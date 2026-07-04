import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../auth/auth.types';

/** The patient acting for themselves (resolved from the Cognito identity, not an org membership). */
export interface PatientContext {
  patientId: string;
  userId: string;
}

export type PatientRequest = AuthenticatedRequest & {
  patientContext?: PatientContext;
};

/**
 * Gates the patient portal (`/me/*`). Runs after the global JwtAuthGuard (which sets `request.auth`):
 * maps the authenticated `app_user` → their `patient` profile and attaches `request.patientContext`.
 * 403 if the account has no patient profile (e.g. a staff-only user). Patient data crosses orgs, so
 * portal services use the UNSCOPED Prisma client filtered by `patientId` — never the org-scoped one.
 */
@Injectable()
export class PatientContextGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PatientRequest>();
    const userId = request.auth?.user?.id;
    if (!userId) {
      throw new ForbiddenException('Authentication required');
    }

    const patient = await this.prisma.patient.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!patient) {
      throw new ForbiddenException('No patient profile is linked to this account');
    }

    request.patientContext = { patientId: patient.id, userId };
    return true;
  }
}
