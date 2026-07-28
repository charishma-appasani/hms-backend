import { z } from 'zod';

/** Doctor's thumbs up/down on a generation — the evaluation signal (see ai-features.md). */
export const aiFeedbackSchema = z.object({
  feedback: z.union([z.literal(1), z.literal(-1)]),
});

export type AiFeedbackDto = z.infer<typeof aiFeedbackSchema>;

/** Pre-submit prescription safety check — called as the doctor types the drug name. */
export const prescriptionCheckSchema = z.object({
  visitId: z.uuid(),
  drug: z.string().trim().min(2).max(200),
});

export type PrescriptionCheckDto = z.infer<typeof prescriptionCheckSchema>;

/** Ask-this-chart: a natural-language question about the patient. */
export const chartAskSchema = z.object({
  question: z.string().trim().min(3).max(500),
});

export type ChartAskDto = z.infer<typeof chartAskSchema>;
