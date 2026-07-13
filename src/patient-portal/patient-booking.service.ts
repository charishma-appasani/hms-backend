import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { nextSequence } from '../common/sequence';
import { formatUhid, DEFAULT_UHID_FORMAT } from '../common/uhid';
import { formatDateOnly, utcToZonedDateOnly } from '../common/datetime';
import {
  reserveSeat,
  releaseSeat,
} from '../scheduling/appointments/appointments.service';
import type { AppointmentStatus, Prisma } from '../../generated/prisma/client';
import type { SelfBookDto } from './dto/directory.dto';

const CANCELLABLE: AppointmentStatus[] = ['requested', 'confirmed'];
const RESCHEDULABLE: AppointmentStatus[] = ['requested', 'confirmed'];

const APPT_VIEW = {
  practice: { select: { name: true, org: { select: { name: true } } } },
  provider: {
    select: { specialty: true, user: { select: { firstName: true, lastName: true } } },
  },
  patient: {
    select: { user: { select: { firstName: true, phone: true, email: true } } },
  },
} as const;

/**
 * Patient-initiated booking (Part B). Unlike the staff path (org-scoped), this runs WITHOUT an org
 * context — everything is derived from the slot — and **auto-registers** the patient at the slot's
 * org on their first appointment there (no staff action, no OTP; the patient self-acts so consent is
 * inherent). No-oversell uses the same atomic seat helpers as the staff path. channel = `patient_app`.
 */
@Injectable()
export class PatientBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  async book(patientId: string, dto: SelfBookDto) {
    const slot = await this.prisma.slot.findFirst({
      where: { id: dto.slotId },
      select: {
        id: true,
        orgId: true,
        practiceId: true,
        providerId: true,
        mode: true,
        startAt: true,
        practice: { select: { timezone: true } },
        org: { select: { uhidFormat: true, approvedAt: true } },
      },
    });
    if (!slot) throw new NotFoundException('Slot not found');
    // Unapproved orgs are invisible in the directory — also block deep-linked bookings.
    if (!slot.org.approvedAt) {
      throw new NotFoundException('Slot not found');
    }

    const sessionDate = utcToZonedDateOnly(slot.startAt, slot.practice.timezone);

    const appointment = await this.prisma.$transaction(async (tx) => {
      // 1. Secure the seat (hard-capped appt bucket) — fails if full/blocked.
      const reserved = await reserveSeat(tx, slot.id, slot.orgId, 'appt');
      if (!reserved) {
        throw new ConflictException('Slot is no longer available (full or blocked)');
      }
      // 2. Auto-register at this org on first booking.
      await this.ensureRegistration(tx, slot.orgId, patientId, slot.org.uhidFormat);
      // 3. Create the appointment (one shared queue token).
      const tokenNumber = reserved.apptBooked + reserved.walkinBooked;
      return tx.appointment.create({
        data: {
          orgId: slot.orgId,
          practiceId: slot.practiceId,
          patientId,
          providerId: slot.providerId,
          slotId: slot.id,
          mode: slot.mode,
          sessionDate,
          tokenNumber,
          apptType: dto.apptType,
          channel: 'patient_app',
          status: 'confirmed',
          reason: dto.reason,
        },
        include: APPT_VIEW,
      });
    });

    await this.audit.record({
      action: 'appointment.book',
      entityType: 'appointment',
      entityId: appointment.id,
      patientId,
      orgId: slot.orgId,
      metadata: { slotId: slot.id, tokenNumber: appointment.tokenNumber, channel: 'patient_app', via: 'patient' },
    });
    const response = toResponse(appointment);
    await this.notifications.notify(recipientOf(appointment), {
      kind: 'appointment_booked',
      orgName: response.orgName,
      providerName: response.providerName,
      appointment: { sessionDate: response.sessionDate, tokenNumber: response.tokenNumber },
    });
    return response;
  }

  async cancel(patientId: string, appointmentId: string) {
    const appointment = await this.prisma.$transaction(async (tx) => {
      const appt = await tx.appointment.findFirst({
        where: { id: appointmentId, patientId },
        select: { id: true, slotId: true, orgId: true, channel: true, status: true },
      });
      if (!appt) throw new NotFoundException('Appointment not found');
      if (!CANCELLABLE.includes(appt.status)) {
        throw new ConflictException(`Cannot cancel an appointment in status '${appt.status}'`);
      }
      await releaseSeat(tx, appt.slotId, appt.orgId, appt.channel === 'walk_in' ? 'walkin' : 'appt');
      return tx.appointment.update({
        where: { id: appointmentId },
        data: { status: 'cancelled' },
        include: APPT_VIEW,
      });
    });
    await this.audit.record({
      action: 'appointment.cancel',
      entityType: 'appointment',
      entityId: appointment.id,
      patientId,
      orgId: appointment.orgId,
      metadata: { slotId: appointment.slotId, via: 'patient' },
    });
    const response = toResponse(appointment);
    await this.notifications.notify(recipientOf(appointment), {
      kind: 'appointment_cancelled',
      appointment: { sessionDate: response.sessionDate, tokenNumber: response.tokenNumber },
    });
    return response;
  }

  async reschedule(patientId: string, appointmentId: string, newSlotId: string) {
    const old = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, patientId },
      select: { id: true, slotId: true, orgId: true, channel: true, status: true, apptType: true, reason: true },
    });
    if (!old) throw new NotFoundException('Appointment not found');
    if (!RESCHEDULABLE.includes(old.status)) {
      throw new ConflictException(`Cannot reschedule an appointment in status '${old.status}'`);
    }
    if (newSlotId === old.slotId) {
      throw new ConflictException('New slot is the same as the current slot');
    }

    const newSlot = await this.prisma.slot.findFirst({
      where: { id: newSlotId },
      select: {
        id: true, orgId: true, practiceId: true, providerId: true, mode: true,
        startAt: true, practice: { select: { timezone: true } },
        org: { select: { uhidFormat: true, approvedAt: true } },
      },
    });
    if (!newSlot) throw new NotFoundException('Slot not found');
    if (!newSlot.org.approvedAt) throw new NotFoundException('Slot not found');
    const sessionDate = utcToZonedDateOnly(newSlot.startAt, newSlot.practice.timezone);

    const created = await this.prisma.$transaction(async (tx) => {
      const reserved = await reserveSeat(tx, newSlot.id, newSlot.orgId, 'appt');
      if (!reserved) {
        throw new ConflictException('The new slot is no longer available (full or blocked)');
      }
      // Reschedule may cross orgs (different clinic) → ensure a registration at the target org.
      await this.ensureRegistration(tx, newSlot.orgId, patientId, newSlot.org.uhidFormat);
      const tokenNumber = reserved.apptBooked + reserved.walkinBooked;
      await releaseSeat(tx, old.slotId, old.orgId, old.channel === 'walk_in' ? 'walkin' : 'appt');
      await tx.appointment.update({ where: { id: old.id }, data: { status: 'rescheduled' } });
      return tx.appointment.create({
        data: {
          orgId: newSlot.orgId,
          practiceId: newSlot.practiceId,
          patientId,
          providerId: newSlot.providerId,
          slotId: newSlot.id,
          mode: newSlot.mode,
          sessionDate,
          tokenNumber,
          apptType: old.apptType,
          channel: 'patient_app',
          status: 'confirmed',
          reason: old.reason ?? undefined,
          rescheduledFromId: old.id,
        },
        include: APPT_VIEW,
      });
    });
    await this.audit.record({
      action: 'appointment.reschedule',
      entityType: 'appointment',
      entityId: created.id,
      patientId,
      orgId: newSlot.orgId,
      metadata: { fromAppointmentId: old.id, toSlotId: newSlot.id, via: 'patient' },
    });
    return toResponse(created);
  }

  /** Find the patient's registration at an org, or create one (with a fresh UHID) on first booking. */
  private async ensureRegistration(
    tx: Pick<Prisma.TransactionClient, 'patientRegistration' | '$queryRaw'>,
    orgId: string,
    patientId: string,
    uhidFormat: string | null,
  ): Promise<void> {
    const existing = await tx.patientRegistration.findFirst({
      where: { orgId, patientId, deletedAt: null },
      select: { id: true },
    });
    if (existing) return;
    const seq = await nextSequence(tx, { orgId, scope: 'org', scopeId: orgId, name: 'uhid' });
    await tx.patientRegistration.create({
      data: {
        orgId,
        patientId,
        uhid: formatUhid(uhidFormat ?? DEFAULT_UHID_FORMAT, seq),
        status: 'active',
      },
    });
  }
}

type AppointmentView = {
  id: string;
  sessionDate: Date;
  tokenNumber: number | null;
  status: AppointmentStatus;
  channel: string;
  practice: { name: string; org: { name: string } };
  provider: { specialty: string | null; user: { firstName: string; lastName: string | null } };
  patient: { user: { firstName: string; phone: string | null; email: string | null } };
};

function recipientOf(a: AppointmentView) {
  return {
    name: a.patient.user.firstName,
    email: a.patient.user.email,
    phone: a.patient.user.phone,
  };
}

function toResponse(a: AppointmentView) {
  return {
    id: a.id,
    orgName: a.practice.org.name,
    practiceName: a.practice.name,
    providerName: `${a.provider.user.firstName} ${a.provider.user.lastName ?? ''}`.trim(),
    sessionDate: formatDateOnly(a.sessionDate),
    tokenNumber: a.tokenNumber,
    status: a.status,
    channel: a.channel,
  };
}
