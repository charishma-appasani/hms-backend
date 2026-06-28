import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { CognitoService } from '../auth/cognito.service';
import { OtpService } from '../otp/otp.service';
import { AuditService, diffFields } from '../audit/audit.service';
import { throwMappedPrismaError } from '../common/prisma-errors';
import { nextSequence } from '../common/sequence';
import { formatDateOnly, parseDateOnly } from '../common/datetime';
import type {
  AppUser,
  Patient,
  PatientRegistration,
} from '../../generated/prisma/client';
import type {
  CreatePatientDto,
  LinkStartDto,
  LinkVerifyDto,
  SignupStartDto,
  SignupVerifyDto,
  UpdatePatientDto,
} from './dto/patient.dto';

const SIGNUP_PURPOSE = 'patient_signup';
const LINK_PURPOSE = 'patient_link';

/**
 * Patients: a global `app_user` identity + `patient` profile, linked to an org via
 * `patient_registration` (per-org UHID). Two creation paths:
 *   - STAFF create (org-scoped): registers a brand-new patient at the current org, provisioning a
 *     Cognito login by phone/email.
 *   - SELF signup (public, OTP via OtpService): the patient verifies their phone, sets a password,
 *     and gets an identity + profile (no org yet — they register at an org on first visit).
 */
@Injectable()
export class PatientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scoped: ScopedPrismaService,
    private readonly cognito: CognitoService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── staff ─────────────────────────

  async createByStaff(dto: CreatePatientDto) {
    const orgId = this.scoped.orgId;
    const actorId = this.scoped.actorId;
    await this.assertUniqueContact(dto.phone, dto.email);
    const org = await this.scoped.db.organization.findFirst({
      where: { id: orgId },
      select: { uhidFormat: true },
    });

    // Each person has a unique phone/email → always a real Cognito login.
    const cognitoSub = await this.cognito.provisionPatient({
      phone: dto.phone,
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
    });

    try {
      const { user, patient, registration } = await this.scoped.db.$transaction(
        async (tx) => {
          const user = await tx.appUser.create({
            data: {
              cognitoSub,
              firstName: dto.firstName,
              lastName: dto.lastName,
              phone: dto.phone,
              email: dto.email,
              dateOfBirth: dto.dateOfBirth
                ? parseDateOnly(dto.dateOfBirth)
                : undefined,
              gender: dto.gender,
              updatedByOrg: orgId,
              updatedByUser: actorId,
            },
          });
          const patient = await tx.patient.create({
            data: { userId: user.id, abhaNumber: dto.abhaNumber },
          });
          const seq = await nextSequence(tx, {
            orgId,
            scope: 'org',
            scopeId: orgId,
            name: 'uhid',
          });
          const registration = await tx.patientRegistration.create({
            data: {
              orgId,
              patientId: patient.id,
              uhid: formatUhid(org?.uhidFormat ?? 'UH{seq:08}', seq),
              status: 'active',
            },
          });
          return { user, patient, registration };
        },
      );
      await this.audit.record({
        action: 'patient.create',
        entityType: 'patient',
        entityId: patient.id,
        patientId: patient.id,
        metadata: { uhid: registration.uhid, via: 'staff' },
      });
      return toPatientResponse(user, patient, registration);
    } catch (err) {
      return throwMappedPrismaError(err, {
        conflict: 'A patient with this phone, email, or ABHA already exists',
      });
    }
  }

  /** Phone/email are unique per person (the Cognito login). Reject a duplicate up front. */
  private async assertUniqueContact(
    phone: string | undefined,
    email: string | undefined,
    excludeUserId?: string,
  ): Promise<void> {
    const or: { phone?: string; email?: string }[] = [];
    if (phone) or.push({ phone });
    if (email) or.push({ email });
    if (or.length === 0) return;
    const existing = await this.prisma.appUser.findFirst({
      where: {
        OR: or,
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'A person with this phone or email already exists',
      );
    }
  }

  list() {
    return this.scoped.db.patientRegistration
      .findMany({
        orderBy: { createdAt: 'desc' },
        include: { patient: { include: { user: true } } },
      })
      .then((rows) =>
        rows.map((r) => toPatientResponse(r.patient.user, r.patient, r)),
      );
  }

  async get(patientId: string) {
    const registration = await this.scoped.db.patientRegistration.findFirst({
      where: { patientId },
      include: { patient: { include: { user: true } } },
    });
    if (!registration) {
      throw new NotFoundException('Patient is not registered at this organization');
    }
    return toPatientResponse(
      registration.patient.user,
      registration.patient,
      registration,
    );
  }

  async update(patientId: string, dto: UpdatePatientDto) {
    const orgId = this.scoped.orgId;
    const actorId = this.scoped.actorId;
    const registration = await this.scoped.db.patientRegistration.findFirst({
      where: { patientId },
      include: { patient: { include: { user: true } } },
    });
    if (!registration) {
      throw new NotFoundException('Patient is not registered at this organization');
    }
    if (dto.phone || dto.email) {
      await this.assertUniqueContact(
        dto.phone,
        dto.email,
        registration.patient.userId,
      );
    }
    const before = registration.patient.user;

    try {
      const { user, patient } = await this.scoped.db.$transaction(async (tx) => {
        const user = await tx.appUser.update({
          where: { id: registration.patient.userId },
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone,
            email: dto.email,
            dateOfBirth: dto.dateOfBirth
              ? parseDateOnly(dto.dateOfBirth)
              : undefined,
            gender: dto.gender,
            updatedByOrg: orgId, // cross-org demographic attribution (last-write-wins)
            updatedByUser: actorId,
          },
        });
        const patient =
          dto.abhaNumber !== undefined
            ? await tx.patient.update({
                where: { id: patientId },
                data: { abhaNumber: dto.abhaNumber },
              })
            : await tx.patient.findUniqueOrThrow({ where: { id: patientId } });
        return { user, patient };
      });
      const changes = diffFields(
        {
          firstName: before.firstName,
          lastName: before.lastName,
          phone: before.phone,
          email: before.email,
          dateOfBirth: before.dateOfBirth
            ? formatDateOnly(before.dateOfBirth)
            : null,
          gender: before.gender,
          abhaNumber: registration.patient.abhaNumber,
        },
        {
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          email: dto.email,
          dateOfBirth: dto.dateOfBirth,
          gender: dto.gender,
          abhaNumber: dto.abhaNumber,
        },
      );
      if (Object.keys(changes).length > 0) {
        await this.audit.record({
          action: 'patient.update',
          entityType: 'patient',
          entityId: patientId,
          patientId,
          metadata: { changes },
        });
      }
      return toPatientResponse(user, patient, registration);
    } catch (err) {
      return throwMappedPrismaError(err, {
        conflict: 'A patient with this ABHA number already exists',
      });
    }
  }

  // ───────────────────────── self-signup (OTP) ─────────────────────────

  /** Step 1: rate-limited OTP to the phone (OtpService enforces the limits + sends). */
  async signupStart(
    dto: SignupStartDto,
    ip: string,
  ): Promise<{ sent: boolean }> {
    await this.otp.request({
      phone: dto.phone,
      email: dto.email,
      purpose: SIGNUP_PURPOSE,
      ip,
    });
    return { sent: true };
  }

  /** Step 2: verify the OTP, then create the patient identity + profile (no org registration yet). */
  async signupVerify(dto: SignupVerifyDto) {
    await this.otp.verify({
      phone: dto.phone,
      purpose: SIGNUP_PURPOSE,
      code: dto.code,
    });

    // Phone verified — but it (or the email) may already belong to an account.
    const existing = await this.prisma.appUser.findFirst({
      where: { OR: [{ phone: dto.phone }, ...(dto.email ? [{ email: dto.email }] : [])] },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'An account already exists for this phone or email — please log in',
      );
    }

    const cognitoSub = await this.cognito.provisionPatient({
      phone: dto.phone,
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      password: dto.password,
    });

    const patient = await this.prisma.$transaction(async (tx) => {
      const user = await tx.appUser.create({
        data: {
          cognitoSub,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          email: dto.email,
          dateOfBirth: dto.dateOfBirth
            ? parseDateOnly(dto.dateOfBirth)
            : undefined,
          gender: dto.gender,
        },
      });
      return tx.patient.create({ data: { userId: user.id } });
    });

    await this.audit.record({
      action: 'patient.signup',
      entityType: 'patient',
      entityId: patient.id,
      patientId: patient.id,
      metadata: { via: 'self' }, // public route → no actor/org context
    });
    return {
      patientId: patient.id,
      message: 'Signup complete. You can now log in.',
    };
  }

  // ─────────────── cross-org link (existing patient → this org) ───────────────

  /**
   * Step 1: an existing global patient (found by phone) consents to joining THIS org via an OTP to
   * their own contact. Rejects if there's no such patient (use staff-create instead) or they're
   * already registered here. The OTP prefers the patient's email when present.
   */
  async linkStart(dto: LinkStartDto, ip: string): Promise<{ sent: boolean }> {
    const patient = await this.prisma.patient.findFirst({
      where: { user: { phone: dto.phone } },
      select: { id: true, user: { select: { email: true, firstName: true } } },
    });
    if (!patient) {
      throw new NotFoundException(
        'No existing patient with this phone — create a new record instead',
      );
    }
    const already = await this.scoped.db.patientRegistration.findFirst({
      where: { patientId: patient.id },
      select: { id: true },
    });
    if (already) {
      throw new ConflictException(
        'Patient is already registered at this organization',
      );
    }
    await this.otp.request({
      phone: dto.phone,
      email: patient.user.email ?? undefined,
      name: patient.user.firstName,
      purpose: LINK_PURPOSE,
      ip,
    });
    return { sent: true };
  }

  /**
   * Step 2: verify the patient's consent OTP, then register them at this org — a new
   * `patient_registration` (fresh UHID) plus a `consent` row (type org_link, method otp) that the
   * registration references. The global patient + their demographics are shared, not duplicated.
   */
  async linkVerify(dto: LinkVerifyDto) {
    const orgId = this.scoped.orgId;
    await this.otp.verify({
      phone: dto.phone,
      purpose: LINK_PURPOSE,
      code: dto.code,
    });

    const patient = await this.prisma.patient.findFirst({
      where: { user: { phone: dto.phone } },
      include: { user: true },
    });
    if (!patient) {
      throw new NotFoundException('No existing patient with this phone');
    }
    const already = await this.scoped.db.patientRegistration.findFirst({
      where: { patientId: patient.id },
      select: { id: true },
    });
    if (already) {
      throw new ConflictException(
        'Patient is already registered at this organization',
      );
    }

    const org = await this.scoped.db.organization.findFirst({
      where: { id: orgId },
      select: { uhidFormat: true },
    });
    const registration = await this.scoped.db.$transaction(async (tx) => {
      const consent = await tx.consent.create({
        data: {
          orgId,
          patientId: patient.id,
          type: 'org_link',
          method: 'otp',
          reference: dto.phone,
          verifiedAt: new Date(),
        },
      });
      const seq = await nextSequence(tx, {
        orgId,
        scope: 'org',
        scopeId: orgId,
        name: 'uhid',
      });
      return tx.patientRegistration.create({
        data: {
          orgId,
          patientId: patient.id,
          uhid: formatUhid(org?.uhidFormat ?? 'UH{seq:08}', seq),
          status: 'active',
          consentId: consent.id,
        },
      });
    });
    await this.audit.record({
      action: 'patient.link',
      entityType: 'patient_registration',
      entityId: registration.id,
      patientId: patient.id,
      metadata: { uhid: registration.uhid, consentId: registration.consentId },
    });
    return toPatientResponse(patient.user, patient, registration);
  }
}

/** "UH{seq:08}" → "UH00000001". Supports an optional zero-pad width. */
function formatUhid(format: string, seq: bigint): string {
  return format.replace(/\{seq(?::0(\d+))?\}/, (_m, pad?: string) =>
    pad ? String(seq).padStart(Number(pad), '0') : String(seq),
  );
}

function toPatientResponse(
  user: AppUser,
  patient: Patient,
  registration: PatientRegistration | null,
) {
  return {
    patientId: patient.id,
    userId: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    email: user.email,
    dateOfBirth: user.dateOfBirth ? formatDateOnly(user.dateOfBirth) : null,
    gender: user.gender,
    abhaNumber: patient.abhaNumber,
    isVerified: patient.isVerified,
    registration: registration
      ? { uhid: registration.uhid, status: registration.status }
      : null,
  };
}
