import { z } from 'zod';

export const createOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    kind: z.enum(['clinic', 'practice', 'insurer']),
  })
  .strict();

export const addDoctorSchema = z
  .object({
    user_id: z.string().uuid(),
    license_number: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z.-]{3,32}$/),
    specialty: z.string().trim().min(2).max(80).optional(),
  })
  .strict();

export type CreateOrganizationDto = z.infer<typeof createOrganizationSchema>;
export type AddDoctorDto = z.infer<typeof addDoctorSchema>;
