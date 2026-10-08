import { z } from 'zod';

// Ciphertext includes the 16-byte GCM tag; IV travels separately.
export const MAX_CIPHERTEXT_BYTES = 50 * 1024 * 1024 + 16;
const token = z.string().min(1).max(4096);
const base64Bytes = (length: number) =>
  z
    .string()
    .base64()
    .length(4 * Math.ceil(length / 3))
    .refine((value) => {
      // Browser-compatible length check (no Node Buffer in shared schemas).
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
      return (value.length / 4) * 3 - padding === length;
    }, 'Invalid byte length');

export const uploadRecordSchema = z
  .object({
    patient_code: token,
    content_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .refine((v) => !/^0+$/.test(v)),
    ciphertext_bytes: z.number().int().min(17).max(MAX_CIPHERTEXT_BYTES),
  })
  .strict();

export const createRecordSchema = z
  .object({
    upload_token: token,
    dek: base64Bytes(32),
    encryption_iv: base64Bytes(12),
  })
  .strict();

export const listRecordsSchema = z
  .object({
    offset: z.coerce.number().int().min(0).max(100000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type UploadRecordDto = z.infer<typeof uploadRecordSchema>;
export type CreateRecordDto = z.infer<typeof createRecordSchema>;
export type ListRecordsDto = z.infer<typeof listRecordsSchema>;
