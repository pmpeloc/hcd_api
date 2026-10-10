import {
  ForbiddenException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const identity = {
  patient_id: z.string().uuid(),
  patient_wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  expires_at: z.number().int().positive(),
};
const patientSchema = z
  .object({
    ...identity,
    purpose: z.literal('record-patient'),
    nonce: z.string().uuid(),
  })
  .strict();
const uploadSchema = z
  .object({
    ...identity,
    purpose: z.literal('record-upload'),
    record_id: z.string().uuid(),
    organization_id: z.string().uuid(),
    doctor_id: z.string().uuid(),
    user_id: z.string().uuid(),
    doctor_wallet: z.string(),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/),
    ciphertext_bytes: z.number().int().positive(),
    // Display metadata declared at reservation time and bound into the
    // ticket, so registration cannot silently swap the study's identity.
    title: z.string().max(140).optional(),
    study_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    origin: z.enum(['issued', 'digitized']).optional(),
  })
  .strict();
export type UploadTicket = z.infer<typeof uploadSchema>;

@Injectable()
export class RecordTokensService implements OnModuleInit {
  private secret?: Buffer;

  constructor(private readonly config: ConfigService) {}

  // Fail fast at boot instead of on the first request: a missing or
  // malformed RECORDS_TOKEN_SECRET must never reach production traffic.
  onModuleInit() {
    const value = this.config.get<string>('RECORDS_TOKEN_SECRET');
    if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error('RECORDS_TOKEN_SECRET must be 64 hex characters');
    }
    this.secret = Buffer.from(value, 'hex');
  }

  patient(patientId: string, wallet: string) {
    return this.sign(
      patientSchema.parse({
        purpose: 'record-patient',
        patient_id: patientId,
        patient_wallet: wallet,
        nonce: randomUUID(),
        expires_at: Date.now() + 120000,
      }),
    );
  }

  upload(ticket: Omit<UploadTicket, 'purpose' | 'expires_at'>) {
    return this.sign(
      uploadSchema.parse({
        ...ticket,
        purpose: 'record-upload',
        expires_at: Date.now() + 600000,
      }),
    );
  }

  readPatient(token: string) {
    return this.read(token, patientSchema);
  }
  readUpload(token: string) {
    return this.read(token, uploadSchema);
  }

  private mac(payload: string) {
    if (!this.secret) {
      throw new ServiceUnavailableException('Record tokens are not configured');
    }
    return createHmac('sha256', this.secret)
      .update('salua-records-v1:')
      .update(payload)
      .digest();
  }

  private sign(data: unknown) {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${payload}.${this.mac(payload).toString('base64url')}`;
  }

  private read<T extends { expires_at: number }>(
    token: string,
    schema: z.ZodType<T>,
  ): T {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
      throw new ForbiddenException('Invalid or expired record token');
    }
    const expected = this.mac(parts[0]);
    const received = Buffer.from(parts[1], 'base64url');
    if (
      received.length !== expected.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException('Invalid or expired record token');
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
      throw new ForbiddenException('Invalid or expired record token');
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success || parsed.data.expires_at <= Date.now()) {
      throw new ForbiddenException('Invalid or expired record token');
    }
    return parsed.data;
  }
}
