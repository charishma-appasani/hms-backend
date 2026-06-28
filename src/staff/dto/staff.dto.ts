import { z } from 'zod';

const userRole = z.enum(['admin', 'doctor', 'front_desk', 'nurse']);

/**
 * Create-staff payload = identity (provisioned in Cognito + app_user if new) + the org membership.
 * Demographics (email/name/phone) live on the GLOBAL app_user; org-specific fields (roles,
 * clinician details) live on the staff row. The scoped client injects orgId + audit columns.
 */
export const createStaffSchema = z.object({
  // Normalized (trim + lowercase) so identity dedup by email is reliable across orgs.
  email: z.string().trim().toLowerCase().pipe(z.email().max(160)),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{9,14}$/, 'Phone must be E.164, e.g. +9198XXXXXXXX')
    .optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80).optional(),
  roles: z.array(userRole).min(1),
  // Clinician fields — meaningful only when roles include 'doctor'.
  specialty: z.string().trim().max(120).optional(),
  registrationNumber: z.string().trim().max(64).optional(),
  consultationFee: z.number().nonnegative().optional(),
});

/** Membership edits only — identity/demographics are changed on the app_user, not here. */
export const updateStaffSchema = z.object({
  roles: z.array(userRole).min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  specialty: z.string().trim().max(120).optional(),
  registrationNumber: z.string().trim().max(64).optional(),
  consultationFee: z.number().nonnegative().optional(),
});

export type CreateStaffDto = z.infer<typeof createStaffSchema>;
export type UpdateStaffDto = z.infer<typeof updateStaffSchema>;
