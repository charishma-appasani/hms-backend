import { z } from 'zod';
import { addressFieldsSchema } from '../../common/address.schema';

/**
 * Practice payloads. `org_id` and audit columns are NOT accepted from the client — the scoped
 * Prisma client injects orgId + created_by/updated_by from the request (see scoped-client.ts).
 * `code` is unique per org (DB `@@unique([orgId, code])`) → a duplicate surfaces as 409.
 * `address` is the practice's address, managed nested (created/updated with the practice).
 */
export const createPracticeSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(1).max(32),
  timezone: z.string().trim().min(1).max(40).optional(),
  address: addressFieldsSchema.optional(),
});

export const updatePracticeSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  code: z.string().trim().min(1).max(32).optional(),
  timezone: z.string().trim().min(1).max(40).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  address: addressFieldsSchema.optional(),
});

export type CreatePracticeDto = z.infer<typeof createPracticeSchema>;
export type UpdatePracticeDto = z.infer<typeof updatePracticeSchema>;
