import { ForbiddenException } from '@nestjs/common';
import type { OrgContext } from '../auth/auth.types';

/**
 * Schedule writes (availability templates + blocks) are allowed for org admins on ANY provider,
 * and for doctors on THEIR OWN schedule only (`ctx.staffId` is the caller's staff row — the same
 * id scheduling uses as `provider_id`). Other roles never reach this check (@Roles rejects them),
 * as does an assumed super_admin (empty roles).
 */
export function assertCanManageProviderSchedule(
  ctx: OrgContext,
  providerId: string,
): void {
  if (ctx.roles.includes('admin')) return;
  if (ctx.roles.includes('doctor') && ctx.staffId === providerId) return;
  throw new ForbiddenException('Doctors can only manage their own schedule');
}
