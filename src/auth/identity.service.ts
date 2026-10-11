import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../otp/otp.service';
import type { LookupDto } from '../common/contact.schema';

/** The parts of an existing account the "add a person" flows need. */
export interface Account {
  id: string;
  cognitoSub: string;
  firstName: string;
  email: string | null;
  phone: string | null;
  platformRole: string | null;
  patient: { id: string } | null;
}

/** Where the person is being added — a code is valid only for that one place. */
export interface ConsentScope {
  /** An org id, or 'platform'. */
  scope: string;
  /** Per flow, e.g. 'staff_link' — separates rate limits and codes. */
  purpose: string;
}

/**
 * The shared core of every "add a person" flow (staff, patients, platform users). One human is
 * ONE app_user across Aayufy, so adding someone starts by finding their existing account by email
 * and/or phone. An existing account is attached only with a code sent to the person — their
 * consent (DPDP) — and nothing about them is shown to the adder before that, except a masked hint
 * of where the code went.
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
  ) {}

  /**
   * The ONE account matching the email and/or phone, or null. Each is unique on its own, so at most
   * one account per value — but the two may belong to DIFFERENT people (a data-entry mistake → 409).
   * A match on one value is enough; the other isn't copied onto the account.
   */
  async findAccount({ email, phone }: LookupDto): Promise<Account | null> {
    const matches = await this.prisma.appUser.findMany({
      where: {
        OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])],
      },
      select: {
        id: true,
        cognitoSub: true,
        firstName: true,
        email: true,
        phone: true,
        platformRole: true,
        patient: { select: { id: true } },
      },
    });
    if (matches.length > 1) {
      throw new ConflictException(
        'This email and phone number belong to two different people. Check both and try again.',
      );
    }
    return matches[0] ?? null;
  }

  /**
   * Send the person a consent code (email if they have one, else SMS). `reason` tells them who is
   * asking and what for. Returns the masked contact it went to — safe to show the adder.
   */
  async sendCode(
    account: Account,
    { scope, purpose }: ConsentScope,
    reason: string,
    ip: string,
  ): Promise<string> {
    await this.otp.request({
      identifier: `${scope}:${account.id}`,
      purpose,
      ip,
      email: account.email ?? undefined,
      phone: account.phone ?? undefined,
      name: account.firstName,
      reason: `${reason} Share this code only if you agree.`,
    });
    return account.email ? maskEmail(account.email) : maskPhone(account.phone!);
  }

  /** Throws 400 unless `code` is the one sent to this person for this scope (single-use). */
  verifyCode(
    account: Account,
    { scope, purpose }: ConsentScope,
    code: string,
  ): Promise<void> {
    return this.otp.verify({
      identifier: `${scope}:${account.id}`,
      purpose,
      code,
    });
  }
}

/** `asha@gmail.com` → `a***@gmail.com` — enough for the adder to confirm, not to harvest. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local[0]}***@${domain}`;
}

/** `+919876543210` → `+91******3210`. */
function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}${'*'.repeat(Math.max(phone.length - 7, 0))}${phone.slice(-4)}`;
}
