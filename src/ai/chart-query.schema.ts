import { z } from 'zod';
import type { Tool } from '@aws-sdk/client-bedrock-runtime';

/**
 * Contract for an ask-this-chart answer (see docs/architecture/ai-features.md). As with the
 * visit summary, the model output is UNTRUSTED — tool-use constrains the shape, zod re-validates
 * it, and the answer is grounded strictly in the dossier the model was given.
 */

export const CHART_ANSWER_TOOL_NAME = 'answer_chart_question';

export const chartAnswerSchema = z.object({
  answer: z.string().min(1).max(1500),
  // false = the record does not contain what was asked. The model must not guess; it says so.
  foundInRecord: z.boolean(),
  // Dossier cite ids the answer drew on (`visit:V000012`, `medication:<id>`, `test:<id>`, …).
  citations: z.array(z.string().max(80)).max(12).default([]),
});

export type ChartAnswer = z.infer<typeof chartAnswerSchema>;

export const CHART_ANSWER_TOOL: Tool = {
  toolSpec: {
    name: CHART_ANSWER_TOOL_NAME,
    description:
      "Answer the clinician's question about this patient, grounded in the dossier.",
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            description:
              'A direct, concise answer to the question, drawn only from the dossier. If the dossier does not contain the answer, say what is not available rather than guessing.',
          },
          foundInRecord: {
            type: 'boolean',
            description:
              'true if the dossier contained the information needed to answer; false if it did not.',
          },
          citations: {
            type: 'array',
            maxItems: 12,
            description:
              'The `cite` values of the dossier items the answer is based on (empty when foundInRecord is false).',
            items: { type: 'string' },
          },
        },
        required: ['answer', 'foundInRecord', 'citations'],
      },
    },
  },
};

/**
 * System prompt. The hard boundary is the same as the summary's: the model may use ONLY the
 * dossier, must cite, and must not diagnose or recommend treatment. It is also told the dossier
 * is a BOUNDED recent extract, so "not found" is qualified honestly rather than stated as
 * "the patient has never …".
 */
export const CHART_ANSWER_SYSTEM_PROMPT = `You are a clinical records assistant for an Indian outpatient hospital system. A clinician is asking a question about one patient during a consultation. You are given a JSON dossier assembled from that patient's record and the clinician's question.

Answer the question using ONLY the dossier. This dossier is a BOUNDED recent extract (roughly the last 10 visits or 24 months at this organisation, plus the patient's global conditions and allergies) — it is not the patient's complete lifetime history.

Rules:
- Use only facts present in the dossier. Never introduce a condition, allergy, medication, test, value or event that is not there.
- Cite every claim with the "cite" value of the dossier item it came from.
- If the dossier does not contain what was asked, set foundInRecord to false and say plainly what is not available — e.g. "There is no record of that in the visits available here." Do NOT assert the patient has never had something; the dossier is only a recent extract.
- Do not diagnose, and do not recommend a drug, dose, or treatment plan. You may report what the record already contains.
- Be concise and factual. The clinician is mid-consultation.

Respond only by calling the ${CHART_ANSWER_TOOL_NAME} tool.`;
