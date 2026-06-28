import { Inject, Injectable, Logger, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../auth/auth.types';
import type { Prisma } from '../../generated/prisma/client';

/** One audit entry. Actor/org/IP/user-agent are filled from the request automatically. */
export interface AuditEntry {
  /** Dotted verb, e.g. 'patient.update', 'appointment.cancel'. */
  action: string;
  /** The kind of thing acted on, e.g. 'patient', 'appointment'. */
  entityType: string;
  /** The acted-on row's id (when there is one). */
  entityId?: string;
  /** The patient this action concerns, for the patient-history index (when applicable). */
  patientId?: string;
  /** Action-specific detail — typically a before/after diff (see {@link diffFields}). */
  metadata?: Record<string, unknown>;
  /** Override the org attribution (defaults to the request's org context; null for platform ops). */
  orgId?: string;
}

/** A fully-attributed audit row (caller supplies actor/org/IP/ua). */
export interface AuditRecordInput extends AuditEntry {
  actorUserId?: string;
  ip?: string;
  userAgent?: string;
}

const auditLogger = new Logger('AuditLog');

/**
 * Best-effort insert of one `audit_log` row through the UNSCOPED client. A failed insert is
 * logged and SWALLOWED — an audit hiccup must never throw or roll back the action it records.
 * Shared by {@link AuditService} (request-scoped, the usual entry point) and the few singleton
 * call sites that can't inject it (e.g. OrgContextGuard logging an org-assume).
 */
export async function writeAuditLog(
  prisma: PrismaService,
  input: AuditRecordInput,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        patientId: input.patientId,
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        ip: input.ip,
        userAgent: input.userAgent,
      },
    });
  } catch (err) {
    auditLogger.error(
      `Failed to write audit_log entry '${input.action}'`,
      err instanceof Error ? err.stack : String(err),
    );
  }
}

/** Extract the request's user-agent header (it may be a string or string[]). */
export function userAgentOf(request: { headers: Record<string, unknown> }): string | undefined {
  const ua = request.headers['user-agent'];
  return Array.isArray(ua) ? (ua[0] as string) : (ua as string | undefined);
}

/**
 * Append-only audit trail writer (`audit_log`). REQUEST-scoped so it can attribute every entry to
 * the acting user + org + request IP/user-agent without each call site passing them. See
 * {@link writeAuditLog} for the best-effort / never-throws contract. Call `record` AFTER the action
 * succeeds, so the log reflects real changes. Actions taken under an ASSUMED org context (a platform
 * super_admin acting on an org they don't belong to) are auto-tagged `metadata.assumed = true`.
 */
@Injectable({ scope: Scope.REQUEST })
export class AuditService {
  constructor(
    @Inject(REQUEST) private readonly request: AuthenticatedRequest,
    private readonly prisma: PrismaService,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const assumed = this.request.orgContext?.assumed === true;
    await writeAuditLog(this.prisma, {
      ...entry,
      metadata: assumed ? { ...entry.metadata, assumed: true } : entry.metadata,
      orgId: entry.orgId ?? this.request.orgContext?.orgId,
      actorUserId: this.request.auth?.user?.id,
      ip: this.request.ip,
      userAgent: userAgentOf(this.request),
    });
  }
}

/**
 * Build a `{ field: { from, to } }` map of the fields that actually changed. `after` holds the
 * proposed values (e.g. a DTO); only keys present in `after` AND different from `before` appear.
 * Use as audit metadata so the trail records exactly what changed and from what.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(after)) {
    if (next === undefined) continue; // not being set
    if (before[key] !== next) changes[key] = { from: before[key] ?? null, to: next };
  }
  return changes;
}
