// cron.ts — a compact, dependency-free 5-field cron expression engine.
//
// Supported syntax (standard cron, minute resolution):
//   ┌───────────── minute (0-59)
//   │ ┌───────────── hour (0-23)
//   │ │ ┌───────────── day of month (1-31)
//   │ │ │ ┌───────────── month (1-12 or JAN-DEC)
//   │ │ │ │ ┌───────────── day of week (0-7, 0 and 7 = SUN, or MON-SUN)
//   │ │ │ │ │
//   * * * * *
//
// Each field accepts: *, a number, a range (1-5), a list (1,3,5), a step
// (*/10, 1-30/5), and names for month/dow (MON-FRI). The day-of-month and
// day-of-week fields follow the standard OR rule: when both are restricted,
// a day matching EITHER field fires.
//
// Timezone support: `nextRun` and `describe` evaluate the expression in the
// given IANA timezone by computing the offset of the target wall-clock time
// (the same approach cron-parser uses; no external dependency needed).

export interface CronField {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** true when the day-of-month field was left unrestricted (*) */
  domUnrestricted: boolean;
  /** true when the day-of-week field was left unrestricted (*) */
  dowUnrestricted: boolean;
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (7 → 0)
];

function normalizeToken(token: string, fieldIndex: number): number {
  const upper = token.toUpperCase();
  if (fieldIndex === 3) {
    const idx = MONTH_NAMES.indexOf(upper);
    if (idx >= 0) return idx + 1;
  }
  if (fieldIndex === 4) {
    const idx = DOW_NAMES.indexOf(upper);
    if (idx >= 0) return idx;
  }
  const n = Number(token);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CronParseError(`invalid value "${token}" in cron field ${fieldIndex + 1}`);
  }
  return n;
}

function parseField(raw: string, fieldIndex: number): { values: Set<number>; unrestricted: boolean } {
  const [min, max] = FIELD_RANGES[fieldIndex];
  const trimmed = raw.trim();
  if (!trimmed) throw new CronParseError(`cron field ${fieldIndex + 1} is empty`);

  const values = new Set<number>();
  let unrestricted = false;

  for (const part of trimmed.split(',')) {
    if (!part) throw new CronParseError(`empty list item in cron field ${fieldIndex + 1}`);
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isFinite(step) || step < 1) {
      throw new CronParseError(`invalid step "/${stepPart}" in cron field ${fieldIndex + 1}`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      if (stepPart === undefined && part === '*') unrestricted = true;
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = normalizeToken(a, fieldIndex);
      hi = normalizeToken(b, fieldIndex);
    } else {
      lo = normalizeToken(rangePart, fieldIndex);
      hi = stepPart !== undefined ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronParseError(
        `value out of range (${min}-${max}) in cron field ${fieldIndex + 1}: "${part}"`
      );
    }
    for (let v = lo; v <= hi; v += step) values.add(v === 7 && fieldIndex === 4 ? 0 : v);
  }
  if (!values.size) throw new CronParseError(`cron field ${fieldIndex + 1} resolves to nothing`);
  return { values, unrestricted };
}

export function parseCron(expr: string): CronField {
  const raw = String(expr ?? '').trim();
  // support "6 fields" by rejecting the seconds prefix explicitly (no silent
  // misinterpretation)
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`
    );
  }
  const minute = parseField(parts[0], 0);
  const hour = parseField(parts[1], 1);
  const dom = parseField(parts[2], 2);
  const month = parseField(parts[3], 3);
  const dow = parseField(parts[4], 4);
  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domUnrestricted: dom.unrestricted,
    dowUnrestricted: dow.unrestricted,
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

// ---------- timezone handling ----------

/** The UTC offset (ms) of `timezone` at the given UTC instant. */
function tzOffsetMs(timezone: string, at: Date): number {
  if (!timezone) return -at.getTimezoneOffset() * 60_000; // server local
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  return asUTC - at.getTime();
}

/** The wall-clock parts of a UTC instant, in the given timezone. */
function wallParts(at: Date, timezone: string): { y: number; m: number; d: number; h: number; min: number; dow: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || undefined,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour')) % 24,
    min: Number(get('minute')),
    dow: DOW_NAMES.indexOf(get('weekday').slice(0, 3).toUpperCase()),
  };
}

function dayMatches(field: CronField, m: number, d: number, dow: number): boolean {
  if (!field.months.has(m)) return false;
  const domOk = field.daysOfMonth.has(d);
  const dowOk = field.daysOfWeek.has(dow);
  // standard cron rule: when BOTH fields are restricted, either may match
  if (field.domUnrestricted && field.dowUnrestricted) return true;
  if (field.domUnrestricted) return dowOk;
  if (field.dowUnrestricted) return domOk;
  return domOk || dowOk;
}

/**
 * The next firing time AFTER `from` (exclusive), in the given timezone.
 * Returns a UTC Date. The scan is bounded (4 years) so leap-day expressions
 * (e.g. `0 5 29 2 *`) still resolve; a truly unsatisfiable expression
 * (e.g. Feb 30) returns null instead of looping forever.
 *
 * Algorithm: coarse jumps (month → day → hour → minute) on the WALL CLOCK of
 * the target timezone, converting to UTC with the timezone offset. This is
 * at most ~1460 iterations for the 4-year day-jump bound, never
 * minute-by-minute.
 */
export function nextCronRun(expr: string, from: Date = new Date(), timezone = ''): Date | null {
  const field = parseCron(expr);
  // start at the next whole minute after `from`
  let cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const limit = new Date(from.getTime() + 4 * 366 * 24 * 60 * 60 * 1000);
  const sortedMinutes = [...field.minutes].sort((a, b) => a - b);
  const sortedHours = [...field.hours].sort((a, b) => a - b);

  /** wall-clock (y,m,d,h,min) → UTC instant using the timezone offset */
  const toUtc = (y: number, m: number, d: number, h: number, min: number): Date => {
    const approx = new Date(Date.UTC(y, m - 1, d, h, min));
    const off = tzOffsetMs(timezone, approx);
    const exact = new Date(Date.UTC(y, m - 1, d, h, min) - off);
    // refine once (the offset can shift between approx and exact across DST)
    const off2 = tzOffsetMs(timezone, exact);
    return off2 === off ? exact : new Date(Date.UTC(y, m - 1, d, h, min) - off2);
  };

  // C2: a wall-clock time inside a DST GAP (spring-forward, e.g. 02:30 on the
  // night clocks jump 02:00→03:00) does not exist. `toUtc` then resolves it to
  // a UTC instant whose wall clock is EARLIER than the cursor that produced it
  // — the scan would recompute the same cursor forever and freeze the server.
  // `advance` guarantees the cursor moves forward on every iteration; if a
  // candidate does not progress, we step one minute past the previous cursor
  // and keep scanning (the run lands after the gap, typically next day).
  let prevMs = cursor.getTime();
  const advance = (candidate: Date): void => {
    cursor = candidate.getTime() > prevMs ? candidate : new Date(prevMs + 60_000);
  };

  while (cursor <= limit) {
    prevMs = cursor.getTime();
    const w = wallParts(cursor, timezone);

    // 1) month
    if (!field.months.has(w.m)) {
      const nextMonth = [...field.months].sort((a, b) => a - b).find((m) => m > w.m);
      if (nextMonth === undefined) {
        advance(toUtc(w.y + 1, Math.min(...field.months), 1, 0, 0));
      } else {
        advance(toUtc(w.y, nextMonth, 1, 0, 0));
      }
      continue;
    }

    // 2) day of month / day of week (standard OR rule)
    if (!dayMatches(field, w.m, w.d, w.dow)) {
      advance(toUtc(w.y, w.m, w.d + 1, 0, 0));
      continue;
    }

    // 3) hour
    if (!field.hours.has(w.h)) {
      const nextH = sortedHours.find((h) => h > w.h);
      if (nextH === undefined) {
        advance(toUtc(w.y, w.m, w.d + 1, 0, 0));
      } else {
        advance(toUtc(w.y, w.m, w.d, nextH, sortedMinutes[0]));
      }
      continue;
    }

    // 4) minute
    if (!field.minutes.has(w.min)) {
      const nextMin = sortedMinutes.find((m) => m > w.min);
      if (nextMin === undefined) {
        const nextH = sortedHours.find((h) => h > w.h);
        if (nextH === undefined) {
          advance(toUtc(w.y, w.m, w.d + 1, 0, 0));
        } else {
          advance(toUtc(w.y, w.m, w.d, nextH, sortedMinutes[0]));
        }
      } else {
        advance(toUtc(w.y, w.m, w.d, w.h, nextMin));
      }
      continue;
    }

    // all fields match — but make sure we are genuinely AFTER `from`
    if (cursor.getTime() > from.getTime()) return cursor;
    advance(new Date(prevMs + 60_000));
  }
  return null;
}

/**
 * A human-readable description, used by the UI so nobody has to decode a
 * raw expression. Not exhaustive — common patterns get named, everything
 * else falls back to the expression itself.
 */
export function describeCron(expr: string): string {
  const raw = String(expr ?? '').trim();
  if (raw === '* * * * *') return 'Every minute';
  if (raw === '0 * * * *') return 'Hourly';
  if (/^\d+ \* \* \* \*$/.test(raw)) return `Every hour at :${raw.split(' ')[0].padStart(2, '0')}`;
  if (raw === '0 0 * * *') return 'Daily at midnight';
  const m = raw.match(/^(\d+) (\d+) \* \* \*$/);
  if (m) return `Daily at ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  if (raw === '0 0 * * 0') return 'Weekly on Sunday';
  if (raw === '0 0 * * 1') return 'Weekly on Monday';
  if (raw === '0 0 1 * *') return 'Monthly on the 1st';
  if (raw === '0 9 * * 1-5') return 'Weekdays at 09:00';
  return `Cron: ${raw}`;
}
