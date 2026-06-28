import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopedPrismaService } from '../prisma/scoped-prisma.service';
import { throwMappedPrismaError } from '../common/prisma-errors';
import type { CreatePracticeDto, UpdatePracticeDto } from './dto/practice.dto';

/**
 * Practices CRUD within the caller's current org. Every query goes through `ScopedPrismaService`,
 * so org scoping, soft-delete filtering, and audit stamping are applied automatically — this
 * service never reads orgId or stamps audit columns itself.
 */
@Injectable()
export class PracticesService {
  constructor(private readonly scoped: ScopedPrismaService) {}

  create(dto: CreatePracticeDto) {
    const { address, ...practice } = dto;
    // Address is a plain (non-tenant) row; create it then link by scalar address_id. One
    // transaction so a failed practice insert doesn't orphan the address. orgId is provided for
    // the type; the scoped client re-injects the same value (+ audit) at runtime.
    return this.scoped.db
      .$transaction(async (tx) => {
        const addr = address ? await tx.address.create({ data: address }) : null;
        return tx.practice.create({
          data: { ...practice, orgId: this.scoped.orgId, addressId: addr?.id },
          include: { address: true },
        });
      })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, {
          conflict: `A practice with code "${dto.code}" already exists in this organization`,
        }),
      );
  }

  list() {
    return this.scoped.db.practice.findMany({
      orderBy: { createdAt: 'desc' },
      include: { address: true },
    });
  }

  async get(id: string) {
    // findFirst (not findUnique) so the scoped client applies the org + soft-delete filter.
    const practice = await this.scoped.db.practice.findFirst({
      where: { id },
      include: { address: true },
    });
    if (!practice) throw new NotFoundException('Practice not found');
    return practice;
  }

  update(id: string, dto: UpdatePracticeDto) {
    const { address, ...practice } = dto;
    return this.scoped.db
      .$transaction(async (tx) => {
        const existing = await tx.practice.findFirst({
          where: { id },
          select: { id: true, addressId: true },
        });
        if (!existing) throw new NotFoundException('Practice not found');

        // Upsert the practice's address: update in place if it has one, else create + link.
        let addressId = existing.addressId;
        if (address) {
          if (addressId) {
            await tx.address.update({ where: { id: addressId }, data: address });
          } else {
            addressId = (await tx.address.create({ data: address })).id;
          }
        }

        return tx.practice.update({
          where: { id },
          data: { ...practice, addressId },
          include: { address: true },
        });
      })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, {
          notFound: 'Practice not found',
          conflict: 'A practice with that code already exists in this organization',
        }),
      );
  }

  async remove(id: string): Promise<void> {
    // Soft delete: the scoped client blocks hard deletes and stamps deleted_by from the request.
    await this.scoped.db.practice
      .update({ where: { id }, data: { deletedAt: new Date() } })
      .catch((err: unknown) =>
        throwMappedPrismaError(err, { notFound: 'Practice not found' }),
      );
  }
}
