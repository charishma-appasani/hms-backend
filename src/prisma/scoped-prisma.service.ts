import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { PrismaService } from './prisma.service';
import { buildScopedClient, type ScopedPrismaClient } from './scoped-client';
import type { AuthenticatedRequest } from '../auth/auth.types';

/**
 * REQUEST-scoped tenant data accessor. Resolves the caller's {@link OrgContext} (set by
 * OrgContextGuard) and exposes `db` — a Prisma client pre-bound to this request's orgId + actor
 * that auto-applies org scoping, soft-delete filtering, and audit stamping (see scoped-client.ts).
 *
 * Inject this in feature services for org-scoped routes; write plain Prisma queries against `db`.
 * Routes that reach here are gated by `@Roles()` (→ RolesGuard requires an org context), so a
 * missing context is a programming error, surfaced loudly rather than silently unscoped.
 *
 * For global/platform data (app_user, organization onboarding, audit_log writes) inject the
 * unscoped `PrismaService` directly instead.
 */
@Injectable({ scope: Scope.REQUEST })
export class ScopedPrismaService {
  private cached?: ScopedPrismaClient;

  constructor(
    @Inject(REQUEST) private readonly request: AuthenticatedRequest,
    private readonly prisma: PrismaService,
  ) {}

  /** Tenant-scoped Prisma client for the current request (built once, then memoised). */
  get db(): ScopedPrismaClient {
    if (this.cached) return this.cached;

    const orgContext = this.request.orgContext;
    if (!orgContext) {
      throw new Error(
        'ScopedPrismaService used without an org context. The route must be org-scoped ' +
          '(@Roles / a resolved X-Org-Id); use the unscoped PrismaService for platform data.',
      );
    }

    this.cached = buildScopedClient(this.prisma, {
      orgId: orgContext.orgId,
      actorId: this.request.auth.user.id,
    });
    return this.cached;
  }

  /** The org this request is scoped to (convenience for explicit cross-entity queries). */
  get orgId(): string {
    const orgContext = this.request.orgContext;
    if (!orgContext) {
      throw new Error('ScopedPrismaService.orgId used without an org context.');
    }
    return orgContext.orgId;
  }

  /**
   * The acting user's app_user.id (the same value stamped into created_by/updated_by). Use when a
   * service must attribute writes to GLOBAL tables the scoped client doesn't stamp (e.g. creating
   * an app_user → updated_by_user).
   */
  get actorId(): string {
    return this.request.auth.user.id;
  }
}
