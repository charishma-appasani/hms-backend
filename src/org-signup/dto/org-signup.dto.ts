import { z } from 'zod';

// Normalized (trim + lowercase) so identity dedup by email is reliable — same rule as staff.
const email = z.string().trim().toLowerCase().pipe(z.email().max(160));
const phone = z
  .string()
  .regex(/^\+[1-9]\d{9,14}$/, 'Phone must be E.164, e.g. +9198XXXXXXXX');

/**
 * Org self-signup step 1: request an OTP. Email is REQUIRED — it becomes the founding admin's
 * login (staff Cognito identities are email-keyed) and the code is always delivered there
 * (email takes precedence over SMS when present).
 */
export const orgSignupStartSchema = z.object({
  email,
  phone: phone.optional(),
});

/** Org self-signup step 2: verify the OTP → create the org (unapproved) + its founding admin. */
export const orgSignupVerifySchema = z.object({
  email,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  orgName: z.string().trim().min(1).max(160),
  legalName: z.string().trim().min(1).max(200).optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: phone.optional(),
  // Used only when the email doesn't already belong to an account (existing users keep theirs).
  password: z.string().min(8).max(128),
});

export type OrgSignupStartDto = z.infer<typeof orgSignupStartSchema>;
export type OrgSignupVerifyDto = z.infer<typeof orgSignupVerifySchema>;
