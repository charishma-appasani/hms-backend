import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { NotificationService } from '../../notifications/notification.service';
import { throwMappedPrismaError } from '../../common/prisma-errors';
import type {
  CreateOrganizationDto,
  UpdateOrganizationDto,
} from './dto/organization.dto';

/**
 * Organization (tenant) management for platform operators. Organizations are the tenant ROOT —
 * they have no org_id and are NOT reachable through the scoped client, so this service uses the
 * unscoped PrismaService and stamps audit columns explicitly from the acting operator (`actorId`
 * = the platform user's app_user.id).
 *
 * Approval: operator-created orgs are approved at creation (trusted). Self-signed-up orgs
 * (OrgSignupService) start with `approvedAt` null and stay out of the public patient directory
 * until `approve` is called. "Reject" = the existing soft-delete (`remove`).
 *
 * Scope of this module: org lifecycle CRUD + approval. Bootstrapping the first org admin (staff +
 * Cognito invite) is a separate onboarding step — see docs/architecture/auth-and-authz.md.
 */
@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  create(dto: CreateOrganizationDto, actorId: string) {
    return this.prisma.organization
      .create({
        data: {
          ...dto,
          // Operator-created orgs skip the approval queue.
          approvedAt: new Date(),
          approvedBy: actorId,
          createdBy: actorId,
          updatedBy: actorId,
        },
      })
      .then((org) => {
        this.logger.log(
          `Organization created: id=${org.id} name="${org.name}" actor=${actorId}`,
        );
        return org;
      });
  }

  list() {
    return this.prisma.organization.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const org = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
    });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  update(id: string, dto: UpdateOrganizationDto, actorId: string) {
    return this.prisma.organization
      .update({
        where: { id, deletedAt: null },
        data: { ...dto, updatedBy: actorId },
      })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { notFound: 'Organization not found' }),
      );
  }

  /**
   * Approve a self-signed-up org → it becomes visible in the patient directory and bookable.
   * Idempotent: approving an already-approved org returns it unchanged. Notifies the org's
   * admins (best-effort).
   */
  async approve(id: string, actorId: string) {
    const org = await this.get(id);
    if (org.approvedAt) return org;

    const approved = await this.prisma.organization.update({
      where: { id, deletedAt: null },
      data: { approvedAt: new Date(), approvedBy: actorId, updatedBy: actorId },
    });
    await this.audit.record({
      action: 'org.approve',
      entityType: 'organization',
      entityId: id,
      orgId: id,
    });
    this.logger.log(`Organization approved: id=${id} actor=${actorId}`);
    await this.notifyAdmins(approved.id, approved.name);
    return approved;
  }

  async remove(id: string, actorId: string): Promise<void> {
    await this.prisma.organization
      .update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), deletedBy: actorId, updatedBy: actorId },
      })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { notFound: 'Organization not found' }),
      );
    this.logger.warn(`Organization soft-deleted: id=${id} actor=${actorId}`);
  }

  /** Best-effort "you're approved" note to every active admin of the org. */
  private async notifyAdmins(orgId: string, orgName: string): Promise<void> {
    try {
      const admins = await this.prisma.staff.findMany({
        where: {
          orgId,
          deletedAt: null,
          status: 'active',
          roles: { has: 'admin' },
        },
        select: {
          user: { select: { firstName: true, email: true, phone: true } },
        },
      });
      for (const { user } of admins) {
        await this.notifications.dispatch(
          {
            name: user.firstName,
            email: user.email ?? undefined,
            phone: user.phone ?? undefined,
          },
          {
            subject: 'Your organization is approved on Aayufy',
            body: `"${orgName}" has been approved. Patients can now find and book with you on Aayufy.`,
          },
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to notify admins about approval of org ${orgId}: ${String(err)}`,
      );
    }
  }
}
