import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toMedicineResponse } from './medicine.mapper';
import type { SearchMedicinesDto } from './dto/medicine.dto';

/**
 * Org-facing read of the master medicine catalog (GLOBAL, platform-curated): the prescription
 * autocomplete and nothing else. Curation lives in {@link MedicineCatalogService}.
 * Prescriptions remain free text — the catalog is a typing aid, never a constraint.
 *
 * Deliberately singleton (no AuditService): this is a per-keystroke path.
 */
@Injectable()
export class MedicinesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Contains-search over brand name, generic name, and ingredients (case-insensitive). */
  async search(dto: SearchMedicinesDto) {
    const rows = await this.prisma.medicine.findMany({
      where: {
        deletedAt: null,
        OR: [
          { name: { contains: dto.q, mode: 'insensitive' } },
          { genericName: { contains: dto.q, mode: 'insensitive' } },
          { ingredients: { contains: dto.q, mode: 'insensitive' } },
        ],
      },
      orderBy: { name: 'asc' },
      take: dto.limit,
    });
    return rows.map(toMedicineResponse);
  }
}
