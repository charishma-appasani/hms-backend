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
import type { ScheduleException } from '../../../generated/prisma/client';
import type {
  CreateScheduleExceptionDto,
  ListScheduleExceptionsQueryDto,
} from './dto/schedule-exception.dto';

/**
 * Doctor blocks (time_off / holiday / surgery / busy). Creating a block flips the provider's
 * overlapping OPEN slots to `blocked` (capacity preserved, so it's reversible) and AUTO-RESCHEDULES
 * the future bookings it displaces to their nearest open slot (cancelling only when none exists,
 * notifying the patient); already-checked-in patients are left alone. The response reports exactly
 * what moved so staff can adjust further. Deleting a block reopens the slots it covered, unless
 * another active block still covers them.
 */
@Injectable()
export class ScheduleExceptionsService {
  constructor(
    private readonly scoped: ScopedPrismaService,
    private readonly relocation: RelocationService,
  ) {}

  async create(dto: CreateScheduleExceptionDto) {
    await this.assertProviderAndPractice(dto.providerId, dto.practiceId);
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    const orgId = this.scoped.orgId;

    // 1. Apply the block + collect displaced bookings (one transaction).
    const { exception, blockedSlotCount, affected } =
      await this.scoped.db.$transaction(async (tx) => {
        const exception = await tx.scheduleException.create({
          data: {
            orgId,
            providerId: dto.providerId,
            practiceId: dto.practiceId,
            type: dto.type,
            startAt,
            endAt,
            allDay: dto.allDay,
            reason: dto.reason,
          },
        });

        // Block overlapping OPEN slots (overlap = slot.start < end AND slot.end > start).
        const blocked = await tx.slot.updateMany({
          where: {
            providerId: dto.providerId,
            status: 'open',
            startAt: { lt: endAt },
            endAt: { gt: startAt },
            ...(dto.practiceId ? { practiceId: dto.practiceId } : {}),
          },
          data: { status: 'blocked' },
        });

        const affected = await tx.appointment.findMany({
          where: {
            providerId: dto.providerId,
            status: { in: ['requested', 'confirmed', 'checked_in'] },
            ...(dto.practiceId ? { practiceId: dto.practiceId } : {}),
            slot: { startAt: { lt: endAt }, endAt: { gt: startAt } },
          },
          select: RELOCATABLE_SELECT,
          orderBy: { slot: { startAt: 'asc' } },
        });

        return { exception, blockedSlotCount: blocked.count, affected };
      });

    // 2. After the block commits, migrate the displaced future bookings (notify each patient).
    const relocation = await this.relocation.relocate(affected, {
      migrate: true,
      reason: dto.type,
    });

    return { ...toResponse(exception), blockedSlotCount, ...relocation };
  }

  list(filter: ListScheduleExceptionsQueryDto) {
    return this.scoped.db.scheduleException
      .findMany({
        where: {
          providerId: filter.providerId,
          practiceId: filter.practiceId,
          startAt: filter.to ? { lt: new Date(filter.to) } : undefined,
          endAt: filter.from ? { gt: new Date(filter.from) } : undefined,
        },
        orderBy: { startAt: 'asc' },
      })
      .then((rows) => rows.map(toResponse));
  }

  async get(id: string) {
    const ex = await this.scoped.db.scheduleException.findFirst({
      where: { id },
    });
    if (!ex) throw new NotFoundException('Schedule exception not found');
    return toResponse(ex);
  }

  /** Remove a block and reopen the slots it covered — unless another active block still covers them. */
  async remove(id: string): Promise<void> {
    const orgId = this.scoped.orgId;
    await this.scoped.db.$transaction(async (tx) => {
      const ex = await tx.scheduleException.findFirst({
        where: { id },
        select: {
          id: true,
          providerId: true,
          practiceId: true,
          startAt: true,
          endAt: true,
        },
      });
      if (!ex) throw new NotFoundException('Schedule exception not found');

      await tx.scheduleException.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      // Reopen blocked slots in this block's window that no OTHER active block still covers.
      await tx.$executeRaw`
        UPDATE "slot" SET status = 'open', updated_at = now()
         WHERE org_id = ${orgId}::uuid AND provider_id = ${ex.providerId}::uuid
           AND status = 'blocked'
           AND start_at < ${ex.endAt} AND end_at > ${ex.startAt}
           AND (${ex.practiceId}::uuid IS NULL OR practice_id = ${ex.practiceId}::uuid)
           AND NOT EXISTS (
             SELECT 1 FROM "schedule_exception" se
              WHERE se.org_id = "slot".org_id AND se.provider_id = "slot".provider_id
                AND se.deleted_at IS NULL AND se.id <> ${id}::uuid
                AND se.type IN ('time_off', 'holiday', 'surgery', 'busy')
                AND (se.practice_id IS NULL OR se.practice_id = "slot".practice_id)
                AND se.start_at < "slot".end_at AND se.end_at > "slot".start_at
           )`;
    });
  }

  private async assertProviderAndPractice(
    providerId: string,
    practiceId?: string,
  ): Promise<void> {
    const provider = await this.scoped.db.staff.findFirst({
      where: { id: providerId },
      select: { id: true, roles: true },
    });
    if (!provider) {
      throw new BadRequestException(
        'providerId does not reference staff in this organization',
      );
    }
    if (!provider.roles.includes('doctor')) {
      throw new BadRequestException('provider must have the doctor role');
    }
    if (practiceId) {
      const practice = await this.scoped.db.practice.findFirst({
        where: { id: practiceId },
        select: { id: true },
      });
      if (!practice) {
        throw new BadRequestException(
          'practiceId does not reference a practice in this organization',
        );
      }
    }
  }
}

function toResponse(e: ScheduleException) {
  return {
    id: e.id,
    providerId: e.providerId,
    practiceId: e.practiceId,
    type: e.type,
    startAt: e.startAt,
    endAt: e.endAt,
    allDay: e.allDay,
    reason: e.reason,
    createdAt: e.createdAt,
  };
}
