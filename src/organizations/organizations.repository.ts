import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseAdminFactory } from '../auth/supabase-admin.factory';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import type {
  AddDoctorDto,
  CreateOrganizationDto,
} from './organizations.schemas';

/** Organization writes go through the service role; reads stay on the
 * caller's JWT so RLS keeps each org scoped to its own rows. */
@Injectable()
export class OrganizationsRepository {
  constructor(private readonly admin: SupabaseAdminFactory) {}

  async createOrganization(body: CreateOrganizationDto) {
    const result = await this.admin
      .create()
      .from('organizations')
      .insert({ name: body.name, kind: body.kind })
      .select('id, name, kind, created_at')
      .single();
    if (result.error) throw new ServiceUnavailableException('Create failed');
    return result.data;
  }

  myOrganization(request: AuthenticatedRequest) {
    return request.supabase
      .from('organizations')
      .select('id, name, kind, created_at')
      .eq('id', request.user.organizationId!)
      .maybeSingle();
  }

  myDoctors(request: AuthenticatedRequest) {
    return request.supabase
      .from('doctors')
      .select(
        'id, user_id, license_number, specialty, wallet_pubkey, verified, created_at',
      )
      .eq('organization_id', request.user.organizationId!);
  }

  /** Looks up the target user with the service role: the clinic admin's own
   * JWT cannot see app_user rows outside its org, and a missing or misroled
   * user is a 409, not a silent null. */
  async doctorCandidate(userId: string) {
    const result = await this.admin
      .create()
      .from('app_user')
      .select('id, role, organization_id, status, full_name')
      .eq('id', userId)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('User lookup failed');
    return result.data;
  }

  async doctorLicenseInOrg(organizationId: string, licenseNumber: string) {
    const result = await this.admin
      .create()
      .from('doctors')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('license_number', licenseNumber)
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('License lookup failed');
    return result.data;
  }

  /**
   * Adds a doctor row and attaches the app_user to the organization. The
   * service already checked the candidate is a free or same-org doctor; the
   * guarded update re-verifies it so a concurrent attach cannot steal them.
   */
  async addDoctor(organizationId: string, body: AddDoctorDto) {
    const db = this.admin.create();
    const attach = await db
      .from('app_user')
      .update({ organization_id: organizationId })
      .eq('id', body.user_id)
      .eq('role', 'doctor')
      .or(`organization_id.is.null,organization_id.eq.${organizationId}`);
    if (attach.error)
      throw new ServiceUnavailableException('Doctor attach failed');
    const insert = await db
      .from('doctors')
      .insert({
        user_id: body.user_id,
        organization_id: organizationId,
        license_number: body.license_number,
        specialty: body.specialty ?? null,
      })
      .select('id, user_id, license_number, specialty, verified, created_at')
      .single();
    if (insert.error?.code === '23505' || insert.error?.code === '23503')
      throw new ConflictException('Doctor already registered here');
    if (insert.error)
      throw new ServiceUnavailableException('Doctor registration failed');
    return insert.data;
  }

  async setVerified(doctorId: string, verified: boolean) {
    const result = await this.admin
      .create()
      .from('doctors')
      .update({ verified })
      .eq('id', doctorId)
      .select('id, verified')
      .maybeSingle();
    if (result.error)
      throw new ServiceUnavailableException('Verification failed');
    return result.data;
  }
}
