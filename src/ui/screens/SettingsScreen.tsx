import { useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getSetting, setSetting } from '../../db/settings';
import { createLockConfig, passcodeProblem, verifyPasscode } from '../../lock/passcode';
import { formatInstant } from '../../domain/dates';
import { ConfirmDialog, useToast } from '../components/common';
import { PasscodePad } from '../components/PasscodePad';

export function SettingsScreen() {
  const { db, repo, members, categories, categoryById, rules, thisMemberId, timezone, pendingOps, household } = useApp();
  const toast = useToast();
  const autoLock = useLiveQuery(async () => (await getSetting(db, 'autoLockMinutes')) ?? 5, [db], 5);
  const lastBackupAt = useLiveQuery(async () => (await getSetting(db, 'lastBackupAt')) ?? null, [db], null);
  const [newCat, setNewCat] = useState('');
  const [newCatParent, setNewCatParent] = useState('');
  const [eraseOpen, setEraseOpen] = useState(false);
  const [pcStep, setPcStep] = useState<'idle' | 'old' | 'new' | 'confirm'>('idle');
  const [pcNew, setPcNew] = useState('');
  const [pcMsg, setPcMsg] = useState('');
  const [pcReset, setPcReset] = useState(0);
  const [storage, setStorage] = useState<{ persisted: boolean | null; usage?: number; quota?: number }>({ persisted: null });

  useEffect(() => {
    void (async () => {
      const persisted = (await navigator.storage?.persisted?.()) ?? null;
      const est = await navigator.storage?.estimate?.();
      setStorage({ persisted, usage: est?.usage, quota: est?.quota });
    })();
  }, []);

  const topCats = categories.filter((c) => !c.parentCategoryId);

  return (
    <section aria-labelledby="set-title" className="settings">
      <h1 id="set-title" tabIndex={-1}>Settings</h1>

      <div className="card">
        <h2>Household</h2>
        <form
          className="row gap inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await repo.renameHousehold(new FormData(e.currentTarget).get('hh') as string);
              toast('Household renamed');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Could not rename', 'error');
            }
          }}
        >
          <label className="sr-only" htmlFor="hh-name">Household name</label>
          <input id="hh-name" name="hh" defaultValue={household?.displayName} key={household?.displayName} maxLength={60} />
          <button className="btn ghost small" type="submit">Rename</button>
        </form>
        <p className="muted small">Timezone {timezone} · Currency USD</p>
        {members.map((m) => (
          <form
            key={m.memberId}
            className="row gap inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get('name') as string;
              try {
                await repo.renameMember(m.memberId, name);
                toast('Name updated');
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not rename', 'error');
              }
            }}
          >
            <label className="sr-only" htmlFor={`mn-${m.memberId}`}>Name</label>
            <input id={`mn-${m.memberId}`} name="name" defaultValue={m.displayName} maxLength={40} />
            <button className="btn ghost small" type="submit">Rename</button>
            {m.memberId === thisMemberId && <span className="tag">This device</span>}
          </form>
        ))}
        <label className="field">
          Who uses this device?
          <select value={thisMemberId ?? ''} onChange={async (e) => { await setSetting(db, 'memberId', e.target.value); toast('Updated'); }}>
            {members.map((m) => <option key={m.memberId} value={m.memberId}>{m.displayName}</option>)}
          </select>
        </label>
      </div>

      <div className="card">
        <h2>Categories</h2>
        <form
          className="row gap wrap inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await repo.createCategory(newCat, { parentCategoryId: newCatParent || undefined });
              setNewCat('');
              toast('Category added');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Could not add', 'error');
            }
          }}
        >
          <label className="sr-only" htmlFor="nc">New category name</label>
          <input id="nc" placeholder="New category name" value={newCat} maxLength={60} onChange={(e) => setNewCat(e.target.value)} />
          <label className="sr-only" htmlFor="ncp">Parent</label>
          <select id="ncp" value={newCatParent} onChange={(e) => setNewCatParent(e.target.value)}>
            <option value="">Top-level category</option>
            {topCats.filter((c) => !c.isArchived).map((c) => <option key={c.categoryId} value={c.categoryId}>Subcategory of {c.name}</option>)}
          </select>
          <button className="btn primary small" type="submit" disabled={!newCat.trim()}>Add</button>
        </form>
        <ul className="cat-list">
          {topCats.map((c) => (
            <li key={c.categoryId}>
              <div className={`cat-item ${c.isArchived ? 'archived' : ''}`}>
                <span>{c.icon} {c.name}{c.isArchived && ' (archived)'}</span>
                {c.categoryId !== 'cat-uncategorized' && (
                  <button className="btn ghost small" onClick={() => repo.updateCategory(c.categoryId, { isArchived: !c.isArchived })}>
                    {c.isArchived ? 'Unarchive' : 'Archive'}
                  </button>
                )}
              </div>
              {categories.filter((s) => s.parentCategoryId === c.categoryId).map((s) => (
                <div key={s.categoryId} className={`cat-item sub ${s.isArchived ? 'archived' : ''}`}>
                  <span>↳ {s.name}{s.isArchived && ' (archived)'}</span>
                  <button className="btn ghost small" onClick={() => repo.updateCategory(s.categoryId, { isArchived: !s.isArchived })}>
                    {s.isArchived ? 'Unarchive' : 'Archive'}
                  </button>
                </div>
              ))}
            </li>
          ))}
        </ul>
        <p className="hint">Archived categories stay on past expenses but aren't offered for new ones.</p>
      </div>

      <div className="card">
        <h2>Security</h2>
        <label className="field">
          Lock automatically after
          <select value={autoLock} onChange={(e) => setSetting(db, 'autoLockMinutes', Number(e.target.value))}>
            {[1, 5, 15, 30].map((m) => <option key={m} value={m}>{m} minute{m > 1 ? 's' : ''} in the background</option>)}
          </select>
        </label>
        {pcStep === 'idle' ? (
          <div className="row gap">
            <button className="btn ghost" onClick={() => { setPcMsg(''); setPcStep('old'); }}>Change passcode</button>
          </div>
        ) : (
          <div className="pc-change">
            <PasscodePad
              label={pcStep === 'old' ? 'Current passcode' : pcStep === 'new' ? 'New passcode' : 'Confirm new passcode'}
              resetKey={pcReset + (pcStep === 'old' ? 0 : pcStep === 'new' ? 100 : 200)}
              onComplete={async (code) => {
                if (pcStep === 'old') {
                  const cfg = await getSetting(db, 'lock');
                  if (!cfg) return;
                  const r = await verifyPasscode(cfg, code);
                  await setSetting(db, 'lock', r.config);
                  if (r.ok) { setPcMsg(''); setPcStep('new'); } else { setPcMsg(r.reason === 'locked_out' ? 'Too many tries. Wait and try again.' : 'Wrong passcode'); setPcReset((k) => k + 1); }
                } else if (pcStep === 'new') {
                  const p = passcodeProblem(code);
                  if (p) { setPcMsg(p); setPcReset((k) => k + 1); return; }
                  setPcNew(code); setPcMsg(''); setPcStep('confirm');
                } else {
                  if (code !== pcNew) { setPcMsg("Didn't match. Enter the new passcode again."); setPcStep('new'); setPcReset((k) => k + 1); return; }
                  await setSetting(db, 'lock', await createLockConfig(code));
                  setPcStep('idle'); setPcNew('');
                  toast('Passcode changed');
                }
              }}
            />
            {pcMsg && <p className="error center" role="alert">{pcMsg}</p>}
            <button className="btn ghost small" onClick={() => { setPcStep('idle'); setPcNew(''); setPcMsg(''); }}>Cancel</button>
          </div>
        )}
        <p className="hint">
          The passcode stops casual access to this device. It can't protect against someone who controls your unlocked
          computer or browser profile, so keep your device's own screen lock on too.
        </p>
      </div>

      <div className="card">
        <h2>Category rules</h2>
        <p className="muted small">Merchants you've told PocketLedger to always put in a category. They sync (encrypted) to both of you and take priority over built-in suggestions.</p>
        {rules.length === 0 ? (
          <p className="muted">No rules yet. When you correct the same merchant's category twice, the app offers to create one.</p>
        ) : (
          <ul className="plain-list">
            {rules.map((r) => (
              <li key={r.ruleId} className="row between">
                <span>“{r.merchantPattern}” → {categoryById.get(r.categoryId)?.icon} {categoryById.get(r.categoryId)?.name ?? 'Unknown'}</span>
                <button className="btn ghost small danger" onClick={() => repo.deleteMerchantRule(r.ruleId)}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Backups &amp; exports</h2>
        <p className="muted small">Last backup: {lastBackupAt ? formatInstant(lastBackupAt, timezone) : 'never'}.</p>
        <a className="btn ghost" href="#/reports">Open Reports &amp; backup</a>
      </div>

      <div className="card">
        <h2>Storage on this device</h2>
        <p className="muted small">
          {storage.persisted === true && 'Persistent storage is granted: the browser won’t clear this data on its own. '}
          {storage.persisted === false && 'The browser may clear this data if the device runs low on space, or after long inactivity on iPhone/iPad unless the app is installed to the Home Screen. Keep backups. '}
          {storage.usage !== undefined && `Using about ${(storage.usage / 1_048_576).toFixed(1)} MB.`}
        </p>
        <button className="btn danger ghost" onClick={() => setEraseOpen(true)}>Erase all data on this device…</button>
      </div>

      <ConfirmDialog
        open={eraseOpen}
        title="Erase everything on this device?"
        confirmLabel="Erase this device"
        danger
        onCancel={() => setEraseOpen(false)}
        onConfirm={async () => {
          setEraseOpen(false);
          db.close();
          await db.delete();
          window.location.hash = '';
          window.location.reload();
        }}
      >
        <p>This deletes all expenses, categories, settings, the household key and the passcode from this browser. It does not touch Google Drive. To use this device again you'll set it up fresh, restore a backup, or join from Drive with the recovery key.</p>
        {pendingOps > 0 ? (
          <p><strong>{pendingOps} changes exist only on this device.</strong> Sync or download a backup first or they will be lost.</p>
        ) : (
          <p>Download a backup first if you might need this data again.</p>
        )}
      </ConfirmDialog>
    </section>
  );
}
