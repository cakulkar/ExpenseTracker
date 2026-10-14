import { afterEach, describe, expect, it } from 'vitest';
import { LedgerDb } from '../../src/db/schema';
import { ensureDeviceIdentity, loadRepo, setupHousehold, type LedgerRepo } from '../../src/db/repo';
import { getSetting, setSetting } from '../../src/db/settings';
import { HttpDriveApi } from '../../src/drive/driveApi';
import { createDriveHousehold, joinDriveHousehold, runRetention, requestReceiptDeletion, SyncEngine } from '../../src/sync/engine';
import { syncStatus } from '../../src/sync/status';
import { encryptJson } from '../../src/crypto/crypto';
import type { ValidExpenseInput } from '../../src/domain/expenseInput';
import type { Expense } from '../../src/domain/types';
import { FakeDrive } from '../support/fakeDrive';

const dbs: LedgerDb[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.delete();
});

let token = 'token-1';
function driveFor(fake: FakeDrive) {
  return new HttpDriveApi({ tokens: { getToken: async () => token, invalidate: () => {} }, fetchFn: fake.fetch, sleep: async () => {} });
}

interface Device {
  db: LedgerDb;
  repo: LedgerRepo;
  engine: SyncEngine;
  now: { t: Date };
}

async function newDb(): Promise<LedgerDb> {
  const db = new LedgerDb(`sync-${crypto.randomUUID()}`);
  dbs.push(db);
  return db;
}

async function device(db: LedgerDb, fake: FakeDrive, now = { t: new Date('2026-10-14T15:00:00Z') }): Promise<Device> {
  const repo = (await loadRepo(db))!;
  return { db, repo, now, engine: new SyncEngine(db, repo, driveFor(fake), 'America/Detroit', () => now.t) };
}

const input = (_repo: LedgerRepo, members: string[], p: Partial<ValidExpenseInput> = {}): ValidExpenseInput => ({
  kind: 'expense', merchantName: 'Kroger', transactionDate: '2026-10-10', totalCents: 4510, categoryId: 'cat-groceries',
  paidByMemberId: members[0]!, expenseType: 'shared', notes: '', ...p,
});

async function twoDevices() {
  token = 'token-1';
  const fake = new FakeDrive();
  const dbA = await newDb();
  await setupHousehold(dbA, { householdName: 'Home', memberNames: ['Chinu', 'Spouse'], thisDeviceMemberIndex: 0 });
  const { recoveryKey } = await createDriveHousehold(dbA, driveFor(fake));
  const A = await device(dbA, fake);
  const members = (await dbA.members.toArray()).sort((a) => (a.role === 'owner' ? -1 : 1)).map((m) => m.memberId);
  await A.repo.createExpense(input(A.repo, members, { merchantName: 'Kroger', notes: 'weekly shop' }));
  await A.engine.sync();

  const dbB = await newDb();
  await ensureDeviceIdentity(dbB);
  await joinDriveHousehold(dbB, driveFor(fake), recoveryKey, { replaceLocal: false });
  await setSetting(dbB, 'memberId', members[1]!);
  const repoB = (await loadRepo(dbB))!;
  const B: Device = { db: dbB, repo: repoB, now: { t: new Date('2026-10-14T15:05:00Z') }, engine: undefined as unknown as SyncEngine };
  B.engine = new SyncEngine(dbB, repoB, driveFor(fake), 'America/Detroit', () => B.now.t);
  await B.engine.sync();
  return { fake, A, B, members, recoveryKey };
}

const only = async (d: Device) => (await d.db.expenses.toArray()) as Expense[];

describe('connecting and joining', () => {
  it('second device joins with the recovery key and receives the ledger', async () => {
    const { B, fake, recoveryKey } = await twoDevices();
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    const list = await only(B);
    expect(list).toHaveLength(1);
    expect(list[0]!.notes).toBe('weekly shop');
    expect(await B.db.members.count()).toBe(2);
    expect(await B.db.categories.count()).toBe(22);
    expect(fake.fileCount((f) => f.name.startsWith('snap-'))).toBeGreaterThanOrEqual(1);
  });

  it('never uploads readable financial data', async () => {
    const { fake, A } = await twoDevices();
    await A.repo.createExpense(input(A.repo, [A.repo.memberId], { merchantName: 'Very Secret Jeweler', notes: 'anniversary ring' }));
    await A.engine.sync();
    for (const bytes of fake.allData()) {
      const text = new TextDecoder('latin1').decode(bytes);
      expect(text).not.toMatch(/Kroger|Secret Jeweler|anniversary|weekly shop|4510/);
    }
  });

  it('rejects a wrong recovery key and a malformed one', async () => {
    const { fake } = await twoDevices();
    const db = await newDb();
    await ensureDeviceIdentity(db);
    await expect(joinDriveHousehold(db, driveFor(fake), 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', { replaceLocal: false })).rejects.toThrow(/doesn't match/);
    await expect(joinDriveHousehold(db, driveFor(fake), 'nope', { replaceLocal: false })).rejects.toThrow(/32 letters/);
  });

  it('refuses to create a second household in the same Drive', async () => {
    const { fake } = await twoDevices();
    const db = await newDb();
    await setupHousehold(db, { householdName: 'x', memberNames: ['a', 'b'], thisDeviceMemberIndex: 0 });
    await expect(createDriveHousehold(db, driveFor(fake))).rejects.toThrow(/already exists/);
  });
});

describe('two-way sync and conflicts', () => {
  it('merges edits to different fields without asking', async () => {
    const { A, B, members } = await twoDevices();
    const [e] = await only(A);
    await A.repo.updateExpense(e!.expenseId, input(A.repo, members, { notes: 'milk and eggs' }));
    const [eb] = await only(B);
    await B.repo.updateExpense(eb!.expenseId, input(B.repo, members, { notes: 'weekly shop', totalCents: 4600 }));
    await A.engine.sync();
    await B.engine.sync();
    await A.engine.sync();
    for (const d of [A, B]) {
      const [x] = await only(d);
      expect(x!.notes).toBe('milk and eggs');
      expect(x!.totalCents).toBe(4600);
      expect(await d.db.conflicts.count()).toBe(0);
    }
  });

  it('detects a conflicting edit, converges, and resolves everywhere', async () => {
    const { A, B, members } = await twoDevices();
    const [e] = await only(A);
    await A.repo.updateExpense(e!.expenseId, input(A.repo, members, { totalCents: 5000, notes: 'weekly shop' }));
    B.now.t = new Date('2026-10-14T15:10:00Z');
    await B.repo.updateExpense(e!.expenseId, input(B.repo, members, { totalCents: 5100, notes: 'weekly shop' }));
    await A.engine.sync();
    await B.engine.sync();
    await A.engine.sync();
    const [a] = await only(A);
    const [b] = await only(B);
    expect(a!.totalCents).toBe(b!.totalCents); // converged, nothing silently diverges
    const ca = await A.db.conflicts.toArray();
    const cb = await B.db.conflicts.toArray();
    expect(ca).toHaveLength(1);
    expect(cb).toHaveLength(1);
    expect(new Set([ca[0]!.keptValue, ca[0]!.otherValue])).toEqual(new Set([5000, 5100])); // the losing value is preserved
    expect(syncStatus.get().state).toBe('conflict');

    // Resolve on A by choosing the other value
    const chosen = ca[0]!.otherValue as number;
    await A.repo.tx(() => A.repo.updateIn('expense', e!.expenseId, { totalCents: chosen }));
    await A.db.conflicts.update(ca[0]!.conflictId, { resolvedAt: new Date().toISOString() });
    await A.engine.sync();
    await B.engine.sync();
    expect((await only(B))[0]!.totalCents).toBe(chosen);
    expect(await B.db.conflicts.filter((c) => !c.resolvedAt).count()).toBe(0);
  });

  it('propagates deletions as tombstones and flags edit-vs-delete', async () => {
    const { A, B, members } = await twoDevices();
    const [e] = await only(A);
    await A.repo.deleteExpense(e!.expenseId);
    await B.repo.updateExpense(e!.expenseId, input(B.repo, members, { notes: 'edited while deleted elsewhere' }));
    await A.engine.sync();
    await B.engine.sync();
    await A.engine.sync();
    for (const d of [A, B]) {
      const [x] = await only(d);
      expect(x!.deletedAt).toBeTruthy();
      expect((await d.db.conflicts.toArray()).some((c) => c.field === '__deleted__')).toBe(true);
    }
    // A plain delete with no concurrent edits never resurrects
    const fresh = await A.repo.createExpense(input(A.repo, members, { merchantName: 'Shell', categoryId: 'cat-fuel' }));
    await A.engine.sync();
    await B.engine.sync();
    await B.repo.deleteExpense(fresh.expenseId);
    await B.engine.sync();
    await A.engine.sync();
    await A.engine.sync();
    expect((await A.db.expenses.get(fresh.expenseId))!.deletedAt).toBeTruthy();
  });

  it('applies the same remote ops only once (idempotent replays)', async () => {
    const { A, B, members } = await twoDevices();
    await A.repo.createExpense(input(A.repo, members, { merchantName: 'Target' }));
    await A.engine.sync();
    await B.engine.sync();
    await setSetting(B.db, 'syncCursors', {}); // force a full replay
    await B.engine.sync();
    expect((await only(B)).filter((e) => e.merchantName === 'Target')).toHaveLength(1);
  });
});

describe('offline, retries and failures', () => {
  it('keeps local entries when Drive is unreachable and syncs them later exactly once', async () => {
    const { A, B, fake, members } = await twoDevices();
    await A.repo.createExpense(input(A.repo, members, { merchantName: 'Offline Cafe' }));
    fake.failNext(503, 'backendError', 5);
    await expect(A.engine.sync()).rejects.toThrow();
    expect((await only(A)).some((e) => e.merchantName === 'Offline Cafe')).toBe(true);
    expect(await A.db.syncOps.where('syncStatus').equals('pending').count()).toBeGreaterThan(0);
    await A.engine.sync();
    await B.engine.sync();
    expect((await only(B)).filter((e) => e.merchantName === 'Offline Cafe')).toHaveLength(1);
  });

  it('does not create a duplicate op file when an upload completed but the app stopped before recording it', async () => {
    const { A, fake, members } = await twoDevices();
    await A.repo.createExpense(input(A.repo, members, { merchantName: 'Interrupted' }));
    await A.engine.push();
    const before = fake.fileCount((f) => f.name.startsWith('ops-'));
    // Simulate the crash: re-mark the last batch as unsent
    const seq = (await getSetting(A.db, 'nextBatchSeq'))! - 1;
    const ids = (await A.db.syncOps.toArray()).filter((o) => o.syncStatus === 'synced').map((o) => o.operationId);
    await setSetting(A.db, 'pendingBatch', { seq, operationIds: ids.slice(-1) });
    await A.engine.push();
    expect(fake.fileCount((f) => f.name.startsWith('ops-'))).toBe(before);
  });

  it('retries rate limits with backoff', async () => {
    const { A, fake, members } = await twoDevices();
    await A.repo.createExpense(input(A.repo, members, { merchantName: 'Retry' }));
    fake.failNext(429, 'rateLimitExceeded', 2);
    await A.engine.sync();
    expect(await A.db.syncOps.where('syncStatus').equals('pending').count()).toBe(0);
  });

  it('reports authentication expiry without losing data, then recovers', async () => {
    const { A, members, fake } = await twoDevices();
    await A.repo.createExpense(input(A.repo, members, { merchantName: 'After expiry' }));
    token = 'expired';
    await expect(A.engine.sync()).rejects.toThrow();
    expect(syncStatus.get().state).toBe('auth_required');
    expect((await only(A)).some((e) => e.merchantName === 'After expiry')).toBe(true);
    token = 'token-1';
    fake.validTokens.add('token-1');
    await A.engine.sync();
    expect(syncStatus.get().state).toBe('up_to_date');
  });

  it('reports a full Drive', async () => {
    const { A, members, fake } = await twoDevices();
    await A.repo.createExpense(input(A.repo, members, { merchantName: 'Quota' }));
    fake.quotaFull = true;
    await expect(A.engine.sync()).rejects.toThrow(/storage is full/);
    expect(syncStatus.get().state).toBe('quota');
  });

  it('stops on tampered sync files and on newer schema versions', async () => {
    const { A, B, fake, members } = await twoDevices();
    await A.repo.createExpense(input(A.repo, members, { merchantName: 'Tamper' }));
    await A.engine.sync();
    const f = [...fake.files.values()].filter((x) => x.name.startsWith('ops-')).sort((a, b) => b.createdTime.localeCompare(a.createdTime))[0]!;
    f.data = f.data.slice();
    f.data[f.data.length - 1] = f.data[f.data.length - 1]! ^ 1;
    await expect(B.engine.sync()).rejects.toThrow(/decrypt/i);

    // A newer-schema file from a third device
    const key = (await getSetting(A.db, 'householdKey'))!;
    const cfg = (await getSetting(A.db, 'driveConfig'))!;
    f.data = new Uint8Array(); // drop the tampered file
    fake.files.delete(f.id);
    const householdId = (await getSetting(A.db, 'householdId'))!;
    const blob = await encryptJson(key, { format: 'pocketledger-ops', schemaVersion: 99, householdId, deviceId: 'dev-new', seq: 1, ops: [] }, { type: 'ops', id: 'dev-new:1' });
    await driveFor(fake).upload({ name: 'ops-dev-new-00000001.bin', parentId: cfg.opsId, mimeType: 'application/octet-stream', appProperties: { kind: 'ops', deviceId: 'dev-new', seq: '1' } }, blob);
    await expect(B.engine.sync()).rejects.toThrow(/newer version/);
  });
});

describe('receipts and retention', () => {
  async function addReceipt(d: Device, members: string[], date = '2026-10-10') {
    const original = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]).buffer;
    const thumb = new Uint8Array([1, 2]).buffer;
    return d.repo.createExpenseFromReceipt(
      {
        expense: input(d.repo, members, { transactionDate: date }),
        provenance: { totalCents: 'extracted' },
        verificationStatus: 'verified',
        lineItems: [{ description: 'Bananas', totalCents: 129, manuallyVerified: false }],
        image: { bytes: original, thumbnail: thumb, mimeType: 'image/jpeg', hash: 'h1' },
        encryptImages: true,
      },
      'America/Detroit',
    );
  }

  it('uploads encrypted receipt images once, keeps only a thumbnail locally, and the other device can view it', async () => {
    const { A, B, fake, members } = await twoDevices();
    const { receipt } = await addReceipt(A, members);
    expect(receipt!.retentionDeadline).toBe('2028-10-10');
    await A.engine.sync();
    await A.engine.sync();
    expect(fake.fileCount((f) => f.appProperties.kind === 'receipt')).toBe(1);
    const r = (await A.db.receipts.get(receipt!.receiptId))!;
    expect(r.uploadStatus).toBe('uploaded');
    const local = await A.db.receiptBlobs.get(r.receiptId);
    expect(local?.original).toBeUndefined();
    expect(local?.thumbnail).toBeTruthy();
    const stored = [...fake.files.values()].find((f) => f.appProperties.kind === 'receipt')!;
    expect([...stored.data.slice(0, 4)]).toEqual([0x50, 0x4c, 0x45, 0x31]); // encrypted envelope, not JPEG
    await B.engine.sync();
    const rb = (await B.db.receipts.get(r.receiptId))!;
    const img = new Uint8Array(await (await B.engine.fetchReceiptImage(rb)).arrayBuffer());
    expect([...img]).toEqual([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]);
    expect((await B.db.lineItems.toArray())[0]!.description).toBe('Bananas');
  });

  it('retries failed receipt uploads with backoff', async () => {
    const { A, fake, members } = await twoDevices();
    const { receipt } = await addReceipt(A, members);
    await A.engine.push();
    fake.failNext(500, 'backendError', 5, /upload/);
    expect(await A.engine.uploadReceipts()).toBe(0);
    const r = (await A.db.receipts.get(receipt!.receiptId))!;
    expect(r.uploadStatus).toBe('failed');
    expect(r.nextUploadAt).toBeTruthy();
    A.now.t = new Date(A.now.t.getTime() + 2 * 60_000);
    await A.engine.sync();
    expect((await A.db.receipts.get(receipt!.receiptId))!.uploadStatus).toBe('uploaded');
  });

  it('deletes the Drive image two years after the purchase date but keeps the expense', async () => {
    const { A, B, fake, members } = await twoDevices();
    const { receipt, expense } = await addReceipt(A, members, '2026-10-10');
    await A.engine.sync();
    expect(fake.fileCount((f) => f.appProperties.kind === 'receipt')).toBe(1);
    A.now.t = new Date('2028-10-09T16:00:00Z'); // one day before the deadline (Detroit time)
    await A.engine.sync();
    expect(fake.fileCount((f) => f.appProperties.kind === 'receipt')).toBe(1);
    A.now.t = new Date('2028-10-10T16:00:00Z');
    fake.failNext(500, 'backendError', 5, /^DELETE/);
    await A.engine.sync();
    expect((await A.db.receipts.get(receipt!.receiptId))!.deletionStatus).toBe('failed');
    expect((await A.db.deletionAudit.get(receipt!.receiptId))!.status).toBe('failed');
    A.now.t = new Date('2028-10-10T16:05:00Z');
    await A.engine.sync();
    const r = (await A.db.receipts.get(receipt!.receiptId))!;
    expect(r.deletionStatus).toBe('deleted');
    expect(r.driveFileId).toBeUndefined();
    expect(fake.fileCount((f) => f.appProperties.kind === 'receipt')).toBe(0);
    expect(await A.db.receiptBlobs.get(r.receiptId)).toBeUndefined();
    const audit = (await A.db.deletionAudit.get(r.receiptId))!;
    expect(audit).toMatchObject({ status: 'deleted', verified: true, scheduledDeadline: '2028-10-10' });
    expect(Object.keys(audit).sort()).toEqual(['attempts', 'completedAt', 'receiptId', 'scheduledDeadline', 'status', 'verified']);
    expect((await A.db.expenses.get(expense.expenseId))!.totalCents).toBe(4510);
    await B.engine.sync();
    expect((await B.db.receipts.get(r.receiptId))!.deletionStatus).toBe('deleted');
  });

  it('queues deletion while offline and removes local copies', async () => {
    const { A, members } = await twoDevices();
    const { receipt } = await addReceipt(A, members, '2024-01-15');
    // Never uploaded, expired: local image goes, record marked deleted (no Drive needed)
    const n = await runRetention(A.db, A.repo, null, 'America/Detroit', () => new Date('2026-10-14T12:00:00Z'));
    expect(n).toBe(1);
    expect(await A.db.receiptBlobs.get(receipt!.receiptId)).toBeUndefined();
    expect((await A.db.deletionAudit.get(receipt!.receiptId))!.status).toBe('not_uploaded');
  });

  it('manual delete removes the image now and keeps the expense', async () => {
    const { A, fake, members } = await twoDevices();
    const { receipt, expense } = await addReceipt(A, members);
    await A.engine.sync();
    await requestReceiptDeletion(A.repo, receipt!.receiptId);
    await A.engine.sync();
    expect(fake.fileCount((f) => f.appProperties.kind === 'receipt')).toBe(0);
    expect((await A.db.expenses.get(expense.expenseId))!.deletedAt).toBeUndefined();
  });
});

describe('restart recovery', () => {
  it('keeps data, pending changes and the (non-extractable) household key across a restart', async () => {
    const { A, members } = await twoDevices();
    await A.repo.createExpense(input(A.repo, members, { merchantName: 'Before restart' }));
    const name = A.db.name;
    A.db.close();
    const reopened = new LedgerDb(name);
    dbs.push(reopened);
    await reopened.open();
    expect((await reopened.expenses.toArray()).some((e) => e.merchantName === 'Before restart')).toBe(true);
    expect(await reopened.syncOps.where('syncStatus').equals('pending').count()).toBeGreaterThan(0);
    const key = await getSetting(reopened, 'householdKey');
    expect(key).toBeTruthy();
    expect((key as CryptoKey).extractable).toBe(false);
  });
});
