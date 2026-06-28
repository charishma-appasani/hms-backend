/**
 * Per-model tenant metadata that drives the scoped Prisma client (see scoped-prisma.service.ts).
 *
 * The scoped client auto-applies, per request:
 *   - `org`        → filter reads/updates by `orgId`, stamp `orgId` on creates
 *   - `softDelete` → filter `deletedAt IS NULL` on reads/updates; hard `delete()` is BLOCKED
 *     (call `update({ data: { deletedAt, deletedBy } })` instead — reads then hide the row)
 *   - `createdBy`  → stamp the request actor on creates
 *   - `updatedBy`  → stamp the request actor on creates and updates
 *
 * Keyed by the Prisma model name (the PascalCase `model` passed to a `$allOperations` extension),
 * NOT the table name. Models absent from this map (AppUser, Patient, Organization, AuditLog) are
 * GLOBAL / platform-owned and pass through the scoped client untouched — they are reached through
 * the platform namespace or an explicit registration gate, never tenant-scoped.
 *
 * Mirror this map against prisma/schema.prisma whenever a tenant model's columns change.
 */
export interface TenantModelMeta {
  /** Has an `org_id` column → scope every read/write by the request's orgId. */
  org: boolean;
  /** Has `deleted_at` + `deleted_by` → filter soft-deleted rows; block hard deletes. */
  softDelete: boolean;
  /** Has a `created_by` column → stamp the request actor on create. */
  createdBy: boolean;
  /** Has an `updated_by` column → stamp the request actor on create + update. */
  updatedBy: boolean;
}

export const TENANT_MODELS: Record<string, TenantModelMeta> = {
  Practice: { org: true, softDelete: true, createdBy: true, updatedBy: true },
  Staff: { org: true, softDelete: true, createdBy: true, updatedBy: true },
  StaffPractice: { org: true, softDelete: false, createdBy: false, updatedBy: false },
  Consent: { org: true, softDelete: false, createdBy: true, updatedBy: false },
  PatientRegistration: { org: true, softDelete: true, createdBy: true, updatedBy: true },
  AvailabilityTemplate: { org: true, softDelete: true, createdBy: true, updatedBy: true },
  ScheduleException: { org: true, softDelete: true, createdBy: true, updatedBy: true },
  Slot: { org: true, softDelete: false, createdBy: false, updatedBy: false },
  Appointment: { org: true, softDelete: true, createdBy: true, updatedBy: true },
  Visit: { org: true, softDelete: true, createdBy: true, updatedBy: true },
  NumberSequence: { org: true, softDelete: false, createdBy: false, updatedBy: false },
};
