import { Injectable, Logger } from '@nestjs/common';
import type {
  AiChartAnswerResult,
  AiPatientSummaryResult,
  AiProvider,
  AiSummaryResult,
  PatientDossier,
  PatientVisitInput,
} from './ai.types';

/**
 * Offline provider used when `AI_ENABLED=false` (the default) — local dev and CI never call AWS
 * and never spend money, exactly as the logging notification channels work for SES/SNS.
 *
 * It is DETERMINISTIC and derived from the dossier rather than canned text, so the whole
 * pipeline (dossier → hash → cache → persistence → API shape → UI) is exercisable end-to-end
 * without inference. It states plainly that it is not a real summary; nobody should mistake
 * stub output for a model's.
 */
@Injectable()
export class StubAiProvider implements AiProvider {
  private readonly logger = new Logger(StubAiProvider.name);

  summariseVisit(dossier: PatientDossier): Promise<AiSummaryResult> {
    this.logger.debug(
      `[stub] summarising patient=${dossier.patient.id} visits=${dossier.visits.length}`,
    );

    const { patient, allergies, conditions, visits } = dossier;
    const active = conditions.filter((c) => c.status === 'active');
    const last = visits[0];

    const parts = [
      `${patient.name}${patient.age !== null ? `, ${patient.age}` : ''} — ${visits.length} recorded visit(s) at this organisation.`,
      active.length
        ? `Active conditions: ${active.map((c) => c.name).join(', ')}.`
        : 'No active conditions recorded.',
      last
        ? `Last seen ${last.date} by ${last.providerName}${last.diagnosis ? ` — ${last.diagnosis}` : ''}.`
        : 'No previous visit on record.',
      '(AI is disabled in this environment; this is a generated placeholder, not a model summary.)',
    ];

    return Promise.resolve({
      summary: {
        summary: parts.join(' '),
        highlights: allergies.map((a) => ({
          text: `Documented allergy: ${a.name}.`,
          severity: 'attention' as const,
          cite: a.cite,
        })),
        watchOuts: allergies.length
          ? [`Patient has ${allergies.length} documented allergy/allergies.`]
          : [],
        openThreads: dossier.tests
          .filter((t) => t.status !== 'resulted' && t.status !== 'cancelled')
          .map(
            (t) => `Test '${t.name}' ordered ${t.date} has no recorded result.`,
          ),
      },
      usage: { modelId: 'stub' },
    });
  }

  /**
   * Offline ask-this-chart: a naive keyword scan over the dossier so the end-to-end pipeline
   * (question → grounded answer → citations → persistence → UI) is exercisable without a model.
   * Not a real answer — it says so — but it demonstrates grounding and the found/not-found path.
   */
  answerChartQuestion(
    dossier: PatientDossier,
    question: string,
  ): Promise<AiChartAnswerResult> {
    const terms = question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3);

    const hits: { text: string; cite: string }[] = [];
    const scan = (text: string | null, cite: string, label: string) => {
      if (!text) return;
      const hay = text.toLowerCase();
      if (terms.some((t) => hay.includes(t)))
        hits.push({ text: `${label}: ${text}`, cite });
    };

    for (const a of dossier.allergies) scan(a.name, a.cite, 'Allergy');
    for (const c of dossier.conditions) scan(c.name, c.cite, 'Condition');
    for (const m of dossier.medications)
      scan(m.drug, m.cite, `Medication (${m.date})`);
    for (const t of dossier.tests)
      scan(`${t.name} ${t.result ?? ''}`, t.cite, `Test (${t.date})`);
    for (const v of dossier.visits)
      scan(
        `${v.diagnosis ?? ''} ${v.symptoms ?? ''} ${v.notes ?? ''}`,
        v.cite,
        `Visit ${v.visitNumber}`,
      );

    const found = hits.length > 0;
    return Promise.resolve({
      answer: {
        answer: found
          ? `Matches in the record for "${question}": ${hits.map((h) => h.text).join('; ')}. ` +
            '(AI is disabled in this environment; this is a keyword match, not a model answer.)'
          : `Nothing in the available record matches "${question}". (AI is disabled in this environment; ` +
            'this is a keyword scan, not a model answer.)',
        foundInRecord: found,
        citations: hits.map((h) => h.cite),
      },
      usage: { modelId: 'stub' },
    });
  }

  /**
   * Offline patient summary: a deterministic rephrase of the visit record, so the whole pipeline
   * (completion → generate → persist → portal → notification) is exercisable without a model.
   * Says plainly that AI is disabled; it only reformats what the doctor recorded.
   */
  summariseVisitForPatient(
    input: PatientVisitInput,
  ): Promise<AiPatientSummaryResult> {
    return Promise.resolve({
      summary: {
        summary: input.diagnosis
          ? `At your visit on ${input.date} at ${input.orgName}, the doctor noted: ${input.diagnosis}. ` +
            '(AI is disabled here; this is a placeholder, not a model summary.)'
          : `This is a summary of your visit on ${input.date} at ${input.orgName}. ` +
            '(AI is disabled here; this is a placeholder, not a model summary.)',
        medications: input.medications.map((m) =>
          [m.drug, m.dosage, m.frequency, m.duration, m.instructions]
            .filter(Boolean)
            .join(' — '),
        ),
        nextSteps: input.tests.map((t) =>
          t.instructions
            ? `${t.name} (${t.instructions})`
            : `Get this test done: ${t.name}`,
        ),
      },
      usage: { modelId: 'stub' },
    });
  }
}
