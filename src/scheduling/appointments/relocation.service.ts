import { Injectable } from '@nestjs/common';
import { ScopedPrismaService } from '../../prisma/scoped-prisma.service';
import { AppointmentsService } from './appointments.service';
import { NotificationService } from '../../notifications/notification.service';
import type {
  NotificationEvent,
  NotificationRecipient,
} from '../../notifications/notification.types';
import { formatDateOnly } from '../../common/datetime';
import type { AppointmentStatus } from '../../../generated/prisma/client';

/** The fields a displaced appointment needs to be relocated + the patient notified. */
export interface RelocatableAppointment {
  id: string;
  status: AppointmentStatus;
  providerId: string;
  practiceId: string;
  slotId: string;
  sessionDate: Date;
  tokenNumber: number | null;
  slot: { startAt: Date };
  patient: {
    user: { firstName: string; email: string | null; phone: string | null };
  };
}

export interface RelocationResult {
  rescheduled: {
    previousAppointmentId: string;
    appointment: Awaited<ReturnType<AppointmentsService['reschedule']>>;
  }[];
  cancelled: string[];
  needsAttention: { appointmentId: string; reason: string }[];
}

/** Prisma select that produces a RelocatableAppointment (reuse so callers stay in sync). */
export const RELOCATABLE_SELECT = {
  id: true,
  status: true,
  providerId: true,
  practiceId: true,
  slotId: true,
  sessionDate: true,
  tokenNumber: true,
  slot: { select: { startAt: true } },
  patient: {
    select: {
      user: { select: { firstName: true, email: true, phone: true } },
    },
  },
} as const;

/**
 * Relocates appointments displaced by a schedule change (a block, or a template drop/replace), and
 * notifies each patient. `migrate: true` moves each future booking to its nearest open slot
 * (cancelling only if none); `migrate: false` cancels them outright. Already checked-in patients
 * (present) are never auto-moved — they're returned in `needsAttention` for manual handling.
 *
 * Callers should block/remove the source slots BEFORE calling with `migrate: true`, so the
 * nearest-slot search can't pick a slot that's about to disappear.
 */
@Injectable()
export class RelocationService {
  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly appointments: AppointmentsService,
    private readonly notifications: NotificationService,
  ) {}

  async relocate(
    appointments: RelocatableAppointment[],
    opts: { migrate: boolean; reason: string },
  ): Promise<RelocationResult> {
    const result: RelocationResult = {
      rescheduled: [],
      cancelled: [],
      needsAttention: [],
    };

    for (const appt of appointments) {
      const recipient: NotificationRecipient = {
        name: appt.patient.user.firstName,
        email: appt.patient.user.email,
        phone: appt.patient.user.phone,
      };
      const from = {
        sessionDate: formatDateOnly(appt.sessionDate),
        tokenNumber: appt.tokenNumber,
      };

      if (appt.status === 'checked_in') {
        result.needsAttention.push({ appointmentId: appt.id, reason: appt.status });
        continue;
      }

      if (opts.migrate) {
        const target = await this.findNearestOpenSlot(
          appt.providerId,
          appt.practiceId,
          appt.slot.startAt,
          appt.slotId,
        );
        if (target) {
          try {
            const moved = await this.appointments.reschedule(appt.id, target);
            result.rescheduled.push({
              previousAppointmentId: appt.id,
              appointment: moved,
            });
            await this.notify(recipient, {
              kind: 'appointment_rescheduled',
              reason: opts.reason,
              from,
              to: {
                sessionDate: moved.sessionDate,
                tokenNumber: moved.tokenNumber,
              },
            });
            continue;
          } catch {
            // target filled in a race → fall through to cancel
          }
        }
      }

      await this.appointments.cancel(appt.id);
      result.cancelled.push(appt.id);
      await this.notify(recipient, {
        kind: 'appointment_cancelled',
        reason: opts.reason,
        appointment: from,
      });
    }

    return result;
  }

  /** Nearest future open slot with appt capacity for the same provider+practice (by time distance). */
  private async findNearestOpenSlot(
    providerId: string,
    practiceId: string,
    around: Date,
    excludeSlotId: string,
  ): Promise<string | null> {
    const candidates = await this.scoped.db.slot.findMany({
      where: {
        providerId,
        practiceId,
        status: 'open',
        startAt: { gt: new Date() },
        id: { not: excludeSlotId },
      },
      select: { id: true, startAt: true, apptCapacity: true, apptBooked: true },
    });
    const open = candidates.filter((c) => c.apptBooked < c.apptCapacity);
    if (open.length === 0) return null;
    const t = around.getTime();
    open.sort(
      (a, b) =>
        Math.abs(a.startAt.getTime() - t) - Math.abs(b.startAt.getTime() - t),
    );
    return open[0].id;
  }

  /** Best-effort patient notification (never blocks the schedule change). */
  private async notify(
    recipient: NotificationRecipient,
    event: NotificationEvent,
  ): Promise<void> {
    try {
      await this.notifications.notify(recipient, event);
    } catch {
      // swallowed
    }
  }
}
