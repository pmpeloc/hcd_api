import {
  ConflictException,
  ForbiddenException,
  Injectable,
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
}
