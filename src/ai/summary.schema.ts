import { z } from 'zod';
import type { Tool } from '@aws-sdk/client-bedrock-runtime';

/**
 * The contract for a visit summary, in both forms we need it:
 *  - `visitSummarySchema` validates what came back (model output is UNTRUSTED input)
 *  - `VISIT_SUMMARY_TOOL` forces the model to emit that shape via Converse tool-use, instead of
 *    us regex-parsing prose. A malformed response then fails cleanly rather than half-filling
 *    the UI.
 *
 * Keep the two in sync by hand — the JSON Schema below is the tool spec Bedrock receives.
 */

export const SUMMARY_TOOL_NAME = 'record_patient_summary';

export const visitSummarySchema = z.object({
  summary: z.string().min(1).max(1200),
  highlights: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        severity: z.enum(['info', 'attention', 'urgent']).default('info'),
        // The model is asked to cite, but an uncited highlight is not worth failing the whole
        // generation over — the UI renders it differently instead.
        cite: z.string().max(80).nullish().transform((v) => v ?? null),
      }),
    )
    .max(8)
    .default([]),
  watchOuts: z.array(z.string().min(1).max(400)).max(6).default([]),
  openThreads: z.array(z.string().min(1).max(400)).max(6).default([]),
});
// The parsed shape must stay assignable to the domain `VisitSummary` — enforced where the
// parse result is returned (see AiGenerationService.toResponse), so no cast is needed here.

export const VISIT_SUMMARY_TOOL: Tool = {
  toolSpec: {
    name: SUMMARY_TOOL_NAME,
    description:
      'Record the orientation summary for the doctor about to see this patient.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'Two to four sentences orienting the doctor: who this patient is, what is ongoing, what changed since the last visit.',
          },
          highlights: {
            type: 'array',
            maxItems: 8,
            description:
              'Specific things worth the doctor knowing before they start. Each MUST cite a dossier item.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                severity: {
                  type: 'string',
                  enum: ['info', 'attention', 'urgent'],
                },
                cite: {
                  type: 'string',
                  description:
                    'The `cite` value of the dossier item this statement comes from, e.g. "visit:V000012".',
                },
              },
              required: ['text', 'severity', 'cite'],
            },
          },
          watchOuts: {
            type: 'array',
            maxItems: 6,
            description:
              'Documented allergy or medication risks relevant to today. State only what the dossier records.',
            items: { type: 'string' },
          },
          openThreads: {
            type: 'array',
            maxItems: 6,
            description:
              'Loose ends from previous visits, e.g. an ordered test with no recorded result, or a stated follow-up that has not happened.',
            items: { type: 'string' },
          },
        },
        required: ['summary', 'highlights', 'watchOuts', 'openThreads'],
      },
    },
  },
};

/**
 * System prompt. The hard boundaries live here AND in the architecture: the model cannot invent
 * record values because the UI renders facts from the dossier, not from this response.
 */
export const VISIT_SUMMARY_SYSTEM_PROMPT = `You are a clinical documentation assistant for an Indian outpatient hospital system. A doctor is about to start a consultation. You are given a JSON dossier assembled from that patient's existing record.

Your job is to orient the doctor in a few seconds of reading. You are NOT diagnosing and NOT recommending treatment.

Rules:
- Use ONLY facts present in the dossier. Never introduce a condition, allergy, medication, test or measurement that is not there.
- Every highlight MUST carry the "cite" value of the dossier item it came from. If you cannot cite it, do not say it.
- Do not suggest a diagnosis, a drug, a dose, or a treatment plan.
- Prefer what CHANGED or what is UNRESOLVED over restating the whole history — the doctor can already see the full record.
- Use "urgent" severity only for a documented allergy conflict or a clearly abnormal recorded value. Most items are "info".
- If the dossier is thin (a new patient, no prior visits), say so plainly and briefly. Do not pad.
- Be terse. A busy doctor reads this between patients.

Respond only by calling the ${SUMMARY_TOOL_NAME} tool.`;
