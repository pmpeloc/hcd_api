/// <reference types="jest" />
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { KeyCryptoService } from '../keys/key-crypto.service';
import { RecordTokensService } from './record-tokens.service';
import { RecordsRepository } from './records.repository';
import { RecordsService } from './records.service';
import {
  createRecordSchema,
  listRecordsSchema,
  uploadRecordSchema,
  MAX_CIPHERTEXT_BYTES,
} from './records.schemas';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  patient: '00000000-0000-4000-8000-000000000002',
  org: '00000000-0000-4000-8000-000000000003',
  doctor: '00000000-0000-4000-8000-000000000004',
};
const patientWallet = '11111111111111111111111111111111';
const doctorWallet = '22222222222222222222222222222222';
const ciphertext = Buffer.alloc(33, 7);
const hash = createHash('sha256').update(ciphertext).digest('hex');
const dek = Buffer.alloc(32, 9).toString('base64');
const iv = Buffer.alloc(12, 5).toString('base64');
const config = new ConfigService({
  RECORDS_TOKEN_SECRET: 'ab'.repeat(32),
  MASTER_KEY: 'cd'.repeat(32),
});

describe('Record tokens', () => {
  const tokens = new RecordTokensService(config);
  tokens.onModuleInit();
  afterEach(() => jest.useRealTimers());

  it('expires patient codes exactly at two minutes', () => {
    jest.useFakeTimers().setSystemTime(1000000);
    const token = tokens.patient(ids.patient, patientWallet);
    expect(tokens.readPatient(token).patient_id).toBe(ids.patient);
    jest.advanceTimersByTime(120000);
    expect(() => tokens.readPatient(token)).toThrow('Invalid or expired');
  });

  it('rejects modified tokens and using a patient code as an upload ticket', () => {
    const token = tokens.patient(ids.patient, patientWallet);
    expect(() => tokens.readUpload(token)).toThrow('Invalid or expired');
    expect(() => tokens.readPatient(`a${token}`)).toThrow('Invalid or expired');
    expect(() => tokens.readPatient(`${token}.extra`)).toThrow(
      'Invalid or expired',
    );
  });

  it('denies token issuance without a separate configured secret', () => {
    const unconfigured = new RecordTokensService(new ConfigService());
    expect(() => unconfigured.onModuleInit()).toThrow('RECORDS_TOKEN_SECRET');
    expect(() => unconfigured.patient(ids.patient, patientWallet)).toThrow(
      'not configured',
    );
  });
});

describe('RecordsService', () => {
  const tokens = new RecordTokensService(config);
  tokens.onModuleInit();
  const crypto = new KeyCryptoService(config);
  crypto.onModuleInit();
  let repository: {
    doctor: jest.Mock;
    ownPatient: jest.Mock;
    assertPatient: jest.Mock;
    consumePatientCode: jest.Mock;
    uploadUrl: jest.Mock;
    insertReservation: jest.Mock;
    consumeReservation: jest.Mock;
    removeUpload: jest.Mock;
    ciphertextHash: jest.Mock;
    insert: jest.Mock;
    list: jest.Mock;
    findPda: jest.Mock;
  };
  let service: RecordsService;
  let request: AuthenticatedRequest;
  const solana = {
    program: { account: { record: { fetch: jest.fn() } } },
  } as unknown as ConstructorParameters<typeof RecordsService>[3];

  beforeEach(() => {
    request = {
      user: {
        id: ids.user,
        organizationId: ids.org,
        role: 'doctor',
        status: 'active',
      },
    } as AuthenticatedRequest;
    repository = {
      doctor: jest.fn().mockResolvedValue({
        id: ids.doctor,
        organizationId: ids.org,
        wallet: doctorWallet,
      }),
      ownPatient: jest
        .fn()
        .mockResolvedValue({ id: ids.patient, wallet_pubkey: patientWallet }),
      assertPatient: jest.fn().mockResolvedValue(undefined),
      consumePatientCode: jest.fn().mockResolvedValue(undefined),
      insertReservation: jest.fn().mockResolvedValue(undefined),
      consumeReservation: jest.fn().mockResolvedValue(undefined),
      removeUpload: jest.fn().mockResolvedValue(undefined),
      uploadUrl: jest.fn().mockResolvedValue({
        signedUrl: 'https://storage.invalid/upload',
        path: 'opaque.bin',
        token: 'storage-token',
      }),
      ciphertextHash: jest.fn().mockResolvedValue(hash),
      insert: jest.fn().mockResolvedValue(undefined),
      list: jest.fn(),
      findPda: jest.fn(),
    };
    service = new RecordsService(
      repository as unknown as RecordsRepository,
      tokens,
      crypto,
      solana,
    );
  });

  async function reserve() {
    return service.uploadUrl(request, {
      patient_code: tokens.patient(ids.patient, patientWallet),
      content_hash: hash,
      ciphertext_bytes: ciphertext.length,
    });
  }

  it('wraps the DEK and returns the persisted UUID as storage_ref, never a path', async () => {
    const upload = await reserve();
    const result = await service.create(request, {
      upload_token: upload.upload_token,
      dek,
      encryption_iv: iv,
    });
    expect(result).toEqual({
      record_id: upload.record_id,
      status: 'pending_chain',
      build_request: {
        instruction: 'issue_record',
        signer: doctorWallet,
        args: {
          patient: patientWallet,
          content_hash: hash,
          storage_ref: upload.record_id,
        },
      },
    });
    expect(repository.ciphertextHash).toHaveBeenCalledWith(
      expect.anything(),
      Buffer.from(iv, 'base64'),
    );
    const [ticket, wrapped, savedIv] = repository.insert.mock.calls[0] as [
      unknown,
      Buffer,
      Buffer,
    ];
    expect(ticket).toMatchObject({
      patient_id: ids.patient,
      organization_id: ids.org,
      user_id: ids.user,
    });
    expect(wrapped).toHaveLength(60);
    expect(crypto.unwrapDek(wrapped, ids.org)).toEqual(
      Buffer.from(dek, 'base64'),
    );
    expect(savedIv).toEqual(Buffer.from(iv, 'base64'));
    expect(JSON.stringify(result)).not.toContain(dek);
  });

  it.each(['user', 'organization', 'wallet'])(
    'rejects an upload reused by a different %s',
    async (changed) => {
      const upload = await reserve();
      if (changed === 'user') request.user.id = ids.patient;
      else
        repository.doctor.mockResolvedValue({
          id: ids.doctor,
          organizationId: changed === 'organization' ? ids.patient : ids.org,
          wallet: changed === 'wallet' ? patientWallet : doctorWallet,
        });
      await expect(
        service.create(request, {
          upload_token: upload.upload_token,
          dek,
          encryption_iv: iv,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(repository.ciphertextHash).not.toHaveBeenCalled();
      expect(repository.insert).not.toHaveBeenCalled();
    },
  );

  it('does not persist when the ciphertext hash changes', async () => {
    const upload = await reserve();
    repository.ciphertextHash.mockResolvedValue('cd'.repeat(32));
    await expect(
      service.create(request, {
        upload_token: upload.upload_token,
        dek,
        encryption_iv: iv,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('burns the patient code nonce so replays get 403 before upload', async () => {
    repository.consumePatientCode.mockRejectedValue(
      Object.assign(new Error('Patient code already used'), { status: 403 }),
    );
    await expect(reserve()).rejects.toMatchObject({ status: 403 });
    expect(repository.uploadUrl).not.toHaveBeenCalled();
  });

  it('persists the reservation when issuing an upload URL', async () => {
    const upload = await reserve();
    expect(repository.insertReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        record_id: upload.record_id,
        organization_id: ids.org,
      }),
    );
  });

  it('rejects a replayed upload token without touching storage', async () => {
    const upload = await reserve();
    repository.consumeReservation.mockRejectedValue(
      Object.assign(new Error('Upload token already used or expired'), {
        status: 403,
      }),
    );
    await expect(
      service.create(request, {
        upload_token: upload.upload_token,
        dek,
        encryption_iv: iv,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.ciphertextHash).not.toHaveBeenCalled();
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('removes the orphaned ciphertext when registration fails', async () => {
    const upload = await reserve();
    repository.insert.mockRejectedValue(new Error('database unavailable'));
    await expect(
      service.create(request, {
        upload_token: upload.upload_token,
        dek,
        encryption_iv: iv,
      }),
    ).rejects.toThrow('database unavailable');
    expect(repository.removeUpload).toHaveBeenCalledWith(
      expect.objectContaining({ record_id: upload.record_id }),
    );
  });

  it('returns the on-chain hash and null while pending_chain', async () => {
    const pda = 'BPFLoaderUpgradeab1e11111111111111111111111';
    repository.findPda.mockResolvedValue({ id: ids.patient, record_pda: pda });
    (solana.program.account.record.fetch as jest.Mock).mockResolvedValue({
      contentHash: Array.from(Buffer.alloc(32, 0xab)),
    });
    await expect(service.chainHash(request, ids.patient)).resolves.toEqual({
      record_pda: pda,
      content_hash: 'ab'.repeat(32),
    });
    repository.findPda.mockResolvedValue({ id: ids.patient, record_pda: null });
    await expect(service.chainHash(request, ids.patient)).resolves.toEqual({
      record_pda: null,
      content_hash: null,
    });
  });

  it('denies self-issued records before creating an upload URL', async () => {
    repository.doctor.mockResolvedValue({
      id: ids.doctor,
      organizationId: ids.org,
      wallet: patientWallet,
    });
    await expect(reserve()).rejects.toMatchObject({ status: 403 });
    expect(repository.uploadUrl).not.toHaveBeenCalled();
  });

  it('rechecks patient authorization before registration', async () => {
    const upload = await reserve();
    repository.assertPatient.mockRejectedValue(new Error('patient suspended'));
    await expect(
      service.create(request, {
        upload_token: upload.upload_token,
        dek,
        encryption_iv: iv,
      }),
    ).rejects.toThrow('patient suspended');
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('erases the decoded DEK buffer even when persistence fails', async () => {
    const upload = await reserve();
    let buffer: Buffer | undefined;
    const spy = jest.spyOn(crypto, 'wrapDek').mockImplementation((value) => {
      buffer = value;
      return Buffer.alloc(60);
    });
    repository.insert.mockRejectedValue(new Error('database unavailable'));
    try {
      await expect(
        service.create(request, {
          upload_token: upload.upload_token,
          dek,
          encryption_iv: iv,
        }),
      ).rejects.toThrow('database unavailable');
      expect(buffer).toEqual(Buffer.alloc(32));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Record request validation', () => {
  it('requires a 32-byte DEK and a 12-byte IV and rejects ownership overrides', () => {
    const valid = { upload_token: 'opaque-token', dek, encryption_iv: iv };
    expect(createRecordSchema.safeParse(valid).success).toBe(true);
    expect(
      createRecordSchema.safeParse({
        ...valid,
        dek: Buffer.alloc(31).toString('base64'),
      }).success,
    ).toBe(false);
    expect(
      createRecordSchema.safeParse({
        ...valid,
        encryption_iv: Buffer.alloc(11).toString('base64'),
      }).success,
    ).toBe(false);
    expect(
      createRecordSchema.safeParse({ ...valid, organization_id: ids.org })
        .success,
    ).toBe(false);
  });

  it('rejects zero hashes and oversized files', () => {
    const valid = {
      patient_code: 'opaque-token',
      content_hash: hash,
      ciphertext_bytes: 33,
    };
    expect(uploadRecordSchema.safeParse(valid).success).toBe(true);
    expect(
      uploadRecordSchema.safeParse({ ...valid, content_hash: '0'.repeat(64) })
        .success,
    ).toBe(false);
    expect(
      uploadRecordSchema.safeParse({
        ...valid,
        ciphertext_bytes: MAX_CIPHERTEXT_BYTES + 1,
      }).success,
    ).toBe(false);
  });

  it('ignores cache-buster params on the records query', () => {
    const parsed = listRecordsSchema.safeParse({ _: '1699', limit: '5' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ offset: 0, limit: 5 });
    }
  });

  it('never includes submitted keys in validation errors', () => {
    const pipe = new ZodValidationPipe(createRecordSchema);
    expect(() => pipe.transform({ dek: 'private-value' })).toThrow(
      'Invalid request',
    );
  });
});
