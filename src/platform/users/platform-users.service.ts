import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CognitoService } from '../../auth/cognito.service';
import { IdentityService } from '../../auth/identity.service';
import { throwMappedPrismaError } from '../../common/prisma-errors';
import { IDENTITY_CONFLICT } from '../../common/phone-availability';
import type { LookupDto } from '../../common/contact.schema';
import type { CreatePlatformUserDto } from './dto/platform-user.dto';

/** A platform-access consent code is valid only for being made an operator. */
const CONSENT_SCOPE = { scope: 'platform', purpose: 'operator_link' };

/** Identity fields returned for a platform operator (no tenant data — these live above orgs). */
const OPERATOR_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  platformRole: true,
  createdAt: true,
} as const;

/**
 * Platform operator (our employees: `app_user.platform_role`) management. Closes the onboarding
 * gap after bootstrap: the first super_admin comes from `/platform/bootstrap`, everyone after from
 * here — no more direct DB edits (docs/architecture/onboarding-and-bootstrap.md).
 *
 * Adding an operator is the same two steps as adding staff or a patient (IdentityService): `lookup`
 * finds the person's ONE global account and, if it exists, sends them a consent code — so a typo
 * can't silently grant platform access to someone else; `create` then grants the role (with the
 * code) or provisions a new Cognito login (invite) + app_user. Uses the unscoped PrismaService —
 * operators carry no org context.
 */
@Injectable()
export class PlatformUsersService {
  private readonly logger = new Logger(PlatformUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cognito: CognitoService,
    private readonly identity: IdentityService,
  ) {}

  /** Step 1: an existing account gets a consent code (masked hint returned); else no match. */
  async lookup(dto: LookupDto, ip: string) {
    const account = await this.identity.findAccount(dto);
    if (!account) return { match: false as const };
    if (account.platformRole) {
      throw new ConflictException('This person is already a platform operator');
    }
    const sentTo = await this.identity.sendCode(
      account,
      CONSENT_SCOPE,
      'Aayufy wants to give you platform operator access.',
      ip,
    );
    return { match: true as const, sentTo };
  }

  list() {
    return this.prisma.appUser.findMany({
      where: { platformRole: { not: null } },
      select: OPERATOR_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Step 2: grant the role to the existing account (with `code`), or invite a new person. */
  async create(dto: CreatePlatformUserDto, actorId: string) {
    const existing = await this.identity.findAccount(dto);
    if (dto.code) {
      if (!existing) {
        throw new BadRequestException(
          'No account matches these details — start again',
        );
      }
      if (existing.platformRole) {
        throw new ConflictException(
          'This person is already a platform operator',
        );
      }
      await this.identity.verifyCode(existing, CONSENT_SCOPE, dto.code);
      // Known identity (e.g. onboarded as org staff earlier) — just grant the platform role.
      const user = await this.prisma.appUser.update({
        where: { id: existing.id },
        data: { platformRole: dto.platformRole },
        select: OPERATOR_SELECT,
      });
      this.logger.log(
        `Platform role granted to existing user: id=${user.id} role=${dto.platformRole} actor=${actorId}`,
      );
      return user;
    }
    if (existing) {
      throw new ConflictException(
        'This person already has an account — verify them with a code instead',
      );
    }

    const firstName = dto.firstName!; // the DTO requires it on the no-code path
    const cognitoSub = await this.cognito.provisionUser({
      email: dto.email,
      firstName,
      lastName: dto.lastName,
      phone: dto.phone,
    });
    // Upsert on cognito_sub: an unlinked Cognito identity reuses its login instead of failing.
    const user = await this.prisma.appUser
      .upsert({
        where: { cognitoSub },
        update: { platformRole: dto.platformRole },
        create: {
          cognitoSub,
          firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          platformRole: dto.platformRole,
        },
        select: OPERATOR_SELECT,
      })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { conflict: IDENTITY_CONFLICT }),
      );
    this.logger.log(
      `Platform operator invited: id=${user.id} role=${dto.platformRole} actor=${actorId}`,
    );
    return user;
  }

  /**
   * Revoke operator access (platform_role → null). The app_user survives — they may still be org
   * staff or a patient. Self-revocation is blocked, which also makes the last super_admin
   * irremovable (only a super_admin can call this).
   */
  async revoke(id: string, actorId: string): Promise<void> {
    if (id === actorId) {
      throw new BadRequestException(
        'You cannot revoke your own platform access',
      );
    }
    const user = await this.prisma.appUser.findFirst({
      where: { id },
      select: { platformRole: true },
    });
    if (!user?.platformRole) {
      throw new NotFoundException('Platform operator not found');
    }
    await this.prisma.appUser.update({
      where: { id },
      data: { platformRole: null },
    });
    this.logger.warn(
      `Platform access revoked: id=${id} was=${user.platformRole} actor=${actorId}`,
    );
  }
}
