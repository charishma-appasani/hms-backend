import { z } from 'zod';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * An authenticated non-patient user (staff/doctor/platform operator) activating a patient profile
 * on their OWN account. No password/OTP — they already proved the identity by logging in. The
 * fields only fill demographics MISSING on the app_user (never overwrite staff-entered values).
 */
export const activatePatientProfileSchema = z.object({
  dateOfBirth: dateOnly.optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
});

export type ActivatePatientProfileDto = z.infer<
  typeof activatePatientProfileSchema
>;
