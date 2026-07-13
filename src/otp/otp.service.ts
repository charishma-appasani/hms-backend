import { createHash, randomInt } from 'crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notifications/notification.service';

const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
// Rate limits — all enforced from the DB (otp_challenge), so they hold across instances.
const RESEND_COOLDOWN_MS = 60 * 1000; // min gap between codes to the same identifier+purpose
const IDENTIFIER_WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_IDENTIFIER = 5; // per identifier+purpose per hour
const IP_WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_IP = 10; // per IP per 10 min (across identifiers → anti-enumeration)

export interface OtpRequest {
  /** The contact being verified (a phone OR an email) — keys the limits + verification. */
  identifier: string;
  purpose: string; // e.g. 'patient_signup' — scopes limits + verification
  ip?: string; // request IP for per-IP limiting (omit if unknown)
  email?: string; // delivery contact — EMAIL takes precedence when present
  phone?: string; // delivery fallback — SMS when there is no email
  name?: string; // greeting in the message (defaults to a neutral salutation)
}

/**
 * Generic OTP capability, reusable by any module (patient self-signup, cross-org patient link,
 * org self-signup). `request` is the ONLY way to issue a code and it always runs the rate-limit
 * checks first, so an OTP can't be sent without passing them. All limits and the challenge live
 * in `otp_challenge`, so they're consistent across instances. Codes are stored hashed and are
 * single-use (consumed on successful `verify`).
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Rate-limit → generate → store → deliver. Throws 429 if a limit is hit (no code is sent).
   * Delivery channel: EMAIL when an email is given (cheaper/no DLT, so it takes precedence),
   * otherwise SMS to the phone. The challenge is always keyed by `identifier` (the limits +
   * verification), which may itself be the email or the phone.
   */
  async request({
    identifier,
    purpose,
    ip,
    email,
    phone,
    name,
  }: OtpRequest): Promise<void> {
    await this.enforceLimits(identifier, purpose, ip);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // Invalidate any outstanding code for this identifier+purpose, then store the new one (hashed).
    await this.prisma.otpChallenge.updateMany({
      where: { identifier, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await this.prisma.otpChallenge.create({
      data: {
        identifier,
        purpose,
        ip,
        codeHash: hashCode(identifier, code),
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });

    // Choosing the recipient's single contact selects the channel (NotificationService only
    // dispatches to channels a recipient supports): email if present, else SMS.
    const recipient = email
      ? { name: name ?? 'there', email }
      : { name: name ?? 'there', phone };
    await this.notifications.dispatch(recipient, {
      subject: 'Aayufy verification code',
      body: `Your Aayufy verification code is ${code}. It expires in 10 minutes.`,
    });
  }

  /** Validate a code; consumes it on success (single-use). Throws 400 on invalid/expired/exhausted. */
  async verify({
    identifier,
    purpose,
    code,
  }: {
    identifier: string;
    purpose: string;
    code: string;
  }): Promise<void> {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: {
        identifier,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) {
      throw new BadRequestException(
        'No valid verification code — please request a new one',
      );
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException(
        'Too many attempts — please request a new code',
      );
    }
    if (challenge.codeHash !== hashCode(identifier, code)) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Invalid verification code');
    }
    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
  }

  private async enforceLimits(
    identifier: string,
    purpose: string,
    ip: string | undefined,
  ): Promise<void> {
    const recent = await this.prisma.otpChallenge.findFirst({
      where: {
        identifier,
        purpose,
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) {
      throw tooMany('Please wait a minute before requesting another code');
    }

    const identifierCount = await this.prisma.otpChallenge.count({
      where: {
        identifier,
        purpose,
        createdAt: { gt: new Date(Date.now() - IDENTIFIER_WINDOW_MS) },
      },
    });
    if (identifierCount >= MAX_PER_IDENTIFIER) {
      throw tooMany(
        'Too many code requests for this contact — please try again later',
      );
    }

    if (ip) {
      const ipCount = await this.prisma.otpChallenge.count({
        where: { ip, createdAt: { gt: new Date(Date.now() - IP_WINDOW_MS) } },
      });
      if (ipCount >= MAX_PER_IP) {
        throw tooMany(
          'Too many requests from this network — please try again later',
        );
      }
    }
  }
}

function tooMany(message: string): HttpException {
  return new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
}

function hashCode(identifier: string, code: string): string {
  return createHash('sha256').update(`${identifier}:${code}`).digest('hex');
}
