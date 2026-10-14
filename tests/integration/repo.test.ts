import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerDb } from '../../src/db/schema';
import { loadRepo, setupHousehold, type LedgerRepo } from '../../src/db/repo';
import { createBackup, parseBackup, restoreBackup } from '../../src/db/backup';
import { getSetting } from '../../src/db/settings';
import type { ValidExpenseInput } from '../../src/domain/expenseInput';

let db: LedgerDb;
let repo: LedgerRepo;
let members: string[];

const input = (p: Partial<ValidExpenseInput> = {}): ValidExpenseInput => ({
  kind: 'expense', merchantName: 'Kroger #512', transactionDate: '2026-10-14', totalCents: 4510,
  categoryId: 'cat-groceries', paidByMemberId: members[0]!, expenseType: 'shared', notes: '', ...p,
});

beforeEach(async () => {
  db = new LedgerDb(`test-${crypto.randomUUID()}`);
  await setupHousehold(db, { householdName: 'Home', memberNames: ['A', 'B'], thisDeviceMemberIndex: 1 });
  repo = (await loadRepo(db))!;
  members = (await db.members.toArray()).sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0)).map((m) => m.memberId);
});
afterEach(async () => {
  await db.delete();
});

describe('household setup', () => {
  it('creates members, 22 default categories and device identity', async () => {
    expect(await db.members.count()).toBe(2);
    expect(await db.categories.count()).toBe(22);
    expect(await getSetting(db, 'memberId')).toBe(members[1]);
    await expect(setupHousehold(db, { householdName: 'x', memberNames: ['a', 'b'], thisDeviceMemberIndex: 0 })).rejects.toThrow();
  });
});

describe('expense CRUD with sync operations', () => {
  it('creates an expense locally and queues a create op', async () => {
    const e = await repo.createExpense(input());
    expect(e.merchantNormalized).toBe('kroger');
    expect(e.createdByMemberId).toBe(members[1]);
    const ops = await db.syncOps.where('entityId').equals(e.expenseId).toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.operationType).toBe('create');
    expect(ops[0]!.syncStatus).toBe('pending');
  });

  it('records only changed fields with their base versions', async () => {
    const e = await repo.createExpense(input());
    const updated = await repo.updateExpense(e.expenseId, input({ totalCents: 4600, notes: 'milk' }));
    expect(updated.totalCents).toBe(4600);
    expect(updated.fieldVersions.totalCents).not.toBe(e.fieldVersions.totalCents);
    expect(updated.fieldVersions.merchantName).toBe(e.fieldVersions.merchantName);
    const op = (await db.syncOps.where('entityId').equals(e.expenseId).toArray()).find((o) => o.operationType === 'update')!;
    expect(Object.keys(op.payload).sort()).toEqual(['notes', 'totalCents', 'updatedAt']);
    expect(op.baseFieldVersions.totalCents).toBe(e.fieldVersions.totalCents);
  });

  it('does not record an op when nothing changed', async () => {
    const e = await repo.createExpense(input());
    await repo.updateExpense(e.expenseId, input());
    expect(await db.syncOps.where('entityId').equals(e.expenseId).count()).toBe(1);
  });

  it('removes optional fields when cleared', async () => {
    const e = await repo.createExpense(input({ taxCents: 300 }));
    const u = await repo.updateExpense(e.expenseId, input());
    expect(u.taxCents).toBeUndefined();
  });

  it('soft-deletes with a tombstone and restores', async () => {
    const e = await repo.createExpense(input());
    await repo.deleteExpense(e.expenseId);
    const deleted = (await db.expenses.get(e.expenseId))!;
    expect(deleted.deletedAt).toBeTruthy();
    await expect(repo.updateExpense(e.expenseId, input({ totalCents: 1 }))).rejects.toThrow(/Restore/);
    await repo.restoreExpense(e.expenseId);
    expect((await db.expenses.get(e.expenseId))!.deletedAt).toBeUndefined();
    const types = (await db.syncOps.where('entityId').equals(e.expenseId).toArray()).map((o) => o.operationType).sort();
    expect(types).toEqual(['create', 'delete', 'restore']);
  });

  it('persists the clock so versions keep increasing after a restart', async () => {
    const a = await repo.createExpense(input());
    const repo2 = (await loadRepo(db))!; // simulates reopening the app
    const b = await repo2.createExpense(input());
    expect(b.recordVersion > a.recordVersion).toBe(true);
  });

  it('saves refunds as positive amounts with kind=refund', async () => {
    const r = await repo.createExpense(input({ kind: 'refund', totalCents: 1299 }));
    expect(r.totalCents).toBe(1299);
    expect(r.kind).toBe('refund');
  });
});

describe('categories', () => {
  it('creates subcategories one level deep and rejects duplicates', async () => {
    const sub = await repo.createCategory('Costco', { parentCategoryId: 'cat-groceries' });
    expect(sub.parentCategoryId).toBe('cat-groceries');
    await expect(repo.createCategory('Bulk', { parentCategoryId: sub.categoryId })).rejects.toThrow(/one level/);
    await expect(repo.createCategory('groceries')).rejects.toThrow(/exists/);
    await repo.updateCategory(sub.categoryId, { isArchived: true });
    expect((await db.categories.get(sub.categoryId))!.isArchived).toBe(true);
  });
});

describe('local backup and restore', () => {
  it('round-trips all records onto a fresh device', async () => {
    await repo.createExpense(input());
    await repo.createExpense(input({ merchantName: 'Shell', categoryId: 'cat-fuel' }));
    const backup = await createBackup(db);
    const text = JSON.stringify(backup);
    expect(text).not.toContain('hashB64');

    const fresh = new LedgerDb(`test-${crypto.randomUUID()}`);
    await restoreBackup(fresh, parseBackup(text), { memberId: members[0] });
    expect(await fresh.expenses.count()).toBe(2);
    expect(await fresh.categories.count()).toBe(22);
    expect(await getSetting(fresh, 'memberId')).toBe(members[0]);
    expect(await getSetting(fresh, 'deviceId')).not.toBe(await getSetting(db, 'deviceId'));
    const r = (await loadRepo(fresh))!;
    await r.createExpense(input());
    expect(await fresh.expenses.count()).toBe(3);
    await fresh.delete();
  });

  it('rejects files that are not backups or are from a newer schema', () => {
    expect(() => parseBackup('nope')).toThrow(/not a PocketLedger/);
    expect(() => parseBackup(JSON.stringify({ format: 'other' }))).toThrow(/not a PocketLedger/);
    expect(() => parseBackup(JSON.stringify({ format: 'pocketledger-backup', schemaVersion: 999 }))).toThrow(/newer/);
  });
});

describe('encrypted backup', () => {
  it('round-trips with the right password and queues restored records for sync', async () => {
    const { createEncryptedBackup, readBackup, restoreBackup } = await import('../../src/db/backup');
    await repo.createExpense(input({ merchantName: 'Encrypted Shop' }));
    const env = await createEncryptedBackup(db, 'a long backup password');
    const text = JSON.stringify(env);
    expect(text).not.toContain('Encrypted Shop');
    await expect(readBackup(text, 'wrong password!!')).rejects.toThrow(/Wrong password/);
    await expect(readBackup(text)).rejects.toThrow(/encrypted/);
    const fresh = new LedgerDb(`test-${crypto.randomUUID()}`);
    await restoreBackup(fresh, await readBackup(text, 'a long backup password'));
    expect((await fresh.expenses.toArray()).map((e) => e.merchantName)).toContain('Encrypted Shop');
    expect(await fresh.syncOps.where('syncStatus').equals('pending').count()).toBeGreaterThan(20);
    await fresh.delete();
  });
});
