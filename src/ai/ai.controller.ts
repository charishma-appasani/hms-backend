import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AiGenerationService } from './ai-generation.service';
import { PrescriptionSafetyService } from './prescription-safety.service';
import { ChartQueryService } from './chart-query.service';
import {
  aiFeedbackSchema,
  chartAskSchema,
  prescriptionCheckSchema,
  type AiFeedbackDto,
  type ChartAskDto,
  type PrescriptionCheckDto,
} from './dto/ai.dto';

// Who may see an AI patient summary. Same set that records the clinical note — this is
// consultation-support, not front-desk information.
const CLINICAL = ['admin', 'doctor', 'doctor_assistant', 'nurse'] as const;

/**
 * AI-assist endpoints (see docs/architecture/ai-features.md). Reads are cheap and cached: the
 * summary is normally generated at check-in, so by the time the doctor opens the consultation
 * the row is already `ready`.
 */
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiGenerationService,
    private readonly safety: PrescriptionSafetyService,
    private readonly chart: ChartQueryService,
  ) {}

  /**
   * Deterministic allergy + duplicate-therapy check for a candidate drug (NO model, no cost —
   * see prescription-safety.ts). The consultation form calls this as the doctor types, so the
   * warning appears BEFORE the line is added. Warns, never blocks.
   */
  @Post('prescription-check')
  @Roles(...CLINICAL)
  async checkPrescription(
    @Body(new ZodValidationPipe(prescriptionCheckSchema))
    dto: PrescriptionCheckDto,
  ) {
    return {
      warnings: await this.safety.checkForVisit(dto.visitId, dto.drug),
    };
  }

  /** The visit-start patient summary: deterministic dossier + model narrative. */
  @Get('visits/:visitId/summary')
  @Roles(...CLINICAL)
  getVisitSummary(@Param('visitId', ParseUUIDPipe) visitId: string) {
    return this.ai.getVisitSummary(visitId);
  }

  /** Force a fresh generation, ignoring the cache. */
  @Post('visits/:visitId/summary/regenerate')
  @Roles(...CLINICAL)
  regenerateVisitSummary(@Param('visitId', ParseUUIDPipe) visitId: string) {
    return this.ai.getVisitSummary(visitId, { force: true });
  }

  @Post('generations/:id/feedback')
  @Roles(...CLINICAL)
  recordFeedback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(aiFeedbackSchema)) dto: AiFeedbackDto,
  ) {
    return this.ai.recordFeedback(id, dto.feedback);
  }

  // ── ask-this-chart (natural-language Q&A over one patient's record) ──

  /** Ask a grounded question about the patient. On-demand model call — costs only when used. */
  @Post('visits/:visitId/ask')
  @Roles(...CLINICAL)
  ask(
    @Param('visitId', ParseUUIDPipe) visitId: string,
    @Body(new ZodValidationPipe(chartAskSchema)) dto: ChartAskDto,
  ) {
    return this.chart.ask(visitId, dto.question);
  }

  /** This patient's recent questions (the ask panel's history). */
  @Get('patients/:patientId/chart-queries')
  @Roles(...CLINICAL)
  chartHistory(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.chart.listForPatient(patientId);
  }

  @Post('chart-queries/:id/feedback')
  @Roles(...CLINICAL)
  chartFeedback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(aiFeedbackSchema)) dto: AiFeedbackDto,
  ) {
    return this.chart.recordFeedback(id, dto.feedback);
  }
}
