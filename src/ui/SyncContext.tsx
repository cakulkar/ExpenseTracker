/**
 * Drive connection + sync scheduling for the running app.
 * Sync runs: after unlock, when the app returns to the foreground, when the network comes back, every
 * 5 minutes while open, and a few seconds after local changes. A Web Lock keeps two open tabs from
 * syncing at the same time. Nothing here can run while every device is closed.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from './AppContext';
import { useLiveQuery } from './hooks/useLiveQuery';
import { getSetting } from '../db/settings';
import { googleAuth } from '../drive/auth';
import { HttpDriveApi } from '../drive/driveApi';
import { SyncEngine, runRetention } from '../sync/engine';
import { syncStatus } from '../sync/status';

export interface SyncControl {
  /** Drive folders + household key exist on this device. */
  connected: boolean;
  /** Connected to Drive but the household key is missing (re-enter the recovery key). */
  needsKey: boolean;
  signedIn: boolean;
  configured: boolean;
  engine: SyncEngine | null;
  drive: HttpDriveApi;
  /** Run a sync now. `interactive` may open Google's sign-in popup (call from a click). */
  syncNow: (interactive?: boolean) => Promise<void>;
  signIn: () => Promise<void>;
}

const Ctx = createContext<SyncControl | null>(null);
const AUTO_INTERVAL_MS = 5 * 60_000;
const DEBOUNCE_MS = 4000;

export function SyncProvider({ children }: { children: ReactNode }) {
  const { db, repo, timezone, pendingOps } = useApp();
  const driveConfig = useLiveQuery(() => getSetting(db, 'driveConfig'), [db], undefined);
  const hasKey = useLiveQuery(async () => !!(await getSetting(db, 'householdKey')), [db], false);
  const [signedIn, setSignedIn] = useState(googleAuth.signedIn);
  useEffect(() => googleAuth.subscribe(() => setSignedIn(googleAuth.signedIn)), []);

  const drive = useMemo(() => new HttpDriveApi({ tokens: googleAuth }), []);
  const connected = !!driveConfig && hasKey;
  const engine = useMemo(() => (connected ? new SyncEngine(db, repo, drive, timezone) : null), [connected, db, repo, drive, timezone]);
  const engineRef = useRef(engine);
  engineRef.current = engine;

  const run = useCallback(async () => {
    const e = engineRef.current;
    if (!e) return;
    if (!googleAuth.signedIn) {
      syncStatus.set({ state: 'auth_required', message: 'Sign in to Google to sync' });
      return;
    }
    const go = () => e.sync().then(() => undefined, () => undefined);
    if (navigator.locks?.request) await navigator.locks.request('pocketledger-sync', { ifAvailable: true }, async (lock) => (lock ? go() : undefined));
    else await go();
  }, []);

  const signIn = useCallback(async () => {
    await googleAuth.signIn(true);
  }, []);

  const syncNow = useCallback(
    async (interactive = false) => {
      if (interactive && !googleAuth.signedIn) await googleAuth.signIn(true);
      await run();
    },
    [run],
  );

  // Status when not connected; local retention runs regardless.
  useEffect(() => {
    if (!driveConfig) syncStatus.set({ state: 'not_connected', message: undefined });
    else if (!hasKey) syncStatus.set({ state: 'locked_key', message: 'Enter the household recovery key to resume syncing' });
    void runRetention(db, repo, null, timezone).catch(() => undefined);
  }, [driveConfig, hasKey, db, repo, timezone]);

  // Triggers
  useEffect(() => {
    if (!engine) return;
    void run();
    const onVisible = () => document.visibilityState === 'visible' && void run();
    const onOnline = () => void run();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const t = setInterval(() => void run(), AUTO_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      clearInterval(t);
    };
  }, [engine, run, signedIn]);

  // Debounced sync after local changes
  const lastPending = useRef(pendingOps);
  useEffect(() => {
    if (!engine) return;
    if (pendingOps > lastPending.current) {
      const t = setTimeout(() => void run(), DEBOUNCE_MS);
      lastPending.current = pendingOps;
      return () => clearTimeout(t);
    }
    lastPending.current = pendingOps;
  }, [pendingOps, engine, run]);

  const value = useMemo<SyncControl>(
    () => ({ connected, needsKey: !!driveConfig && !hasKey, signedIn, configured: googleAuth.configured, engine, drive, syncNow, signIn }),
    [connected, driveConfig, hasKey, signedIn, engine, drive, syncNow, signIn],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncControl {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSync outside provider');
  return v;
}
