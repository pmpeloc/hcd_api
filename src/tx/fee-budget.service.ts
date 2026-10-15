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
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';

const LOW_BALANCE_LAMPORTS = 100_000_000; // ~0.1 SOL
const USER_DAILY_TX_LIMIT = 50;

/**
 * Fee payer protection. The backend pays network fees + account rent from a
 * hot wallet that must stay nearly empty, so spend is capped per day and a
 * low-balance alert fires on every send (plus an hourly check in case there
 * is no traffic).
 *
 * Accounting lives in Postgres (`fee_payer_spend`, `fee_payer_user_txs`):
 * a restart no longer resets the daily allowance and the counters are shared
 * across instances. The atomic increment runs in the `fee_payer_record`
 * Postgres function.
 */
@Injectable()
export class FeeBudgetService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeeBudgetService.name);
  private readonly dailyBudget: number;
  private balanceTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly solana: SolanaService,
    private readonly admin: SupabaseAdminFactory,
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
  async assertWithinLimits(estimatedLamports: number, signer: string) {
    const day = this.today();
    const db = this.admin.create();
    const [{ data: spend }, { data: quota }] = await Promise.all([
      db
        .from('fee_payer_spend')
        .select('lamports')
        .eq('day', day)
        .maybeSingle(),
      db
        .from('fee_payer_user_txs')
        .select('tx_count')
        .eq('day', day)
        .eq('signer', signer)
        .maybeSingle(),
    ]);
    const spent = Number(spend?.lamports ?? 0);
    if (spent + estimatedLamports > this.dailyBudget) {
      throw new HttpException(
        'daily network budget exhausted, retry tomorrow',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (Number(quota?.tx_count ?? 0) >= USER_DAILY_TX_LIMIT) {
      throw new HttpException(
        'daily transaction limit reached',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Records actual spend after the tx confirms (fee + rent, read from the
   * fee payer's balance delta), and counts the tx against the user quota.
   * Atomic on the Postgres side via the fee_payer_record function. */
  async recordSpend(actualLamports: number, signer: string) {
    const { error } = await this.admin.create().rpc('fee_payer_record', {
      p_day: this.today(),
      p_lamports: actualLamports,
      p_signer: signer,
    });
    if (error) {
      this.logger.warn(`fee_payer_record failed: ${error.message}`);
    }
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
