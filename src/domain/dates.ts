/**
 * Date handling.
 * - Calendar dates (transaction dates, due dates) are ISO date strings "YYYY-MM-DD" in the
 *   household timezone. They carry no time and never shift across timezones.
 * - Instants (createdAt, updatedAt) are ISO-8601 UTC strings from `new Date().toISOString()`.
 * The household timezone defaults to America/Detroit.
 */

export const DEFAULT_TIMEZONE = 'America/Detroit';

export type IsoDate = string; // YYYY-MM-DD
export type MonthKey = string; // YYYY-MM

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

export function isValidIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function parseIsoDate(s: IsoDate): { y: number; m: number; d: number } {
  if (!isValidIsoDate(s)) throw new RangeError(`Invalid date: ${s}`);
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

export function toIsoDate(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Today's calendar date in the given timezone. */
export function todayIn(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function monthOf(date: IsoDate): MonthKey {
  parseIsoDate(date);
  return date.slice(0, 7);
}

export function isValidMonth(s: unknown): s is MonthKey {
  if (typeof s !== 'string') return false;
  const m = MONTH_RE.exec(s);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

export function monthRange(month: MonthKey): { from: IsoDate; to: IsoDate } {
  if (!isValidMonth(month)) throw new RangeError(`Invalid month: ${month}`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: toIsoDate(y, m, 1), to: toIsoDate(y, m, daysInMonth(y, m)) };
}

export function addMonthsToMonth(month: MonthKey, n: number): MonthKey {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/**
 * Add calendar months to a date, clamping to the end of the target month.
 * Jan 31 + 1 month -> Feb 28/29. Feb 29 + 12 months -> Feb 28.
 */
export function addMonthsClamped(date: IsoDate, n: number): IsoDate {
  const { y, m, d } = parseIsoDate(date);
  const [ny, nm] = addMonthsToMonth(`${y}-${String(m).padStart(2, '0')}`, n).split('-').map(Number) as [number, number];
  return toIsoDate(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addYearsClamped(date: IsoDate, years: number): IsoDate {
  return addMonthsClamped(date, years * 12);
}

/** Day number since 1970-01-01 for a calendar date (timezone-free). */
export function dayNumber(date: IsoDate): number {
  const { y, m, d } = parseIsoDate(date);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function addDays(date: IsoDate, n: number): IsoDate {
  const dt = new Date((dayNumber(date) + n) * 86_400_000);
  return toIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const longFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "Oct 14, 2026" — formatted without timezone shifting. */
export function formatDate(date: IsoDate): string {
  const { y, m, d } = parseIsoDate(date);
  return longFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

/** "October 2026" */
export function formatMonth(month: MonthKey): string {
  const { from } = monthRange(month);
  const { y, m } = parseIsoDate(from);
  return monthFmt.format(new Date(Date.UTC(y, m - 1, 1)));
}

/** Format an instant (UTC ISO string) as local date-time in the household timezone. */
export function formatInstant(iso: string, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
