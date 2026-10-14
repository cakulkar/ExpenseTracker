import { useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { useLiveQuery } from '../hooks/useLiveQuery';
import type { Expense } from '../../domain/types';
import { computeTotals, filterExpenses, sortExpenses, type ExpenseFilter, type SortDir, type SortKey } from '../../domain/expenseQuery';
import { formatCents, tryParseCents } from '../../domain/money';
import { isValidIsoDate } from '../../domain/dates';
import { ExpenseRow } from '../components/ExpenseRow';
import { EmptyState } from '../components/common';

interface UiFilters {
  text: string;
  from: string;
  to: string;
  min: string;
  max: string;
  categoryId: string;
  paidBy: string;
  type: '' | 'shared' | 'personal';
  receipt: '' | 'yes' | 'no';
  recurring: '' | 'yes' | 'no';
  verification: '' | 'verified' | 'needs_review';
  kind: '' | 'expense' | 'refund';
  showDeleted: boolean;
}

const EMPTY: UiFilters = {
  text: '', from: '', to: '', min: '', max: '', categoryId: '', paidBy: '', type: '', receipt: '', recurring: '',
  verification: '', kind: '', showDeleted: false,
};

function toFilter(u: UiFilters): ExpenseFilter {
  const yn = (v: '' | 'yes' | 'no') => (v === '' ? undefined : v === 'yes');
  return {
    text: u.text.trim() || undefined,
    from: isValidIsoDate(u.from) ? u.from : undefined,
    to: isValidIsoDate(u.to) ? u.to : undefined,
    minCents: tryParseCents(u.min) ?? undefined,
    maxCents: tryParseCents(u.max) ?? undefined,
    categoryIds: u.categoryId ? [u.categoryId] : undefined,
    paidByMemberId: u.paidBy || undefined,
    expenseType: u.type || undefined,
    hasReceipt: yn(u.receipt),
    isRecurring: yn(u.recurring),
    verificationStatus: u.verification || undefined,
    kind: u.kind || undefined,
    includeDeleted: u.showDeleted,
  };
}

export function ExpensesScreen() {
  const { db, categories, members, categoryParents } = useApp();
  const all = useLiveQuery(() => db.expenses.toArray(), [db], [] as Expense[]);
  const [f, setF] = useState<UiFilters>(EMPTY);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showFilters, setShowFilters] = useState(false);

  const filter = useMemo(() => toFilter(f), [f]);
  const list = useMemo(
    () => sortExpenses(filterExpenses(all, filter, categoryParents), sortKey, sortDir),
    [all, filter, categoryParents, sortKey, sortDir],
  );
  const totals = useMemo(() => computeTotals(list), [list]);
  const activeCount = Object.entries(f).filter(([k, v]) => k !== 'text' && v !== '' && v !== false).length;
  const set = <K extends keyof UiFilters>(k: K, v: UiFilters[K]) => setF((p) => ({ ...p, [k]: v }));
  const topCats = categories.filter((c) => !c.parentCategoryId);

  return (
    <section aria-labelledby="exp-title">
      <div className="page-head">
        <h1 id="exp-title">Expenses</h1>
        <div className="row gap">
          <a className="btn ghost" href="#/expenses/refund">+ Refund</a>
          <a className="btn primary" href="#/expenses/new">+ Expense</a>
        </div>
      </div>

      <div className="toolbar">
        <label className="sr-only" htmlFor="q">Search expenses</label>
        <input id="q" type="search" placeholder="Search merchant or notes" value={f.text} onChange={(e) => set('text', e.target.value)} />
        <button className="btn ghost" aria-expanded={showFilters} aria-controls="filters" onClick={() => setShowFilters((s) => !s)}>
          Filters{activeCount ? ` (${activeCount})` : ''}
        </button>
        <label className="sr-only" htmlFor="sort">Sort by</label>
        <select
          id="sort"
          value={`${sortKey}:${sortDir}`}
          onChange={(e) => {
            const [k, d] = e.target.value.split(':') as [SortKey, SortDir];
            setSortKey(k);
            setSortDir(d);
          }}
        >
          <option value="date:desc">Newest first</option>
          <option value="date:asc">Oldest first</option>
          <option value="amount:desc">Largest amount</option>
          <option value="amount:asc">Smallest amount</option>
          <option value="merchant:asc">Merchant A–Z</option>
          <option value="merchant:desc">Merchant Z–A</option>
        </select>
      </div>

      {showFilters && (
        <div id="filters" className="filters card">
          <div className="grid3">
            <label>From<input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></label>
            <label>To<input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></label>
            <label>Category
              <select value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">All</option>
                {topCats.map((c) => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
              </select>
            </label>
            <label>Min amount<input inputMode="decimal" value={f.min} onChange={(e) => set('min', e.target.value)} placeholder="0.00" /></label>
            <label>Max amount<input inputMode="decimal" value={f.max} onChange={(e) => set('max', e.target.value)} placeholder="Any" /></label>
            <label>Paid by
              <select value={f.paidBy} onChange={(e) => set('paidBy', e.target.value)}>
                <option value="">Anyone</option>
                {members.map((m) => <option key={m.memberId} value={m.memberId}>{m.displayName}</option>)}
              </select>
            </label>
            <label>Shared / personal
              <select value={f.type} onChange={(e) => set('type', e.target.value as UiFilters['type'])}>
                <option value="">Both</option><option value="shared">Shared</option><option value="personal">Personal</option>
              </select>
            </label>
            <label>Receipt
              <select value={f.receipt} onChange={(e) => set('receipt', e.target.value as UiFilters['receipt'])}>
                <option value="">Any</option><option value="yes">Has receipt</option><option value="no">Missing receipt</option>
              </select>
            </label>
            <label>Recurring
              <select value={f.recurring} onChange={(e) => set('recurring', e.target.value as UiFilters['recurring'])}>
                <option value="">Any</option><option value="yes">Recurring</option><option value="no">One-time</option>
              </select>
            </label>
            <label>Verification
              <select value={f.verification} onChange={(e) => set('verification', e.target.value as UiFilters['verification'])}>
                <option value="">Any</option><option value="verified">Verified</option><option value="needs_review">Needs review</option>
              </select>
            </label>
            <label>Type
              <select value={f.kind} onChange={(e) => set('kind', e.target.value as UiFilters['kind'])}>
                <option value="">Expenses and refunds</option><option value="expense">Expenses only</option><option value="refund">Refunds only</option>
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={f.showDeleted} onChange={(e) => set('showDeleted', e.target.checked)} /> Show deleted</label>
          </div>
          <button className="btn ghost small" onClick={() => setF({ ...EMPTY, text: f.text })}>Clear filters</button>
        </div>
      )}

      <p className="muted small" aria-live="polite">
        {totals.count} transaction{totals.count === 1 ? '' : 's'} · Net {formatCents(totals.netCents)}
        {totals.refundCents > 0 && ` (after ${formatCents(totals.refundCents)} in refunds)`}
      </p>

      {all.length === 0 ? (
        <EmptyState title="No expenses yet">
          <a className="btn primary" href="#/expenses/new">Add your first expense</a>
        </EmptyState>
      ) : list.length === 0 ? (
        <EmptyState title="Nothing matches these filters" />
      ) : (
        <ul className="exp-list">{list.map((e) => <ExpenseRow key={e.expenseId} e={e} />)}</ul>
      )}
    </section>
  );
}
