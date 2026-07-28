import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  DossierCondition,
  DossierMedication,
  DossierTest,
  DossierVisit,
  PatientDossier,
} from './ai.types';

/**
 * How much history the model gets. Bounded deliberately: a chronic patient with 200 visits must
 * not blow the context window or the per-check-in cost. Constants, not configuration — changing
 * the window changes what every cached summary was built from.
 */
const DOSSIER_VISIT_LIMIT = 10;
const DOSSIER_MONTHS = 24;

/** Trim free-text clinical fields so one verbose note can't dominate the prompt. */
const TEXT_LIMIT = 600;

/**
 * Builds the deterministic patient dossier that grounds every AI feature (see
 * docs/architecture/ai-features.md). This is also what the UI renders as FACT — the model's
 * narrative sits beside it, never replaces it.
 *
 * Two clients on purpose:
 *  - `scoped` for visits/prescriptions/test orders → a doctor sees only episodes at their own org
 *  - `prisma` (unscoped) for `patient` + `patient_condition`, which are GLOBAL by design so that
 *    allergies follow the patient across orgs (see data-model.md)
 *
 * Callers must have already established that the patient is registered at this org — every route
 * that reaches here goes through a visit, which is org-scoped.
 */
@Injectable()
export class DossierService {
  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * `excludeVisitId` — the visit being summarised, when building for a visit-start summary. The
   * summary is about PRIOR history, and the exclusion is also what keeps the cache stable:
   * without it, every vitals/note edit during the consultation changes the hash and re-triggers
   * paid inference on the next read. Omit for future patient-level kinds (e.g. ask-this-chart),
   * where the current visit legitimately belongs in the dossier.
   */
  async build(
    patientId: string,
    options: { excludeVisitId?: string } = {},
  ): Promise<PatientDossier> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: {
        id: true,
        user: {
          select: {
            firstName: true,
            lastName: true,
            dateOfBirth: true,
            gender: true,
          },
        },
        conditions: {
          where: { deletedAt: null },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          select: {
            id: true,
            type: true,
            name: true,
            status: true,
            notes: true,
            createdAt: true,
          },
        },
      },
    });
    if (!patient) throw new NotFoundException('Patient not found');

    const since = new Date();
    since.setMonth(since.getMonth() - DOSSIER_MONTHS);

    const visits = await this.scoped.db.visit.findMany({
      where: {
        patientId,
        checkInAt: { gte: since },
        ...(options.excludeVisitId ? { id: { not: options.excludeVisitId } } : {}),
      },
      orderBy: { checkInAt: 'desc' },
      take: DOSSIER_VISIT_LIMIT,
      include: {
        practice: { select: { name: true } },
        provider: {
          select: {
            specialty: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
        prescriptions: { orderBy: { createdAt: 'asc' } },
        testOrders: { orderBy: { createdAt: 'asc' } },
      },
    });

    const dossierVisits: DossierVisit[] = [];
    const medications: DossierMedication[] = [];
    const tests: DossierTest[] = [];

    for (const visit of visits) {
      const date = isoDate(visit.checkInAt);
      dossierVisits.push({
        cite: `visit:${visit.visitNumber}`,
        visitNumber: visit.visitNumber,
        date,
        practiceName: visit.practice.name,
        providerName:
          `${visit.provider.user.firstName} ${visit.provider.user.lastName ?? ''}`.trim(),
        specialty: visit.provider.specialty,
        symptoms: clip(visit.symptoms),
        diagnosis: clip(visit.diagnosis),
        notes: clip(visit.notes),
        vitals: asRecord(visit.vitals),
      });

      for (const rx of visit.prescriptions) {
        medications.push({
          cite: `medication:${rx.id}`,
          visitNumber: visit.visitNumber,
          date,
          drug: rx.drug,
          dosage: rx.dosage,
          frequency: rx.frequency,
          duration: rx.duration,
        });
      }
      for (const test of visit.testOrders) {
        tests.push({
          cite: `test:${test.id}`,
          visitNumber: visit.visitNumber,
          date,
          name: test.name,
          status: test.status,
          result: clip(test.result),
        });
      }
    }

    const toCondition = (
      prefix: string,
      row: (typeof patient.conditions)[number],
    ): DossierCondition => ({
      cite: `${prefix}:${row.id}`,
      name: row.name,
      status: row.status,
      notes: clip(row.notes),
      recordedAt: isoDate(row.createdAt),
    });

    return {
      patient: {
        id: patient.id,
        name: `${patient.user.firstName} ${patient.user.lastName ?? ''}`.trim(),
        age: ageInYears(patient.user.dateOfBirth),
        gender: patient.user.gender,
      },
      allergies: patient.conditions
        .filter((c) => c.type === 'allergy')
        .map((c) => toCondition('allergy', c)),
      conditions: patient.conditions
        .filter((c) => c.type === 'condition')
        .map((c) => toCondition('condition', c)),
      // Visits are queried newest-first (that's the useful order for the model); the trend is
      // rendered oldest-first because that's how a human reads a progression.
      visits: dossierVisits,
      medications,
      tests,
      vitalsTrend: [...dossierVisits]
        .reverse()
        .filter((v) => v.vitals && Object.keys(v.vitals).length > 0)
        .map((v) => ({
          date: v.date,
          vitals: v.vitals as Record<string, unknown>,
        })),
    };
  }
}

/**
 * Stable content hash of a dossier — the cache key for `ai_generation.input_hash`. Object keys
 * are sorted so that an incidental reordering by Prisma doesn't look like a record change and
 * trigger a pointless regeneration.
 */
export function hashDossier(dossier: PatientDossier): string {
  return hashJson(dossier);
}

/** Stable, key-order-independent content hash of any JSON value (drives `input_hash` cache keys). */
export function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalise(value)).digest('hex');
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
  return `{${entries.join(',')}}`;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function clip(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > TEXT_LIMIT
    ? `${trimmed.slice(0, TEXT_LIMIT)}…`
    : trimmed;
}

/** Prisma `Json` is typed loosely; vitals are only ever written as an object (see visit DTO). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ageInYears(dob: Date | null): number | null {
  if (!dob) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate()))
    age -= 1;
  return age >= 0 ? age : null;
}
