import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CognitoService } from '../../auth/cognito.service';
import type { CreatePlatformUserDto } from './dto/platform-user.dto';

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
 * `create` mirrors StaffService.resolveAppUser: reuse the person's ONE global identity when it
 * already exists (grant the role only), else provision Cognito (invite email) + app_user. Uses the
 * unscoped PrismaService — operators carry no org context.
 */
@Injectable()
export class PlatformUsersService {
  private readonly logger = new Logger(PlatformUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cognito: CognitoService,
  ) {}

  list() {
    return this.prisma.appUser.findMany({
      where: { platformRole: { not: null } },
      select: OPERATOR_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreatePlatformUserDto, actorId: string) {
    const existing = await this.prisma.appUser.findFirst({
      where: { email: dto.email },
      select: { id: true, platformRole: true },
    });
    if (existing?.platformRole) {
      throw new ConflictException('This person is already a platform operator');
    }

    if (existing) {
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

    const cognitoSub = await this.cognito.provisionUser({
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
    });
    // Upsert on cognito_sub: an unlinked Cognito identity reuses its login instead of failing.
    const user = await this.prisma.appUser.upsert({
      where: { cognitoSub },
      update: { platformRole: dto.platformRole },
      create: {
        cognitoSub,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        platformRole: dto.platformRole,
      },
      select: OPERATOR_SELECT,
    });
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
