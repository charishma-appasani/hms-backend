import { z } from 'zod';

const phone = z
  .string()
  .regex(/^\+[1-9]\d{9,14}$/, 'Phone must be E.164, e.g. +9198XXXXXXXX');
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const gender = z.enum(['male', 'female', 'other']);

/**
 * Staff registers a NEW patient at the current org (creates identity + profile + registration).
 * Each person needs a UNIQUE phone or email (at least one) — it becomes their Cognito login.
 */
export const createPatientSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80).optional(),
    phone: phone.optional(),
    email: z.email().max(160).optional(),
    dateOfBirth: dateOnly.optional(),
    gender: gender.optional(),
    abhaNumber: z.string().trim().max(17).optional(),
  })
  .refine((v) => Boolean(v.phone || v.email), {
    message: 'A phone or email is required',
    path: ['phone'],
  });

/** Demographics edit (global, attributed). Identity (login) isn't changed here. */
export const updatePatientSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: phone.optional(),
  email: z.email().max(160).optional(),
  dateOfBirth: dateOnly.optional(),
  gender: gender.optional(),
  abhaNumber: z.string().trim().max(17).optional(),
});

/** Self-signup step 1: request an OTP. Code goes to `email` if given, else SMS to `phone`. */
export const signupStartSchema = z.object({
  phone,
  email: z.email().max(160).optional(),
});

/** Self-signup step 2: verify the OTP and create the patient identity + profile. */
export const signupVerifySchema = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  password: z.string().min(8).max(128),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80).optional(),
  email: z.email().max(160).optional(),
  dateOfBirth: dateOnly.optional(),
  gender: gender.optional(),
});

/** Cross-org link step 1: front desk requests an OTP to the existing patient's phone. */
export const linkStartSchema = z.object({ phone });

/** Cross-org link step 2: verify the OTP (patient consent) → register the patient at this org. */
export const linkVerifySchema = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export type CreatePatientDto = z.infer<typeof createPatientSchema>;
export type UpdatePatientDto = z.infer<typeof updatePatientSchema>;
export type SignupStartDto = z.infer<typeof signupStartSchema>;
export type SignupVerifyDto = z.infer<typeof signupVerifySchema>;
export type LinkStartDto = z.infer<typeof linkStartSchema>;
export type LinkVerifyDto = z.infer<typeof linkVerifySchema>;
