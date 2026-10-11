import { z } from 'zod';
import {
  consentCode,
  contactFields,
  contactRequired,
  hasContact,
} from '../../../common/contact.schema';

/**
 * Payload for adding a platform operator (our own employee), step 2 after
 * `POST /platform/users/lookup`. Two shapes:
 *   - GRANT to an existing account: contact + `code` (the OTP the person received — their consent).
 *   - NEW person: contact (email and/or phone) + name. They get the Cognito invite (email, else
 *     SMS; FORCE_CHANGE_PASSWORD) — there is no password path here.
 * The role is explicit: `super_admin` manages, `support` reads, `data_entry` curates the medicine
 * catalog only.
 */
export const createPlatformUserSchema = z
  .object({
    ...contactFields,
    code: consentCode.optional(),
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    platformRole: z.enum(['super_admin', 'support', 'data_entry']),
  })
  .refine(hasContact, contactRequired)
  .refine((v) => v.code || v.firstName, {
    message: 'First name is required for a new person',
    path: ['firstName'],
  });

export type CreatePlatformUserDto = z.infer<typeof createPlatformUserSchema>;
