import { z } from 'zod';

/**
 * Book a SCHEDULED appointment into a slot's appointment bucket. practiceId/providerId/mode/date
 * are derived from the slot (not trusted from the client). The patient must be registered at this
 * org. `walk_in` is a separate endpoint (the walk-in bucket); this covers the booked channels.
 */
export const bookAppointmentSchema = z.object({
  slotId: z.uuid(),
  patientId: z.uuid(),
  channel: z.enum(['phone', 'online', 'patient_app']),
  apptType: z.enum(['new', 'follow_up']).default('new'),
  reason: z.string().trim().max(500).optional(),
});

/** Register a walk-in: same slot/patient, draws on the slot's walk-in bucket, created checked-in. */
export const walkInSchema = z.object({
  slotId: z.uuid(),
  patientId: z.uuid(),
  apptType: z.enum(['new', 'follow_up']).default('new'),
  reason: z.string().trim().max(500).optional(),
});

/** Move an appointment to a different slot. */
export const rescheduleSchema = z.object({
  slotId: z.uuid(),
});

/** Filters for the appointment list / OPD queue view. */
export const listAppointmentsQuerySchema = z.object({
  providerId: z.uuid().optional(),
  patientId: z.uuid().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  status: z
    .enum([
      'requested',
      'confirmed',
      'checked_in',
      'fulfilled',
      'cancelled',
      'no_show',
      'rescheduled',
    ])
    .optional(),
});

export type BookAppointmentDto = z.infer<typeof bookAppointmentSchema>;
export type WalkInDto = z.infer<typeof walkInSchema>;
export type RescheduleDto = z.infer<typeof rescheduleSchema>;
export type ListAppointmentsQueryDto = z.infer<
  typeof listAppointmentsQuerySchema
>;
