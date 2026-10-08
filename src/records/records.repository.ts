import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { SupabaseAdminFactory } from '../keys/supabase-admin.factory';
import { MAX_CIPHERTEXT_BYTES, type ListRecordsDto } from './records.schemas';
import type { UploadTicket } from './record-tokens.service';

const wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const doctorSchema = z.object({ id: z.string().uuid(), wallet_pubkey: wallet });
const patientSchema = z.object({
  id: z.string().uuid(),
  wallet_pubkey: wallet,
});
const listedSchema = z.object({
  id: z.string().uuid(),
  record_pda: z.string().nullable(),
  status: z.enum(['pending_chain', 'active', 'disputed', 'voided']),
  created_at: z.string(),
  encryption_iv: z.string().nullable(),
});

@Injectable()
export class RecordsRepository {
  constructor(
    private readonly admin: SupabaseAdminFactory,
    private readonly config: ConfigService,
  ) {}

  async doctor(request: AuthenticatedRequest) {
    const user = request.user;
    if (user.role !== 'doctor' || !user.organizationId)
      throw new ForbiddenException('Verified doctor required');
    const result = await request.supabase
      .from('doctors')
      .select('id, wallet_pubkey')
      .eq('user_id', user.id)
      .eq('organization_id', user.organizationId)
      .eq('verified', true)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Doctor lookup failed');
    const parsed = doctorSchema.safeParse(result.data);
    if (!parsed.success)
      throw new ForbiddenException('Verified doctor wallet required');
    const profile = await request.supabase
      .from('app_user')
      .select('wallet_pubkey')
      .eq('id', user.id)
      .maybeSingle();
    if (profile.error)
      throw new ServiceUnavailableException('Wallet lookup failed');
    const bound = z.object({ wallet_pubkey: wallet }).safeParse(profile.data);
    if (
      !bound.success ||
      bound.data.wallet_pubkey !== parsed.data.wallet_pubkey
    ) {
      throw new ForbiddenException('Doctor wallet enrollment required');
    }
    return {
      id: parsed.data.id,
      wallet: parsed.data.wallet_pubkey,
      organizationId: user.organizationId,
    };
  }

  async ownPatient(request: AuthenticatedRequest) {
    if (request.user.role !== 'patient')
      throw new ForbiddenException('Patient role required');
    const result = await request.supabase
      .from('app_user')
      .select('id, wallet_pubkey')
      .eq('id', request.user.id)
      .eq('role', 'patient')
      .eq('status', 'active')
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Patient lookup failed');
    const parsed = patientSchema.safeParse(result.data);
    if (!parsed.success)
      throw new ForbiddenException('Patient wallet enrollment required');
    return parsed.data;
  }

  async assertPatient(patientId: string, patientWallet: string) {
    // Cross-organization lookup authorized ONLY by a server-issued patient token.
    const result = await this.admin
      .create()
      .from('app_user')
      .select('id, wallet_pubkey')
      .eq('id', patientId)
      .eq('role', 'patient')
      .eq('status', 'active')
      .eq('wallet_pubkey', patientWallet)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Patient lookup failed');
    if (!patientSchema.safeParse(result.data).success)
      throw new ForbiddenException('Patient authorization is no longer valid');
  }

  path(ticket: Pick<UploadTicket, 'organization_id' | 'record_id'>) {
    return `${ticket.organization_id}/${ticket.record_id}.bin`;
  }

  private async bucket() {
    const db = this.admin.create();
    const name = this.config.get<string>('STORAGE_BUCKET') ?? 'records';
    const result = await db.storage.getBucket(name);
    if (
      result.error ||
      !result.data ||
      result.data.public ||
      !result.data.file_size_limit ||
      result.data.file_size_limit > MAX_CIPHERTEXT_BYTES
    ) {
      throw new ServiceUnavailableException(
        'A private, size-limited records bucket is required',
      );
    }
    return db.storage.from(name);
  }

  async uploadUrl(ticket: UploadTicket) {
    const bucket = await this.bucket();
    const result = await bucket.createSignedUploadUrl(this.path(ticket), {
      upsert: false,
    });
    if (result.error || !result.data)
      throw new ServiceUnavailableException('Upload URL unavailable');
    return result.data;
  }

  async ciphertext(ticket: UploadTicket) {
    const bucket = await this.bucket();
    const result = await bucket.download(this.path(ticket));
    if (result.error || !result.data)
      throw new ConflictException('Upload must complete before registration');
    if (
      result.data.size !== ticket.ciphertext_bytes ||
      result.data.size > MAX_CIPHERTEXT_BYTES
    ) {
      throw new ConflictException(
        'Uploaded size does not match the reservation',
      );
    }
    return Buffer.from(await result.data.arrayBuffer());
  }

  async insert(ticket: UploadTicket, wrappedDek: Buffer, iv: Buffer) {
    const result = await this.admin
      .create()
      .from('records')
      .insert({
        id: ticket.record_id,
        organization_id: ticket.organization_id,
        patient_user_id: ticket.patient_id,
        issuer_doctor_id: ticket.doctor_id,
        content_hash: `\\x${ticket.content_hash}`,
        storage_path: this.path(ticket),
        wrapped_dek: `\\x${wrappedDek.toString('hex')}`,
        encryption_iv: `\\x${iv.toString('hex')}`,
        // The indexer sets these ONLY after a confirmed RecordIssued event.
        record_pda: null,
        record_id_onchain: null,
        status: 'pending_chain',
      });
    if (result.error?.code === '23505')
      throw new ConflictException('Record already registered');
    if (result.error)
      throw new ServiceUnavailableException('Record registration failed');
  }

  async list(request: AuthenticatedRequest, query: ListRecordsDto) {
    if (request.user.role !== 'patient')
      throw new ForbiddenException('Patient role required');
    const result = await request.supabase
      .from('records')
      .select('id, record_pda, status, created_at, encryption_iv')
      .eq('patient_user_id', request.user.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);
    if (result.error)
      throw new ServiceUnavailableException('Records unavailable');
    const rows = z.array(listedSchema).safeParse(result.data);
    if (!rows.success)
      throw new ServiceUnavailableException('Records unavailable');
    return {
      records: rows.data.map((row) => ({
        id: row.id,
        record_pda: row.record_pda,
        status: row.record_pda ? row.status : 'pending_chain',
        created_at: row.created_at,
        encryption_iv: row.encryption_iv
          ? Buffer.from(row.encryption_iv.replace(/^\\x/, ''), 'hex').toString(
              'base64',
            )
          : null,
      })),
      offset: query.offset,
      limit: query.limit,
    };
  }
}
