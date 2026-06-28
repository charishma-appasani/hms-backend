import { z } from 'zod';

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24h)');
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * A BOUNDED recurring availability template: a provider's weekly hours at a practice, running for
 * `weeks` (1–8) consecutive weeks from `startDate`. The recurring weekday is `startDate`'s weekday
 * (no separate field to drift). Creating it eagerly materializes the slots for the whole range
 * (see AvailabilityTemplatesService). `org_id`/audit are injected by the scoped client; times are
 * practice-local wall-clock. `providerId` must be a doctor at this org; `practiceId` in this org.
 *
 * There is no PATCH: changing a live schedule is the replace-and-migrate flow (separate). For now,
 * delete + recreate (slots regenerate). `code`-style conflicts don't apply.
 */
export const createAvailabilityTemplateSchema = z
  .object({
    practiceId: z.uuid(),
    providerId: z.uuid(),
    startDate: dateOnly, // anchors the range; its weekday is the recurring day
    weeks: z.number().int().min(1).max(8),
    startTime: timeOfDay,
    endTime: timeOfDay,
    mode: z.enum(['slot', 'token']),
    slotDurationMins: z.number().int().positive().max(1440).optional(),
    apptCapacity: z.number().int().min(0).max(1000).optional(),
    walkinCapacity: z.number().int().min(0).max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.endTime <= v.startTime) {
      ctx.addIssue({
        code: 'custom',
        message: 'endTime must be after startTime',
        path: ['endTime'],
      });
    }
    if (v.mode === 'slot' && v.slotDurationMins == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'slotDurationMins is required for slot mode',
        path: ['slotDurationMins'],
      });
    }
    if (v.mode === 'token' && (v.apptCapacity == null || v.apptCapacity < 1)) {
      ctx.addIssue({
        code: 'custom',
        message: 'apptCapacity (>= 1) is required for token mode',
        path: ['apptCapacity'],
      });
    }
  });

export type CreateAvailabilityTemplateDto = z.infer<
  typeof createAvailabilityTemplateSchema
>;
