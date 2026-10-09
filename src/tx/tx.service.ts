import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as anchor from '@anchor-lang/core';
import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as cryptoVerify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SolanaService } from './solana.service';
import { TxBuilderService } from './tx-builder.service';
import { PendingTxStore } from './pending-tx.store';
import { FeeBudgetService } from './fee-budget.service';
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';
import type { AuthenticatedUser } from '../auth/authenticated-request';
import type { BuildTxDto, SubmitTxDto } from './tx-schemas';

const { web3 } = anchor;
const { Transaction } = web3;

// Anchor program error codes (6000+) -> { name, msg } for 422 responses.
const IDL_ERRORS = new Map<number, { name: string; msg: string }>(
  (
    JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'idl', 'hcd.json'), 'utf8'),
    ) as {
      errors?: { code: number; name: string; msg: string }[];
    }
  ).errors?.map((e) => [e.code, { name: e.name, msg: e.msg }]) ?? [],
);

const EXPLORER = 'https://explorer.solana.com/tx';

/**
 * Two-phase transaction flow (spec: docs/proyecto/modulo-tx.md):
 * build -> user signs with their embedded wallet -> submit -> the backend
 * verifies the signed message BYTE BY BYTE against what it built, co-signs
 * as fee payer (plus key_service on issue_record) and broadcasts.
 *
 * The byte comparison is the security boundary: we never sign a message the
 * client assembled, and a single flipped bit means a 403.
 */
@Injectable()
export class TxService {
  private readonly logger = new Logger(TxService.name);

  constructor(
    private readonly solana: SolanaService,
    private readonly builder: TxBuilderService,
    private readonly pending: PendingTxStore,
    private readonly budget: FeeBudgetService,
    private readonly admin: SupabaseAdminFactory,
  ) {}

  async build(user: AuthenticatedUser, body: BuildTxDto) {
    const { tx, signer, needsKeyService, estimatedLamports } =
      await this.builder.build(body);
    await this.assertSignerOwned(user, signer, body);

    const { blockhash, lastValidBlockHeight } = await this.getLatestBlockhash();
    tx.feePayer = this.solana.feePayer.publicKey;
    tx.recentBlockhash = blockhash;

    const message = tx.serializeMessage();
    const txId = randomUUID();
    this.pending.save({
      txId,
      instruction: body.instruction,
      signer,
      message,
      lastValidBlockHeight,
      needsKeyService,
      estimatedLamports,
    });

    return {
      tx_id: txId,
      tx_base64: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      message_hash: createHash('sha256').update(message).digest('hex'),
      last_valid_block_height: lastValidBlockHeight,
      expires_in_seconds: 90,
    };
  }

  async submit(body: SubmitTxDto) {
    const pending = this.pending.get(body.tx_id);
    if (!pending) {
      throw new HttpException(
        'unknown, used or expired tx_id - call /tx/build again',
        HttpStatus.GONE,
      );
    }

    let tx: anchor.web3.Transaction;
    try {
      tx = Transaction.from(Buffer.from(body.signed_tx_base64, 'base64'));
    } catch {
      throw new HttpException(
        'signed_tx_base64 is not a valid transaction',
        HttpStatus.BAD_REQUEST,
      );
    }

    // 1. Byte-by-byte message comparison. One differing bit = total reject.
    const receivedMessage = tx.serializeMessage();
    if (!receivedMessage.equals(pending.message)) {
      this.logger.warn(
        `SECURITY: tampered transaction rejected (tx_id=${body.tx_id}, instruction=${pending.instruction}, signer=${pending.signer.toBase58()})`,
      );
      throw new HttpException(
        'transaction does not match the one built by the backend',
        HttpStatus.FORBIDDEN,
      );
    }

    // 2. The expected user signature must be present and valid.
    const userSig = tx.signatures.find((s) =>
      s.publicKey.equals(pending.signer),
    );
    if (!userSig?.signature) {
      throw new HttpException(
        `missing signature for ${pending.signer.toBase58()}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!tx.verifySignatures(false)) {
      throw new HttpException('invalid signature', HttpStatus.BAD_REQUEST);
    }

    // 3. Budget + user quota before co-signing.
    this.budget.assertWithinLimits(
      pending.estimatedLamports,
      pending.signer.toBase58(),
    );
    await this.budget.checkBalance();

    // 4. Co-sign and broadcast.
    tx.partialSign(this.solana.feePayer);
    if (pending.needsKeyService) {
      tx.partialSign(this.solana.keyService);
    }

    const signature = await this.sendAndConfirm(
      tx,
      pending.lastValidBlockHeight,
    );
    this.pending.consume(body.tx_id);

    // 5. Record the actual fee-payer balance delta in the daily counter.
    void this.correctSpend(signature, pending.signer.toBase58());

    return {
      signature,
      explorer_url: `${EXPLORER}/${signature}?cluster=devnet`,
    };
  }

  async status(signature: string) {
    try {
      const res = await this.solana.connection.getSignatureStatuses(
        [signature],
        {
          searchTransactionHistory: true,
        },
      );
      const s = res.value[0];
      if (!s) return { signature, status: 'not_found' };
      return {
        signature,
        status: s.confirmationStatus ?? 'unknown',
        confirmations: s.confirmations,
        error: s.err,
        slot: s.slot,
      };
    } catch (e) {
      throw new HttpException(
        `rpc unavailable: ${(e as Error).message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * The declared signer must be a wallet of the authenticated user:
   * app_user.wallet_pubkey or, for doctors, doctors.wallet_pubkey. If the
   * user has no wallet registered yet, the first signer they present is
   * bound to their account (null -> set, never overwrite) — but only after
   * they prove key control with a fresh wallet_proof signature, so nobody
   * can bind someone else's public key. A wallet already bound to another
   * account is refused.
   */
  private async assertSignerOwned(
    user: AuthenticatedUser,
    signer: anchor.web3.PublicKey,
    body: BuildTxDto,
  ) {
    const db = this.admin.create();
    const signerStr = signer.toBase58();
    const [{ data: appUser }, { data: doctor }, { data: holder }] =
      await Promise.all([
        db
          .from('app_user')
          .select('wallet_pubkey')
          .eq('id', user.id)
          .maybeSingle(),
        db
          .from('doctors')
          .select('wallet_pubkey')
          .eq('user_id', user.id)
          .maybeSingle(),
        db
          .from('app_user')
          .select('id')
          .eq('wallet_pubkey', signerStr)
          .maybeSingle(),
      ]);
    const owned = [appUser?.wallet_pubkey, doctor?.wallet_pubkey].filter(
      (w): w is string => typeof w === 'string' && w.length > 0,
    );
    if (owned.includes(signerStr)) return;
    if (owned.length > 0) {
      throw new HttpException(
        'signer is not a wallet of the authenticated user',
        HttpStatus.FORBIDDEN,
      );
    }
    if (holder && holder.id !== user.id) {
      throw new HttpException(
        'wallet is already bound to another account',
        HttpStatus.FORBIDDEN,
      );
    }
    // First transaction for this user: bind the wallet they are about to
    // sign with, after proving they control it. Empty string for the second
    // .eq() would match nothing, so .is() is required for a NULL-safe
    // "only if not already set".
    this.assertWalletProof(user, signer, body);
    const { error } = await db
      .from('app_user')
      .update({ wallet_pubkey: signerStr })
      .eq('id', user.id)
      .is('wallet_pubkey', null);
    if (error) {
      throw new HttpException(
        'wallet binding failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * First-use binding proof: the wallet signs
   * `salua:bind-wallet:<user.id>:<signer>:<ts>` (fresh within 5 minutes).
   * Verifying the signature proves the caller controls the keypair, not
   * just knows the public key. Ed25519 verify is native to Node — no extra
   * dependency.
   */
  private assertWalletProof(
    user: AuthenticatedUser,
    signer: anchor.web3.PublicKey,
    body: BuildTxDto,
  ) {
    const { wallet_proof: proof, wallet_proof_ts: ts } = body;
    if (!proof || !ts) {
      throw new HttpException(
        'wallet not registered: send wallet_proof + wallet_proof_ts (sign ' +
          '`salua:bind-wallet:<user.id>:<signer>:<ts>` with the wallet)',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (Math.abs(Date.now() / 1000 - ts) > 300) {
      throw new HttpException('wallet proof expired', HttpStatus.FORBIDDEN);
    }
    const message = Buffer.from(
      `salua:bind-wallet:${user.id}:${signer.toBase58()}:${ts}`,
      'utf8',
    );
    let valid = false;
    try {
      const key = createPublicKey({
        key: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: Buffer.from(signer.toBytes()).toString('base64url'),
        },
        format: 'jwk',
      });
      valid = cryptoVerify(null, message, key, Buffer.from(proof, 'base64'));
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new HttpException(
        'wallet proof signature invalid',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async getLatestBlockhash() {
    try {
      return await this.solana.connection.getLatestBlockhash('confirmed');
    } catch (e) {
      if (this.solana.fallbackConnection) {
        try {
          return await this.solana.fallbackConnection.getLatestBlockhash(
            'confirmed',
          );
        } catch {
          // fall through to the 503 below
        }
      }
      throw new HttpException(
        `rpc unavailable: ${(e as Error).message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async sendAndConfirm(
    tx: anchor.web3.Transaction,
    lastValidBlockHeight: number,
  ): Promise<string> {
    const raw = tx.serialize();
    let signature: string;
    try {
      signature = await this.solana.connection.sendRawTransaction(raw);
    } catch (e) {
      if (this.solana.fallbackConnection) {
        try {
          signature =
            await this.solana.fallbackConnection.sendRawTransaction(raw);
        } catch {
          this.throwProgramError(e); // report the primary RPC error
        }
      } else {
        this.throwProgramError(e);
      }
    }

    try {
      const result = await this.solana.connection.confirmTransaction(
        { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight },
        'confirmed',
      );
      if (result.value.err) {
        this.throwProgramError(result.value.err);
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const msg = (e as Error).message ?? '';
      if (msg.includes('expired') || msg.includes('block height exceeded')) {
        throw new HttpException(
          'transaction expired, call /tx/build again',
          HttpStatus.CONFLICT,
        );
      }
      throw new HttpException(
        `confirmation failed: ${msg}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return signature;
  }

  /** Maps on-chain program failures to 422 with the IDL error name/message;
   * everything else is rethrown for the caller to classify. */
  private throwProgramError(err: unknown): never {
    const text = JSON.stringify(err) + ((err as Error)?.message ?? '');
    const match = /custom program error: (0x[0-9a-fA-F]+|\d+)/i.exec(text);
    if (match) {
      const code = parseInt(match[1], match[1].startsWith('0x') ? 16 : 10);
      const mapped = IDL_ERRORS.get(code);
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: mapped?.name ?? `error_${code}`,
          message: mapped?.msg ?? `program error ${code}`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (/already been processed/i.test(text)) {
      throw new HttpException(
        'transaction already processed',
        HttpStatus.CONFLICT,
      );
    }
    throw err instanceof HttpException
      ? err
      : new HttpException(
          `transaction failed: ${(err as Error)?.message ?? 'unknown'}`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
  }

  /** After confirmation, read the fee payer balance delta (fee + rent) and
   * record it in the daily counter; also counts the tx on the user quota. */
  private async correctSpend(signature: string, signer: string) {
    let actual = 0;
    try {
      const parsed = await this.solana.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      const meta = parsed?.meta;
      if (meta) {
        actual = Math.max(0, meta.preBalances[0] - meta.postBalances[0]);
      }
    } catch {
      // Can't read the delta: count the tx anyway, spend stays unrecorded.
    }
    this.budget.recordSpend(actual, signer);
  }
}
