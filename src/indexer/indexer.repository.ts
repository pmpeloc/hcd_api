import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';

const recordRowSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  patient_user_id: z.string().uuid(),
  issuer_doctor_id: z.string().uuid(),
});
export type IndexedRecordRow = z.infer<typeof recordRowSchema>;

const doctorRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
});

const auditEntry = z.object({
  organization_id: z.string().uuid().nullable(),
  record_id: z.string().uuid().nullable(),
  actor_user_id: z.string().uuid().nullable(),
  event_type: z.string().max(64),
  tx_signature: z.string().max(128),
});
export type AuditEntry = z.infer<typeof auditEntry>;

/**
 * Mirrors confirmed on-chain events into the database. Everything here runs
 * on the service role: events arrive over the websocket, not over a user
 * JWT, so there is no RLS boundary to lean on — every lookup is scoped in
 * code (record_pda match, pending_chain guard, wallet resolution).
 */
@Injectable()
export class IndexerRepository {
  constructor(private readonly admin: SupabaseAdminFactory) {}

  /** app_user id for a wallet pubkey (patients and doctors alike). */
  async userIdByWallet(wallet: string): Promise<string | null> {
    const result = await this.admin
      .create()
      .from('app_user')
      .select('id')
      .eq('wallet_pubkey', wallet)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('User lookup failed');
    const parsed = z.object({ id: z.string().uuid() }).safeParse(result.data);
    return parsed.success ? parsed.data.id : null;
  }

  /** Doctor row for an issuer wallet (doctors.wallet_pubkey mirrors the
   * bound app_user wallet). */
  async doctorByWallet(wallet: string) {
    const result = await this.admin
      .create()
      .from('doctors')
      .select('id, user_id')
      .eq('wallet_pubkey', wallet)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Doctor lookup failed');
    const parsed = doctorRowSchema.safeParse(result.data);
    return parsed.success ? parsed.data : null;
  }

  /** RecordIssued is the only event that can flip pending_chain -> active.
   * The conditional update is the boundary: only the reservation row that
   * matches patient + issuer and has never been anchored is touched, so a
   * replayed or forged log line can't resurrect a resolved record. */
  async activateRecord(args: {
    storageRef: string;
    recordPda: string;
    recordId: number;
    patientUserId: string;
    doctorId: string;
  }): Promise<IndexedRecordRow | null> {
    const result = await this.admin
      .create()
      .from('records')
      .update({
        record_pda: args.recordPda,
        record_id_onchain: args.recordId,
        status: 'active',
      })
      .eq('id', args.storageRef)
      .eq('patient_user_id', args.patientUserId)
      .eq('issuer_doctor_id', args.doctorId)
      .eq('status', 'pending_chain')
      .is('record_pda', null)
      .select('id, organization_id, patient_user_id, issuer_doctor_id')
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Record activation failed');
    const parsed = recordRowSchema.safeParse(result.data);
    return parsed.success ? parsed.data : null;
  }

  /** Any event that references a record account resolves the local row via
   * its anchored PDA — the only join key the chain and the DB share. */
  async recordByPda(recordPda: string): Promise<IndexedRecordRow | null> {
    const result = await this.admin
      .create()
      .from('records')
      .select('id, organization_id, patient_user_id, issuer_doctor_id')
      .eq('record_pda', recordPda)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Record lookup failed');
    const parsed = recordRowSchema.safeParse(result.data);
    return parsed.success ? parsed.data : null;
  }

  /** disputed/voided only apply while the record is still active — a voided
   * record can't be re-disputed, and a disputed one can still be voided by
   * the issuer. The program already rejects invalid transitions; this is
   * the mirror-side belt. */
  async setRecordStatus(recordId: string, status: 'disputed' | 'voided') {
    const allowed = status === 'disputed' ? 'active' : undefined;
    let q = this.admin
      .create()
      .from('records')
      .update({ status })
      .eq('id', recordId);
    if (allowed) q = q.eq('status', allowed);
    const result = await q.select('id').maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Record status update failed');
    return result.data !== null;
  }

  /** Idempotency: the same signature can be delivered again after a
   * reconnect. An identical (signature, event, record) entry means the
   * event was already mirrored. */
  async auditExists(
    txSignature: string,
    eventType: string,
    recordId: string | null,
  ): Promise<boolean> {
    let q = this.admin
      .create()
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('tx_signature', txSignature)
      .eq('event_type', eventType);
    q = recordId ? q.eq('record_id', recordId) : q.is('record_id', null);
    const result = await q;
    if (result.error)
      throw new ServiceUnavailableException('Audit lookup failed');
    return (result.count ?? 0) > 0;
  }

  async insertAudit(entry: AuditEntry) {
    const parsed = auditEntry.parse(entry);
    const result = await this.admin
      .create()
      .from('audit_events')
      .insert(parsed);
    if (result.error)
      throw new ServiceUnavailableException('Audit insert failed');
  }
}
