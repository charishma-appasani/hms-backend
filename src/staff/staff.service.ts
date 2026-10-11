import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { CognitoService } from '../auth/cognito.service';
import { IdentityService } from '../auth/identity.service';
import { AuditService } from '../audit/audit.service';
import { ImagesService } from '../images/images.service';
import { throwMappedPrismaError } from '../common/prisma-errors';
import { IDENTITY_CONFLICT } from '../common/phone-availability';
import type { LookupDto } from '../common/contact.schema';
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
 * Staff (org membership) management. Adding a person is two steps: `lookup` (does this email/phone
 * already have an account? if so, OTP them for consent) then `create` (link that account with the
 * code, or provision a brand-new Cognito identity + app_user), followed by the membership. The
 * membership row is tenant-scoped (ScopedPrismaService); the app_user is global (PrismaService).
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
    private readonly identity: IdentityService,
  ) {}

  /** A staff consent code is valid only for joining THIS org. */
  private get consentScope() {
    return { scope: this.scoped.orgId, purpose: 'staff_link' };
  }

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

  /**
   * Step 1 of adding staff. If the email/phone belongs to an existing account, emails/texts the
   * person a code (they share it with the admin to consent — DPDP) and returns only a masked hint
   * of where it went, never their details. No match → the admin fills in a new person.
   */
  async lookup(dto: LookupDto, ip: string) {
    const account = await this.identity.findAccount(dto);
    if (!account) return { match: false as const };

    const member = await this.scoped.db.staff.findFirst({
      where: { userId: account.id },
      select: { id: true },
    });
    if (member) {
      throw new ConflictException(
        'This person is already staff at this organization',
      );
    }
    const org = await this.scoped.db.organization.findFirst({
      where: { id: this.scoped.orgId },
      select: { name: true },
    });
    const sentTo = await this.identity.sendCode(
      account,
      this.consentScope,
      `${org?.name ?? 'An organization'} wants to add you as staff on Aayufy.`,
      ip,
    );
    return { match: true as const, sentTo };
  }

  /**
   * Step 2. With `code`: link the existing account the lookup matched (code proves consent).
   * Without: create a brand-new person — refused if the contact already belongs to an account.
   */
  async create(dto: CreateStaffDto) {
    const account = await this.identity.findAccount(dto);
    let userId: string;
    if (dto.code) {
      if (!account) {
        throw new BadRequestException(
          'No account matches these details — start again',
        );
      }
      await this.identity.verifyCode(account, this.consentScope, dto.code);
      // They may never have signed in (expired temporary password) — send a fresh invite.
      // Best-effort: the admin can retry with "Resend invite".
      await this.cognito
        .resendInviteIfPending(account.cognitoSub)
        .catch((err: unknown) =>
          this.logger.warn(
            `Invite resend failed for user=${account.id}: ${String(err)}`,
          ),
        );
      userId = account.id;
    } else {
      if (account) {
        throw new ConflictException(
          'This person already has an account — verify them with a code instead',
        );
      }
      userId = await this.provisionNew(dto);
    }
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
        metadata: {
          userId,
          roles: dto.roles,
          via: dto.code ? 'linked_existing' : 'new_person',
        },
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
   * Email the member a fresh temporary password. Only for people who have never signed in — once
   * they've set their own password, "Forgot password" on the login screen is the way back in.
   */
  async resendInvite(id: string) {
    const staff = await this.scoped.db.staff.findFirst({
      where: { id },
      select: { user: { select: { id: true, cognitoSub: true } } },
    });
    if (!staff) throw new NotFoundException('Staff member not found');
    const sent = await this.cognito.resendInviteIfPending(
      staff.user.cognitoSub,
    );
    if (!sent) {
      throw new BadRequestException(
        'This person has already signed in. They can use "Forgot password" to reset it.',
      );
    }
    await this.audit.record({
      action: 'staff.resend_invite',
      entityType: 'staff',
      entityId: id,
    });
    this.logger.log(
      `Staff invite resent: id=${id} user=${staff.user.id} org=${this.scoped.orgId}`,
    );
    return { sent };
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
   * Provision a brand-new person (no app_user has this email or phone): Cognito login + invite
   * (email, else SMS), then the app_user. If Cognito already has the login (an app_user was lost), AdminCreateUser
   * fails with UsernameExistsException and CognitoService returns the EXISTING `sub` — so the
   * upsert keyed on `cognito_sub` links it instead of duplicating.
   */
  private async provisionNew(dto: CreateStaffDto): Promise<string> {
    // The DTO guarantees a name (and an email or phone) on the no-code path.
    const firstName = dto.firstName!;
    const cognitoSub = await this.cognito.provisionUser({
      email: dto.email,
      phone: dto.phone,
      firstName,
      lastName: dto.lastName,
    });
    const user = await this.prisma.appUser
      .upsert({
        where: { cognitoSub },
        update: {}, // identity already exists — don't clobber its demographics
        create: {
          cognitoSub,
          firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          status: 'active',
          updatedByOrg: this.scoped.orgId,
          updatedByUser: this.scoped.actorId,
        },
        select: { id: true },
      })
      // Race with a concurrent add of the same phone/email — still a 409, not a 500.
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { conflict: IDENTITY_CONFLICT }),
      );
    return user.id;
  }
}
