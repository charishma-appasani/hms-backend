import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ScopedPrismaService } from '../../prisma/scoped-prisma.service';
import {
  RelocationService,
  RELOCATABLE_SELECT,
} from '../appointments/relocation.service';
import {
  formatDateOnly,
  formatTimeOfDay,
  parseDateOnly,
  parseTimeOfDay,
} from '../../common/datetime';
import { slotRowsForTemplate } from '../slots/slot-generation';
import type { AvailabilityTemplate } from '../../../generated/prisma/client';
import type { CreateAvailabilityTemplateDto } from './dto/availability-template.dto';

const ACTIVE_APPT = ['requested', 'confirmed', 'checked_in'] as const;

export interface ListAvailabilityTemplatesFilter {
  providerId?: string;
  practiceId?: string;
}

/**
 * Bounded availability templates with EAGER slot generation. Creating a template materializes its
 * slots for the whole (≤8-week) range in one transaction. Tenant-scoped; provider must be a doctor
 * and practice must belong to this org. Times/dates cross the API as wall-clock strings.
 *
 * Dropping a template (DELETE) cancels its future bookings (+notify) and removes/blocks its slots;
 * replacing one (POST :id/replace) generates the new schedule and migrates the old bookings to it.
 */
@Injectable()
export class AvailabilityTemplatesService {
  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly relocation: RelocationService,
  ) {}

  async create(dto: CreateAvailabilityTemplateDto) {
    const practice = await this.assertProviderAndPractice(
      dto.providerId,
      dto.practiceId,
    );
    const { template, slotCount } = await this.generateTemplate(dto, practice);
    return { ...toResponse(template), weeks: dto.weeks, generatedSlots: slotCount };
  }

  async list(filter: ListAvailabilityTemplatesFilter) {
    const rows = await this.scoped.db.availabilityTemplate.findMany({
      where: { providerId: filter.providerId, practiceId: filter.practiceId },
      orderBy: [{ providerId: 'asc' }, { weekday: 'asc' }, { startTime: 'asc' }],
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
  async remove(id: string) {
    const template = await this.scoped.db.availabilityTemplate.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!template) throw new NotFoundException('Availability template not found');

    const affected = await this.findActiveAppointments(id);
    await this.blockTemplateSlots(id); // stop new bookings during the drop
    const relocation = await this.relocation.relocate(affected, {
      migrate: false,
      reason: 'schedule_removed',
    });
    await this.finalizeDrop(id);

    return { templateId: id, ...relocation };
  }

  /**
   * REPLACE a template's remaining schedule with a new one (same provider + practice): generate the
   * new template's slots, then MIGRATE the old template's future bookings to their nearest open slot
   * in the new schedule (cancelling only if none fits), notifying each patient. The old template is
   * then dropped.
   */
  async replace(id: string, dto: CreateAvailabilityTemplateDto) {
    const old = await this.scoped.db.availabilityTemplate.findFirst({
      where: { id },
      select: { id: true, providerId: true, practiceId: true },
    });
    if (!old) throw new NotFoundException('Availability template not found');
    if (dto.providerId !== old.providerId || dto.practiceId !== old.practiceId) {
      throw new BadRequestException(
        'Replace must keep the same provider and practice (it reschedules their hours)',
      );
    }
    const practice = await this.assertProviderAndPractice(
      dto.providerId,
      dto.practiceId,
    );

    // 1. Build the new schedule.
    const { template, slotCount } = await this.generateTemplate(dto, practice);
    // 2. Block the old slots so migration targets the NEW open slots, never the disappearing ones.
    await this.blockTemplateSlots(id);
    // 3. Migrate the old future bookings onto the new schedule (notify each patient).
    const affected = await this.findActiveAppointments(id);
    const relocation = await this.relocation.relocate(affected, {
      migrate: true,
      reason: 'schedule_changed',
    });
    // 4. Drop the old template.
    await this.finalizeDrop(id);

    return {
      template: { ...toResponse(template), weeks: dto.weeks, generatedSlots: slotCount },
      ...relocation,
    };
  }

  /** Create a template + eagerly generate its slots (blocking any that fall in an active exception). */
  private async generateTemplate(
    dto: CreateAvailabilityTemplateDto,
    practice: { id: string; timezone: string },
  ): Promise<{ template: AvailabilityTemplate; slotCount: number }> {
    // Range: `weeks` occurrences of startDate's weekday, beginning at startDate.
    const validFrom = parseDateOnly(dto.startDate);
    const weekday = validFrom.getUTCDay();
    const validTo = new Date(validFrom.getTime());
    validTo.setUTCDate(validTo.getUTCDate() + (dto.weeks - 1) * 7);

    return this.scoped.db.$transaction(async (tx) => {
      const created = await tx.availabilityTemplate.create({
        data: {
          orgId: this.scoped.orgId,
          practiceId: dto.practiceId,
          providerId: dto.providerId,
          weekday,
          startTime: parseTimeOfDay(dto.startTime),
          endTime: parseTimeOfDay(dto.endTime),
          mode: dto.mode,
          slotDurationMins: dto.slotDurationMins,
          apptCapacity: dto.apptCapacity,
          walkinCapacity: dto.walkinCapacity,
          validFrom,
          validTo,
        },
      });
      const rows = slotRowsForTemplate(created, practice.timezone);
      if (rows.length > 0) {
        await tx.slot.createMany({ data: rows, skipDuplicates: true });
        // Exceptions don't depend on schedule order: any of these new slots that fall inside an
        // active block start `blocked` (reversible — lifting the block reopens them).
        await tx.$executeRaw`
          UPDATE "slot" SET status = 'blocked', updated_at = now()
           WHERE template_id = ${created.id}::uuid AND status = 'open'
             AND EXISTS (
               SELECT 1 FROM "schedule_exception" se
                WHERE se.org_id = "slot".org_id AND se.provider_id = "slot".provider_id
                  AND se.deleted_at IS NULL
                  AND se.type IN ('time_off', 'holiday', 'surgery', 'busy')
                  AND (se.practice_id IS NULL OR se.practice_id = "slot".practice_id)
                  AND se.start_at < "slot".end_at AND se.end_at > "slot".start_at
             )`;
      }
      return { template: created, slotCount: rows.length };
    });
  }

  /** Future, active bookings on a template's slots (shaped for RelocationService). */
  private findActiveAppointments(templateId: string) {
    return this.scoped.db.appointment.findMany({
      where: { status: { in: [...ACTIVE_APPT] }, slot: { templateId } },
      select: RELOCATABLE_SELECT,
      orderBy: { slot: { startAt: 'asc' } },
    });
  }

  /** Block a template's still-open slots (prevents new bookings during a drop/replace). */
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
