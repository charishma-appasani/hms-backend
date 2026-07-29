import { z } from 'zod';

/**
 * Payload for adding a platform operator (our own employee). Mirrors the bootstrap identity shape,
 * but the role is explicit (`super_admin` manages, `support` reads, `data_entry` curates the
 * medicine catalog only) and there is no password path — operators always get the Cognito invite
 * email (FORCE_CHANGE_PASSWORD).
 */
export const createPlatformUserSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(160)),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{9,14}$/, 'Phone must be E.164, e.g. +9198XXXXXXXX')
    .optional(),
  platformRole: z.enum(['super_admin', 'support', 'data_entry']),
});

export type CreatePlatformUserDto = z.infer<typeof createPlatformUserSchema>;
