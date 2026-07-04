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

/** Clinical narrative on the visit: presenting symptoms and/or the doctor's diagnosis (free text). */
export const updateClinicalSchema = z
  .object({
    symptoms: z.string().trim().max(4000).optional(),
    diagnosis: z.string().trim().max(4000).optional(),
  })
  .refine((v) => v.symptoms !== undefined || v.diagnosis !== undefined, {
    message: 'Provide symptoms and/or diagnosis',
  });

/** A prescribed medication line. */
export const createPrescriptionSchema = z.object({
  drug: z.string().trim().min(1).max(200),
  dosage: z.string().trim().max(120).optional(),
  frequency: z.string().trim().max(120).optional(),
  duration: z.string().trim().max(120).optional(),
  instructions: z.string().trim().max(2000).optional(),
});

/** A test/investigation ordered on the visit. */
export const createTestOrderSchema = z.object({
  name: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(2000).optional(),
});

/** Update a test order's lifecycle status and/or its result. */
export const updateTestOrderSchema = z
  .object({
    status: z.enum(['ordered', 'collected', 'resulted', 'cancelled']).optional(),
    result: z.string().trim().max(4000).optional(),
  })
  .refine((v) => v.status !== undefined || v.result !== undefined, {
    message: 'Provide status and/or result',
  });

export type CheckInDto = z.infer<typeof checkInSchema>;
export type UpdateVisitStatusDto = z.infer<typeof updateVisitStatusSchema>;
export type VisitVitalsDto = z.infer<typeof visitVitalsSchema>;
export type QueueQueryDto = z.infer<typeof queueQuerySchema>;
export type UpdateClinicalDto = z.infer<typeof updateClinicalSchema>;
export type CreatePrescriptionDto = z.infer<typeof createPrescriptionSchema>;
export type CreateTestOrderDto = z.infer<typeof createTestOrderSchema>;
export type UpdateTestOrderDto = z.infer<typeof updateTestOrderSchema>;
