/**
 * Duplicate detection. Never deletes anything: it only reports suspected matches so the user can
 * compare, keep both, or merge.
 */
import type { Expense, Receipt } from './types';
import { dayNumber, type IsoDate } from './dates';
import { normalizeMerchant } from './expenseQuery';

export interface DuplicateCandidate {
  imageHash?: string;
  merchantName?: string;
  transactionDate?: IsoDate;
  totalCents?: number;
  receiptNumber?: string;
  /** Exclude this expense (when editing). */
  excludeExpenseId?: string;
}

export interface DuplicateMatch {
  expense: Expense;
  reasons: string[];
  strength: 'certain' | 'likely';
}

function similarMerchant(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(' ').filter((t) => t.length > 2));
  const tb = b.split(' ').filter((t) => t.length > 2);
  return tb.some((t) => ta.has(t));
}

export function findDuplicates(c: DuplicateCandidate, expenses: readonly Expense[], receipts: readonly Receipt[]): DuplicateMatch[] {
  const byExpense = new Map<string, DuplicateMatch>();
  const add = (e: Expense, reason: string, strength: DuplicateMatch['strength']) => {
    const m = byExpense.get(e.expenseId) ?? { expense: e, reasons: [], strength };
    if (!m.reasons.includes(reason)) m.reasons.push(reason);
    if (strength === 'certain') m.strength = 'certain';
    byExpense.set(e.expenseId, m);
  };
  const live = expenses.filter((e) => !e.deletedAt && e.expenseId !== c.excludeExpenseId);
  const expenseById = new Map(live.map((e) => [e.expenseId, e]));

  if (c.imageHash) {
    for (const r of receipts) {
      if (r.imageHash === c.imageHash) {
        const e = expenseById.get(r.expenseId);
        if (e) add(e, 'The same receipt image was already saved', 'certain');
      }
    }
  }
  const merchant = c.merchantName ? normalizeMerchant(c.merchantName) : '';
  for (const e of live) {
    if (c.receiptNumber && e.receiptNumber && c.receiptNumber === e.receiptNumber && similarMerchant(merchant, e.merchantNormalized)) {
      add(e, `Same receipt number (${c.receiptNumber}) at the same store`, 'certain');
    }
    if (
      c.totalCents !== undefined &&
      c.transactionDate &&
      e.totalCents === c.totalCents &&
      Math.abs(dayNumber(e.transactionDate) - dayNumber(c.transactionDate)) <= 1 &&
      similarMerchant(merchant, e.merchantNormalized)
    ) {
      add(e, 'Same store, same amount, same or next day', 'likely');
    }
  }
  return [...byExpense.values()].sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'certain' ? -1 : 1));
}
