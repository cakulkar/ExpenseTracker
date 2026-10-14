/**
 * Encrypted, conflict-safe synchronization through Google Drive. No server.
 *
 * Drive layout (folder IDs are discovered at runtime and stored in device settings):
 *   PocketLedger/
 *     household.key.json         household key wrapped by the recovery key (no plaintext key)
 *     HouseholdSync/
 *       ops/        ops-<deviceId>-<seq>.bin     encrypted, append-only, one writer per file
 *       snapshots/  snap-<time>-<deviceId>.bin   encrypted full state for new devices
 *     Receipts/<yyyy>/<mm>/<receiptId>.bin      encrypted receipt images (or .jpg if encryption is off)
 *     Exports/                                   optional encrypted backups
 *
 * Concurrency: each device only ever creates files with its own deviceId in the name and never edits them,
 * so two devices never write the same file and no lock is needed. Every op file is checked by name before
 * upload, so a retry after an interrupted upload never creates a duplicate.
 *
 * Guarantees: each file upload is atomic on Drive. Sync as a whole is eventually consistent — not real-time.
 */
import type { LedgerDb } from '../db/schema';
import { SYNCED_TABLES } from '../db/schema';
import { getSetting, setSetting, type DriveConfig } from '../db/settings';
import type { LedgerRepo } from '../db/repo';
import { FOLDER_MIME, DriveError, q, type DriveApi, type DriveFile } from '../drive/driveApi';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, generateHdk, makeKeyFile, newRecoveryKey, openKeyFile, type KeyFile } from '../crypto/crypto';
import { applyRemoteOps, UnsupportedSchemaError, validateOp } from './merge';
import { syncStatus } from './status';
import { SCHEMA_VERSION, type Receipt, type SyncOperation } from '../domain/types';
import { todayIn } from '../domain/dates';
import { decodeRecoveryKey } from '../crypto/crypto';

export const ROOT_FOLDER = 'PocketLedger';
export const KEY_FILE = 'household.key.json';
export const BATCH_LIMIT = 500;
export const SNAPSHOT_EVERY_OPS = 300;
export const KEEP_OWN_SNAPSHOTS = 2;
const RETRY_SCHEDULE_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];

export function retryDelay(attempts: number): number {
  return RETRY_SCHEDULE_MS[Math.min(Math.max(attempts - 1, 0), RETRY_SCHEDULE_MS.length - 1)]!;
}

const pad = (n: number) => String(n).padStart(8, '0');

interface OpsFile {
  format: 'pocketledger-ops';
  schemaVersion: number;
  householdId: string;
  deviceId: string;
  seq: number;
  ops: SyncOperation[];
}

interface SnapshotFile {
  format: 'pocketledger-snapshot';
  schemaVersion: number;
  householdId: string;
  deviceId: string;
  createdAt: string;
  cursors: Record<string, number>;
  tables: Record<string, unknown[]>;
}

// ---------- Discovery & setup ----------

async function findOrCreateFolder(drive: DriveApi, name: string, parentId: string | 'root'): Promise<string> {
  const found = await drive.list(`name = ${q(name)} and mimeType = '${FOLDER_MIME}' and ${q(parentId)} in parents and trashed = false`);
  if (found[0]) return found[0].id;
  return (await drive.createFolder(name, parentId)).id;
}

export interface DriveHousehold {
  rootId: string;
  keyFileId: string;
  keyFile: KeyFile;
}

/** Look for an existing PocketLedger household in this Google account's Drive (app-created files only). */
export async function findDriveHousehold(drive: DriveApi): Promise<DriveHousehold | null> {
  const roots = await drive.list(`name = ${q(ROOT_FOLDER)} and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`);
  for (const root of roots) {
    const keys = await drive.list(`name = ${q(KEY_FILE)} and ${q(root.id)} in parents and trashed = false`);
    if (keys[0]) {
      const keyFile = JSON.parse(new TextDecoder().decode(await drive.download(keys[0].id))) as KeyFile;
      if (keyFile.format === 'pocketledger-key') return { rootId: root.id, keyFileId: keys[0].id, keyFile };
    }
  }
  return null;
}

async function ensureFolders(drive: DriveApi, rootId: string, keyFileId: string): Promise<DriveConfig> {
  const syncId = await findOrCreateFolder(drive, 'HouseholdSync', rootId);
  const [opsId, snapshotsId, receiptsId, exportsId] = await Promise.all([
    findOrCreateFolder(drive, 'ops', syncId),
    findOrCreateFolder(drive, 'snapshots', syncId),
    findOrCreateFolder(drive, 'Receipts', rootId),
    findOrCreateFolder(drive, 'Exports', rootId),
  ]);
  return { rootId, syncId, opsId, snapshotsId, receiptsId, exportsId, keyFileId, receiptMonthFolders: {} };
}

/**
 * First device: create the Drive folders, a new household key and recovery key.
 * Returns the recovery key text, which must be shown to the user once and never stored.
 */
export async function createDriveHousehold(db: LedgerDb, drive: DriveApi): Promise<{ recoveryKey: string }> {
  const householdId = await getSetting(db, 'householdId');
  if (!householdId) throw new Error('Set up the household on this device first');
  if (await findDriveHousehold(drive)) throw new Error('A PocketLedger household already exists in this Google Drive. Join it with the recovery key instead.');
  const root = await drive.createFolder(ROOT_FOLDER, 'root', { kind: 'pl-root' });
  const { raw, key } = await generateHdk();
  const recovery = newRecoveryKey();
  const keyFile = await makeKeyFile(householdId, raw, recovery.bytes);
  raw.fill(0);
  const kf = await drive.upload({ name: KEY_FILE, parentId: root.id, mimeType: 'application/json', appProperties: { kind: 'pl-key' } }, new TextEncoder().encode(JSON.stringify(keyFile, null, 2)));
  const config = await ensureFolders(drive, root.id, kf.id);
  await setSetting(db, 'householdKey', key);
  await setSetting(db, 'driveConfig', config);
  await setSetting(db, 'syncCursors', {});
  await setSetting(db, 'nextBatchSeq', 1);
  await setSetting(db, 'pendingBatch', null);
  await setSetting(db, 'opsSinceSnapshot', SNAPSHOT_EVERY_OPS); // write a snapshot on first sync
  if ((await getSetting(db, 'encryptReceipts')) === undefined) await setSetting(db, 'encryptReceipts', true);
  return { recoveryKey: recovery.text };
}

/**
 * Unlock an existing Drive household with the recovery key and configure this device.
 * If `replaceLocal`, local ledger data is replaced by the Drive snapshot (the caller must have warned the user).
 */
export async function joinDriveHousehold(db: LedgerDb, drive: DriveApi, recoveryText: string, opts: { replaceLocal: boolean }): Promise<{ householdId: string }> {
  const bytes = decodeRecoveryKey(recoveryText);
  if (!bytes) throw new Error('A recovery key has 32 letters and digits, like ABCD-EFGH-…');
  const hh = await findDriveHousehold(drive);
  if (!hh) throw new Error('No PocketLedger household was found in this Google Drive.');
  const key = await openKeyFile(hh.keyFile, bytes);
  const localHousehold = await getSetting(db, 'householdId');
  if (localHousehold && localHousehold !== hh.keyFile.householdId && !opts.replaceLocal) {
    throw new Error('This device has a different household. Choose to replace this device’s data to join.');
  }
  const config = await ensureFolders(drive, hh.rootId, hh.keyFileId);
  await setSetting(db, 'householdKey', key);
  await setSetting(db, 'driveConfig', config);
  if (localHousehold !== hh.keyFile.householdId) {
    // Fresh start for this household on this device.
    await db.transaction('rw', [...SYNCED_TABLES, 'syncOps', 'appliedOps', 'deferredOps', 'conflicts', 'receiptBlobs', 'deletionAudit', 'settings'].map((t) => db.table(t)), async () => {
      for (const t of [...SYNCED_TABLES, 'syncOps', 'appliedOps', 'deferredOps', 'conflicts', 'receiptBlobs', 'deletionAudit']) await db.table(t).clear();
      await setSetting(db, 'householdId', hh.keyFile.householdId);
      await setSetting(db, 'syncCursors', {});
      await setSetting(db, 'nextBatchSeq', 1);
      await setSetting(db, 'pendingBatch', null);
      await setSetting(db, 'opsSinceSnapshot', 0);
    });
  } else {
    if ((await getSetting(db, 'syncCursors')) === undefined) await setSetting(db, 'syncCursors', {});
    if ((await getSetting(db, 'nextBatchSeq')) === undefined) await setSetting(db, 'nextBatchSeq', await nextFreeSeq(db, drive, config));
    if ((await getSetting(db, 'pendingBatch')) === undefined) await setSetting(db, 'pendingBatch', null);
  }
  if ((await getSetting(db, 'encryptReceipts')) === undefined) await setSetting(db, 'encryptReceipts', true);
  return { householdId: hh.keyFile.householdId };
}

async function nextFreeSeq(db: LedgerDb, drive: DriveApi, config: DriveConfig): Promise<number> {
  const deviceId = (await getSetting(db, 'deviceId'))!;
  const mine = await drive.list(`${q(config.opsId)} in parents and appProperties has { key='deviceId' and value=${q(deviceId)} } and trashed = false`);
  return mine.reduce((m, f) => Math.max(m, Number(f.appProperties?.seq ?? 0)), 0) + 1;
}

// ---------- The engine ----------

export interface SyncResult {
  pushedOps: number;
  pulledOps: number;
  conflicts: number;
  uploadedReceipts: number;
  deletedReceipts: number;
  snapshotWritten: boolean;
}

export class SyncEngine {
  private running: Promise<SyncResult> | null = null;

  constructor(
    private readonly db: LedgerDb,
    private readonly repo: LedgerRepo,
    private readonly drive: DriveApi,
    private readonly timezone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async key(): Promise<CryptoKey> {
    const k = await getSetting(this.db, 'householdKey');
    if (!k) throw new Error('Household key missing on this device');
    return k;
  }

  private async config(): Promise<DriveConfig> {
    const c = await getSetting(this.db, 'driveConfig');
    if (!c) throw new Error('Google Drive is not connected');
    return c;
  }

  /** Run one full sync. Concurrent calls share the same run. */
  sync(): Promise<SyncResult> {
    if (!this.running) {
      this.running = this.syncInner().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async syncInner(): Promise<SyncResult> {
    const result: SyncResult = { pushedOps: 0, pulledOps: 0, conflicts: 0, uploadedReceipts: 0, deletedReceipts: 0, snapshotWritten: false };
    syncStatus.set({ running: true });
    try {
      syncStatus.set({ state: 'uploading' });
      result.pushedOps = await this.push();
      syncStatus.set({ state: 'downloading' });
      const pulled = await this.pull();
      result.pulledOps = pulled.applied;
      result.conflicts = pulled.conflicts;
      syncStatus.set({ state: 'uploading' });
      result.uploadedReceipts = await this.uploadReceipts();
      result.deletedReceipts = await runRetention(this.db, this.repo, this.drive, this.timezone, this.now);
      // Receipt status changes create ops; push them in the same run.
      result.pushedOps += await this.push();
      result.snapshotWritten = await this.maybeSnapshot();
      await this.pruneLocalLog();
      const at = this.now().toISOString();
      await setSetting(this.db, 'lastSyncAt', at);
      const openConflicts = await this.db.conflicts.filter((c) => !c.resolvedAt).count();
      const pending = await this.db.syncOps.where('syncStatus').equals('pending').count();
      syncStatus.set({
        state: openConflicts ? 'conflict' : pending ? 'pending' : 'up_to_date',
        lastSuccessAt: at,
        lastError: undefined,
        message: openConflicts ? `${openConflicts} conflicting edit${openConflicts > 1 ? 's' : ''} to review` : undefined,
      });
      return result;
    } catch (e) {
      const state = e instanceof DriveError ? (e.kind === 'auth' ? 'auth_required' : e.kind === 'quota' ? 'quota' : 'failed') : 'failed';
      const message = e instanceof UnsupportedSchemaError ? e.message : e instanceof Error ? e.message : 'Sync failed';
      syncStatus.set({ state, lastError: message, message });
      throw e;
    } finally {
      syncStatus.set({ running: false });
    }
  }

  // ----- push -----

  async push(): Promise<number> {
    const config = await this.config();
    const key = await this.key();
    const deviceId = this.repo.deviceId;
    const householdId = (await getSetting(this.db, 'householdId'))!;
    let pushed = 0;
    for (;;) {
      let batch = (await getSetting(this.db, 'pendingBatch')) ?? null;
      if (!batch) {
        const pending = await this.db.syncOps.where('syncStatus').equals('pending').toArray();
        if (pending.length === 0) break;
        pending.sort((a, b) => a.recordVersion.localeCompare(b.recordVersion));
        const seq = (await getSetting(this.db, 'nextBatchSeq')) ?? 1;
        batch = { seq, operationIds: pending.slice(0, BATCH_LIMIT).map((o) => o.operationId) };
        await setSetting(this.db, 'pendingBatch', batch);
        await setSetting(this.db, 'nextBatchSeq', seq + 1);
      }
      const ops = (await this.db.syncOps.bulkGet(batch.operationIds)).filter((o): o is SyncOperation => !!o);
      const name = `ops-${deviceId}-${pad(batch.seq)}.bin`;
      const already = await this.drive.list(`name = ${q(name)} and ${q(config.opsId)} in parents and trashed = false`);
      if (already.length === 0) {
        const file: OpsFile = { format: 'pocketledger-ops', schemaVersion: SCHEMA_VERSION, householdId, deviceId, seq: batch.seq, ops: ops.map((o) => ({ ...o, syncStatus: 'synced' as const })) };
        const blob = await encryptJson(key, file, { type: 'ops', id: `${deviceId}:${batch.seq}` });
        await this.drive.upload(
          { name, parentId: config.opsId, mimeType: 'application/octet-stream', appProperties: { kind: 'ops', deviceId, seq: String(batch.seq) } },
          blob,
        );
      }
      await this.db.transaction('rw', this.db.syncOps, this.db.settings, async () => {
        for (const o of ops) await this.db.syncOps.update(o.operationId, { syncStatus: 'synced' });
        await setSetting(this.db, 'pendingBatch', null);
        await setSetting(this.db, 'opsSinceSnapshot', ((await getSetting(this.db, 'opsSinceSnapshot')) ?? 0) + ops.length);
      });
      pushed += ops.length;
    }
    return pushed;
  }

  // ----- pull -----

  async pull(): Promise<{ applied: number; conflicts: number }> {
    const config = await this.config();
    const key = await this.key();
    const deviceId = this.repo.deviceId;
    const householdId = (await getSetting(this.db, 'householdId'))!;
    let cursors = (await getSetting(this.db, 'syncCursors')) ?? {};

    // A device with no cursors and no ledger data starts from the newest snapshot.
    if (Object.keys(cursors).length === 0 && (await this.db.expenses.count()) === 0 && (await this.db.members.count()) === 0) {
      cursors = await this.loadLatestSnapshot(config, key, householdId);
    }

    const files = await this.drive.list(`${q(config.opsId)} in parents and trashed = false`);
    const byDevice = new Map<string, DriveFile[]>();
    for (const f of files) {
      const dev = f.appProperties?.deviceId;
      const seq = Number(f.appProperties?.seq);
      if (!dev || dev === deviceId || !Number.isInteger(seq) || seq <= (cursors[dev] ?? 0)) continue;
      byDevice.set(dev, [...(byDevice.get(dev) ?? []), f]);
    }
    const ops: SyncOperation[] = [];
    const newCursors = { ...cursors };
    for (const [dev, list] of byDevice) {
      list.sort((a, b) => Number(a.appProperties!.seq) - Number(b.appProperties!.seq));
      let expected = (cursors[dev] ?? 0) + 1;
      for (const f of list) {
        const seq = Number(f.appProperties!.seq);
        if (seq !== expected) break; // gap: an earlier file isn't visible yet; continue next sync
        const data = await decryptJson<OpsFile>(key, await this.drive.download(f.id), { type: 'ops', id: `${dev}:${seq}` });
        if (data.format !== 'pocketledger-ops' || data.householdId !== householdId || data.deviceId !== dev || data.seq !== seq) {
          throw new Error('A sync file failed validation. Sync stopped to protect your data.');
        }
        if (data.schemaVersion > SCHEMA_VERSION) throw new UnsupportedSchemaError(data.schemaVersion);
        ops.push(...data.ops.filter(validateOp));
        newCursors[dev] = seq;
        expected++;
      }
    }
    const tables = [...SYNCED_TABLES, 'conflicts', 'appliedOps', 'deferredOps', 'settings'].map((t) => this.db.table(t));
    return this.db.transaction('rw', tables, async () => {
      const r = await applyRemoteOps(this.db, ops, this.repo.clock);
      await setSetting(this.db, 'syncCursors', newCursors);
      await setSetting(this.db, 'hlcState', this.repo.clock.snapshot);
      return { applied: r.applied, conflicts: r.conflicts };
    });
  }

  private async loadLatestSnapshot(config: DriveConfig, key: CryptoKey, householdId: string): Promise<Record<string, number>> {
    const snaps = await this.drive.list(`${q(config.snapshotsId)} in parents and trashed = false`);
    snaps.sort((a, b) => (b.appProperties?.createdAt ?? b.name).localeCompare(a.appProperties?.createdAt ?? a.name));
    for (const s of snaps) {
      const dev = s.appProperties?.deviceId ?? '';
      let snap: SnapshotFile;
      try {
        snap = await decryptJson<SnapshotFile>(key, await this.drive.download(s.id), { type: 'snapshot', id: `${dev}:${s.name}` });
      } catch {
        continue; // damaged snapshot: try an older one, then fall back to replaying all ops
      }
      if (snap.format !== 'pocketledger-snapshot' || snap.householdId !== householdId) continue;
      if (snap.schemaVersion > SCHEMA_VERSION) throw new UnsupportedSchemaError(snap.schemaVersion);
      await this.db.transaction('rw', [...SYNCED_TABLES, 'settings'].map((t) => this.db.table(t)), async () => {
        for (const t of SYNCED_TABLES) {
          await this.db.table(t).clear();
          const rows = snap.tables[t] ?? [];
          if (rows.length) await this.db.table(t).bulkPut(rows);
        }
        await setSetting(this.db, 'syncCursors', snap.cursors);
      });
      return snap.cursors;
    }
    return {};
  }

  // ----- snapshot -----

  async maybeSnapshot(force = false): Promise<boolean> {
    const config = await this.config();
    const since = (await getSetting(this.db, 'opsSinceSnapshot')) ?? 0;
    const pending = await this.db.syncOps.where('syncStatus').equals('pending').count();
    if (pending > 0 || (!force && since < SNAPSHOT_EVERY_OPS)) return false;
    const key = await this.key();
    const deviceId = this.repo.deviceId;
    const householdId = (await getSetting(this.db, 'householdId'))!;
    const cursors = { ...((await getSetting(this.db, 'syncCursors')) ?? {}) };
    cursors[deviceId] = ((await getSetting(this.db, 'nextBatchSeq')) ?? 1) - 1;
    const tables: Record<string, unknown[]> = {};
    await this.db.transaction('r', SYNCED_TABLES.map((t) => this.db.table(t)), async () => {
      for (const t of SYNCED_TABLES) tables[t] = await this.db.table(t).toArray();
    });
    const createdAt = this.now().toISOString();
    const name = `snap-${createdAt.replace(/[:.]/g, '')}-${deviceId}.bin`;
    const snap: SnapshotFile = { format: 'pocketledger-snapshot', schemaVersion: SCHEMA_VERSION, householdId, deviceId, createdAt, cursors, tables };
    const blob = await encryptJson(key, snap, { type: 'snapshot', id: `${deviceId}:${name}` });
    await this.drive.upload({ name, parentId: config.snapshotsId, mimeType: 'application/octet-stream', appProperties: { kind: 'snapshot', deviceId, createdAt } }, blob);
    await setSetting(this.db, 'opsSinceSnapshot', 0);
    // Keep only this device's newest snapshots.
    const mine = (await this.drive.list(`${q(config.snapshotsId)} in parents and appProperties has { key='deviceId' and value=${q(deviceId)} } and trashed = false`))
      .sort((a, b) => (b.appProperties?.createdAt ?? '').localeCompare(a.appProperties?.createdAt ?? ''));
    for (const old of mine.slice(KEEP_OWN_SNAPSHOTS)) await this.drive.remove(old.id);
    return true;
  }

  // ----- receipts -----

  private async receiptFolder(config: DriveConfig, dateIso: string): Promise<string> {
    const ym = `${dateIso.slice(0, 4)}/${dateIso.slice(5, 7)}`;
    const cached = config.receiptMonthFolders[ym];
    if (cached) return cached;
    const yearId = await findOrCreateFolder(this.drive, dateIso.slice(0, 4), config.receiptsId);
    const monthId = await findOrCreateFolder(this.drive, dateIso.slice(5, 7), yearId);
    const next = { ...config, receiptMonthFolders: { ...config.receiptMonthFolders, [ym]: monthId } };
    await setSetting(this.db, 'driveConfig', next);
    return monthId;
  }

  async uploadReceipts(): Promise<number> {
    const now = this.now();
    const due = (await this.db.receipts.toArray()).filter(
      (r) => r.deletionStatus === 'active' && !r.driveFileId && (r.uploadStatus === 'pending' || r.uploadStatus === 'failed' || r.uploadStatus === 'uploading') && (!r.nextUploadAt || r.nextUploadAt <= now.toISOString()),
    );
    let uploaded = 0;
    for (const r of due) {
      const local = await this.db.receiptBlobs.get(r.receiptId);
      if (!local?.original) continue; // captured on another device; that device uploads it
      try {
        await this.uploadOne(r, local.original);
        uploaded++;
      } catch (e) {
        const attempts = r.uploadAttempts + 1;
        await this.repo.updateReceipt(r.receiptId, { uploadStatus: 'failed', uploadAttempts: attempts, nextUploadAt: new Date(now.getTime() + retryDelay(attempts)).toISOString() });
        if (e instanceof DriveError && (e.kind === 'auth' || e.kind === 'quota')) throw e;
      }
    }
    return uploaded;
  }

  private async uploadOne(r: Receipt, original: ArrayBuffer): Promise<void> {
    const config = await this.config();
    const folder = await this.receiptFolder(config, r.transactionDate ?? todayIn(this.timezone, this.now()));
    // Idempotency: an earlier attempt may have uploaded before the app was closed.
    const existing = await this.drive.list(`${q(folder)} in parents and appProperties has { key='receiptId' and value=${q(r.receiptId)} } and trashed = false`);
    let fileId = existing[0]?.id;
    if (!fileId) {
      const bytes = new Uint8Array(original);
      const body = r.encrypted ? await encryptBytes(await this.key(), bytes, { type: 'receipt', id: r.receiptId }) : bytes;
      const f = await this.drive.upload(
        { name: `${r.receiptId}.${r.encrypted ? 'bin' : 'jpg'}`, parentId: folder, mimeType: r.encrypted ? 'application/octet-stream' : r.mimeType, appProperties: { kind: 'receipt', receiptId: r.receiptId } },
        body,
      );
      fileId = f.id;
    }
    await this.repo.updateReceipt(r.receiptId, { driveFileId: fileId, uploadedAt: this.now().toISOString(), uploadStatus: 'uploaded', nextUploadAt: undefined });
    // The original now lives in Drive; keep only the small local thumbnail.
    const local = await this.db.receiptBlobs.get(r.receiptId);
    if (local) await this.db.receiptBlobs.put({ receiptId: r.receiptId, thumbnail: local.thumbnail, mimeType: local.mimeType });
  }

  /** Download (and decrypt) a receipt image from Drive for viewing. */
  async fetchReceiptImage(r: Receipt): Promise<Blob> {
    if (!r.driveFileId) throw new Error('This receipt image is not in Google Drive');
    const bytes = await this.drive.download(r.driveFileId);
    const plain = r.encrypted ? await decryptBytes(await this.key(), bytes, { type: 'receipt', id: r.receiptId }) : bytes;
    return new Blob([plain as BlobPart], { type: r.mimeType });
  }

  /** Upload an already-encrypted backup file to PocketLedger/Exports. */
  async saveBackupToDrive(name: string, bytes: Uint8Array): Promise<void> {
    const config = await this.config();
    await this.drive.upload({ name, parentId: config.exportsId, mimeType: 'application/json', appProperties: { kind: 'backup' } }, bytes);
  }

  /** Keep the local op log bounded: synced ops older than 60 days are no longer needed. */
  private async pruneLocalLog(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - 60 * 86_400_000).toISOString();
    await this.db.syncOps.where('syncStatus').equals('synced').filter((o) => o.createdAt < cutoff).delete();
  }
}

// ---------- Retention manager ----------

/**
 * Deletes receipt images whose retention deadline has passed (or that the user asked to delete).
 * Runs at app start and after every sync. Best effort: nothing runs while every device is closed.
 * The expense record is never touched.
 */
export async function runRetention(db: LedgerDb, repo: LedgerRepo, drive: DriveApi | null, timezone: string, now: () => Date = () => new Date()): Promise<number> {
  const today = todayIn(timezone, now());
  const nowIso = now().toISOString();
  const receipts = await db.receipts.toArray();
  let deleted = 0;
  for (const r of receipts) {
    // Images of receipts deleted on another device must not linger here either.
    if (r.deletionStatus === 'deleted') await db.receiptBlobs.delete(r.receiptId);
    const expired = r.retentionDeadline <= today;
    const requested = r.deletionStatus === 'scheduled' || r.deletionStatus === 'failed' || r.deletionStatus === 'deleting';
    const needsWork = (expired || requested) && (r.deletionStatus !== 'deleted' || !!r.driveFileId);
    if (!needsWork) continue;
    if (r.nextDeletionAt && r.nextDeletionAt > nowIso) continue;

    // Local copies can always go.
    await db.receiptBlobs.delete(r.receiptId);

    if (!r.driveFileId) {
      if (r.uploadStatus === 'uploaded') {
        // Uploaded by another device whose file ID hasn't synced here yet; wait.
        continue;
      }
      await repo.updateReceipt(r.receiptId, { deletionStatus: 'deleted', deletedAt: nowIso, uploadStatus: 'local', nextDeletionAt: undefined });
      await db.deletionAudit.put({ receiptId: r.receiptId, scheduledDeadline: r.retentionDeadline, status: 'not_uploaded', completedAt: nowIso, verified: true, attempts: r.deletionAttempts });
      deleted++;
      continue;
    }
    if (!drive) {
      if (r.deletionStatus === 'active') await repo.updateReceipt(r.receiptId, { deletionStatus: 'scheduled' });
      continue;
    }
    try {
      await repo.updateReceipt(r.receiptId, { deletionStatus: 'deleting' });
      await drive.remove(r.driveFileId);
      const stillThere = await drive.exists(r.driveFileId);
      if (stillThere) throw new Error('Drive still reports the file');
      await repo.updateReceipt(r.receiptId, { deletionStatus: 'deleted', deletedAt: nowIso, driveFileId: undefined, nextDeletionAt: undefined });
      await db.deletionAudit.put({ receiptId: r.receiptId, scheduledDeadline: r.retentionDeadline, status: 'deleted', completedAt: nowIso, verified: true, attempts: r.deletionAttempts + 1 });
      deleted++;
    } catch (e) {
      const attempts = r.deletionAttempts + 1;
      await repo.updateReceipt(r.receiptId, { deletionStatus: 'failed', deletionAttempts: attempts, nextDeletionAt: new Date(now().getTime() + retryDelay(attempts)).toISOString() });
      await db.deletionAudit.put({ receiptId: r.receiptId, scheduledDeadline: r.retentionDeadline, status: 'failed', verified: false, attempts });
      if (e instanceof DriveError && (e.kind === 'auth' || e.kind === 'quota' || e.kind === 'network')) break;
    }
  }
  return deleted;
}

/** User action: delete a receipt image now, keeping the expense. */
export async function requestReceiptDeletion(repo: LedgerRepo, receiptId: string): Promise<void> {
  await repo.updateReceipt(receiptId, { deletionStatus: 'scheduled', nextDeletionAt: undefined });
}

/** User action: retry a failed deletion immediately. */
export async function retryReceiptDeletion(repo: LedgerRepo, receiptId: string): Promise<void> {
  await repo.updateReceipt(receiptId, { nextDeletionAt: undefined, deletionStatus: 'scheduled' });
}

