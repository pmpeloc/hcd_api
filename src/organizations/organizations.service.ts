import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { OrganizationsRepository } from './organizations.repository';
import type {
  AddDoctorDto,
  CreateOrganizationDto,
} from './organizations.schemas';

/**
 * Clinics and their doctors. In the MVP the team is the admin: only `admin`
 * creates organizations and verifies licenses; `clinic_admin` (and `admin`)
 * adds doctors to their own organization. Patients never touch this module.
 */
@Injectable()
export class OrganizationsService {
  constructor(private readonly repository: OrganizationsRepository) {}

  async create(request: AuthenticatedRequest, body: CreateOrganizationDto) {
    this.requireRole(request, ['admin']);
    return this.repository.createOrganization(body);
  }

  async mine(request: AuthenticatedRequest) {
    if (!request.user.organizationId)
      throw new NotFoundException('No organization');
    const result = await this.repository.myOrganization(request);
    if (result.error)
      throw new ServiceUnavailableException('Organization lookup failed');
    if (!result.data) throw new NotFoundException('No organization');
    return result.data;
  }

  async doctors(request: AuthenticatedRequest) {
    if (!request.user.organizationId)
      throw new NotFoundException('No organization');
    const result = await this.repository.myDoctors(request);
    if (result.error)
      throw new ServiceUnavailableException('Doctor list failed');
    return result.data;
  }

  async addDoctor(
    request: AuthenticatedRequest,
    organizationId: string,
    body: AddDoctorDto,
  ) {
    this.requireRole(request, ['admin', 'clinic_admin']);
    // Clinic admins only touch their own org; an admin may target any.
    if (
      request.user.role !== 'admin' &&
      request.user.organizationId !== organizationId
    ) {
      throw new ForbiddenException('Not your organization');
    }

    const candidate = await this.repository.doctorCandidate(body.user_id);
    if (!candidate) throw new NotFoundException('User not found');
    if (candidate.role !== 'doctor' || candidate.status !== 'active')
      throw new ConflictException('User is not an active doctor');
    if (
      candidate.organization_id !== null &&
      candidate.organization_id !== organizationId
    ) {
      throw new ConflictException('Doctor belongs to another organization');
    }

    const taken = await this.repository.doctorLicenseInOrg(
      organizationId,
      body.license_number,
    );
    if (taken)
      throw new ConflictException('License already registered in this org');

    return this.repository.addDoctor(organizationId, body);
  }

  async verify(
    request: AuthenticatedRequest,
    doctorId: string,
    verified: boolean,
  ) {
    this.requireRole(request, ['admin']);
    const updated = await this.repository.setVerified(doctorId, verified);
    if (!updated) throw new NotFoundException('Doctor not found');
    return updated;
  }

  private requireRole(
    request: AuthenticatedRequest,
    roles: Array<AuthenticatedRequest['user']['role']>,
  ) {
    if (!roles.includes(request.user.role))
      throw new ForbiddenException('Role not allowed');
  }
}
