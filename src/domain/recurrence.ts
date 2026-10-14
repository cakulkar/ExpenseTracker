/**
 * Recurring expected payments. Every due date is computed from the anchor date
 * (occurrence n = anchor + n × period), so month-end and leap-day dates never drift:
 * Jan 31 monthly → Feb 28 (29 in leap years) → Mar 31 → Apr 30 …
 */
import type { Expense, Frequency, RecurringExpense } from './types';
import { addDays, addMonthsClamped, dayNumber, type IsoDate } from './dates';
import { normalizeMerchant } from './expenseQuery';

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: 'week',
  monthly: 'month',
  quarterly: 'quarter',
  annual: 'year',
};

export function describeSchedule(r: Pick<RecurringExpense, 'frequency' | 'interval'>): string {
  const unit = FREQUENCY_LABEL[r.frequency];
  return r.interval === 1 ? `Every ${unit}` : `Every ${r.interval} ${unit}s`;
}

export function occurrence(anchor: IsoDate, frequency: Frequency, interval: number, n: number): IsoDate {
  if (!Number.isInteger(interval) || interval < 1) throw new RangeError('interval must be a positive integer');
  switch (frequency) {
    case 'weekly':
      return addDays(anchor, 7 * interval * n);
    case 'monthly':
      return addMonthsClamped(anchor, interval * n);
    case 'quarterly':
      return addMonthsClamped(anchor, 3 * interval * n);
    case 'annual':
      return addMonthsClamped(anchor, 12 * interval * n);
  }
}

/** Index of the first occurrence on or after `date` (0 if date <= anchor). */
function firstIndexOnOrAfter(anchor: IsoDate, frequency: Frequency, interval: number, date: IsoDate): number {
  if (date <= anchor) return 0;
  // Estimate, then correct — avoids iterating over years of weekly dates.
  const days = dayNumber(date) - dayNumber(anchor);
  const approxPeriod = frequency === 'weekly' ? 7 * interval : frequency === 'monthly' ? 30.4 * interval : frequency === 'quarterly' ? 91.3 * interval : 365.25 * interval;
  let n = Math.max(0, Math.floor(days / approxPeriod) - 1);
  while (occurrence(anchor, frequency, interval, n) < date) n++;
  while (n > 0 && occurrence(anchor, frequency, interval, n - 1) >= date) n--;
  return n;
}

export function nextOccurrenceOnOrAfter(r: Pick<RecurringExpense, 'anchorDate' | 'frequency' | 'interval'>, date: IsoDate): IsoDate {
  return occurrence(r.anchorDate, r.frequency, r.interval, firstIndexOnOrAfter(r.anchorDate, r.frequency, r.interval, date));
}

export function nextOccurrenceAfter(r: Pick<RecurringExpense, 'anchorDate' | 'frequency' | 'interval'>, date: IsoDate): IsoDate {
  return nextOccurrenceOnOrAfter(r, addDays(date, 1));
}

export function occurrencesBetween(r: Pick<RecurringExpense, 'anchorDate' | 'frequency' | 'interval'>, from: IsoDate, to: IsoDate, max = 400): IsoDate[] {
  const out: IsoDate[] = [];
  let n = firstIndexOnOrAfter(r.anchorDate, r.frequency, r.interval, from);
  for (;;) {
    const d = occurrence(r.anchorDate, r.frequency, r.interval, n++);
    if (d > to || out.length >= max) break;
    out.push(d);
  }
  return out;
}

export type RecurringState = 'overdue' | 'due_soon' | 'upcoming' | 'inactive';

export function recurringState(r: RecurringExpense, today: IsoDate, soonDays = 7): RecurringState {
  if (!r.isActive || r.deletedAt) return 'inactive';
  if (r.nextDueDate < today) return 'overdue';
  if (dayNumber(r.nextDueDate) - dayNumber(today) <= soonDays) return 'due_soon';
  return 'upcoming';
}

export interface MatchCandidate {
  expense: Expense;
  score: number;
  reasons: string[];
}

/**
 * Existing expenses that probably are this bill's payment for `dueDate`, so the user can link one
 * instead of entering a duplicate. Never links automatically.
 */
export function findPaymentMatches(r: RecurringExpense, expenses: readonly Expense[], dueDate: IsoDate, windowDays = 10): MatchCandidate[] {
  const name = normalizeMerchant(r.merchantName);
  const out: MatchCandidate[] = [];
  for (const e of expenses) {
    if (e.deletedAt || e.kind !== 'expense') continue;
    if (e.recurringExpenseId && e.recurringExpenseId !== r.recurringExpenseId) continue;
    const dist = Math.abs(dayNumber(e.transactionDate) - dayNumber(dueDate));
    if (dist > windowDays) continue;
    const reasons: string[] = [];
    let score = 0;
    const nameMatch = name.length >= 3 && (e.merchantNormalized.includes(name) || (e.merchantNormalized.length >= 3 && name.includes(e.merchantNormalized)));
    if (nameMatch) {
      score += 3;
      reasons.push('same merchant');
    }
    const tolerance = Math.max(100, Math.round(r.expectedAmountCents * 0.1));
    if (Math.abs(e.totalCents - r.expectedAmountCents) <= tolerance) {
      score += e.totalCents === r.expectedAmountCents ? 3 : 2;
      reasons.push(e.totalCents === r.expectedAmountCents ? 'same amount' : 'similar amount');
    }
    if (e.categoryId === r.categoryId) {
      score += 1;
      reasons.push('same category');
    }
    if (e.recurringExpenseId === r.recurringExpenseId) {
      score += 5;
      reasons.push('already linked');
    }
    score += Math.max(0, 2 - dist / 5);
    if (nameMatch || reasons.includes('same amount') || reasons.includes('already linked')) out.push({ expense: e, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}
