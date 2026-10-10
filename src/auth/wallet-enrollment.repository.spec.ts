/// <reference types="jest" />
import { SupabaseAdminFactory } from './supabase-admin.factory';
import type { SupabaseClient } from '@supabase/supabase-js';
import { WalletEnrollmentRepository } from './wallet-enrollment.repository';
const user = '00000000-0000-4000-8000-000000000001';
const challengeId = '00000000-0000-4000-8000-000000000002';
describe('Wallet enrollment persistence boundary', () => {
  let repository: WalletEnrollmentRepository;
  let query: Record<string, jest.Mock>;
  let data: unknown;
  beforeEach(() => {
    data = {
      id: user,
      role: 'doctor',
      organization_id: challengeId,
      status: 'active',
      wallet_pubkey: null,
      wallet_verified_at: null,
    };
    query = {};
    for (const name of ['from', 'select', 'eq'])
      query[name] = jest.fn(() => query);
    query.maybeSingle = jest.fn(() => Promise.resolve({ data, error: null }));
    query.upsert = jest.fn().mockResolvedValue({ error: null });
    query.rpc = jest.fn().mockResolvedValue({ error: null });
    repository = new WalletEnrollmentRepository({} as SupabaseAdminFactory);
    jest
      .spyOn(repository as unknown as { db(): SupabaseClient }, 'db')
      .mockReturnValue(query as unknown as SupabaseClient);
  });
  it('only creates patient/null-organization and preserves existing profiles', async () => {
    const result = await repository.initialize(user);
    expect(query.upsert).toHaveBeenCalledWith(
      { id: user, role: 'patient', status: 'active', organization_id: null },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    expect(result.role).toBe('doctor');
    expect(result.organization_id).toBe(challengeId);
  });
  it('reuses the privileged client supplied by the shared factory', async () => {
    const create = jest.fn(() => query);
    const shared = new WalletEnrollmentRepository({
      create,
    } as unknown as SupabaseAdminFactory);
    await shared.profile(user);
    await shared.profile(user);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('does not reactivate suspended users or accept missing profiles', async () => {
    data = null;
    await expect(repository.profile(user)).rejects.toMatchObject({
      status: 403,
    });
    data = {
      id: user,
      role: 'patient',
      status: 'suspended',
      organization_id: null,
      wallet_pubkey: null,
      wallet_verified_at: null,
    };
    await expect(repository.initialize(user)).rejects.toMatchObject({
      status: 403,
    });
  });
  it.each(['expired', 'consumed', 'other-user', 'replaced'])(
    'rejects a %s challenge',
    async (state) => {
      data = {
        user_id: state === 'other-user' ? challengeId : user,
        challenge_id: state === 'replaced' ? user : challengeId,
        message: 'test',
        wallet_pubkey: 'test',
        expires_at: new Date(
          Date.now() + (state === 'expired' ? -1 : 60000),
        ).toISOString(),
        consumed_at: state === 'consumed' ? new Date().toISOString() : null,
      };
      await expect(
        repository.challenge(user, challengeId),
      ).rejects.toMatchObject({ status: 410 });
      expect(query.eq).toHaveBeenCalledWith('user_id', user);
      expect(query.eq).toHaveBeenCalledWith('challenge_id', challengeId);
    },
  );
  it.each([
    ['PT403', 403],
    ['PT409', 409],
    ['23505', 409],
    ['PT410', 410],
    ['XX000', 503],
  ])('maps completion error %s', async (code, status) => {
    query.rpc.mockResolvedValue({
      error: { code, message: 'private diagnostics' },
    });
    await expect(repository.complete(user, challengeId)).rejects.toMatchObject({
      status,
    });
    await expect(repository.complete(user, challengeId)).rejects.not.toThrow(
      'private diagnostics',
    );
  });
  it('fails closed on database read errors', async () => {
    query.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'private diagnostics' },
    });
    await expect(repository.profile(user)).rejects.toMatchObject({
      status: 503,
    });
    await expect(repository.challenge(user, challengeId)).rejects.toMatchObject(
      { status: 503 },
    );
    expect(query.rpc).not.toHaveBeenCalled();
  });
});
