import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { CognitoService } from '../auth/cognito.service';
import { AuditService } from '../audit/audit.service';
import { ImagesService } from '../images/images.service';
import { throwMappedPrismaError } from '../common/prisma-errors';
import { AvailabilityTemplatesService } from '../scheduling/availability-templates/availability-templates.service';
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
    private readonly schedules: AvailabilityTemplatesService,
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
    const restored = await this.restoreRemoved(userId, dto);
    if (restored) return restored;
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

  /**
   * The org's staff directory. Disabled members are always included; soft-deleted (removed) ones
   * only when `includeRemoved` — the admin screen shows them so they can be re-activated, while
   * pickers (e.g. scheduling's doctor list) keep the default.
   */
  async list(includeRemoved = false) {
    const staff = await this.scoped.db.staff.findMany({
      // An explicit `deletedAt: undefined` opts out of the scoped client's soft-delete filter.
      where: includeRemoved ? { deletedAt: undefined } : {},
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

  /** What removing this member would cancel — shown in the admin's confirmation dialog. */
  async removalImpact(id: string) {
    await this.get(id); // 404 for unknown / already-removed members
    return this.schedules.upcomingBookingCounts(id);
  }

  /**
   * Soft-delete the membership. A doctor's upcoming appointments are CANCELLED (patients notified)
   * and their schedule dropped first — so a failure leaves them still listed and retryable, never
   * removed with live bookings. Checked-in patients aren't cancelled; they come back in
   * `needsAttention`. The membership itself is reversible via {@link activate} or by adding the
   * person again (the schedule has to be recreated).
   */
  async remove(id: string) {
    await this.assertNotSelf(id);
    await this.get(id);
    const retired = await this.schedules.retireProvider(id);
    await this.scoped.db.staff
      .update({ where: { id }, data: { deletedAt: new Date() } })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { notFound: 'Staff member not found' }),
      );
    await this.audit.record({
      action: 'staff.remove',
      entityType: 'staff',
      entityId: id,
      metadata: {
        cancelledAppointments: retired.cancelled.length,
        needsAttention: retired.needsAttention.length,
      },
    });
    this.logger.log(
      `Staff removed: id=${id} org=${this.scoped.orgId} cancelled=${retired.cancelled.length} needsAttention=${retired.needsAttention.length}`,
    );
    return {
      cancelledAppointments: retired.cancelled.length,
      needsAttention: retired.needsAttention,
    };
  }

  /** Block sign-in to this org while keeping the membership visible (and editable). */
  async disable(id: string) {
    await this.assertNotSelf(id);
    const staff = await this.scoped.db.staff
      .update({
        where: { id },
        data: { status: 'disabled' },
        include: { user: { select: USER_SELECT } },
      })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { notFound: 'Staff member not found' }),
      );
    await this.audit.record({
      action: 'staff.disable',
      entityType: 'staff',
      entityId: id,
    });
    this.logger.log(`Staff disabled: id=${id} org=${this.scoped.orgId}`);
    return this.withImage(staff);
  }

  /** Re-activate a disabled OR removed membership (clears the soft delete too). */
  async activate(id: string) {
    const staff = await this.scoped.db.staff
      .update({
        where: { id, deletedAt: undefined }, // reach removed rows too
        data: { status: 'active', deletedAt: null },
        include: { user: { select: USER_SELECT } },
      })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { notFound: 'Staff member not found' }),
      );
    await this.audit.record({
      action: 'staff.activate',
      entityType: 'staff',
      entityId: id,
    });
    this.logger.log(`Staff activated: id=${id} org=${this.scoped.orgId}`);
    return this.withImage(staff);
  }

  /**
   * An admin can't disable/remove their OWN membership — that would lock them out of the org
   * (and could leave it with no admin). Another admin (or a super_admin) must do it.
   */
  private async assertNotSelf(id: string): Promise<void> {
    const target = await this.scoped.db.staff.findFirst({
      where: { id },
      select: { userId: true },
    });
    if (target?.userId === this.scoped.actorId) {
      throw new BadRequestException(
        'You cannot disable or remove your own membership',
      );
    }
  }

  /**
   * `staff` is unique on (org, user) INCLUDING soft-deleted rows, so re-adding a removed person
   * restores their old membership (history intact) with the newly submitted roles/fields instead
   * of failing with "already staff". Returns null when there is no removed membership.
   */
  private async restoreRemoved(userId: string, dto: CreateStaffDto) {
    const removed = await this.scoped.db.staff.findFirst({
      where: { userId, deletedAt: { not: null } },
      select: { id: true },
    });
    if (!removed) return null;
    const staff = await this.scoped.db.staff.update({
      where: { id: removed.id, deletedAt: { not: null } },
      data: {
        roles: dto.roles,
        status: 'active',
        deletedAt: null,
        specialty: dto.specialty,
        registrationNumber: dto.registrationNumber,
        consultationFee: dto.consultationFee,
      },
      include: { user: { select: USER_SELECT } },
    });
    await this.audit.record({
      action: 'staff.restore',
      entityType: 'staff',
      entityId: staff.id,
      metadata: { userId, roles: dto.roles },
    });
    this.logger.log(
      `Staff restored: id=${staff.id} user=${userId} org=${this.scoped.orgId}`,
    );
    return this.withImage(staff);
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
