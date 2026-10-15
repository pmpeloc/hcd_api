import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';
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
  title: z.string().nullable(),
  study_date: z.string().nullable(),
  origin: z.string().nullable(),
  issuer_name: z.string().nullable(),
  issuer_org: z.string().nullable(),
});

const patientAliasSchema = z.object({
  nonce: z.string().uuid(),
  patient_user_id: z.string().uuid(),
  patient_wallet: wallet,
  expires_at: z.string(),
});

/** Matches the app's CODE_ALPHABET: no 0/O/1/I/L for dictation safety. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

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
      .not('wallet_verified_at', 'is', null)
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

  /**
   * Burns a patient-code nonce so the QR/token cannot be reused within its
   * 120 s window. The insert is the atomicity boundary: two concurrent
   * requests with the same code race on the primary key and the loser gets
   * 23505 -> 403. Expired rows are purged lazily on each consume.
   */
  async consumePatientCode(
    nonce: string,
    patientId: string,
    expiresAtMs: number,
  ) {
    const db = this.admin.create();
    await db
      .from('consumed_patient_codes')
      .delete()
      .lt('expires_at', new Date().toISOString());
    const result = await db.from('consumed_patient_codes').insert({
      nonce,
      patient_user_id: patientId,
      expires_at: new Date(expiresAtMs).toISOString(),
    });
    if (result.error?.code === '23505')
      throw new ForbiddenException('Patient code already used');
    if (result.error)
      throw new ServiceUnavailableException('Patient code check failed');
  }

  /**
   * Mints the short dictable alias for a patient-code nonce (`SAL-4F7K`).
   * The QR shows it and the patient can read it aloud; both forms resolve
   * to the same nonce, so the single-use consume covers either path.
   */
  async issuePatientAlias(ticket: {
    nonce: string;
    patient_id: string;
    patient_wallet: string;
    expires_at: number;
  }) {
    const db = this.admin.create();
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = randomBytes(4);
      const code = `SAL-${[...bytes]
        .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
        .join('')}`;
      const result = await db.from('patient_codes').insert({
        code,
        nonce: ticket.nonce,
        patient_user_id: ticket.patient_id,
        patient_wallet: ticket.patient_wallet,
        expires_at: new Date(ticket.expires_at).toISOString(),
      });
      if (!result.error) return code;
      if (result.error.code !== '23505')
        throw new ServiceUnavailableException('Patient code failed');
    }
    throw new ServiceUnavailableException('Patient code failed');
  }

  /**
   * Short code -> the same identity a signed token would carry. Expired
   * rows never resolve and are purged lazily on each call. Returns null
   * for unknown or expired codes; callers map that to 403.
   */
  async resolvePatientAlias(code: string) {
    const db = this.admin.create();
    await db
      .from('patient_codes')
      .delete()
      .lt('expires_at', new Date().toISOString());
    const result = await db
      .from('patient_codes')
      .select('nonce, patient_user_id, patient_wallet, expires_at')
      .eq('code', code)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Patient code lookup failed');
    const parsed = patientAliasSchema.safeParse(result.data);
    if (!parsed.success) return null;
    const expiresAt = new Date(parsed.data.expires_at).getTime();
    if (expiresAt <= Date.now()) return null;
    return {
      nonce: parsed.data.nonce,
      patient_id: parsed.data.patient_user_id,
      patient_wallet: parsed.data.patient_wallet,
      expires_at: expiresAt,
    };
  }

  path(ticket: Pick<UploadTicket, 'organization_id' | 'record_id'>) {
    return `${ticket.organization_id}/${ticket.record_id}.bin`;
  }

  /** Persists the upload reservation at signed-URL time so the token can be
   * consumed exactly once at registration. */
  async insertReservation(ticket: UploadTicket) {
    const result = await this.admin
      .create()
      .from('upload_reservations')
      .insert({
        record_id: ticket.record_id,
        organization_id: ticket.organization_id,
        patient_user_id: ticket.patient_id,
        doctor_id: ticket.doctor_id,
        user_id: ticket.user_id,
        patient_wallet: ticket.patient_wallet,
        doctor_wallet: ticket.doctor_wallet,
        content_hash: `\\x${ticket.content_hash}`,
        ciphertext_bytes: ticket.ciphertext_bytes,
        storage_path: this.path(ticket),
        expires_at: new Date(ticket.expires_at).toISOString(),
      });
    if (result.error?.code === '23505')
      throw new ConflictException('Record reservation already exists');
    if (result.error)
      throw new ServiceUnavailableException('Reservation failed');
  }

  /**
   * Burns the reservation so the upload token cannot be replayed. The
   * conditional update is the atomicity boundary: concurrent registrations
   * race on `consumed_at is null` and the loser gets 403. Expired,
   * unconsumed rows are purged lazily on each call.
   */
  async consumeReservation(ticket: UploadTicket) {
    const db = this.admin.create();
    const now = new Date().toISOString();
    await db
      .from('upload_reservations')
      .delete()
      .is('consumed_at', null)
      .lt('expires_at', now);
    const result = await db
      .from('upload_reservations')
      .update({ consumed_at: now })
      .eq('record_id', ticket.record_id)
      .is('consumed_at', null)
      .gt('expires_at', now)
      .select(
        'content_hash, ciphertext_bytes, organization_id, doctor_id, patient_user_id',
      )
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Reservation check failed');
    if (!result.data)
      throw new ForbiddenException('Upload token already used or expired');
    // Defense in depth: the persisted reservation must match the ticket.
    const row = result.data;
    const storedHash = String(row.content_hash).replace(/^\\x/, '');
    if (
      storedHash !== ticket.content_hash ||
      Number(row.ciphertext_bytes) !== ticket.ciphertext_bytes ||
      row.organization_id !== ticket.organization_id ||
      row.doctor_id !== ticket.doctor_id ||
      row.patient_user_id !== ticket.patient_id
    ) {
      throw new ConflictException(
        'Reservation does not match the upload token',
      );
    }
  }

  /** Best-effort removal of ciphertext left behind by a failed
   * registration; failures are intentionally swallowed. */
  async removeUpload(ticket: UploadTicket) {
    try {
      const bucket = await this.bucket();
      await bucket.remove([this.path(ticket)]);
    } catch {
      // Orphan cleanup is opportunistic; the reservation row is the log.
    }
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

  /**
   * Streams the uploaded ciphertext through SHA-256 without buffering it:
   * up to ~50 MiB per request used to sit in memory. The declared size is
   * checked from the blob metadata first, and the stream is aborted if the
   * body ever exceeds the reservation, so a lying client cannot make us
   * hash unbounded input.
   */
  /**
   * SHA-256 of the stored blob, streamed — the object is the sealed file
   * `iv(12) || ciphertext+tag`, so `content_hash` covers the IV too. When
   * `expectedIv` is given the blob's first 12 bytes must equal it, or the
   * client uploaded something that is not the sealed format it declared.
   */
  async ciphertextHash(ticket: UploadTicket, expectedIv?: Buffer) {
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
    const hash = createHash('sha256');
    let bytes = 0;
    let head = Buffer.alloc(0);
    for await (const chunk of result.data.stream()) {
      bytes += chunk.byteLength;
      if (bytes > ticket.ciphertext_bytes) {
        throw new ConflictException(
          'Uploaded size does not match the reservation',
        );
      }
      if (expectedIv && head.length < 12)
        head = Buffer.concat([head, Buffer.from(chunk)]);
      hash.update(chunk);
    }
    if (expectedIv && !head.subarray(0, 12).equals(expectedIv))
      throw new ConflictException('Sealed IV does not match encryption_iv');
    return hash.digest('hex');
  }

  /** Issuer display names denormalized at registration: "who issued it
   * then", immune to later name or organization changes. */
  async issuerDisplay(doctorId: string) {
    const result = await this.admin
      .create()
      .from('doctors')
      .select('app_user!user_id(full_name), organizations(name)')
      .eq('id', doctorId)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Issuer lookup failed');
    const parsed = z
      .object({
        app_user: z.object({ full_name: z.string().nullable() }).nullable(),
        organizations: z.object({ name: z.string() }).nullable(),
      })
      .safeParse(result.data);
    return {
      issuer_name: parsed.success ? parsed.data.app_user?.full_name : null,
      issuer_org: parsed.success
        ? (parsed.data.organizations?.name ?? null)
        : null,
    };
  }

  async insert(ticket: UploadTicket, wrappedDek: Buffer, iv: Buffer) {
    const display = await this.issuerDisplay(ticket.doctor_id);
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
        title: ticket.title ?? null,
        study_date: ticket.study_date ?? null,
        origin: ticket.origin ?? null,
        issuer_name: display.issuer_name ?? null,
        issuer_org: display.issuer_org ?? null,
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

  /** Reads one record's identity through the caller's JWT so RLS keeps the
   * row scoped to the patient or their organization. Metadata only. */
  async findPda(request: AuthenticatedRequest, recordId: string) {
    const result = await request.supabase
      .from('records')
      .select('id, record_pda')
      .eq('id', recordId)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Record lookup failed');
    const parsed = z
      .object({
        id: z.string().uuid(),
        record_pda: z.string().nullable(),
      })
      .safeParse(result.data);
    if (!parsed.success) throw new NotFoundException('Record not found');
    return parsed.data;
  }

  async list(request: AuthenticatedRequest, query: ListRecordsDto) {
    if (request.user.role !== 'patient')
      throw new ForbiddenException('Patient role required');
    const result = await request.supabase
      .from('records')
      .select(
        'id, record_pda, status, created_at, encryption_iv, title, study_date, origin, issuer_name, issuer_org',
      )
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
        title: row.title,
        study_date: row.study_date,
        origin: row.origin,
        issuer_name: row.issuer_name,
        issuer_org: row.issuer_org,
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
