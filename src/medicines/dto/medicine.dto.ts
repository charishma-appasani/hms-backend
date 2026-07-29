import { z } from 'zod';

/** Autocomplete search over the master catalog. */
export const searchMedicinesSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(15),
});

/** Platform catalog browse: optional filter + paging (the catalog runs to thousands of rows). */
export const listMedicinesSchema = z.object({
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Platform-curated master data (the /platform/medicines data-entry page). Optional fields accept
 * an explicit `null` so the edit form can CLEAR a wrong value — omitted still means "leave alone".
 */
export const createMedicineSchema = z.object({
  name: z.string().trim().min(1).max(200),
  genericName: z.string().trim().max(200).nullish(),
  manufacturer: z.string().trim().max(200).nullish(),
  ingredients: z.string().trim().max(4000).nullish(),
  form: z.string().trim().max(60).nullish(),
  strength: z.string().trim().max(60).nullish(),
  // Pharmacological class powering the tier-2 allergy check (see ai-features.md). Free text,
  // normalized in code — e.g. 'penicillins', 'sulfonamides', 'nsaids'.
  drugClass: z.string().trim().max(80).nullish(),
});

export const updateMedicineSchema = createMedicineSchema
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

/**
 * One row of a bulk import. `sourceRow` is the CSV line number the client parsed it from — it is
 * echoed back on failures so the operator can fix the file, and is never persisted.
 */
export const importMedicineRowSchema = createMedicineSchema.extend({
  sourceRow: z.coerce.number().int().min(1).optional(),
});

/**
 * A bulk-import batch. The client parses the CSV and posts rows in chunks, so one oversized file
 * can't blow the request body limit and the page can show progress.
 */
export const importMedicinesSchema = z.object({
  rows: z.array(importMedicineRowSchema).min(1).max(500),
});

export type SearchMedicinesDto = z.infer<typeof searchMedicinesSchema>;
export type ListMedicinesDto = z.infer<typeof listMedicinesSchema>;
export type CreateMedicineDto = z.infer<typeof createMedicineSchema>;
export type UpdateMedicineDto = z.infer<typeof updateMedicineSchema>;
export type ImportMedicineRowDto = z.infer<typeof importMedicineRowSchema>;
export type ImportMedicinesDto = z.infer<typeof importMedicinesSchema>;
