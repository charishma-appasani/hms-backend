import { z } from 'zod';

/**
 * A person's contact details — the two values that identify an Aayufy account. Each is unique on
 * its own; a person needs at least one. Shared by every "add a person" flow (staff, patients,
 * platform users) so they all match accounts the same way.
 */
export const contactFields = {
  // Normalized (trim + lowercase) so matching by email is reliable across orgs.
  email: z.string().trim().toLowerCase().pipe(z.email().max(160)).optional(),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{9,14}$/, 'Phone must be E.164, e.g. +9198XXXXXXXX')
    .optional(),
};

export const hasContact = (v: { email?: string; phone?: string }) =>
  Boolean(v.email || v.phone);
export const contactRequired = {
  message: 'Enter an email or a phone number',
};

/** Step 1 of adding a person: does this email/phone already belong to an account? */
export const lookupSchema = z
  .object(contactFields)
  .refine(hasContact, contactRequired);
export type LookupDto = z.infer<typeof lookupSchema>;

/** Step 2 with an existing account: the 6-digit code the person received from the lookup. */
export const consentCode = z.string().regex(/^\d{6}$/, 'Code must be 6 digits');
