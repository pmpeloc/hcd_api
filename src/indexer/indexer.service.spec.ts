import { ConfigService } from '@nestjs/config';
import { PublicKey } from '@solana/web3.js';
import { IndexerService } from './indexer.service';
import type { SolanaService } from '../tx/solana.service';

const recordPda = PublicKey.unique().toBase58();
const patientWallet = PublicKey.unique();
const doctorWallet = PublicKey.unique();
const recordRow = {
  id: '00000000-0000-4000-8000-000000000010',
  organization_id: '00000000-0000-4000-8000-000000000020',
  patient_user_id: '00000000-0000-4000-8000-000000000030',
  issuer_doctor_id: '00000000-0000-4000-8000-000000000040',
};

// Kept as plain jest.Mock properties (not Connection methods) so
// expect(connection.onLogs) does not trip unbound-method.
const connection = {
  onLogs: jest.fn(() => 7),
  removeOnLogsListener: jest.fn().mockResolvedValue(undefined),
};
const solana = {
  programId: PublicKey.unique(),
  connection,
  recordPda: jest.fn(() => new PublicKey(recordPda)),
} as unknown as SolanaService;

const repository = {
  userIdByWallet: jest.fn<Promise<string | null>, [string]>(),
  doctorByWallet: jest.fn<
    Promise<{ id: string; user_id: string } | null>,
    [string]
  >(),
  activateRecord: jest.fn<
    Promise<typeof recordRow | null>,
    [
      {
        recordPda: string;
        recordId: number;
        patientUserId: string;
        doctorId: string;
      },
    ]
  >(),
  recordByPda: jest.fn<Promise<typeof recordRow | null>, [string]>(),
  setRecordStatus: jest.fn<Promise<boolean>, [string, 'disputed' | 'voided']>(),
  auditExists: jest.fn<Promise<boolean>, [string, string, string | null]>(),
  insertAudit: jest.fn<Promise<void>, [unknown]>(),
};

const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;

describe('IndexerService', () => {
  let service: IndexerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IndexerService(solana, repository as never, config);
    repository.userIdByWallet.mockResolvedValue('user-1');
    repository.doctorByWallet.mockResolvedValue({
      id: 'doctor-1',
      user_id: 'doctor-user-1',
    });
    repository.recordByPda.mockResolvedValue(recordRow);
    repository.auditExists.mockResolvedValue(false);
  });

  it('subscribes on init and unsubscribes on destroy', async () => {
    service.onModuleInit();
    expect(connection.onLogs).toHaveBeenCalledWith(
      solana.programId,
      expect.any(Function),
      'confirmed',
    );
    await service.onModuleDestroy();
    expect(connection.removeOnLogsListener).toHaveBeenCalledWith(7);
  });

  it('does not subscribe when INDEXER_ENABLED=false', () => {
    const disabled = { get: jest.fn(() => 'false') };
    const svc = new IndexerService(
      solana,
      repository as never,
      disabled as never,
    );
    svc.onModuleInit();
    expect(connection.onLogs).not.toHaveBeenCalled();
  });

  it('RecordIssued activates the matching pending reservation', async () => {
    repository.activateRecord.mockResolvedValue(recordRow);
    await service.handleEvent(
      'RecordIssued',
      {
        record: new PublicKey(recordPda),
        patient: patientWallet,
        issuer: doctorWallet,
        record_id: { toNumber: () => 3 },
      },
      'sig-1',
    );
    expect(repository.activateRecord).toHaveBeenCalledWith({
      recordPda,
      recordId: 3,
      patientUserId: 'user-1',
      doctorId: 'doctor-1',
    });
    expect(repository.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'record_issued',
        record_id: recordRow.id,
        actor_user_id: 'doctor-user-1',
        tx_signature: 'sig-1',
      }),
    );
  });

  it('RecordIssued is ignored when the derived PDA differs', async () => {
    (solana.recordPda as jest.Mock).mockReturnValueOnce(PublicKey.unique());
    await service.handleEvent(
      'RecordIssued',
      {
        record: new PublicKey(recordPda),
        patient: patientWallet,
        issuer: doctorWallet,
        record_id: { toNumber: () => 3 },
      },
      'sig-x',
    );
    expect(repository.activateRecord).not.toHaveBeenCalled();
    expect(repository.insertAudit).not.toHaveBeenCalled();
  });

  it('RecordIssued is ignored when no reservation matches', async () => {
    repository.activateRecord.mockResolvedValue(null);
    await service.handleEvent(
      'RecordIssued',
      {
        record: new PublicKey(recordPda),
        patient: patientWallet,
        issuer: doctorWallet,
        record_id: { toNumber: () => 3 },
      },
      'sig-x',
    );
    expect(repository.insertAudit).not.toHaveBeenCalled();
  });

  it('RecordDisputed flags the record and audits the patient', async () => {
    await service.handleEvent(
      'RecordDisputed',
      { record: new PublicKey(recordPda), patient: patientWallet },
      'sig-2',
    );
    expect(repository.setRecordStatus).toHaveBeenCalledWith(
      recordRow.id,
      'disputed',
    );
    expect(repository.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'record_disputed' }),
    );
  });

  it('RecordVoided flags the record', async () => {
    await service.handleEvent(
      'RecordVoided',
      { record: new PublicKey(recordPda), issuer: doctorWallet },
      'sig-3',
    );
    expect(repository.setRecordStatus).toHaveBeenCalledWith(
      recordRow.id,
      'voided',
    );
    expect(repository.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'record_voided' }),
    );
  });

  it('AccessGranted audits with the patient as actor', async () => {
    await service.handleEvent(
      'AccessGranted',
      {
        record: new PublicKey(recordPda),
        patient: patientWallet,
        doctor: doctorWallet,
        expires_at: { toNumber: () => 1000 },
      },
      'sig-4',
    );
    expect(repository.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'access_granted',
        record_id: recordRow.id,
        actor_user_id: 'user-1',
      }),
    );
  });

  it('AccessLogged audits with the doctor as actor', async () => {
    repository.userIdByWallet.mockResolvedValue('doctor-user-1');
    await service.handleEvent(
      'AccessLogged',
      {
        record: new PublicKey(recordPda),
        doctor: doctorWallet,
        access_count: { toNumber: () => 1 },
      },
      'sig-5',
    );
    expect(repository.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'access_logged' }),
    );
  });

  it('events on unknown record PDAs are dropped', async () => {
    repository.recordByPda.mockResolvedValue(null);
    await service.handleEvent(
      'AccessGranted',
      {
        record: PublicKey.unique(),
        patient: patientWallet,
        doctor: doctorWallet,
        expires_at: { toNumber: () => 1 },
      },
      'sig-x',
    );
    expect(repository.insertAudit).not.toHaveBeenCalled();
  });

  it('a signature already mirrored is not duplicated', async () => {
    repository.auditExists.mockResolvedValue(true);
    repository.activateRecord.mockResolvedValue(recordRow);
    await service.handleEvent(
      'RecordIssued',
      {
        record: new PublicKey(recordPda),
        patient: patientWallet,
        issuer: doctorWallet,
        record_id: { toNumber: () => 3 },
      },
      'sig-1',
    );
    expect(repository.insertAudit).not.toHaveBeenCalled();
  });

  it('handleLogs swallows parse errors instead of killing the listener', async () => {
    service.onModuleInit();
    await expect(
      service.handleLogs(['Program log: garbage'], 'sig-bad'),
    ).resolves.toBeUndefined();
  });
});
