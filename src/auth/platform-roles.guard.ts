import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformRole } from '../../generated/prisma/client';
import type { AuthenticatedRequest } from './auth.types';
import { PLATFORM_ROLES_KEY } from './platform-roles.decorator';

/**
 * Enforces @PlatformRoles(): the caller's `app_user.platform_role` must be one of the required
 * platform roles. Null platform_role (every customer/patient) is rejected. Routes without
 * @PlatformRoles are unaffected.
 */
@Injectable()
export class PlatformRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PlatformRole[]>(
      PLATFORM_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const platformRole = request.auth?.user.platformRole;
    if (!platformRole || !required.includes(platformRole)) {
      throw new ForbiddenException('Platform operator role required');
    }
    return true;
  }
}
