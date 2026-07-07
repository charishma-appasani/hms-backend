import { z } from 'zod';

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24h)');
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * A provider's weekly availability at a practice, created as a whole: one entry per working
 * weekday (per-day hours, shared mode/capacity), running `weeks` (1–8) consecutive weeks.
 * `startDate` anchors week 1 — each listed weekday recurs from its first occurrence on/after it —
 * and must be tomorrow or later in the practice's timezone (service-enforced; needs the tz).
 *
 * There is NO edit/replace: creating a schedule SUPERSEDES the provider's existing schedule at
 * that practice from `startDate` on. The old schedule ends the day before; bookings whose exact
 * time still exists in the new schedule stay untouched, the rest are relocated to the nearest
 * open slot (patients notified). See AvailabilityTemplatesService.create.
 */
export const createAvailabilityTemplateSchema = z
  .object({
    practiceId: z.uuid(),
    providerId: z.uuid(),
    startDate: dateOnly, // anchors week 1 (any weekday); must be tomorrow+ (practice tz)
    weeks: z.number().int().min(1).max(8),
    mode: z.enum(['slot', 'token']),
    slotDurationMins: z.number().int().positive().max(1440).optional(),
    apptCapacity: z.number().int().min(0).max(1000).optional(),
    walkinCapacity: z.number().int().min(0).max(1000).optional(),
    days: z
      .array(
        z.object({
          weekday: z.number().int().min(0).max(6), // 0=Sun .. 6=Sat
          startTime: timeOfDay,
          endTime: timeOfDay,
        }),
      )
      .min(1)
      .max(7),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<number>();
    v.days.forEach((d, i) => {
      if (seen.has(d.weekday)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each weekday may appear only once',
          path: ['days', i, 'weekday'],
        });
      }
      seen.add(d.weekday);
      if (d.endTime <= d.startTime) {
        ctx.addIssue({
          code: 'custom',
          message: 'endTime must be after startTime',
          path: ['days', i, 'endTime'],
        });
      }
    });
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
