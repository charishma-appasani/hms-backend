import { z } from 'zod';

/** Query for a provider's bookable availability at a practice on a date. */
export const directoryAvailabilityQuerySchema = z.object({
  practiceId: z.uuid(),
  providerId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});
export type DirectoryAvailabilityQueryDto = z.infer<
  typeof directoryAvailabilityQuerySchema
>;

/** Patient self-book: just the slot — provider/practice/date/org are derived from it server-side. */
export const selfBookSchema = z.object({
  slotId: z.uuid(),
  apptType: z.enum(['new', 'follow_up']).default('new'),
  reason: z.string().trim().max(500).optional(),
});
export type SelfBookDto = z.infer<typeof selfBookSchema>;

/** Patient reschedules their own appointment to a different slot. */
export const selfRescheduleSchema = z.object({ slotId: z.uuid() });
export type SelfRescheduleDto = z.infer<typeof selfRescheduleSchema>;
