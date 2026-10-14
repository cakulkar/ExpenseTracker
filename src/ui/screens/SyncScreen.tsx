import { useState } from 'react';
import { useApp } from '../AppContext';
import { useSync } from '../SyncContext';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getSetting, setSetting, deleteSetting } from '../../db/settings';
import { createDriveHousehold, findDriveHousehold, joinDriveHousehold, retryReceiptDeletion } from '../../sync/engine';
import { STATE_LABEL, useSyncStatus } from '../../sync/status';
import { formatCents } from '../../domain/money';
import { formatDate, formatInstant, todayIn } from '../../domain/dates';
import type { Conflict, DeletionAudit, Expense } from '../../domain/types';
import { ENTITY_TABLES } from '../../db/schema';
import { ConfirmDialog, Field, useOnline, useToast } from '../components/common';

const FIELD_LABEL: Record<string, string> = {
  totalCents: 'Amount', merchantName: 'Merchant', transactionDate: 'Date', categoryId: 'Category', subcategoryId: 'Subcategory', paidByMemberId: 'Paid by',
  expenseType: 'Shared/personal', notes: 'Notes', kind: 'Expense/refund', taxCents: 'Tax', tipCents: 'Tip', subtotalCents: 'Subtotal', discountCents: 'Discount',
  monthlyLimitCents: 'Monthly limit', name: 'Name', displayName: 'Name', expectedAmountCents: 'Expected amount', __deleted__: 'Deleted vs edited',
};

export function RecoveryKeyDisplay({ text, onDone }: { text: string; onDone: () => void }) {
  const [check, setCheck] = useState('');
  const groups = text.split('-');
  const last = groups[groups.length - 1]!;
  return (
    <div className="recovery">
      <h2>Your household recovery key</h2>
      <p>
        This key unlocks your shared, encrypted data on a new phone or computer. <strong>It is shown only once.</strong> Write it down or save it in a
        password manager, and give your spouse a copy. Google can't recover it, and neither can PocketLedger.
      </p>
      <p className="recovery-key" aria-label={`Recovery key: ${groups.join(' ')}`}>{groups.map((g, i) => <span key={i}>{g}</span>)}</p>
      <div className="row gap wrap">
        <button className="btn ghost small" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
        <button className="btn ghost small" onClick={() => window.print()}>Print</button>
      </div>
      <Field id="rk-check" label={`To confirm you saved it, type the last group (${groups.length}th): ____`}>
        <input id="rk-check" value={check} autoComplete="off" onChange={(e) => setCheck(e.target.value.toUpperCase())} />
      </Field>
      <button className="btn primary" disabled={check.trim() !== last} onClick={onDone}>I saved the recovery key</button>
    </div>
  );
}

export function SyncScreen() {
  const { db, repo, timezone, receipts, pendingOps, categoryById, memberById, household } = useApp();
  const sync = useSync();
  const st = useSyncStatus();
  const online = useOnline();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [recoveryText, setRecoveryText] = useState<string | null>(null);
  const [joinMode, setJoinMode] = useState<null | { replace: boolean }>(null);
  const [keyInput, setKeyInput] = useState('');
  const [disconnect, setDisconnect] = useState(false);
  const conflicts = useLiveQuery(() => db.conflicts.filter((c) => !c.resolvedAt).toArray(), [db], [] as Conflict[]);
  const audit = useLiveQuery(() => db.deletionAudit.toArray(), [db], [] as DeletionAudit[]);
  const encryptReceipts = useLiveQuery(async () => (await getSetting(db, 'encryptReceipts')) ?? true, [db], true);
  const expensesById = useLiveQuery(async () => new Map((await db.expenses.toArray()).map((e) => [e.expenseId, e])), [db], new Map<string, Expense>());
  const today = todayIn(timezone);
  const lastLocal = useLiveQueryLast(db);

  const waitingUpload = receipts.filter((r) => r.deletionStatus === 'active' && r.uploadStatus !== 'uploaded');
  const failedUpload = receipts.filter((r) => r.deletionStatus === 'active' && r.uploadStatus === 'failed');
  const overdue = receipts.filter((r) => r.deletionStatus !== 'deleted' && r.retentionDeadline <= today);
  const failedDeletion = receipts.filter((r) => r.deletionStatus === 'failed');
  const upcoming = receipts.filter((r) => r.deletionStatus === 'active' && r.retentionDeadline > today).sort((a, b) => a.retentionDeadline.localeCompare(b.retentionDeadline));

  const connect = async () => {
    setBusy(true);
    try {
      await sync.signIn();
      const existing = await findDriveHousehold(sync.drive);
      if (existing) {
        const sameHousehold = existing.keyFile.householdId === household?.householdId;
        setJoinMode({ replace: !sameHousehold });
        toast(sameHousehold ? 'Found your household in Drive. Enter the recovery key.' : 'Found a PocketLedger household in this Drive.');
      } else {
        const { recoveryKey } = await createDriveHousehold(db, sync.drive);
        setRecoveryText(recoveryKey);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not connect', 'error');
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    try {
      if (!sync.signedIn) await sync.signIn();
      await joinDriveHousehold(db, sync.drive, keyInput, { replaceLocal: joinMode?.replace ?? false });
      setJoinMode(null);
      setKeyInput('');
      toast('Connected. Syncing…');
      if (joinMode?.replace) window.location.reload();
      else await sync.syncNow();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not join', 'error');
    } finally {
      setBusy(false);
    }
  };

  const describe = (c: Conflict) => {
    const t = ENTITY_TABLES[c.entityType];
    const exp = c.entityType === 'expense' ? expensesById.get(c.entityId) : undefined;
    const label = FIELD_LABEL[c.field] ?? c.field;
    const fmt = (v: unknown) => {
      if (v === undefined || v === null || v === '') return '(empty)';
      if (/Cents$/.test(c.field) && typeof v === 'number') return formatCents(v);
      if (c.field === 'categoryId' || c.field === 'subcategoryId') return categoryById.get(String(v))?.name ?? String(v);
      if (c.field === 'paidByMemberId') return memberById.get(String(v))?.displayName ?? String(v);
      if (c.field === 'transactionDate') return formatDate(String(v));
      return String(v);
    };
    return { title: exp ? `${exp.merchantName} · ${formatDate(exp.transactionDate)}` : `${t.table} record`, label, kept: fmt(c.keptValue), other: fmt(c.otherValue), link: exp ? `#/expenses/${exp.expenseId}` : undefined };
  };

  const resolve = async (c: Conflict, choose: 'kept' | 'other') => {
    if (c.field === '__deleted__') {
      if (choose === 'other') await repo.tx(() => repo.setDeletedIn(c.entityType, c.entityId, false));
    } else {
      const value = choose === 'kept' ? c.keptValue : c.otherValue;
      await repo.tx(() => repo.updateIn(c.entityType, c.entityId, { [c.field]: value ?? undefined }));
    }
    await db.conflicts.update(c.conflictId, { resolvedAt: new Date().toISOString() });
    toast('Conflict resolved');
    void sync.syncNow();
  };

  return (
    <section aria-labelledby="sync-title" className="sync-page">
      <h1 id="sync-title" tabIndex={-1}>Sync &amp; Google Drive</h1>

      {recoveryText ? (
        <div className="card">
          <RecoveryKeyDisplay
            text={recoveryText}
            onDone={() => {
              setRecoveryText(null);
              toast('Drive connected. Your spouse can now join with the recovery key.');
              void sync.syncNow();
            }}
          />
        </div>
      ) : (
        <div className="card">
          <div className="row between wrap">
            <h2>Status: {STATE_LABEL[st.state]}{st.running ? ' (running)' : ''}</h2>
            {sync.connected && (
              <button className="btn primary" disabled={busy || st.running || !online} onClick={() => sync.syncNow(true).catch((e) => toast(e instanceof Error ? e.message : 'Sign-in failed', 'error'))}>
                {sync.signedIn ? 'Sync now' : 'Sign in & sync'}
              </button>
            )}
          </div>
          <dl className="kv">
            <div><dt>Last successful sync</dt><dd>{st.lastSuccessAt ? formatInstant(st.lastSuccessAt, timezone) : (lastLocal ?? 'never')}</dd></div>
            <div><dt>Changes waiting on this device</dt><dd>{pendingOps}</dd></div>
            <div><dt>Receipt images waiting to upload</dt><dd>{waitingUpload.length}</dd></div>
            <div><dt>Google account</dt><dd>{sync.signedIn ? 'Signed in (this session)' : 'Not signed in'}</dd></div>
            {st.lastError && <div><dt>Last error</dt><dd className="bad">{st.lastError}</dd></div>}
          </dl>

          {!sync.configured && (
            <p className="banner warn block">This copy of the app has no Google Client ID, so Drive sync is unavailable. See docs/OAUTH_SETUP.md. Everything still works on this device.</p>
          )}

          {sync.configured && !sync.connected && !sync.needsKey && !joinMode && (
            <>
              <p>
                Connect the shared household Google account to back up and share your ledger. PocketLedger asks only for access to <strong>files it creates</strong>.
                Your ledger is encrypted on this device before upload; Google stores only unreadable data plus your receipt images (encrypted by default).
              </p>
              <button className="btn primary" disabled={busy || !online} onClick={connect}>{busy ? 'Connecting…' : 'Connect Google Drive'}</button>
            </>
          )}

          {(joinMode || sync.needsKey) && (
            <div className="join">
              <p>
                {joinMode?.replace
                  ? 'This Google Drive already has a PocketLedger household. To join it, enter its recovery key. This device’s current data will be replaced by the household’s data — download a backup first if you need it.'
                  : 'Enter the household recovery key to unlock your shared data on this device.'}
              </p>
              <Field id="rk" label="Recovery key"><input id="rk" value={keyInput} autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" onChange={(e) => setKeyInput(e.target.value)} /></Field>
              <div className="row gap">
                {joinMode && <button className="btn ghost" onClick={() => setJoinMode(null)}>Cancel</button>}
                <button className="btn primary" disabled={busy || keyInput.replace(/[\s-]/g, '').length < 32} onClick={join}>{joinMode?.replace ? 'Replace data and join' : 'Unlock'}</button>
              </div>
            </div>
          )}

          {sync.connected && (
            <>
              <label className="check">
                <input type="checkbox" checked={encryptReceipts} onChange={(e) => setSetting(db, 'encryptReceipts', e.target.checked)} />
                Encrypt receipt images before upload (recommended). Turn off only if you want to open images directly in Google Drive.
              </label>
              <button className="btn ghost small danger" onClick={() => setDisconnect(true)}>Disconnect this device from Drive…</button>
            </>
          )}
          <details>
            <summary>How sync works</summary>
            <ul>
              <li>Everything is saved on this device first. Sync uploads encrypted changes to the household Drive and downloads your spouse's changes.</li>
              <li>Sync runs when you open the app, when it comes back online, every 5 minutes while open, and shortly after you make changes. It can't run while every device is closed.</li>
              <li>If you both change the same field before syncing, both devices keep the most recent change and the other value is listed below for you to choose. Nothing is silently lost.</li>
              <li>Google sign-in gives access to Drive; the recovery key unlocks the data. Neither one alone is enough.</li>
            </ul>
          </details>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="card">
          <h2>Edits that need a decision ({conflicts.length})</h2>
          <ul className="conflicts">
            {conflicts.map((c) => {
              const d = describe(c);
              return (
                <li key={c.conflictId}>
                  <p>{d.link ? <a href={d.link}>{d.title}</a> : d.title} — <strong>{d.label}</strong></p>
                  {c.field === '__deleted__' ? (
                    <div className="row gap wrap">
                      <span>One device deleted this record while the other edited it. It's currently {String(c.keptValue)}.</span>
                      <button className="btn small" onClick={() => resolve(c, 'kept')}>Keep it deleted</button>
                      <button className="btn small" onClick={() => resolve(c, 'other')}>Restore it</button>
                    </div>
                  ) : (
                    <div className="row gap wrap">
                      <button className="btn small" onClick={() => resolve(c, 'kept')}>Keep “{d.kept}” (current)</button>
                      <button className="btn small" onClick={() => resolve(c, 'other')}>Use “{d.other}”</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Receipt images</h2>
        {failedUpload.length > 0 && (
          <p className="banner warn block">
            {failedUpload.length} upload{failedUpload.length > 1 ? 's' : ''} failed and will be retried automatically.{' '}
            <button className="btn small" onClick={async () => { for (const r of failedUpload) await repo.updateReceipt(r.receiptId, { nextUploadAt: undefined, uploadStatus: 'pending' }); void sync.syncNow(true); }}>Retry now</button>
          </p>
        )}
        <dl className="kv">
          <div><dt>Stored in Drive</dt><dd>{receipts.filter((r) => r.uploadStatus === 'uploaded' && r.deletionStatus !== 'deleted').length}</dd></div>
          <div><dt>Waiting on a device</dt><dd>{waitingUpload.length}</dd></div>
          <div><dt>Deleted after 2 years (or by you)</dt><dd>{receipts.filter((r) => r.deletionStatus === 'deleted').length}</dd></div>
          <div><dt>Overdue for deletion</dt><dd className={overdue.length ? 'bad' : ''}>{overdue.length}{overdue.length ? ' — deleted at the next sync' : ''}</dd></div>
          <div><dt>Next scheduled deletion</dt><dd>{upcoming[0] ? formatDate(upcoming[0].retentionDeadline) : '—'}</dd></div>
        </dl>
        {failedDeletion.length > 0 && (
          <div className="banner warn block">
            <p>{failedDeletion.length} deletion{failedDeletion.length > 1 ? 's' : ''} failed (retrying with increasing waits).</p>
            <button className="btn small" onClick={async () => { for (const r of failedDeletion) await retryReceiptDeletion(repo, r.receiptId); void sync.syncNow(true); }}>Retry deletions now</button>
          </div>
        )}
        <details>
          <summary>Deletion log on this device ({audit.length})</summary>
          <table className="li-table">
            <thead><tr><th>Due</th><th>Result</th><th>When</th></tr></thead>
            <tbody>
              {audit.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).slice(0, 100).map((a) => (
                <tr key={a.receiptId}>
                  <td>{formatDate(a.scheduledDeadline)}</td>
                  <td>{a.status === 'deleted' ? 'Deleted from Drive (verified)' : a.status === 'not_uploaded' ? 'Removed from device (never uploaded)' : `Failed (${a.attempts} tries)`}</td>
                  <td>{a.completedAt ? formatInstant(a.completedAt, timezone) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <p className="muted small">
          Images are deleted with Drive's permanent delete (not the trash) and then checked. Deletion runs only while the app is open on some device, so it
          may happen after the exact date. Copies you downloaded or exported yourself aren't affected.
        </p>
      </div>

      <ConfirmDialog
        open={disconnect}
        title="Disconnect this device from Drive?"
        confirmLabel="Disconnect"
        danger
        onCancel={() => setDisconnect(false)}
        onConfirm={async () => {
          setDisconnect(false);
          await deleteSetting(db, 'householdKey');
          await deleteSetting(db, 'driveConfig');
          toast('Disconnected. Data on this device and in Drive is unchanged.');
        }}
      >
        <p>This device stops syncing and forgets the household key. Your data stays on this device and in Drive. To reconnect you'll need the recovery key.</p>
        {pendingOps > 0 && <p><strong>{pendingOps} changes haven't been uploaded yet.</strong> Sync first if your spouse should get them.</p>}
      </ConfirmDialog>
    </section>
  );
}

function useLiveQueryLast(db: ReturnType<typeof useApp>['db']): string | null {
  const { timezone } = useApp();
  const v = useLiveQuery(async () => (await getSetting(db, 'lastSyncAt')) ?? null, [db], null);
  return v ? formatInstant(v, timezone) : null;
}
