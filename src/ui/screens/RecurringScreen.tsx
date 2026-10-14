import { useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { useLiveQuery } from '../hooks/useLiveQuery';
import type { Expense, ExpenseType, Frequency, RecurringExpense } from '../../domain/types';
import { centsToInput, formatCents, tryParseCents } from '../../domain/money';
import { formatDate, isValidIsoDate, todayIn } from '../../domain/dates';
import { describeSchedule, findPaymentMatches, nextOccurrenceAfter, nextOccurrenceOnOrAfter, occurrence, recurringState } from '../../domain/recurrence';
import { UNCATEGORIZED_ID } from '../../domain/categories';
import { ConfirmDialog, EmptyState, Field, useToast } from '../components/common';

interface FormState {
  id?: string;
  merchantName: string;
  description: string;
  categoryId: string;
  amount: string;
  frequency: Frequency;
  interval: string;
  anchorDate: string;
  paidByMemberId: string;
  expenseType: ExpenseType;
  isActive: boolean;
}

const STATE_TITLE = { overdue: 'Overdue', due_soon: 'Due within 7 days', upcoming: 'Upcoming', inactive: 'Paused' } as const;

export function RecurringScreen() {
  const { db, repo, recurring, categories, categoryById, members, memberById, thisMemberId, timezone } = useApp();
  const toast = useToast();
  const today = todayIn(timezone);
  const expenses = useLiveQuery(() => db.expenses.toArray(), [db], [] as Expense[]);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState<RecurringExpense | null>(null);
  const [payDate, setPayDate] = useState(today);
  const [payAmount, setPayAmount] = useState('');
  const [deleting, setDeleting] = useState<RecurringExpense | null>(null);

  const groups = useMemo(() => {
    const g: Record<keyof typeof STATE_TITLE, RecurringExpense[]> = { overdue: [], due_soon: [], upcoming: [], inactive: [] };
    for (const r of recurring) g[recurringState(r, today)].push(r);
    for (const k of Object.keys(g) as Array<keyof typeof g>) g[k].sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
    return g;
  }, [recurring, today]);

  const openNew = () => {
    setError('');
    setForm({ merchantName: '', description: '', categoryId: 'cat-subscriptions', amount: '', frequency: 'monthly', interval: '1', anchorDate: today, paidByMemberId: thisMemberId ?? '', expenseType: 'shared', isActive: true });
  };
  const openEdit = (r: RecurringExpense) => {
    setError('');
    setForm({
      id: r.recurringExpenseId, merchantName: r.merchantName, description: r.description, categoryId: r.categoryId, amount: centsToInput(r.expectedAmountCents),
      frequency: r.frequency, interval: String(r.interval), anchorDate: r.anchorDate, paidByMemberId: r.paidByMemberId ?? '', expenseType: r.expenseType, isActive: r.isActive,
    });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const cents = tryParseCents(form.amount);
    const interval = Number(form.interval);
    if (!form.merchantName.trim()) return setError('Enter a name, like Netflix or Rent');
    if (cents === null) return setError('Enter the expected amount');
    if (!isValidIsoDate(form.anchorDate)) return setError('Choose the first due date');
    if (!Number.isInteger(interval) || interval < 1 || interval > 52) return setError('Repeat every 1–52');
    const existing = form.id ? recurring.find((r) => r.recurringExpenseId === form.id) : undefined;
    const scheduleChanged = !existing || existing.anchorDate !== form.anchorDate || existing.frequency !== form.frequency || existing.interval !== interval;
    const nextDueDate = scheduleChanged
      ? nextOccurrenceOnOrAfter({ anchorDate: form.anchorDate, frequency: form.frequency, interval }, existing ? today : form.anchorDate)
      : existing!.nextDueDate;
    try {
      await repo.saveRecurring({
        recurringExpenseId: form.id, merchantName: form.merchantName, description: form.description, categoryId: form.categoryId, expectedAmountCents: cents,
        frequency: form.frequency, interval, anchorDate: form.anchorDate, nextDueDate, paidByMemberId: form.paidByMemberId || undefined,
        expenseType: form.expenseType, isActive: form.isActive, lastMatchedExpenseId: existing?.lastMatchedExpenseId,
      });
      toast('Recurring bill saved');
      setForm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  };

  const matches = paying ? findPaymentMatches(paying, expenses, paying.nextDueDate) : [];
  const advance = (r: RecurringExpense) => nextOccurrenceAfter(r, r.nextDueDate);

  return (
    <section aria-labelledby="rec-title">
      <div className="page-head">
        <h1 id="rec-title" tabIndex={-1}>Recurring bills</h1>
        <button className="btn primary" onClick={openNew}>+ Recurring bill</button>
      </div>
      <p className="muted small">Expected payments only. Nothing is marked paid automatically — you link a payment or create one when it happens.</p>

      {form && (
        <form className="card form" onSubmit={save} noValidate aria-label="Recurring bill">
          <h2>{form.id ? 'Edit recurring bill' : 'New recurring bill'}</h2>
          <fieldset>
            <div className="grid2">
              <Field id="r-name" label="Name / merchant"><input id="r-name" value={form.merchantName} maxLength={120} onChange={(e) => setForm({ ...form, merchantName: e.target.value })} /></Field>
              <Field id="r-amt" label="Expected amount (USD)"><input id="r-amt" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
            </div>
            <div className="grid3">
              <Field id="r-freq" label="Repeats">
                <select id="r-freq" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}>
                  <option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Yearly</option>
                </select>
              </Field>
              <Field id="r-int" label="Every" hint={describeSchedule({ frequency: form.frequency, interval: Number(form.interval) || 1 })}>
                <input id="r-int" type="number" min={1} max={52} value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })} />
              </Field>
              <Field id="r-anchor" label="First due date"><input id="r-anchor" type="date" value={form.anchorDate} onChange={(e) => setForm({ ...form, anchorDate: e.target.value })} /></Field>
            </div>
            <div className="grid3">
              <Field id="r-cat" label="Category">
                <select id="r-cat" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                  {categories.filter((c) => !c.isArchived && !c.parentCategoryId).map((c) => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
                </select>
              </Field>
              <Field id="r-paid" label="Usually paid by">
                <select id="r-paid" value={form.paidByMemberId} onChange={(e) => setForm({ ...form, paidByMemberId: e.target.value })}>
                  <option value="">Either</option>
                  {members.map((m) => <option key={m.memberId} value={m.memberId}>{m.displayName}</option>)}
                </select>
              </Field>
              <Field id="r-type" label="Shared or personal">
                <select id="r-type" value={form.expenseType} onChange={(e) => setForm({ ...form, expenseType: e.target.value as ExpenseType })}>
                  <option value="shared">Shared</option><option value="personal">Personal</option>
                </select>
              </Field>
            </div>
            <Field id="r-desc" label="Notes (optional)"><input id="r-desc" value={form.description} maxLength={200} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Active</label>
            {isValidIsoDate(form.anchorDate) && Number(form.interval) >= 1 && (
              <p className="muted small">Next dates: {[0, 1, 2].map((n) => formatDate(occurrence(form.anchorDate, form.frequency, Number(form.interval), n))).join(' · ')}</p>
            )}
            {error && <p className="error" role="alert">{error}</p>}
          </fieldset>
          <div className="row gap end">
            <button type="button" className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
            <button type="submit" className="btn primary">Save</button>
          </div>
        </form>
      )}

      {recurring.length === 0 && !form && (
        <EmptyState title="No recurring bills yet">
          <p className="muted">Track rent, utilities, insurance and subscriptions so you see what's coming up.</p>
          <button className="btn primary" onClick={openNew}>Add a recurring bill</button>
        </EmptyState>
      )}

      {(Object.keys(STATE_TITLE) as Array<keyof typeof STATE_TITLE>).map((k) =>
        groups[k].length ? (
          <div key={k} className="card">
            <h2 className={k === 'overdue' ? 'bad' : ''}>{STATE_TITLE[k]}</h2>
            <ul className="rec-list">
              {groups[k].map((r) => (
                <li key={r.recurringExpenseId} className="rec-item">
                  <div className="rec-main">
                    <strong>{categoryById.get(r.categoryId)?.icon} {r.merchantName}</strong>
                    <span className="muted small">
                      {describeSchedule(r)} · expected {formatCents(r.expectedAmountCents)}
                      {r.paidByMemberId && ` · ${memberById.get(r.paidByMemberId)?.displayName ?? ''}`}
                    </span>
                    <span className={`small ${k === 'overdue' ? 'bad' : ''}`}>{k === 'inactive' ? 'Paused' : `Next due ${formatDate(r.nextDueDate)}`}</span>
                  </div>
                  <div className="row gap wrap">
                    {r.isActive && <button className="btn primary small" onClick={() => { setPaying(r); setPayDate(r.nextDueDate <= today ? today : r.nextDueDate); setPayAmount(centsToInput(r.expectedAmountCents)); }}>Mark paid</button>}
                    {r.isActive && <button className="btn ghost small" onClick={async () => { await repo.skipRecurring(r.recurringExpenseId, advance(r)); toast(`Skipped; next due ${formatDate(advance(r))}`); }}>Skip</button>}
                    <button className="btn ghost small" onClick={() => openEdit(r)}>Edit</button>
                    <button className="btn ghost small danger" onClick={() => setDeleting(r)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}

      <ConfirmDialog
        open={!!paying}
        title={paying ? `Mark ${paying.merchantName} (${formatDate(paying.nextDueDate)}) paid` : ''}
        confirmLabel="Create new expense"
        onCancel={() => setPaying(null)}
        onConfirm={async () => {
          const r = paying!;
          const cents = tryParseCents(payAmount);
          if (cents === null || !isValidIsoDate(payDate)) return toast('Enter a valid date and amount', 'error');
          const exp = await repo.createExpense(
            {
              kind: 'expense', merchantName: r.merchantName, transactionDate: payDate, totalCents: cents, categoryId: r.categoryId || UNCATEGORIZED_ID,
              paidByMemberId: r.paidByMemberId ?? thisMemberId ?? members[0]!.memberId, expenseType: r.expenseType, notes: r.description,
            },
            { source: 'recurring', recurringExpenseId: r.recurringExpenseId },
          );
          await repo.markRecurringPaid(r.recurringExpenseId, exp.expenseId, advance(r));
          setPaying(null);
          toast(`Recorded. Next due ${formatDate(advance(r))}`);
        }}
      >
        {matches.length > 0 && (
          <div className="banner warn block">
            <p><strong>This payment may already be entered.</strong> Link it instead of creating a duplicate:</p>
            <ul className="plain-list">
              {matches.slice(0, 4).map((m) => (
                <li key={m.expense.expenseId} className="row between gap">
                  <span>{formatDate(m.expense.transactionDate)} · {m.expense.merchantName} · {formatCents(m.expense.totalCents)} <span className="muted small">({m.reasons.join(', ')})</span></span>
                  <button
                    className="btn small"
                    onClick={async () => {
                      await repo.markRecurringPaid(paying!.recurringExpenseId, m.expense.expenseId, advance(paying!));
                      toast('Linked existing expense');
                      setPaying(null);
                    }}
                  >
                    Link
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p>Or create a new expense for this payment:</p>
        <div className="grid2">
          <Field id="p-date" label="Date paid"><input id="p-date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></Field>
          <Field id="p-amt" label="Amount"><input id="p-amt" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /></Field>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deleting}
        title="Delete this recurring bill?"
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          await repo.deleteRecurring(deleting!.recurringExpenseId);
          setDeleting(null);
          toast('Recurring bill deleted. Past expenses stay.');
        }}
      >
        <p>Expenses already recorded for it are kept.</p>
      </ConfirmDialog>
    </section>
  );
}
