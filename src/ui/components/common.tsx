import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatInstant } from '../../domain/dates';
import { useApp } from '../AppContext';
import { STATE_LABEL, useSyncStatus } from '../../sync/status';

// ---------- Confirm dialog (native <dialog>: focus trap + Esc handled by the browser) ----------

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => { e.preventDefault(); props.onCancel(); }} aria-labelledby="dlg-title">
      <h2 id="dlg-title">{props.title}</h2>
      <div className="dialog-body">{props.children}</div>
      <div className="row end gap">
        <button type="button" className="btn ghost" onClick={props.onCancel}>Cancel</button>
        <button type="button" className={`btn ${props.danger ? 'danger' : 'primary'}`} onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

// ---------- Toasts announced to screen readers ----------

type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }].slice(-3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------- Form field ----------

export function Field(props: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className={`field ${props.error ? 'has-error' : ''}`}>
      <label htmlFor={props.id}>{props.label}</label>
      {props.children}
      {props.hint && !props.error && <p className="hint" id={`${props.id}-hint`}>{props.hint}</p>}
      {props.error && <p className="error" id={`${props.id}-err`} role="alert">{props.error}</p>}
    </div>
  );
}

// ---------- Online + sync status ----------

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Sync indicator: one of the eight sync states plus the last successful sync time. */
export function SyncStatus() {
  const { pendingOps, lastSyncAt, timezone, openConflicts } = useApp();
  const st = useSyncStatus();
  const online = useOnline();
  let state = st.state;
  if (state === 'up_to_date' && pendingOps > 0) state = 'pending';
  if (openConflicts > 0 && (state === 'up_to_date' || state === 'pending')) state = 'conflict';
  const tone = state === 'up_to_date' ? 'ok' : state === 'failed' || state === 'quota' || state === 'conflict' || state === 'auth_required' || state === 'locked_key' ? 'bad' : 'warn';
  const label = st.running ? (state === 'downloading' ? 'Downloading…' : 'Syncing…') : STATE_LABEL[state];
  return (
    <a className="sync" href="#/sync" aria-live="polite" title={st.message ?? undefined}>
      <span className={`dot ${tone} ${st.running ? 'pulse' : ''}`} aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        {pendingOps > 0 && ` · ${pendingOps} change${pendingOps === 1 ? '' : 's'} waiting`}
        {!online && ' · Offline'}
      </span>
      <span className="muted small">Last sync: {lastSyncAt ? formatInstant(lastSyncAt, timezone) : state === 'not_connected' ? 'Drive not connected' : 'never'}</span>
    </a>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}
