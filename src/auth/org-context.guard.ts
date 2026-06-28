import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { writeAuditLog, userAgentOf } from '../audit/audit.service';
import type { AuthenticatedRequest } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';

/** Header carrying the organization the caller is acting within for this request. */
export const ORG_ID_HEADER = 'x-org-id';

/** HTTP methods that change state — the ones worth auditing an org-assume for. */
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Global guard (runs after JwtAuthGuard): if the request carries an `X-Org-Id` header, it
 * resolves the caller's ACTIVE `staff` membership at that org and attaches it as
 * `request.orgContext` (orgId + staffId + roles read fresh from the DB). A present-but-invalid
 * org (no active membership) is a 403 — you cannot act inside an org you don't belong to.
 *
 * It does NOT require the header on its own: routes that need an org are enforced by
 * `@Roles()` (via RolesGuard) or by reading `@CurrentOrg()`. Platform routes (`@PlatformRoles`)
 * operate on the platform namespace and carry no org context.
 */
@Injectable()
export class OrgContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const orgId = this.extractOrgId(request);
    if (!orgId) return true; // No org context this request; RolesGuard rejects org-scoped routes.

    const staff = await this.prisma.staff.findFirst({
      where: {
        orgId,
        userId: request.auth.user.id,
        deletedAt: null,
        status: 'active',
      },
      select: { id: true, roles: true },
    });
    if (!staff) {
      // A platform super_admin may act on an org they don't belong to (e.g. onboarding its first
      // admin). Grant an ASSUMED context with NO roles: @Roles routes still reject it; only guards
      // that explicitly honor `assumed` (e.g. StaffManageGuard) allow the action.
      if (request.auth.user.platformRole === 'super_admin') {
        const org = await this.prisma.organization.findFirst({
          where: { id: orgId, deletedAt: null },
          select: { id: true },
        });
        if (!org) throw new NotFoundException('Organization not found');
        request.orgContext = { orgId, staffId: null, roles: [], assumed: true };
        await this.recordAssume(request, orgId);
        return true;
      }
      throw new ForbiddenException(
        'No active membership for this organization',
      );
    }

    request.orgContext = {
      orgId,
      staffId: staff.id,
      roles: staff.roles,
      assumed: false,
    };
    return true;
  }

  private extractOrgId(request: AuthenticatedRequest): string | undefined {
    const raw = request.headers[ORG_ID_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value?.trim() || undefined;
  }

  /**
   * Audit a platform super_admin acting on an org they don't belong to. Only mutating requests are
   * logged — assumed reads carry no roles and are rejected by RolesGuard anyway, so they'd be noise.
   * Best-effort (writeAuditLog never throws); the assumed action's own entry is additionally tagged
   * `assumed: true` by AuditService.
   */
  private async recordAssume(
    request: AuthenticatedRequest,
    orgId: string,
  ): Promise<void> {
    if (!MUTATION_METHODS.has(request.method)) return;
    await writeAuditLog(this.prisma, {
      action: 'org.assume',
      entityType: 'organization',
      entityId: orgId,
      orgId,
      actorUserId: request.auth.user.id,
      metadata: { method: request.method, path: request.url },
      ip: request.ip,
      userAgent: userAgentOf(request),
    });
  }
}
