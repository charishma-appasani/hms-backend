import { zonedTimeToUtc } from '../../common/datetime';
import type {
  AvailabilityTemplate,
  Prisma,
} from '../../../generated/prisma/client';

/**
 * Pure slot-generation logic, shared by template creation (eager generation) and any future
 * regeneration (schedule replace). No DB access — callers persist the returned rows.
 *
 * A template is bounded (validFrom..validTo, ≤8 weeks) and recurs on a single weekday. This
 * expands it into the concrete `slot` rows for every occurrence in the range, resolving each
 * template-local wall-clock time to a UTC instant with the practice timezone.
 */
export function slotRowsForTemplate(
  template: AvailabilityTemplate,
  timeZone: string,
): Prisma.SlotCreateManyInput[] {
  const rows: Prisma.SlotCreateManyInput[] = [];
  const end = template.validTo ?? template.validFrom;

  // Walk weekly from the first occurrence (validFrom is already on the template's weekday).
  const cursor = new Date(template.validFrom.getTime());
  while (cursor.getUTCDay() !== template.weekday) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  while (cursor.getTime() <= end.getTime()) {
    rows.push(
      ...slotRowsForDate(
        template,
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + 1,
        cursor.getUTCDate(),
        timeZone,
      ),
    );
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return rows;
}

/** One occurrence date: per-interval rows in slot mode, a single session row in token mode. */
function slotRowsForDate(
  t: AvailabilityTemplate,
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Prisma.SlotCreateManyInput[] {
  const startMin = t.startTime.getUTCHours() * 60 + t.startTime.getUTCMinutes();
  const endMin = t.endTime.getUTCHours() * 60 + t.endTime.getUTCMinutes();

  const at = (min: number) =>
    zonedTimeToUtc(year, month, day, Math.floor(min / 60), min % 60, timeZone);
  const row = (fromMin: number, toMin: number): Prisma.SlotCreateManyInput => ({
    orgId: t.orgId,
    practiceId: t.practiceId,
    providerId: t.providerId,
    templateId: t.id,
    mode: t.mode,
    startAt: at(fromMin),
    endAt: at(toMin),
    apptCapacity: t.apptCapacity,
    walkinCapacity: t.walkinCapacity,
  });

  if (t.mode === 'token') {
    return [row(startMin, endMin)]; // one session; tokens drawn against the session capacities
  }

  const step = t.slotDurationMins ?? 0;
  if (step <= 0) return [];
  const rows: Prisma.SlotCreateManyInput[] = [];
  for (let m = startMin; m + step <= endMin; m += step) {
    rows.push(row(m, m + step));
  }
  return rows;
}
