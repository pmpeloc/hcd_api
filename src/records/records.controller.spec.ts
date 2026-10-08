/// <reference types="jest" />
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { SupabaseClientFactory } from '../auth/supabase-client.factory';
import { RecordsModule } from './records.module';
import { RecordsService } from './records.service';
import type { AuthenticatedRequest } from '../auth/authenticated-request';

describe('Records HTTP boundary', () => {
  let app: INestApplication;
  let url: string;
  const create = jest.fn();
  const records = {
    create: jest.fn(),
    list: jest.fn(),
    patientCode: jest.fn(),
    uploadUrl: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [() => ({ MASTER_KEY: 'ab'.repeat(32) })],
        }),
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
        RecordsModule,
      ],
    })
      .overrideProvider(RecordsService)
      .useValue(records)
      .overrideProvider(SupabaseClientFactory)
      .useValue({ create })
      .compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    create.mockReturnValue({
      auth: {
        getClaims: jest.fn().mockResolvedValue({
          data: { claims: { sub: '00000000-0000-4000-8000-000000000001' } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: '00000000-0000-4000-8000-000000000001',
                  role: 'patient',
                  organization_id: null,
                  status: 'active',
                },
                error: null,
              }),
          }),
        }),
      }),
    });
  });

  it.each([
    ['POST', '/records'],
    ['POST', '/records/upload-url'],
    ['POST', '/patients/me/record-code'],
    ['GET', '/patients/me/records'],
  ])('requires authentication for %s %s', async (method, path) => {
    const response = await fetch(url + path, { method });
    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects invalid bodies before invoking the service without echoing secrets', async () => {
    const response = await fetch(url + '/records', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dek: 'private-secret',
        organization_id: 'forged',
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private-secret');
    expect(records.create).not.toHaveBeenCalled();
  });

  it('applies listing defaults and rejects unbounded pagination', async () => {
    records.list.mockResolvedValue({ records: [] });
    const headers = { Authorization: 'Bearer synthetic-token' };
    const response = await fetch(url + '/patients/me/records', { headers });
    expect(response.status).toBe(200);
    const [request, query] = records.list.mock.calls[0] as [
      AuthenticatedRequest,
      { offset: number; limit: number },
    ];
    expect(request.user.role).toBe('patient');
    expect(query).toEqual({ offset: 0, limit: 20 });
    const invalid = await fetch(url + '/patients/me/records?limit=10000', {
      headers,
    });
    expect(invalid.status).toBe(400);
  });
});
