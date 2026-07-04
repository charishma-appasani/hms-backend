import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { formatDateOnly, parseDateOnly } from '../common/datetime';
import type { UpdateProfileDto } from './dto/profile.dto';

/** Provider (clinician) summary for patient-facing views. */
const PROVIDER_SELECT = {
  specialty: true,
  user: { select: { firstName: true, lastName: true } },
} as const;

const PRACTICE_SELECT = {
  name: true,
  timezone: true,
  org: { select: { id: true, name: true } },
} as const;

function providerName(p: {
  specialty: string | null;
  user: { firstName: string; lastName: string | null };
}): string {
  const name = `${p.user.firstName} ${p.user.lastName ?? ''}`.trim();
  return p.specialty ? `${name} (${p.specialty})` : name;
}

/**
 * Patient-facing reads of the caller's OWN record, across every org they're registered at. Uses the
 * UNSCOPED Prisma client filtered by `patientId` (a patient owns their data everywhere; there is no
 * single org context). See phase-2-patient-portal.md (Part A).
 */
@Injectable()
export class PatientPortalService {
  constructor(private readonly prisma: PrismaService) {}

  async registrations(patientId: string) {
    const rows = await this.prisma.patientRegistration.findMany({
      where: { patientId, deletedAt: null },
      include: { org: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      orgName: r.org.name,
      uhid: r.uhid,
      status: r.status,
    }));
  }

  async appointments(patientId: string) {
    const rows = await this.prisma.appointment.findMany({
      where: { patientId, deletedAt: null },
      include: {
        practice: { select: PRACTICE_SELECT },
        provider: { select: PROVIDER_SELECT },
      },
      orderBy: [{ sessionDate: 'desc' }, { tokenNumber: 'asc' }],
    });
    return rows.map((a) => ({
      id: a.id,
      orgName: a.practice.org.name,
      practiceName: a.practice.name,
      providerName: providerName(a.provider),
      // Ids the patient portal needs to re-query availability when rescheduling.
      practiceId: a.practiceId,
      providerId: a.providerId,
      sessionDate: formatDateOnly(a.sessionDate),
      tokenNumber: a.tokenNumber,
      status: a.status,
      channel: a.channel,
      apptType: a.apptType,
      reason: a.reason,
    }));
  }

  /** The patient's own demographics (for the profile screen). */
  async profile(userId: string) {
    const u = await this.prisma.appUser.findUniqueOrThrow({
      where: { id: userId },
      select: {
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        dateOfBirth: true,
        gender: true,
      },
    });
    return {
      firstName: u.firstName,
      lastName: u.lastName,
      phone: u.phone,
      email: u.email,
      dateOfBirth: u.dateOfBirth ? formatDateOnly(u.dateOfBirth) : null,
      gender: u.gender,
    };
  }

  /**
   * Patient edits their OWN demographics (global app_user). Phone/email are NOT editable here — they
   * are the Cognito login username and we have no login-identity-change flow yet (see the
   * profile.dto.ts note / phase-2 "change-login-identity" TODO).
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.prisma.appUser.update({
      where: { id: userId },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        dateOfBirth: dto.dateOfBirth ? parseDateOnly(dto.dateOfBirth) : undefined,
        gender: dto.gender,
        updatedByUser: userId, // self-edit attribution (no org context)
      },
    });
    return this.profile(userId);
  }

  async visits(patientId: string) {
    const rows = await this.prisma.visit.findMany({
      where: { patientId, deletedAt: null },
      include: {
        practice: { select: PRACTICE_SELECT },
        provider: { select: PROVIDER_SELECT },
      },
      orderBy: { checkInAt: 'desc' },
    });
    return rows.map((v) => this.toVisitSummary(v));
  }

  async visit(patientId: string, visitId: string) {
    const v = await this.prisma.visit.findFirst({
      where: { id: visitId, patientId, deletedAt: null },
      include: {
        practice: { select: PRACTICE_SELECT },
        provider: { select: PROVIDER_SELECT },
        prescriptions: { orderBy: { createdAt: 'asc' } },
        testOrders: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!v) throw new NotFoundException('Visit not found');
    return {
      ...this.toVisitSummary(v),
      // The doctor's clinical record for this visit (Part C/D).
      vitals: v.vitals,
      symptoms: v.symptoms,
      diagnosis: v.diagnosis,
      notes: v.notes,
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

  private toVisitSummary(v: {
    id: string;
    visitNumber: string;
    tokenNumber: number | null;
    status: string;
    checkInAt: Date;
    completedAt: Date | null;
    practice: { name: string; org: { name: string } };
    provider: {
      specialty: string | null;
      user: { firstName: string; lastName: string | null };
    };
  }) {
    return {
      id: v.id,
      orgName: v.practice.org.name,
      practiceName: v.practice.name,
      providerName: providerName(v.provider),
      visitNumber: v.visitNumber,
      tokenNumber: v.tokenNumber,
      status: v.status,
      checkInAt: v.checkInAt,
      completedAt: v.completedAt,
    };
  }
}
