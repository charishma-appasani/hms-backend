import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';

/**
 * A free-form JSON object payload (e.g. practice `address`, organization `settings`), typed to
 * Prisma's JSON input so a validated value drops straight into a `data: {...}` without casting at
 * the call site. The single cast lives here: Zod infers `Record<string, unknown>`, which is
 * structurally fine but not assignable to Prisma's recursive `InputJsonObject`.
 */
export const jsonObjectSchema = z
  .record(z.string(), z.unknown())
  .transform((v) => v as Prisma.InputJsonObject);
