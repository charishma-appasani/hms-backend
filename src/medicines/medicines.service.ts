import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Medicine } from '../../generated/prisma/client';
import type {
  CreateMedicineDto,
  SearchMedicinesDto,
  UpdateMedicineDto,
} from './dto/medicine.dto';

/**
 * Master medicine catalog (GLOBAL, platform-curated). Org clinicians only SEARCH it (the
 * prescription autocomplete); create/update/delete is platform-operator master-data entry.
 * Prescriptions remain free text — the catalog is a typing aid, never a constraint.
 */
@Injectable()
export class MedicinesService {
  private readonly logger = new Logger(MedicinesService.name);

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
    return rows.map(toResponse);
  }

  async create(dto: CreateMedicineDto) {
    const created = await this.prisma.medicine.create({ data: dto });
    this.logger.log(`Medicine created: id=${created.id} name=${created.name}`);
    return toResponse(created);
  }

  async update(id: string, dto: UpdateMedicineDto) {
    const existing = await this.prisma.medicine.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Medicine not found');
    const updated = await this.prisma.medicine.update({
      where: { id },
      data: dto,
    });
    return toResponse(updated);
  }

  async remove(id: string): Promise<void> {
    const { count } = await this.prisma.medicine.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('Medicine not found');
    this.logger.log(`Medicine removed: id=${id}`);
  }
}

function toResponse(m: Medicine) {
  return {
    id: m.id,
    name: m.name,
    genericName: m.genericName,
    manufacturer: m.manufacturer,
    ingredients: m.ingredients,
    form: m.form,
    strength: m.strength,
  };
}
