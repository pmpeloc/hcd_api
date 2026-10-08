import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { KeyCryptoService } from '../keys/key-crypto.service';
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
  ) {}

  async patientCode(request: AuthenticatedRequest) {
    const patient = await this.repository.ownPatient(request);
    return {
      patient_code: this.tokens.patient(patient.id, patient.wallet_pubkey),
      expires_in_seconds: 120,
    };
  }

  async uploadUrl(request: AuthenticatedRequest, body: UploadRecordDto) {
    const doctor = await this.repository.doctor(request);
    const patient = this.tokens.readPatient(body.patient_code);
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
    });
    const ticket = this.tokens.readUpload(uploadToken);
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
    const ciphertext = await this.repository.ciphertext(ticket);
    const hash = createHash('sha256').update(ciphertext).digest('hex');
    if (hash !== ticket.content_hash)
      throw new ConflictException(
        'Uploaded hash does not match the reservation',
      );
    const dek = Buffer.from(body.dek, 'base64');
    try {
      const wrapped = this.crypto.wrapDek(dek, ticket.organization_id);
      await this.repository.insert(
        ticket,
        wrapped,
        Buffer.from(body.encryption_iv, 'base64'),
      );
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
}
