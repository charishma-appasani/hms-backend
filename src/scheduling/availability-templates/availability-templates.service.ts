import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ScopedPrismaService } from '../../prisma/scoped-prisma.service';
import {
  RelocationService,
  RELOCATABLE_SELECT,
  type RelocationResult,
} from '../appointments/relocation.service';
import {
  dayWindowUtc,
  formatDateOnly,
  formatTimeOfDay,
  parseDateOnly,
  parseTimeOfDay,
  utcToZonedDateOnly,
} from '../../common/datetime';
import { slotRowsForTemplate } from '../slots/slot-generation';
import { assertCanManageProviderSchedule } from '../provider-schedule-access';
import type { OrgContext } from '../../auth/auth.types';
import type { AvailabilityTemplate } from '../../../generated/prisma/client';
import type { CreateAvailabilityTemplateDto } from './dto/availability-template.dto';

const ACTIVE_APPT = ['requested', 'confirmed', 'checked_in'] as const;

/** One weekday's template, resolved to concrete dates (input to the shared generator). */
interface TemplateSpec {
  practiceId: string;
  providerId: string;
  weekday: number;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  mode: 'slot' | 'token';
  slotDurationMins?: number;
  apptCapacity?: number;
  walkinCapacity?: number;
  validFrom: Date;
  validTo: Date;
}

/** Anything that can run the exception-blocking raw SQL (the scoped client or a tx). */
interface RawDb {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
}

/** Resolve a weekday to [validFrom, validTo]: first occurrence on/after `anchor`, `weeks` occurrences. */
function rangeForWeekday(
  anchor: Date,
  weekday: number,
  weeks: number,
): { validFrom: Date; validTo: Date } {
  const validFrom = new Date(anchor.getTime());
  while (validFrom.getUTCDay() !== weekday) {
    validFrom.setUTCDate(validFrom.getUTCDate() + 1);
  }
  const validTo = new Date(validFrom.getTime());
  validTo.setUTCDate(validTo.getUTCDate() + (weeks - 1) * 7);
  return { validFrom, validTo };
}

export interface ListAvailabilityTemplatesFilter {
  providerId?: string;
  practiceId?: string;
}

/**
 * A provider's bounded weekly availability at a practice, with EAGER slot generation. Creating a
 * schedule materializes one template per working weekday plus all their slots (≤8 weeks) in one
 * transaction. Tenant-scoped; provider must be a doctor and the practice must belong to this org.
 * Times/dates cross the API as practice-local wall-clock strings.
 *
 * There is NO edit/replace: creating a schedule SUPERSEDES the provider's existing schedule at the
 * practice from its startDate on (see create). Dropping a template (DELETE) cancels its future
 * bookings (+notify) and removes/blocks its slots.
 */
@Injectable()
export class AvailabilityTemplatesService {
  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly relocation: RelocationService,
  ) {}

  /**
   * Create the provider's weekly schedule at a practice — and SUPERSEDE the existing one from
   * `startDate` (today or later, practice tz) onward. Same-day supersede applies from the START of
   * the practice-day: already-booked slots earlier today are preserved (kept/relocated per steps
   * 3–4), only empty ones are cleared:
   *
   *   1. The superseded portion of the old schedule is retired: its slots from the cutover on are
   *      blocked (no new bookings) and the empty ones deleted, freeing their times for the new
   *      schedule (slots are unique per provider+startAt).
   *   2. The new templates + slots are generated (one transaction, all-or-nothing).
   *   3. Bookings whose exact time/mode still exists in the new schedule KEEP their slot — the old
   *      slot row is adopted into the new template. Nothing changes for those patients: no move,
   *      no notification.
   *   4. Every other future booking on the old schedule is relocated to the nearest open slot
   *      (cancelled only if none fits), notifying each patient. Checked-in patients are flagged
   *      `needsAttention` instead.
   *   5. Old templates straddling the cutover are truncated to end the day before `startDate`;
   *      templates starting on/after it are removed outright.
   */
  async create(dto: CreateAvailabilityTemplateDto, org: OrgContext) {
    assertCanManageProviderSchedule(org, dto.providerId);
    const practice = await this.assertProviderAndPractice(
      dto.providerId,
      dto.practiceId,
    );
    const startDate = parseDateOnly(dto.startDate);

    const today = utcToZonedDateOnly(new Date(), practice.timezone);
    if (startDate.getTime() < today.getTime()) {
      throw new BadRequestException(
        'startDate must be today or later (practice time)',
      );
    }
    const { dayStart: cutover } = dayWindowUtc(
      dto.startDate,
      practice.timezone,
    );

    // Everything still running on/after startDate is superseded (validTo ≥ startDate or unbounded).
    const superseded = await this.scoped.db.availabilityTemplate.findMany({
      where: {
        providerId: dto.providerId,
        practiceId: dto.practiceId,
        OR: [{ validTo: null }, { validTo: { gte: startDate } }],
      },
      select: { id: true, validFrom: true },
    });
    const supersededIds = superseded.map((t) => t.id);

    // 1. Retire the superseded portion: block (stops new bookings) and delete the empty slots so
    //    their times are free for the new schedule. Booked slots stay for steps 3/4.
    if (supersededIds.length > 0) {
      await this.scoped.db.$transaction(async (tx) => {
        await tx.slot.updateMany({
          where: {
            templateId: { in: supersededIds },
            startAt: { gte: cutover },
            status: 'open',
          },
          data: { status: 'blocked' },
        });
        await tx.slot.deleteMany({
          where: {
            templateId: { in: supersededIds },
            startAt: { gte: cutover },
            appointments: { none: {} },
          },
        });
      });
    }

    // 2. Generate the new schedule.
    const anchor = parseDateOnly(dto.startDate);
    const specs: TemplateSpec[] = dto.days.map((day) => ({
      practiceId: dto.practiceId,
      providerId: dto.providerId,
      weekday: day.weekday,
      startTime: day.startTime,
      endTime: day.endTime,
      mode: dto.mode,
      slotDurationMins: dto.slotDurationMins,
      apptCapacity: dto.apptCapacity,
      walkinCapacity: dto.walkinCapacity,
      ...rangeForWeekday(anchor, day.weekday, dto.weeks),
    }));
    const created = await this.generateTemplates(specs, practice);

    // 3. Keep bookings whose time survived; 4. relocate the rest (adoption first, so kept
    //    appointments are off the superseded templates before the relocation query runs).
    let kept = 0;
    let relocation: RelocationResult = {
      rescheduled: [],
      cancelled: [],
      needsAttention: [],
    };
    if (supersededIds.length > 0) {
      kept = await this.adoptMatchingSlots(
        supersededIds,
        cutover,
        created,
        practice.timezone,
      );
      const affected = await this.scoped.db.appointment.findMany({
        where: {
          status: { in: [...ACTIVE_APPT] },
          slot: {
            templateId: { in: supersededIds },
            startAt: { gte: cutover },
          },
        },
        select: RELOCATABLE_SELECT,
        orderBy: { slot: { startAt: 'asc' } },
      });
      relocation = await this.relocation.relocate(affected, {
        migrate: true,
        reason: 'schedule_changed',
      });

      // 5. Retire the superseded templates: clear now-empty slots (relocated bookings moved off;
      //    slots still referenced by old/cancelled appointments stay, blocked), truncate the
      //    straddlers, remove the fully-future ones.
      await this.scoped.db.slot.deleteMany({
        where: {
          templateId: { in: supersededIds },
          startAt: { gte: cutover },
          appointments: { none: {} },
        },
      });
      const dayBefore = new Date(startDate.getTime());
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      const straddling = superseded
        .filter((t) => t.validFrom.getTime() < startDate.getTime())
        .map((t) => t.id);
      const future = superseded
        .filter((t) => t.validFrom.getTime() >= startDate.getTime())
        .map((t) => t.id);
      if (straddling.length > 0) {
        await this.scoped.db.availabilityTemplate.updateMany({
          where: { id: { in: straddling } },
          data: { validTo: dayBefore },
        });
      }
      if (future.length > 0) {
        await this.scoped.db.availabilityTemplate.updateMany({
          where: { id: { in: future } },
          data: { deletedAt: new Date() },
        });
      }
    }

    return {
      weeks: dto.weeks,
      generatedSlots: created.reduce((n, c) => n + c.slotCount, 0),
      templates: created.map((c) => ({
        ...toResponse(c.template),
        generatedSlots: c.slotCount,
      })),
      supersededTemplates: supersededIds.length,
      keptAppointments: kept,
      ...relocation,
    };
  }

  async list(filter: ListAvailabilityTemplatesFilter) {
    const rows = await this.scoped.db.availabilityTemplate.findMany({
      where: { providerId: filter.providerId, practiceId: filter.practiceId },
      orderBy: [
        { providerId: 'asc' },
        { weekday: 'asc' },
        { startTime: 'asc' },
      ],
    });
    return rows.map(toResponse);
  }

  async get(id: string) {
    const row = await this.scoped.db.availabilityTemplate.findFirst({
      where: { id },
    });
    if (!row) throw new NotFoundException('Availability template not found');
    return toResponse(row);
  }

  /**
   * DROP a template before its end: cancel its future bookings (notifying each patient), then
   * remove its empty slots, block any slots that still carry (now-cancelled) bookings — slots can't
   * be deleted while appointments reference them — and soft-delete the template.
   */
  async remove(id: string, org: OrgContext) {
    const template = await this.scoped.db.availabilityTemplate.findFirst({
      where: { id },
      select: { id: true, providerId: true },
    });
    if (!template)
      throw new NotFoundException('Availability template not found');
    assertCanManageProviderSchedule(org, template.providerId);

    const affected = await this.findActiveAppointments(id);
    await this.blockTemplateSlots(id); // stop new bookings during the drop
    const relocation = await this.relocation.relocate(affected, {
      migrate: false,
      reason: 'schedule_removed',
    });
    await this.finalizeDrop(id);

    return { templateId: id, ...relocation };
  }

  /** Create the given templates + their slots in ONE transaction (all land or none do). */
  private generateTemplates(
    specs: TemplateSpec[],
    practice: { id: string; timezone: string },
  ): Promise<Array<{ template: AvailabilityTemplate; slotCount: number }>> {
    return this.scoped.db.$transaction(async (tx) => {
      const out: Array<{ template: AvailabilityTemplate; slotCount: number }> =
        [];
      for (const spec of specs) {
        const created = await tx.availabilityTemplate.create({
          data: {
            orgId: this.scoped.orgId,
            practiceId: spec.practiceId,
            providerId: spec.providerId,
            weekday: spec.weekday,
            startTime: parseTimeOfDay(spec.startTime),
            endTime: parseTimeOfDay(spec.endTime),
            mode: spec.mode,
            slotDurationMins: spec.slotDurationMins,
            apptCapacity: spec.apptCapacity,
            walkinCapacity: spec.walkinCapacity,
            validFrom: spec.validFrom,
            validTo: spec.validTo,
          },
        });
        const rows = slotRowsForTemplate(created, practice.timezone);
        if (rows.length > 0) {
          await tx.slot.createMany({ data: rows, skipDuplicates: true });
          await this.blockSlotsInsideExceptions(tx, created.id);
        }
        out.push({ template: created, slotCount: rows.length });
      }
      return out;
    });
  }

  /**
   * ADOPT old booked slots whose exact time/mode still exists in the new schedule: their identical
   * new rows were skipped (slots are unique per provider+startAt), so re-point the surviving old
   * slot to the new template and reopen it. The bookings on it are untouched — same slot id, same
   * time — so those patients are NOT notified. Returns how many active appointments were kept.
   */
  private async adoptMatchingSlots(
    supersededIds: string[],
    cutover: Date,
    created: Array<{ template: AvailabilityTemplate; slotCount: number }>,
    timezone: string,
  ): Promise<number> {
    // Would-be rows of the new schedule, keyed by start instant (slot gen is pure/deterministic).
    const wanted = new Map<
      number,
      { template: AvailabilityTemplate; endAt: number }
    >();
    for (const { template } of created) {
      for (const row of slotRowsForTemplate(template, timezone)) {
        wanted.set((row.startAt as Date).getTime(), {
          template,
          endAt: (row.endAt as Date).getTime(),
        });
      }
    }

    const candidates = await this.scoped.db.slot.findMany({
      where: {
        templateId: { in: supersededIds },
        startAt: { gte: cutover },
        appointments: { some: { status: { in: [...ACTIVE_APPT] } } },
      },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        mode: true,
        _count: {
          select: {
            appointments: { where: { status: { in: [...ACTIVE_APPT] } } },
          },
        },
      },
    });

    let kept = 0;
    const adoptedTemplateIds = new Set<string>();
    for (const slot of candidates) {
      const match = wanted.get(slot.startAt.getTime());
      if (
        !match ||
        match.endAt !== slot.endAt.getTime() ||
        match.template.mode !== slot.mode
      ) {
        continue;
      }
      await this.scoped.db.slot.update({
        where: { id: slot.id },
        data: {
          templateId: match.template.id,
          status: 'open',
          apptCapacity: match.template.apptCapacity,
          walkinCapacity: match.template.walkinCapacity,
        },
      });
      adoptedTemplateIds.add(match.template.id);
      kept += slot._count.appointments;
    }

    // Adopted slots joined the new templates after their exception pass — re-apply it to them.
    for (const templateId of adoptedTemplateIds) {
      await this.blockSlotsInsideExceptions(this.scoped.db, templateId);
    }
    return kept;
  }

  /**
   * Exceptions don't depend on schedule order: any of a template's open slots that fall inside an
   * active block become `blocked` (reversible — lifting the block reopens them).
   */
  private blockSlotsInsideExceptions(
    db: RawDb,
    templateId: string,
  ): Promise<number> {
    return db.$executeRaw`
      UPDATE "slot" SET status = 'blocked', updated_at = now()
       WHERE template_id = ${templateId}::uuid AND status = 'open'
         AND EXISTS (
           SELECT 1 FROM "schedule_exception" se
            WHERE se.org_id = "slot".org_id AND se.provider_id = "slot".provider_id
              AND se.deleted_at IS NULL
              AND se.type IN ('time_off', 'holiday', 'surgery', 'busy')
              AND (se.practice_id IS NULL OR se.practice_id = "slot".practice_id)
              AND se.start_at < "slot".end_at AND se.end_at > "slot".start_at
         )`;
  }

  /** Future, active bookings on a template's slots (shaped for RelocationService). */
  private findActiveAppointments(templateId: string) {
    return this.scoped.db.appointment.findMany({
      where: { status: { in: [...ACTIVE_APPT] }, slot: { templateId } },
      select: RELOCATABLE_SELECT,
      orderBy: { slot: { startAt: 'asc' } },
    });
  }

  /** Block a template's still-open slots (prevents new bookings during a drop). */
  private blockTemplateSlots(templateId: string) {
    return this.scoped.db.slot.updateMany({
      where: { templateId, status: 'open' },
      data: { status: 'blocked' },
    });
  }

  /** Delete the template's now-empty slots and soft-delete the template (slots with bookings stay, blocked). */
  private async finalizeDrop(templateId: string): Promise<void> {
    await this.scoped.db.slot.deleteMany({
      where: { templateId, appointments: { none: {} } },
    });
    await this.scoped.db.availabilityTemplate.update({
      where: { id: templateId },
      data: { deletedAt: new Date() },
    });
  }

  /** Both references must resolve WITHIN this org; the provider must be a doctor. Returns the practice. */
  private async assertProviderAndPractice(
    providerId: string,
    practiceId: string,
  ): Promise<{ id: string; timezone: string }> {
    const [practice, provider] = await Promise.all([
      this.scoped.db.practice.findFirst({
        where: { id: practiceId },
        select: { id: true, timezone: true },
      }),
      this.scoped.db.staff.findFirst({
        where: { id: providerId },
        select: { id: true, roles: true },
      }),
    ]);
    if (!practice) {
      throw new BadRequestException(
        'practiceId does not reference a practice in this organization',
      );
    }
    if (!provider) {
      throw new BadRequestException(
        'providerId does not reference staff in this organization',
      );
    }
    if (!provider.roles.includes('doctor')) {
      throw new BadRequestException('provider must have the doctor role');
    }
    return practice;
  }
}

/** API shape — wall-clock strings instead of epoch Dates for the time/date columns. */
function toResponse(t: AvailabilityTemplate) {
  return {
    id: t.id,
    practiceId: t.practiceId,
    providerId: t.providerId,
    weekday: t.weekday,
    startTime: formatTimeOfDay(t.startTime),
    endTime: formatTimeOfDay(t.endTime),
    mode: t.mode,
    slotDurationMins: t.slotDurationMins,
    apptCapacity: t.apptCapacity,
    walkinCapacity: t.walkinCapacity,
    validFrom: formatDateOnly(t.validFrom),
    validTo: t.validTo ? formatDateOnly(t.validTo) : null,
    createdAt: t.createdAt,
  };
}
