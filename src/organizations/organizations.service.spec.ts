import { OrganizationsService } from './organizations.service';
import type { AuthenticatedRequest } from '../auth/authenticated-request';

const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clinicAdminId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const orgId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherOrg = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const userId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const doctorId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const asUser = (
  role: 'patient' | 'doctor' | 'clinic_admin' | 'admin',
  organizationId: string | null = orgId,
  id = adminId,
) =>
  ({
    user: { id, role, organizationId, status: 'active' },
    supabase: {},
  }) as unknown as AuthenticatedRequest;

type Candidate = {
  id: string;
  role: string;
  organization_id: string | null;
  status: string;
  full_name: string;
};

const repository = {
  createOrganization: jest.fn((b: unknown) => Promise.resolve(b)),
  myOrganization: jest.fn(() =>
    Promise.resolve({ data: { id: orgId }, error: null }),
  ),
  myDoctors: jest.fn(() => Promise.resolve({ data: [], error: null })),
  doctorCandidate: jest.fn((): Promise<Candidate | null> =>
    Promise.resolve({
      id: userId,
      role: 'doctor',
      organization_id: null,
      status: 'active',
      full_name: 'Dra. Test',
    }),
  ),
  doctorLicenseInOrg: jest.fn((): Promise<{ id: string } | null> =>
    Promise.resolve(null),
  ),
  addDoctor: jest.fn((_org: string, b: unknown) => Promise.resolve(b)),
  setVerified: jest.fn((): Promise<{ id: string; verified: boolean } | null> =>
    Promise.resolve({ id: doctorId, verified: true }),
  ),
};

const service = new OrganizationsService(repository as never);

beforeEach(() => jest.clearAllMocks());

describe('create organization', () => {
  it('admins create clinics', async () => {
    await expect(
      service.create(asUser('admin'), {
        name: 'Clínica del Sol',
        kind: 'clinic',
      }),
    ).resolves.toMatchObject({ name: 'Clínica del Sol' });
  });

  it('rejects non-admin roles', async () => {
    for (const role of ['patient', 'doctor', 'clinic_admin'] as const) {
      await expect(
        service.create(asUser(role), { name: 'X', kind: 'clinic' }),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(repository.createOrganization).not.toHaveBeenCalled();
  });
});

describe('my organization and doctors', () => {
  it('patients without org get 404', async () => {
    await expect(service.mine(asUser('patient', null))).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.doctors(asUser('patient', null)),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('addDoctor', () => {
  const body = { user_id: userId, license_number: 'MN-112.345' };

  it('clinic_admin adds a doctor to their own org', async () => {
    await expect(
      service.addDoctor(
        asUser('clinic_admin', orgId, clinicAdminId),
        orgId,
        body,
      ),
    ).resolves.toMatchObject({ license_number: 'MN-112.345' });
    expect(repository.addDoctor).toHaveBeenCalledWith(orgId, body);
  });

  it('clinic_admin cannot touch another org', async () => {
    await expect(
      service.addDoctor(asUser('clinic_admin', orgId), otherOrg, body),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.doctorCandidate).not.toHaveBeenCalled();
  });

  it('rejects a patient or another orgs doctor as candidate', async () => {
    repository.doctorCandidate.mockResolvedValueOnce({
      id: userId,
      role: 'patient',
      organization_id: null,
      status: 'active',
      full_name: 'X',
    });
    await expect(
      service.addDoctor(asUser('admin'), orgId, body),
    ).rejects.toMatchObject({ status: 409 });

    repository.doctorCandidate.mockResolvedValueOnce({
      id: userId,
      role: 'doctor',
      organization_id: otherOrg,
      status: 'active',
      full_name: 'X',
    });
    await expect(
      service.addDoctor(asUser('admin'), orgId, body),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a license already used in the org', async () => {
    repository.doctorLicenseInOrg.mockResolvedValueOnce({ id: doctorId });
    await expect(
      service.addDoctor(asUser('admin'), orgId, body),
    ).rejects.toMatchObject({ status: 409 });
    expect(repository.addDoctor).not.toHaveBeenCalled();
  });
});

describe('verify', () => {
  it('only admins verify doctors', async () => {
    await expect(
      service.verify(asUser('clinic_admin'), doctorId, true),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.verify(asUser('admin'), doctorId, true),
    ).resolves.toMatchObject({ verified: true });
  });

  it('unknown doctor -> 404', async () => {
    repository.setVerified.mockResolvedValueOnce(null);
    await expect(
      service.verify(asUser('admin'), doctorId, false),
    ).rejects.toMatchObject({ status: 404 });
  });
});
