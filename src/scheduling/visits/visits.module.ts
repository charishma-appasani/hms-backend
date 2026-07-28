import { Module } from '@nestjs/common';
import { VisitsController } from './visits.controller';
import { VisitsService } from './visits.service';
import { AiModule } from '../../ai/ai.module';

/** Visits / check-in: appointment → visit episode, OP queue, clinical lifecycle. */
@Module({
  // AiModule provides AiGenerationService, used to pre-generate the patient summary at check-in
  // so it is already waiting when the doctor opens the consultation. Not circular — the AI layer
  // reads visits through Prisma, never through VisitsService.
  imports: [AiModule],
  controllers: [VisitsController],
  providers: [VisitsService],
  exports: [VisitsService],
})
export class VisitsModule {}
