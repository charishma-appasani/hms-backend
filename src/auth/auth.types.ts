import type { FastifyRequest } from 'fastify';
import type { AppUser } from '../../generated/prisma/client';

/** Set on the request by JwtAuthGuard after Cognito verification + app_user lookup. */
export interface AuthenticatedUser {
  /** The global app_user row (id, names, platformRole, …). */
  user: AppUser;
  /** Raw Cognito subject from the verified token. */
  cognitoSub: string;
}

export type AuthenticatedRequest = FastifyRequest & {
  auth: AuthenticatedUser;
};
