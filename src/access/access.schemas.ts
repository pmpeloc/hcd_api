import { z } from 'zod';

export const lookupPatientSchema = z
  .object({
    patient_code: z.string().min(1).max(4096),
  })
  .strict();

export const createAccessRequestSchema = z
  .object({
    patient_code: z.string().min(1).max(4096),
    reason: z.string().trim().min(3).max(280),
  })
  .strict();

// The three durations the patient UI offers; the program's Config caps the
// maximum on-chain anyway.
export const approveAccessRequestSchema = z
  .object({
    duration_seconds: z.union([
      z.literal(3600),
      z.literal(86400),
      z.literal(604800),
    ]),
  })
  .strict();

// Query schemas stay non-strict: cache-busters (?_=) must not 400.
export const listAccessRequestsSchema = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'expired']).optional(),
});

export type LookupPatientDto = z.infer<typeof lookupPatientSchema>;
export type CreateAccessRequestDto = z.infer<typeof createAccessRequestSchema>;
export type ApproveAccessRequestDto = z.infer<
  typeof approveAccessRequestSchema
>;
export type ListAccessRequestsDto = z.infer<typeof listAccessRequestsSchema>;
