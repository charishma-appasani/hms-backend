import type { FastifyRequest } from 'fastify';
import type { AppUser, UserRole } from '../../generated/prisma/client';

/** Set on the request by JwtAuthGuard after Cognito verification + app_user lookup. */
export interface AuthenticatedUser {
  /** The global app_user row (id, names, platformRole, …). */
  user: AppUser;
  /** Raw Cognito subject from the verified token. */
  cognitoSub: string;
}

/**
 * The caller's tenant context for ONE request, resolved by OrgContextGuard from the
 * `X-Org-Id` header against the caller's active `staff` membership. Roles are read fresh
 * from the DB per request (never from the JWT) and drive @Roles RBAC + org scoping.
 */
export interface OrgContext {
  /** The organization the caller is acting within (from X-Org-Id, membership-verified). */
  orgId: string;
  /**
   * The caller's staff row id at this org (the clinician/actor id used by scheduling). `null`
   * when `assumed` — a platform super_admin acting on an org they are not a member of.
   */
  staffId: string | null;
  /** The caller's roles at THIS org (admin/doctor/front_desk/nurse). Empty when `assumed`. */
  roles: UserRole[];
  /**
   * True when a platform super_admin is acting on an org WITHOUT a membership (e.g. onboarding
   * the first admin). Carries no roles, so @Roles routes still reject it — only guards that
   * explicitly honor `assumed` (e.g. StaffManageGuard) permit the action, and it is auditable.
   */
  assumed: boolean;
}

export type AuthenticatedRequest = FastifyRequest & {
  auth: AuthenticatedUser;
  /** Present only after OrgContextGuard resolves a valid membership for X-Org-Id. */
  orgContext?: OrgContext;
};
