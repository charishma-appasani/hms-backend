import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { PlatformRoles } from '../auth/platform-roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MedicinesService } from './medicines.service';
import { MedicineCatalogService } from './medicine-catalog.service';
import {
  createMedicineSchema,
  importMedicinesSchema,
  listMedicinesSchema,
  searchMedicinesSchema,
  updateMedicineSchema,
  type CreateMedicineDto,
  type ImportMedicinesDto,
  type ListMedicinesDto,
  type SearchMedicinesDto,
  type UpdateMedicineDto,
} from './dto/medicine.dto';

const ORG_MEMBER = [
  'admin',
  'doctor',
  'doctor_assistant',
  'front_desk',
  'nurse',
] as const;

/** Org-facing: the prescription autocomplete's search (read-only, org context required). */
@Controller('medicines')
export class MedicinesController {
  constructor(private readonly medicines: MedicinesService) {}

  @Get()
  @Roles(...ORG_MEMBER)
  search(
    @Query(new ZodValidationPipe(searchMedicinesSchema))
    query: SearchMedicinesDto,
  ) {
    return this.medicines.search(query);
  }
}

/**
 * Platform master-data entry: the medicine catalog console. Curation is super_admin + the
 * data_entry operator role (whose ONLY platform surface this is); support can read. No org context
 * on /platform/* — the catalog is global.
 */
@Controller('platform/medicines')
export class PlatformMedicinesController {
  constructor(private readonly catalog: MedicineCatalogService) {}

  @Get()
  @PlatformRoles('super_admin', 'data_entry', 'support')
  list(
    @Query(new ZodValidationPipe(listMedicinesSchema)) query: ListMedicinesDto,
  ) {
    return this.catalog.list(query);
  }

  @Post()
  @PlatformRoles('super_admin', 'data_entry')
  create(
    @Body(new ZodValidationPipe(createMedicineSchema)) dto: CreateMedicineDto,
  ) {
    return this.catalog.create(dto);
  }

  /** One batch of a CSV import (the client parses the file and chunks it). */
  @Post('import')
  @PlatformRoles('super_admin', 'data_entry')
  import(
    @Body(new ZodValidationPipe(importMedicinesSchema)) dto: ImportMedicinesDto,
  ) {
    return this.catalog.import(dto);
  }

  @Patch(':id')
  @PlatformRoles('super_admin', 'data_entry')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateMedicineSchema)) dto: UpdateMedicineDto,
  ) {
    return this.catalog.update(id, dto);
  }

  @Delete(':id')
  @PlatformRoles('super_admin', 'data_entry')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.catalog.remove(id);
  }
}
