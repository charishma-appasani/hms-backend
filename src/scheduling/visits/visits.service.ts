import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ScopedPrismaService } from '../../prisma/scoped-prisma.service';
import { dayWindowUtc } from '../../common/datetime';
import { nextSequence } from '../../common/sequence';
import type {
  Prisma,
  Visit,
  VisitStatus,
} from '../../../generated/prisma/client';
import type {
  QueueQueryDto,
  UpdateVisitStatusDto,
  VisitVitalsDto,
} from './dto/visit.dto';

const PATIENT_INCLUDE = {
  patient: {
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true, phone: true } },
    },
  },
} as const;

/** Allowed visit status transitions (the OPD lifecycle). */
const TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  checked_in: ['in_consultation', 'cancelled'],
  in_consultation: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

// An appointment is checkable from these states (scheduled `confirmed`, or a walk-in `checked_in`).
const CHECKABLE = ['confirmed', 'checked_in'];

/**
 * Visits = the actual OPD episode (appointment → check-in → visit). Check-in creates the visit
 * from an appointment, assigns a per-practice gapless visit number, and carries over the queue
 * token. The clinical lifecycle then runs checked_in → in_consultation → completed (completing a
 * visit marks its appointment fulfilled). One visit per appointment.
 */
@Injectable()
export class VisitsService {
  constructor(private readonly scoped: ScopedPrismaService) {}

  async checkIn(appointmentId: string) {
    const orgId = this.scoped.orgId;
    const visit = await this.scoped.db.$transaction(async (tx) => {
      const appt = await tx.appointment.findFirst({
        where: { id: appointmentId },
        select: {
          id: true,
          practiceId: true,
          patientId: true,
          providerId: true,
          tokenNumber: true,
          status: true,
        },
      });
      if (!appt) throw new NotFoundException('Appointment not found');
      if (!CHECKABLE.includes(appt.status)) {
        throw new ConflictException(
          `Cannot check in an appointment in status '${appt.status}'`,
        );
      }
      const already = await tx.visit.findFirst({
        where: { appointmentId },
        select: { id: true },
      });
      if (already) throw new ConflictException('Appointment is already checked in');

      const seq = await nextSequence(tx, {
        orgId,
        scope: 'practice',
        scopeId: appt.practiceId,
        name: 'visit',
      });
      const visitNumber = `V${String(seq).padStart(6, '0')}`;

      const created = await tx.visit.create({
        data: {
          orgId,
          practiceId: appt.practiceId,
          patientId: appt.patientId,
          providerId: appt.providerId,
          appointmentId: appt.id,
          visitNumber,
          tokenNumber: appt.tokenNumber ?? 0,
          status: 'checked_in',
        },
        include: PATIENT_INCLUDE,
      });

      if (appt.status !== 'checked_in') {
        await tx.appointment.update({
          where: { id: appointmentId },
          data: { status: 'checked_in' },
        });
      }
      return created;
    });
    return toResponse(visit);
  }

  /** Live OP queue: a practice's visits (optionally one provider / one day), in token order. */
  async queue(filter: QueueQueryDto) {
    const where: Prisma.VisitWhereInput = {
      practiceId: filter.practiceId,
      providerId: filter.providerId,
    };
    if (filter.date) {
      const practice = await this.scoped.db.practice.findFirst({
        where: { id: filter.practiceId },
        select: { timezone: true },
      });
      if (!practice) {
        throw new BadRequestException(
          'practiceId does not reference a practice in this organization',
        );
      }
      const { dayStart, dayEnd } = dayWindowUtc(filter.date, practice.timezone);
      where.checkInAt = { gte: dayStart, lt: dayEnd };
    }
    const rows = await this.scoped.db.visit.findMany({
      where,
      orderBy: [{ tokenNumber: 'asc' }, { checkInAt: 'asc' }],
      include: PATIENT_INCLUDE,
    });
    return rows.map(toResponse);
  }

  async get(id: string) {
    const visit = await this.scoped.db.visit.findFirst({
      where: { id },
      include: PATIENT_INCLUDE,
    });
    if (!visit) throw new NotFoundException('Visit not found');
    return toResponse(visit);
  }

  async updateStatus(id: string, dto: UpdateVisitStatusDto) {
    const visit = await this.scoped.db.$transaction(async (tx) => {
      const current = await tx.visit.findFirst({
        where: { id },
        select: { id: true, status: true, appointmentId: true },
      });
      if (!current) throw new NotFoundException('Visit not found');
      if (!TRANSITIONS[current.status].includes(dto.status)) {
        throw new ConflictException(
          `Cannot move a visit from '${current.status}' to '${dto.status}'`,
        );
      }

      const data: Prisma.VisitUpdateInput = { status: dto.status };
      if (dto.status === 'in_consultation') data.startedAt = new Date();
      if (dto.status === 'completed') data.completedAt = new Date();

      const updated = await tx.visit.update({
        where: { id },
        data,
        include: PATIENT_INCLUDE,
      });

      // Completing the visit fulfils its appointment (closes the OPD loop).
      if (dto.status === 'completed' && current.appointmentId) {
        await tx.appointment.update({
          where: { id: current.appointmentId },
          data: { status: 'fulfilled' },
        });
      }
      return updated;
    });
    return toResponse(visit);
  }

  async setVitals(id: string, dto: VisitVitalsDto) {
    return this.scoped.db.visit
      .update({
        where: { id },
        data: { vitals: dto.vitals, notes: dto.notes },
        include: PATIENT_INCLUDE,
      })
      .then(toResponse)
      .catch((err: unknown) => {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          err.code === 'P2025'
        ) {
          throw new NotFoundException('Visit not found');
        }
        throw err;
      });
  }
}

type VisitWithPatient = Visit & {
  patient: {
    id: string;
    user: { firstName: string; lastName: string | null; phone: string | null };
  };
};

function toResponse(v: VisitWithPatient) {
  return {
    id: v.id,
    practiceId: v.practiceId,
    providerId: v.providerId,
    appointmentId: v.appointmentId,
    patient: {
      id: v.patient.id,
      firstName: v.patient.user.firstName,
      lastName: v.patient.user.lastName,
      phone: v.patient.user.phone,
    },
    visitNumber: v.visitNumber,
    tokenNumber: v.tokenNumber,
    status: v.status,
    checkInAt: v.checkInAt,
    startedAt: v.startedAt,
    completedAt: v.completedAt,
    vitals: v.vitals,
    notes: v.notes,
  };
}
