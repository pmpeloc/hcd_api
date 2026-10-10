import { Keypair } from '@solana/web3.js';
import { AccessService } from './access.service';
import type { AuthenticatedRequest } from '../auth/authenticated-request';

const patientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const doctorUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const doctorRowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const orgId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const requestId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const recordId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
// PDAs and wallets flow through PublicKey derivation now, so the fixtures
// must be real base58 keys.
const doctorWallet = Keypair.generate().publicKey.toBase58();
const patientWallet = Keypair.generate().publicKey.toBase58();
const recordPda = Keypair.generate().publicKey.toBase58();

const asUser = (
  role: 'patient' | 'doctor' | 'clinic_admin' | 'admin',
  id = doctorUserId,
) =>
  ({
    user: { id, role, organizationId: orgId, status: 'active' },
    supabase: {},
  }) as unknown as AuthenticatedRequest;

const code = {
  patient_id: patientId,
  patient_wallet: patientWallet,
  nonce: '99999999-9999-4999-8999-999999999999',
  expires_at: Date.now() + 60000,
};

const doctorRow = {
  id: doctorRowId,
  organization_id: orgId,
  verified: true,
  wallet_pubkey: doctorWallet,
};

const repository = {
  doctor: jest.fn(() => Promise.resolve(doctorRow)),
  patientSummary: jest.fn(() =>
    Promise.resolve({
      name: 'Ana Martínez',
      member_since: '2026-09-01',
      record_count: 3,
    }),
  ),
  pendingRequest: jest.fn((): Promise<{ id: string } | null> =>
    Promise.resolve(null),
  ),
  insertRequest: jest.fn(() =>
    Promise.resolve({ id: requestId, status: 'pending', created_at: 'x' }),
  ),
  myRequests: jest.fn(
    (): Promise<
      {
        id: string;
        status: string;
        reason: string | null;
        created_at: string;
        resolved_at: string | null;
        granted_expires_at: string | null;
        record_ids: string[];
        doctor_id: string;
        doctors: {
          license_number: string | null;
          specialty: string | null;
          wallet_pubkey: string | null;
          app_user: { full_name: string | null } | null;
          organizations: { name: string } | null;
        } | null;
      }[]
    > => Promise.resolve([]),
  ),
  pendingForPatient: jest.fn(
    (): Promise<{
      id: string;
      status: string;
      patient_user_id: string;
      doctor_id: string;
      record_ids: string[];
      granted_expires_at?: string | null;
    } | null> =>
      Promise.resolve({
        id: requestId,
        status: 'pending',
        patient_user_id: patientId,
        doctor_id: doctorRowId,
        record_ids: [],
      }),
  ),
  resolveRequest: jest.fn((): Promise<{ id: string } | null> =>
    Promise.resolve({ id: requestId }),
  ),
  doctorByRowId: jest.fn(() => Promise.resolve(doctorRow)),
  grantableRecords: jest.fn(() =>
    Promise.resolve([{ id: recordId, record_pda: recordPda }]),
  ),
  patientTimeline: jest.fn(() => Promise.resolve([])),
};

const records = {
  consumePatientCode: jest.fn(() => Promise.resolve()),
  resolvePatientAlias: jest.fn(
    (): Promise<{
      patient_id: string;
      patient_wallet: string;
      nonce: string;
      expires_at: number;
    } | null> => Promise.resolve(null),
  ),
  ownPatient: jest.fn(() =>
    Promise.resolve({ id: patientId, wallet_pubkey: patientWallet }),
  ),
};

const tokens = {
  readPatient: jest.fn(() => code),
};

const fetchGrants = jest.fn((pdas: unknown[]): Promise<unknown[]> =>
  Promise.resolve(pdas.map(() => null)),
);
const activeGrant = {
  status: { active: {} },
  expiresAt: { toNumber: () => Math.floor(Date.now() / 1000) + 3600 },
};
const solana = {
  grantPda: jest.fn(() => ({
    toBase58: () => 'GrantPda111111111111111111111',
  })),
  program: { account: { accessGrant: { fetchMultiple: fetchGrants } } },
};

const service = new AccessService(
  repository as never,
  records as never,
  tokens as never,
  solana as never,
);

beforeEach(() => jest.clearAllMocks());

describe('lookup', () => {
  it('resolves a patient code without consuming it', async () => {
    const result = await service.lookup(asUser('doctor'), {
      patient_code: 'tok',
    });
    expect(result.patient.name).toBe('Ana Martínez');
    expect(tokens.readPatient).toHaveBeenCalledWith('tok');
    expect(records.consumePatientCode).not.toHaveBeenCalled();
  });

  it('patients cannot look up codes', async () => {
    await expect(
      service.lookup(asUser('patient', patientId), { patient_code: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('resolves a dictable SAL- alias through the persisted nonce', async () => {
    records.resolvePatientAlias.mockResolvedValueOnce(code);
    const result = await service.lookup(asUser('doctor'), {
      patient_code: 'SAL-4F7K',
    });
    expect(result.patient.name).toBe('Ana Martínez');
    expect(records.resolvePatientAlias).toHaveBeenCalledWith('SAL-4F7K');
    expect(tokens.readPatient).not.toHaveBeenCalled();
  });

  it('an unknown or expired SAL- alias is a 403, not a 404', async () => {
    await expect(
      service.lookup(asUser('doctor'), { patient_code: 'SAL-ZZZZ' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('create', () => {
  it('a verified doctor creates the request and burns the code', async () => {
    const result = await service.create(asUser('doctor'), {
      patient_code: 'tok',
      reason: 'Consulta de cardiología',
    });
    expect(result.request_id).toBe(requestId);
    expect(records.consumePatientCode).toHaveBeenCalledWith(
      code.nonce,
      patientId,
      code.expires_at,
    );
  });

  it('unverified doctors cannot request access', async () => {
    repository.doctor.mockResolvedValueOnce({ ...doctorRow, verified: false });
    await expect(
      service.create(asUser('doctor'), { patient_code: 't', reason: 'x y z' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('a doctor cannot request their own record', async () => {
    tokens.readPatient.mockReturnValueOnce({
      ...code,
      patient_id: doctorUserId,
    });
    await expect(
      service.create(asUser('doctor'), { patient_code: 't', reason: 'x y z' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('a second pending request for the same patient is a conflict', async () => {
    repository.pendingRequest.mockResolvedValueOnce({ id: requestId });
    await expect(
      service.create(asUser('doctor'), { patient_code: 't', reason: 'x y z' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(records.consumePatientCode).not.toHaveBeenCalled();
  });
});

describe('approve', () => {
  it('approves and returns one grant_access build per record', async () => {
    const result = await service.approve(
      asUser('patient', patientId),
      requestId,
      { duration_seconds: 3600 },
    );
    expect(result.status).toBe('approved');
    expect(result.build_requests).toHaveLength(1);
    expect(result.build_requests[0]).toMatchObject({
      instruction: 'grant_access',
      signer: patientWallet,
      args: { record: recordPda, doctor: doctorWallet },
    });
    expect(result.build_requests[0].args.expires_at).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
    // The covered records are pinned so the inbox can rebuild grant PDAs.
    expect(repository.resolveRequest).toHaveBeenCalledWith(
      requestId,
      'approved',
      expect.objectContaining({ record_ids: [recordId] }),
    );
  });

  it('another patients request -> 404, resolved -> 409', async () => {
    repository.pendingForPatient.mockResolvedValueOnce(null);
    await expect(
      service.approve(asUser('patient', patientId), requestId, {
        duration_seconds: 3600,
      }),
    ).rejects.toMatchObject({ status: 404 });

    repository.pendingForPatient.mockResolvedValueOnce({
      id: requestId,
      status: 'denied',
      patient_user_id: patientId,
      doctor_id: doctorRowId,
      record_ids: [],
    });
    await expect(
      service.approve(asUser('patient', patientId), requestId, {
        duration_seconds: 3600,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('re-approving a half-signed approval returns only the missing grants', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    repository.pendingForPatient.mockResolvedValueOnce({
      id: requestId,
      status: 'approved',
      patient_user_id: patientId,
      doctor_id: doctorRowId,
      record_ids: [recordId],
      granted_expires_at: future,
    });
    const result = await service.approve(
      asUser('patient', patientId),
      requestId,
      { duration_seconds: 3600 },
    );
    expect(result.build_requests).toHaveLength(1);
    expect(result.granted_expires_at).toBe(future);
    expect(repository.resolveRequest).not.toHaveBeenCalled();

    // Every grant already on-chain -> nothing to resume.
    fetchGrants.mockResolvedValueOnce([activeGrant]);
    repository.pendingForPatient.mockResolvedValueOnce({
      id: requestId,
      status: 'approved',
      patient_user_id: patientId,
      doctor_id: doctorRowId,
      record_ids: [recordId],
      granted_expires_at: future,
    });
    await expect(
      service.approve(asUser('patient', patientId), requestId, {
        duration_seconds: 3600,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a doctor that lost verification cannot be granted', async () => {
    repository.doctorByRowId.mockResolvedValueOnce({
      ...doctorRow,
      verified: false,
    });
    await expect(
      service.approve(asUser('patient', patientId), requestId, {
        duration_seconds: 3600,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(repository.resolveRequest).not.toHaveBeenCalled();
  });

  it('a lost resolve race -> 409', async () => {
    repository.resolveRequest.mockResolvedValueOnce(null);
    await expect(
      service.approve(asUser('patient', patientId), requestId, {
        duration_seconds: 3600,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('myRequests', () => {
  it('flattens the doctor embed and rebuilds grant PDAs for approved rows', async () => {
    repository.myRequests.mockResolvedValueOnce([
      {
        id: requestId,
        status: 'approved',
        reason: 'Consulta',
        created_at: '2026-10-01T00:00:00Z',
        resolved_at: '2026-10-02T00:00:00Z',
        granted_expires_at: '2026-10-03T00:00:00Z',
        record_ids: [recordId],
        doctor_id: doctorRowId,
        doctors: {
          license_number: 'MN-1',
          specialty: 'Clínica',
          wallet_pubkey: doctorWallet,
          app_user: { full_name: 'Dra. Ejemplo' },
          organizations: { name: 'Clínica Demo' },
        },
      },
    ]);
    const result = await service.myRequests(asUser('patient', patientId), {});
    const row = result.requests[0];
    expect(row.doctor).toMatchObject({
      name: 'Dra. Ejemplo',
      clinic: 'Clínica Demo',
      wallet_pubkey: doctorWallet,
    });
    expect(row.records).toEqual([
      {
        record_id: recordId,
        record_pda: recordPda,
        grant_pda: 'GrantPda111111111111111111111',
        grant_status: 'missing',
      },
    ]);
    expect(row.status).toBe('approved');
    expect(solana.grantPda).toHaveBeenCalled();
  });

  it('an approved request whose grants were all revoked on-chain reads as revoked', async () => {
    fetchGrants.mockResolvedValueOnce([
      { ...activeGrant, status: { revoked: {} } },
    ]);
    repository.myRequests.mockResolvedValueOnce([
      {
        id: requestId,
        status: 'approved',
        reason: 'Consulta',
        created_at: '2026-10-01T00:00:00Z',
        resolved_at: '2026-10-02T00:00:00Z',
        granted_expires_at: '2026-10-03T00:00:00Z',
        record_ids: [recordId],
        doctor_id: doctorRowId,
        doctors: {
          license_number: 'MN-1',
          specialty: null,
          wallet_pubkey: doctorWallet,
          app_user: null,
          organizations: null,
        },
      },
    ]);
    const result = await service.myRequests(asUser('patient', patientId), {});
    expect(result.requests[0].status).toBe('revoked');
    expect(result.requests[0].records[0].grant_status).toBe('revoked');
  });

  it('pending rows carry no grant records', async () => {
    repository.myRequests.mockResolvedValueOnce([
      {
        id: requestId,
        status: 'pending',
        reason: 'x',
        created_at: '2026-10-01T00:00:00Z',
        resolved_at: null,
        granted_expires_at: null,
        record_ids: [],
        doctor_id: doctorRowId,
        doctors: null,
      },
    ]);
    const result = await service.myRequests(asUser('patient', patientId), {});
    expect(result.requests[0].records).toEqual([]);
    expect(repository.grantableRecords).not.toHaveBeenCalled();
  });
});

describe('deny and timeline', () => {
  it('denies a pending request', async () => {
    await expect(
      service.deny(asUser('patient', patientId), requestId),
    ).resolves.toMatchObject({ status: 'denied' });
    expect(repository.resolveRequest).toHaveBeenCalledWith(requestId, 'denied');
  });

  it('timeline is patient-only', async () => {
    await expect(service.timeline(asUser('doctor'))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.timeline(asUser('patient', patientId)),
    ).resolves.toEqual([]);
  });
});
