/**
 * Local IndexedDB database (Dexie). Versioned; each `version(n)` block is a migration.
 * Index strings list only queried fields — Dexie stores whole objects regardless.
 *
 * Migration policy: never edit a released version block. Add version(n+1) with an
 * `.upgrade()` callback and a test in tests/integration/migrations.test.ts.
 */
import Dexie, { type EntityTable } from 'dexie';
import type {
  AppliedOp,
  Budget,
  Category,
  Conflict,
  DeletionAudit,
  EntityType,
  Expense,
  ExpenseLineItem,
  Household,
  HouseholdMember,
  MerchantRule,
  Receipt,
  ReceiptBlob,
  RecurringExpense,
  SettingRow,
  SyncOperation,
} from '../domain/types';

export const DB_NAME = 'pocketledger';

export const V1_STORES = {
  household: 'householdId',
  members: 'memberId, householdId',
  expenses: 'expenseId, transactionDate, categoryId, paidByMemberId, merchantNormalized, updatedAt, receiptId, recurringExpenseId',
  lineItems: 'lineItemId, expenseId',
  categories: 'categoryId, parentCategoryId',
  budgets: 'budgetId, categoryId',
  receipts: 'receiptId, expenseId, imageHash, retentionDeadline, uploadStatus, deletionStatus',
  recurring: 'recurringExpenseId, nextDueDate',
  merchantRules: 'ruleId, merchantPattern',
  syncOps: 'operationId, syncStatus, entityId, recordVersion',
  settings: 'key',
};

export const V2_STORES = {
  ...V1_STORES,
  receiptBlobs: 'receiptId',
  conflicts: 'conflictId, entityId, resolvedAt',
  deletionAudit: 'receiptId',
  appliedOps: 'operationId',
  deferredOps: 'operationId',
};

export class LedgerDb extends Dexie {
  household!: EntityTable<Household, 'householdId'>;
  members!: EntityTable<HouseholdMember, 'memberId'>;
  expenses!: EntityTable<Expense, 'expenseId'>;
  lineItems!: EntityTable<ExpenseLineItem, 'lineItemId'>;
  categories!: EntityTable<Category, 'categoryId'>;
  budgets!: EntityTable<Budget, 'budgetId'>;
  receipts!: EntityTable<Receipt, 'receiptId'>;
  recurring!: EntityTable<RecurringExpense, 'recurringExpenseId'>;
  merchantRules!: EntityTable<MerchantRule, 'ruleId'>;
  syncOps!: EntityTable<SyncOperation, 'operationId'>;
  settings!: EntityTable<SettingRow, 'key'>;
  receiptBlobs!: EntityTable<ReceiptBlob, 'receiptId'>;
  conflicts!: EntityTable<Conflict, 'conflictId'>;
  deletionAudit!: EntityTable<DeletionAudit, 'receiptId'>;
  appliedOps!: EntityTable<AppliedOp, 'operationId'>;
  /** Remote ops whose record hasn't arrived yet (applied on a later sync). */
  deferredOps!: EntityTable<SyncOperation, 'operationId'>;

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(1).stores(V1_STORES);
    this.version(2)
      .stores(V2_STORES)
      .upgrade(async (tx) => {
        // Members and the household gained per-field versions (needed for sync).
        const seed = '000000000000000:00000:migration';
        for (const t of ['members', 'household']) {
          await tx.table(t).toCollection().modify((r: Record<string, unknown>) => {
            if (!r.fieldVersions) {
              const fv: Record<string, string> = {};
              for (const k of Object.keys(r)) fv[k] = seed;
              r.fieldVersions = fv;
              r.recordVersion = seed;
            }
          });
        }
        // Budgets gained a scope; existing budgets keep counting all spending.
        await tx.table('budgets').toCollection().modify((b: Record<string, unknown>) => {
          if (!b.scope) b.scope = 'all';
        });
        // Receipts gained retry counters.
        await tx.table('receipts').toCollection().modify((r: Record<string, unknown>) => {
          r.uploadAttempts ??= 0;
          r.deletionAttempts ??= 0;
        });
      });
  }
}

/** Synced entity → table name and primary key. */
export const ENTITY_TABLES: Record<EntityType, { table: string; key: string }> = {
  household: { table: 'household', key: 'householdId' },
  member: { table: 'members', key: 'memberId' },
  expense: { table: 'expenses', key: 'expenseId' },
  lineItem: { table: 'lineItems', key: 'lineItemId' },
  category: { table: 'categories', key: 'categoryId' },
  budget: { table: 'budgets', key: 'budgetId' },
  receipt: { table: 'receipts', key: 'receiptId' },
  recurring: { table: 'recurring', key: 'recurringExpenseId' },
  merchantRule: { table: 'merchantRules', key: 'ruleId' },
};

export const SYNCED_TABLES = Object.values(ENTITY_TABLES).map((e) => e.table);

let instance: LedgerDb | null = null;

export function getDb(): LedgerDb {
  if (!instance) instance = new LedgerDb();
  return instance;
}

/** Test hook: use a fresh database. */
export function setDbForTests(db: LedgerDb | null): void {
  instance = db;
}
