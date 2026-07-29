import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ImagesService } from '../images/images.service';
import { dayWindowUtc } from '../common/datetime';

/**
 * Public-ish provider directory for patients: browse ACTIVE organizations, their practices, and
 * doctors, plus a provider's bookable availability. Cross-org (no membership), gated by
 * PatientContextGuard so only signed-in patients can browse. Patients are never listed here — this
 * is the provider side only. See phase-2-patient-portal.md (Part B, decision 1).
 */
@Injectable()
export class DirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImagesService,
  ) {}

  /** Active, platform-APPROVED orgs, optionally filtered by name. */
  async orgs(q?: string) {
    const rows = await this.prisma.organization.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        approvedAt: { not: null }, // self-signed-up orgs are hidden until approved
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      select: { id: true, name: true, imageUpdatedAt: true },
      orderBy: { name: 'asc' },
      take: 50,
    });
    return Promise.all(
      rows.map(async ({ imageUpdatedAt, ...org }) => ({
        ...org,
        logoUrl: await this.images.urlFor('org', org.id, imageUpdatedAt),
      })),
    );
  }

  /** One org with its active practices + doctors (for the patient to pick a branch + provider). */
  async org(orgId: string) {
    const org = await this.prisma.organization.findFirst({
      where: {
        id: orgId,
        deletedAt: null,
        status: 'active',
        approvedAt: { not: null },
      },
      select: { id: true, name: true, imageUpdatedAt: true },
    });
    if (!org) throw new NotFoundException('Organization not found');

    const [practices, doctors] = await Promise.all([
      this.prisma.practice.findMany({
        where: { orgId, deletedAt: null, status: 'active' },
        select: {
          id: true,
          name: true,
          timezone: true,
          imageUpdatedAt: true,
          address: { select: { city: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.staff.findMany({
        where: {
          orgId,
          deletedAt: null,
          status: 'active',
          roles: { has: 'doctor' },
        },
        select: {
          id: true,
          specialty: true,
          consultationFee: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              imageUpdatedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Pictures: the org logo and branch photos come from the CDN; a doctor's face is personal
    // data, so it is presigned like every other avatar.
    const [logoUrl, practiceImages, providerImages] = await Promise.all([
      this.images.urlFor('org', org.id, org.imageUpdatedAt),
      Promise.all(
        practices.map((p) =>
          this.images.urlFor('practice', p.id, p.imageUpdatedAt),
        ),
      ),
      Promise.all(
        doctors.map((d) =>
          this.images.urlFor('user', d.user.id, d.user.imageUpdatedAt),
        ),
      ),
    ]);

    return {
      id: org.id,
      name: org.name,
      logoUrl,
      practices: practices.map((p, i) => ({
        id: p.id,
        name: p.name,
        timezone: p.timezone,
        city: p.address?.city ?? null,
        imageUrl: practiceImages[i],
      })),
      providers: doctors.map((d, i) => ({
        id: d.id,
        name: `${d.user.firstName} ${d.user.lastName ?? ''}`.trim(),
        specialty: d.specialty,
        consultationFee: d.consultationFee ? Number(d.consultationFee) : null,
        imageUrl: providerImages[i],
      })),
    };
  }

  /** A provider's bookable (open, appt-bucket has room) slots at a practice on a date. */
  async availability(input: {
    practiceId: string;
    providerId: string;
    date: string;
  }) {
    const practice = await this.prisma.practice.findFirst({
      where: {
        id: input.practiceId,
        deletedAt: null,
        status: 'active',
        org: { approvedAt: { not: null } }, // no availability peeking at unapproved orgs
      },
      select: { id: true, timezone: true, org: { select: { id: true } } },
    });
    if (!practice) throw new NotFoundException('Practice not found');

    const { dayStart, dayEnd } = dayWindowUtc(input.date, practice.timezone);
    const slots = await this.prisma.slot.findMany({
      where: {
        practiceId: input.practiceId,
        providerId: input.providerId,
        status: 'open',
        startAt: { gte: dayStart, lt: dayEnd },
      },
      orderBy: { startAt: 'asc' },
    });

    return {
      date: input.date,
      practiceId: input.practiceId,
      providerId: input.providerId,
      timezone: practice.timezone,
      slots: slots
        .map((s) => ({
          id: s.id,
          startAt: s.startAt,
          endAt: s.endAt,
          mode: s.mode,
          available: Math.max(0, s.apptCapacity - s.apptBooked),
        }))
        // Only show slots a patient can actually book into.
        .filter((s) => s.available > 0),
    };
  }
}
