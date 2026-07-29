import { z } from 'zod';
import type { Tool } from '@aws-sdk/client-bedrock-runtime';

/**
 * Contract for the patient-facing after-visit summary (roadmap #6, docs/architecture/
 * ai-features.md). The model REWRITES the doctor's completed-visit record into plain language a
 * patient can act on — it never adds advice, diagnosis, or anything the doctor did not record.
 * That rephrase-only boundary is what makes it safe to show a patient directly.
 *
 * English-only for now (a language preference is deferred). Model output is untrusted: tool-use
 * constrains the shape, zod re-validates it.
 */

export const PATIENT_SUMMARY_TOOL_NAME = 'record_patient_visit_summary';

export const patientSummarySchema = z.object({
  // 1-3 plain sentences: what the visit was about / what the doctor found, in lay terms.
  summary: z.string().min(1).max(900),
  // Each prescribed medicine explained plainly ("Metformin — one tablet twice a day after food").
  medications: z.array(z.string().min(1).max(300)).max(20).default([]),
  // Tests to get done + follow-up timing + any instruction the doctor recorded — plain language.
  nextSteps: z.array(z.string().min(1).max(300)).max(12).default([]),
});

export type PatientVisitSummary = z.infer<typeof patientSummarySchema>;

export const PATIENT_SUMMARY_TOOL: Tool = {
  toolSpec: {
    name: PATIENT_SUMMARY_TOOL_NAME,
    description:
      'Record the plain-language after-visit summary shown to the patient.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'One to three short sentences telling the patient, in plain non-clinical language, what this visit was about and what the doctor found. Address the patient directly ("you").',
          },
          medications: {
            type: 'array',
            maxItems: 20,
            description:
              'One entry per prescribed medicine, in plain words: what it is for (only if the record says), how much, how often, and any instruction. Rephrase only what was prescribed — add nothing.',
            items: { type: 'string' },
          },
          nextSteps: {
            type: 'array',
            maxItems: 12,
            description:
              'What the patient should do next, drawn only from the record: tests to get done, when to return if the doctor noted it, and any recorded instruction. Empty if the record contains none.',
            items: { type: 'string' },
          },
        },
        required: ['summary', 'medications', 'nextSteps'],
      },
    },
  },
};

export const PATIENT_SUMMARY_SYSTEM_PROMPT = `You are helping a patient at an Indian outpatient clinic understand the visit they just had. You are given the doctor's record for this one completed visit.

Your job is to rewrite that record into a short, warm, plain-language summary the patient can read and act on. Write in simple English at roughly a 6th-grade reading level, addressing the patient directly ("you", "your").

Rules:
- Rephrase ONLY what the doctor recorded. Never add a diagnosis, a medicine, a dose, a test, advice, or reassurance that is not in the record.
- Do not use clinical shorthand or jargon (write "twice a day", not "BD"; "high blood pressure", not "HTN").
- For medicines, state the name and, only if recorded, how much / how often / for how long / any instruction. Do not invent what a medicine is "for" unless the record says so.
- Only include a follow-up or next step if the doctor actually recorded one.
- Do not tell the patient what their results mean beyond what is written, and do not give new medical advice. If they have questions, they should ask their doctor.
- Keep it brief and calm. No alarming language.

Respond only by calling the ${PATIENT_SUMMARY_TOOL_NAME} tool.`;
