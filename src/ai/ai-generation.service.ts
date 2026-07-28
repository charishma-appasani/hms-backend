import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { AuditService } from '../audit/audit.service';
import { DossierService, hashDossier } from './dossier.service';
import { visitSummarySchema } from './summary.schema';
import {
  AI_PROVIDER,
  type AiProvider,
  type PatientDossier,
  type VisitSummary,
} from './ai.types';
import { Prisma } from '../../generated/prisma/client';

/**
 * A generation already in flight is left alone for this long before another caller will start a
 * second one. Covers the normal race (check-in fires generation; the doctor opens the page a
 * moment later) without deadlocking on a process that died mid-flight.
 */
const IN_FLIGHT_GRACE_MS = 60_000;

/**
 * Minimum age of a READY generation before `force` runs paid inference again. Every regenerate
 * click is a Bedrock call; without this, a doctor hammering the button spends money for an
 * identical answer. Failed generations are exempt — a retry after an outage must work at once.
 */
const REGENERATE_COOLDOWN_MS = 30_000;

/** What the API returns for a visit summary. Facts and narrative are deliberately separate. */
export interface VisitSummaryResponse {
  generationId: string | null;
  status: 'ready' | 'pending' | 'failed';
  /** Deterministic, code-built, always present — the UI renders this as fact. */
  dossier: PatientDossier;
  /** Model-authored narrative. Null while pending or on failure. */
  summary: VisitSummary | null;
  modelId: string | null;
  generatedAt: Date | null;
  latencyMs: number | null;
  feedback: number | null;
  /** Present when status = failed, so the UI can say what went wrong rather than show a blank. */
  error: string | null;
}

/**
 * Orchestrates AI generation: build the dossier, consult the cache, call the provider, persist.
 *
 * BEST-EFFORT by contract, like NotificationService and AuditService — inference failures are
 * recorded as `status = 'failed'` and never propagate. Bedrock being unavailable must not block
 * a check-in or a consultation.
 *
 * See docs/architecture/ai-features.md.
 */
@Injectable()
export class AiGenerationService {
  private readonly logger = new Logger(AiGenerationService.name);

  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly dossiers: DossierService,
    private readonly audit: AuditService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  /**
   * Fire-and-forget pre-generation, called after check-in commits. Swallows everything: the
   * caller has already responded to the client and nothing here may surface as a request error.
   */
  prewarmVisitSummary(visitId: string): void {
    void this.getVisitSummary(visitId).catch((err: unknown) => {
      this.logger.warn(
        `Pre-generation failed for visit=${visitId}: ${errorText(err)}`,
      );
    });
  }

  /**
   * The read path. Returns the cached generation when the record hasn't changed, otherwise
   * generates. `force` regenerates regardless (the "Regenerate" action).
   */
  async getVisitSummary(
    visitId: string,
    options: { force?: boolean } = {},
  ): Promise<VisitSummaryResponse> {
    const visit = await this.scoped.db.visit.findFirst({
      where: { id: visitId },
      select: { id: true, patientId: true },
    });
    if (!visit) throw new NotFoundException('Visit not found');

    // Exclude the visit being summarised — the summary is about prior history, and excluding it
    // keeps the cache stable while the doctor edits today's record (see DossierService.build).
    const dossier = await this.dossiers.build(visit.patientId, {
      excludeVisitId: visit.id,
    });
    const inputHash = hashDossier(dossier);

    const existing = await this.scoped.db.aiGeneration.findFirst({
      where: { visitId, kind: 'visit_summary' },
    });

    if (!options.force && existing) {
      // Cache hit: the record hasn't changed since this summary was written.
      if (existing.status === 'ready' && existing.inputHash === inputHash) {
        return toResponse(existing, dossier);
      }
      // Someone else is already generating this — don't pay for it twice.
      if (
        existing.status === 'pending' &&
        Date.now() - existing.updatedAt.getTime() < IN_FLIGHT_GRACE_MS
      ) {
        return toResponse(existing, dossier);
      }
    }

    // Cooldown on explicit regeneration (READY rows only — failures retry immediately).
    if (
      options.force &&
      existing?.status === 'ready' &&
      Date.now() - existing.updatedAt.getTime() < REGENERATE_COOLDOWN_MS
    ) {
      throw new HttpException(
        'Summary was generated moments ago — try again shortly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return this.generate(visit.id, visit.patientId, dossier, inputHash, existing?.id);
  }

  /** Record a doctor's thumbs up/down. This is the evaluation signal — see the doc. */
  async recordFeedback(
    generationId: string,
    feedback: 1 | -1,
  ): Promise<{ id: string; feedback: number }> {
    const row = await this.scoped.db.aiGeneration.findFirst({
      where: { id: generationId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('AI generation not found');

    const updated = await this.scoped.db.aiGeneration.update({
      where: { id: generationId },
      data: {
        feedback,
        feedbackBy: this.scoped.actorId,
        feedbackAt: new Date(),
      },
      select: { id: true, feedback: true },
    });
    await this.audit.record({
      action: 'ai.summary.feedback',
      entityType: 'ai_generation',
      entityId: generationId,
      metadata: { feedback },
    });
    return { id: updated.id, feedback: updated.feedback as number };
  }

  /**
   * Claim the row as pending, call the provider, persist the outcome. A failure is stored and
   * returned as `status: 'failed'` rather than thrown — the consultation page must still load.
   */
  private async generate(
    visitId: string,
    patientId: string,
    dossier: PatientDossier,
    inputHash: string,
    existingId?: string,
  ): Promise<VisitSummaryResponse> {
    const claim = {
      status: 'pending' as const,
      inputHash,
      inputSnapshot: dossier as unknown as Prisma.InputJsonObject,
      // Prisma.DbNull (not `null`) is how a nullable Json column is set to SQL NULL — clears any
      // previous output when a regeneration re-claims the row.
      output: Prisma.DbNull,
      error: null,
      modelId: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
    };
    const row = existingId
      ? await this.scoped.db.aiGeneration.update({
          where: { id: existingId },
          data: claim,
        })
      : await this.scoped.db.aiGeneration.create({
          data: {
            orgId: this.scoped.orgId,
            kind: 'visit_summary',
            visitId,
            patientId,
            ...claim,
          },
        });

    const startedAt = Date.now();
    try {
      // A patient with an empty record needs no model — inference on a thin dossier is pure
      // cost for a sentence code can write. In Indian OPD a large share of check-ins are first
      // visits, so this skip removes a sizeable fraction of all paid calls.
      const result = isThinDossier(dossier)
        ? {
            summary: newPatientSummary(dossier),
            usage: { modelId: 'deterministic' },
          }
        : await this.provider.summariseVisit(dossier);
      const latencyMs = Date.now() - startedAt;
      const updated = await this.scoped.db.aiGeneration.update({
        where: { id: row.id },
        data: {
          status: 'ready',
          output: result.summary as unknown as Prisma.InputJsonObject,
          modelId: result.usage.modelId,
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
          latencyMs,
        },
      });
      // Ids, counts and latency only — never dossier or output content (that is PHI).
      this.logger.log(
        `AI summary ready: generation=${row.id} visit=${visitId} model=${result.usage.modelId} ` +
          `tokens=${result.usage.inputTokens ?? '?'}/${result.usage.outputTokens ?? '?'} ${latencyMs}ms`,
      );
      await this.audit.record({
        action: 'ai.summary.generate',
        entityType: 'ai_generation',
        entityId: row.id,
        patientId,
        metadata: {
          visitId,
          modelId: result.usage.modelId,
          regenerated: Boolean(existingId),
          latencyMs,
        },
      });
      return toResponse(updated, dossier);
    } catch (err) {
      const message = errorText(err);
      this.logger.error(
        `AI summary failed: generation=${row.id} visit=${visitId}: ${message}`,
      );
      const failed = await this.scoped.db.aiGeneration
        .update({
          where: { id: row.id },
          data: {
            status: 'failed',
            error: message.slice(0, 500),
            latencyMs: Date.now() - startedAt,
          },
        })
        .catch(() => null);
      return failed
        ? toResponse(failed, dossier)
        : {
            generationId: row.id,
            status: 'failed',
            dossier,
            summary: null,
            modelId: null,
            generatedAt: null,
            latencyMs: null,
            feedback: null,
            error: message,
          };
    }
  }
}

/**
 * Map a persisted row to the API shape. `output` is re-validated on the way out: it was written
 * by a previous process (possibly an older prompt/schema), so it is treated as untrusted here
 * too — a row that no longer parses degrades to facts-only rather than breaking the page.
 */
function toResponse(
  row: {
    id: string;
    status: string;
    output: unknown;
    modelId: string | null;
    latencyMs: number | null;
    feedback: number | null;
    error: string | null;
    updatedAt: Date;
  },
  dossier: PatientDossier,
): VisitSummaryResponse {
  const parsed =
    row.status === 'ready' ? visitSummarySchema.safeParse(row.output) : null;
  return {
    generationId: row.id,
    status: row.status as 'ready' | 'pending' | 'failed',
    dossier,
    summary: parsed?.success ? parsed.data : null,
    modelId: row.modelId,
    generatedAt: row.status === 'ready' ? row.updatedAt : null,
    latencyMs: row.latencyMs,
    feedback: row.feedback,
    error: row.error,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Nothing to summarise: no prior visits at this org and no recorded conditions or allergies.
 * (Conditions/allergies alone still warrant inference — "known diabetic, first visit here" is
 * exactly the orientation the narrative exists for.)
 */
function isThinDossier(dossier: PatientDossier): boolean {
  return (
    dossier.visits.length === 0 &&
    dossier.conditions.length === 0 &&
    dossier.allergies.length === 0
  );
}

/** Deterministic stand-in for a thin dossier — must satisfy `visitSummarySchema`. */
function newPatientSummary(dossier: PatientDossier): VisitSummary {
  return {
    summary:
      `${dossier.patient.name} has no prior visits at this organisation and no recorded ` +
      'conditions or allergies. There is no history to summarise yet.',
    highlights: [],
    watchOuts: [],
    openThreads: [],
  };
}
