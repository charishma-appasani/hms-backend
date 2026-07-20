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
import {
  createMedicineSchema,
  searchMedicinesSchema,
  updateMedicineSchema,
  type CreateMedicineDto,
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
 * Platform master-data entry (super_admin). A data-entry UI is a future page — until then these
 * work via curl/import scripts. No org context on /platform/*.
 */
@Controller('platform/medicines')
export class PlatformMedicinesController {
  constructor(private readonly medicines: MedicinesService) {}

  @Post()
  @PlatformRoles('super_admin')
  create(
    @Body(new ZodValidationPipe(createMedicineSchema)) dto: CreateMedicineDto,
  ) {
    return this.medicines.create(dto);
  }

  @Patch(':id')
  @PlatformRoles('super_admin')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateMedicineSchema)) dto: UpdateMedicineDto,
  ) {
    return this.medicines.update(id, dto);
  }

  @Delete(':id')
  @PlatformRoles('super_admin')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.medicines.remove(id);
  }
}
