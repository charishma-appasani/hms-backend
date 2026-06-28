import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import type { AuthenticatedRequest, OrgContext } from './auth.types';

/**
 * Injects the resolved {@link OrgContext} (set by OrgContextGuard) into a handler parameter.
 * Throws 403 if no org context was resolved — pair it with `@Roles()` (or otherwise require
 * the `X-Org-Id` header) so org-scoped handlers always receive a verified membership.
 */
export const CurrentOrg = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OrgContext => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.orgContext) {
      throw new ForbiddenException(
        'Organization context required (set the X-Org-Id header)',
      );
    }
    return request.orgContext;
  },
);
