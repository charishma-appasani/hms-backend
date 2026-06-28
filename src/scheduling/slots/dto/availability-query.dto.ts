import { z } from 'zod';

/** Query for the availability of one provider at one practice on one date. */
export const availabilityQuerySchema = z.object({
  practiceId: z.uuid(),
  providerId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

export type AvailabilityQueryDto = z.infer<typeof availabilityQuerySchema>;
