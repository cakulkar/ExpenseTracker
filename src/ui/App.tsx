import { useCallback, useEffect, useRef, useState } from 'react';
import { getDb } from '../db/schema';
import { loadRepo, type LedgerRepo } from '../db/repo';
import { getSetting } from '../db/settings';
import { AppDataProvider } from './AppContext';
import { Onboarding } from './screens/Onboarding';
import { LockScreen } from './screens/LockScreen';
import { Shell } from './Shell';
import { SyncProvider } from './SyncContext';
import { ToastProvider } from './components/common';

type Phase = { name: 'loading' } | { name: 'onboarding' } | { name: 'locked'; repo: LedgerRepo } | { name: 'ready'; repo: LedgerRepo } | { name: 'error'; message: string };

export function App() {
  const db = getDb();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const hiddenAt = useRef<number | null>(null);

  const boot = useCallback(async () => {
    try {
      const repo = await loadRepo(db);
      if (!repo) return setPhase({ name: 'onboarding' });
      const lock = await getSetting(db, 'lock');
      setPhase(lock ? { name: 'locked', repo } : { name: 'ready', repo });
    } catch {
      setPhase({
        name: 'error',
        message: 'This browser blocked local storage (private browsing can do this). PocketLedger needs local storage to work.',
      });
    }
  }, [db]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const lock = useCallback(() => {
    setPhase((p) => (p.name === 'ready' ? { name: 'locked', repo: p.repo } : p));
  }, []);

  // Auto-lock after the app has been in the background for the configured time.
  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      const since = hiddenAt.current;
      hiddenAt.current = null;
      if (since === null) return;
      const minutes = (await getSetting(db, 'autoLockMinutes')) ?? 5;
      if (Date.now() - since >= minutes * 60_000) lock();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [db, lock]);

  let body;
  switch (phase.name) {
    case 'loading':
      body = <p className="center muted pad-top">Loading…</p>;
      break;
    case 'error':
      body = <p className="center error pad-top" role="alert">{phase.message}</p>;
      break;
    case 'onboarding':
      body = <Onboarding db={db} onDone={() => void boot().then(() => setPhase((p) => (p.name === 'locked' ? { name: 'ready', repo: p.repo } : p)))} />;
      break;
    case 'locked':
      body = <LockScreen db={db} onUnlock={() => setPhase({ name: 'ready', repo: phase.repo })} />;
      break;
    case 'ready':
      body = (
        <AppDataProvider db={db} repo={phase.repo} lock={lock}>
          <SyncProvider>
            <Shell />
          </SyncProvider>
        </AppDataProvider>
      );
  }
  return <ToastProvider>{body}</ToastProvider>;
}
