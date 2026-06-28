import { BadRequestException, Injectable } from '@nestjs/common';
import { ScopedPrismaService } from '../../prisma/scoped-prisma.service';
import { dayWindowUtc } from '../../common/datetime';
import type { Slot } from '../../../generated/prisma/client';

/**
 * Slot availability (read-only). Slots are materialized eagerly when a template is created
 * (see AvailabilityTemplatesService), so this just reads the rows for a date and computes
 * `available = capacity − booked` per bucket. No generation happens here.
 */
@Injectable()
export class SlotsService {
  constructor(private readonly scoped: ScopedPrismaService) {}

  async getAvailability(input: {
    practiceId: string;
    providerId: string;
    date: string;
  }) {
    const practice = await this.scoped.db.practice.findFirst({
      where: { id: input.practiceId },
      select: { id: true, timezone: true },
    });
    if (!practice) {
      throw new BadRequestException(
        'practiceId does not reference a practice in this organization',
      );
    }

    const { dayStart, dayEnd } = dayWindowUtc(input.date, practice.timezone);
    const slots = await this.scoped.db.slot.findMany({
      where: {
        practiceId: input.practiceId,
        providerId: input.providerId,
        startAt: { gte: dayStart, lt: dayEnd },
      },
      orderBy: { startAt: 'asc' },
    });

    const view = slots.map(toAvailability);
    return {
      date: input.date,
      practiceId: input.practiceId,
      providerId: input.providerId,
      timezone: practice.timezone,
      // Day roll-up of how many walk-ins were taken past the slots' walk-in caps.
      walkinOverLimit: view.reduce((sum, s) => sum + s.walkin.overLimit, 0),
      slots: view,
    };
  }
}

/**
 * Slot → availability view: available = capacity − booked (computed in app, never stored). The
 * walk-in bucket is soft-capped, so it also reports `overLimit` (booked − capacity) — how many
 * walk-ins were accepted beyond the limit.
 */
function toAvailability(s: Slot) {
  return {
    id: s.id,
    startAt: s.startAt,
    endAt: s.endAt,
    mode: s.mode,
    status: s.status,
    appt: {
      capacity: s.apptCapacity,
      booked: s.apptBooked,
      available: Math.max(0, s.apptCapacity - s.apptBooked),
    },
    walkin: {
      capacity: s.walkinCapacity,
      booked: s.walkinBooked,
      available: Math.max(0, s.walkinCapacity - s.walkinBooked),
      overLimit: Math.max(0, s.walkinBooked - s.walkinCapacity),
    },
  };
}
