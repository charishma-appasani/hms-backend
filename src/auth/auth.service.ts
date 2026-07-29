import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ImagesService } from '../images/images.service';
import { formatDateOnly } from '../common/datetime';
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
    /** YYYY-MM-DD; the patient-profile activation dialog only asks for what's missing here. */
    dateOfBirth: string | null;
    gender: string | null;
    platformRole: string | null;
    /** Presigned avatar URL, or null when they have no photo (see images.md). */
    imageUrl: string | null;
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
    /** Org logo (CDN URL) — the staff shell header brands itself with this. */
    orgLogoUrl: string | null;
  }>;
  hasPatientProfile: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImagesService,
  ) {}

  async getMe(auth: AuthenticatedUser): Promise<MeResponse> {
    const { user } = auth;

    const [memberships, patient] = await Promise.all([
      this.prisma.staff.findMany({
        where: { userId: user.id, deletedAt: null },
        include: {
          org: {
            select: {
              id: true,
              name: true,
              approvedAt: true,
              imageUpdatedAt: true,
            },
          },
        },
      }),
      this.prisma.patient.findUnique({
        where: { userId: user.id },
        select: { id: true },
      }),
    ]);

    const [avatarUrl, logoUrls] = await Promise.all([
      this.images.urlFor('user', user.id, user.imageUpdatedAt),
      Promise.all(
        memberships.map((m) =>
          this.images.urlFor('org', m.org.id, m.org.imageUpdatedAt),
        ),
      ),
    ]);

    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        dateOfBirth: user.dateOfBirth ? formatDateOnly(user.dateOfBirth) : null,
        gender: user.gender,
        platformRole: user.platformRole,
        imageUrl: avatarUrl,
      },
      memberships: memberships.map((m, i) => ({
        orgId: m.org.id,
        orgName: m.org.name,
        staffId: m.id,
        roles: m.roles,
        status: m.status,
        orgApproved: m.org.approvedAt !== null,
        orgLogoUrl: logoUrls[i],
      })),
      hasPatientProfile: patient !== null,
    };
  }
}
