import { SetMetadata } from '@nestjs/common';
import type { PlatformRole } from '../../generated/prisma/client';

export const PLATFORM_ROLES_KEY = 'platformRoles';

/**
 * Restricts a route to Polaris platform operators (our own employees) holding one of the given
 * platform roles (super_admin/support). Enforced by PlatformRoleGuard against
 * `app_user.platform_role`. Used by the `/platform/*` namespace (org onboarding, the one
 * legitimate global user search). Orthogonal to @Roles — platform role ≠ org role.
 *
 * @example @PlatformRoles('super_admin')
 */
export const PlatformRoles = (...roles: PlatformRole[]) =>
  SetMetadata(PLATFORM_ROLES_KEY, roles);
