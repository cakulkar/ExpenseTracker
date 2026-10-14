import { useState } from 'react';
import type { LedgerDb } from '../../db/schema';
import { ensureDeviceIdentity, LedgerRepo, setupHousehold } from '../../db/repo';
import { getSetting, setSetting } from '../../db/settings';
import { isEncryptedBackup, readBackup, restoreBackup, type BackupFile } from '../../db/backup';
import { googleAuth } from '../../drive/auth';
import { HttpDriveApi } from '../../drive/driveApi';
import { joinDriveHousehold, SyncEngine } from '../../sync/engine';
import { HybridClock } from '../../sync/hlc';
import type { HouseholdMember } from '../../domain/types';
import { createLockConfig, passcodeProblem } from '../../lock/passcode';
import { PasscodePad } from '../components/PasscodePad';
import { Field } from '../components/common';

type Step = 'welcome' | 'household' | 'restore' | 'join' | 'join-member' | 'passcode' | 'confirm';

export function Onboarding({ db, onDone }: { db: LedgerDb; onDone: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [householdName, setHouseholdName] = useState('Our household');
  const [names, setNames] = useState<[string, string]>(['', '']);
  const [me, setMe] = useState<0 | 1>(0);
  const [backup, setBackup] = useState<BackupFile | null>(null);
  const [backupMember, setBackupMember] = useState('');
  const [firstCode, setFirstCode] = useState('');
  const [error, setError] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [backupText, setBackupText] = useState<string | null>(null);
  const [backupPw, setBackupPw] = useState('');
  const [recovery, setRecovery] = useState('');
  const [joined, setJoined] = useState<HouseholdMember[] | null>(null);
  const [joinMember, setJoinMember] = useState('');

  const finish = async (code: string) => {
    setBusy(true);
    try {
      if (joined) {
        await setSetting(db, 'memberId', joinMember);
      } else if (backup) {
        await restoreBackup(db, backup, { memberId: backupMember || undefined });
      } else {
        await setupHousehold(db, { householdName, memberNames: names, thisDeviceMemberIndex: me });
      }
      await setSetting(db, 'lock', await createLockConfig(code));
      if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed');
      setBusy(false);
    }
  };

  return (
    <main className="onboard" aria-labelledby="ob-title">
      <div className="onboard-card">
        <p className="brand">PocketLedger</p>

        {step === 'welcome' && (
          <>
            <h1 id="ob-title">Your household ledger, private by design</h1>
            <ol className="explain">
              <li><strong>Stored on this device.</strong> Every expense is saved here first, so the app works offline. Nothing waits on the internet.</li>
              <li><strong>Google Drive.</strong> When you connect the household Google account, Drive holds receipt images and an <em>encrypted</em> copy of your ledger so both of you stay in sync. The app can only see files it created.</li>
              <li><strong>Sharing.</strong> The first person sets up the household and connects Drive; the second chooses “Join our household” and enters the recovery key. Each device says who uses it, so you see who entered and who paid.</li>
              <li><strong>Recovery key.</strong> Connecting Drive creates a long household recovery key. It unlocks the shared data on a new device — Google sign-in alone can't. Keep it somewhere safe; it can't be reset.</li>
              <li><strong>Receipts expire.</strong> Receipt images are deleted from Drive two years after the purchase date. The expense record stays.</li>
              <li><strong>Your data is yours.</strong> Export or back up your records any time from Settings.</li>
            </ol>
            <p className="muted">There are no bank connections, no ads, no analytics, and no AI services.</p>
            <div className="row gap wrap">
              <button className="btn primary" onClick={() => setStep('household')}>Set up a new household</button>
              <button className="btn ghost" onClick={() => setStep('join')}>Join our household from Google Drive</button>
              <button className="btn ghost" onClick={() => setStep('restore')}>Restore from a backup file</button>
            </div>
          </>
        )}

        {step === 'household' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!names[0].trim() || !names[1].trim()) {
                setError('Enter both names');
                return;
              }
              setError('');
              setStep('passcode');
            }}
          >
            <h1 id="ob-title">Your household</h1>
            <Field id="hh-name" label="Household name">
              <input id="hh-name" value={householdName} maxLength={60} onChange={(e) => setHouseholdName(e.target.value)} />
            </Field>
            <div className="grid2">
              {[0, 1].map((i) => (
                <Field key={i} id={`m${i}`} label={i === 0 ? 'First person' : 'Second person'}>
                  <input
                    id={`m${i}`}
                    value={names[i]}
                    maxLength={40}
                    autoComplete="off"
                    placeholder={i === 0 ? 'e.g. Alex' : 'e.g. Sam'}
                    onChange={(e) => setNames((n) => (i === 0 ? [e.target.value, n[1]] : [n[0], e.target.value]))}
                  />
                </Field>
              ))}
            </div>
            <fieldset className="field">
              <legend>Who uses this device?</legend>
              <div className="seg">
                {[0, 1].map((i) => (
                  <label key={i} className={me === i ? 'on' : ''}>
                    <input type="radio" name="me" checked={me === i} onChange={() => setMe(i as 0 | 1)} />
                    {names[i]?.trim() || (i === 0 ? 'First person' : 'Second person')}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="hint">Only first names are needed. Nothing else about you is stored.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="row gap">
              <button type="button" className="btn ghost" onClick={() => setStep('welcome')}>Back</button>
              <button type="submit" className="btn primary">Continue</button>
            </div>
          </form>
        )}

        {step === 'restore' && (
          <div>
            <h1 id="ob-title">Restore from backup</h1>
            <Field id="bk" label="Backup file (.json)">
              <input
                id="bk"
                type="file"
                accept="application/json,.json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const text = await f.text();
                  setBackup(null);
                  setError('');
                  if (isEncryptedBackup(text)) {
                    setBackupText(text);
                    return;
                  }
                  try {
                    const b = await readBackup(text);
                    setBackup(b);
                    setBackupMember((b.tables.members as Array<{ memberId: string }>)[0]?.memberId ?? '');
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not read the file');
                  }
                }}
              />
            </Field>
            {backupText && !backup && (
              <div className="row gap wrap">
                <Field id="bk-pw" label="Backup password">
                  <input id="bk-pw" type="password" value={backupPw} onChange={(e) => setBackupPw(e.target.value)} />
                </Field>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const b = await readBackup(backupText, backupPw);
                      setBackup(b);
                      setBackupMember((b.tables.members as Array<{ memberId: string }>)[0]?.memberId ?? '');
                      setError('');
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Could not open the backup');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Unlock backup
                </button>
              </div>
            )}
            {backup && (
              <>
                <p className="muted">
                  Backup from {new Date(backup.exportedAt).toLocaleString()} · {(backup.tables.expenses as unknown[]).length} expense records.
                </p>
                <Field id="bk-me" label="Who uses this device?">
                  <select id="bk-me" value={backupMember} onChange={(e) => setBackupMember(e.target.value)}>
                    {(backup.tables.members as Array<{ memberId: string; displayName: string }>).map((m) => (
                      <option key={m.memberId} value={m.memberId}>{m.displayName}</option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <div className="row gap">
              <button className="btn ghost" onClick={() => { setBackup(null); setError(''); setStep('welcome'); }}>Back</button>
              <button className="btn primary" disabled={!backup} onClick={() => setStep('passcode')}>Continue</button>
            </div>
          </div>
        )}

        {step === 'join' && (
          <div>
            <h1 id="ob-title">Join your household</h1>
            {!googleAuth.configured ? (
              <p className="error">This copy of the app has no Google Client ID, so it can't connect to Drive. Use a backup file instead.</p>
            ) : (
              <>
                <ol className="explain">
                  <li>Sign in with the <strong>shared household Google account</strong>.</li>
                  <li>Enter the <strong>recovery key</strong> shown when the household connected Drive.</li>
                </ol>
                <Field id="join-key" label="Household recovery key">
                  <input id="join-key" value={recovery} autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" onChange={(e) => setRecovery(e.target.value)} />
                </Field>
              </>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <div className="row gap">
              <button className="btn ghost" onClick={() => { setError(''); setStep('welcome'); }}>Back</button>
              <button
                className="btn primary"
                disabled={busy || !googleAuth.configured || recovery.replace(/[\s-]/g, '').length < 32}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    if (!googleAuth.signedIn) await googleAuth.signIn(true);
                    const drive = new HttpDriveApi({ tokens: googleAuth });
                    const deviceId = await ensureDeviceIdentity(db);
                    const { householdId } = await joinDriveHousehold(db, drive, recovery, { replaceLocal: true });
                    const repo = new LedgerRepo({ db, deviceId, householdId, memberId: '', clock: new HybridClock(deviceId, await getSetting(db, 'hlcState')) });
                    await new SyncEngine(db, repo, drive, 'America/Detroit').sync();
                    const ms = (await db.members.toArray()).filter((m) => m.status === 'active');
                    if (!ms.length) throw new Error('No household data was found in Drive yet. Ask your spouse to open the app and sync first.');
                    setJoined(ms);
                    setJoinMember(ms[ms.length - 1]!.memberId);
                    setStep('join-member');
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Could not join');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Connecting…' : 'Sign in and join'}
              </button>
            </div>
          </div>
        )}

        {step === 'join-member' && joined && (
          <div>
            <h1 id="ob-title">Who uses this device?</h1>
            <div className="seg">
              {joined.map((m) => (
                <label key={m.memberId} className={joinMember === m.memberId ? 'on' : ''}>
                  <input type="radio" name="jm" checked={joinMember === m.memberId} onChange={() => setJoinMember(m.memberId)} />
                  {m.displayName}
                </label>
              ))}
            </div>
            <button className="btn primary" onClick={() => setStep('passcode')}>Continue</button>
          </div>
        )}

        {step === 'passcode' && (
          <div>
            <h1 id="ob-title">Create a 6-digit passcode</h1>
            <p className="muted">
              You'll enter this to open PocketLedger on this device. Each device has its own passcode. It keeps
              casual eyes out of an unlocked phone or laptop; it isn't the key that encrypts your shared data.
            </p>
            <PasscodePad
              label="New passcode"
              resetKey={resetKey}
              onComplete={(code) => {
                const p = passcodeProblem(code);
                if (p) {
                  setError(p);
                  setResetKey((k) => k + 1);
                  return;
                }
                setError('');
                setFirstCode(code);
                setStep('confirm');
              }}
            />
            {error && <p className="error center" role="alert">{error}</p>}
            <button className="btn ghost" onClick={() => setStep(joined ? 'join-member' : backup ? 'restore' : 'household')}>Back</button>
          </div>
        )}

        {step === 'confirm' && (
          <div>
            <h1 id="ob-title">Enter it again</h1>
            <PasscodePad
              label="Confirm passcode"
              resetKey={resetKey}
              disabled={busy}
              onComplete={(code) => {
                if (code !== firstCode) {
                  setError("Passcodes didn't match. Start again.");
                  setFirstCode('');
                  setResetKey((k) => k + 1);
                  setStep('passcode');
                  return;
                }
                void finish(code);
              }}
            />
            {busy && <p className="muted center">Setting up…</p>}
            {error && <p className="error center" role="alert">{error}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
