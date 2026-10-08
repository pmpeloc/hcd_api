import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { ConfigService } from '@nestjs/config';

import * as anchor from '@anchor-lang/core';
import { SolanaService } from './solana.service';
import { TxBuilderService } from './tx-builder.service';
import { TxService } from './tx.service';
import { PendingTxStore } from './pending-tx.store';
import { FeeBudgetService } from './fee-budget.service';
import { buildTxSchema } from './tx-schemas';
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';
import type { AuthenticatedUser } from '../auth/authenticated-request';

const { web3 } = anchor;
const { Keypair, Transaction } = web3;

const kp = () => Keypair.generate();

const b64 = (tx: anchor.web3.Transaction) =>
  tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');

const makeEnv = (
  feePayer: anchor.web3.Keypair,
  keyService: anchor.web3.Keypair,
  extra = {},
) => ({
  FEE_PAYER_SECRET: JSON.stringify(Array.from(feePayer.secretKey)),
  KEY_SERVICE_SECRET: JSON.stringify(Array.from(keyService.secretKey)),
  SOLANA_RPC_URL: 'http://localhost:8899',
  TX_DAILY_BUDGET_LAMPORTS: '200000000',
  ...extra,
});

const AUTH_USER: AuthenticatedUser = {
  id: '00000000-0000-4000-8000-000000000001',
  role: 'patient',
  organizationId: null,
  status: 'active',
};

/** Minimal Supabase mock covering the verified-wallet check in build() and
 * the Postgres-backed pending_tx / fee-payer tables. The query-builder chain
 * is emulated per table; rpc() implements fee_payer_record. */
function makeAdminDb(
  opts: {
    appUserWallet?: string | null;
    verified?: boolean;
    error?: { message: string };
  } = {},
) {
  type Row = Record<string, unknown>;
  const pendingRows = new Map<string, Row>();
  const spend = new Map<string, Row>();
  const quota = new Map<string, Row>();
  const db = {
    from: (table: string) => {
      if (table === 'pending_tx') {
        return {
          insert: (row: Row) => {
            pendingRows.set(row.tx_id as string, { used: false, ...row });
            return Promise.resolve({ error: null });
          },
          select: () => ({
            eq: (_c: string, id: string) => ({
              eq: (_c2: string, used: boolean) => ({
                gt: (_c3: string, now: string) => ({
                  maybeSingle: () => {
                    const r = pendingRows.get(id);
                    const ok =
                      r &&
                      r.used === used &&
                      Date.parse(r.expires_at as string) > Date.parse(now);
                    return Promise.resolve({ data: ok ? r : null });
                  },
                }),
              }),
            }),
          }),
          update: (values: Row) => ({
            eq: (_c: string, id: string) => ({
              eq: () => {
                const r = pendingRows.get(id);
                if (r) Object.assign(r, values);
                return Promise.resolve({ error: null });
              },
            }),
          }),
          delete: () => ({
            lt: (_c: string, now: string) => {
              for (const [k, r] of pendingRows) {
                if (Date.parse(r.expires_at as string) < Date.parse(now)) {
                  pendingRows.delete(k);
                }
              }
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === 'fee_payer_spend') {
        return {
          select: () => ({
            eq: (_c: string, day: string) => ({
              maybeSingle: () =>
                Promise.resolve({ data: spend.get(day) ?? null }),
            }),
          }),
        };
      }
      if (table === 'fee_payer_user_txs') {
        return {
          select: () => ({
            eq: (_c: string, day: string) => ({
              eq: (_c2: string, signer: string) => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: quota.get(`${day}:${signer}`) ?? null,
                  }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: opts.appUserWallet
                  ? {
                      wallet_pubkey: opts.appUserWallet,
                      wallet_verified_at:
                        (opts.verified ?? true) ? '2026-10-08T12:00:00Z' : null,
                    }
                  : null,
                error: opts.error ?? null,
              }),
          }),
        }),
      };
    },
    rpc: (
      fn: string,
      args: { p_day: string; p_lamports: number; p_signer: string },
    ) => {
      if (fn === 'fee_payer_record') {
        const s = (spend.get(args.p_day) ?? {
          day: args.p_day,
          lamports: 0,
        }) as { lamports: number };
        s.lamports += args.p_lamports;
        spend.set(args.p_day, s);
        const k = `${args.p_day}:${args.p_signer}`;
        const q = (quota.get(k) ?? { tx_count: 0 }) as { tx_count: number };
        q.tx_count += 1;
        quota.set(k, q);
      }
      return Promise.resolve({ error: null });
    },
  };
  const admin = { create: () => db } as unknown as SupabaseAdminFactory;
  return { admin };
}

function makeService(
  env: Record<string, string>,
  admin?: SupabaseAdminFactory,
) {
  const config = { get: (k: string) => env[k] } as ConfigService;
  const solana = new SolanaService(config);
  const builder = new TxBuilderService(solana);
  const db = admin ?? makeAdminDb().admin;
  const store = new PendingTxStore(db);
  const budget = new FeeBudgetService(config, solana, db);
  const service = new TxService(solana, builder, store, budget, db);
  return { solana, builder, store, budget, service };
}

describe('TxService', () => {
  const feePayer = kp();
  const keyService = kp();
  const user = kp();
  let solana: SolanaService;
  let service: TxService;
  let sendSpy: ReturnType<typeof jest.spyOn>;

  const disputeBody = () => ({
    instruction: 'dispute_record' as const,
    signer: user.publicKey.toBase58(),
    args: { record: kp().publicKey.toBase58() },
  });

  beforeEach(() => {
    ({ solana, service } = makeService(
      makeEnv(feePayer, keyService),
      makeAdminDb({ appUserWallet: user.publicKey.toBase58() }).admin,
    ));
    jest.spyOn(solana.connection, 'getLatestBlockhash').mockResolvedValue({
      blockhash: kp().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    });
    sendSpy = jest
      .spyOn(solana.connection, 'sendRawTransaction')
      .mockResolvedValue('5igNATURE');
    jest
      .spyOn(solana.connection, 'confirmTransaction')
      .mockResolvedValue({ value: { err: null } } as never);
    jest.spyOn(solana.connection, 'getTransaction').mockResolvedValue({
      meta: { preBalances: [1_000_000], postBalances: [900_000] },
    } as never);
    jest.spyOn(solana.connection, 'getBalance').mockResolvedValue(500_000_000);
  });

  const buildAndSign = async (body = disputeBody(), signer = user) => {
    const built = await service.build(AUTH_USER, body);
    const tx = Transaction.from(Buffer.from(built.tx_base64, 'base64'));
    tx.partialSign(signer);
    return { tx_id: built.tx_id, signed_tx_base64: b64(tx), tx };
  };

  it('builds a tx with the backend fee payer and stores the message', async () => {
    const built = await service.build(AUTH_USER, disputeBody());
    const tx = Transaction.from(Buffer.from(built.tx_base64, 'base64'));
    expect(tx.feePayer?.equals(feePayer.publicKey)).toBe(true);
    expect(built.tx_base64).toBeTruthy();
    expect(built.message_hash).toMatch(/^[0-9a-f]{64}$/);
    // unsigned: no signatures yet
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
  });

  it('completes build -> user sign -> submit -> co-sign -> send', async () => {
    const { tx_id, signed_tx_base64 } = await buildAndSign();
    const res = await service.submit({ tx_id, signed_tx_base64 });
    expect(res.signature).toBe('5igNATURE');
    expect(res.explorer_url).toContain(res.signature);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered transaction byte-by-byte with 403', async () => {
    const built = await service.build(AUTH_USER, disputeBody());
    // A DIFFERENT valid transaction signed by the same user.
    const other = await service.build(AUTH_USER, {
      instruction: 'revoke_access',
      signer: user.publicKey.toBase58(),
      args: { grant: kp().publicKey.toBase58() },
    });
    const foreign = Transaction.from(Buffer.from(other.tx_base64, 'base64'));
    foreign.partialSign(user);
    await expect(
      service.submit({ tx_id: built.tx_id, signed_tx_base64: b64(foreign) }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects when the user signature is missing (400)', async () => {
    const built = await service.build(AUTH_USER, disputeBody());
    await expect(
      service.submit({ tx_id: built.tx_id, signed_tx_base64: built.tx_base64 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a signature from a different wallet (400)', async () => {
    // Attacker signs the exact same message with a different key and drops
    // the signature into the expected signer's slot.
    const built = await service.build(AUTH_USER, disputeBody());
    const tx = Transaction.from(Buffer.from(built.tx_base64, 'base64'));
    const wrong = kp();
    const key = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(wrong.secretKey.slice(0, 32)),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const forged = cryptoSign(null, tx.serializeMessage(), key);
    const slot = tx.signatures.find((s) => s.publicKey.equals(user.publicKey))!;
    slot.signature = forged;
    await expect(
      service.submit({ tx_id: built.tx_id, signed_tx_base64: b64(tx) }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('tx_id is single-use', async () => {
    const { tx_id, signed_tx_base64 } = await buildAndSign();
    await service.submit({ tx_id, signed_tx_base64 });
    await expect(
      service.submit({ tx_id, signed_tx_base64 }),
    ).rejects.toMatchObject({
      status: 410,
    });
  });

  it('unknown tx_id -> 410', async () => {
    await expect(
      service.submit({
        tx_id: '00000000-0000-4000-8000-000000000000',
        signed_tx_base64: '',
      }),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('daily budget exhausted -> 429 before co-signing', async () => {
    ({ solana, service } = makeService(
      makeEnv(feePayer, keyService, { TX_DAILY_BUDGET_LAMPORTS: '10' }),
      makeAdminDb({ appUserWallet: user.publicKey.toBase58() }).admin,
    ));
    jest.spyOn(solana.connection, 'getLatestBlockhash').mockResolvedValue({
      blockhash: kp().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    });
    jest.spyOn(solana.connection, 'getBalance').mockResolvedValue(500_000_000);
    const sendSpy = jest.spyOn(solana.connection, 'sendRawTransaction');
    const { tx_id, signed_tx_base64 } = await buildAndSign();
    await expect(
      service.submit({ tx_id, signed_tx_base64 }),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('issue_record marks the tx as needing the key_service signature', async () => {
    jest
      .spyOn(solana.program.account.patientProfile, 'fetch')
      .mockResolvedValue({ nextRecordId: { toNumber: () => 0 } });
    const patient = kp();
    const built = await service.build(AUTH_USER, {
      instruction: 'issue_record',
      signer: user.publicKey.toBase58(),
      args: {
        patient: patient.publicKey.toBase58(),
        content_hash: 'ab'.repeat(32),
        storage_ref: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c',
      },
    });
    const tx = Transaction.from(Buffer.from(built.tx_base64, 'base64'));
    // Three required signers: fee payer, issuer, key_service.
    const compiled = tx.compileMessage();
    const signerKeys = compiled.accountKeys.slice(
      0,
      compiled.header.numRequiredSignatures,
    );
    const signerSet = new Set(signerKeys.map((k) => k.toBase58()));
    expect(signerSet.has(feePayer.publicKey.toBase58())).toBe(true);
    expect(signerSet.has(user.publicKey.toBase58())).toBe(true);
    expect(signerSet.has(keyService.publicKey.toBase58())).toBe(true);
  });

  it('issue_record 404s when the patient has no profile', async () => {
    jest
      .spyOn(solana.program.account.patientProfile, 'fetch')
      .mockRejectedValue(new Error('Account does not exist'));
    await expect(
      service.build(AUTH_USER, {
        instruction: 'issue_record',
        signer: user.publicKey.toBase58(),
        args: {
          patient: kp().publicKey.toBase58(),
          content_hash: 'ab'.repeat(32),
          storage_ref: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c',
        },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('schema rejects instructions outside the allowed union (log_access, admin)', () => {
    for (const instruction of [
      'log_access',
      'initialize_config',
      'set_provider_verified',
    ]) {
      const result = buildTxSchema.safeParse({
        instruction,
        signer: kp().publicKey.toBase58(),
        args: {},
      });
      expect(result.success).toBe(false);
    }
  });

  it('issue_record rejects a storage_ref that is not a lowercase UUID', () => {
    for (const storage_ref of [
      'obj_synthetic_1',
      'pacientes/juan/rx.pdf.enc',
      '3F2B8C1E-9A4D-4E7B-8C2A-1D5E6F7A8B9C',
    ]) {
      const result = buildTxSchema.safeParse({
        instruction: 'issue_record',
        signer: kp().publicKey.toBase58(),
        args: {
          patient: kp().publicKey.toBase58(),
          content_hash: 'ab'.repeat(32),
          storage_ref,
        },
      });
      expect(result.success).toBe(false);
    }
  });

  it('grant_access rejects a past expires_at', async () => {
    await expect(
      service.build(AUTH_USER, {
        instruction: 'grant_access',
        signer: user.publicKey.toBase58(),
        args: {
          record: kp().publicKey.toBase58(),
          doctor: kp().publicKey.toBase58(),
          expires_at: Math.floor(Date.now() / 1000) - 60,
        },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a signer that is not the enrolled wallet (403)', async () => {
    ({ solana, service } = makeService(
      makeEnv(feePayer, keyService),
      makeAdminDb({ appUserWallet: kp().publicKey.toBase58() }).admin,
    ));
    jest.spyOn(solana.connection, 'getLatestBlockhash').mockResolvedValue({
      blockhash: kp().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    });
    await expect(service.build(AUTH_USER, disputeBody())).rejects.toMatchObject(
      { status: 403 },
    );
  });

  it('rejects a wallet that is stored but never verified (403)', async () => {
    ({ solana, service } = makeService(
      makeEnv(feePayer, keyService),
      makeAdminDb({
        appUserWallet: user.publicKey.toBase58(),
        verified: false,
      }).admin,
    ));
    await expect(service.build(AUTH_USER, disputeBody())).rejects.toMatchObject(
      { status: 403 },
    );
  });

  it('rejects when the user has no enrolled wallet at all (403)', async () => {
    ({ solana, service } = makeService(
      makeEnv(feePayer, keyService),
      makeAdminDb({ appUserWallet: null }).admin,
    ));
    await expect(service.build(AUTH_USER, disputeBody())).rejects.toMatchObject(
      { status: 403 },
    );
  });

  it('fails closed with 503 when the identity lookup errors', async () => {
    ({ solana, service } = makeService(
      makeEnv(feePayer, keyService),
      makeAdminDb({ error: { message: 'connection refused' } }).admin,
    ));
    await expect(service.build(AUTH_USER, disputeBody())).rejects.toMatchObject(
      { status: 503 },
    );
  });
});
