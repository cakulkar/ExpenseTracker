/** Typed access to device-local settings. These never leave the device. */
import type { LedgerDb } from './schema';
import type { HlcState } from '../sync/hlc';
import type { LockConfig } from '../lock/passcode';

export interface DriveConfig {
  rootId: string;
  syncId: string;
  opsId: string;
  snapshotsId: string;
  receiptsId: string;
  exportsId: string;
  keyFileId: string;
  /** "2026/10" → folder id */
  receiptMonthFolders: Record<string, string>;
}

export interface PendingBatch {
  seq: number;
  operationIds: string[];
}

export interface DeviceSettings {
  deviceId: string;
  householdId: string;
  /** Which household member uses this device ("I am …"). */
  memberId: string;
  hlcState: HlcState;
  lock: LockConfig | null;
  autoLockMinutes: number;
  lastBackupAt: string | null;
  lastSyncAt: string | null;
  /** Household data key: a NON-EXTRACTABLE CryptoKey (structured-cloned into IndexedDB). */
  householdKey: CryptoKey;
  /** Drive folder/file IDs discovered at runtime. */
  driveConfig: DriveConfig;
  /** Next op-batch sequence number for this device. */
  nextBatchSeq: number;
  /** Batch currently being uploaded (so retries re-send the same file). */
  pendingBatch: PendingBatch | null;
  /** Highest batch seq applied per remote device. */
  syncCursors: Record<string, number>;
  /** Number of local ops pushed since the last snapshot this device wrote. */
  opsSinceSnapshot: number;
  /** Encrypt receipt images before upload (default true). */
  encryptReceipts: boolean;
  /** Budget alerts already shown: "budgetId|YYYY-MM|80" */
  budgetAlertsShown: string[];
  /** Category corrections per merchant: { "kroger": { "cat-x": 2 } } */
  categoryCorrections: Record<string, Record<string, number>>;
  /** Merchants the user declined to make a rule for. */
  ruleOffersDeclined: string[];
}

export type SettingKey = keyof DeviceSettings;

export async function getSetting<K extends SettingKey>(db: LedgerDb, key: K): Promise<DeviceSettings[K] | undefined> {
  const row = await db.settings.get(key);
  return row?.value as DeviceSettings[K] | undefined;
}

export async function setSetting<K extends SettingKey>(db: LedgerDb, key: K, value: DeviceSettings[K]): Promise<void> {
  await db.settings.put({ key, value });
}

export async function deleteSetting(db: LedgerDb, key: SettingKey): Promise<void> {
  await db.settings.delete(key);
}
