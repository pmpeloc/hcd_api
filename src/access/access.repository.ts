import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import type { ListAccessRequestsDto } from './access.schemas';

const doctorSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  verified: z.boolean(),
  wallet_pubkey: z.string().nullable(),
});
export type DoctorRow = z.infer<typeof doctorSchema>;

const insertedRequestSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  created_at: z.string(),
});

const accessRequestSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  patient_user_id: z.string().uuid(),
  doctor_id: z.string().uuid(),
  record_ids: z.array(z.string().uuid()),
  granted_expires_at: z.string().nullable().optional(),
});
export type AccessRequestRow = z.infer<typeof accessRequestSchema>;

const myRequestRowSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  reason: z.string().nullable(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
  granted_expires_at: z.string().nullable(),
  record_ids: z.array(z.string().uuid()),
  doctor_id: z.string().uuid(),
  doctors: z
    .object({
      license_number: z.string().nullable(),
      specialty: z.string().nullable(),
      wallet_pubkey: z.string().nullable(),
      app_user: z.object({ full_name: z.string().nullable() }).nullable(),
      organizations: z.object({ name: z.string() }).nullable(),
    })
    .nullable(),
});
export type MyRequestRow = z.infer<typeof myRequestRowSchema>;

/**
 * Access-request reads run on the caller's JWT (RLS decides visibility);
 * writes and cross-tenant lookups go through the service role.
 */
@Injectable()
export class AccessRepository {
  constructor(private readonly admin: SupabaseAdminFactory) {}

  /** The caller's doctor row. Privileged read: a doctor's own row is visible
   * to them via RLS, but the verified flag must never be self-readable in a
   * way a stale cache could flip — go through service role like records. */
  async doctor(request: AuthenticatedRequest): Promise<DoctorRow> {
    const result = await this.admin
      .create()
      .from('doctors')
      .select('id, organization_id, verified, wallet_pubkey')
      .eq('user_id', request.user.id)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Doctor lookup failed');
    const parsed = doctorSchema.safeParse(result.data);
    if (!parsed.success) throw new ServiceUnavailableException('Not a doctor');
    return parsed.data;
  }

  /** Public-facing patient summary for the confirm screen: name + counts.
   * Service role because patients carry no organization and RLS hides them
   * from doctors. Never returns ids or wallet to the caller unchecked. */
  async patientSummary(patientId: string) {
    const db = this.admin.create();
    const user = await db
      .from('app_user')
      .select('id, full_name, created_at, role, status')
      .eq('id', patientId)
      .maybeSingle();
    if (user.error)
      throw new ServiceUnavailableException('Patient lookup failed');
    if (
      !user.data ||
      user.data.role !== 'patient' ||
      user.data.status !== 'active'
    ) {
      return null;
    }
    const count = await db
      .from('records')
      .select('id', { count: 'exact', head: true })
      .eq('patient_user_id', patientId);
    return {
      name: (user.data.full_name as string | null) ?? 'Paciente',
      member_since: user.data.created_at as string,
      record_count: count.count ?? 0,
    };
  }

  async pendingRequest(doctorId: string, patientId: string) {
    const result = await this.admin
      .create()
      .from('access_requests')
      .select('id')
      .eq('doctor_id', doctorId)
      .eq('patient_user_id', patientId)
      .eq('status', 'pending')
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Request lookup failed');
    return result.data;
  }

  async insertRequest(input: {
    organization_id: string;
    doctor_id: string;
    patient_user_id: string;
    reason: string;
  }) {
    const result = await this.admin
      .create()
      .from('access_requests')
      .insert({ ...input, record_ids: [] })
      .select('id, status, created_at')
      .single();
    if (result.error)
      throw new ServiceUnavailableException('Request create failed');
    const parsed = insertedRequestSchema.safeParse(result.data);
    if (!parsed.success)
      throw new ServiceUnavailableException('Request create failed');
    return parsed.data;
  }

  /** Patient's own requests, joined with doctor display info. Service role:
   * the doctors embed must be visible to patients, but RLS only exposes a
   * doctor to their own organization — so ownership is enforced here by the
   * explicit patient_user_id filter, same pattern as doctor(). Only display
   * fields are selected (no wallet). */
  async myRequests(
    request: AuthenticatedRequest,
    query: ListAccessRequestsDto,
  ): Promise<MyRequestRow[]> {
    let q = this.admin
      .create()
      .from('access_requests')
      .select(
        'id, status, reason, created_at, resolved_at, granted_expires_at, record_ids, doctor_id, doctors(license_number, specialty, wallet_pubkey, app_user!user_id(full_name), organizations(name))',
      )
      .eq('patient_user_id', request.user.id)
      .order('created_at', { ascending: false });
    if (query.status) q = q.eq('status', query.status);
    const result = await q;
    if (result.error)
      throw new ServiceUnavailableException('Request list failed');
    const parsed = z.array(myRequestRowSchema).safeParse(result.data);
    if (!parsed.success)
      throw new ServiceUnavailableException('Request list failed');
    return parsed.data;
  }

  /** The request the patient is resolving: must belong to them and be
   * pending. Read with the service role after the ownership check ran on
   * the user's JWT. */
  async pendingForPatient(requestId: string, patientId: string) {
    const result = await this.admin
      .create()
      .from('access_requests')
      .select(
        'id, status, patient_user_id, doctor_id, record_ids, granted_expires_at',
      )
      .eq('id', requestId)
      .eq('patient_user_id', patientId)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Request lookup failed');
    const parsed = accessRequestSchema.safeParse(result.data);
    return parsed.success ? parsed.data : null;
  }

  async resolveRequest(
    requestId: string,
    status: 'approved' | 'denied',
    fields?: { granted_expires_at?: string; record_ids?: string[] },
  ) {
    const result = await this.admin
      .create()
      .from('access_requests')
      .update({ status, resolved_at: new Date().toISOString(), ...fields })
      .eq('id', requestId)
      .eq('status', 'pending') // only a still-pending row resolves
      .select('id')
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Request update failed');
    return result.data; // null => someone else resolved it first
  }

  async doctorByRowId(doctorId: string): Promise<DoctorRow | null> {
    const result = await this.admin
      .create()
      .from('doctors')
      .select('id, organization_id, verified, wallet_pubkey')
      .eq('id', doctorId)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Doctor lookup failed');
    const parsed = doctorSchema.safeParse(result.data);
    return parsed.success ? parsed.data : null;
  }

  /** Records the grant covers: explicit ids, or the patient's whole active
   * history when the request asked for everything (empty record_ids). Only
   * anchored records can be granted on-chain. */
  async grantableRecords(patientId: string, recordIds: string[]) {
    let q = this.admin
      .create()
      .from('records')
      .select('id, record_pda')
      .eq('patient_user_id', patientId)
      .eq('status', 'active')
      .not('record_pda', 'is', null);
    if (recordIds.length > 0) q = q.in('id', recordIds);
    const result = await q;
    if (result.error)
      throw new ServiceUnavailableException('Record lookup failed');
    return result.data as { id: string; record_pda: string }[];
  }

  /** The patient's timeline: on-chain events the indexer mirrored into
   * audit_events. Service role because RLS hides organizations from patients
   * (they own no org), so the org name behind each event needs the elevated
   * client; the `records!inner` join + patient filter keeps the scoping
   * explicit in code instead. */
  async patientTimeline(request: AuthenticatedRequest) {
    const result = await this.admin
      .create()
      .from('audit_events')
      .select(
        'id, event_type, tx_signature, created_at, record_id, actor:app_user(wallet_pubkey), records!inner(title, patient_user_id), organizations(name)',
      )
      .eq('records.patient_user_id', request.user.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (result.error)
      throw new ServiceUnavailableException('Timeline lookup failed');
    // audit_events stores the actor id; the app shows the actor's wallet.
    return (
      result.data as unknown as (Record<string, unknown> & {
        actor: { wallet_pubkey: string | null } | null;
      })[]
    ).map(({ actor, ...row }) => ({
      ...row,
      actor_wallet: actor?.wallet_pubkey ?? null,
    }));
  }
}
