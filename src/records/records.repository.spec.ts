/// <reference types="jest" />
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import type { SupabaseAdminFactory } from '../auth/supabase-admin.factory';
import { RecordsRepository } from './records.repository';
import type { UploadTicket } from './record-tokens.service';

const id = '00000000-0000-4000-8000-000000000001';
const org = '00000000-0000-4000-8000-000000000002';
const wallet = '11111111111111111111111111111111';

describe('RecordsRepository authorization and persistence', () => {
  let result: {
    data: unknown;
    error: null | { code?: string; message: string };
  };
  let chain: Record<string, jest.Mock>;
  let storage: { getBucket: jest.Mock; from: jest.Mock };
  let bucket: {
    createSignedUploadUrl: jest.Mock;
    download: jest.Mock;
    remove: jest.Mock;
  };
  let adminCreate: jest.Mock;
  let repository: RecordsRepository;
  let request: AuthenticatedRequest;
  const ticket = {
    record_id: id,
    organization_id: org,
    ciphertext_bytes: 33,
    patient_id: id,
    doctor_id: id,
    content_hash: 'ab'.repeat(32),
  } as UploadTicket;

  beforeEach(() => {
    result = { data: [], error: null };
    chain = {};
    for (const name of [
      'select',
      'eq',
      'order',
      'from',
      'delete',
      'update',
      'is',
      'gt',
    ])
      chain[name] = jest.fn(() => chain);
    for (const name of ['range', 'maybeSingle', 'insert', 'lt'])
      chain[name] = jest.fn(() => Promise.resolve(result));
    bucket = {
      createSignedUploadUrl: jest.fn().mockResolvedValue({
        data: { signedUrl: 'url', path: 'path', token: 'token' },
        error: null,
      }),
      download: jest.fn().mockResolvedValue({
        data: new Blob([new Uint8Array(33)]),
        error: null,
      }),
      remove: jest.fn().mockResolvedValue({ data: [], error: null }),
    };
    storage = {
      getBucket: jest.fn().mockResolvedValue({
        data: { public: false, file_size_limit: 52428816 },
        error: null,
      }),
      from: jest.fn(() => bucket),
    };
    adminCreate = jest.fn(() => ({ ...chain, storage }));
    repository = new RecordsRepository(
      { create: adminCreate } as unknown as SupabaseAdminFactory,
      new ConfigService(),
    );
    request = {
      user: { id, role: 'patient', status: 'active', organizationId: null },
      supabase: chain,
    } as unknown as AuthenticatedRequest;
  });

  it('lists only the authenticated patient through RLS and hides wrapped keys and paths', async () => {
    result.data = [
      {
        id,
        record_pda: null,
        status: 'active',
        created_at: '2026-10-08T12:00:00Z',
        encryption_iv: '\\x' + 'aa'.repeat(12),
        title: 'Ecocardiograma',
        study_date: '2026-10-01',
        origin: 'issued',
        issuer_name: 'Dra. Ejemplo',
        issuer_org: 'Clínica Demo',
        wrapped_dek: 'private',
        storage_path: 'private',
      },
    ];
    const response = await repository.list(request, { offset: 0, limit: 20 });
    expect(chain.eq).toHaveBeenCalledWith('patient_user_id', id);
    expect(chain.range).toHaveBeenCalledWith(0, 19);
    expect(adminCreate).not.toHaveBeenCalled();
    expect(response.records[0].status).toBe('pending_chain');
    expect(response.records[0].title).toBe('Ecocardiograma');
    expect(response.records[0].issuer_org).toBe('Clínica Demo');
    expect(response.records[0].encryption_iv).toBe(
      Buffer.alloc(12, 0xaa).toString('base64'),
    );
    expect(JSON.stringify(response)).not.toContain('private');
    expect(chain.select).toHaveBeenCalledWith(
      'id, record_pda, status, created_at, encryption_iv, title, study_date, origin, issuer_name, issuer_org',
    );
  });

  it('does not expose database errors or allow doctors to use the patient listing', async () => {
    result.error = { message: 'sensitive database details' };
    await expect(
      repository.list(request, { offset: 0, limit: 20 }),
    ).rejects.toMatchObject({ status: 503, message: 'Records unavailable' });
    request.user.role = 'doctor';
    await expect(
      repository.list(request, { offset: 0, limit: 20 }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('requires doctor verification in the current organization and a matching enrolled wallet', async () => {
    request.user.role = 'doctor';
    request.user.organizationId = org;
    chain.maybeSingle
      .mockResolvedValueOnce({
        data: { id, wallet_pubkey: wallet },
        error: null,
      })
      .mockResolvedValueOnce({ data: { wallet_pubkey: wallet }, error: null });
    await expect(repository.doctor(request)).resolves.toEqual({
      id,
      wallet,
      organizationId: org,
    });
    expect(chain.eq).toHaveBeenCalledWith('organization_id', org);
    expect(chain.eq).toHaveBeenCalledWith('user_id', id);
    expect(chain.eq).toHaveBeenCalledWith('verified', true);
    expect(adminCreate).not.toHaveBeenCalled();
  });

  it('rejects a missing doctor or a mismatched wallet', async () => {
    request.user.role = 'doctor';
    request.user.organizationId = org;
    result.data = null;
    await expect(repository.doctor(request)).rejects.toMatchObject({
      status: 403,
    });
    chain.maybeSingle
      .mockResolvedValueOnce({
        data: { id, wallet_pubkey: wallet },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { wallet_pubkey: '22222222222222222222222222222222' },
        error: null,
      });
    await expect(repository.doctor(request)).rejects.toMatchObject({
      status: 403,
    });
  });

  it.each([
    { public: true, file_size_limit: 52428816 },
    { public: false },
    { public: false, file_size_limit: 100000000 },
  ])('denies unsafe bucket configuration %j', async (data) => {
    storage.getBucket.mockResolvedValue({ data, error: null });
    await expect(repository.uploadUrl(ticket)).rejects.toMatchObject({
      status: 503,
    });
    expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('uses an opaque organization path with overwrite disabled', async () => {
    await repository.uploadUrl(ticket);
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(
      `${org}/${id}.bin`,
      { upsert: false },
    );
  });

  it('rejects missing uploads and incorrect uploaded lengths', async () => {
    bucket.download.mockResolvedValueOnce({
      data: null,
      error: { message: 'not found' },
    });
    await expect(repository.ciphertextHash(ticket)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      repository.ciphertextHash({ ...ticket, ciphertext_bytes: 35 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('hashes the streamed ciphertext without buffering it', async () => {
    const digest = await repository.ciphertextHash(ticket);
    // The spec blob is 33 zero bytes; the digest proves the stream ran.
    expect(digest).toBe(
      createHash('sha256').update(Buffer.alloc(33)).digest('hex'),
    );
  });

  it('checks the sealed IV prefix against the declared encryption_iv', async () => {
    // The spec blob is 33 zero bytes: a zero IV matches, any other fails.
    await expect(
      repository.ciphertextHash(ticket, Buffer.alloc(12)),
    ).resolves.toBe(
      createHash('sha256').update(Buffer.alloc(33)).digest('hex'),
    );
    await expect(
      repository.ciphertextHash(ticket, Buffer.alloc(12, 1)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('burns patient-code nonces atomically: 23505 -> 403, db error -> 503', async () => {
    const nonce = '55555555-5555-4555-8555-555555555555';
    await expect(
      repository.consumePatientCode(nonce, id, Date.now() + 120000),
    ).resolves.toBeUndefined();
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ nonce, patient_user_id: id }),
    );
    expect(chain.lt).toHaveBeenCalled();
    result.error = { code: '23505', message: 'duplicate' };
    await expect(
      repository.consumePatientCode(nonce, id, Date.now() + 120000),
    ).rejects.toMatchObject({ status: 403 });
    result.error = { message: 'connection lost' };
    await expect(
      repository.consumePatientCode(nonce, id, Date.now() + 120000),
    ).rejects.toMatchObject({ status: 503 });
  });

  const fullTicket = {
    record_id: id,
    organization_id: org,
    patient_id: id,
    patient_wallet: wallet,
    doctor_id: id,
    user_id: id,
    doctor_wallet: wallet,
    content_hash: 'ab'.repeat(32),
    ciphertext_bytes: 33,
    expires_at: Date.now() + 600000,
  } as UploadTicket;

  it('persists the upload reservation mirroring the ticket', async () => {
    await repository.insertReservation(fullTicket);
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        record_id: id,
        organization_id: org,
        patient_user_id: id,
        doctor_id: id,
        storage_path: `${org}/${id}.bin`,
        content_hash: '\\x' + 'ab'.repeat(32),
      }),
    );
  });

  it('consumes the reservation atomically and verifies it matches the ticket', async () => {
    result.data = {
      content_hash: '\\x' + 'ab'.repeat(32),
      ciphertext_bytes: 33,
      organization_id: org,
      doctor_id: id,
      patient_user_id: id,
    };
    await expect(
      repository.consumeReservation(fullTicket),
    ).resolves.toBeUndefined();
    expect(chain.update).toHaveBeenCalled();
    const updateCalls = chain.update.mock.calls as [{ consumed_at: string }][];
    expect(typeof updateCalls[0][0].consumed_at).toBe('string');
    expect(chain.is).toHaveBeenCalledWith('consumed_at', null);
    expect(chain.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
  });

  it('rejects a replayed reservation with 403 and a db failure with 503', async () => {
    result.data = null;
    await expect(
      repository.consumeReservation(fullTicket),
    ).rejects.toMatchObject({ status: 403 });
    result.error = { message: 'connection lost' };
    await expect(
      repository.consumeReservation(fullTicket),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a reservation that does not match the ticket', async () => {
    result.data = {
      content_hash: '\\x' + 'cd'.repeat(32),
      ciphertext_bytes: 33,
      organization_id: org,
      doctor_id: id,
      patient_user_id: id,
    };
    await expect(
      repository.consumeReservation(fullTicket),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('removes orphaned ciphertext best-effort', async () => {
    await repository.removeUpload(fullTicket);
    expect(bucket.remove).toHaveBeenCalledWith([`${org}/${id}.bin`]);
    bucket.remove.mockRejectedValue(new Error('storage down'));
    await expect(repository.removeUpload(fullTicket)).resolves.toBeUndefined();
  });

  it('persists binary values as bytea and translates concurrent duplicate insertion to 409', async () => {
    // issuerDisplay resolves doctor + org names through a separate lookup.
    chain.maybeSingle.mockResolvedValue({
      data: {
        app_user: { full_name: 'Dra. Ejemplo' },
        organizations: { name: 'Clínica Demo' },
      },
      error: null,
    });
    await repository.insert(ticket, Buffer.alloc(60, 1), Buffer.alloc(12, 2));
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        organization_id: org,
        storage_path: `${org}/${id}.bin`,
        wrapped_dek: '\\x' + '01'.repeat(60),
        content_hash: '\\x' + 'ab'.repeat(32),
        encryption_iv: '\\x' + '02'.repeat(12),
        issuer_name: 'Dra. Ejemplo',
        issuer_org: 'Clínica Demo',
        record_pda: null,
        status: 'pending_chain',
      }),
    );
    result.error = { code: '23505', message: 'duplicate' };
    await expect(
      repository.insert(ticket, Buffer.alloc(60), Buffer.alloc(12)),
    ).rejects.toMatchObject({ status: 409 });
  });
});
