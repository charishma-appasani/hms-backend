import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ScopedPrismaService } from '../../prisma/scoped-prisma.service';
import { AuditService } from '../../audit/audit.service';
import { formatDateOnly, utcToZonedDateOnly } from '../../common/datetime';
import { parseDateOnly } from '../../common/datetime';
import type {
  Appointment,
  AppointmentChannel,
  AppointmentStatus,
  AppointmentType,
  Prisma,
} from '../../../generated/prisma/client';
import type {
  BookAppointmentDto,
  WalkInDto,
} from './dto/book-appointment.dto';

/** Which slot capacity bucket a channel draws on. */
type Bucket = 'appt' | 'walkin';

const PATIENT_INCLUDE = {
  patient: {
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true, phone: true } },
    },
  },
} as const;

const CANCELLABLE: AppointmentStatus[] = ['requested', 'confirmed', 'checked_in'];
// Manual reschedule covers walk-ins too (checked_in) — a still-waiting visit is cancelled. (The
// block auto-relocate flow uses a narrower set: it never moves a checked-in/present patient.)
const RESCHEDULABLE: AppointmentStatus[] = ['requested', 'confirmed', 'checked_in'];

export interface ListAppointmentsFilter {
  providerId?: string;
  patientId?: string;
  date?: string;
  status?: AppointmentStatus;
}

/**
 * Appointment booking + walk-ins + cancellation. The no-oversell guarantee is a single atomic
 * conditional UPDATE on the slot's bucket (`booked < capacity`) — done via parameterized raw SQL
 * because Prisma can't compare a column to another column in `where`. Booking the seat and writing
 * the appointment share one transaction, so a failed insert releases the seat.
 *
 * token# = running total of the slot's appt + walk-in bookings (one shared queue per session).
 */
@Injectable()
export class AppointmentsService {
  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly audit: AuditService,
  ) {}

  book(dto: BookAppointmentDto) {
    return this.createBooking(dto.slotId, dto.patientId, {
      bucket: 'appt',
      channel: dto.channel,
      status: 'confirmed',
      apptType: dto.apptType,
      reason: dto.reason,
    });
  }

  walkIn(dto: WalkInDto) {
    // Walk-ins collapse booking + check-in: created already checked-in, on the walk-in bucket.
    return this.createBooking(dto.slotId, dto.patientId, {
      bucket: 'walkin',
      channel: 'walk_in',
      status: 'checked_in',
      apptType: dto.apptType,
      reason: dto.reason,
    });
  }

  private async createBooking(
    slotId: string,
    patientId: string,
    opts: {
      bucket: Bucket;
      channel: AppointmentChannel;
      status: AppointmentStatus;
      apptType: AppointmentType;
      reason?: string;
    },
  ) {
    const slot = await this.scoped.db.slot.findFirst({
      where: { id: slotId },
      select: {
        id: true,
        practiceId: true,
        providerId: true,
        mode: true,
        startAt: true,
        walkinCapacity: true,
        practice: { select: { timezone: true } },
      },
    });
    if (!slot) throw new NotFoundException('Slot not found');

    const registration = await this.scoped.db.patientRegistration.findFirst({
      where: { patientId, status: 'active' },
      select: { id: true },
    });
    if (!registration) {
      throw new BadRequestException(
        'Patient is not registered at this organization',
      );
    }

    const sessionDate = utcToZonedDateOnly(slot.startAt, slot.practice.timezone);
    const orgId = this.scoped.orgId;

    const { appointment, reserved } = await this.scoped.db.$transaction(
      async (tx) => {
        // token# = appt + walk-in (one shared queue), from the post-reserve counters.
        const reserved = await reserveSeat(tx, slotId, orgId, opts.bucket);
        if (!reserved) {
          throw new ConflictException(
            'Slot is no longer available (full or blocked)',
          );
        }
        const tokenNumber = reserved.apptBooked + reserved.walkinBooked;

        const appointment = await tx.appointment.create({
          data: {
            orgId,
            practiceId: slot.practiceId,
            patientId,
            providerId: slot.providerId,
            slotId,
            mode: slot.mode,
            sessionDate,
            tokenNumber,
            apptType: opts.apptType,
            channel: opts.channel,
            status: opts.status,
            reason: opts.reason,
          },
          include: PATIENT_INCLUDE,
        });
        return { appointment, reserved };
      },
    );

    const response = toResponse(appointment);
    if (opts.bucket !== 'walkin') {
      await this.audit.record({
        action: 'appointment.book',
        entityType: 'appointment',
        entityId: appointment.id,
        patientId,
        metadata: { slotId, tokenNumber: appointment.tokenNumber, channel: opts.channel },
      });
      return response;
    }
    // Soft-capped bucket: tell the front desk how far past the walk-in limit this slot now is.
    const overLimit = Math.max(0, reserved.walkinBooked - slot.walkinCapacity);
    await this.audit.record({
      action: 'appointment.walkin',
      entityType: 'appointment',
      entityId: appointment.id,
      patientId,
      metadata: { slotId, tokenNumber: appointment.tokenNumber, walkinOverLimit: overLimit },
    });
    return { ...response, walkinOverbooked: overLimit > 0, walkinOverLimit: overLimit };
  }

  list(filter: ListAppointmentsFilter) {
    const where: Prisma.AppointmentWhereInput = {
      providerId: filter.providerId,
      patientId: filter.patientId,
      status: filter.status,
      sessionDate: filter.date ? parseDateOnly(filter.date) : undefined,
    };
    return this.scoped.db.appointment
      .findMany({
        where,
        orderBy: [{ sessionDate: 'asc' }, { tokenNumber: 'asc' }],
        include: PATIENT_INCLUDE,
      })
      .then((rows) => rows.map(toResponse));
  }

  async get(id: string) {
    const appt = await this.scoped.db.appointment.findFirst({
      where: { id },
      include: {
        ...PATIENT_INCLUDE,
        rescheduledFrom: { select: APPT_SUMMARY }, // the original, if this came from a reschedule
      },
    });
    if (!appt) throw new NotFoundException('Appointment not found');
    return {
      ...toResponse(appt),
      rescheduledFrom: appt.rescheduledFrom
        ? toSummary(appt.rescheduledFrom)
        : null,
    };
  }

  /** Cancel an active appointment and atomically release its seat back to the slot bucket. */
  async cancel(id: string) {
    const orgId = this.scoped.orgId;
    const { appointment, previousStatus } = await this.scoped.db.$transaction(
      async (tx) => {
        const appt = await tx.appointment.findFirst({
          where: { id },
          select: { id: true, slotId: true, channel: true, status: true },
        });
        if (!appt) throw new NotFoundException('Appointment not found');
        if (!CANCELLABLE.includes(appt.status)) {
          throw new ConflictException(
            `Cannot cancel an appointment in status '${appt.status}'`,
          );
        }

        const bucket: Bucket = appt.channel === 'walk_in' ? 'walkin' : 'appt';
        await releaseSeat(tx, appt.slotId, orgId, bucket);

        const appointment = await tx.appointment.update({
          where: { id },
          data: { status: 'cancelled' },
          include: PATIENT_INCLUDE,
        });
        return { appointment, previousStatus: appt.status };
      },
    );
    await this.audit.record({
      action: 'appointment.cancel',
      entityType: 'appointment',
      entityId: appointment.id,
      patientId: appointment.patientId,
      metadata: { slotId: appointment.slotId, previousStatus },
    });
    return toResponse(appointment);
  }

  /**
   * Move an appointment to another slot — works for BOTH scheduled bookings and walk-ins.
   * History-preserving: the old appointment is marked `rescheduled` (its seat released from its
   * own bucket) and a NEW `confirmed` appointment is created on the target slot's appt bucket,
   * linked back via `rescheduledFromId` so the UI can show both. If the patient was already checked
   * in, a still-waiting visit is cancelled (you can't move someone mid-consultation). All atomic —
   * the old seat is given up only once the new one is secured.
   */
  async reschedule(id: string, newSlotId: string) {
    const orgId = this.scoped.orgId;
    const old = await this.scoped.db.appointment.findFirst({
      where: { id },
      select: {
        id: true,
        slotId: true,
        patientId: true,
        channel: true,
        status: true,
        apptType: true,
        reason: true,
      },
    });
    if (!old) throw new NotFoundException('Appointment not found');
    if (!RESCHEDULABLE.includes(old.status)) {
      throw new ConflictException(
        `Cannot reschedule an appointment in status '${old.status}'`,
      );
    }
    if (newSlotId === old.slotId) {
      throw new BadRequestException('New slot is the same as the current slot');
    }

    // A checked-in patient can be moved only while still waiting (not mid/after consultation).
    const visit = await this.scoped.db.visit.findFirst({
      where: { appointmentId: id },
      select: { id: true, status: true },
    });
    if (visit && visit.status !== 'checked_in') {
      throw new ConflictException(
        `Cannot reschedule: the visit is '${visit.status}'`,
      );
    }

    const newSlot = await this.scoped.db.slot.findFirst({
      where: { id: newSlotId },
      select: {
        id: true,
        practiceId: true,
        providerId: true,
        mode: true,
        startAt: true,
        practice: { select: { timezone: true } },
      },
    });
    if (!newSlot) throw new NotFoundException('Slot not found');
    const sessionDate = utcToZonedDateOnly(
      newSlot.startAt,
      newSlot.practice.timezone,
    );
    const oldBucket: Bucket = old.channel === 'walk_in' ? 'walkin' : 'appt';

    const created = await this.scoped.db.$transaction(async (tx) => {
      // Secure the new seat (always the appt bucket — it's now a scheduled booking) first.
      const reserved = await reserveSeat(tx, newSlotId, orgId, 'appt');
      if (!reserved) {
        throw new ConflictException(
          'The new slot is no longer available (full or blocked)',
        );
      }
      const tokenNumber = reserved.apptBooked + reserved.walkinBooked;
      await releaseSeat(tx, old.slotId, orgId, oldBucket);
      if (visit) {
        await tx.visit.update({
          where: { id: visit.id },
          data: { status: 'cancelled' },
        });
      }
      await tx.appointment.update({
        where: { id },
        data: { status: 'rescheduled' },
      });
      return tx.appointment.create({
        data: {
          orgId,
          practiceId: newSlot.practiceId,
          patientId: old.patientId,
          providerId: newSlot.providerId,
          slotId: newSlotId,
          mode: newSlot.mode,
          sessionDate,
          tokenNumber,
          apptType: old.apptType,
          channel: old.channel,
          status: 'confirmed',
          reason: old.reason ?? undefined,
          rescheduledFromId: id,
        },
        include: PATIENT_INCLUDE,
      });
    });
    await this.audit.record({
      action: 'appointment.reschedule',
      entityType: 'appointment',
      entityId: created.id,
      patientId: created.patientId,
      metadata: {
        fromAppointmentId: id,
        fromSlotId: old.slotId,
        toSlotId: newSlotId,
        tokenNumber: created.tokenNumber,
      },
    });
    return toResponse(created);
  }
}

interface SeatCounters {
  apptBooked: number;
  walkinBooked: number;
}

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRawUnsafe'>;

/**
 * Atomically reserve a seat in a slot's bucket (a single conditional UPDATE — column<column isn't
 * expressible in Prisma `where`; org_id is in the WHERE because raw SQL bypasses the scoped
 * client's filter). Returns post-increment counters, or null if the slot was blocked/missing.
 *
 * The two buckets differ on capacity: the `appt` bucket is HARD-capped (`appt_booked <
 * appt_capacity`) — scheduled bookings never oversell. The `walkin` bucket is SOFT-capped: a
 * walk-in is accepted into any open slot regardless of `walkin_capacity` (front desk can't turn
 * people away), and the overflow is reported separately (booked − capacity).
 */
async function reserveSeat(
  tx: RawTx,
  slotId: string,
  orgId: string,
  bucket: Bucket,
): Promise<SeatCounters | null> {
  const rows =
    bucket === 'appt'
      ? await tx.$queryRaw<SeatCounters[]>`
          UPDATE "slot" SET appt_booked = appt_booked + 1, updated_at = now()
           WHERE id = ${slotId}::uuid AND org_id = ${orgId}::uuid
             AND status = 'open' AND appt_booked < appt_capacity
          RETURNING appt_booked AS "apptBooked", walkin_booked AS "walkinBooked"`
      : await tx.$queryRaw<SeatCounters[]>`
          UPDATE "slot" SET walkin_booked = walkin_booked + 1, updated_at = now()
           WHERE id = ${slotId}::uuid AND org_id = ${orgId}::uuid
             AND status = 'open'
          RETURNING appt_booked AS "apptBooked", walkin_booked AS "walkinBooked"`;
  return rows.length ? rows[0] : null;
}

/** Release a previously-reserved seat (guarded so the counter can't go negative). */
async function releaseSeat(
  tx: RawTx,
  slotId: string,
  orgId: string,
  bucket: Bucket,
): Promise<void> {
  const column = bucket === 'walkin' ? 'walkin_booked' : 'appt_booked';
  // Column name is from a fixed two-value set, not user input.
  await tx.$executeRawUnsafe(
    `UPDATE "slot" SET ${column} = ${column} - 1, updated_at = now()
       WHERE id = $1::uuid AND org_id = $2::uuid AND ${column} > 0`,
    slotId,
    orgId,
  );
}

type AppointmentWithPatient = Appointment & {
  patient: {
    id: string;
    user: { firstName: string; lastName: string | null; phone: string | null };
  };
};

/** API shape: session date as YYYY-MM-DD; patient demographics flattened from app_user. */
function toResponse(a: AppointmentWithPatient) {
  return {
    id: a.id,
    practiceId: a.practiceId,
    providerId: a.providerId,
    slotId: a.slotId,
    patient: {
      id: a.patient.id,
      firstName: a.patient.user.firstName,
      lastName: a.patient.user.lastName,
      phone: a.patient.user.phone,
    },
    mode: a.mode,
    sessionDate: formatDateOnly(a.sessionDate),
    tokenNumber: a.tokenNumber,
    apptType: a.apptType,
    channel: a.channel,
    status: a.status,
    reason: a.reason,
    rescheduledFromId: a.rescheduledFromId,
    createdAt: a.createdAt,
  };
}

/** Compact fields for the linked (original / resulting) appointment on a reschedule chain. */
const APPT_SUMMARY = {
  id: true,
  slotId: true,
  sessionDate: true,
  tokenNumber: true,
  status: true,
  channel: true,
} as const;

type AppointmentSummary = {
  id: string;
  slotId: string;
  sessionDate: Date;
  tokenNumber: number | null;
  status: Appointment['status'];
  channel: Appointment['channel'];
};

function toSummary(a: AppointmentSummary) {
  return {
    id: a.id,
    slotId: a.slotId,
    sessionDate: formatDateOnly(a.sessionDate),
    tokenNumber: a.tokenNumber,
    status: a.status,
    channel: a.channel,
  };
}
