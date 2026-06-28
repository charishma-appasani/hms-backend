import { z } from 'zod';
import { jsonObjectSchema } from '../../../common/zod-json';

/** Check a patient in from an existing appointment (scheduled or walk-in) → creates the visit. */
export const checkInSchema = z.object({
  appointmentId: z.uuid(),
});

/** Clinical progression of a visit. checked_in → in_consultation → completed; or cancelled. */
export const updateVisitStatusSchema = z.object({
  status: z.enum(['in_consultation', 'completed', 'cancelled']),
});

/** Record vitals (free-form JSON, e.g. bp/temp/pulse) and/or a note on the visit. */
export const visitVitalsSchema = z
  .object({
    vitals: jsonObjectSchema.optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.vitals !== undefined || v.notes !== undefined, {
    message: 'Provide vitals and/or notes',
  });

/** Live OP queue filter: a practice (required), optionally a provider and a date. */
export const queueQuerySchema = z.object({
  practiceId: z.uuid(),
  providerId: z.uuid().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type CheckInDto = z.infer<typeof checkInSchema>;
export type UpdateVisitStatusDto = z.infer<typeof updateVisitStatusSchema>;
export type VisitVitalsDto = z.infer<typeof visitVitalsSchema>;
export type QueueQueryDto = z.infer<typeof queueQuerySchema>;
