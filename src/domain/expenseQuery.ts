/**
 * Pure filtering, searching, sorting and totalling of expenses.
 * The dashboard, list and (later) exports all use these functions so numbers always agree.
 */
import type { Expense, ExpenseType, VerificationStatus } from './types';
import type { Cents } from './money';
import { signedAmount, sumCents } from './money';
import type { IsoDate } from './dates';

export interface ExpenseFilter {
  from?: IsoDate;
  to?: IsoDate;
  text?: string;
  minCents?: Cents;
  maxCents?: Cents;
  categoryIds?: readonly string[];
  paidByMemberId?: string;
  expenseType?: ExpenseType;
  hasReceipt?: boolean;
  isRecurring?: boolean;
  verificationStatus?: VerificationStatus;
  kind?: 'expense' | 'refund';
  includeDeleted?: boolean;
}

export type SortKey = 'date' | 'merchant' | 'amount';
export type SortDir = 'asc' | 'desc';

/** Lowercase, strip punctuation and store-number noise for matching ("WAL-MART #1234" -> "wal mart"). */
export function normalizeMerchant(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/#\s*\d+/g, ' ')
    .replace(/\b(store|str|no)\.?\s*\d+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function matchesFilter(e: Expense, f: ExpenseFilter, categoryParents?: ReadonlyMap<string, string | undefined>): boolean {
  if (!f.includeDeleted && e.deletedAt) return false;
  if (f.from && e.transactionDate < f.from) return false;
  if (f.to && e.transactionDate > f.to) return false;
  if (f.minCents !== undefined && e.totalCents < f.minCents) return false;
  if (f.maxCents !== undefined && e.totalCents > f.maxCents) return false;
  if (f.categoryIds && f.categoryIds.length > 0) {
    const parent = categoryParents?.get(e.categoryId);
    const ids = new Set(f.categoryIds);
    if (!ids.has(e.categoryId) && !(parent && ids.has(parent)) && !(e.subcategoryId && ids.has(e.subcategoryId))) {
      return false;
    }
  }
  if (f.paidByMemberId && e.paidByMemberId !== f.paidByMemberId) return false;
  if (f.expenseType && e.expenseType !== f.expenseType) return false;
  if (f.hasReceipt !== undefined && Boolean(e.receiptId) !== f.hasReceipt) return false;
  if (f.isRecurring !== undefined && Boolean(e.recurringExpenseId) !== f.isRecurring) return false;
  if (f.verificationStatus && e.verificationStatus !== f.verificationStatus) return false;
  if (f.kind && e.kind !== f.kind) return false;
  if (f.text) {
    const terms = normalizeMerchant(f.text).split(' ').filter(Boolean);
    const hay = `${e.merchantNormalized} ${normalizeMerchant(e.notes)}`;
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
}

export function filterExpenses(
  list: readonly Expense[],
  f: ExpenseFilter,
  categoryParents?: ReadonlyMap<string, string | undefined>,
): Expense[] {
  return list.filter((e) => matchesFilter(e, f, categoryParents));
}

export function sortExpenses(list: readonly Expense[], key: SortKey, dir: SortDir): Expense[] {
  const mul = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let c = 0;
    if (key === 'date') c = a.transactionDate.localeCompare(b.transactionDate) || a.createdAt.localeCompare(b.createdAt);
    else if (key === 'merchant') c = a.merchantNormalized.localeCompare(b.merchantNormalized);
    else c = signedAmount(a) - signedAmount(b);
    return c * mul || a.expenseId.localeCompare(b.expenseId);
  });
}

export interface Totals {
  netCents: Cents;
  expenseCents: Cents;
  refundCents: Cents;
  sharedCents: Cents;
  personalCents: Cents;
  count: number;
  byCategory: Map<string, Cents>;
  byMember: Map<string, Cents>;
}

/**
 * Totals over a filtered list. Refunds reduce net spending. Each expense is counted exactly once.
 * byCategory rolls subcategories into their top-level parent when a parent map is supplied.
 */
export function computeTotals(list: readonly Expense[], categoryParents?: ReadonlyMap<string, string | undefined>): Totals {
  const live = list.filter((e) => !e.deletedAt);
  const byCategory = new Map<string, Cents>();
  const byMember = new Map<string, Cents>();
  for (const e of live) {
    const amt = signedAmount(e);
    const cat = categoryParents?.get(e.categoryId) ?? e.categoryId;
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + amt);
    byMember.set(e.paidByMemberId, (byMember.get(e.paidByMemberId) ?? 0) + amt);
  }
  return {
    netCents: sumCents(live.map(signedAmount)),
    expenseCents: sumCents(live.filter((e) => e.kind === 'expense').map((e) => e.totalCents)),
    refundCents: sumCents(live.filter((e) => e.kind === 'refund').map((e) => e.totalCents)),
    sharedCents: sumCents(live.filter((e) => e.expenseType === 'shared').map(signedAmount)),
    personalCents: sumCents(live.filter((e) => e.expenseType === 'personal').map(signedAmount)),
    count: live.length,
    byCategory,
    byMember,
  };
}
