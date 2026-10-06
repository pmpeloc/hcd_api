import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SolanaService } from './solana.service';

const LOW_BALANCE_LAMPORTS = 100_000_000; // ~0.1 SOL
const USER_DAILY_TX_LIMIT = 50;

/**
 * Fee payer protection. The backend pays network fees + account rent from a
 * hot wallet that must stay nearly empty, so spend is capped per day and a
 * low-balance alert fires on every send (plus an hourly check in case there
 * is no traffic).
 *
 * Spend accounting is in-memory: a restart resets the counter, which only
 * widens the daily allowance — acceptable in devnet. Swap for the Postgres
 * `fee_payer_spend (day, lamports)` table when the schema lands.
 */
@Injectable()
export class FeeBudgetService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeeBudgetService.name);
  private readonly dailyBudget: number;
  private readonly spentByDay = new Map<string, number>();
  private readonly txCountByUserDay = new Map<string, number>();
  private balanceTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly solana: SolanaService,
  ) {
    this.dailyBudget = Number(
      this.config.get('TX_DAILY_BUDGET_LAMPORTS') ?? 200_000_000,
    );
  }

  onModuleInit() {
    this.balanceTimer = setInterval(() => void this.checkBalance(), 3_600_000);
    this.balanceTimer.unref();
  }

  onModuleDestroy() {
    if (this.balanceTimer) clearInterval(this.balanceTimer);
  }

  /**
   * Throws 429 when the estimated spend would exceed the daily budget or the
   * user's daily tx quota. Called before co-signing anything.
   */
  assertWithinLimits(estimatedLamports: number, signer: string) {
    const day = this.today();
    const spent = this.spentByDay.get(day) ?? 0;
    if (spent + estimatedLamports > this.dailyBudget) {
      throw new HttpException(
        'daily network budget exhausted, retry tomorrow',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const userKey = `${day}:${signer}`;
    const userCount = this.txCountByUserDay.get(userKey) ?? 0;
    if (userCount >= USER_DAILY_TX_LIMIT) {
      throw new HttpException(
        'daily transaction limit reached',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Records actual spend after the tx confirms (fee + rent, read from the
   * fee payer's balance delta), and counts the tx against the user quota. */
  recordSpend(actualLamports: number, signer: string) {
    const day = this.today();
    this.spentByDay.set(day, (this.spentByDay.get(day) ?? 0) + actualLamports);
    const userKey = `${day}:${signer}`;
    this.txCountByUserDay.set(
      userKey,
      (this.txCountByUserDay.get(userKey) ?? 0) + 1,
    );
  }

  async checkBalance() {
    try {
      const balance = await this.solana.connection.getBalance(
        this.solana.feePayer.publicKey,
      );
      if (balance < LOW_BALANCE_LAMPORTS) {
        this.logger.warn(
          `fee payer balance low: ${balance} lamports (${this.solana.feePayer.publicKey.toBase58()}) - top up the hot wallet`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `fee payer balance check failed: ${(e as Error).message}`,
      );
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
