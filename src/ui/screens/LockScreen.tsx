import { useEffect, useState } from 'react';
import type { LedgerDb } from '../../db/schema';
import { getSetting, setSetting } from '../../db/settings';
import { verifyPasscode } from '../../lock/passcode';
import { PasscodePad } from '../components/PasscodePad';

export function LockScreen({ db, onUnlock }: { db: LedgerDb; onUnlock: () => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void getSetting(db, 'lock').then((c) => setLockedUntil(c?.lockedUntil ?? 0));
  }, [db]);

  useEffect(() => {
    if (lockedUntil <= now) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lockedUntil, now]);

  const waiting = lockedUntil > now;

  const submit = async (code: string) => {
    setBusy(true);
    const cfg = await getSetting(db, 'lock');
    if (!cfg) {
      onUnlock();
      return;
    }
    const r = await verifyPasscode(cfg, code);
    await setSetting(db, 'lock', r.config);
    setBusy(false);
    if (r.ok) {
      onUnlock();
      return;
    }
    setResetKey((k) => k + 1);
    setNow(Date.now());
    setLockedUntil(r.lockedUntil);
    if (r.reason === 'wrong') {
      setMessage(r.remainingFree > 0 ? `Wrong passcode. ${r.remainingFree} tries before a short wait.` : 'Wrong passcode.');
    }
  };

  return (
    <main className="onboard" aria-labelledby="lock-title">
      <div className="onboard-card narrow">
        <p className="brand">PocketLedger</p>
        <h1 id="lock-title" className="center">Enter passcode</h1>
        <PasscodePad label="Passcode" onComplete={(c) => void submit(c)} disabled={busy || waiting} resetKey={resetKey} />
        {waiting && (
          <p className="error center" role="alert">Too many tries. Try again in {Math.ceil((lockedUntil - now) / 1000)} s.</p>
        )}
        {!waiting && message && <p className="error center" role="alert">{message}</p>}
        <details className="muted small">
          <summary>Forgot your passcode?</summary>
          <p>
            The passcode can't be recovered. Clear this site's data in your browser settings, then set the app up again.
            Restore from a backup file, or (once Drive sync is on) from Drive with your household recovery key.
            Changes that never left this device would be lost.
          </p>
        </details>
      </div>
    </main>
  );
}
