import { Inject, Injectable, Logger } from '@nestjs/common';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { hashJson } from './dossier.service';
import {
  AI_PROVIDER,
  type AiProvider,
  type PatientVisitInput,
} from './ai.types';
import { Prisma } from '../../generated/prisma/client';

/**
 * Patient-facing after-visit summary (roadmap #6, docs/architecture/ai-features.md). Generated
 * when a visit is COMPLETED — one small model call per completed visit (far lower volume than the
 * doctor summary, which runs per check-in) — then shown to the patient in the portal, with a
 * best-effort notification pointing them to it.
 *
 * Stored in `ai_generation` with kind `patient_summary` (one per visit, overwrite-in-place). This
 * service only WRITES (in the org/staff context of the completing visit); the patient READS it
 * unscoped through the patient portal (they own their record). BEST-EFFORT throughout — a failure
 * never blocks visit completion.
 */
@Injectable()
export class PatientSummaryService {
  private readonly logger = new Logger(PatientSummaryService.name);

  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  /**
   * Fire-and-forget, called after the completion transaction commits. Swallows everything — the
   * visit is already completed and nothing here may surface as a request error.
   */
  prewarm(visitId: string): void {
    void this.generate(visitId).catch((err: unknown) => {
      this.logger.warn(
        `Patient summary generation failed for visit=${visitId}: ${errorText(err)}`,
      );
    });
  }

  private async generate(visitId: string): Promise<void> {
    const visit = await this.scoped.db.visit.findFirst({
      where: { id: visitId },
      include: {
        practice: { select: { org: { select: { name: true } } } },
        patient: { select: { user: { select: { firstName: true, email: true, phone: true } } } },
        prescriptions: { orderBy: { createdAt: 'asc' } },
        testOrders: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!visit) return;

    const input: PatientVisitInput = {
      patientFirstName: visit.patient.user.firstName,
      orgName: visit.practice.org.name,
      date: visit.checkInAt.toISOString().slice(0, 10),
      diagnosis: clean(visit.diagnosis),
      symptoms: clean(visit.symptoms),
      notes: clean(visit.notes),
      medications: visit.prescriptions.map((p) => ({
        drug: p.drug,
        dosage: p.dosage,
        frequency: p.frequency,
        duration: p.duration,
        instructions: p.instructions,
      })),
      tests: visit.testOrders.map((t) => ({ name: t.name, instructions: t.instructions })),
    };
    const inputHash = hashJson(input);

    const existing = await this.scoped.db.aiGeneration.findFirst({
      where: { visitId, kind: 'patient_summary' },
      select: { id: true, status: true, inputHash: true },
    });
    // Idempotent: a completed row for the same record needs no second call.
    if (existing?.status === 'ready' && existing.inputHash === inputHash) return;

    const claim = {
      status: 'pending' as const,
      inputHash,
      inputSnapshot: input as unknown as Prisma.InputJsonObject,
      output: Prisma.DbNull,
      error: null,
      modelId: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
    };
    const row = existing
      ? await this.scoped.db.aiGeneration.update({ where: { id: existing.id }, data: claim })
      : await this.scoped.db.aiGeneration.create({
          data: {
            orgId: this.scoped.orgId,
            kind: 'patient_summary',
            visitId,
            patientId: visit.patientId,
            ...claim,
          },
        });

    const startedAt = Date.now();
    try {
      const result = await this.provider.summariseVisitForPatient(input);
      const latencyMs = Date.now() - startedAt;
      await this.scoped.db.aiGeneration.update({
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
      this.logger.log(
        `Patient summary ready: generation=${row.id} visit=${visitId} model=${result.usage.modelId} ${latencyMs}ms`,
      );
      await this.audit.record({
        action: 'ai.patient_summary.generate',
        entityType: 'ai_generation',
        entityId: row.id,
        patientId: visit.patientId,
        metadata: { visitId, modelId: result.usage.modelId, latencyMs },
      });
      // Best-effort nudge — a POINTER to the portal, not the clinical detail (minimal PHI over
      // email/SMS; the plain-language summary lives in the authenticated portal).
      await this.notify(
        {
          name: visit.patient.user.firstName,
          email: visit.patient.user.email,
          phone: visit.patient.user.phone,
        },
        visit.practice.org.name,
      );
    } catch (err) {
      const message = errorText(err);
      this.logger.error(
        `Patient summary failed: generation=${row.id} visit=${visitId}: ${message}`,
      );
      await this.scoped.db.aiGeneration
        .update({
          where: { id: row.id },
          data: { status: 'failed', error: message.slice(0, 500), latencyMs: Date.now() - startedAt },
        })
        .catch(() => undefined);
    }
  }

  private async notify(
    recipient: { name: string; email: string | null; phone: string | null },
    orgName: string,
  ): Promise<void> {
    try {
      await this.notifications.dispatch(recipient, {
        subject: `Your visit summary from ${orgName}`,
        body:
          `Dear ${recipient.name},\n\n` +
          `A summary of your recent visit at ${orgName} is ready. ` +
          'Please sign in to your patient portal to read it.\n\n' +
          'This message is a reminder only and does not contain your medical details.',
      });
    } catch (err) {
      // dispatch is already best-effort per channel; guard the whole call too.
      this.logger.warn(`Patient summary notification failed: ${errorText(err)}`);
    }
  }
}

/** Trim to null so empty strings don't look like recorded content to the model. */
function clean(text: string | null): string | null {
  const t = text?.trim();
  return t ? t : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
