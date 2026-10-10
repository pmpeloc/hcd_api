/// <reference types="jest" />
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { SupabaseClientFactory } from './supabase-client.factory';
import { WalletEnrollmentModule } from './wallet-enrollment.module';
import { WalletEnrollmentService } from './wallet-enrollment.service';

const user = '00000000-0000-4000-8000-000000000001';
describe('Wallet enrollment HTTP boundary', () => {
  let app: INestApplication;
  let url: string;
  const getClaims = jest.fn();
  const service = {
    initialize: jest.fn(),
    profile: jest.fn(),
    challenge: jest.fn(),
    verify: jest.fn(),
  };
  const headers = {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
        WalletEnrollmentModule,
      ],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({ create: () => ({ auth: { getClaims } }) })
      .overrideProvider(WalletEnrollmentService)
      .useValue(service)
      .compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: user,
          email: 'synthetic@example.test',
          role: 'admin',
          organization_id: user,
        },
      },
      error: null,
    });
    service.initialize.mockResolvedValue({
      id: user,
      role: 'patient',
      organization_id: null,
    });
  });

  it.each([
    ['POST', '/auth/profile'],
    ['GET', '/auth/profile'],
    ['POST', '/auth/wallet/challenge'],
    ['POST', '/auth/wallet/verify'],
  ])('rejects unauthenticated %s %s', async (method, path) => {
    expect((await fetch(url + path, { method })).status).toBe(401);
    expect(getClaims).not.toHaveBeenCalled();
  });
  it('bootstraps with verified subject only, ignoring claimed roles', async () => {
    const result = await fetch(url + '/auth/profile', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(result.status).toBe(201);
    expect(service.initialize).toHaveBeenCalledWith(user);
    expect(await result.json()).toEqual({
      id: user,
      role: 'patient',
      organization_id: null,
    });
  });
  it('rejects client roles or organization assignments', async () => {
    const result = await fetch(url + '/auth/profile', {
      method: 'POST',
      headers,
      body: JSON.stringify({ role: 'doctor', organization_id: user }),
    });
    expect(result.status).toBe(400);
    expect(service.initialize).not.toHaveBeenCalled();
  });
  it.each([
    { data: null, error: { message: 'expired' } },
    { data: { claims: { sub: 'invalid' } }, error: null },
  ])('rejects invalid tokens before initialization', async (claims) => {
    getClaims.mockResolvedValue(claims);
    expect(
      (
        await fetch(url + '/auth/profile', {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(service.initialize).not.toHaveBeenCalled();
  });
  it('fails closed without exposing authentication infrastructure errors', async () => {
    getClaims.mockRejectedValue(new Error('private connection details'));
    const result = await fetch(url + '/auth/profile', { headers });
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('private connection details');
  });
  it('rejects client-supplied account or message during verification', async () => {
    const result = await fetch(url + '/auth/wallet/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        challenge_id: user,
        signature: Buffer.alloc(64).toString('base64'),
        user_id: user,
        message: 'tampered',
      }),
    });
    expect(result.status).toBe(400);
    expect(service.verify).not.toHaveBeenCalled();
  });

  it('passes only the verified JWT email to the challenge service', async () => {
    const wallet = '11111111111111111111111111111111';
    const response = await fetch(url + '/auth/wallet/challenge', {
      method: 'POST',
      headers,
      body: JSON.stringify({ wallet_pubkey: wallet }),
    });
    expect(response.status).toBe(201);
    expect(service.challenge).toHaveBeenCalledWith(
      user,
      { wallet_pubkey: wallet },
      'synthetic@example.test',
    );
    const forged = await fetch(url + '/auth/wallet/challenge', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        wallet_pubkey: wallet,
        email: 'other@example.test',
      }),
    });
    expect(forged.status).toBe(400);
    expect(service.challenge).toHaveBeenCalledTimes(1);
  });

  it('throttles unauthenticated traffic before checking JWTs', async () => {
    for (let i = 0; i < 11; i++)
      await fetch(url + '/auth/profile', {
        headers: { Authorization: 'Bearer spam' },
      });
    getClaims.mockClear();
    expect((await fetch(url + '/auth/profile', { headers })).status).toBe(429);
    expect(getClaims).not.toHaveBeenCalled();
  });
});
