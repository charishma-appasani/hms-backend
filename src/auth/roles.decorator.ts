import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../generated/prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to callers who hold at least one of the given org roles at the org named
 * by `X-Org-Id`. Enforced by RolesGuard against `request.orgContext.roles` (resolved by
 * OrgContextGuard). Implies org context: a route with @Roles requires a valid X-Org-Id.
 *
 * @example @Roles('admin', 'front_desk')
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
