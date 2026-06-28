import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
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
 * Scope of this module: org lifecycle CRUD. Bootstrapping the first org admin (staff + Cognito
 * invite) is a separate onboarding step — see docs/architecture/auth-and-authz.md.
 */
@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateOrganizationDto, actorId: string) {
    return this.prisma.organization.create({
      data: { ...dto, createdBy: actorId, updatedBy: actorId },
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

  async remove(id: string, actorId: string): Promise<void> {
    await this.prisma.organization
      .update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), deletedBy: actorId, updatedBy: actorId },
      })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { notFound: 'Organization not found' }),
      );
  }
}
