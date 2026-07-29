import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkPrescriptionSafety,
  type CatalogEntry,
  type ExistingLineInput,
  type PrescriptionWarning,
} from './prescription-safety';

/** How far back a prior prescription counts as "possibly still being taken". */
const RECENT_DAYS = 30;

const CATALOG_SELECT = {
  name: true,
  genericName: true,
  ingredients: true,
  drugClass: true,
} as const;

/**
 * Data plumbing for the deterministic prescription check (logic lives in prescription-safety.ts
 * as a pure function). Gathers, for one visit + one candidate drug:
 *   - the patient's ACTIVE allergies (global patient_condition — unscoped client by design)
 *   - this visit's existing prescription lines (scoped)
 *   - the patient's other prescriptions at this org from the last 30 days (scoped)
 * and resolves each drug/allergy text against the medicine catalog so tier-2 class data is
 * available. No model, no network beyond Postgres — cheap enough to call on every keystroke
 * pause in the prescription form.
 */
@Injectable()
export class PrescriptionSafetyService {
  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly prisma: PrismaService,
  ) {}

  async checkForVisit(
    visitId: string,
    drug: string,
  ): Promise<PrescriptionWarning[]> {
    const visit = await this.scoped.db.visit.findFirst({
      where: { id: visitId },
      select: { id: true, patientId: true },
    });
    if (!visit) throw new NotFoundException('Visit not found');

    const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
    const [allergies, currentLines, recentLines] = await Promise.all([
      this.prisma.patientCondition.findMany({
        where: {
          patientId: visit.patientId,
          type: 'allergy',
          status: 'active',
          deletedAt: null,
        },
        select: { id: true, name: true },
      }),
      this.scoped.db.prescription.findMany({
        where: { visitId },
        select: { id: true, drug: true },
      }),
      this.scoped.db.prescription.findMany({
        where: {
          createdAt: { gte: since },
          visitId: { not: visitId },
          visit: { patientId: visit.patientId },
        },
        select: {
          id: true,
          drug: true,
          createdAt: true,
          visit: { select: { visitNumber: true } },
        },
      }),
    ]);

    const existing: ExistingLineInput[] = [
      ...currentLines.map((l) => ({ id: l.id, drug: l.drug })),
      ...recentLines.map((l) => ({
        id: l.id,
        drug: l.drug,
        visitNumber: l.visit.visitNumber,
        date: l.createdAt.toISOString().slice(0, 10),
      })),
    ];

    // Resolve catalog rows for every text we'll match (candidate drug, allergies naming a
    // brand, existing lines). Deduplicated; the check works with nulls (tier 1 only).
    const texts = new Set<string>([
      drug,
      ...allergies.map((a) => a.name),
      ...existing.map((l) => l.drug),
    ]);
    const catalog = new Map<string, CatalogEntry | null>();
    await Promise.all(
      [...texts].map(async (text) =>
        catalog.set(text, await this.resolveCatalog(text)),
      ),
    );

    return checkPrescriptionSafety(
      { drug, catalog: catalog.get(drug) },
      allergies.map((a) => ({ ...a, catalog: catalog.get(a.name) })),
      existing.map((l) => ({ ...l, catalog: catalog.get(l.drug) })),
    );
  }

  /**
   * Best-effort catalog lookup for free text. The autocomplete fills exact catalog names, so
   * equals-insensitive is the main path; "Brufen 400" falls back to the part before the number;
   * a typed generic falls back to generic_name. A miss just means tier-1-typed-tokens only.
   */
  private async resolveCatalog(text: string): Promise<CatalogEntry | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const byName = await this.prisma.medicine.findFirst({
      where: {
        deletedAt: null,
        name: { equals: trimmed, mode: 'insensitive' },
      },
      select: CATALOG_SELECT,
    });
    if (byName) return byName;

    const lead = trimmed.replace(/\s+\d.*$/, '').trim();
    if (lead && lead !== trimmed) {
      const byLead = await this.prisma.medicine.findFirst({
        where: { deletedAt: null, name: { equals: lead, mode: 'insensitive' } },
        select: CATALOG_SELECT,
      });
      if (byLead) return byLead;
    }

    return this.prisma.medicine.findFirst({
      where: {
        deletedAt: null,
        genericName: { equals: lead || trimmed, mode: 'insensitive' },
      },
      select: CATALOG_SELECT,
    });
  }
}
