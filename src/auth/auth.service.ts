import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from './auth.types';

/**
 * Shape returned by GET /auth/me — everything the UI needs at session start: who the user
 * is, every org membership with roles (drives the org/practice picker + RBAC on the client),
 * whether they have a patient profile, and any platform role. Roles deliberately come from
 * here (fresh, per request) rather than JWT claims.
 */
export interface MeResponse {
  user: {
    id: string;
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    platformRole: string | null;
  };
  memberships: Array<{
    orgId: string;
    orgName: string;
    /** The caller's staff row id at this org — scheduling's provider id when they are a doctor. */
    staffId: string;
    roles: string[];
    status: string;
    /** False while a self-signed-up org awaits platform approval (not patient-visible yet). */
    orgApproved: boolean;
  }>;
  hasPatientProfile: boolean;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(auth: AuthenticatedUser): Promise<MeResponse> {
    const { user } = auth;

    const [memberships, patient] = await Promise.all([
      this.prisma.staff.findMany({
        where: { userId: user.id, deletedAt: null },
        include: { org: { select: { id: true, name: true, approvedAt: true } } },
      }),
      this.prisma.patient.findUnique({
        where: { userId: user.id },
        select: { id: true },
      }),
    ]);

    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        platformRole: user.platformRole,
      },
      memberships: memberships.map((m) => ({
        orgId: m.org.id,
        orgName: m.org.name,
        staffId: m.id,
        roles: m.roles,
        status: m.status,
        orgApproved: m.org.approvedAt !== null,
      })),
      hasPatientProfile: patient !== null,
    };
  }
}
