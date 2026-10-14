import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { LedgerDb, V1_STORES } from '../../src/db/schema';

describe('schema migrations', () => {
  it('upgrades a version-1 database to version 2 without losing data', async () => {
    const name = `mig-${crypto.randomUUID()}`;
    const v1 = new Dexie(name);
    v1.version(1).stores(V1_STORES);
    await v1.open();
    await v1.table('members').add({ memberId: 'm1', householdId: 'h', displayName: 'A', role: 'owner', createdAt: 'x', status: 'active' });
    await v1.table('budgets').add({ budgetId: 'b1', monthlyLimitCents: 1000, startMonth: '2026-01', alertThresholdPercent: 80, isActive: true, currencyCode: 'USD', recordVersion: 'v', fieldVersions: {} });
    await v1.table('expenses').add({ expenseId: 'e1', totalCents: 4510, merchantName: 'Kroger' });
    v1.close();

    const db = new LedgerDb(name);
    await db.open();
    expect(db.verno).toBe(2);
    const m = (await db.members.get('m1'))!;
    expect(m.fieldVersions.displayName).toBeTruthy();
    expect(m.displayName).toBe('A');
    expect((await db.budgets.get('b1'))!.scope).toBe('all');
    expect((await db.expenses.get('e1'))!.totalCents).toBe(4510);
    expect(await db.conflicts.count()).toBe(0);
    await db.delete();
  });
});
