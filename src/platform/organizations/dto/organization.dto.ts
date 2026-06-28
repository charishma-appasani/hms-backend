import { z } from 'zod';
import { jsonObjectSchema } from '../../../common/zod-json';

/**
 * Organization (tenant) payloads for the platform namespace. `status` defaults to `pending`
 * (onboarding) at the DB; audit columns are stamped by the service from the platform operator.
 */
export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  legalName: z.string().trim().min(1).max(200).optional(),
  uhidFormat: z.string().trim().min(1).max(64).optional(),
  settings: jsonObjectSchema.optional(),
});

export const updateOrganizationSchema = createOrganizationSchema
  .partial()
  .extend({ status: z.enum(['active', 'disabled']).optional() });

export type CreateOrganizationDto = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationDto = z.infer<typeof updateOrganizationSchema>;
