import { z } from 'zod';

export const releaseKeySchema = z
  .object({
    record_id: z.string().uuid(),
  })
  .strict();

export type ReleaseKeyDto = z.infer<typeof releaseKeySchema>;

// Shape of the `records` row the release flow reads through the service-role
// client. Parsed at runtime — the DB is trusted but never assumed.
export const recordRowSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  record_pda: z.string().min(1).nullable(),
  storage_path: z.string(),
  wrapped_dek: z.string(),
  content_hash: z.string(),
});
export type RecordRow = z.infer<typeof recordRowSchema>;

export const keyReleaseIdSchema = z.object({
  id: z.union([z.number(), z.bigint()]),
});
