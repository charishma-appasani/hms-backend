import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
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
  CreatePrescriptionDto,
  CreateTestOrderDto,
  QueueQueryDto,
  UpdateClinicalDto,
  UpdateTestOrderDto,
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
  private readonly logger = new Logger(VisitsService.name);

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
      if (already)
        throw new ConflictException('Appointment is already checked in');

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
    this.logger.log(
      `Visit checked in: visit=${visit.id} visitNumber=${visit.visitNumber} appointment=${appointmentId} patient=${visit.patientId} token=${visit.tokenNumber}`,
    );
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

  /**
   * A patient's past visits AT THIS ORG, newest first — the consultation page's history panel.
   * Summaries only; the panel fetches `get()` for a full past record (incl. prescriptions).
   */
  async historyForPatient(patientId: string) {
    const rows = await this.scoped.db.visit.findMany({
      where: { patientId },
      orderBy: { checkInAt: 'desc' },
      include: {
        practice: { select: { name: true } },
        provider: {
          select: {
            specialty: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    return rows.map((v) => ({
      id: v.id,
      visitNumber: v.visitNumber,
      status: v.status,
      checkInAt: v.checkInAt,
      completedAt: v.completedAt,
      practiceName: v.practice.name,
      providerName:
        `${v.provider.user.firstName} ${v.provider.user.lastName ?? ''}`.trim(),
      diagnosis: v.diagnosis,
      vitals: v.vitals, // feeds the consultation page's vitals-trends sparklines
    }));
  }

  async get(id: string) {
    const visit = await this.scoped.db.visit.findFirst({
      where: { id },
      include: {
        ...PATIENT_INCLUDE,
        practice: { select: { name: true, org: { select: { name: true } } } },
        provider: {
          select: {
            specialty: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
        prescriptions: { orderBy: { createdAt: 'asc' } },
        testOrders: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!visit) throw new NotFoundException('Visit not found');
    const providerName =
      `${visit.provider.user.firstName} ${visit.provider.user.lastName ?? ''}`.trim();
    return {
      ...toResponse(visit),
      orgName: visit.practice.org.name,
      practiceName: visit.practice.name,
      providerName: visit.provider.specialty
        ? `${providerName} (${visit.provider.specialty})`
        : providerName,
      ...clinicalRecord(visit),
    };
  }

  async updateStatus(id: string, dto: UpdateVisitStatusDto) {
    const { visit, previousStatus } = await this.scoped.db.$transaction(
      async (tx) => {
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
        return { visit: updated, previousStatus: current.status };
      },
    );
    this.logger.log(
      `Visit status changed: visit=${id} ${previousStatus} -> ${dto.status} patient=${visit.patientId}`,
    );
    return toResponse(visit);
  }

  setVitals(id: string, dto: VisitVitalsDto) {
    return this.updateVisit(id, { vitals: dto.vitals, notes: dto.notes });
  }

  /** Record the clinical narrative (presenting symptoms / diagnosis / general notes). */
  setClinical(id: string, dto: UpdateClinicalDto) {
    return this.updateVisit(id, {
      symptoms: dto.symptoms,
      diagnosis: dto.diagnosis,
      notes: dto.notes,
    });
  }

  /** Add a prescription line to a visit. */
  async addPrescription(visitId: string, dto: CreatePrescriptionDto) {
    await this.assertVisit(visitId);
    // orgId is re-injected by the scoped client at runtime; passed here only to satisfy the type.
    const created = await this.scoped.db.prescription.create({
      data: { orgId: this.scoped.orgId, visitId, ...dto },
    });
    this.logger.log(`Prescription added: id=${created.id} visit=${visitId}`);
    return created;
  }

  async removePrescription(
    visitId: string,
    prescriptionId: string,
  ): Promise<void> {
    const { count } = await this.scoped.db.prescription.deleteMany({
      where: { id: prescriptionId, visitId },
    });
    if (count === 0) throw new NotFoundException('Prescription not found');
    this.logger.log(
      `Prescription removed: id=${prescriptionId} visit=${visitId}`,
    );
  }

  /** Order a test/investigation on a visit. */
  async addTestOrder(visitId: string, dto: CreateTestOrderDto) {
    await this.assertVisit(visitId);
    const created = await this.scoped.db.testOrder.create({
      data: { orgId: this.scoped.orgId, visitId, ...dto },
    });
    this.logger.log(`Test order added: id=${created.id} visit=${visitId}`);
    return created;
  }

  /** Update a test order's status and/or result (e.g. once the lab reports back). */
  async updateTestOrder(
    visitId: string,
    testOrderId: string,
    dto: UpdateTestOrderDto,
  ) {
    const { count } = await this.scoped.db.testOrder.updateMany({
      where: { id: testOrderId, visitId },
      data: { status: dto.status, result: dto.result },
    });
    if (count === 0) throw new NotFoundException('Test order not found');
    const updated = await this.scoped.db.testOrder.findFirst({
      where: { id: testOrderId, visitId },
    });
    return updated;
  }

  async removeTestOrder(visitId: string, testOrderId: string): Promise<void> {
    const { count } = await this.scoped.db.testOrder.deleteMany({
      where: { id: testOrderId, visitId },
    });
    if (count === 0) throw new NotFoundException('Test order not found');
  }

  /** Shared visit-field update with a friendly 404 (used by vitals + clinical narrative). */
  private updateVisit(id: string, data: Prisma.VisitUpdateInput) {
    return this.scoped.db.visit
      .update({ where: { id }, data, include: PATIENT_INCLUDE })
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

  /** Confirm the visit exists in this org before attaching clinical children. */
  private async assertVisit(id: string): Promise<void> {
    const visit = await this.scoped.db.visit.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!visit) throw new NotFoundException('Visit not found');
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
    symptoms: v.symptoms,
    diagnosis: v.diagnosis,
    notes: v.notes,
  };
}

/** The clinical children (prescriptions + test orders) for a visit detail view. */
function clinicalRecord(v: {
  prescriptions: {
    id: string;
    drug: string;
    dosage: string | null;
    frequency: string | null;
    duration: string | null;
    instructions: string | null;
  }[];
  testOrders: {
    id: string;
    name: string;
    instructions: string | null;
    status: string;
    result: string | null;
  }[];
}) {
  return {
    prescriptions: v.prescriptions.map((p) => ({
      id: p.id,
      drug: p.drug,
      dosage: p.dosage,
      frequency: p.frequency,
      duration: p.duration,
      instructions: p.instructions,
    })),
    testOrders: v.testOrders.map((t) => ({
      id: t.id,
      name: t.name,
      instructions: t.instructions,
      status: t.status,
      result: t.result,
    })),
  };
}
