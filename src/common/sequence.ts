import type { Prisma } from '../../generated/prisma/client';

/**
 * Atomic, gapless per-scope counter via INSERT … ON CONFLICT … +1 RETURNING (a single statement
 * serializes concurrent allocations). Used for UHID (scope = org) and visit# (scope = practice).
 */
export async function nextSequence(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  params: {
    orgId: string;
    scope: 'org' | 'practice';
    scopeId: string;
    name: 'uhid' | 'visit';
  },
): Promise<bigint> {
  const rows = await tx.$queryRaw<{ value: bigint }[]>`
    INSERT INTO "number_sequence" (id, org_id, scope, scope_id, name, current_value)
    VALUES (gen_random_uuid(), ${params.orgId}::uuid, ${params.scope}::"SequenceScope",
            ${params.scopeId}::uuid, ${params.name}::"SequenceName", 1)
    ON CONFLICT (org_id, scope, scope_id, name)
    DO UPDATE SET current_value = "number_sequence".current_value + 1
    RETURNING current_value AS "value"`;
  return rows[0].value;
}
