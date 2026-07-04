import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CognitoService } from '../../auth/cognito.service';
import type { BootstrapDto } from './dto/bootstrap.dto';

/**
 * One-time bootstrap of the first platform `super_admin`. Solves the chicken-and-egg of a fresh
 * instance (no operator exists to create the first operator, org, or admin). Guarded by an absolute
 * emptiness check: it succeeds ONLY when the database has zero `app_user` rows.
 */
@Injectable()
export class BootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cognito: CognitoService,
  ) {}

  async bootstrap(dto: BootstrapDto) {
    // Absolute new-instance check: any user at all (operator, staff, or patient) closes this door.
    const userCount = await this.prisma.appUser.count();
    if (userCount > 0) {
      throw new ConflictException('System is already initialized');
    }

    const cognitoSub = await this.cognito.provisionUser({
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
      password: dto.password,
    });

    const user = await this.prisma.appUser.create({
      data: {
        cognitoSub,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        email: dto.email,
        platformRole: 'super_admin',
      },
    });

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      platformRole: user.platformRole,
      // Whether the operator can log in now (password set) or must use the emailed invite.
      loginReady: Boolean(dto.password),
    };
  }
}
