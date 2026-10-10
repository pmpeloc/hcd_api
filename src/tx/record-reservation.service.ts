import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';

const wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const recordSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  patient_user_id: z.string().uuid(),
  issuer_doctor_id: z.string().uuid(),
  status: z.enum(['pending_chain', 'active', 'disputed', 'voided']),
  content_hash: z.string(),
  storage_path: z.string(),
  record_pda: z.string().nullable(),
});
const doctorSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  verified: z.boolean(),
  wallet_pubkey: wallet,
});
const userSchema = z.object({ wallet_pubkey: wallet.nullable() });

/**
 * Authorization contract between POST /records and /tx/build issue_record.
 *
 * A record upload leaves a persisted reservation (records row in
 * status 'pending_chain' with record_pda = null). Before building an
 * issue_record transaction the backend re-reads that row with the
 * service-role client and requires an exact match on identity, hash,
 * patient wallet and issuer wallet — so a doctor can only anchor the
 * ciphertext they registered, for the patient that authorized the upload.
 * Without this check any verified doctor could point issue_record at an
 * arbitrary storage_ref and end up as its on-chain issuer, which would
 * later entitle them to the record's DEK through /keys/release.
 */
@Injectable()
export class RecordReservationService {
  constructor(private readonly admin: SupabaseAdminFactory) {}

  async assertIssueable(args: {
    recordId: string;
    contentHash: string; // 64 lowercase hex chars
    patientWallet: string; // base58, from build args
    issuerWallet: string; // base58, the tx signer
  }) {
    const db = this.admin.create();

    const recordResult = await db
      .from('records')
      .select(
        'id, organization_id, patient_user_id, issuer_doctor_id, status, content_hash, storage_path, record_pda',
      )
      .eq('id', args.recordId)
      .maybeSingle();
    if (recordResult.error)
      throw new ServiceUnavailableException('Record lookup failed');
    const parsed = recordSchema.safeParse(recordResult.data);
    if (!parsed.success)
      throw new NotFoundException('Unknown record reservation');
    const record = parsed.data;

    if (record.status !== 'pending_chain' || record.record_pda !== null) {
      throw new ConflictException(
        'Record is already anchored or no longer pending',
      );
    }

    const storedHash = record.content_hash.replace(/^\\x/, '').toLowerCase();
    if (storedHash !== args.contentHash.toLowerCase()) {
      throw new ForbiddenException(
        'content_hash does not match the registered upload',
      );
    }

    // The storage path is server-derived at insert time; a mismatch means
    // the reservation is corrupt and must not be anchored.
    if (record.storage_path !== `${record.organization_id}/${record.id}.bin`) {
      throw new ServiceUnavailableException(
        'Record reservation is inconsistent',
      );
    }

    const doctorResult = await db
      .from('doctors')
      .select('id, user_id, organization_id, verified, wallet_pubkey')
      .eq('id', record.issuer_doctor_id)
      .maybeSingle();
    if (doctorResult.error)
      throw new ServiceUnavailableException('Doctor lookup failed');
    const doctor = doctorSchema.safeParse(doctorResult.data);
    if (
      !doctor.success ||
      !doctor.data.verified ||
      doctor.data.wallet_pubkey !== args.issuerWallet ||
      doctor.data.organization_id !== record.organization_id
    ) {
      throw new ForbiddenException('Record is not reserved for this issuer');
    }

    // The issuer's app_user wallet must be bound to the same pubkey, the
    // same invariant POST /records enforced at upload time.
    const issuerResult = await db
      .from('app_user')
      .select('wallet_pubkey')
      .eq('id', doctor.data.user_id)
      .eq('status', 'active')
      .not('wallet_verified_at', 'is', null)
      .maybeSingle();
    if (issuerResult.error)
      throw new ServiceUnavailableException('Issuer lookup failed');
    const issuer = userSchema.safeParse(issuerResult.data);
    if (!issuer.success || issuer.data.wallet_pubkey !== args.issuerWallet) {
      throw new ForbiddenException('Issuer wallet enrollment required');
    }

    const patientResult = await db
      .from('app_user')
      .select('wallet_pubkey')
      .eq('id', record.patient_user_id)
      .eq('role', 'patient')
      .eq('status', 'active')
      .not('wallet_verified_at', 'is', null)
      .maybeSingle();
    if (patientResult.error)
      throw new ServiceUnavailableException('Patient lookup failed');
    const patient = userSchema.safeParse(patientResult.data);
    if (!patient.success || patient.data.wallet_pubkey !== args.patientWallet) {
      throw new ForbiddenException(
        'patient wallet does not match the reservation',
      );
    }
  }
}
