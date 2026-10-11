import { z } from 'zod';
import {
  consentCode,
  contactFields,
  contactRequired,
  hasContact,
} from '../../common/contact.schema';

const userRole = z.enum([
  'admin',
  'doctor',
  'doctor_assistant',
  'front_desk',
  'nurse',
]);

/**
 * Create-staff payload (step 2, after `POST /staff/lookup`), two shapes:
 *   - LINK an existing account: contact + `code` (the OTP the person received from lookup).
 *   - NEW person: contact (email and/or phone — the invite goes to email, else SMS) + name.
 * Both carry the membership: roles + clinician fields. Demographics live on the GLOBAL app_user;
 * the scoped client injects orgId + audit columns on the staff row.
 */
export const createStaffSchema = z
  .object({
    ...contactFields,
    code: consentCode.optional(),
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    roles: z.array(userRole).min(1),
    // Clinician fields — meaningful only when roles include 'doctor'.
    specialty: z.string().trim().max(120).optional(),
    registrationNumber: z.string().trim().max(64).optional(),
    consultationFee: z.number().nonnegative().optional(),
  })
  .refine(hasContact, contactRequired)
  .refine((v) => v.code || v.firstName, {
    message: 'First name is required for a new person',
    path: ['firstName'],
  });

/**
 * Membership edits only — identity/demographics are changed on the app_user, not here. Status is
 * NOT editable here: it changes only through the explicit disable / activate / delete actions.
 */
export const updateStaffSchema = z.object({
  roles: z.array(userRole).min(1).optional(),
  specialty: z.string().trim().max(120).optional(),
  registrationNumber: z.string().trim().max(64).optional(),
  consultationFee: z.number().nonnegative().optional(),
});

export type CreateStaffDto = z.infer<typeof createStaffSchema>;
export type UpdateStaffDto = z.infer<typeof updateStaffSchema>;
