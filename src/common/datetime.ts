/**
 * Conversions between API strings and the Date values Prisma uses for `@db.Time` / `@db.Date`
 * columns. Everything is handled in UTC so a wall-clock time/date round-trips unchanged regardless
 * of server timezone (a `time`/`date` column carries no zone). Practice-local interpretation of
 * these wall-clock values happens later, during slot generation, using the practice timezone.
 */

/** "HH:MM" (24h) → a 1970-01-01 UTC Date carrying that time-of-day (for `@db.Time`). */
export function parseTimeOfDay(value: string): Date {
  const [h, m] = value.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
}

/** `@db.Time` Date → "HH:MM" (24h). */
export function formatTimeOfDay(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** "YYYY-MM-DD" → a midnight-UTC Date (for `@db.Date`). */
export function parseDateOnly(value: string): Date {
  const [y, mo, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
}

/** `@db.Date` Date → "YYYY-MM-DD". */
export function formatDateOnly(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** The UTC instants bounding a practice-local calendar date [00:00, next 00:00). */
export function dayWindowUtc(
  date: string,
  timeZone: string,
): { dayStart: Date; dayEnd: Date } {
  const [y, mo, d] = date.split('-').map(Number);
  return {
    dayStart: zonedTimeToUtc(y, mo, d, 0, 0, timeZone),
    dayEnd: zonedTimeToUtc(y, mo, d, 24, 0, timeZone), // rolls to next local midnight
  };
}

/** A UTC instant → the practice-local calendar date it falls on (for `@db.Date`, e.g. session date). */
export function utcToZonedDateOnly(instant: Date, timeZone: string): Date {
  // en-CA formats as YYYY-MM-DD.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return parseDateOnly(ymd);
}

/** The offset (ms) of `timeZone` at the given instant: how far ahead of UTC the zone is. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

/**
 * A practice-local wall-clock moment (`year-month-day hour:minute` in `timeZone`) → the UTC instant
 * for a `timestamptz` column. Used by slot generation to anchor a template's local times to a date.
 * `hour`/`day` may overflow (e.g. hour 24) and roll over via Date.UTC. Month is 1-based.
 *
 * India has no DST so the offset is constant; the single-pass offset lookup is also correct for
 * DST zones except inside the ~1h/year ambiguous fold, which scheduling doesn't depend on.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = tzOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}
