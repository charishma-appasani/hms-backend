import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiController } from './ai.controller';
import { AiGenerationService } from './ai-generation.service';
import { PrescriptionSafetyService } from './prescription-safety.service';
import { ChartQueryService } from './chart-query.service';
import { PatientSummaryService } from './patient-summary.service';
import { DossierService } from './dossier.service';
import { BedrockAiProvider } from './bedrock.provider';
import { StubAiProvider } from './stub.provider';
import { AI_PROVIDER, type AiProvider } from './ai.types';
import type { Env } from '../config/env.schema';

/**
 * AI-assist features (see docs/architecture/ai-features.md).
 *
 * `AI_PROVIDER` resolves to real Bedrock inference when AI_ENABLED=true, otherwise to the
 * deterministic offline stub — the same shape as NotificationModule's channel selection, so
 * local dev and CI never call AWS. Only the enabled branch is constructed: BedrockAiProvider
 * requires AI_SUMMARY_MODEL_ID at construction, which is absent when AI is off.
 *
 * Exports AiGenerationService so VisitsModule can pre-generate the summary at check-in.
 */
@Module({
  controllers: [AiController],
  providers: [
    DossierService,
    AiGenerationService,
    PrescriptionSafetyService,
    ChartQueryService,
    PatientSummaryService,
    {
      provide: AI_PROVIDER,
      useFactory: (config: ConfigService<Env, true>): AiProvider =>
        config.get('AI_ENABLED', { infer: true })
          ? new BedrockAiProvider(config)
          : new StubAiProvider(),
      inject: [ConfigService],
    },
  ],
  // Exported so VisitsModule can pre-generate at check-in, safety-check on add-prescription, and
  // generate the patient summary on completion.
  exports: [AiGenerationService, PrescriptionSafetyService, PatientSummaryService],
})
export class AiModule {}
