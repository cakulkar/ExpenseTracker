/**
 * Local backup and restore.
 * - Encrypted backup (recommended): the ledger JSON encrypted with a password you choose
 *   (PBKDF2-SHA-256, 600,000 iterations → AES-GCM-256).
 * - Plain backup: readable JSON; the UI warns before creating one.
 * Device settings (passcode hash, household key, Drive IDs) are never included. Receipt images are not
 * included (they live in Google Drive); receipt metadata and every expense record are.
 *
 * Restoring keeps each record's field versions and queues it for sync, so a restored record that
 * Drive lost is re-uploaded, and records that are older than what's in Drive don't overwrite newer edits.
 */
import { SYNCED_TABLES, ENTITY_TABLES, type LedgerDb } from './schema';
import { getSetting, setSetting } from './settings';
import { ensureDeviceIdentity } from './repo';
import { newId } from '../domain/ids';
import { decryptWithPassword, encryptWithPassword, type PasswordEnvelope } from '../crypto/crypto';
import { SCHEMA_VERSION, type EntityType, type SyncOperation } from '../domain/types';

export const BACKUP_FORMAT = 'pocketledger-backup';

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  encrypted: false;
  schemaVersion: number;
  exportedAt: string;
  householdId: string;
  tables: Record<string, unknown[]>;
}

export async function createBackup(db: LedgerDb): Promise<BackupFile> {
  const householdId = await getSetting(db, 'householdId');
  if (!householdId) throw new Error('Nothing to back up yet');
  const tables: Record<string, unknown[]> = {};
  await db.transaction('r', SYNCED_TABLES.map((t) => db.table(t)), async () => {
    for (const t of SYNCED_TABLES) tables[t] = await db.table(t).toArray();
  });
  return { format: BACKUP_FORMAT, encrypted: false, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), householdId, tables };
}

export async function createEncryptedBackup(db: LedgerDb, password: string): Promise<PasswordEnvelope> {
  return encryptWithPassword(await createBackup(db), password);
}

export function isEncryptedBackup(text: string): boolean {
  try {
    return (JSON.parse(text) as { format?: string }).format === 'pocketledger-encrypted-backup';
  } catch {
    return false;
  }
}

export function validateBackup(data: unknown): BackupFile {
  const b = data as Partial<BackupFile>;
  if (!b || b.format !== BACKUP_FORMAT) throw new Error('This file is not a PocketLedger backup');
  if (typeof b.schemaVersion !== 'number' || b.schemaVersion > SCHEMA_VERSION) {
    throw new Error('This backup was made by a newer version of the app. Update the app first.');
  }
  if (typeof b.householdId !== 'string' || !b.tables) throw new Error('Backup is incomplete');
  for (const t of ['household', 'members', 'expenses', 'categories']) {
    if (!Array.isArray(b.tables[t])) throw new Error(`Backup is missing ${t}`);
  }
  const hh = b.tables.household as Array<{ householdId?: string }>;
  if (hh.length !== 1 || hh[0]?.householdId !== b.householdId) throw new Error('Backup household record is invalid');
  return b as BackupFile;
}

/** Parse a backup file's text. Encrypted backups need the password. */
export async function readBackup(text: string, password?: string): Promise<BackupFile> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not a PocketLedger backup (invalid JSON)');
  }
  if ((data as { format?: string }).format === 'pocketledger-encrypted-backup') {
    if (!password) throw new Error('This backup is encrypted. Enter its password.');
    data = await decryptWithPassword(data as PasswordEnvelope, password);
  }
  return validateBackup(data);
}

/** Synchronous parse for unencrypted backups (kept for callers that already hold JSON text). */
export function parseBackup(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not a PocketLedger backup (invalid JSON)');
  }
  if ((data as { format?: string }).format === 'pocketledger-encrypted-backup') throw new Error('This backup is encrypted. Enter its password.');
  return validateBackup(data);
}

const TABLE_TO_ENTITY = new Map(Object.entries(ENTITY_TABLES).map(([type, v]) => [v.table, { type: type as EntityType, key: v.key }]));

/**
 * Replace all ledger data with the backup. `memberId` picks who uses this device when restoring onto a
 * fresh device. Every restored record is queued for sync (with its original versions).
 */
export async function restoreBackup(db: LedgerDb, backup: BackupFile, opts: { memberId?: string } = {}): Promise<void> {
  const members = backup.tables.members as Array<{ memberId: string }>;
  const deviceId = await ensureDeviceIdentity(db);
  const tables = [...SYNCED_TABLES, 'syncOps', 'settings', 'conflicts', 'appliedOps', 'deferredOps'].map((t) => db.table(t));
  await db.transaction('rw', tables, async () => {
    const now = new Date().toISOString();
    await db.syncOps.clear();
    await db.conflicts.clear();
    await db.deferredOps.clear();
    const ops: SyncOperation[] = [];
    for (const t of SYNCED_TABLES) {
      await db.table(t).clear();
      const rows = (backup.tables[t] ?? []) as Array<Record<string, unknown>>;
      if (rows.length) await db.table(t).bulkAdd(rows);
      const meta = TABLE_TO_ENTITY.get(t)!;
      for (const r of rows) {
        const { recordVersion, fieldVersions, ...payload } = r as { recordVersion: string; fieldVersions: Record<string, string> } & Record<string, unknown>;
        ops.push({
          operationId: newId(),
          entityType: meta.type,
          entityId: String(r[meta.key]),
          operationType: 'create',
          recordVersion,
          baseFieldVersions: {},
          fieldVersions,
          payload,
          createdAt: now,
          deviceId,
          syncStatus: 'pending',
          schemaVersion: SCHEMA_VERSION,
        });
      }
    }
    await db.syncOps.bulkAdd(ops);
    await setSetting(db, 'householdId', backup.householdId);
    const current = await getSetting(db, 'memberId');
    const chosen = opts.memberId ?? current;
    await setSetting(db, 'memberId', chosen && members.some((m) => m.memberId === chosen) ? chosen : members[0]!.memberId);
    await setSetting(db, 'lastBackupAt', backup.exportedAt);
  });
}
