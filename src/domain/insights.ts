/**
 * Transparent, rule-based insights. Each insight states exactly how it was calculated.
 * No predictions, no external services.
 */
import type { Category, Expense, Receipt, RecurringExpense } from './types';
import type { BudgetStatus } from './budget';
import { computeTotals } from './expenseQuery';
import { formatCents, percentOf } from './money';
import { addDays, addMonthsToMonth, dayNumber, formatDate, formatMonth, monthRange, type IsoDate, type MonthKey } from './dates';
import { recurringState } from './recurrence';

export interface Insight {
  id: string;
  kind: 'category_increase' | 'budget_near' | 'budget_over' | 'recurring_due' | 'recurring_overdue' | 'large_transaction' | 'receipt_pending' | 'receipt_failed' | 'receipt_missing';
  severity: 'info' | 'warning';
  title: string;
  detail: string;
  /** Plain-language explanation of the rule that produced this insight. */
  how: string;
  link?: string;
}

export interface InsightInput {
  month: MonthKey;
  today: IsoDate;
  expenses: readonly Expense[];
  categories: ReadonlyMap<string, Category>;
  categoryParents: ReadonlyMap<string, string | undefined>;
  budgetStatuses: readonly BudgetStatus[];
  recurring: readonly RecurringExpense[];
  receipts: readonly Receipt[];
}

export const INCREASE_MIN_PERCENT = 25;
export const INCREASE_MIN_CENTS = 2500;
export const LARGE_MULTIPLE = 3;
export const LARGE_MIN_CENTS = 10000;
export const MISSING_RECEIPT_MIN_CENTS = 7500;

function inRange(list: readonly Expense[], from: IsoDate, to: IsoDate): Expense[] {
  return list.filter((e) => !e.deletedAt && e.transactionDate >= from && e.transactionDate <= to);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function computeInsights(i: InsightInput): Insight[] {
  const out: Insight[] = [];
  const cur = monthRange(i.month);
  const prevMonth = addMonthsToMonth(i.month, -1);
  const prev = monthRange(prevMonth);
  const curTotals = computeTotals(inRange(i.expenses, cur.from, cur.to), i.categoryParents);
  const prevTotals = computeTotals(inRange(i.expenses, prev.from, prev.to), i.categoryParents);

  // 1. Category spending up vs previous month
  for (const [catId, now] of curTotals.byCategory) {
    const before = prevTotals.byCategory.get(catId) ?? 0;
    if (before <= 0) continue;
    const diff = now - before;
    const pct = percentOf(diff, before);
    if (diff >= INCREASE_MIN_CENTS && pct >= INCREASE_MIN_PERCENT) {
      const name = i.categories.get(catId)?.name ?? 'A category';
      out.push({
        id: `inc-${catId}-${i.month}`,
        kind: 'category_increase',
        severity: 'info',
        title: `${name} is up ${Math.round(pct)}%`,
        detail: `${formatCents(now)} in ${formatMonth(i.month)} vs ${formatCents(before)} in ${formatMonth(prevMonth)}.`,
        how: `Shown when a category's net spending this month is at least ${INCREASE_MIN_PERCENT}% and ${formatCents(INCREASE_MIN_CENTS)} higher than the whole previous month. Refunds are subtracted.`,
      });
    }
  }

  // 2. Budgets
  for (const s of i.budgetStatuses) {
    if (s.level === 'ok') continue;
    const name = s.budget.categoryId ? i.categories.get(s.budget.categoryId)?.name ?? 'Category' : 'Overall';
    out.push({
      id: `bud-${s.budget.budgetId}-${s.month}`,
      kind: s.level === 'over' ? 'budget_over' : 'budget_near',
      severity: 'warning',
      title: s.level === 'over' ? `${name} budget exceeded by ${formatCents(s.overCents)}` : `${name} budget is ${Math.floor(s.percentUsed)}% used`,
      detail: `${formatCents(s.spentCents)} of ${formatCents(s.limitCents)} spent.`,
      how: `Spending in the budget month (refunds subtracted${s.budget.scope === 'shared' ? ', shared expenses only' : ''}) divided by the monthly limit. Warning at ${s.budget.alertThresholdPercent}%, exceeded at 100%.`,
      link: '#/budgets',
    });
  }

  // 3. Recurring bills due within 7 days or overdue
  for (const r of i.recurring) {
    const st = recurringState(r, i.today);
    if (st !== 'due_soon' && st !== 'overdue') continue;
    out.push({
      id: `rec-${r.recurringExpenseId}-${r.nextDueDate}`,
      kind: st === 'overdue' ? 'recurring_overdue' : 'recurring_due',
      severity: st === 'overdue' ? 'warning' : 'info',
      title: st === 'overdue' ? `${r.merchantName} was due ${formatDate(r.nextDueDate)}` : `${r.merchantName} is due ${formatDate(r.nextDueDate)}`,
      detail: `Expected about ${formatCents(r.expectedAmountCents)}. Mark it paid or skip it on the Recurring page.`,
      how: 'Shown when a recurring bill’s next expected date is within 7 days, or has passed without being marked paid or skipped. The app never marks bills paid on its own.',
      link: '#/recurring',
    });
  }

  // 4. Unusually large transactions this month
  const lookbackFrom = addDays(cur.from, -90);
  const history = inRange(i.expenses, lookbackFrom, addDays(cur.from, -1)).filter((e) => e.kind === 'expense');
  if (history.length >= 5) {
    const med = median(history.map((e) => e.totalCents));
    const limit = Math.max(LARGE_MIN_CENTS, med * LARGE_MULTIPLE);
    for (const e of inRange(i.expenses, cur.from, cur.to)) {
      if (e.kind !== 'expense' || e.totalCents < limit) continue;
      out.push({
        id: `large-${e.expenseId}`,
        kind: 'large_transaction',
        severity: 'info',
        title: `Large transaction: ${e.merchantName}`,
        detail: `${formatCents(e.totalCents)} on ${formatDate(e.transactionDate)}. Worth a second look.`,
        how: `Shown for expenses of at least ${LARGE_MULTIPLE}× your median expense over the previous 90 days (median ${formatCents(med)}) and at least ${formatCents(LARGE_MIN_CENTS)}.`,
        link: `#/expenses/${e.expenseId}`,
      });
    }
  }

  // 5. Larger expenses this month without a receipt
  const missing = inRange(i.expenses, cur.from, cur.to).filter((e) => e.kind === 'expense' && !e.receiptId && e.totalCents >= MISSING_RECEIPT_MIN_CENTS && e.source !== 'recurring' && !e.recurringExpenseId);
  if (missing.length) {
    out.push({
      id: `rcpt-missing-${i.month}`,
      kind: 'receipt_missing',
      severity: 'info',
      title: `${missing.length} expense${missing.length > 1 ? 's' : ''} over ${formatCents(MISSING_RECEIPT_MIN_CENTS)} without a receipt`,
      detail: missing.slice(0, 3).map((e) => `${e.merchantName} (${formatCents(e.totalCents)})`).join(', ') + (missing.length > 3 ? '…' : ''),
      how: `Lists this month's expenses of at least ${formatCents(MISSING_RECEIPT_MIN_CENTS)} that have no receipt attached, excluding recurring bills. Open one and tap “Attach a receipt”, or ignore this if you don't need it.`,
      link: '#/expenses',
    });
  }

  // 6. Receipts waiting or failed
  const pending = i.receipts.filter((r) => r.deletionStatus === 'active' && (r.uploadStatus === 'pending' || r.uploadStatus === 'uploading'));
  const failed = i.receipts.filter((r) => r.deletionStatus === 'active' && r.uploadStatus === 'failed');
  if (pending.length) {
    out.push({
      id: 'rcpt-pending',
      kind: 'receipt_pending',
      severity: 'info',
      title: `${pending.length} receipt image${pending.length > 1 ? 's' : ''} waiting to upload`,
      detail: 'They are saved on this device and upload when Google Drive is connected and online.',
      how: 'Counts receipts saved on this device whose image has not reached Google Drive yet.',
      link: '#/sync',
    });
  }
  if (failed.length) {
    out.push({
      id: 'rcpt-failed',
      kind: 'receipt_failed',
      severity: 'warning',
      title: `${failed.length} receipt upload${failed.length > 1 ? 's' : ''} failed`,
      detail: 'The app keeps retrying. Open Sync for details or to retry now.',
      how: 'Counts receipts whose last upload attempt returned an error.',
      link: '#/sync',
    });
  }
  const order = { warning: 0, info: 1 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Month-over-month totals for the last `n` months ending at `month`, oldest first. */
export function monthlySeries(expenses: readonly Expense[], month: MonthKey, n: number, filter?: (e: Expense) => boolean): Array<{ month: MonthKey; cents: number }> {
  const out: Array<{ month: MonthKey; cents: number }> = [];
  for (let k = n - 1; k >= 0; k--) {
    const m = addMonthsToMonth(month, -k);
    const { from, to } = monthRange(m);
    const list = inRange(expenses, from, to).filter((e) => !filter || filter(e));
    out.push({ month: m, cents: computeTotals(list).netCents });
  }
  return out;
}

/** Net spending per day of the month, plus the cumulative total. */
export function dailySeries(expenses: readonly Expense[], month: MonthKey): Array<{ date: IsoDate; cents: number; cumulative: number }> {
  const { from, to } = monthRange(month);
  const byDay = new Map<IsoDate, number>();
  for (const e of inRange(expenses, from, to)) byDay.set(e.transactionDate, (byDay.get(e.transactionDate) ?? 0) + (e.kind === 'refund' ? -e.totalCents : e.totalCents));
  const out: Array<{ date: IsoDate; cents: number; cumulative: number }> = [];
  let cum = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const c = byDay.get(d) ?? 0;
    cum += c;
    out.push({ date: d, cents: c, cumulative: cum });
  }
  return out;
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return dayNumber(b) - dayNumber(a);
}
