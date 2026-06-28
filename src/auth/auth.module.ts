import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CognitoService } from './cognito.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OrgContextGuard } from './org-context.guard';
import { RolesGuard } from './roles.guard';
import { PlatformRoleGuard } from './platform-roles.guard';

/**
 * Registers the global guard chain, in execution order (APP_GUARDs run in registration order):
 *   1. JwtAuthGuard      — verify Cognito JWT → request.auth (skipped by @Public).
 *   2. OrgContextGuard   — X-Org-Id → active membership → request.orgContext.
 *   3. RolesGuard        — enforce @Roles() against org roles.
 *   4. PlatformRoleGuard — enforce @PlatformRoles() against app_user.platform_role.
 * Every route requires a Cognito JWT unless @Public().
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    CognitoService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: OrgContextGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PlatformRoleGuard },
  ],
  exports: [AuthService, CognitoService],
})
export class AuthModule {}
