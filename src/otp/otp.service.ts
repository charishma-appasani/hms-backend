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
const RESEND_COOLDOWN_MS = 60 * 1000; // min gap between codes to the same phone+purpose
const PHONE_WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_PHONE = 5; // per phone+purpose per hour
const IP_WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_IP = 10; // per IP per 10 min (across phones → anti-enumeration)

export interface OtpRequest {
  phone: string;
  purpose: string; // e.g. 'patient_signup' — scopes limits + verification
  ip?: string; // request IP for per-IP limiting (omit if unknown)
  email?: string; // if present, the code is delivered by EMAIL instead of SMS
  name?: string; // greeting in the message (defaults to a neutral salutation)
}

/**
 * Generic phone-OTP capability, reusable by any module (patient self-signup today; cross-org
 * patient link / consent later). `request` is the ONLY way to issue a code and it always runs the
 * rate-limit checks first, so an OTP can't be sent without passing them. All limits and the
 * challenge live in `otp_challenge`, so they're consistent across instances. Codes are stored
 * hashed and are single-use (consumed on successful `verify`).
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Rate-limit → generate → store → deliver. Throws 429 if a limit is hit (no code is sent).
   * Delivery channel: EMAIL when an email is given (cheaper/no DLT, so preferred when both exist),
   * otherwise SMS to the phone. The challenge is always keyed by phone (the limits + verification).
   */
  async request({ phone, purpose, ip, email, name }: OtpRequest): Promise<void> {
    await this.enforceLimits(phone, purpose, ip);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // Invalidate any outstanding code for this phone+purpose, then store the new one (hashed).
    await this.prisma.otpChallenge.updateMany({
      where: { phone, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await this.prisma.otpChallenge.create({
      data: {
        phone,
        purpose,
        ip,
        codeHash: hashCode(phone, code),
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });

    // Choosing the recipient's single contact selects the channel (NotificationService only
    // dispatches to channels a recipient supports): email if present, else SMS.
    const recipient = email
      ? { name: name ?? 'there', email }
      : { name: name ?? 'there', phone };
    await this.notifications.dispatch(recipient, {
      subject: 'Polaris verification code',
      body: `Your Polaris verification code is ${code}. It expires in 10 minutes.`,
    });
  }

  /** Validate a code; consumes it on success (single-use). Throws 400 on invalid/expired/exhausted. */
  async verify({
    phone,
    purpose,
    code,
  }: {
    phone: string;
    purpose: string;
    code: string;
  }): Promise<void> {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
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
    if (challenge.codeHash !== hashCode(phone, code)) {
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
    phone: string,
    purpose: string,
    ip: string | undefined,
  ): Promise<void> {
    const recent = await this.prisma.otpChallenge.findFirst({
      where: {
        phone,
        purpose,
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) {
      throw tooMany('Please wait a minute before requesting another code');
    }

    const phoneCount = await this.prisma.otpChallenge.count({
      where: {
        phone,
        purpose,
        createdAt: { gt: new Date(Date.now() - PHONE_WINDOW_MS) },
      },
    });
    if (phoneCount >= MAX_PER_PHONE) {
      throw tooMany(
        'Too many code requests for this number — please try again later',
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

function hashCode(phone: string, code: string): string {
  return createHash('sha256').update(`${phone}:${code}`).digest('hex');
}
