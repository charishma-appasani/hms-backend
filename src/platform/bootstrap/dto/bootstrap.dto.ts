import { z } from 'zod';

/**
 * Payload for creating the FIRST platform super_admin on a brand-new instance. `password` is
 * optional: with it the operator can log in immediately; without it Cognito emails an invite
 * (needs SES configured). This endpoint only works while the database has zero users.
 */
export const bootstrapSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(160)),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{9,14}$/, 'Phone must be E.164, e.g. +9198XXXXXXXX')
    .optional(),
  password: z.string().min(8).max(128).optional(),
});

export type BootstrapDto = z.infer<typeof bootstrapSchema>;
