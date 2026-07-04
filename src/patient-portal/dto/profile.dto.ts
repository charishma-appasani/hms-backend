import { z } from 'zod';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * A patient editing their OWN demographics (global app_user). At least one field required.
 *
 * NOTE: `phone`/`email` are intentionally NOT editable here. They are the Cognito login username,
 * and we don't yet have a flow to change the login identity in Cognito — allowing an edit would let
 * the profile drift from the actual login. See the "change-login-identity" TODO in
 * phase-2-patient-portal.md. Re-add once that flow exists.
 */
export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    dateOfBirth: dateOnly.optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
