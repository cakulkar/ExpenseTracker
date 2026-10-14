import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { useSync } from '../SyncContext';
import { navigate } from '../router';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { centsToInput, formatCents, tryParseCents } from '../../domain/money';
import { formatDate, formatInstant, isValidIsoDate, todayIn } from '../../domain/dates';
import { UNCATEGORIZED_ID } from '../../domain/categories';
import { breakdownWarning, validateExpenseForm, type ExpenseFormValues, type FieldErrors } from '../../domain/expenseInput';
import { classify } from '../../domain/classify';
import { findDuplicates } from '../../domain/duplicates';
import type { Expense, ExpenseKind, ExpenseLineItem } from '../../domain/types';
import { requestReceiptDeletion, retryReceiptDeletion } from '../../sync/engine';
import { ConfirmDialog, Field, useToast } from '../components/common';
import { noteCategoryChoice } from '../categoryLearning';

function fromExpense(e: Expense): ExpenseFormValues {
  const opt = (c?: number) => (c === undefined ? '' : centsToInput(c));
  return {
    kind: e.kind, merchantName: e.merchantName, transactionDate: e.transactionDate, amount: centsToInput(e.totalCents),
    subtotal: opt(e.subtotalCents), tax: opt(e.taxCents), tip: opt(e.tipCents), discount: opt(e.discountCents),
    categoryId: e.categoryId, subcategoryId: e.subcategoryId ?? '', paidByMemberId: e.paidByMemberId, expenseType: e.expenseType, notes: e.notes,
  };
}

const PROV_LABEL = { extracted: 'read from receipt', inferred: 'guessed', manual: 'entered by hand' } as const;

function ReceiptPanel({ expense }: { expense: Expense }) {
  const { db, repo, receiptById, timezone } = useApp();
  const { engine, connected } = useSync();
  const toast = useToast();
  const receipt = expense.receiptId ? receiptById.get(expense.receiptId) : undefined;
  const local = useLiveQuery(() => (expense.receiptId ? db.receiptBlobs.get(expense.receiptId) : undefined), [db, expense.receiptId], undefined);
  const [thumbUrl, setThumbUrl] = useState('');
  const [fullUrl, setFullUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (!local?.thumbnail) return setThumbUrl('');
    const u = URL.createObjectURL(new Blob([local.thumbnail], { type: 'image/jpeg' }));
    setThumbUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [local?.thumbnail]);
  useEffect(() => () => {
    if (fullUrl) URL.revokeObjectURL(fullUrl);
  }, [fullUrl]);

  if (!expense.receiptId || !receipt) {
    return (
      <div className="card receipt-panel">
        <h2>Receipt</h2>
        <p className="muted">No receipt attached.</p>
        {!expense.deletedAt && <a className="btn ghost" href={`#/scan?attach=${expense.expenseId}`}>📷 Attach a receipt</a>}
      </div>
    );
  }
  const deleted = receipt.deletionStatus === 'deleted';
  const view = async () => {
    setBusy(true);
    try {
      let blob: Blob;
      if (local?.original) blob = new Blob([local.original], { type: receipt.mimeType });
      else if (engine && receipt.driveFileId) blob = await engine.fetchReceiptImage(receipt);
      else throw new Error(connected ? 'The image is on the other device and hasn’t been uploaded yet.' : 'Connect Google Drive to view this image.');
      setFullUrl(URL.createObjectURL(blob));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the image', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card receipt-panel">
      <h2>Receipt</h2>
      <div className="row gap wrap">
        {thumbUrl && !deleted && <img className="thumb" src={thumbUrl} alt="Receipt thumbnail" />}
        <dl className="kv">
          <div><dt>Image</dt><dd>{deleted ? `Deleted ${receipt.deletedAt ? formatInstant(receipt.deletedAt, timezone) : ''} (expense kept)` : receipt.uploadStatus === 'uploaded' ? `In Google Drive${receipt.encrypted ? ', encrypted' : ''}` : receipt.uploadStatus === 'failed' ? 'Upload failed — will retry' : 'On this device, waiting to upload'}</dd></div>
          <div><dt>Delete after</dt><dd>{formatDate(receipt.retentionDeadline)} ({receipt.retentionBasis === 'transaction' ? '2 years after purchase' : '2 years after upload'})</dd></div>
          {receipt.deletionStatus === 'failed' && <div><dt>Deletion</dt><dd className="bad">Failed {receipt.deletionAttempts}× — retrying</dd></div>}
          {receipt.deletionStatus === 'scheduled' && <div><dt>Deletion</dt><dd>Queued (runs when Drive is reachable)</dd></div>}
        </dl>
      </div>
      {!deleted && (
        <div className="row gap wrap">
          <button className="btn ghost small" disabled={busy} onClick={view}>{busy ? 'Loading…' : 'View full image'}</button>
          {receipt.deletionStatus === 'failed' ? (
            <button className="btn ghost small" onClick={() => retryReceiptDeletion(repo, receipt.receiptId)}>Retry deletion</button>
          ) : (
            <button className="btn ghost small danger" onClick={() => setConfirmDel(true)}>Delete image</button>
          )}
        </div>
      )}
      {deleted && !expense.deletedAt && <a className="btn ghost small" href={`#/scan?attach=${expense.expenseId}`}>Attach a new receipt</a>}
      {fullUrl && (
        <div className="full-image">
          <button className="btn small" onClick={() => setFullUrl('')}>Close image</button>
          <img src={fullUrl} alt="Full receipt" />
        </div>
      )}
      <ConfirmDialog
        open={confirmDel}
        title="Delete the receipt image?"
        confirmLabel="Delete image"
        danger
        onCancel={() => setConfirmDel(false)}
        onConfirm={async () => {
          setConfirmDel(false);
          await requestReceiptDeletion(repo, receipt.receiptId);
          toast('Image queued for deletion. The expense stays.');
        }}
      >
        <p>The image is removed from this device and permanently deleted from Google Drive (skipping Drive's trash) the next time sync runs. The expense and its amounts stay. Copies you downloaded yourself aren't affected.</p>
      </ConfirmDialog>
    </div>
  );
}

export function ExpenseForm(props: { mode: 'new'; kind: ExpenseKind } | { mode: 'edit'; id: string }) {
  const { db, repo, categories, members, thisMemberId, timezone, memberById, rules, recurring, receipts } = useApp();
  const toast = useToast();
  const [existing, setExisting] = useState<Expense | null | undefined>(props.mode === 'new' ? null : undefined);
  const [v, setV] = useState<ExpenseFormValues>(() => ({
    kind: props.mode === 'new' ? props.kind : 'expense', merchantName: '', transactionDate: todayIn(timezone), amount: '', subtotal: '', tax: '',
    tip: '', discount: '', categoryId: UNCATEGORIZED_ID, subcategoryId: '', paidByMemberId: thisMemberId ?? '', expenseType: 'shared', notes: '',
  }));
  const [recurringId, setRecurringId] = useState('');
  const [catTouched, setCatTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const all = useLiveQuery(() => db.expenses.toArray(), [db], [] as Expense[]);

  const editId = props.mode === 'edit' ? props.id : null;
  const liveExisting = useLiveQuery<Expense | undefined>(async () => (editId ? await db.expenses.get(editId) : undefined), [db, editId], undefined);
  const lineItems = useLiveQuery<ExpenseLineItem[]>(async () => (editId ? await db.lineItems.where('expenseId').equals(editId).filter((l) => !l.deletedAt).toArray() : []), [db, editId], []);

  useEffect(() => {
    if (!editId) return;
    void db.expenses.get(editId).then((e) => {
      setExisting(e ?? null);
      if (e) {
        setV(fromExpense(e));
        setRecurringId(e.recurringExpenseId ?? '');
        setCatTouched(true);
        setShowBreakdown(e.subtotalCents !== undefined || e.taxCents !== undefined || e.tipCents !== undefined || e.discountCents !== undefined);
      }
    });
  }, [db, editId]);

  useEffect(() => {
    if (!v.paidByMemberId && thisMemberId) setV((p) => ({ ...p, paidByMemberId: thisMemberId }));
  }, [thisMemberId, v.paidByMemberId]);

  const validIds = useMemo(() => new Set(categories.filter((c) => !c.isArchived).map((c) => c.categoryId)), [categories]);
  const suggestion = useMemo(() => (v.merchantName.trim().length >= 3 ? classify({ merchantName: v.merchantName, rules, validCategoryIds: validIds }) : null), [v.merchantName, rules, validIds]);
  // Auto-apply the suggestion for new entries until the user picks a category themselves.
  useEffect(() => {
    if (!existing && !catTouched && suggestion && suggestion.categoryId !== v.categoryId) setV((p) => ({ ...p, categoryId: suggestion.categoryId, subcategoryId: '' }));
  }, [suggestion, catTouched, existing, v.categoryId]);

  const topCats = categories.filter((c) => !c.parentCategoryId && (!c.isArchived || c.categoryId === v.categoryId));
  const subCats = categories.filter((c) => c.parentCategoryId === v.categoryId && (!c.isArchived || c.categoryId === v.subcategoryId));
  const known = useMemo(() => ({ categoryIds: new Set(categories.map((c) => c.categoryId)), memberIds: new Set(members.map((m) => m.memberId)) }), [categories, members]);
  const validation = validateExpenseForm(v, known);
  const warning = validation.ok ? breakdownWarning(validation.value) : null;
  const dupes = useMemo(() => {
    const cents = tryParseCents(v.amount);
    if (!v.merchantName.trim() || cents === null || !isValidIsoDate(v.transactionDate)) return [];
    return findDuplicates({ merchantName: v.merchantName, transactionDate: v.transactionDate, totalCents: cents, excludeExpenseId: editId ?? undefined }, all, receipts);
  }, [v.merchantName, v.amount, v.transactionDate, all, receipts, editId]);
  const set = <K extends keyof ExpenseFormValues>(k: K, val: ExpenseFormValues[K]) => setV((p) => ({ ...p, [k]: val }));

  if (existing === undefined) return <p className="muted">Loading…</p>;
  if (props.mode === 'edit' && existing === null) {
    return (
      <section>
        <h1 tabIndex={-1}>Expense not found</h1>
        <a className="btn" href="#/expenses">Back to expenses</a>
      </section>
    );
  }
  const current = liveExisting ?? existing ?? null;
  const deleted = Boolean(current?.deletedAt);

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const r = validateExpenseForm(v, known);
    if (!r.ok) {
      setErrors(r.errors);
      document.getElementById(`f-${Object.keys(r.errors)[0]}`)?.focus();
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (current) {
        await repo.updateExpense(current.expenseId, r.value, { recurringExpenseId: recurringId || undefined, verificationStatus: 'verified' });
      } else {
        await repo.createExpense(r.value, { recurringExpenseId: recurringId || undefined });
      }
      if (suggestion) await noteCategoryChoice(db, rules, r.value.merchantName, suggestion.categoryId, r.value.categoryId);
      toast(current ? 'Changes saved' : `${r.value.kind === 'refund' ? 'Refund' : 'Expense'} saved`);
      navigate('/expenses');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'error');
      setSaving(false);
    }
  };

  const err = (k: keyof FieldErrors) => errors[k];
  const isRefund = v.kind === 'refund';
  const prov = current?.fieldProvenance ?? {};

  return (
    <section aria-labelledby="form-title">
      <div className="page-head">
        <h1 id="form-title" tabIndex={-1}>{current ? (deleted ? 'Deleted expense' : 'Expense details') : isRefund ? 'New refund' : 'New expense'}</h1>
        <div className="row gap">
          {!current && <a className="btn ghost" href="#/scan">📷 Scan instead</a>}
          <a className="btn ghost" href="#/expenses">Cancel</a>
        </div>
      </div>

      {deleted && (
        <div className="banner warn" role="status">
          This record is deleted and excluded from totals.
          <button className="btn small" onClick={async () => { await repo.restoreExpense(current!.expenseId); toast('Expense restored'); navigate('/expenses'); }}>Restore</button>
        </div>
      )}
      {current?.verificationStatus === 'needs_review' && !deleted && <div className="banner warn" role="status">Saved from a receipt for later review. Check the details and save to mark it verified.</div>}

      <div className="form-layout">
        <form className="card form" onSubmit={onSubmit} noValidate>
          <fieldset disabled={deleted || saving}>
            <fieldset className="field">
              <legend>Type</legend>
              <div className="seg">
                {(['expense', 'refund'] as const).map((k) => (
                  <label key={k} className={v.kind === k ? 'on' : ''}>
                    <input type="radio" name="kind" checked={v.kind === k} onChange={() => set('kind', k)} />
                    {k === 'expense' ? 'Expense' : 'Refund / credit'}
                  </label>
                ))}
              </div>
              {isRefund && <p className="hint">Refunds reduce spending in their category and in budgets.</p>}
            </fieldset>

            <Field id="f-merchantName" label="Merchant or description" error={err('merchantName')} hint={prov.merchantName ? `Merchant ${PROV_LABEL[prov.merchantName]}` : undefined}>
              <input id="f-merchantName" value={v.merchantName} maxLength={120} autoComplete="off" aria-invalid={!!err('merchantName')} onChange={(e) => set('merchantName', e.target.value)} />
            </Field>

            <div className="grid2">
              <Field id="f-amount" label={isRefund ? 'Refund amount (USD)' : 'Total amount (USD)'} error={err('amount')} hint={prov.totalCents ? `Amount ${PROV_LABEL[prov.totalCents]}` : undefined}>
                <input id="f-amount" inputMode="decimal" placeholder="0.00" value={v.amount} aria-invalid={!!err('amount')} onChange={(e) => set('amount', e.target.value)} />
              </Field>
              <Field id="f-transactionDate" label="Date" error={err('transactionDate')}>
                <input id="f-transactionDate" type="date" value={v.transactionDate} aria-invalid={!!err('transactionDate')} onChange={(e) => set('transactionDate', e.target.value)} />
              </Field>
            </div>

            <div className="grid2">
              <Field id="f-categoryId" label="Category" error={err('categoryId')} hint={suggestion && !catTouched ? `Suggested: ${suggestion.reason}` : undefined}>
                <select id="f-categoryId" value={v.categoryId} onChange={(e) => { setCatTouched(true); setV((p) => ({ ...p, categoryId: e.target.value, subcategoryId: '' })); }}>
                  {topCats.map((c) => <option key={c.categoryId} value={c.categoryId}>{c.icon} {c.name}</option>)}
                </select>
              </Field>
              <Field id="f-subcategoryId" label="Subcategory" error={err('subcategoryId')} hint={subCats.length ? undefined : 'None for this category. Add them in Settings.'}>
                <select id="f-subcategoryId" value={v.subcategoryId} disabled={!subCats.length} onChange={(e) => set('subcategoryId', e.target.value)}>
                  <option value="">None</option>
                  {subCats.map((c) => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
                </select>
              </Field>
            </div>

            <div className="grid2">
              <Field id="f-paidByMemberId" label={isRefund ? 'Refunded to' : 'Who paid'} error={err('paidByMemberId')}>
                <select id="f-paidByMemberId" value={v.paidByMemberId} onChange={(e) => set('paidByMemberId', e.target.value)}>
                  {members.map((m) => <option key={m.memberId} value={m.memberId}>{m.displayName}</option>)}
                </select>
              </Field>
              <fieldset className="field">
                <legend>Shared or personal</legend>
                <div className="seg">
                  {(['shared', 'personal'] as const).map((t) => (
                    <label key={t} className={v.expenseType === t ? 'on' : ''}>
                      <input type="radio" name="etype" checked={v.expenseType === t} onChange={() => set('expenseType', t)} />
                      {t === 'shared' ? 'Shared' : 'Personal'}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <details className="breakdown" open={showBreakdown} onToggle={(e) => setShowBreakdown((e.target as HTMLDetailsElement).open)}>
              <summary>Receipt breakdown (optional)</summary>
              <div className="grid4">
                {(['subtotal', 'tax', 'tip', 'discount'] as const).map((k) => (
                  <Field key={k} id={`f-${k}`} label={k[0]!.toUpperCase() + k.slice(1)} error={err(k)}>
                    <input id={`f-${k}`} inputMode="decimal" placeholder="—" value={v[k]} onChange={(e) => set(k, e.target.value)} />
                  </Field>
                ))}
              </div>
              {warning && <p className="banner warn small" role="status">{warning}</p>}
            </details>

            <Field id="f-recurring" label="Recurring bill (optional)" hint="Link this payment to a recurring bill you track.">
              <select id="f-recurring" value={recurringId} onChange={(e) => setRecurringId(e.target.value)}>
                <option value="">Not recurring</option>
                {recurring.map((r) => <option key={r.recurringExpenseId} value={r.recurringExpenseId}>{r.merchantName}</option>)}
              </select>
            </Field>

            <Field id="f-notes" label="Notes" error={err('notes')}>
              <textarea id="f-notes" rows={3} maxLength={2000} value={v.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>

            {dupes.length > 0 && (
              <div className="banner warn block" role="status">
                Possible duplicate of{' '}
                {dupes.slice(0, 2).map((d, i) => (
                  <span key={d.expense.expenseId}>
                    {i > 0 && ', '}
                    <a href={`#/expenses/${d.expense.expenseId}`}>{d.expense.merchantName} on {formatDate(d.expense.transactionDate)} ({formatCents(d.expense.totalCents)})</a>
                  </span>
                ))}
                . Saving keeps both.
              </div>
            )}
            {validation.ok && <p className="muted small">Saves {isRefund ? 'a refund of ' : ''}{formatCents(validation.value.totalCents)} on this device first, then syncs.</p>}
          </fieldset>

          {!deleted && (
            <div className="row gap between">
              {current ? <button type="button" className="btn danger ghost" onClick={() => setConfirmDelete(true)}>Delete</button> : <span />}
              <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          )}
        </form>

        {current && (
          <aside className="side-col">
            <ReceiptPanel expense={current} />
            {lineItems.length > 0 && (
              <div className="card">
                <h2>Line items</h2>
                <table className="li-table">
                  <tbody>
                    {lineItems.map((l) => (
                      <tr key={l.lineItemId}>
                        <td>{l.quantity ? `${l.quantity} × ` : ''}{l.description}</td>
                        <td className="num">{formatCents(l.totalCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">
              Entered by {memberById.get(current.createdByMemberId)?.displayName ?? 'unknown'} · created {formatInstant(current.createdAt, timezone)}
              {current.updatedAt !== current.createdAt && ` · updated ${formatInstant(current.updatedAt, timezone)}`} · source: {current.source}
              {current.paymentMethod && ` · paid with ${current.paymentMethod}`}
              {current.receiptNumber && ` · receipt #${current.receiptNumber}`}
            </p>
          </aside>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this expense?"
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          await repo.deleteExpense(current!.expenseId);
          toast('Expense deleted. Restore it from Expenses → Filters → Show deleted.');
          navigate('/expenses');
        }}
      >
        <p>It will be removed from totals on every device after syncing. You can restore it later. A receipt image, if any, follows its normal retention schedule.</p>
      </ConfirmDialog>
    </section>
  );
}
