/**
 * Deterministic prescription safety check (roadmap #2 in docs/architecture/ai-features.md).
 *
 * NO model is involved, on purpose: an allergy conflict is a patient-safety fact, and facts are
 * computed by code in this product. Two tiers, both reproducible:
 *
 *   Tier 1 — token matching: an active allergy's tokens appearing in the prescribed drug's
 *            name / generic name / composition (word-boundary tokens, spelling variants
 *            normalized — never substrings, so "pen" can't match unrelated drugs).
 *   Tier 2 — drug classes: allergy synonym → class ("sulfa" → sulfonamides) matched against the
 *            catalog row's `drug_class`, plus a short cross-reactivity list (penicillins ↔
 *            cephalosporins, at lower severity).
 *
 * Duplicate therapy reuses the same token machinery against the visit's existing lines and the
 * patient's recent prescriptions.
 *
 * Explicit NON-goal: full drug-drug interaction checking. That needs a licensed pairwise
 * dataset; hand-curating it or asking an LLM to recall it are both unsafe. Do not add "adds
 * interaction warnings" here without that dataset — the feature is deliberately labelled an
 * allergy + duplicate-therapy check.
 *
 * Warnings WARN, they never block — the doctor may prescribe into a known allergy with cover.
 * The caller records that warnings were shown (audit_log), which is the medico-legal trail.
 */

export interface PrescriptionWarning {
  type: 'allergy_conflict' | 'duplicate_therapy';
  /** urgent = direct allergy match; attention = cross-reactivity or duplicate. */
  severity: 'attention' | 'urgent';
  /** What matched (the allergy name or the earlier drug). */
  matched: string;
  /** Templated, cited explanation — no model involved. */
  reason: string;
  /** Dossier-style citation (`allergy:<id>`, `prescription:<id>`) for the UI chip. */
  cite: string;
}

/** Catalog facts for a drug name (resolved by the caller; null when not in the catalog). */
export interface CatalogEntry {
  name: string;
  genericName: string | null;
  ingredients: string | null;
  drugClass: string | null;
}

export interface AllergyInput {
  id: string;
  name: string;
  /** Catalog row the allergy text resolved to, when it names a brand (e.g. "Augmentin"). */
  catalog?: CatalogEntry | null;
}

export interface ExistingLineInput {
  id: string;
  drug: string;
  /** Where the line came from — this visit, or a recent visit (visitNumber + date set). */
  visitNumber?: string;
  date?: string;
  catalog?: CatalogEntry | null;
}

export interface DrugInput {
  drug: string;
  catalog?: CatalogEntry | null;
}

/**
 * Spelling/synonym normalization applied per token. Keyed variant → canonical. Kept small and
 * Indian-OPD-focused; extend as real data shows misses.
 */
const TOKEN_VARIANTS: Record<string, string> = {
  amoxycillin: 'amoxicillin',
  ampicilline: 'ampicillin',
  sulpha: 'sulfa',
  sulphonamide: 'sulfonamide',
  sulphonamides: 'sulfonamide',
  sulfonamides: 'sulfonamide',
  acetaminophen: 'paracetamol',
  cephalosporins: 'cephalosporin',
  penicillins: 'penicillin',
  nsaids: 'nsaid',
  quinolones: 'quinolone',
  macrolides: 'macrolide',
  tetracyclines: 'tetracycline',
  opioids: 'opioid',
  statins: 'statin',
};

/**
 * Allergy-synonym → canonical drug class. The tier-2 map: what a recorded allergy NAME implies
 * as a class. Canonical class ids are the singular normalized tokens above.
 */
const ALLERGY_CLASS_SYNONYMS: Record<string, string> = {
  penicillin: 'penicillin',
  sulfa: 'sulfonamide',
  sulfonamide: 'sulfonamide',
  nsaid: 'nsaid',
  aspirin: 'nsaid',
  cephalosporin: 'cephalosporin',
  quinolone: 'quinolone',
  macrolide: 'macrolide',
  tetracycline: 'tetracycline',
  opioid: 'opioid',
  statin: 'statin',
};

/**
 * Partial cross-reactivity between classes — flagged at `attention`, not `urgent`, because the
 * risk is possible, not established (e.g. a minority of penicillin-allergic patients react to
 * cephalosporins).
 */
const CROSS_REACTIVE: Record<string, string[]> = {
  penicillin: ['cephalosporin'],
  cephalosporin: ['penicillin'],
};

/** Tokens that carry no drug identity (units, forms, strengths). */
const STOP_TOKENS = new Set([
  'mg',
  'mcg',
  'ml',
  'gm',
  'iu',
  'tab',
  'tabs',
  'tablet',
  'tablets',
  'cap',
  'caps',
  'capsule',
  'capsules',
  'syrup',
  'syp',
  'injection',
  'inj',
  'cream',
  'gel',
  'drops',
  'drop',
  'ointment',
  'suspension',
  'forte',
  'plus',
  'and',
  'with',
  'of',
  'the',
  'dsr',
  'sr',
  'er',
  'xr',
  'od',
  'bd',
  'allergy',
  'allergic',
  'drugs',
  'drug',
]);

/** Lowercase word tokens with variants normalized; numbers, units and short noise dropped. */
export function drugTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || STOP_TOKENS.has(raw)) continue;
    out.add(TOKEN_VARIANTS[raw] ?? raw);
  }
  return out;
}

/** All identity tokens of a drug: what was typed plus its catalog row's name/generic/composition. */
function identityTokens(
  drug: string,
  catalog?: CatalogEntry | null,
): Set<string> {
  const tokens = drugTokens(drug);
  if (catalog) {
    for (const t of drugTokens(catalog.name)) tokens.add(t);
    for (const t of drugTokens(catalog.genericName)) tokens.add(t);
    for (const t of drugTokens(catalog.ingredients)) tokens.add(t);
  }
  return tokens;
}

/** Canonical class ids implied by an allergy row (its name, and its catalog row's class). */
function allergyClasses(allergy: AllergyInput): Set<string> {
  const classes = new Set<string>();
  for (const token of drugTokens(allergy.name)) {
    const cls = ALLERGY_CLASS_SYNONYMS[token];
    if (cls) classes.add(cls);
  }
  for (const token of drugTokens(allergy.catalog?.drugClass)) {
    classes.add(TOKEN_VARIANTS[token] ?? token);
  }
  return classes;
}

function intersect(a: Set<string>, b: Set<string>): string | null {
  for (const item of a) if (b.has(item)) return item;
  return null;
}

/**
 * The whole check as a pure function — trivially unit-testable, no I/O. The caller resolves
 * catalog rows (see AiGenerationService.checkPrescription) and passes them in.
 */
export function checkPrescriptionSafety(
  drug: DrugInput,
  allergies: AllergyInput[],
  existingLines: ExistingLineInput[],
): PrescriptionWarning[] {
  const warnings: PrescriptionWarning[] = [];
  const tokens = identityTokens(drug.drug, drug.catalog);
  const classTokens = drugTokens(drug.catalog?.drugClass);

  for (const allergy of allergies) {
    // Tier 1 — the allergy's tokens (or its catalog row's composition) inside the drug's identity.
    const allergyTokens = identityTokens(allergy.name, allergy.catalog);
    const hit = intersect(allergyTokens, tokens);
    if (hit) {
      warnings.push({
        type: 'allergy_conflict',
        severity: 'urgent',
        matched: allergy.name,
        reason: `Patient has a recorded allergy to ${allergy.name}; ${drug.drug} contains or matches "${hit}".`,
        cite: `allergy:${allergy.id}`,
      });
      continue; // one warning per allergy — the strongest match wins
    }

    // Tier 2 — class match via the catalog's drug_class.
    const classes = allergyClasses(allergy);
    const classHit = intersect(classes, classTokens);
    if (classHit) {
      warnings.push({
        type: 'allergy_conflict',
        severity: 'urgent',
        matched: allergy.name,
        reason: `Patient has a recorded allergy to ${allergy.name}; ${drug.drug} is a ${classHit}-class drug.`,
        cite: `allergy:${allergy.id}`,
      });
      continue;
    }

    // Tier 2b — partial cross-reactivity, lower severity.
    for (const cls of classes) {
      const related = (CROSS_REACTIVE[cls] ?? []).find((r) =>
        classTokens.has(r),
      );
      if (related) {
        warnings.push({
          type: 'allergy_conflict',
          severity: 'attention',
          matched: allergy.name,
          reason: `Patient has a recorded allergy to ${allergy.name} (${cls} class); ${drug.drug} is a ${related}-class drug with possible cross-reactivity.`,
          cite: `allergy:${allergy.id}`,
        });
        break;
      }
    }
  }

  for (const line of existingLines) {
    const lineTokens = identityTokens(line.drug, line.catalog);
    const hit = intersect(lineTokens, tokens);
    if (!hit) continue;
    warnings.push({
      type: 'duplicate_therapy',
      severity: 'attention',
      matched: line.drug,
      reason: line.visitNumber
        ? `${line.drug} was already prescribed on ${line.date} (${line.visitNumber}) — shared component "${hit}".`
        : `${line.drug} is already on this visit's prescription — shared component "${hit}".`,
      cite: `prescription:${line.id}`,
    });
  }

  // Urgent first — the UI shows these in order.
  return warnings.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'urgent' ? -1 : 1,
  );
}
