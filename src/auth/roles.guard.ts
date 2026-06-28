import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '../../generated/prisma/client';
import type { AuthenticatedRequest } from './auth.types';
import { ROLES_KEY } from './roles.decorator';

/**
 * Enforces @Roles(): the caller must have an org context (valid X-Org-Id membership, set by
 * OrgContextGuard) AND hold at least one of the required roles at that org. Routes without
 * @Roles are unaffected. Authorization is per-org and per-request — never from JWT claims.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const orgContext = request.orgContext;
    if (!orgContext) {
      throw new ForbiddenException(
        'Organization context required (set the X-Org-Id header)',
      );
    }

    const hasRole = orgContext.roles.some((role) => required.includes(role));
    if (!hasRole) {
      throw new ForbiddenException('Insufficient role for this action');
    }
    return true;
  }
}
