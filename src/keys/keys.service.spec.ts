import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Keypair, PublicKey } from '@solana/web3.js';
import { KeysService } from './keys.service';
import { KeyCryptoService } from './key-crypto.service';
import { SupabaseAdminFactory } from './supabase-admin.factory';
import type { AuthenticatedUser } from '../auth/authenticated-request';

const ORG_ID = '11111111-2222-4333-8444-555555555555';
const RECORD_ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const MASTER_KEY = randomBytes(32).toString('hex');

const patient = Keypair.generate();
const issuer = Keypair.generate();
const doctor = Keypair.generate();
const stranger = Keypair.generate();
const keyService = Keypair.generate();
const feePayer = Keypair.generate();

const recordPda = PublicKey.findProgramAddressSync(
  [Buffer.from('record'), patient.publicKey.toBuffer(), Buffer.alloc(8)],
  Keypair.generate().publicKey,
)[0];
const grantPda = PublicKey.findProgramAddressSync(
  [Buffer.from('grant'), recordPda.toBuffer(), doctor.publicKey.toBuffer()],
  Keypair.generate().publicKey,
)[0];

const user = (
  id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
): AuthenticatedUser => ({
  id,
  role: 'patient',
  organizationId: ORG_ID,
  status: 'active',
});

// --- Fluent Supabase stub ---------------------------------------------------

type Row = Record<string, unknown>;

function makeDb(handlers: {
  recordsRow?: Row | null;
  appUserRow?: Row | null;
  appUserError?: { message: string };
  doctorRow?: Row | null;
  releaseId?: number;
  signedUrl?: string;
}) {
  const inserts: Row[] = [];
  const updates: { values: Row; id: unknown }[] = [];
  const selectChain = (row: Row | null, error: unknown = null) => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest
      .fn<() => Promise<{ data: Row | null; error: unknown }>>()
      .mockResolvedValue({ data: row, error }),
  });
  const db = {
    from: jest.fn((table: string) => {
      if (table === 'records') return selectChain(handlers.recordsRow ?? null);
      if (table === 'app_user')
        return selectChain(
          handlers.appUserRow ?? null,
          handlers.appUserError ?? null,
        );
      if (table === 'doctors') return selectChain(handlers.doctorRow ?? null);
      if (table === 'key_releases') {
        const chain = {
          insert: jest.fn((v: Row) => {
            inserts.push(v);
            return chain;
          }),
          update: jest.fn((values: Row) => {
            const q = {
              eq: jest.fn((_c: string, id: unknown) => {
                updates.push({ values, id });
                return Promise.resolve({ error: null });
              }),
            };
            return q;
          }),
          select: jest.fn().mockReturnThis(),
          single: jest
            .fn<() => Promise<{ data: Row; error: null }>>()
            .mockResolvedValue({
              data: { id: handlers.releaseId ?? 1 },
              error: null,
            }),
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    }),
    storage: {
      from: () => ({
        createSignedUrl: jest
          .fn<
            () => Promise<{ data: { signedUrl: string } | null; error: null }>
          >()
          .mockResolvedValue({
            data: {
              signedUrl: handlers.signedUrl ?? 'https://signed.example/x',
            },
            error: null,
          }),
      }),
    },
  };
  return { db, inserts, updates };
}

// --- Solana stub ------------------------------------------------------------

function makeSolana(accounts: {
  record?: unknown;
  grants?: Record<string, unknown>;
  provider?: unknown;
  sendErr?: Error;
}) {
  const sendRawTransaction = jest
    .fn<() => Promise<string>>()
    .mockImplementation(() =>
      accounts.sendErr
        ? Promise.reject(accounts.sendErr)
        : Promise.resolve('sig123'),
    );
  return {
    feePayer,
    keyService,
    connection: {
      getLatestBlockhash: jest
        .fn<() => Promise<{ blockhash: string }>>()
        .mockResolvedValue({
          blockhash: '11111111111111111111111111111111',
        }),
      sendRawTransaction,
      confirmTransaction: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({}),
    },
    program: {
      account: {
        record: {
          fetch: jest.fn(() => Promise.resolve(accounts.record)),
        },
        accessGrant: {
          fetch: jest.fn((pda: PublicKey) => {
            const g = accounts.grants?.[pda.toBase58()];
            if (!g) return Promise.reject(new Error('Account does not exist'));
            return Promise.resolve(g);
          }),
        },
        provider: {
          fetch: jest.fn(() => {
            if (!accounts.provider)
              return Promise.reject(new Error('Account does not exist'));
            return Promise.resolve(accounts.provider);
          }),
        },
        config: {
          fetch: jest
            .fn<() => Promise<unknown>>()
            .mockResolvedValue({ keyService: keyService.publicKey }),
        },
      },
      methods: {
        logAccess: () => ({
          accountsPartial: () => ({
            transaction: async () => {
              const tx = new (await import('@solana/web3.js')).Transaction();
              return tx;
            },
          }),
        }),
      },
    },
    configPda: () =>
      PublicKey.findProgramAddressSync(
        [Buffer.from('config')],
        Keypair.generate().publicKey,
      )[0],
    providerPda: (k: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from('provider'), k.toBuffer()],
        Keypair.generate().publicKey,
      )[0],
    grantPda: (record: PublicKey, doc: PublicKey) =>
      record.equals(recordPda) && doc.equals(doctor.publicKey)
        ? grantPda
        : PublicKey.findProgramAddressSync(
            [Buffer.from('grant'), record.toBuffer(), doc.toBuffer()],
            Keypair.generate().publicKey,
          )[0],
  };
}

// --- Fixture ----------------------------------------------------------------

const activeRecord = {
  patient: patient.publicKey,
  issuer: issuer.publicKey,
  status: { active: {} },
};

function makeCrypto(): KeyCryptoService {
  const crypto = new KeyCryptoService(new ConfigService({ MASTER_KEY }));
  crypto.onModuleInit();
  return crypto;
}

function recordRow(crypto: KeyCryptoService, dek: Buffer) {
  return {
    id: RECORD_ID,
    organization_id: ORG_ID,
    record_pda: recordPda.toBase58(),
    storage_path: 'enc/file.bin',
    wrapped_dek: '\\x' + crypto.wrapDek(dek, ORG_ID).toString('hex'),
    content_hash: '\\x' + 'ab'.repeat(32),
  };
}

describe('KeysService.release', () => {
  let crypto: KeyCryptoService;
  let dek: Buffer;

  beforeEach(() => {
    crypto = makeCrypto();
    dek = randomBytes(32);
  });

  const service = (
    db: ReturnType<typeof makeDb>['db'],
    solana: ReturnType<typeof makeSolana>,
  ) =>
    new KeysService(
      new ConfigService({ STORAGE_BUCKET: 'records' }),
      solana as never,
      crypto,
      { create: () => db } as unknown as SupabaseAdminFactory,
    );

  it('patient gets the DEK, row is skipped, no log_access tx', async () => {
    const { db, inserts } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: patient.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
    });
    const solana = makeSolana({ record: activeRecord });
    const res = await service(db, solana).release(user(), {
      record_id: RECORD_ID,
    });
    expect(Buffer.from(res.dek, 'base64').equals(dek)).toBe(true);
    expect(res.expires_in).toBe(60);
    expect(inserts[0]).toMatchObject({
      role: 'patient',
      log_access_status: 'skipped',
    });
    expect(solana.connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('issuer gets the DEK without log_access', async () => {
    const { db, inserts } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: issuer.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
    });
    const res = await service(db, makeSolana({ record: activeRecord })).release(
      user(),
      { record_id: RECORD_ID },
    );
    expect(res.dek).toBeTruthy();
    expect(inserts[0]).toMatchObject({ role: 'issuer' });
  });

  it('doctor with a live grant: log_access confirmed with tx_signature', async () => {
    const { db, inserts, updates } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: doctor.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
      releaseId: 42,
    });
    const solana = makeSolana({
      record: activeRecord,
      grants: {
        [grantPda.toBase58()]: {
          status: { active: {} },
          expiresAt: { toNumber: () => Math.floor(Date.now() / 1000) + 3600 },
          doctor: doctor.publicKey,
          record: recordPda,
        },
      },
      provider: { verified: true },
    });
    const res = await service(db, solana).release(user(), {
      record_id: RECORD_ID,
    });
    expect(res.dek).toBeTruthy();
    expect(inserts[0]).toMatchObject({
      role: 'doctor',
      grant_pda: grantPda.toBase58(),
      log_access_status: 'pending',
    });
    expect(updates[0].values).toMatchObject({
      log_access_status: 'confirmed',
      tx_signature: 'sig123',
    });
  });

  it('program rejection -> 403, row marked failed, nothing delivered', async () => {
    const { db, updates } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: doctor.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
    });
    const solana = makeSolana({
      record: activeRecord,
      grants: {
        [grantPda.toBase58()]: {
          status: { active: {} },
          expiresAt: { toNumber: () => Math.floor(Date.now() / 1000) + 3600 },
          doctor: doctor.publicKey,
          record: recordPda,
        },
      },
      provider: { verified: true },
      sendErr: new Error('custom program error: 0x1778'),
    });
    await expect(
      service(db, solana).release(user(), { record_id: RECORD_ID }),
    ).rejects.toMatchObject({ status: 403 });
    expect(updates[0].values.log_access_status).toBe('failed');
  });

  it('RPC down on log_access -> 503, nothing delivered, row marked failed', async () => {
    const { db, updates } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: doctor.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
    });
    const solana = makeSolana({
      record: activeRecord,
      grants: {
        [grantPda.toBase58()]: {
          status: { active: {} },
          expiresAt: { toNumber: () => Math.floor(Date.now() / 1000) + 3600 },
          doctor: doctor.publicKey,
          record: recordPda,
        },
      },
      provider: { verified: true },
      sendErr: new Error('fetch failed: connection refused'),
    });
    await expect(
      service(db, solana).release(user(), { record_id: RECORD_ID }),
    ).rejects.toMatchObject({ status: 503 });
    expect(updates[0].values.log_access_status).toBe('failed');
  });

  it('disputed record -> 403 even for the patient', async () => {
    const { db } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: patient.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
    });
    const solana = makeSolana({
      record: { ...activeRecord, status: { disputed: {} } },
    });
    await expect(
      service(db, solana).release(user(), { record_id: RECORD_ID }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('identity lookup error -> 503, not "no wallet" (403)', async () => {
    const { db } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserError: { message: 'connection refused' },
    });
    await expect(
      service(db, makeSolana({ record: activeRecord })).release(user(), {
        record_id: RECORD_ID,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('stored but unverified wallet -> 403 (enrollment never ran)', async () => {
    const { db } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: patient.publicKey.toBase58(),
        wallet_verified_at: null,
      },
    });
    await expect(
      service(db, makeSolana({ record: activeRecord })).release(user(), {
        record_id: RECORD_ID,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('unknown record -> 404', async () => {
    const { db } = makeDb({ recordsRow: null });
    await expect(
      service(db, makeSolana({})).release(user(), { record_id: RECORD_ID }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('stranger wallet -> 403', async () => {
    const { db } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: stranger.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
    });
    await expect(
      service(db, makeSolana({ record: activeRecord })).release(user(), {
        record_id: RECORD_ID,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    ['revoked', { revoked: {} }, Math.floor(Date.now() / 1000) + 3600],
    ['expired', { active: {} }, Math.floor(Date.now() / 1000) - 5],
  ])('doctor with %s grant -> 403', async (_name, status, expiresAt) => {
    const { db } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: doctor.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
    });
    const solana = makeSolana({
      record: activeRecord,
      grants: {
        [grantPda.toBase58()]: {
          status,
          expiresAt: { toNumber: () => expiresAt },
          doctor: doctor.publicKey,
          record: recordPda,
        },
      },
      provider: { verified: true },
    });
    await expect(
      service(db, solana).release(user(), { record_id: RECORD_ID }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('doctor with grant but suspended provider -> 403', async () => {
    const { db } = makeDb({
      recordsRow: recordRow(crypto, dek),
      appUserRow: {
        wallet_pubkey: doctor.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
    });
    const solana = makeSolana({
      record: activeRecord,
      grants: {
        [grantPda.toBase58()]: {
          status: { active: {} },
          expiresAt: { toNumber: () => Math.floor(Date.now() / 1000) + 3600 },
          doctor: doctor.publicKey,
          record: recordPda,
        },
      },
      provider: { verified: false },
    });
    await expect(
      service(db, solana).release(user(), { record_id: RECORD_ID }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('corrupt wrapped_dek -> 500, nothing delivered', async () => {
    const { db, inserts } = makeDb({
      recordsRow: {
        ...recordRow(crypto, dek),
        wrapped_dek: '\\x' + 'ff'.repeat(10),
      },
      appUserRow: {
        wallet_pubkey: patient.publicKey.toBase58(),
        wallet_verified_at: '2026-10-08T12:00:00Z',
      },
    });
    await expect(
      service(db, makeSolana({ record: activeRecord })).release(user(), {
        record_id: RECORD_ID,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(inserts).toHaveLength(0);
  });
});

describe('KeyCryptoService', () => {
  it('wrap/unwrap roundtrip + fingerprint', () => {
    const crypto = makeCrypto();
    const dek = randomBytes(32);
    const blob = crypto.wrapDek(dek, ORG_ID);
    expect(blob.length).toBe(60);
    expect(crypto.unwrapDek(blob, ORG_ID).equals(dek)).toBe(true);
    expect(crypto.dekFingerprint(dek)).toMatch(/^[0-9a-f]{64}$/);
    // Different org -> different KEK -> open fails
    expect(() =>
      crypto.unwrapDek(blob, '99999999-9999-4999-8999-999999999999'),
    ).toThrow();
  });

  it('boot fails on malformed MASTER_KEY', () => {
    const svc = new KeyCryptoService(new ConfigService({ MASTER_KEY: 'zz' }));
    expect(() => svc.onModuleInit()).toThrow(/32 bytes/);
  });
});
