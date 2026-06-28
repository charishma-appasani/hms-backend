import { PrismaClient } from '../../generated/prisma/client';
import { TENANT_MODELS, type TenantModelMeta } from './tenant-models';

/** The actor + tenant a scoped client is bound to for the lifetime of one request. */
export interface ScopeContext {
  /** Organization the caller is acting within (orgContext.orgId). */
  orgId: string;
  /** app_user.id of the caller — stamped into created_by / updated_by. */
  actorId: string;
}

const READ_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Wraps the app-wide Prisma client in a `$extends` layer that transparently enforces tenant
 * isolation, soft-delete, and audit stamping for the bound {@link ScopeContext}. Feature services
 * inject the request-scoped client and write plain queries — the org filter and audit columns are
 * applied here, so they cannot be forgotten (a forgotten `org_id` filter is a cross-tenant leak).
 *
 * Deliberate guard rails (loud failures beat silent leaks):
 *   - `findUnique` / `findUniqueOrThrow` on a tenant model THROW — a point lookup by unique id
 *     reads naturally as `findFirst({ where: { id } })` here, where the org/soft-delete filter is
 *     unambiguous. (Single-row `update`/`delete` keep their unique `where`; the extra filters are
 *     injected via Prisma's extended-where-unique, so a cross-org id resolves to "not found".)
 *   - `delete` / `deleteMany` on a soft-delete model THROW — hard deletes bypass the soft-delete
 *     policy. Soft-delete via `update({ data: { deletedAt: new Date(), deletedBy } })`.
 *
 * Returns a fully-typed Prisma client; the extension is invisible to call sites.
 */
export function buildScopedClient(base: PrismaClient, ctx: ScopeContext) {
  return base.$extends({
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          const meta = TENANT_MODELS[model];
          if (!meta) return query(args); // global / platform model — untouched

          if (
            meta.org &&
            (operation === 'findUnique' || operation === 'findUniqueOrThrow')
          ) {
            throw new Error(
              `Scoped Prisma: ${operation} is not tenant-safe on ${model}. ` +
                `Use findFirst({ where: { id, ... } }) so the org filter applies.`,
            );
          }

          if (
            meta.softDelete &&
            (operation === 'delete' || operation === 'deleteMany')
          ) {
            throw new Error(
              `Scoped Prisma: hard ${operation} is blocked on ${model}. ` +
                `Soft-delete via update({ data: { deletedAt: new Date(), deletedBy } }).`,
            );
          }

          const next = { ...(args ?? {}) };

          if (READ_OPS.has(operation)) {
            next.where = scopeWhere(next.where, meta, ctx);
          } else if (operation === 'create') {
            next.data = stampCreate(next.data, meta, ctx);
          } else if (operation === 'createMany') {
            next.data = Array.isArray(next.data)
              ? next.data.map((row: unknown) => stampCreate(row, meta, ctx))
              : stampCreate(next.data, meta, ctx);
          } else if (operation === 'update' || operation === 'updateMany') {
            next.where = scopeWhere(next.where, meta, ctx);
            next.data = stampUpdate(next.data, meta, ctx);
          } else if (operation === 'upsert') {
            next.where = scopeWhere(next.where, meta, ctx);
            next.create = stampCreate(next.create, meta, ctx);
            next.update = stampUpdate(next.update, meta, ctx);
          } else if (operation === 'delete' || operation === 'deleteMany') {
            // non-soft-delete tenant model: still confine the hard delete to this org
            next.where = scopeWhere(next.where, meta, ctx);
          }

          return query(next);
        },
      },
    },
  });
}

/** Build the tenant client type once so providers/services can annotate against it. */
export type ScopedPrismaClient = ReturnType<typeof buildScopedClient>;

function scopeWhere(
  where: Record<string, unknown> | undefined,
  meta: TenantModelMeta,
  ctx: ScopeContext,
): Record<string, unknown> {
  const scoped = { ...(where ?? {}) };
  if (meta.org) scoped.orgId = ctx.orgId;
  // Respect an explicit deletedAt filter (e.g. a restore/admin query that opts in).
  if (meta.softDelete && scoped.deletedAt === undefined) scoped.deletedAt = null;
  return scoped;
}

function stampCreate(
  data: unknown,
  meta: TenantModelMeta,
  ctx: ScopeContext,
): Record<string, unknown> {
  const row = { ...(data as Record<string, unknown>) };
  if (meta.org) row.orgId = ctx.orgId;
  if (meta.createdBy) row.createdBy = ctx.actorId;
  if (meta.updatedBy) row.updatedBy = ctx.actorId;
  return row;
}

function stampUpdate(
  data: unknown,
  meta: TenantModelMeta,
  ctx: ScopeContext,
): Record<string, unknown> {
  const row = { ...(data as Record<string, unknown>) };
  if (meta.updatedBy) row.updatedBy = ctx.actorId;
  // Soft-delete via `update({ data: { deletedAt } })` → stamp the actor (or clear it on restore),
  // so services never set deletedBy by hand and it can't drift from deletedAt.
  if (meta.softDelete && 'deletedAt' in row) {
    row.deletedBy = row.deletedAt == null ? null : ctx.actorId;
  }
  return row;
}
