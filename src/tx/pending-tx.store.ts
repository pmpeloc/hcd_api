import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { PublicKey } from './solana.service';

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

/**
 * Short-lived store for transactions built but not yet submitted. The entry
 * lives at most ~2 minutes (a devnet blockhash is valid for ~150 slots) and
 * is single-use: consumed on submit or expired, never replayed.
 *
 * In-memory for now: a restart drops pending transactions, which only forces
 * the client to call /tx/build again. Swap for the Postgres `pending_tx`
 * table when the database schema lands (same interface).
 */
@Injectable()
export class PendingTxStore implements OnModuleInit, OnModuleDestroy {
  private readonly ttlMs = 120_000;
  private readonly store = new Map<string, PendingTx>();
  private sweeper?: NodeJS.Timeout;

  onModuleInit() {
    this.sweeper = setInterval(() => this.purge(), 30_000);
    this.sweeper.unref();
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  save(entry: Omit<PendingTx, 'expiresAt' | 'used'>): PendingTx {
    const pending: PendingTx = {
      ...entry,
      expiresAt: Date.now() + this.ttlMs,
      used: false,
    };
    this.store.set(pending.txId, pending);
    return pending;
  }

  /** Returns the pending tx, or undefined if unknown, used or expired. */
  get(txId: string): PendingTx | undefined {
    const pending = this.store.get(txId);
    if (!pending || pending.used || pending.expiresAt < Date.now()) {
      return undefined;
    }
    return pending;
  }

  consume(txId: string) {
    const pending = this.store.get(txId);
    if (pending) pending.used = true;
  }

  private purge() {
    const now = Date.now();
    for (const [id, p] of this.store) {
      if (p.used || p.expiresAt < now) this.store.delete(id);
    }
  }
}
