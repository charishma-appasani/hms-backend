import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, diffFields } from '../audit/audit.service';
import { toMedicineResponse } from './medicine.mapper';
import type {
  CreateMedicineDto,
  ImportMedicinesDto,
  ListMedicinesDto,
  UpdateMedicineDto,
} from './dto/medicine.dto';

/** Fields an operator can edit — also the audit diff surface. */
const EDITABLE = [
  'name',
  'genericName',
  'manufacturer',
  'ingredients',
  'form',
  'strength',
  'drugClass',
] as const;

/** Outcome of one bulk-import batch (the client aggregates across batches). */
export interface ImportResult {
  created: number;
  /** Rows whose (name, strength) already exists in the catalog — left untouched. */
  skipped: number;
  /** Rows the database rejected, keyed back to their CSV line. */
  errors: { sourceRow?: number; name: string; message: string }[];
}

/**
 * Master medicine catalog curation (`/platform/medicines`): browse, CRUD, and CSV bulk import.
 * Platform-only — super_admin and the data_entry operator role. Every mutation is audited with
 * `orgId: undefined` (these rows are global, not a tenant's).
 *
 * Request-scoped via AuditService; the org-facing autocomplete deliberately uses the singleton
 * {@link MedicinesService} instead.
 */
@Injectable()
export class MedicineCatalogService {
  private readonly logger = new Logger(MedicineCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Paged browse with an optional contains-filter (name / generic / manufacturer / ingredients). */
  async list(dto: ListMedicinesDto) {
    const q = dto.q?.trim();
    const where = {
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { genericName: { contains: q, mode: 'insensitive' as const } },
              { manufacturer: { contains: q, mode: 'insensitive' as const } },
              { ingredients: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.medicine.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (dto.page - 1) * dto.pageSize,
        take: dto.pageSize,
      }),
      this.prisma.medicine.count({ where }),
    ]);
    return {
      rows: rows.map(toMedicineResponse),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async create(dto: CreateMedicineDto) {
    const created = await this.prisma.medicine.create({ data: dto });
    this.logger.log(`Medicine created: id=${created.id} name=${created.name}`);
    await this.audit.record({
      action: 'medicine.create',
      entityType: 'medicine',
      entityId: created.id,
      metadata: { name: created.name },
    });
    return toMedicineResponse(created);
  }

  async update(id: string, dto: UpdateMedicineDto) {
    const existing = await this.prisma.medicine.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Medicine not found');
    const updated = await this.prisma.medicine.update({
      where: { id },
      data: dto,
    });
    await this.audit.record({
      action: 'medicine.update',
      entityType: 'medicine',
      entityId: id,
      metadata: {
        name: updated.name,
        changes: diffFields(pick(existing), dto),
      },
    });
    return toMedicineResponse(updated);
  }

  /** Soft delete — the catalog row disappears from search but prescriptions that quoted it stand. */
  async remove(id: string): Promise<void> {
    const existing = await this.prisma.medicine.findFirst({
      where: { id, deletedAt: null },
      select: { name: true },
    });
    if (!existing) throw new NotFoundException('Medicine not found');
    await this.prisma.medicine.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    this.logger.log(`Medicine removed: id=${id}`);
    await this.audit.record({
      action: 'medicine.delete',
      entityType: 'medicine',
      entityId: id,
      metadata: { name: existing.name },
    });
  }

  /**
   * Import one batch of parsed CSV rows. Existing entries are SKIPPED, never overwritten: a row is
   * a duplicate when its name + strength already exist (case-insensitive), which is the pair that
   * distinguishes catalog entries in practice ("Augmentin 625 mg" vs "Augmentin 1 g"). Duplicates
   * inside the batch itself are collapsed the same way, so a file listing a brand twice imports once.
   */
  async import(dto: ImportMedicinesDto): Promise<ImportResult> {
    const result: ImportResult = { created: 0, skipped: 0, errors: [] };

    const names = [...new Set(dto.rows.map((r) => r.name.toLowerCase()))];
    const existing = await this.prisma.$queryRaw<
      { name: string; strength: string | null }[]
    >`
      SELECT name, strength FROM "medicine"
      WHERE deleted_at IS NULL AND lower(name) = ANY(${names}::text[])`;
    const seen = new Set(existing.map((m) => dupKey(m.name, m.strength)));

    for (const row of dto.rows) {
      const { sourceRow, ...data } = row;
      const key = dupKey(data.name, data.strength);
      if (seen.has(key)) {
        result.skipped++;
        continue;
      }
      try {
        await this.prisma.medicine.create({ data });
        seen.add(key);
        result.created++;
      } catch (err) {
        result.errors.push({
          sourceRow,
          name: data.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log(
      `Medicine import batch: created=${result.created} skipped=${result.skipped} failed=${result.errors.length}`,
    );
    await this.audit.record({
      action: 'medicine.import',
      entityType: 'medicine',
      metadata: {
        created: result.created,
        skipped: result.skipped,
        failed: result.errors.length,
      },
    });
    return result;
  }
}

/** Duplicate identity for import: brand name + strength, case- and whitespace-insensitive. */
function dupKey(name: string, strength: string | null | undefined): string {
  const norm = (s: string | null | undefined) =>
    (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${norm(name)}|${norm(strength)}`;
}

/** The editable slice of a row, for the audit diff. */
function pick(m: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(EDITABLE.map((k) => [k, m[k]]));
}
