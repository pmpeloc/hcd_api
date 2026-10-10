import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { RecordTokensService } from '../records/record-tokens.service';
import { RecordsRepository } from '../records/records.repository';
import { PublicKey, SolanaService } from '../tx/solana.service';
import { AccessRepository } from './access.repository';
import type {
  ApproveAccessRequestDto,
  CreateAccessRequestDto,
  ListAccessRequestsDto,
  LookupPatientDto,
} from './access.schemas';

/**
 * Off-chain access requests: the doctor asks with the patient's QR code and
 * the patient approves — which returns grant_access build requests the app
 * signs on-chain. The code resolves the patient without consuming it on
 * lookup; only creating the request burns the single-use nonce.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly repository: AccessRepository,
    private readonly records: RecordsRepository,
    private readonly tokens: RecordTokensService,
    private readonly solana: SolanaService,
  ) {}

  /** Codes arrive in two shapes: the signed HMAC token from the QR payload,
   * or the dictable `SAL-XXXX` alias persisted next to its nonce. */
  private async readPatientCode(input: string) {
    if (/^SAL-[A-HJ-KMNP-Z2-9]{4}$/.test(input)) {
      const alias = await this.records.resolvePatientAlias(input);
      if (!alias) {
        throw new ForbiddenException('Invalid or expired record token');
      }
      return alias;
    }
    return this.tokens.readPatient(input);
  }

  /** Scan → preview: who does this code belong to. Does NOT burn the nonce —
   * the code still authorizes the actual request (or an upload). */
  async lookup(request: AuthenticatedRequest, body: LookupPatientDto) {
    await this.assertDoctor(request);
    const patient = await this.readPatientCode(body.patient_code);
    const summary = await this.repository.patientSummary(patient.patient_id);
    if (!summary) throw new NotFoundException('Patient not found');
    return { patient: summary, expires_at: patient.expires_at };
  }

  async create(request: AuthenticatedRequest, body: CreateAccessRequestDto) {
    const doctor = await this.assertDoctor(request);
    const patient = await this.readPatientCode(body.patient_code);
    if (patient.patient_id === request.user.id)
      throw new ForbiddenException('Doctors cannot request their own record');

    const existing = await this.repository.pendingRequest(
      doctor.id,
      patient.patient_id,
    );
    if (existing) throw new ConflictException('Request already pending');

    // Single-use: one scanned code authorizes one action. From here on a
    // replay of the same QR gets a 403 before touching anything else.
    await this.records.consumePatientCode(
      patient.nonce,
      patient.patient_id,
      patient.expires_at,
    );

    const created = await this.repository.insertRequest({
      organization_id: doctor.organization_id,
      doctor_id: doctor.id,
      patient_user_id: patient.patient_id,
      reason: body.reason,
    });
    const summary = await this.repository.patientSummary(patient.patient_id);
    return { request_id: created.id, status: created.status, patient: summary };
  }

  /**
   * The patient's request inbox, normalized for the app: doctor display
   * fields flattened out of the embed, and for approved rows the on-chain
   * grant PDAs the client needs to sign revoke_access later.
   */
  async myRequests(
    request: AuthenticatedRequest,
    query: ListAccessRequestsDto,
  ) {
    if (request.user.role !== 'patient')
      throw new ForbiddenException('Patient role required');
    const rows = await this.repository.myRequests(request, query);
    const requests = await Promise.all(
      rows.map(async (row) => {
        const doctor = row.doctors;
        const result: {
          request_id: string;
          status: string;
          reason: string | null;
          created_at: string;
          resolved_at: string | null;
          granted_expires_at: string | null;
          doctor: {
            name: string;
            license: string | null;
            specialty: string | null;
            clinic: string | null;
            wallet_pubkey: string | null;
          } | null;
          records: {
            record_id: string;
            record_pda: string;
            grant_pda: string;
          }[];
        } = {
          request_id: row.id,
          status: row.status,
          reason: row.reason,
          created_at: row.created_at,
          resolved_at: row.resolved_at,
          granted_expires_at: row.granted_expires_at,
          doctor: doctor
            ? {
                name: doctor.app_user?.full_name ?? 'Profesional',
                license: doctor.license_number,
                specialty: doctor.specialty,
                clinic: doctor.organizations?.name ?? null,
                wallet_pubkey: doctor.wallet_pubkey,
              }
            : null,
          records: [],
        };
        if (
          row.status === 'approved' &&
          doctor?.wallet_pubkey &&
          row.record_ids.length > 0
        ) {
          const covered = await this.repository.grantableRecords(
            request.user.id,
            row.record_ids,
          );
          const doctorWallet = new PublicKey(doctor.wallet_pubkey);
          result.records = covered.map((record) => ({
            record_id: record.id,
            record_pda: record.record_pda,
            grant_pda: this.solana
              .grantPda(new PublicKey(record.record_pda), doctorWallet)
              .toBase58(),
          }));
        }
        return result;
      }),
    );
    return { requests };
  }

  /**
   * Patient approves: marks the request approved and returns one
   * grant_access build request per covered record. Only anchored records
   * (record_pda set) can be granted — pending_chain ones are skipped so the
   * patient never signs a grant against a nonexistent Record account.
   */
  async approve(
    request: AuthenticatedRequest,
    requestId: string,
    body: ApproveAccessRequestDto,
  ) {
    if (request.user.role !== 'patient')
      throw new ForbiddenException('Patient role required');
    const pending = await this.repository.pendingForPatient(
      requestId,
      request.user.id,
    );
    if (!pending) throw new NotFoundException('Request not found');
    if (pending.status !== 'pending')
      throw new ConflictException('Request already resolved');

    const doctor = await this.repository.doctorByRowId(pending.doctor_id);
    if (!doctor?.verified || !doctor.wallet_pubkey)
      throw new ConflictException('Doctor is no longer verified');

    const records = await this.repository.grantableRecords(
      request.user.id,
      pending.record_ids,
    );
    const expiresAt = Math.floor(Date.now() / 1000) + body.duration_seconds;
    const expiresAtIso = new Date(expiresAt * 1000).toISOString();

    // The conditional update is the atomicity boundary: concurrent approvals
    // race on status='pending' and the loser gets a 409. record_ids are
    // pinned to the covered set so a later listing can rebuild grant PDAs.
    const resolved = await this.repository.resolveRequest(
      requestId,
      'approved',
      {
        granted_expires_at: expiresAtIso,
        record_ids: records.map((record) => record.id),
      },
    );
    if (!resolved) throw new ConflictException('Request already resolved');

    // The patient signs with their own wallet; the app_user row holds it.
    const patient = await this.records.ownPatient(request);
    const doctorWallet = new PublicKey(doctor.wallet_pubkey);
    return {
      request_id: requestId,
      status: 'approved' as const,
      granted_expires_at: expiresAtIso,
      build_requests: records.map((record) => ({
        instruction: 'grant_access' as const,
        signer: patient.wallet_pubkey,
        args: {
          record: record.record_pda,
          doctor: doctor.wallet_pubkey,
          expires_at: expiresAt,
        },
        // Handy for the "Pueden ver" list the app paints right after signing.
        grant_pda: this.solana
          .grantPda(new PublicKey(record.record_pda), doctorWallet)
          .toBase58(),
      })),
    };
  }

  async deny(request: AuthenticatedRequest, requestId: string) {
    if (request.user.role !== 'patient')
      throw new ForbiddenException('Patient role required');
    const pending = await this.repository.pendingForPatient(
      requestId,
      request.user.id,
    );
    if (!pending) throw new NotFoundException('Request not found');
    const resolved = await this.repository.resolveRequest(requestId, 'denied');
    if (!resolved) throw new ConflictException('Request already resolved');
    return { request_id: requestId, status: 'denied' as const };
  }

  async timeline(request: AuthenticatedRequest) {
    if (request.user.role !== 'patient')
      throw new ForbiddenException('Patient role required');
    return this.repository.patientTimeline(request);
  }

  /** Doctors must be verified to request access: an unverified license can
   * ask for nothing, same rule as issue_record. */
  private async assertDoctor(request: AuthenticatedRequest) {
    if (request.user.role !== 'doctor')
      throw new ForbiddenException('Doctor role required');
    const doctor = await this.repository.doctor(request);
    if (!doctor.verified || !doctor.wallet_pubkey)
      throw new ForbiddenException('Doctor is not verified');
    return doctor;
  }
}
