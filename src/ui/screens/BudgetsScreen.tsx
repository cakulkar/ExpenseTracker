import { useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { useLiveQuery } from '../hooks/useLiveQuery';
import type { Budget, BudgetScope, Expense } from '../../domain/types';
import { computeBudgetStatuses } from '../../domain/budget';
import { centsToInput, formatCents, tryParseCents } from '../../domain/money';
import { addMonthsToMonth, formatMonth, isValidMonth, monthOf, todayIn } from '../../domain/dates';
import { ConfirmDialog, EmptyState, Field, useToast } from '../components/common';

interface FormState {
  budgetId?: string;
  categoryId: string;
  limit: string;
  threshold: string;
  scope: BudgetScope;
  startMonth: string;
  endMonth: string;
  isActive: boolean;
}

export function BudgetsScreen() {
  const { db, repo, budgets, categories, categoryById, categoryParents, timezone } = useApp();
  const toast = useToast();
  const [month, setMonth] = useState(() => monthOf(todayIn(timezone)));
  const expenses = useLiveQuery(() => db.expenses.toArray(), [db], [] as Expense[]);
  const statuses = useMemo(() => computeBudgetStatuses(budgets, expenses, month, categoryParents), [budgets, expenses, month, categoryParents]);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Budget | null>(null);
  const inactiveOrOther = budgets.filter((b) => !statuses.some((s) => s.budget.budgetId === b.budgetId));

  const openNew = () => {
    setError('');
    setForm({ categoryId: '', limit: '', threshold: '80', scope: 'all', startMonth: month, endMonth: '', isActive: true });
  };
  const openEdit = (b: Budget) => {
    setError('');
    setForm({
      budgetId: b.budgetId, categoryId: b.categoryId ?? '', limit: centsToInput(b.monthlyLimitCents), threshold: String(b.alertThresholdPercent),
      scope: b.scope, startMonth: b.startMonth, endMonth: b.endMonth ?? '', isActive: b.isActive,
    });
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const cents = tryParseCents(form.limit);
    const threshold = Number(form.threshold);
    if (cents === null || cents <= 0) return setError('Enter a monthly limit above zero, like 600.00');
    if (!isValidMonth(form.startMonth)) return setError('Choose a start month');
    if (form.endMonth && !isValidMonth(form.endMonth)) return setError('End month is not valid');
    try {
      await repo.saveBudget({
        budgetId: form.budgetId, categoryId: form.categoryId || undefined, monthlyLimitCents: cents, alertThresholdPercent: threshold,
        scope: form.scope, startMonth: form.startMonth, endMonth: form.endMonth || undefined, isActive: form.isActive,
      });
      toast('Budget saved');
      setForm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  };
  const name = (b: Budget) => (b.categoryId ? `${categoryById.get(b.categoryId)?.icon ?? ''} ${categoryById.get(b.categoryId)?.name ?? 'Category'}` : 'Overall household budget');

  return (
    <section aria-labelledby="bud-title">
      <div className="page-head">
        <h1 id="bud-title" tabIndex={-1}>Budgets</h1>
        <div className="row gap wrap">
          <div className="month-pick" role="group" aria-label="Month">
            <button className="btn ghost icon" aria-label="Previous month" onClick={() => setMonth((m) => addMonthsToMonth(m, -1))}>‹</button>
            <input aria-label="Month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            <button className="btn ghost icon" aria-label="Next month" onClick={() => setMonth((m) => addMonthsToMonth(m, 1))}>›</button>
          </div>
          <button className="btn primary" onClick={openNew}>+ Budget</button>
        </div>
      </div>

      {form && (
        <form className="card form" onSubmit={save} noValidate aria-label={form.budgetId ? 'Edit budget' : 'New budget'}>
          <h2>{form.budgetId ? 'Edit budget' : 'New budget'}</h2>
          <fieldset>
            <div className="grid2">
              <Field id="b-cat" label="Applies to">
                <select id="b-cat" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                  <option value="">Overall (all categories)</option>
                  {categories.filter((c) => !c.isArchived).map((c) => (
                    <option key={c.categoryId} value={c.categoryId}>{c.parentCategoryId ? `   ↳ ${c.name}` : c.name}</option>
                  ))}
                </select>
              </Field>
              <Field id="b-limit" label="Monthly limit (USD)">
                <input id="b-limit" inputMode="decimal" placeholder="600.00" value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} />
              </Field>
            </div>
            <div className="grid2">
              <Field id="b-th" label="Warn me at" hint="You'll also be alerted at 100%.">
                <select id="b-th" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })}>
                  {[50, 60, 70, 75, 80, 85, 90, 95].map((t) => <option key={t} value={t}>{t}% used</option>)}
                </select>
              </Field>
              <fieldset className="field">
                <legend>Counts</legend>
                <div className="seg">
                  {(['all', 'shared'] as const).map((s) => (
                    <label key={s} className={form.scope === s ? 'on' : ''}>
                      <input type="radio" name="scope" checked={form.scope === s} onChange={() => setForm({ ...form, scope: s })} />
                      {s === 'all' ? 'Shared + personal' : 'Shared only'}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="grid2">
              <Field id="b-start" label="Start month">
                <input id="b-start" type="month" value={form.startMonth} onChange={(e) => setForm({ ...form, startMonth: e.target.value })} />
              </Field>
              <Field id="b-end" label="End month (optional)">
                <input id="b-end" type="month" value={form.endMonth} onChange={(e) => setForm({ ...form, endMonth: e.target.value })} />
              </Field>
            </div>
            <label className="check"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Active</label>
            {error && <p className="error" role="alert">{error}</p>}
          </fieldset>
          <div className="row gap end">
            <button type="button" className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
            <button type="submit" className="btn primary">Save budget</button>
          </div>
        </form>
      )}

      {statuses.length === 0 && !form ? (
        <EmptyState title={`No budgets for ${formatMonth(month)}`}>
          <p className="muted">Set an overall monthly limit, or limits for categories like Groceries or Dining.</p>
          <button className="btn primary" onClick={openNew}>Create a budget</button>
        </EmptyState>
      ) : (
        <ul className="budget-list">
          {statuses.map((s) => (
            <li key={s.budget.budgetId} className={`card budget lvl-${s.level}`}>
              <div className="row between wrap">
                <h2>{name(s.budget)}</h2>
                <div className="row gap">
                  <button className="btn ghost small" onClick={() => openEdit(s.budget)}>Edit</button>
                  <button className="btn ghost small danger" onClick={() => setDeleting(s.budget)}>Delete</button>
                </div>
              </div>
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, Math.floor(s.percentUsed))}
                aria-label={`${name(s.budget)}: ${Math.floor(s.percentUsed)}% used`}
              >
                <span className="progress-fill" style={{ width: `${Math.min(100, s.percentUsed)}%` }} />
                <span className="progress-mark" style={{ left: `${s.budget.alertThresholdPercent}%` }} title={`Warning at ${s.budget.alertThresholdPercent}%`} />
              </div>
              <dl className="budget-nums">
                <div><dt>Budget</dt><dd>{formatCents(s.limitCents)}</dd></div>
                <div><dt>Spent</dt><dd>{formatCents(s.spentCents)}</dd></div>
                <div><dt>{s.overCents > 0 ? 'Over budget' : 'Remaining'}</dt><dd className={s.overCents > 0 ? 'bad' : ''}>{formatCents(s.overCents > 0 ? s.overCents : s.remainingCents)}</dd></div>
                <div><dt>Used</dt><dd>{Number.isFinite(s.percentUsed) ? `${Math.floor(s.percentUsed)}%` : '—'}</dd></div>
              </dl>
              <p className="muted small">
                {s.budget.scope === 'shared' ? 'Counts shared expenses only.' : 'Counts shared and personal expenses.'} Warning at {s.budget.alertThresholdPercent}%.
                {s.budget.endMonth ? ` Runs ${formatMonth(s.budget.startMonth)} – ${formatMonth(s.budget.endMonth)}.` : ` Since ${formatMonth(s.budget.startMonth)}.`}
              </p>
            </li>
          ))}
        </ul>
      )}

      {inactiveOrOther.length > 0 && (
        <details className="card">
          <summary>Other budgets ({inactiveOrOther.length}) — inactive or outside {formatMonth(month)}</summary>
          <ul className="plain-list">
            {inactiveOrOther.map((b) => (
              <li key={b.budgetId} className="row between">
                <span>{name(b)} · {formatCents(b.monthlyLimitCents)} · {b.isActive ? `${formatMonth(b.startMonth)}${b.endMonth ? ` – ${formatMonth(b.endMonth)}` : ' onward'}` : 'inactive'}</span>
                <button className="btn ghost small" onClick={() => openEdit(b)}>Edit</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="card">
        <summary>How budgets are calculated</summary>
        <ul>
          <li>Spending is the total of expenses dated in the month, minus refunds. Deleted records don't count.</li>
          <li>A category budget includes that category's subcategories. The overall budget includes every category, each expense counted once.</li>
          <li><strong>Shared + personal</strong> counts everything the household spent. <strong>Shared only</strong> ignores expenses marked personal — useful if you only budget joint spending.</li>
          <li>Alerts appear once per budget, per month, per threshold (your warning level and 100%).</li>
        </ul>
      </details>

      <ConfirmDialog
        open={!!deleting}
        title="Delete this budget?"
        confirmLabel="Delete budget"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          await repo.deleteBudget(deleting!.budgetId);
          setDeleting(null);
          toast('Budget deleted');
        }}
      >
        <p>Your expenses aren't affected.</p>
      </ConfirmDialog>
    </section>
  );
}
