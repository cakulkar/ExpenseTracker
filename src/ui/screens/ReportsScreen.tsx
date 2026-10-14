import { useMemo, useState } from 'react';
import { useApp } from '../AppContext';
import { useSync } from '../SyncContext';
import { useLiveQuery } from '../hooks/useLiveQuery';
import type { Expense } from '../../domain/types';
import { filterExpenses, sortExpenses } from '../../domain/expenseQuery';
import { formatCents, tryParseCents } from '../../domain/money';
import { addMonthsToMonth, formatDate, formatMonth, isValidIsoDate, monthOf, monthRange, todayIn } from '../../domain/dates';
import { buildCsv, buildPdfReport, buildXlsxReport, type ReportData } from '../../export/reports';
import { guessMapping, IMPORT_FIELDS, mapImportRows, parseCsv, type ColumnMapping, type ImportRow } from '../../export/csv';
import { createBackup, createEncryptedBackup, isEncryptedBackup, readBackup, restoreBackup, type BackupFile } from '../../db/backup';
import { setSetting } from '../../db/settings';
import { MIN_BACKUP_PASSWORD } from '../../crypto/crypto';
import { findDuplicates } from '../../domain/duplicates';
import { UNCATEGORIZED_ID } from '../../domain/categories';
import { ConfirmDialog, Field, useToast } from '../components/common';

export function download(filename: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

type Preset = 'this-month' | 'last-month' | 'this-year' | 'all' | 'custom';
type Format = 'csv' | 'xlsx' | 'pdf';

export function ReportsScreen() {
  const { db, repo, categories, categoryById, categoryParents, members, memberById, receiptById, budgets, timezone, thisMemberId, pendingOps, receipts } = useApp();
  const { engine, connected } = useSync();
  const toast = useToast();
  const today = todayIn(timezone);
  const all = useLiveQuery(() => db.expenses.toArray(), [db], [] as Expense[]);

  const [preset, setPreset] = useState<Preset>('this-month');
  const [from, setFrom] = useState(monthRange(monthOf(today)).from);
  const [to, setTo] = useState(today);
  const [category, setCategory] = useState('');
  const [merchant, setMerchant] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [confirmFormat, setConfirmFormat] = useState<Format | null>(null);
  const [busy, setBusy] = useState(false);

  const range = useMemo(() => {
    const m = monthOf(today);
    switch (preset) {
      case 'this-month': return { ...monthRange(m), label: formatMonth(m), month: m };
      case 'last-month': { const p = addMonthsToMonth(m, -1); return { ...monthRange(p), label: formatMonth(p), month: p }; }
      case 'this-year': return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31`, label: `Year ${today.slice(0, 4)}`, month: undefined };
      case 'all': return { from: '1900-01-01', to: '2200-12-31', label: 'All time', month: undefined };
      case 'custom': return { from: isValidIsoDate(from) ? from : '1900-01-01', to: isValidIsoDate(to) ? to : '2200-12-31', label: `${isValidIsoDate(from) ? formatDate(from) : '…'} – ${isValidIsoDate(to) ? formatDate(to) : '…'}`, month: undefined };
    }
  }, [preset, from, to, today]);

  const list = useMemo(
    () => sortExpenses(filterExpenses(all, { from: range.from, to: range.to, categoryIds: category ? [category] : undefined, text: merchant || undefined, minCents: tryParseCents(min) ?? undefined, maxCents: tryParseCents(max) ?? undefined, paidByMemberId: paidBy || undefined }, categoryParents), 'date', 'asc'),
    [all, range, category, merchant, min, max, paidBy, categoryParents],
  );

  const data = (): ReportData => ({
    title: `Household expenses · ${range.label}`, rangeLabel: range.label, expenses: list, categories: categoryById, categoryParents, members: memberById,
    receipts: receiptById, budgets, month: range.month,
  });

  const doExport = async (fmt: Format) => {
    setConfirmFormat(null);
    setBusy(true);
    try {
      const stamp = `${range.from === '1900-01-01' ? 'all' : range.from}_${range.to === '2200-12-31' ? today : range.to}`;
      if (fmt === 'csv') download(`pocketledger-${stamp}.csv`, buildCsv(data()), 'text/csv;charset=utf-8');
      if (fmt === 'xlsx') download(`pocketledger-${stamp}.xlsx`, buildXlsxReport(data()) as BlobPart, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      if (fmt === 'pdf') download(`pocketledger-${stamp}.pdf`, (await buildPdfReport(data())) as BlobPart, 'application/pdf');
      toast(`${fmt.toUpperCase()} downloaded (${list.length} records)`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Export failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // ----- backups -----
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [plainWarn, setPlainWarn] = useState(false);
  const [restore, setRestore] = useState<{ text: string; encrypted: boolean; name: string } | null>(null);
  const [restorePw, setRestorePw] = useState('');
  const [restoreReady, setRestoreReady] = useState<BackupFile | null>(null);

  const encryptedBackup = async (toDrive: boolean) => {
    if (pw.length < MIN_BACKUP_PASSWORD) return toast(`Use a backup password of at least ${MIN_BACKUP_PASSWORD} characters`, 'error');
    if (pw !== pw2) return toast("The passwords don't match", 'error');
    setBusy(true);
    try {
      const env = await createEncryptedBackup(db, pw);
      const text = JSON.stringify(env);
      const name = `pocketledger-backup-${today}.plbackup.json`;
      if (toDrive && engine) await engine.saveBackupToDrive(name, new TextEncoder().encode(text));
      else download(name, text, 'application/json');
      await setSetting(db, 'lastBackupAt', new Date().toISOString());
      toast(toDrive ? 'Encrypted backup saved to PocketLedger/Exports in Drive' : 'Encrypted backup downloaded');
      setPw('');
      setPw2('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Backup failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // ----- CSV import -----
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [importing, setImporting] = useState(false);
  const preview: Array<ImportRow & { dup: boolean }> = useMemo(() => {
    if (!csvRows) return [];
    const rows = mapImportRows(csvRows.slice(1), mapping, { categories, members, defaultMemberId: thisMemberId ?? members[0]?.memberId ?? '', uncategorizedId: UNCATEGORIZED_ID });
    return rows.map((r) => ({ ...r, dup: !!r.value && findDuplicates({ merchantName: r.value.merchantName, transactionDate: r.value.transactionDate, totalCents: r.value.totalCents }, all, receipts).length > 0 }));
  }, [csvRows, mapping, categories, members, thisMemberId, all, receipts]);
  const [skipDups, setSkipDups] = useState(true);
  const importable = preview.filter((r) => r.ok && !(skipDups && r.dup));

  const runImport = async () => {
    setImporting(true);
    let n = 0;
    try {
      for (const r of importable) {
        const v = r.value!;
        await repo.createExpense({ ...v, subtotalCents: undefined, discountCents: undefined, subcategoryId: undefined }, { source: 'import' });
        n++;
      }
      toast(`Imported ${n} record${n === 1 ? '' : 's'}`);
      setCsvRows(null);
    } catch (e) {
      toast(`Stopped after ${n}: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <section aria-labelledby="rep-title" className="reports">
      <h1 id="rep-title" tabIndex={-1}>Reports &amp; backup</h1>

      <div className="card">
        <h2>Export transactions</h2>
        <div className="grid3">
          <Field id="x-range" label="Dates">
            <select id="x-range" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              <option value="this-month">This month</option><option value="last-month">Last month</option><option value="this-year">This year</option>
              <option value="all">All time</option><option value="custom">Custom…</option>
            </select>
          </Field>
          {preset === 'custom' && <Field id="x-from" label="From"><input id="x-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>}
          {preset === 'custom' && <Field id="x-to" label="To"><input id="x-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>}
          <Field id="x-cat" label="Category">
            <select id="x-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All</option>
              {categories.filter((c) => !c.parentCategoryId).map((c) => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
            </select>
          </Field>
          <Field id="x-merchant" label="Merchant contains"><input id="x-merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} /></Field>
          <Field id="x-paid" label="Paid by">
            <select id="x-paid" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
              <option value="">Anyone</option>
              {members.map((m) => <option key={m.memberId} value={m.memberId}>{m.displayName}</option>)}
            </select>
          </Field>
          <Field id="x-min" label="Min amount"><input id="x-min" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
          <Field id="x-max" label="Max amount"><input id="x-max" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
        </div>
        <p className="muted small" aria-live="polite">{list.filter((e) => !e.deletedAt).length} records · {range.label}. Records are exported even if their receipt image has expired.</p>
        <div className="row gap wrap">
          <button className="btn primary" disabled={busy || list.length === 0} onClick={() => setConfirmFormat('csv')}>Download CSV</button>
          <button className="btn primary" disabled={busy || list.length === 0} onClick={() => setConfirmFormat('xlsx')}>Download Excel (XLSX)</button>
          <button className="btn primary" disabled={busy || list.length === 0} onClick={() => setConfirmFormat('pdf')}>Download PDF report</button>
        </div>
      </div>

      <div className="card">
        <h2>Encrypted backup (recommended)</h2>
        <p className="muted small">Everything in the ledger, locked with a password you choose. Keep the password with your recovery key — it can't be reset.</p>
        <div className="grid2">
          <Field id="bk-pw" label={`Backup password (${MIN_BACKUP_PASSWORD}+ characters)`}><input id="bk-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field id="bk-pw2" label="Repeat password"><input id="bk-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
        </div>
        <div className="row gap wrap">
          <button className="btn primary" disabled={busy} onClick={() => encryptedBackup(false)}>Download encrypted backup</button>
          {connected && <button className="btn ghost" disabled={busy} onClick={() => encryptedBackup(true)}>Save encrypted backup to Drive</button>}
          <button className="btn ghost" onClick={() => setPlainWarn(true)}>Unencrypted backup…</button>
        </div>
        <h3>Restore</h3>
        <label className="btn ghost file-btn">
          Choose backup file
          <input
            type="file"
            className="sr-only"
            accept="application/json,.json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const text = await f.text();
              setRestorePw('');
              setRestoreReady(null);
              setRestore({ text, encrypted: isEncryptedBackup(text), name: f.name });
            }}
          />
        </label>
        {restore && (
          <div className="card inset">
            <p><strong>{restore.name}</strong> {restore.encrypted ? '(encrypted)' : '(not encrypted)'}</p>
            {restore.encrypted && <Field id="rs-pw" label="Backup password"><input id="rs-pw" type="password" value={restorePw} onChange={(e) => setRestorePw(e.target.value)} /></Field>}
            <div className="row gap">
              <button className="btn ghost" onClick={() => setRestore(null)}>Cancel</button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    setRestoreReady(await readBackup(restore.text, restorePw || undefined));
                  } catch (err) {
                    toast(err instanceof Error ? err.message : 'Could not read backup', 'error');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Check backup
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Import from CSV</h2>
        <p className="muted small">Import a CSV exported from PocketLedger (or a spreadsheet with date, merchant and amount columns). You'll see a preview first.</p>
        <label className="btn ghost file-btn">
          Choose CSV file
          <input
            type="file"
            className="sr-only"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                const rows = parseCsv(await f.text());
                if (rows.length < 2) throw new Error('The file has no data rows');
                setCsvRows(rows);
                setMapping(guessMapping(rows[0]!));
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not read CSV', 'error');
              }
            }}
          />
        </label>
        {csvRows && (
          <div className="import">
            <h3>Match columns</h3>
            <div className="grid3">
              {IMPORT_FIELDS.map((f) => (
                <Field key={f.field} id={`map-${f.field}`} label={`${f.label}${f.required ? ' *' : ''}`}>
                  <select id={`map-${f.field}`} value={mapping[f.field] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.field]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                    <option value="">— not in file —</option>
                    {csvRows[0]!.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </Field>
              ))}
            </div>
            <p>
              {preview.filter((r) => r.ok).length} valid · {preview.filter((r) => !r.ok).length} with errors · {preview.filter((r) => r.dup).length} look like duplicates
            </p>
            <label className="check"><input type="checkbox" checked={skipDups} onChange={(e) => setSkipDups(e.target.checked)} /> Skip likely duplicates</label>
            <div className="table-scroll">
              <table className="preview">
                <thead><tr><th>Line</th><th>Date</th><th>Merchant</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {preview.slice(0, 50).map((r) => (
                    <tr key={r.line} className={!r.ok ? 'bad' : r.dup ? 'warn' : ''}>
                      <td>{r.line}</td>
                      <td>{r.value?.transactionDate ?? ''}</td>
                      <td>{r.value?.merchantName ?? ''}</td>
                      <td>{r.value ? `${r.value.kind === 'refund' ? '−' : ''}${formatCents(r.value.totalCents)}` : ''}</td>
                      <td>{r.ok ? (r.dup ? 'Possible duplicate' : 'OK') : r.errors.join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.length > 50 && <p className="muted small">Showing the first 50 of {preview.length} rows.</p>}
            <div className="row gap">
              <button className="btn ghost" onClick={() => setCsvRows(null)}>Cancel</button>
              <button className="btn primary" disabled={importing || importable.length === 0 || mapping.date === undefined || mapping.merchant === undefined} onClick={runImport}>
                {importing ? 'Importing…' : `Import ${importable.length} record${importable.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmFormat}
        title="Export unencrypted data?"
        confirmLabel={`Download ${confirmFormat?.toUpperCase() ?? ''}`}
        onCancel={() => setConfirmFormat(null)}
        onConfirm={() => void doExport(confirmFormat!)}
      >
        <p>The file will contain {list.filter((e) => !e.deletedAt).length} expense records in readable form (merchants, amounts, notes). Store it somewhere private and delete it when you no longer need it.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={plainWarn}
        title="Download an unencrypted backup?"
        confirmLabel="Download unencrypted"
        onCancel={() => setPlainWarn(false)}
        onConfirm={async () => {
          setPlainWarn(false);
          const b = await createBackup(db);
          download(`pocketledger-backup-${today}-UNENCRYPTED.json`, JSON.stringify(b), 'application/json');
          await setSetting(db, 'lastBackupAt', b.exportedAt);
        }}
      >
        <p>Anyone who gets this file can read your entire ledger. Prefer the encrypted backup.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!restoreReady}
        title="Replace this device's data with the backup?"
        confirmLabel="Restore backup"
        danger
        onCancel={() => setRestoreReady(null)}
        onConfirm={async () => {
          const b = restoreReady!;
          setRestoreReady(null);
          setRestore(null);
          await restoreBackup(db, b, { memberId: thisMemberId });
          toast('Backup restored');
          window.location.reload();
        }}
      >
        <p>
          Backup from {restoreReady && new Date(restoreReady.exportedAt).toLocaleString()} with {restoreReady && (restoreReady.tables.expenses as unknown[]).length} expense records.
          All ledger data on this device is replaced. {connected && 'Restored records then sync; newer edits already in Drive are kept.'}
          {pendingOps > 0 && <strong> {pendingOps} unsynced changes on this device will be lost.</strong>}
        </p>
      </ConfirmDialog>
    </section>
  );
}
