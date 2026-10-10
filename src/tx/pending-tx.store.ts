import {
  Injectable,
  InternalServerErrorException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PublicKey } from './solana.service';
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';

export interface PendingTx {
  txId: string;
  instruction: string;
  signer: PublicKey;
  /** Exact serialized message bytes built by the backend. Compared byte by
   * byte at submit: any change (accounts, blockhash, extra instructions,
   * different fee payer) means total rejection. */
  message: Buffer;
  lastValidBlockHeight: number;
  needsKeyService: boolean;
  /** Conservative lamports estimate from the builder, used for the budget
   * pre-check at submit time. */
  estimatedLamports: number;
  expiresAt: number;
  used: boolean;
}

interface PendingTxRow {
  tx_id: string;
  instruction: string;
  signer: string;
  message_b64: string;
  last_valid_block_height: number;
  needs_key_service: boolean;
  estimated_lamports: number;
  expires_at: string;
  used: boolean;
}

/**
 * Short-lived store for transactions built but not yet submitted. The entry
 * lives at most ~2 minutes (a devnet blockhash is valid for ~150 slots) and
 * is single-use: consumed on submit or expired, never replayed.
 *
 * Backed by the `pending_tx` table (service role only, RLS denies everyone
 * else): a restart no longer drops pending envelopes and several API
 * instances can share the flow. Expired rows are swept periodically; the
 * SELECT also filters them, so a missed sweep only wastes storage.
 */
@Injectable()
export class PendingTxStore implements OnModuleInit, OnModuleDestroy {
  private readonly ttlMs = 120_000;
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly admin: SupabaseAdminFactory) {}

  onModuleInit() {
    this.sweeper = setInterval(() => void this.purge(), 30_000);
    this.sweeper.unref();
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  async save(entry: Omit<PendingTx, 'expiresAt' | 'used'>): Promise<PendingTx> {
    const pending: PendingTx = {
      ...entry,
      expiresAt: Date.now() + this.ttlMs,
      used: false,
    };
    const { error } = await this.admin
      .create()
      .from('pending_tx')
      .insert({
        tx_id: pending.txId,
        instruction: pending.instruction,
        signer: pending.signer.toBase58(),
        message_b64: pending.message.toString('base64'),
        last_valid_block_height: pending.lastValidBlockHeight,
        needs_key_service: pending.needsKeyService,
        estimated_lamports: pending.estimatedLamports,
        expires_at: new Date(pending.expiresAt).toISOString(),
      });
    if (error) {
      throw new InternalServerErrorException('pending tx write failed');
    }
    return pending;
  }

  /** Returns the pending tx, or undefined if unknown, used or expired. */
  async get(txId: string): Promise<PendingTx | undefined> {
    const { data, error } = await this.admin
      .create()
      .from('pending_tx')
      .select(
        'tx_id, instruction, signer, message_b64, last_valid_block_height,' +
          ' needs_key_service, estimated_lamports, expires_at, used',
      )
      .eq('tx_id', txId)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException('pending tx read failed');
    }
    const row = data as PendingTxRow | null;
    if (!row) return undefined;
    return {
      txId: row.tx_id,
      instruction: row.instruction,
      signer: new PublicKey(row.signer),
      message: Buffer.from(row.message_b64, 'base64'),
      lastValidBlockHeight: Number(row.last_valid_block_height),
      needsKeyService: row.needs_key_service,
      estimatedLamports: Number(row.estimated_lamports),
      expiresAt: new Date(row.expires_at).getTime(),
      used: row.used,
    };
  }

  async consume(txId: string): Promise<void> {
    await this.admin
      .create()
      .from('pending_tx')
      .update({ used: true })
      .eq('tx_id', txId)
      .eq('used', false);
  }

  private async purge() {
    await this.admin
      .create()
      .from('pending_tx')
      .delete()
      .lt('expires_at', new Date().toISOString());
  }
}
