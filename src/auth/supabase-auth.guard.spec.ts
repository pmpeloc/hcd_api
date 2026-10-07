/// <reference types="jest" />
import { ExecutionContext } from '@nestjs/common';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { SupabaseClientFactory } from './supabase-client.factory';

const id = '00000000-0000-4000-8000-000000000001';
describe('SupabaseAuthGuard', () => {
  const getClaims = jest.fn();
  const maybeSingle = jest.fn();
  const eq = jest.fn(() => ({ maybeSingle }));
  const select = jest.fn(() => ({ eq }));
  const client = { auth: { getClaims }, from: jest.fn(() => ({ select })) };
  const create = jest.fn(() => client);
  const guard = new SupabaseAuthGuard({
    create,
  } as unknown as SupabaseClientFactory);
  let request: {
    headers: { authorization?: string };
    user?: unknown;
    supabase?: unknown;
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
  beforeEach(() => {
    jest.clearAllMocks();
    request = { headers: { authorization: 'Bearer test-token' } };
    getClaims.mockResolvedValue({
      data: { claims: { sub: id, role: 'admin' } },
      error: null,
    });
    maybeSingle.mockResolvedValue({
      data: { id, role: 'patient', organization_id: null, status: 'active' },
      error: null,
    });
  });
  it('uses database role and exposes the per-request RLS client', async () => {
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id,
      role: 'patient',
      organizationId: null,
      status: 'active',
    });
    expect(request.supabase).toBe(client);
    expect(create).toHaveBeenCalledWith('test-token');
    expect(eq).toHaveBeenCalledWith('id', id);
  });
  it.each([undefined, '', 'Basic token', 'Bearer', 'Bearer a b'])(
    'rejects malformed header %s',
    async (authorization) => {
      request.headers.authorization = authorization;
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        status: 401,
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
  it('rejects an invalid or expired token before database lookup', async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: 'expired' } });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
    });
    expect(client.from).not.toHaveBeenCalled();
  });
  it('denies users without a profile', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('denies suspended users', async () => {
    maybeSingle.mockResolvedValue({
      data: { id, role: 'doctor', organization_id: null, status: 'suspended' },
      error: null,
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 403,
    });
    expect(request.user).toBeUndefined();
  });
  it('fails closed when the database is unavailable', async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'private details' },
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 503,
    });
  });
  it('rejects unsupported database roles', async () => {
    maybeSingle.mockResolvedValue({
      data: { id, role: 'superuser', organization_id: null, status: 'active' },
      error: null,
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('rejects an invalid subject before lookup', async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: 'not-a-user-id' } },
      error: null,
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
    });
    expect(client.from).not.toHaveBeenCalled();
  });
  it('fails closed on authentication infrastructure errors', async () => {
    getClaims.mockRejectedValue(new Error('internal connection details'));
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 503,
      message: 'Authentication service unavailable',
    });
    expect(client.from).not.toHaveBeenCalled();
  });
});
