import { z } from 'zod';

// The stored object is the sealed blob: iv(12) || AES-256-GCM ciphertext+tag(16).
// The IV travels inside the file, so /keys/release never returns it and the
// content hash covers it too. Cap: 50 MiB plaintext + 12 + 16 overhead.
export const SEALED_OVERHEAD_BYTES = 12 + 16;
export const MAX_CIPHERTEXT_BYTES = 50 * 1024 * 1024 + SEALED_OVERHEAD_BYTES;
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
    // Minimum sealed blob: iv(12) + 1-byte plaintext + tag(16).
    ciphertext_bytes: z.number().int().min(29).max(MAX_CIPHERTEXT_BYTES),
    // Display metadata for the patient's study list; bound into the upload
    // ticket so the registered row shows exactly what was reserved.
    title: z.string().trim().min(1).max(140).optional(),
    study_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    origin: z.enum(['issued', 'digitized']).optional(),
  })
  .strict();

export const createRecordSchema = z
  .object({
    upload_token: token,
    dek: base64Bytes(32),
    encryption_iv: base64Bytes(12),
  })
  .strict();

// Query schemas stay non-strict: browsers and caches append cache-busters
// (?_=, ?ts=) that would otherwise produce false 400s. Unknown params are
// stripped by zod, never forwarded. Body schemas keep .strict().
export const listRecordsSchema = z.object({
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type UploadRecordDto = z.infer<typeof uploadRecordSchema>;
export type CreateRecordDto = z.infer<typeof createRecordSchema>;
export type ListRecordsDto = z.infer<typeof listRecordsSchema>;
