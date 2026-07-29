import { Module } from '@nestjs/common';
import {
  MedicinesController,
  PlatformMedicinesController,
} from './medicines.controller';
import { MedicinesService } from './medicines.service';
import { MedicineCatalogService } from './medicine-catalog.service';

/**
 * Master medicine catalog: org-facing autocomplete search (`GET /medicines`) + the platform
 * data-entry console (`/platform/medicines`: browse, CRUD, CSV import). PrismaModule is global.
 */
@Module({
  controllers: [MedicinesController, PlatformMedicinesController],
  providers: [MedicinesService, MedicineCatalogService],
})
export class MedicinesModule {}
