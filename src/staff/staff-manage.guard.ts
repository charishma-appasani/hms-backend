import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';

/**
 * Authorizes staff mutations (create/update/remove). Permits EITHER:
 *   - an org **admin** (active membership with the admin role at X-Org-Id), or
 *   - a platform **super_admin** acting on the org via an ASSUMED context (set by OrgContextGuard)
 *     — the bootstrap path for onboarding an org's first admin, who has no membership yet.
 *
 * Reads (@Roles ORG_MEMBER) stay member-only; a super_admin assumes only to provision staff.
 * Has no injected deps, so it works as a plain `@UseGuards(StaffManageGuard)` route guard.
 */
@Injectable()
export class StaffManageGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const orgContext = request.orgContext;
    if (!orgContext) {
      throw new ForbiddenException(
        'Organization context required (set the X-Org-Id header)',
      );
    }

    const isOrgAdmin = orgContext.roles.includes('admin');
    const isAssumingSuperAdmin =
      orgContext.assumed &&
      request.auth.user.platformRole === 'super_admin';

    if (!isOrgAdmin && !isAssumingSuperAdmin) {
      throw new ForbiddenException(
        'Requires the org admin role or platform super_admin',
      );
    }
    return true;
  }
}
