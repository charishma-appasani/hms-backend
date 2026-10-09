import { ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * `app_user.phone` is unique per person. Call BEFORE provisioning a Cognito identity for a new
 * person: failing later, at the app_user insert, leaves an orphaned (possibly already invited)
 * Cognito user behind and surfaces as a 500.
 */
export async function assertPhoneAvailable(
  prisma: PrismaService,
  phone: string | undefined,
): Promise<void> {
  if (!phone) return;
  const owner = await prisma.appUser.findFirst({
    where: { phone },
    select: { id: true },
  });
  if (owner) {
    throw new ConflictException(
      'This phone number is already registered to another person. Use a different number or leave it blank.',
    );
  }
}

/** 409 message for the app_user insert's unique-constraint backstop (a concurrent add). */
export const IDENTITY_CONFLICT =
  'This email or phone number is already registered to another person.';
