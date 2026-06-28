import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

/**
 * Translates the two Prisma write errors feature services routinely hit into HTTP exceptions:
 *   - P2002 (unique constraint) → 409 Conflict
 *   - P2025 (record not found / required row missing) → 404 Not Found
 * Anything else is rethrown unchanged (surfaces as a 500). Call from a service `catch`:
 *
 *   catch (err) { throwMappedPrismaError(err, { conflict: 'Code already in use' }); }
 */
export function throwMappedPrismaError(
  err: unknown,
  messages?: { conflict?: string; notFound?: string },
): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      throw new ConflictException(messages?.conflict ?? 'Resource already exists');
    }
    if (err.code === 'P2025') {
      throw new NotFoundException(messages?.notFound ?? 'Resource not found');
    }
  }
  throw err;
}
