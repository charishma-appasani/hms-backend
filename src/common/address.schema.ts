import { z } from 'zod';

/**
 * Shared address fields (India), embedded in an owner's payload (practice today; org/patient
 * later). The `address` table is entity-agnostic and managed nested within its owner — there is
 * no standalone address endpoint. `postalCode` is a 6-digit PIN; `country` is ISO-3166 alpha-2.
 */
export const addressFieldsSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  landmark: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(1).max(120),
  postalCode: z.string().regex(/^\d{6}$/, 'PIN code must be 6 digits'),
  country: z.string().trim().length(2).toUpperCase().default('IN'),
});

export type AddressFields = z.infer<typeof addressFieldsSchema>;
