/** Observable sync status shared by the engine and the UI. */
import { useSyncExternalStore } from 'react';

export type SyncState =
  | 'not_connected'
  | 'up_to_date'
  | 'pending'
  | 'uploading'
  | 'downloading'
  | 'auth_required'
  | 'quota'
  | 'conflict'
  | 'failed'
  | 'locked_key';

export interface SyncStatusValue {
  state: SyncState;
  message?: string;
  running: boolean;
  lastSuccessAt?: string;
  lastError?: string;
}

export const STATE_LABEL: Record<SyncState, string> = {
  not_connected: 'Local only',
  up_to_date: 'Up to date',
  pending: 'Local changes pending',
  uploading: 'Uploading',
  downloading: 'Downloading',
  auth_required: 'Sign-in required',
  quota: 'Drive storage full',
  conflict: 'Conflict needs attention',
  failed: 'Sync failed',
  locked_key: 'Recovery key needed',
};

let value: SyncStatusValue = { state: 'not_connected', running: false };
const listeners = new Set<() => void>();

export const syncStatus = {
  get(): SyncStatusValue {
    return value;
  },
  set(patch: Partial<SyncStatusValue>): void {
    value = { ...value, ...patch };
    for (const l of listeners) l();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useSyncStatus(): SyncStatusValue {
  return useSyncExternalStore(syncStatus.subscribe, syncStatus.get, syncStatus.get);
}
