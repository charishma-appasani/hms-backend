# AI Features

> How AI capabilities are built into the product. Decision record: AI output is **advisory,
> grounded, and never authoritative** — facts are rendered by code from Postgres, the model
> writes only narrative, and nothing an LLM produces enters the clinical record without an
> explicit human accept.

## Context

The product is being positioned as an AI-assisted HMS. The clinical record we already hold is
small, structured and per-patient: `patient_condition` (conditions + allergies, global),
`visit` (vitals, symptoms, diagnosis, notes), `prescription`, `test_order`. That shape makes
most of the useful AI surface a **prompt-construction** problem, not a retrieval problem.

Two constraints shape every decision below:

1. **Patient safety.** A hallucinated allergy, drug or diagnosis is a clinical incident, not a
   bad UX. The mitigation is architectural (grounding + code-rendered facts + accept-gate), not
   prompt wording.
2. **DPDP / data residency.** Prompts contain PHI. Inference must stay in-region, must not be
   logged in plaintext, and must be auditable after the fact.

## Roadmap

Ordered by value-to-risk. Only phase 1 is built.

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | **Visit-start patient summary** — dossier + narrative, pre-generated at check-in | **Built** (this doc) | Cached on the visit; doctor sees it instantly |
| 2 | **Prescription safety check** — allergy conflict + duplicate therapy | **Built** (see below) | Fully deterministic — no LLM at all. Interactions explicitly out of scope |
| 3 | **Note completion** — terse notes → structured SOAP note | Planned | Doctor authored the content; we reformat. Low risk |
| 4 | **Consider asking / consider ordering** — history questions + test suggestions | Planned | Framed as prompts, never conclusions |
| 5 | **Ambient scribe** — dictation → structured note, multilingual | Planned | Highest time-saving; needs transcription + code-switching (en/hi/te) |
| 6 | **Patient visit summary** — plain-language, to the portal + a notification | **Built** (see below) | Rewrites doctor-approved content only; English-only for now (language deferred) |
| 7 | **Coding assist** — ICD-10 from free-text `diagnosis` | Planned | Unlocks claims + analytics |
| 8 | **Ask-this-chart** — NL Q&A over one patient's record | **Built** (see below) | Reuses the dossier; on-demand model call — cost only when a clinician asks |
| 9 | **Differential diagnosis list** | Deferred | Highest liability. Ship behind an explicit toggle, after regulatory review |
| 10 | Ops intelligence — no-show risk, wait-time estimates | Planned | **Not an LLM.** Regression over existing slot/visit timestamps |

## Cross-cutting decisions

### Grounding: code renders facts, the model writes prose

Every AI surface is built from a **dossier** — a deterministic JSON projection of the patient's
record assembled by our own code. The dossier is what the UI displays as fact (allergy chips,
condition list, vitals trend, medication list). The model receives that same dossier and returns
only a narrative plus **citations** pointing back at dossier items.

Consequence: if the model invents something, it appears as unsourced prose next to a factual
panel that contradicts it — it cannot masquerade as a record value. The API therefore always
returns both halves, and the UI must render the deterministic half even when generation failed.

### No vector store / Knowledge Base

One patient's full history is a few KB of JSON. Retrieval adds a second copy of PHI, an
ingestion pipeline, an embedding model, and a chunking-quality problem — for no recall benefit
over "select the rows". Rejected. Revisit only if we ingest unstructured documents (scanned
reports, discharge PDFs) where retrieval is genuinely needed.

### Structured output via tool-use, not text parsing

Model responses are forced into a JSON schema with the Converse API's `toolConfig`, then parsed
with zod. Free-text-then-regex is not used; a malformed response fails the generation cleanly
rather than half-populating the UI.

### Best-effort, never in the critical path

`AiGenerationService` follows the same contract as `NotificationService` and `AuditService`: a
failure is logged and swallowed. Bedrock being down must never block a check-in or a
consultation. Failures are persisted as `status = 'failed'` so the UI can say so honestly
instead of showing a blank card.

### Everything is recorded

Every generation writes an `ai_generation` row holding the exact input snapshot, the output, the
model id, token counts and latency. This single table serves four purposes:

- **Medico-legal reproducibility** — what did the AI see when it said that
- **Cache + invalidation** — keyed by a hash of the dossier
- **Evaluation dataset** — with the thumbs up/down feedback column
- **Product metrics** — acceptance rate, cost per visit

### Provider abstraction + off by default

`AI_ENABLED` defaults to `false`, selecting a deterministic stub provider — local dev and CI
never call AWS and never spend money, exactly as `NOTIFICATIONS_ENABLED` works for SES/SNS.

## Phase 1: visit-start patient summary

### Flow

```
POST /visits/check-in
      │
      ├─ (tx) create visit, assign visit number, flip appointment → checked_in
      │
      └─ after commit, fire-and-forget ──► AiGenerationService.generateVisitSummary(visitId)
                                                │
                                                ├─ DossierService.build(patientId)   ← Postgres
                                                ├─ hash(dossier) → cache hit? return
                                                ├─ upsert ai_generation (status pending)
                                                ├─ AiProvider.summarise(dossier)     ← Bedrock
                                                └─ update ai_generation (ready | failed)

GET /ai/visits/:visitId/summary   ← doctor opens the consultation page; row is already ready
```

Generating at check-in rather than on open is the whole point: the doctor waits zero seconds.
The gap between check-in and consultation is minutes in practice, far more than the few seconds
inference takes.

### The dossier

Assembled by `DossierService` from the org-scoped client (visits, prescriptions, test orders)
plus the unscoped client for the two **global** tables (`patient`, `patient_condition` — allergies
follow the patient across orgs by design; see data-model.md).

| Section | Source | Window |
|---|---|---|
| `patient` | `app_user` demographics + computed age | — |
| `allergies` | `patient_condition` where `type = 'allergy'`, active first | all |
| `conditions` | `patient_condition` where `type = 'condition'` | all |
| `visits` | `visit` at this org — diagnosis, symptoms, notes, vitals | last 10, 24 months, **excluding the visit being summarised** |
| `medications` | `prescription` on those visits | last 10 visits |
| `tests` | `test_order` on those visits, with results | last 10 visits |
| `vitalsTrend` | vitals JSON off those visits, oldest → newest | last 10 visits |

Bounded deliberately: a long-standing chronic patient must not blow the context window or the
cost model. The window is a constant in `dossier.service.ts`, not configuration.

**Cross-org visibility.** The visit/prescription/test sections come from the *scoped* client, so
a doctor only ever sees clinical episodes recorded **at their own org**. Conditions and allergies
are global (that is the point of them). Making full clinical history cross-org would need the
consent machinery in `consent`/`patient_registration` and is out of scope here.

### The narrative

The model returns:

```jsonc
{
  "summary":     "2-4 sentence orientation for the doctor",
  "highlights":  [{ "text": "...", "severity": "info|attention|urgent", "cite": "visit:V000012" }],
  "watchOuts":   ["allergy or interaction risks worth stating out loud"],
  "openThreads": ["e.g. an ordered test that never got a result"]
}
```

`cite` values reference dossier item ids (`visit:<visitNumber>`, `condition:<id>`,
`allergy:<id>`, `test:<id>`). The frontend renders uncited highlights differently from cited
ones. The prompt forbids diagnosis, treatment recommendations and any fact not present in the
dossier.

### Caching + regeneration

`ai_generation` is unique on `(visit_id, kind)`. The row stores `input_hash` = SHA-256 of the
canonical dossier JSON. On any call:

- hash matches and status is `ready` → return the cached row, no inference
- hash differs (a condition was added, a past visit was edited) → regenerate in place
- `POST .../regenerate` forces it regardless

**Trade-off accepted:** regeneration overwrites the previous output rather than appending a new
row, so the summary has no version history. The summary is advisory and is not part of the
clinical record, and `audit_log` records each regeneration with the actor — that is enough. If
summaries ever become quotable in the record, switch to append-only and drop the unique index.

### Cost controls

Inference runs on every check-in, so the per-call cost is multiplied by patient volume. Four
guards keep spend proportional to value:

| Guard | Mechanism |
|---|---|
| **Current-visit exclusion** | The dossier excludes the visit being summarised. Without it, every mid-consultation edit (vitals, notes, prescriptions) changes the hash and re-triggers paid inference on the next read — one consultation could cost 5-10 calls instead of 1. Also a correctness fix: the summary is about *prior* history. |
| **Thin-dossier skip** | A patient with no prior visits, conditions or allergies gets a deterministic "new patient" summary written by code (`model_id = 'deterministic'`) — no model call. In Indian OPD a large share of check-ins are first visits, so this removes a sizeable fraction of all paid calls at zero value loss. Conditions/allergies without visits still run inference ("known diabetic, first visit here" is exactly what the narrative is for). |
| **Regenerate cooldown** | `POST .../regenerate` on a `ready` row younger than 30s returns **429** — every click is a paid call. Failed rows are exempt so a retry after an outage works immediately. |
| **Cache-by-hash** | Unchanged record ⇒ no inference (the base mechanism above). |

Still pending: prompt caching on the static system prompt (wire when `AI_ENABLED` goes true);
a per-org daily generation cap; a platform cost query over `ai_generation` token counts
(the data is already recorded per call — tokens x org x day is one GROUP BY away).

### What is *not* stored

- No PHI in application logs. Log lines carry ids, status, token counts and latency only.
- **Bedrock model invocation logging must stay disabled** (or be KMS-encrypted with restricted
  read access). It writes full prompts — i.e. PHI — to CloudWatch in plaintext. The same caveat
  applies to Guardrails: PII masking applies to the API *response*, not to the invocation log.

## Prescription safety check (built 2026-07-27)

Roadmap #2. Allergy-conflict + duplicate-therapy detection on the prescription form.
**Deliberately NOT an LLM feature**: an allergy conflict is a patient-safety fact, and facts are
computed by code in this product — a model recalling pharmacology from weights is exactly the
hallucination risk the architecture exists to avoid. Zero marginal cost per use, which is why it
ships ahead of the model-driven features.

### Two deterministic tiers

| Tier | Mechanism | Catches |
|---|---|---|
| **1 — tokens** | Word-boundary token match (never substrings) between an active allergy's text and the drug's name / generic / composition, with Indian spelling variants normalized (amoxycillin→amoxicillin, sulpha→sulfa, acetaminophen→paracetamol) | Allergy "Ibuprofen" vs "Brufen 400" (composition contains ibuprofen); allergy recorded as a brand ("Augmentin") resolves through the catalog to its ingredients |
| **2 — classes** | Allergy synonym → class ("sulfa" → sulfonamides) matched against `medicine.drug_class`; plus a short cross-reactivity list (penicillins ↔ cephalosporins) at lower severity | Allergy "Penicillin" vs Amoxicillin — nothing in the strings connects them; the class does |

Duplicate therapy reuses the token machinery against the visit's existing lines and the
patient's prescriptions at this org from the last 30 days.

**Explicit non-goal: drug-drug interactions.** Pairwise interaction data is a large licensed
dataset (DrugBank etc.); hand-curating it or asking an LLM to recall it are both unsafe. The
feature is labelled an *allergy and duplicate-therapy check* — do not extend it to claim
interaction coverage without licensed data.

### Behaviour

- **Warns, never blocks.** The doctor may prescribe into a known allergy with cover; blocking
  creates workarounds. The Add button relabels to "Add anyway".
- `POST /ai/prescription-check {visitId, drug}` — pre-submit, called (debounced) as the doctor
  types, so the warning appears before the line is added. Clinical roles.
- `POST /visits/:id/prescriptions` re-runs the check server-side; warnings ride back with the
  created line and, when present, an `audit_log` row `prescription.warning_shown` records that
  the doctor prescribed with the warning displayed — the medico-legal trail.
- Best-effort: a check failure never stops a prescription (logged, empty warnings).

### Data it depends on

- `patient_condition` rows with `type='allergy'`, `status='active'` (resolved allergies are
  ignored). Free-text quality matters; long-term, allergy entry should get the same catalog
  autocomplete as the prescription form.
- `medicine.drug_class` — nullable; rows without it degrade gracefully to tier 1. Curating
  ~15-20 classes on common catalog rows is platform master-data work, not code.
- Logic: `src/ai/prescription-safety.ts` (pure function — the token/variant/class/cross-
  reactivity tables live here); plumbing: `src/ai/prescription-safety.service.ts`.

## Ask-this-chart (built 2026-07-27)

Roadmap #8. Natural-language Q&A over one patient's record, from the consultation page — "any
drug allergies on record?", "recent BP readings?", "what was the last diagnosis?". This one
genuinely is a language task, so it uses a model — but on-demand: a call happens only when a
clinician asks, which is the best cost profile on the roadmap.

### Design

- **Reuses the dossier verbatim.** `DossierService.build(patientId)` — but *without*
  `excludeVisitId`: unlike the summary, a mid-consultation question ("what did I just record?")
  is legitimate, so the current visit is included.
- **Grounded + cited, same as the summary.** The model answers strictly from the dossier and
  cites the items it used. It is told the dossier is a BOUNDED recent extract, so a "not found"
  is phrased honestly ("no record of that in the visits available here") rather than "the
  patient has never…". `foundInRecord: false` is a first-class answer, not a failure.
- **Structured output** via Converse tool-use → `{answer, foundInRecord, citations[]}`, zod
  re-validated.
- **Synchronous, not best-effort.** The clinician waits for the answer, so a model failure
  returns a real `503` (the UI shows a toast), not a silently-swallowed empty card. The attempt
  is still audit-logged either way.

### Persistence — a separate table

Ask-this-chart writes to **`ai_chart_query`**, NOT `ai_generation`. The two have genuinely
different shapes:

| | `ai_generation` (summary) | `ai_chart_query` (ask) |
|---|---|---|
| Cardinality | one row per visit+kind | many rows per patient |
| Semantics | overwrite-in-place (cached) | append-only (a log) |
| Caching | hash-keyed | none — every question differs |
| Lifecycle | async pending→ready→failed | synchronous, no status |

Forcing both into one table would mean fighting the `unique(visit_id, kind)` constraint. Same
columns and same four purposes (audit, eval via `feedback`, cost via token counts, and
`input_hash` linking the answer to a record state) — different access pattern, so a different
table. It stores `input_hash` but **not** the full dossier snapshot per question (one snapshot
per question is heavy; the audit need here is "who asked what, answered how"). An `audit_log`
`ai.chart.query` row records every access — answered or failed.

### API

- `POST /ai/visits/:visitId/ask {question}` → the grounded answer (clinical roles)
- `GET /ai/patients/:patientId/chart-queries` → recent questions (the panel's history)
- `POST /ai/chart-queries/:id/feedback` → 👍/👎 (the eval signal)

Model: `AI_CHART_MODEL_ID`, falling back to `AI_SUMMARY_MODEL_ID`. Files:
`src/ai/chart-query.schema.ts` (answer schema + tool + prompt), `src/ai/chart-query.service.ts`.

## Patient visit summary (built 2026-07-27)

Roadmap #6. When a doctor completes a visit, the raw clinical record (`diagnosis`, `notes`,
`prescriptions`, `test_orders`) — written *for clinicians* — is rewritten into a few plain-
language sentences the patient can act on, shown in the portal and announced by a notification.

### Grounding — rephrase only

The model is given ONLY the completed visit's own fields and told to rephrase, never to add a
diagnosis, medicine, test, or advice the doctor didn't record. That rephrase-only boundary is the
entire reason this is low-risk enough to show a patient directly. Same tool-use + zod discipline
as the other features; output is `{summary, medications[], nextSteps[]}`. English-only for now —
a per-patient language preference is deferred (there is no language field yet).

### Lifecycle — generate on completion, read from the portal

- **Trigger:** the `completed` status transition in `VisitsService.updateStatus`, fire-and-forget
  after the transaction commits (best-effort — never delays or fails completion). Mirrors how
  check-in pre-warms the doctor summary.
- **Storage:** reuses `ai_generation` with kind `patient_summary` (one per visit, overwrite-in-
  place, idempotent by `input_hash`). NOT a new table — this is a cached single artifact per
  visit, exactly the shape `ai_generation` is for. Low volume: one small model call per
  *completed* visit (vs the doctor summary's per check-in), so it's the natural batch-inference
  candidate later.
- **Read:** the patient portal (`GET /portal/visits/:id`) returns `aiSummary` when a `ready` row
  exists. The WRITE happens in the completing staff's org context (scoped client); the READ is
  unscoped-by-`patientId` (the patient owns their record, no org context) — only `ready` rows are
  surfaced, so pending/failed shows nothing and the raw record below is unaffected.

### Notification — a pointer, not the record

After a summary is ready, `PatientSummaryService` sends a best-effort notification via
`NotificationService.dispatch` (the same SES/SNS path, stubs by default). It is deliberately a
**pointer** — "your visit summary is ready, sign in to the portal to read it" — carrying **no
clinical detail**. Rationale: minimal PHI leaves the app, it's safe over SMS without dumping a
diagnosis into a text, and the plain-language content stays behind portal auth. Putting the full
text in the *email* body (email only) is a future toggle, not the default.

Files: `src/ai/patient-summary.schema.ts`, `src/ai/patient-summary.service.ts`. Read path:
`src/patient-portal/patient-portal.service.ts` (`patientSummary`).

## Bedrock configuration

| Setting | Value |
|---|---|
| API | Converse (`@aws-sdk/client-bedrock-runtime`), non-streaming — this is a background job |
| Client | `maxAttempts: 5`, `retryMode: 'adaptive'` |
| `maxTokens` | **Always set explicitly.** Unset defaults to the model maximum and silently reserves ~43x the quota — the top cause of surprise `ThrottlingException` |
| Model | `AI_SUMMARY_MODEL_ID` — required when `AI_ENABLED=true`, no default (see below) |
| Region | `BEDROCK_REGION`, falling back to `AWS_REGION` |

### Region, model id, and the data-residency decision (verified 2026-07-27)

The stack runs in **ap-south-2 (Hyderabad)**. A live check against the account settled what is
actually available — and it is more constrained than the earlier plan assumed:

| Finding | Detail |
|---|---|
| Current Claude models in ap-south-2 | Haiku 4.5, Sonnet 4.6, Sonnet 5, Opus — all present, all **`global.` inference-profile ONLY** |
| `apac.` (APAC-contained) profile for current models | **Does not exist** in ap-south-1 or ap-south-2 (only the 2024 `claude-3-haiku` has one) |
| Invocation verified | `global.anthropic.claude-haiku-4-5-20251001-v1:0` invokes successfully **from ap-south-2** |
| In-India on-demand option | Only OLD models: `claude-3-haiku-20240307` / `claude-3-sonnet-20240229`, and only in **ap-south-1** (not Hyderabad) |
| Model-invocation logging | **Off** in both regions (no prompts written to CloudWatch) — keep it that way |

**`global.` routes inference to any commercial AWS region worldwide** — so a current model means
PHI can be processed outside India. There is currently no way to get a *current* Claude model in
these regions with inference contained to India (or even to APAC). This is a real DPDP decision,
not a throughput one:

- **Option A — current model, global routing.** `global.anthropic.claude-haiku-4-5…` from
  ap-south-2. Best quality, no infra change; needs a DPDP/legal sign-off because PHI leaves India.
- **Option B — in-India, older model.** `anthropic.claude-3-haiku-20240307-v1:0` on-demand with
  `BEDROCK_REGION=ap-south-1`. Stays in India, but a weaker 2024 model on every feature.
- **Option C — Provisioned Throughput** in ap-south-1 for a current model. India-contained +
  current quality, at an hourly-commitment cost. The production answer if strict residency is required.

Re-check any time (needs a recent AWS CLI — 2.15 is too old for `list-inference-profiles`; use the
SDK `ListInferenceProfiles` or an updated CLI):

```bash
aws bedrock list-foundation-models  --region ap-south-2 --by-provider anthropic
aws bedrock list-inference-profiles --region ap-south-2
```

Because these ids are environment-specific and change, `AI_SUMMARY_MODEL_ID` is a required env
var with no default rather than a source constant. A wrong id fails at runtime with
`ValidationException` / `ResourceNotFoundException`; a missing var fails at boot.

### Model choice

Everything currently runs on **Haiku 4.5** via `AI_SUMMARY_MODEL_ID` (the doctor summary and the
patient summary use it directly; ask-this-chart falls back to it via `AI_CHART_MODEL_ID`).

Is Haiku enough? Per feature:

| Feature | Task | Haiku verdict |
|---|---|---|
| Doctor visit summary | Summarise supplied structured data | ✅ Enough — no frontier reasoning needed, and it's the cost-sensitive per-check-in path |
| Patient visit summary | Rephrase one visit's record into plain language | ✅ Enough |
| **Ask-this-chart** | NL Q&A over the dossier | ⚠️ Enough for lookups ("any penicillin allergy?"); **multi-step reasoning** ("was she on antibiotics in the last 6 months and did they help?") may want **Sonnet** |
| Prescription safety | — | No model |

**So: leave everything on Haiku. Bump only `AI_CHART_MODEL_ID` to a Sonnet global profile
(e.g. `global.anthropic.claude-sonnet-4-6`) if chart answers to reasoning-heavy questions
disappoint** — it's a one-env-var change and only affects ask-this-chart's cost. Sonnet is also
the expected choice for the later suggestion/scribe features.

Prompt caching on the static system prompt is worth adding once call volume is real; not wired yet.

### IAM

The ECS task role needs `bedrock:InvokeModel`. When invoking through an inference profile the
policy must grant **both** ARN shapes, or the call fails with `AccessDeniedException` once the
profile routes cross-region:

- `arn:aws:bedrock:<region>:<account>:inference-profile/<profile-id>`
- `arn:aws:bedrock:*::foundation-model/<model-id>` (wildcard region — the request may land in any
  region within the profile; for a `global.` profile that is genuinely worldwide)

The CDK task role already grants both with wildcards (`inference-profile/*` +
`foundation-model/*`), which covers a global profile and its worldwide underlying models —
verified sufficient for `global.anthropic.claude-haiku-4-5` from ap-south-2.

## Consent and governance (pending)

Not built in phase 1; the gate today is the `AI_ENABLED` env flag, which is all-or-nothing per
environment. Before customer rollout:

- **Per-org opt-in** — an organization-level setting, so a hospital can decline AI processing.
- **Patient consent** — add `ai_processing` to the `ConsentType` enum and write a `consent` row.
  The table and the OTP machinery already exist (see data-model.md); only the enum value and the
  check are missing. Deliberately not added yet, to avoid a dead enum value.
- **Marketing claims** — copy must say clinical decision support / documentation assistant, never
  diagnosis. The differential-diagnosis feature (#9) should not ship without a regulatory opinion
  on medical-device classification in India.

## Files

| Path | Role |
|---|---|
| `src/ai/ai.module.ts` | Wiring; picks Bedrock vs stub provider on `AI_ENABLED` |
| `src/ai/ai.types.ts` | `PatientDossier`, `VisitSummary`, provider interface |
| `src/ai/dossier.service.ts` | Deterministic dossier projection + canonical hash |
| `src/ai/summary.schema.ts` | zod schema + the Converse tool spec derived from it |
| `src/ai/bedrock.provider.ts` | Real Converse call |
| `src/ai/stub.provider.ts` | Deterministic offline output (`AI_ENABLED=false`) |
| `src/ai/ai-generation.service.ts` | Cache, persistence, best-effort orchestration |
| `src/ai/prescription-safety.ts` | Pure deterministic allergy/duplicate check + its data tables |
| `src/ai/prescription-safety.service.ts` | Gathers allergies/lines/catalog rows for the check |
| `src/ai/chart-query.schema.ts` | Ask-this-chart answer schema + Converse tool + prompt |
| `src/ai/chart-query.service.ts` | Ask-this-chart: dossier → model → persist (`ai_chart_query`) + audit |
| `src/ai/patient-summary.schema.ts` | Patient after-visit summary schema + tool + rephrase-only prompt |
| `src/ai/patient-summary.service.ts` | Generate on completion → persist (`ai_generation` kind `patient_summary`) + notify |
| `src/ai/ai.controller.ts` | Summary, feedback, `/ai/prescription-check`, `/ai/visits/:id/ask`, chart history/feedback |
