import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { CognitoService } from '../auth/cognito.service';
import { AuditService } from '../audit/audit.service';
import { ImagesService } from '../images/images.service';
import { throwMappedPrismaError } from '../common/prisma-errors';
import type { CreateStaffDto, UpdateStaffDto } from './dto/staff.dto';

/** Demographics returned alongside a membership (they live on the global app_user). */
const USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  imageUpdatedAt: true, // → resolved to `imageUrl` by withImage
} as const;

/**
 * Staff (org membership) management. `create` owns the whole "add a person to this org" flow in
 * one call: reuse their global app_user if they already exist, else provision a Cognito identity
 * + app_user, then create the membership. The membership row is tenant-scoped (ScopedPrismaService);
 * the app_user is global (unscoped PrismaService).
 */
@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scoped: ScopedPrismaService,
    private readonly cognito: CognitoService,
    private readonly audit: AuditService,
    private readonly images: ImagesService,
  ) {}

  /**
   * Attach the person's presigned avatar URL. The photo hangs off the global app_user, so the
   * same doctor shows the same face at every org they work at.
   */
  private async withImage<
    T extends { user: { id: string; imageUpdatedAt: Date | null } },
  >(staff: T) {
    return {
      ...staff,
      user: {
        ...staff.user,
        imageUrl: await this.images.urlFor(
          'user',
          staff.user.id,
          staff.user.imageUpdatedAt,
        ),
      },
    };
  }

  async create(dto: CreateStaffDto) {
    const userId = await this.resolveAppUser(dto);
    try {
      const staff = await this.scoped.db.staff.create({
        data: {
          orgId: this.scoped.orgId,
          userId,
          roles: dto.roles,
          status: 'active',
          specialty: dto.specialty,
          registrationNumber: dto.registrationNumber,
          consultationFee: dto.consultationFee,
        },
        include: { user: { select: USER_SELECT } },
      });
      await this.audit.record({
        action: 'staff.create',
        entityType: 'staff',
        entityId: staff.id,
        metadata: { userId, roles: dto.roles },
      });
      this.logger.log(
        `Staff added: id=${staff.id} user=${userId} org=${this.scoped.orgId} roles=[${dto.roles.join(',')}]`,
      );
      return this.withImage(staff);
    } catch (err) {
      this.logger.warn(
        `Staff creation failed for user=${userId} org=${this.scoped.orgId}: ${String(err)}`,
      );
      throwMappedPrismaError(err, {
        conflict: 'This user is already staff at this organization',
      });
    }
  }

  async list() {
    const staff = await this.scoped.db.staff.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: { select: USER_SELECT } },
    });
    return Promise.all(staff.map((s) => this.withImage(s)));
  }

  async get(id: string) {
    const staff = await this.scoped.db.staff.findFirst({
      where: { id },
      include: { user: { select: USER_SELECT } },
    });
    if (!staff) throw new NotFoundException('Staff member not found');
    return this.withImage(staff);
  }

  update(id: string, dto: UpdateStaffDto) {
    return this.scoped.db.staff
      .update({
        where: { id },
        data: dto,
        include: { user: { select: USER_SELECT } },
      })
      .then((updated) => this.withImage(updated))
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { notFound: 'Staff member not found' }),
      );
  }

  async remove(id: string): Promise<void> {
    await this.scoped.db.staff
      .update({ where: { id }, data: { deletedAt: new Date() } })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { notFound: 'Staff member not found' }),
      );
    this.logger.log(`Staff removed: id=${id} org=${this.scoped.orgId}`);
  }

  /**
   * Resolve the person's ONE global identity, creating it only if truly new. A human is a single
   * app_user across every org they work at — so the same doctor added at a second hospital reuses
   * their app_user and Cognito login; only a new `staff` membership is created.
   *
   * Dedup is layered so duplicates can't slip through:
   *   1. Fast path — find the app_user by (normalized) email; reuse it, no Cognito call.
   *   2. Else provision the Cognito identity. If Cognito already has this login (e.g. they were
   *      added under a different email, or onboarded elsewhere), AdminCreateUser fails with
   *      UsernameExistsException and CognitoService returns the EXISTING `sub`.
   *   3. Upsert the app_user keyed on `cognito_sub` (its unique identity key) — so an existing
   *      identity links to the one app_user instead of duplicating (no P2002), and a genuinely new
   *      one is created. Demographics aren't overwritten on reuse (left to the owning org).
   */
  private async resolveAppUser(dto: CreateStaffDto): Promise<string> {
    const existing = await this.prisma.appUser.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) return existing.id;

    const cognitoSub = await this.cognito.provisionUser({
      email: dto.email,
      phone: dto.phone,
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
    const user = await this.prisma.appUser.upsert({
      where: { cognitoSub },
      update: {}, // identity already exists — don't clobber its demographics
      create: {
        cognitoSub,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        status: 'active',
        updatedByOrg: this.scoped.orgId,
        updatedByUser: this.scoped.actorId,
      },
      select: { id: true },
    });
    return user.id;
  }
}
