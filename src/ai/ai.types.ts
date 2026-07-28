/**
 * Shared shapes for the AI layer. See docs/architecture/ai-features.md.
 *
 * The central idea: a {@link PatientDossier} is a DETERMINISTIC projection of the patient's
 * record built by our own code. The UI renders it as fact; the model only ever writes prose
 * ABOUT it. Nothing the model returns is treated as a record value.
 */

/** A dossier item's stable citation id, e.g. `visit:V000012`, `allergy:<uuid>`. */
export type CitationId = string;

export interface DossierPatient {
  id: string;
  name: string;
  /** Whole years at dossier build time; null when dob is not recorded. */
  age: number | null;
  gender: string | null;
}

export interface DossierCondition {
  cite: CitationId;
  name: string;
  status: string;
  notes: string | null;
  recordedAt: string;
}

export interface DossierVisit {
  cite: CitationId;
  visitNumber: string;
  date: string;
  practiceName: string;
  providerName: string;
  specialty: string | null;
  symptoms: string | null;
  diagnosis: string | null;
  notes: string | null;
  vitals: Record<string, unknown> | null;
}

export interface DossierMedication {
  cite: CitationId;
  visitNumber: string;
  date: string;
  drug: string;
  dosage: string | null;
  frequency: string | null;
  duration: string | null;
}

export interface DossierTest {
  cite: CitationId;
  visitNumber: string;
  date: string;
  name: string;
  status: string;
  result: string | null;
}

/**
 * Everything the model is allowed to know about a patient. Bounded on purpose (see
 * DOSSIER_VISIT_LIMIT / DOSSIER_MONTHS) so a long-standing chronic patient can't blow the
 * context window or the cost model.
 *
 * `visits`/`medications`/`tests` come from the ORG-SCOPED client — a doctor sees only episodes
 * recorded at their own org. `allergies`/`conditions` are patient-global by design.
 */
export interface PatientDossier {
  patient: DossierPatient;
  allergies: DossierCondition[];
  conditions: DossierCondition[];
  visits: DossierVisit[];
  medications: DossierMedication[];
  tests: DossierTest[];
  /** Oldest → newest, for the trend sparkline. One entry per visit that recorded vitals. */
  vitalsTrend: { date: string; vitals: Record<string, unknown> }[];
}

/** Model-authored narrative. Every claim should carry a `cite` back into the dossier. */
export interface VisitSummary {
  summary: string;
  highlights: {
    text: string;
    severity: 'info' | 'attention' | 'urgent';
    cite: CitationId | null;
  }[];
  watchOuts: string[];
  openThreads: string[];
}

/** What a provider reports back alongside the parsed output, for the ai_generation row. */
export interface AiUsage {
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiSummaryResult {
  summary: VisitSummary;
  usage: AiUsage;
}

/** Ask-this-chart answer (see chart-query.schema.ts). */
export interface ChartAnswer {
  answer: string;
  /** false = the dossier did not contain what was asked (the model must not guess). */
  foundInRecord: boolean;
  citations: string[];
}

export interface AiChartAnswerResult {
  answer: ChartAnswer;
  usage: AiUsage;
}

/**
 * The doctor's completed-visit record, as the ONLY input to the patient-facing summary. The
 * model rewrites this — it is given nothing else, so it cannot introduce anything unrecorded.
 */
export interface PatientVisitInput {
  patientFirstName: string;
  orgName: string;
  date: string;
  diagnosis: string | null;
  symptoms: string | null;
  notes: string | null;
  medications: {
    drug: string;
    dosage: string | null;
    frequency: string | null;
    duration: string | null;
    instructions: string | null;
  }[];
  tests: { name: string; instructions: string | null }[];
}

/** Plain-language after-visit summary shown to the patient. */
export interface PatientVisitSummary {
  summary: string;
  medications: string[];
  nextSteps: string[];
}

export interface AiPatientSummaryResult {
  summary: PatientVisitSummary;
  usage: AiUsage;
}

/**
 * Pluggable inference backend — mirrors the NotificationChannel pattern. `AI_ENABLED` selects
 * the real Bedrock provider or the offline stub (so local/CI never call AWS or spend money).
 */
export const AI_PROVIDER = Symbol('AI_PROVIDER');

export interface AiProvider {
  summariseVisit(dossier: PatientDossier): Promise<AiSummaryResult>;
  /** Answer a natural-language question grounded in the dossier (ask-this-chart). */
  answerChartQuestion(
    dossier: PatientDossier,
    question: string,
  ): Promise<AiChartAnswerResult>;
  /** Rewrite a completed visit's record into a plain-language patient summary. */
  summariseVisitForPatient(
    input: PatientVisitInput,
  ): Promise<AiPatientSummaryResult>;
}
