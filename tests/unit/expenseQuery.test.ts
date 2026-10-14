import { describe, expect, it } from 'vitest';
import { computeTotals, filterExpenses, normalizeMerchant, sortExpenses } from '../../src/domain/expenseQuery';
import { breakdownWarning, validateExpenseForm, type ExpenseFormValues } from '../../src/domain/expenseInput';
import type { Expense } from '../../src/domain/types';

let n = 0;
function exp(p: Partial<Expense>): Expense {
  n++;
  return {
    expenseId: `e${n}`, householdId: 'h', kind: 'expense', merchantName: 'Store', merchantNormalized: 'store',
    transactionDate: '2026-10-01', createdAt: `2026-10-01T00:00:0${n % 10}Z`, updatedAt: '', createdByMemberId: 'a',
    paidByMemberId: 'a', expenseType: 'shared', categoryId: 'cat-groceries', totalCents: 1000, currencyCode: 'USD',
    notes: '', source: 'manual', verificationStatus: 'verified', recordVersion: '', fieldVersions: {}, ...p,
  };
}

describe('normalizeMerchant', () => {
  it('strips store numbers and punctuation', () => {
    expect(normalizeMerchant('WAL-MART #1234')).toBe('wal mart');
    expect(normalizeMerchant('  Café Rio  Store 88 ')).toBe('cafe rio');
  });
});

describe('filter, sort, totals', () => {
  const list = [
    exp({ merchantNormalized: 'kroger', totalCents: 5000, transactionDate: '2026-10-02' }),
    exp({ merchantNormalized: 'shell', categoryId: 'cat-fuel', totalCents: 4000, paidByMemberId: 'b', expenseType: 'personal' }),
    exp({ merchantNormalized: 'kroger', kind: 'refund', totalCents: 500, transactionDate: '2026-10-03' }),
    exp({ merchantNormalized: 'target', totalCents: 9999, deletedAt: '2026-10-05T00:00:00Z' }),
    exp({ merchantNormalized: 'netflix', categoryId: 'sub-streaming', totalCents: 1599, transactionDate: '2026-09-30', receiptId: 'r1' }),
  ];
  const parents = new Map<string, string | undefined>([['sub-streaming', 'cat-subscriptions']]);

  it('excludes deleted records by default', () => {
    expect(filterExpenses(list, {})).toHaveLength(4);
    expect(filterExpenses(list, { includeDeleted: true })).toHaveLength(5);
  });
  it('filters by date range, member, type, amount, text, receipt', () => {
    expect(filterExpenses(list, { from: '2026-10-01', to: '2026-10-31' })).toHaveLength(3);
    expect(filterExpenses(list, { paidByMemberId: 'b' })).toHaveLength(1);
    expect(filterExpenses(list, { expenseType: 'personal' })).toHaveLength(1);
    expect(filterExpenses(list, { minCents: 4000, maxCents: 5000 })).toHaveLength(2);
    expect(filterExpenses(list, { text: 'KROG' })).toHaveLength(2);
    expect(filterExpenses(list, { hasReceipt: true })).toHaveLength(1);
  });
  it('matches subcategories when filtering by parent', () => {
    expect(filterExpenses(list, { categoryIds: ['cat-subscriptions'] }, parents)).toHaveLength(1);
  });
  it('sorts by amount with refunds as negative', () => {
    const sorted = sortExpenses(filterExpenses(list, {}), 'amount', 'asc');
    expect(sorted[0]!.kind).toBe('refund');
    expect(sorted.at(-1)!.totalCents).toBe(5000);
  });
  it('computes totals counting each expense once and subtracting refunds', () => {
    const t = computeTotals(filterExpenses(list, {}), parents);
    expect(t.netCents).toBe(5000 + 4000 - 500 + 1599);
    expect(t.refundCents).toBe(500);
    expect(t.sharedCents).toBe(5000 - 500 + 1599);
    expect(t.personalCents).toBe(4000);
    expect(t.count).toBe(4);
    expect(t.byCategory.get('cat-subscriptions')).toBe(1599);
    expect(t.byMember.get('b')).toBe(4000);
  });
});

describe('expense form validation', () => {
  const base: ExpenseFormValues = {
    kind: 'expense', merchantName: 'Kroger', transactionDate: '2026-10-14', amount: '45.10', subtotal: '', tax: '', tip: '',
    discount: '', categoryId: 'cat-groceries', subcategoryId: '', paidByMemberId: 'a', expenseType: 'shared', notes: '',
  };
  const known = { categoryIds: new Set(['cat-groceries']), memberIds: new Set(['a']) };

  it('accepts a valid form and converts to cents', () => {
    const r = validateExpenseForm(base, known);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.totalCents).toBe(4510);
  });
  it('allows a legitimate zero amount', () => {
    expect(validateExpenseForm({ ...base, amount: '0' }, known).ok).toBe(true);
  });
  it('reports field errors', () => {
    const r = validateExpenseForm({ ...base, merchantName: '  ', amount: '4.5.1', transactionDate: '2026-02-30', paidByMemberId: 'x' }, known);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['amount', 'merchantName', 'paidByMemberId', 'transactionDate']);
  });
  it('strips control characters from text', () => {
    const r = validateExpenseForm({ ...base, merchantName: 'Kro\u0000ger\u0007' }, known);
    expect(r.ok && r.value.merchantName).toBe('Kroger');
  });
  it('warns but does not block on breakdown mismatch', () => {
    expect(breakdownWarning({ totalCents: 1082, subtotalCents: 1000, taxCents: 60, tipCents: 20 })).toBeNull();
    expect(breakdownWarning({ totalCents: 1081, subtotalCents: 1000, taxCents: 60, tipCents: 20 })).toBeNull(); // ±2¢ rounding
    expect(breakdownWarning({ totalCents: 1200, subtotalCents: 1000, taxCents: 60 })).toMatch(/differs/);
  });
});
