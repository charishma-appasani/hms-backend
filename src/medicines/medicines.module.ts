import { Module } from '@nestjs/common';
import {
  MedicinesController,
  PlatformMedicinesController,
} from './medicines.controller';
import { MedicinesService } from './medicines.service';

/**
 * Master medicine catalog: org-facing autocomplete search (`GET /medicines`) + platform-operator
 * master-data entry (`/platform/medicines`, data-entry UI is a future page). PrismaModule is global.
 */
@Module({
  controllers: [MedicinesController, PlatformMedicinesController],
  providers: [MedicinesService],
})
export class MedicinesModule {}
