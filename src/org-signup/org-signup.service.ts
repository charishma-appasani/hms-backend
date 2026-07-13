import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CognitoService } from '../auth/cognito.service';
import { OtpService } from '../otp/otp.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import type { OrgSignupStartDto, OrgSignupVerifyDto } from './dto/org-signup.dto';

const SIGNUP_PURPOSE = 'org_signup';

/**
 * Public org self-signup (OTP-gated): a hospital/clinic registers itself without a platform
 * operator. The verified email becomes the founding admin's login. The org is created ACTIVE but
 * UNAPPROVED (`approved_at` null) — the admin can sign in and set up (practices, staff, schedules)
 * right away, but the org stays out of the public patient directory and can't take patient
 * self-bookings until a platform super_admin approves it (POST /platform/organizations/:id/approve).
 */
@Injectable()
export class OrgSignupService {
  private readonly logger = new Logger(OrgSignupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cognito: CognitoService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /** Step 1: rate-limited OTP to the admin's email (OtpService enforces the limits + sends). */
  async start(dto: OrgSignupStartDto, ip: string): Promise<{ sent: boolean }> {
    await this.otp.request({
      identifier: dto.email,
      email: dto.email,
      phone: dto.phone,
      purpose: SIGNUP_PURPOSE,
      ip,
    });
    return { sent: true };
  }

  /**
   * Step 2: verify the OTP, then create the organization + its founding admin in one go.
   * If the email already belongs to an app_user (e.g. a doctor elsewhere starting their own
   * clinic), that identity is REUSED and the submitted password is ignored — they keep their
   * existing login. Otherwise a Cognito user is provisioned with the given permanent password.
   */
  async verify(dto: OrgSignupVerifyDto) {
    await this.otp.verify({
      identifier: dto.email,
      purpose: SIGNUP_PURPOSE,
      code: dto.code,
    });

    const { userId, existingAccount } = await this.resolveAdminUser(dto);

    const { org, staff } = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: dto.orgName,
          legalName: dto.legalName,
          // approvedAt stays null → awaiting platform approval.
          createdBy: userId,
          updatedBy: userId,
        },
      });
      const staff = await tx.staff.create({
        data: {
          orgId: org.id,
          userId,
          roles: ['admin'],
          status: 'active',
          createdBy: userId,
          updatedBy: userId,
        },
      });
      return { org, staff };
    });

    await this.audit.record({
      action: 'org.signup',
      entityType: 'organization',
      entityId: org.id,
      orgId: org.id,
      metadata: { via: 'self', adminUserId: userId, existingAccount },
    });
    this.logger.log(
      `Org self-signup: org=${org.id} "${org.name}" admin=${userId} staff=${staff.id} existingAccount=${existingAccount}`,
    );
    await this.notifyPlatformOperators(org.id, org.name);

    return {
      orgId: org.id,
      orgName: org.name,
      existingAccount,
      message: existingAccount
        ? 'Organization created — sign in with your existing password. It will be visible to patients once approved.'
        : 'Organization created. You can sign in now; it will be visible to patients once approved.',
    };
  }

  /** Reuse the email's existing global identity, or provision a new Cognito login + app_user. */
  private async resolveAdminUser(
    dto: OrgSignupVerifyDto,
  ): Promise<{ userId: string; existingAccount: boolean }> {
    const existing = await this.prisma.appUser.findFirst({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) return { userId: existing.id, existingAccount: true };

    const cognitoSub = await this.cognito.provisionUser({
      email: dto.email,
      phone: dto.phone,
      firstName: dto.firstName,
      lastName: dto.lastName,
      password: dto.password, // OTP proved email control → permanent password, no invite email
    });
    const user = await this.prisma.appUser.upsert({
      where: { cognitoSub },
      update: {}, // Cognito user existed without an app_user (drift) — don't clobber
      create: {
        cognitoSub,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        status: 'active',
      },
      select: { id: true },
    });
    return { userId: user.id, existingAccount: false };
  }

  /** Best-effort heads-up to every super_admin that a signup is awaiting approval. */
  private async notifyPlatformOperators(orgId: string, orgName: string): Promise<void> {
    try {
      const operators = await this.prisma.appUser.findMany({
        where: { platformRole: 'super_admin', email: { not: null } },
        select: { firstName: true, email: true },
      });
      for (const op of operators) {
        await this.notifications.dispatch(
          { name: op.firstName, email: op.email ?? undefined },
          {
            subject: 'New organization signup awaiting approval',
            body: `"${orgName}" (${orgId}) signed up on Aayufy and is awaiting approval. Review it in the platform console.`,
          },
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to notify platform operators about org signup ${orgId}: ${String(err)}`,
      );
    }
  }
}
