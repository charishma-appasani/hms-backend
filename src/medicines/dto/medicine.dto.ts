import { z } from 'zod';

/** Autocomplete search over the master catalog. */
export const searchMedicinesSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(15),
});

/** Platform-curated master data (see the future data-entry page TODO in phase-2 docs). */
export const createMedicineSchema = z.object({
  name: z.string().trim().min(1).max(200),
  genericName: z.string().trim().max(200).optional(),
  manufacturer: z.string().trim().max(200).optional(),
  ingredients: z.string().trim().max(4000).optional(),
  form: z.string().trim().max(60).optional(),
  strength: z.string().trim().max(60).optional(),
});

export const updateMedicineSchema = createMedicineSchema
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

export type SearchMedicinesDto = z.infer<typeof searchMedicinesSchema>;
export type CreateMedicineDto = z.infer<typeof createMedicineSchema>;
export type UpdateMedicineDto = z.infer<typeof updateMedicineSchema>;
