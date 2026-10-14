import { describe, expect, it } from 'vitest';
import { alertKey, computeBudgetStatus, computeBudgetStatuses, newBudgetAlerts } from '../../src/domain/budget';
import {
  describeSchedule, findPaymentMatches, nextOccurrenceAfter, nextOccurrenceOnOrAfter, occurrence, occurrencesBetween, recurringState,
} from '../../src/domain/recurrence';
import { computeInsights, dailySeries, monthlySeries } from '../../src/domain/insights';
import type { Budget, Category, Expense, Receipt, RecurringExpense } from '../../src/domain/types';

let n = 0;
const exp = (p: Partial<Expense>): Expense => ({
  expenseId: `e${++n}`, householdId: 'h', kind: 'expense', merchantName: 'Store', merchantNormalized: 'store', transactionDate: '2026-10-05',
  createdAt: '', updatedAt: '', createdByMemberId: 'a', paidByMemberId: 'a', expenseType: 'shared', categoryId: 'cat-groceries',
  totalCents: 1000, currencyCode: 'USD', notes: '', source: 'manual', verificationStatus: 'verified', recordVersion: '', fieldVersions: {}, ...p,
});
const budget = (p: Partial<Budget>): Budget => ({
  budgetId: `b${++n}`, monthlyLimitCents: 10000, currencyCode: 'USD', startMonth: '2026-01', alertThresholdPercent: 80, scope: 'all',
  isActive: true, recordVersion: '', fieldVersions: {}, ...p,
});
const parents = new Map<string, string | undefined>([['sub-costco', 'cat-groceries']]);

describe('budgets', () => {
  const expenses = [
    exp({ totalCents: 5000 }),
    exp({ totalCents: 3000, categoryId: 'sub-costco' }),
    exp({ totalCents: 1000, kind: 'refund' }),
    exp({ totalCents: 2000, expenseType: 'personal' }),
    exp({ totalCents: 9999, deletedAt: 'x' }),
    exp({ totalCents: 7000, categoryId: 'cat-fuel' }),
    exp({ totalCents: 4000, transactionDate: '2026-09-30' }),
  ];

  it('counts category + subcategories, subtracts refunds, excludes deleted and other months', () => {
    const s = computeBudgetStatus(budget({ categoryId: 'cat-groceries' }), expenses, '2026-10', parents);
    expect(s.spentCents).toBe(5000 + 3000 - 1000 + 2000);
    expect(s.remainingCents).toBe(1000);
    expect(s.percentUsed).toBe(90);
    expect(s.level).toBe('warning');
    expect(s.crossed).toEqual([80]);
  });

  it('shared scope ignores personal expenses', () => {
    const s = computeBudgetStatus(budget({ categoryId: 'cat-groceries', scope: 'shared' }), expenses, '2026-10', parents);
    expect(s.spentCents).toBe(7000);
  });

  it('overall budget counts every category exactly once', () => {
    const s = computeBudgetStatus(budget({ monthlyLimitCents: 15000 }), expenses, '2026-10', parents);
    expect(s.spentCents).toBe(5000 + 3000 - 1000 + 2000 + 7000);
    expect(s.overCents).toBe(1000);
    expect(s.level).toBe('over');
    expect(s.crossed).toEqual([80, 100]);
  });

  it('respects start/end months and inactive budgets', () => {
    const list = [budget({ startMonth: '2026-11' }), budget({ endMonth: '2026-09' }), budget({ isActive: false }), budget({})];
    expect(computeBudgetStatuses(list, expenses, '2026-10', parents)).toHaveLength(1);
  });

  it('alerts once per threshold per month', () => {
    const s = computeBudgetStatus(budget({ budgetId: 'B', monthlyLimitCents: 15000 }), expenses, '2026-10', parents);
    const first = newBudgetAlerts([s], new Set());
    expect(first.map((a) => a.threshold)).toEqual([80, 100]);
    const shown = new Set(first.map((a) => a.key));
    expect(newBudgetAlerts([s], shown)).toHaveLength(0);
    expect(alertKey('B', '2026-11', 80)).not.toBe(first[0]!.key);
  });

  it('is deterministic at exact boundaries', () => {
    const s = computeBudgetStatus(budget({ monthlyLimitCents: 10000 }), [exp({ totalCents: 8000 })], '2026-10', parents);
    expect(s.percentUsed).toBe(80);
    expect(s.level).toBe('warning');
    const s2 = computeBudgetStatus(budget({ monthlyLimitCents: 10000 }), [exp({ totalCents: 7999 })], '2026-10', parents);
    expect(s2.level).toBe('ok');
  });
});

describe('recurring schedules', () => {
  it('keeps month-end dates without drift', () => {
    const dates = [0, 1, 2, 3].map((k) => occurrence('2026-01-31', 'monthly', 1, k));
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(occurrence('2028-01-31', 'monthly', 1, 1)).toBe('2028-02-29');
  });
  it('handles leap-day annual bills', () => {
    expect(occurrence('2024-02-29', 'annual', 1, 1)).toBe('2025-02-28');
    expect(occurrence('2024-02-29', 'annual', 1, 4)).toBe('2028-02-29');
  });
  it('supports weekly, quarterly and custom intervals', () => {
    expect(occurrence('2026-10-01', 'weekly', 2, 3)).toBe('2026-11-12');
    expect(occurrence('2026-11-30', 'quarterly', 1, 1)).toBe('2027-02-28');
    expect(describeSchedule({ frequency: 'monthly', interval: 2 })).toBe('Every 2 months');
  });
  it('finds next occurrences', () => {
    const r = { anchorDate: '2026-01-31', frequency: 'monthly' as const, interval: 1 };
    expect(nextOccurrenceOnOrAfter(r, '2026-03-01')).toBe('2026-03-31');
    expect(nextOccurrenceAfter(r, '2026-02-28')).toBe('2026-03-31');
    expect(nextOccurrenceOnOrAfter(r, '2025-01-01')).toBe('2026-01-31');
    expect(occurrencesBetween({ anchorDate: '2026-01-05', frequency: 'weekly', interval: 1 }, '2026-10-01', '2026-10-31')).toHaveLength(4);
    expect(nextOccurrenceAfter({ anchorDate: '2020-01-01', frequency: 'weekly', interval: 1 }, '2026-10-14')).toBe('2026-10-21');
  });

  const rec: RecurringExpense = {
    recurringExpenseId: 'r1', merchantName: 'Netflix', description: '', categoryId: 'cat-subscriptions', expectedAmountCents: 1599,
    currencyCode: 'USD', frequency: 'monthly', interval: 1, anchorDate: '2026-01-10', nextDueDate: '2026-10-10', expenseType: 'shared',
    isActive: true, recordVersion: '', fieldVersions: {},
  };
  it('reports state', () => {
    expect(recurringState(rec, '2026-10-14')).toBe('overdue');
    expect(recurringState(rec, '2026-10-05')).toBe('due_soon');
    expect(recurringState(rec, '2026-09-20')).toBe('upcoming');
    expect(recurringState({ ...rec, isActive: false }, '2026-10-14')).toBe('inactive');
  });
  it('suggests an existing manual entry instead of a duplicate', () => {
    const list = [
      exp({ merchantName: 'NETFLIX.COM', merchantNormalized: 'netflix com', totalCents: 1599, transactionDate: '2026-10-11', categoryId: 'cat-subscriptions' }),
      exp({ merchantNormalized: 'kroger', totalCents: 1599, transactionDate: '2026-09-01' }),
      exp({ merchantNormalized: 'netflix', totalCents: 1599, transactionDate: '2026-10-09', recurringExpenseId: 'other' }),
    ];
    const m = findPaymentMatches(rec, list, '2026-10-10');
    expect(m).toHaveLength(1);
    expect(m[0]!.reasons).toContain('same merchant');
  });
});

describe('insights', () => {
  const cats = new Map<string, Category>([['cat-groceries', { categoryId: 'cat-groceries', name: 'Groceries' } as Category]]);
  it('explains category increases, large transactions, due bills and pending receipts', () => {
    const history = Array.from({ length: 6 }, (_, k) => exp({ totalCents: 2000, transactionDate: `2026-09-0${k + 1}` }));
    const list = [...history, exp({ totalCents: 30000, transactionDate: '2026-10-03', merchantName: 'Big TV' })];
    const ins = computeInsights({
      month: '2026-10', today: '2026-10-14', expenses: list, categories: cats, categoryParents: new Map(), budgetStatuses: [],
      recurring: [{ recurringExpenseId: 'r', merchantName: 'Rent', nextDueDate: '2026-10-16', isActive: true, expectedAmountCents: 120000 } as RecurringExpense],
      receipts: [{ receiptId: 'x', uploadStatus: 'pending', deletionStatus: 'active' } as Receipt],
    });
    const kinds = ins.map((x) => x.kind).sort();
    expect(kinds).toEqual(['category_increase', 'large_transaction', 'receipt_missing', 'receipt_pending', 'recurring_due']);
    expect(ins.every((x) => x.how.length > 20)).toBe(true);
  });
  it('builds monthly and daily series', () => {
    const list = [exp({ transactionDate: '2026-09-15', totalCents: 500 }), exp({ transactionDate: '2026-10-02', totalCents: 700 }), exp({ transactionDate: '2026-10-02', kind: 'refund', totalCents: 200 })];
    expect(monthlySeries(list, '2026-10', 3)).toEqual([{ month: '2026-08', cents: 0 }, { month: '2026-09', cents: 500 }, { month: '2026-10', cents: 500 }]);
    const d = dailySeries(list, '2026-10');
    expect(d).toHaveLength(31);
    expect(d[1]).toEqual({ date: '2026-10-02', cents: 500, cumulative: 500 });
    expect(d[30]!.cumulative).toBe(500);
  });
});
