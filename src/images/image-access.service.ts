import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Scope,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import type { UserRole } from '../../generated/prisma/client';
import type { AuthenticatedRequest } from '../auth/auth.types';
import type { ImageTarget } from './image-targets';

/** Org roles that may set a patient's picture — the same set that may edit the patient record. */
const PATIENT_EDITORS: readonly UserRole[] = ['admin', 'front_desk', 'nurse'];

/**
 * Who may change or delete a given entity's picture. Deny-by-default: every target has an explicit
 * rule and an unknown one throws.
 *
 * These checks guard the image ENDPOINTS. Reading is not checked here — image URLs are only ever
 * embedded in an entity payload that was already authorized (an org-scoped list, the patient's own
 * profile), so the surrounding route's `@Roles` + tenant scoping is the read gate. There is
 * deliberately no "fetch any image by id" endpoint to bypass that.
 *
 * Request-scoped: the acting org comes from this request's `X-Org-Id` context, never from a
 * parameter, so a caller cannot claim an org they aren't in.
 */
@Injectable({ scope: Scope.REQUEST })
export class ImageAccessService {
  constructor(
    @Inject(REQUEST) private readonly request: AuthenticatedRequest,
    private readonly prisma: PrismaService,
  ) {}

  /** Throws unless the caller may upload/replace/delete this entity's picture. */
  async assertCanWrite(target: ImageTarget, id: string): Promise<void> {
    switch (target) {
      case 'org':
        return this.assertOrgAdmin(id);
      case 'practice':
        return this.assertPracticeAdmin(id);
      case 'medicine':
        return this.assertCatalogCurator();
      case 'user':
        return this.assertCanManageUser(id);
      case 'patient-id-card':
        return this.assertCanManagePatient(id);
    }
  }

  /** The org's own admins, or a platform super_admin acting above tenants. */
  private assertOrgAdmin(orgId: string): void {
    if (this.platformRole === 'super_admin') return;
    const org = this.orgContext;
    if (org?.orgId === orgId && org.roles.includes('admin')) return;
    throw new ForbiddenException(
      'Only an organization admin can change its logo',
    );
  }

  private async assertPracticeAdmin(practiceId: string): Promise<void> {
    const practice = await this.prisma.practice.findFirst({
      where: { id: practiceId, deletedAt: null },
      select: { orgId: true },
    });
    if (!practice) throw new NotFoundException('Practice not found');
    this.assertOrgAdmin(practice.orgId);
  }

  private assertCatalogCurator(): void {
    if (
      this.platformRole === 'super_admin' ||
      this.platformRole === 'data_entry'
    )
      return;
    throw new ForbiddenException(
      'Only platform catalog curators can change medicine photos',
    );
  }

  /**
   * A person's own avatar is theirs to set. Otherwise the caller must be acting inside an org that
   * the target belongs to: an admin may set a colleague's photo, and the patient-editing roles may
   * set a photo for a patient registered at that org (front desk taking it at the counter).
   */
  private async assertCanManageUser(userId: string): Promise<void> {
    if (userId === this.callerId) return;

    const org = this.requireOrgContext();
    const [staff, registration] = await Promise.all([
      this.prisma.staff.findFirst({
        where: { orgId: org.orgId, userId, deletedAt: null, status: 'active' },
        select: { id: true },
      }),
      this.prisma.patientRegistration.findFirst({
        where: {
          orgId: org.orgId,
          deletedAt: null,
          status: 'active',
          patient: { userId },
        },
        select: { id: true },
      }),
    ]);

    if (staff && org.roles.includes('admin')) return;
    if (registration && org.roles.some((r) => PATIENT_EDITORS.includes(r)))
      return;
    throw new ForbiddenException('You cannot change this person’s photo');
  }

  /** The patient themselves, or a patient-editing role at an org where they are registered. */
  private async assertCanManagePatient(patientId: string): Promise<void> {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId },
      select: { userId: true },
    });
    if (!patient) throw new NotFoundException('Patient not found');
    if (patient.userId === this.callerId) return;

    const org = this.requireOrgContext();
    if (!org.roles.some((r) => PATIENT_EDITORS.includes(r))) {
      throw new ForbiddenException('Insufficient role for this action');
    }
    const registration = await this.prisma.patientRegistration.findFirst({
      where: { orgId: org.orgId, patientId, deletedAt: null, status: 'active' },
      select: { id: true },
    });
    if (!registration) {
      throw new ForbiddenException(
        'This patient is not registered at your organization',
      );
    }
  }

  private get callerId(): string {
    return this.request.auth.user.id;
  }

  private get platformRole(): string | null {
    return this.request.auth.user.platformRole ?? null;
  }

  private get orgContext() {
    return this.request.orgContext;
  }

  private requireOrgContext() {
    const org = this.orgContext;
    if (!org) {
      throw new ForbiddenException(
        'Organization context required (set the X-Org-Id header)',
      );
    }
    return org;
  }
}
