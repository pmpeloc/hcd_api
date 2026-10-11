import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { KeyCryptoService } from '../keys/key-crypto.service';
import { PublicKey, SolanaService } from '../tx/solana.service';
import { RecordTokensService } from './record-tokens.service';
import { RecordsRepository } from './records.repository';
import type {
  CreateRecordDto,
  ListRecordsDto,
  UploadRecordDto,
} from './records.schemas';

@Injectable()
export class RecordsService {
  constructor(
    private readonly repository: RecordsRepository,
    private readonly tokens: RecordTokensService,
    private readonly crypto: KeyCryptoService,
    private readonly solana: SolanaService,
  ) {}

  async patientCode(request: AuthenticatedRequest) {
    const patient = await this.repository.ownPatient(request);
    const patient_code = this.tokens.patient(patient.id, patient.wallet_pubkey);
    // The HMAC token is the QR's strong credential; the dictable alias is a
    // second handle on the same nonce, so one consume burns both.
    const code = await this.repository.issuePatientAlias(
      this.tokens.readPatient(patient_code),
    );
    return { patient_code, code, expires_in_seconds: 120 };
  }

  /** Codes arrive in two shapes: the signed HMAC token from the QR payload,
   * or the dictable `SAL-XXXX` alias persisted next to its nonce. Both end
   * in the same identity; anything else is a 403. */
  private async readPatientCode(input: string) {
    if (/^SAL-[A-HJ-KMNP-Z2-9]{4}$/.test(input)) {
      const alias = await this.repository.resolvePatientAlias(input);
      if (!alias) {
        throw new ForbiddenException('Invalid or expired record token');
      }
      return alias;
    }
    return this.tokens.readPatient(input);
  }

  async uploadUrl(request: AuthenticatedRequest, body: UploadRecordDto) {
    const doctor = await this.repository.doctor(request);
    const patient = await this.readPatientCode(body.patient_code);
    if (
      patient.patient_wallet === doctor.wallet ||
      patient.patient_id === request.user.id
    ) {
      throw new ForbiddenException(
        'Doctors cannot issue records to themselves',
      );
    }
    await this.repository.assertPatient(
      patient.patient_id,
      patient.patient_wallet,
    );
    // Single-use: burn the code before granting the upload URL. A replay
    // (any doctor, any org, until expiry) is a 403 from here on.
    await this.repository.consumePatientCode(
      patient.nonce,
      patient.patient_id,
      patient.expires_at,
    );
    const uploadToken = this.tokens.upload({
      patient_id: patient.patient_id,
      patient_wallet: patient.patient_wallet,
      record_id: randomUUID(),
      organization_id: doctor.organizationId,
      doctor_id: doctor.id,
      user_id: request.user.id,
      doctor_wallet: doctor.wallet,
      content_hash: body.content_hash,
      ciphertext_bytes: body.ciphertext_bytes,
      title: body.title,
      study_date: body.study_date,
      origin: body.origin,
    });
    const ticket = this.tokens.readUpload(uploadToken);
    // Persist the reservation so registration can consume it exactly once.
    await this.repository.insertReservation(ticket);
    const upload = await this.repository.uploadUrl(ticket);
    return {
      record_id: ticket.record_id,
      upload_token: uploadToken,
      upload_url: upload.signedUrl,
      upload_path: upload.path,
      storage_token: upload.token,
      registration_expires_in_seconds: 600,
    };
  }

  async create(request: AuthenticatedRequest, body: CreateRecordDto) {
    const doctor = await this.repository.doctor(request);
    const ticket = this.tokens.readUpload(body.upload_token);
    if (
      ticket.user_id !== request.user.id ||
      ticket.organization_id !== doctor.organizationId ||
      ticket.doctor_id !== doctor.id ||
      ticket.doctor_wallet !== doctor.wallet
    ) {
      throw new ForbiddenException(
        'Upload belongs to another doctor or organization',
      );
    }
    await this.repository.assertPatient(
      ticket.patient_id,
      ticket.patient_wallet,
    );
    // Single-use: burn the reservation before touching storage. A replay
    // gets 403 here and never reaches the download.
    await this.repository.consumeReservation(ticket);
    const dek = Buffer.from(body.dek, 'base64');
    try {
      // The blob must be the sealed file `iv || ct`: its first 12 bytes
      // have to equal the declared IV, not just the claimed hash.
      const hash = await this.repository.ciphertextHash(
        ticket,
        Buffer.from(body.encryption_iv, 'base64'),
      );
      if (hash !== ticket.content_hash)
        throw new ConflictException(
          'Uploaded hash does not match the reservation',
        );
      const wrapped = this.crypto.wrapDek(dek, ticket.organization_id);
      await this.repository.insert(
        ticket,
        wrapped,
        Buffer.from(body.encryption_iv, 'base64'),
      );
    } catch (error) {
      // The reservation is already consumed, so this upload can never be
      // registered: drop the orphaned ciphertext instead of leaving it.
      await this.repository.removeUpload(ticket);
      throw error;
    } finally {
      dek.fill(0);
    }
    // This is a build REQUEST, not a signed transaction or an on-chain receipt.
    // Tx integration must authorize this persisted reservation before co-signing.
    return {
      record_id: ticket.record_id,
      status: 'pending_chain' as const,
      build_request: {
        instruction: 'issue_record' as const,
        signer: ticket.doctor_wallet,
        args: {
          patient: ticket.patient_wallet,
          content_hash: ticket.content_hash,
          storage_ref: ticket.record_id,
        },
      },
    };
  }

  list(request: AuthenticatedRequest, query: ListRecordsDto) {
    return this.repository.list(request, query);
  }

  /**
   * The record's content hash as anchored on-chain. The viewer checks the
   * downloaded ciphertext against this hash before decrypting, so the
   * comparison cannot be satisfied by the key service alone. Returns
   * `content_hash: null` while the record is still pending_chain.
   */
  async chainHash(request: AuthenticatedRequest, recordId: string) {
    const record = await this.repository.findPda(request, recordId);
    if (!record.record_pda) {
      return { record_pda: null, content_hash: null };
    }
    const account = (await this.solana.program.account['record']
      .fetch(new PublicKey(record.record_pda))
      .catch(() => null)) as { contentHash?: number[] } | null;
    return {
      record_pda: record.record_pda,
      content_hash: account?.contentHash
        ? Buffer.from(account.contentHash).toString('hex')
        : null,
    };
  }

  /**
   * One record's metadata for an authorized reader: the patient owner, the
   * issuing doctor, or a doctor whose approved request still covers it.
   * Metadata only — opening the file goes through `/keys/release`.
   */
  async get(request: AuthenticatedRequest, recordId: string) {
    const record = await this.repository.findRecord(recordId);
    if (!record) throw new NotFoundException('Record not found');
    if (request.user.role === 'patient') {
      if (record.patient_user_id !== request.user.id)
        throw new ForbiddenException('Not your record');
      return this.toMeta(record, null, 'Vos');
    }
    const doctor = await this.repository.doctor(request);
    if (record.issuer_doctor_id === doctor.id) {
      const names = await this.repository.userNames([record.patient_user_id]);
      return this.toMeta(record, null, names.get(record.patient_user_id));
    }
    const covering = await this.coveringRequest(doctor, record);
    if (!covering)
      throw new ForbiddenException('No active access grant for this record');
    const names = await this.repository.userNames([record.patient_user_id]);
    return this.toMeta(record, covering, names.get(record.patient_user_id));
  }

  /** The approved request still covering this record for the doctor — on the
   * DB window AND on-chain: a revoked grant is denied even if the off-chain
   * row still looks live. */
  private async coveringRequest(
    doctor: { id: string; wallet: string },
    record: { id: string; record_pda: string | null },
  ) {
    const sent = await this.repository.sentRequests(doctor.id);
    const now = new Date();
    const covering =
      sent.find(
        (r) =>
          r.status === 'approved' &&
          r.record_ids.includes(record.id) &&
          r.granted_expires_at !== null &&
          new Date(r.granted_expires_at) > now,
      ) ?? null;
    if (!covering || !record.record_pda) return covering;
    const status = await this.grantStatuses(
      [record.record_pda],
      doctor.wallet,
    );
    return status[0] === 'active' ? covering : null;
  }

  /** The chain, not access_requests, says whether a grant still reads:
   * revoke_access and expiry never touch the off-chain row. */
  private async grantStatuses(
    recordPdas: string[],
    doctorWallet: string,
  ): Promise<('missing' | 'revoked' | 'expired' | 'active' | 'unknown')[]> {
    if (recordPdas.length === 0) return [];
    const doctor = new PublicKey(doctorWallet);
    const pdas = recordPdas.map((pda) =>
      pda
        ? this.solana.grantPda(new PublicKey(pda), doctor)
        : doctor,
    );
    const now = Math.floor(Date.now() / 1000);
    try {
      const accounts = (await this.solana.program.account[
        'accessGrant'
      ].fetchMultiple(pdas)) as ({
        status: Record<string, unknown>;
        expiresAt: { toNumber(): number };
      } | null)[];
      return accounts.map((grant) => {
        if (!grant) return 'missing';
        if ('revoked' in grant.status) return 'revoked';
        return grant.expiresAt.toNumber() <= now ? 'expired' : 'active';
      });
    } catch {
      return pdas.map(() => 'unknown');
    }
  }

  /**
   * The doctor's working set: their sent requests plus every record they can
   * open — issued by them, or covered by an approved request whose grant has
   * not expired. Patient names resolved from `app_user`.
   */
  async listForDoctor(request: AuthenticatedRequest) {
    const doctor = await this.repository.doctor(request);
    const [issued, sent] = await Promise.all([
      this.repository.issuedRecords(doctor.id),
      this.repository.sentRequests(doctor.id),
    ]);
    const now = new Date();
    const live = sent.filter(
      (r) =>
        r.status === 'approved' &&
        r.granted_expires_at !== null &&
        new Date(r.granted_expires_at) > now,
    );
    const grantedIds = [...new Set(live.flatMap((r) => r.record_ids))];
    const covered = await this.repository.recordsByIds(grantedIds);
    // The chain is the grant's source of truth: revoked or expired grants
    // drop out of the list even if the off-chain window looks open.
    const statuses = await this.grantStatuses(
      covered.map((r) => r.record_pda ?? ''),
      doctor.wallet,
    );
    const granted = covered.filter(
      (r, i) => statuses[i] === 'active' && r.issuer_doctor_id !== doctor.id,
    );
    const patientIds = [
      ...new Set([
        ...issued.map((r) => r.patient_user_id),
        ...granted.map((r) => r.patient_user_id),
        ...sent.map((r) => r.patient_user_id),
      ]),
    ];
    const names = await this.repository.userNames(patientIds);
    const expiryByRecord = new Map(
      live
        .filter((r) => granted.some((g) => r.record_ids.includes(g.id)))
        .flatMap((r) =>
          r.record_ids.map((id) => [id, r] as const),
        ),
    );
    const all = [...issued, ...granted].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    return {
      records: all.map((r) =>
        this.toMeta(
          r,
          expiryByRecord.get(r.id) ?? null,
          names.get(r.patient_user_id),
        ),
      ),
      requests: sent.map((r) => ({
        request_id: r.id,
        status: r.status,
        reason: r.reason,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
        granted_expires_at: r.granted_expires_at,
        patient: names.get(r.patient_user_id) ?? 'Paciente',
        record_count: r.record_ids.length,
      })),
    };
  }

  private toMeta(
    record: {
      id: string;
      title: string | null;
      study_date: string | null;
      origin: 'issued' | 'digitized' | null;
      issuer_name: string | null;
      issuer_org: string | null;
      status: string;
      created_at: string;
      record_pda: string | null;
    },
    covering: { granted_expires_at: string | null; resolved_at: string | null } | null,
    patientName: string | null | undefined,
  ) {
    return {
      id: record.id,
      title: record.title,
      study_date: record.study_date,
      origin: record.origin,
      issuer_name: record.issuer_name,
      issuer_org: record.issuer_org,
      status: record.record_pda ? record.status : 'pending_chain',
      created_at: record.created_at,
      patient: patientName ?? 'Paciente',
      grant: covering
        ? {
            granted_at: covering.resolved_at,
            expires_at: covering.granted_expires_at,
          }
        : null,
    };
  }
}
