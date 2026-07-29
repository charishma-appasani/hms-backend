import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { AuditService } from '../audit/audit.service';
import { DossierService, hashDossier } from './dossier.service';
import { AI_PROVIDER, type AiProvider } from './ai.types';
import type { Prisma } from '../../generated/prisma/client';

/** One answered ask-this-chart question, as returned to the client. */
export interface ChartQueryResult {
  id: string;
  question: string;
  answer: string;
  foundInRecord: boolean;
  citations: string[];
  modelId: string | null;
  feedback: number | null;
  createdAt: Date;
}

/**
 * Ask-this-chart (roadmap #8, docs/architecture/ai-features.md): natural-language Q&A over ONE
 * patient's record. On-demand and synchronous — the clinician waits — so cost is incurred only
 * when they explicitly ask, and there is no pre-generation or caching (every question differs).
 *
 * Grounding is the same as the summary: the model answers strictly from the deterministic
 * dossier and cites it. Unlike the summary, the dossier INCLUDES the current visit — a mid-
 * consultation question ("what did I just record?") is legitimate.
 *
 * Each answered question is appended to `ai_chart_query` (audit + eval + metrics) and an
 * `audit_log` row records the AI accessing the chart.
 */
@Injectable()
export class ChartQueryService {
  private readonly logger = new Logger(ChartQueryService.name);

  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly dossiers: DossierService,
    private readonly audit: AuditService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  async ask(visitId: string, question: string): Promise<ChartQueryResult> {
    const visit = await this.scoped.db.visit.findFirst({
      where: { id: visitId },
      select: { id: true, patientId: true },
    });
    if (!visit) throw new NotFoundException('Visit not found');

    // Full dossier — patient-level, so NOT excluding the current visit.
    const dossier = await this.dossiers.build(visit.patientId);
    const inputHash = hashDossier(dossier);

    const startedAt = Date.now();
    let result;
    try {
      result = await this.provider.answerChartQuestion(dossier, question);
    } catch (err) {
      this.logger.error(
        `Chart query failed for visit=${visitId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Synchronous, user-facing: surface a real error (the FE shows a toast) rather than a
      // persisted failed row. The audit_log below still records that a question was asked.
      await this.audit
        .record({
          action: 'ai.chart.query',
          entityType: 'ai_chart_query',
          patientId: visit.patientId,
          metadata: { visitId, question, answered: false },
        })
        .catch(() => undefined);
      throw new ServiceUnavailableException(
        'The assistant is unavailable right now. Please try again.',
      );
    }
    const latencyMs = Date.now() - startedAt;

    const row = await this.scoped.db.aiChartQuery.create({
      data: {
        orgId: this.scoped.orgId,
        visitId,
        patientId: visit.patientId,
        question,
        answer: result.answer.answer,
        foundInRecord: result.answer.foundInRecord,
        citations: result.answer.citations as unknown as Prisma.InputJsonValue,
        inputHash,
        modelId: result.usage.modelId,
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
        latencyMs,
      },
    });

    // Ids/counts only — never the question or answer text (PHI) in application logs.
    this.logger.log(
      `Chart query answered: id=${row.id} visit=${visitId} model=${result.usage.modelId} ` +
        `found=${result.answer.foundInRecord} ${latencyMs}ms`,
    );
    await this.audit.record({
      action: 'ai.chart.query',
      entityType: 'ai_chart_query',
      entityId: row.id,
      patientId: visit.patientId,
      metadata: {
        visitId,
        question,
        answered: true,
        foundInRecord: result.answer.foundInRecord,
        modelId: result.usage.modelId,
      },
    });

    return toResult(row);
  }

  /** This patient's recent questions at this org (newest first) — the panel's history. */
  async listForPatient(
    patientId: string,
    limit = 20,
  ): Promise<ChartQueryResult[]> {
    const rows = await this.scoped.db.aiChartQuery.findMany({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toResult);
  }

  async recordFeedback(
    id: string,
    feedback: 1 | -1,
  ): Promise<{ id: string; feedback: number }> {
    const existing = await this.scoped.db.aiChartQuery.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Chart query not found');

    const updated = await this.scoped.db.aiChartQuery.update({
      where: { id },
      data: {
        feedback,
        feedbackBy: this.scoped.actorId,
        feedbackAt: new Date(),
      },
      select: { id: true, feedback: true },
    });
    await this.audit.record({
      action: 'ai.chart.feedback',
      entityType: 'ai_chart_query',
      entityId: id,
      metadata: { feedback },
    });
    return { id: updated.id, feedback: updated.feedback as number };
  }
}

function toResult(row: {
  id: string;
  question: string;
  answer: string;
  foundInRecord: boolean;
  citations: unknown;
  modelId: string | null;
  feedback: number | null;
  createdAt: Date;
}): ChartQueryResult {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    foundInRecord: row.foundInRecord,
    citations: Array.isArray(row.citations) ? (row.citations as string[]) : [],
    modelId: row.modelId,
    feedback: row.feedback,
    createdAt: row.createdAt,
  };
}
