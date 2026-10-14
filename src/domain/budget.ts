/**
 * Monthly budget calculations. Pure and deterministic.
 *
 * How spending counts:
 * - Only non-deleted records in the budget month count. Refunds subtract.
 * - Overall budget: every category. Category budget: that category plus its subcategories
 *   (or exactly that subcategory if the budget is on a subcategory).
 * - Scope 'all' (default) counts shared AND personal spending — the whole household's outflow.
 *   Scope 'shared' counts only expenses marked shared, for couples who budget joint spending only.
 * - Each expense is counted at most once per budget.
 */
import type { Budget, Expense } from './types';
import { percentOf, signedAmount, type Cents } from './money';
import { monthRange, type MonthKey } from './dates';

export interface BudgetStatus {
  budget: Budget;
  month: MonthKey;
  limitCents: Cents;
  spentCents: Cents;
  remainingCents: Cents;
  overCents: Cents;
  percentUsed: number;
  level: 'ok' | 'warning' | 'over';
  /** Thresholds at or above which spending currently sits, e.g. [80] or [80, 100]. */
  crossed: number[];
}

export function budgetAppliesToMonth(b: Budget, month: MonthKey): boolean {
  return !b.deletedAt && b.isActive && b.startMonth <= month && (!b.endMonth || b.endMonth >= month);
}

export function expenseCountsForBudget(e: Expense, b: Budget, categoryParents: ReadonlyMap<string, string | undefined>): boolean {
  if (e.deletedAt) return false;
  if (b.scope === 'shared' && e.expenseType !== 'shared') return false;
  if (!b.categoryId) return true;
  if (e.categoryId === b.categoryId || e.subcategoryId === b.categoryId) return true;
  return categoryParents.get(e.categoryId) === b.categoryId;
}

export function thresholdsFor(b: Budget): number[] {
  return [...new Set([b.alertThresholdPercent, 100])].sort((x, y) => x - y);
}

export function computeBudgetStatus(
  b: Budget,
  expenses: readonly Expense[],
  month: MonthKey,
  categoryParents: ReadonlyMap<string, string | undefined>,
): BudgetStatus {
  const { from, to } = monthRange(month);
  let spent = 0;
  for (const e of expenses) {
    if (e.transactionDate < from || e.transactionDate > to) continue;
    if (expenseCountsForBudget(e, b, categoryParents)) spent += signedAmount(e);
  }
  const limit = b.monthlyLimitCents;
  const pct = percentOf(Math.max(spent, 0), limit);
  const crossed = thresholdsFor(b).filter((t) => pct >= t);
  return {
    budget: b,
    month,
    limitCents: limit,
    spentCents: spent,
    remainingCents: limit - spent,
    overCents: Math.max(0, spent - limit),
    percentUsed: pct,
    level: pct >= 100 ? 'over' : pct >= b.alertThresholdPercent ? 'warning' : 'ok',
    crossed,
  };
}

export function computeBudgetStatuses(
  budgets: readonly Budget[],
  expenses: readonly Expense[],
  month: MonthKey,
  categoryParents: ReadonlyMap<string, string | undefined>,
): BudgetStatus[] {
  return budgets
    .filter((b) => budgetAppliesToMonth(b, month))
    .map((b) => computeBudgetStatus(b, expenses, month, categoryParents))
    .sort((a, b) => (a.budget.categoryId ? 1 : 0) - (b.budget.categoryId ? 1 : 0) || b.percentUsed - a.percentUsed);
}

export function alertKey(budgetId: string, month: MonthKey, threshold: number): string {
  return `${budgetId}|${month}|${threshold}`;
}

/**
 * Alerts not yet shown on this device. Each (budget, month, threshold) alerts once, even if spending
 * later dips below and crosses again.
 */
export function newBudgetAlerts(statuses: readonly BudgetStatus[], shown: ReadonlySet<string>): Array<{ key: string; status: BudgetStatus; threshold: number }> {
  const out: Array<{ key: string; status: BudgetStatus; threshold: number }> = [];
  for (const s of statuses) {
    // Only the highest newly crossed threshold produces a visible alert; lower ones are marked shown too.
    const fresh = s.crossed.filter((t) => !shown.has(alertKey(s.budget.budgetId, s.month, t)));
    for (const t of fresh) out.push({ key: alertKey(s.budget.budgetId, s.month, t), status: s, threshold: t });
  }
  return out;
}
