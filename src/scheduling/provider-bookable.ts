import { BadRequestException } from '@nestjs/common';

/** Select this on a slot's/appointment's `provider` relation to feed {@link assertProviderBookable}. */
export const BOOKABLE_PROVIDER_SELECT = {
  userId: true,
  status: true,
  deletedAt: true,
} as const;

/**
 * A provider takes NEW bookings (and new schedules) only while their membership is active: a
 * disabled doctor keeps their existing appointments but gets no new ones, and a removed doctor's
 * schedule is already retired. Nested relation reads aren't soft-delete filtered by the scoped
 * client, so callers must check `deletedAt` here too.
 */
export function assertProviderBookable(provider: {
  status: string;
  deletedAt: Date | null;
}): void {
  if (provider.deletedAt || provider.status !== 'active') {
    throw new BadRequestException(
      'This doctor is not currently taking appointments',
    );
  }
}
