import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ImagesService } from '../images/images.service';
import { throwMappedPrismaError } from '../common/prisma-errors';
import { formatDateOnly, parseDateOnly } from '../common/datetime';
import { patientSummarySchema } from '../ai/patient-summary.schema';
import type { AppUser, Gender } from '../../generated/prisma/client';
import type { UpdateProfileDto } from './dto/profile.dto';
import type { ActivatePatientProfileDto } from './dto/activate-profile.dto';

/** Provider (clinician) summary for patient-facing views. */
const PROVIDER_SELECT = {
  specialty: true,
  user: { select: { firstName: true, lastName: true } },
} as const;

const PRACTICE_SELECT = {
  name: true,
  timezone: true,
  // imageUpdatedAt → the org logo on the patient's printable prescription.
  org: { select: { id: true, name: true, imageUpdatedAt: true } },
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
  private readonly logger = new Logger(PatientPortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly images: ImagesService,
  ) {}

  /**
   * Activate a patient profile on an EXISTING account (staff/doctor/operator becoming a patient).
   * Creates the 1:1 `patient` row; the dto only fills demographics missing on the app_user — it
   * never overwrites existing values. Org registration stays lazy (first booking). A concurrent
   * or repeat call hits the unique `patient.user_id` constraint → 409.
   */
  async activatePatientProfile(user: AppUser, dto: ActivatePatientProfileDto) {
    try {
      const patient = await this.prisma.$transaction(async (tx) => {
        const fill: { dateOfBirth?: Date; gender?: Gender } = {};
        if (!user.dateOfBirth && dto.dateOfBirth) {
          fill.dateOfBirth = parseDateOnly(dto.dateOfBirth);
        }
        if (!user.gender && dto.gender) fill.gender = dto.gender;
        if (Object.keys(fill).length > 0) {
          await tx.appUser.update({
            where: { id: user.id },
            data: { ...fill, updatedByUser: user.id }, // self-edit attribution (no org context)
          });
        }
        return tx.patient.create({ data: { userId: user.id } });
      });
      await this.audit.record({
        action: 'patient.signup',
        entityType: 'patient',
        entityId: patient.id,
        patientId: patient.id,
        metadata: { via: 'self-link' }, // existing account, no new Cognito identity
      });
      this.logger.log(
        `Patient profile activated on existing account: patientId=${patient.id} userId=${user.id}`,
      );
      return { patientId: patient.id, message: 'Patient profile activated.' };
    } catch (err) {
      return throwMappedPrismaError(err, {
        conflict: 'This account already has a patient profile',
      });
    }
  }

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
        dateOfBirth: dto.dateOfBirth
          ? parseDateOnly(dto.dateOfBirth)
          : undefined,
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
      // Letterhead for the patient's own printable copy of the prescription.
      orgLogoUrl: await this.images.urlFor(
        'org',
        v.practice.org.id,
        v.practice.org.imageUpdatedAt,
      ),
      // The plain-language AI after-visit summary, if one was generated (ai-features.md #6). Read
      // unscoped here because the patient owns their record; the row is scoped to the visit +
      // patient. Only a `ready` row is surfaced — pending/failed shows nothing.
      aiSummary: await this.patientSummary(patientId, visitId),
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

  /**
   * The patient's plain-language after-visit summary for this visit, or null if none is ready.
   * The stored `output` is re-validated (it was written by another process, possibly an older
   * prompt) so a row that no longer parses degrades to null rather than breaking the page.
   */
  private async patientSummary(patientId: string, visitId: string) {
    const row = await this.prisma.aiGeneration.findFirst({
      where: { visitId, patientId, kind: 'patient_summary', status: 'ready' },
      select: { output: true, updatedAt: true },
    });
    if (!row) return null;
    const parsed = patientSummarySchema.safeParse(row.output);
    if (!parsed.success) return null;
    return { ...parsed.data, generatedAt: row.updatedAt };
  }

  private toVisitSummary(v: {
    id: string;
    visitNumber: string;
    tokenNumber: number | null;
    status: string;
    checkInAt: Date;
    completedAt: Date | null;
    practice: {
      name: string;
      org: { id: string; name: string; imageUpdatedAt: Date | null };
    };
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
