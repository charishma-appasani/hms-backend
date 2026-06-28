import { z } from 'zod';

const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 datetime');

/**
 * A subtractive doctor block: time_off / holiday / surgery / busy. Creating it flips overlapping
 * OPEN slots to `blocked` (no new bookings; existing bookings are flagged, not auto-cancelled).
 * `practiceId` omitted = all of the provider's practices. `extra_session` (additive) is not yet
 * supported (it needs slot-gen params the table doesn't carry).
 */
export const createScheduleExceptionSchema = z
  .object({
    providerId: z.uuid(),
    practiceId: z.uuid().optional(),
    type: z.enum(['time_off', 'holiday', 'surgery', 'busy']),
    startAt: isoDateTime,
    endAt: isoDateTime,
    allDay: z.boolean().optional().default(false),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt), {
    message: 'endAt must be after startAt',
    path: ['endAt'],
  });

/** Filters for listing exceptions (all optional). */
export const listScheduleExceptionsQuerySchema = z.object({
  providerId: z.uuid().optional(),
  practiceId: z.uuid().optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

export type CreateScheduleExceptionDto = z.infer<
  typeof createScheduleExceptionSchema
>;
export type ListScheduleExceptionsQueryDto = z.infer<
  typeof listScheduleExceptionsQuerySchema
>;
