/**
 * Repository: every local write goes through here so that it
 *   (1) is saved locally first, in one IndexedDB transaction, and
 *   (2) appends a SyncOperation with HLC field versions for the sync engine.
 * Writes never wait for the network.
 */
import type { Table } from 'dexie';
import { ENTITY_TABLES, SYNCED_TABLES, type LedgerDb } from './schema';
import { getSetting, setSetting } from './settings';
import { HybridClock, type Hlc } from '../sync/hlc';
import { newId } from '../domain/ids';
import { DEFAULT_CATEGORIES } from '../domain/categories';
import { DEFAULT_TIMEZONE, addYearsClamped, todayIn, type IsoDate, type MonthKey } from '../domain/dates';
import { normalizeMerchant } from '../domain/expenseQuery';
import { sanitizeText, type ValidExpenseInput } from '../domain/expenseInput';
import {
  SCHEMA_VERSION,
  type Budget,
  type BudgetScope,
  type Category,
  type EntityType,
  type Expense,
  type ExpenseLineItem,
  type FieldVersions,
  type Household,
  type HouseholdMember,
  type MerchantRule,
  type OperationType,
  type Provenance,
  type Receipt,
  type RecurringExpense,
  type SyncOperation,
} from '../domain/types';
import type { Cents } from '../domain/money';

export interface RepoContext {
  db: LedgerDb;
  deviceId: string;
  memberId: string;
  householdId: string;
  clock: HybridClock;
  now?: () => Date;
}

type Row = Record<string, unknown>;
const VERSION_FIELDS = new Set(['recordVersion', 'fieldVersions']);

export function versionAll(record: object, hlc: Hlc): FieldVersions {
  const fv: FieldVersions = {};
  for (const k of Object.keys(record)) if (!VERSION_FIELDS.has(k)) fv[k] = hlc;
  return fv;
}

function stripVersions(r: Row): Row {
  const { recordVersion: _a, fieldVersions: _b, ...rest } = r;
  return rest;
}

/** Retention deadline: two calendar years after the transaction date (or upload date). Feb 29 → Feb 28. */
export function retentionDeadlineFor(transactionDate: IsoDate | undefined, uploadDate: IsoDate): { deadline: IsoDate; basis: 'transaction' | 'upload' } {
  return transactionDate
    ? { deadline: addYearsClamped(transactionDate, 2), basis: 'transaction' }
    : { deadline: addYearsClamped(uploadDate, 2), basis: 'upload' };
}

export interface ReceiptExpenseInput {
  expense: ValidExpenseInput & { transactionTime?: string; receiptNumber?: string; paymentMethod?: string };
  provenance: Record<string, Provenance>;
  ocrConfidence?: number;
  verificationStatus: 'verified' | 'needs_review';
  lineItems: Array<{ description: string; quantity?: number; unitPriceCents?: Cents; totalCents: Cents; confidence?: number; manuallyVerified: boolean }>;
  image?: { bytes: ArrayBuffer; thumbnail: ArrayBuffer; mimeType: string; hash: string; originalFileName?: string };
  encryptImages: boolean;
}

export class LedgerRepo {
  constructor(private readonly ctx: RepoContext) {}

  get deviceId(): string {
    return this.ctx.deviceId;
  }
  get memberId(): string {
    return this.ctx.memberId;
  }
  get clock(): HybridClock {
    return this.ctx.clock;
  }
  get db(): LedgerDb {
    return this.ctx.db;
  }

  /** Called when the device's "who am I" changes. */
  setMemberId(memberId: string): void {
    this.ctx.memberId = memberId;
  }

  nowIso(): string {
    return (this.ctx.now?.() ?? new Date()).toISOString();
  }

  private table(type: EntityType): Table<Row, string> {
    return this.ctx.db.table(ENTITY_TABLES[type].table);
  }

  private async persistClock(): Promise<void> {
    await setSetting(this.ctx.db, 'hlcState', this.ctx.clock.snapshot);
  }

  private op(type: EntityType, id: string, opType: OperationType, hlc: Hlc, base: FieldVersions, payload: Row): SyncOperation {
    return {
      operationId: newId(),
      entityType: type,
      entityId: id,
      operationType: opType,
      recordVersion: hlc,
      baseFieldVersions: base,
      payload,
      createdAt: this.nowIso(),
      deviceId: this.ctx.deviceId,
      syncStatus: 'pending',
      schemaVersion: SCHEMA_VERSION,
    };
  }

  /** Run `fn` in a read-write transaction over the synced tables + extras. */
  async tx<T>(fn: () => Promise<T>, extra: string[] = []): Promise<T> {
    const { db } = this.ctx;
    const tables = [...SYNCED_TABLES, 'syncOps', 'settings', ...extra].map((t) => db.table(t));
    return db.transaction('rw', tables, async () => {
      const r = await fn();
      await this.persistClock();
      return r;
    });
  }

  // ---------- Generic versioned operations (call inside tx) ----------

  async createIn<T>(type: EntityType, record: Row): Promise<T> {
    const hlc = this.ctx.clock.tick();
    const clean = stripVersions(record);
    for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
    const full = { ...clean, recordVersion: hlc, fieldVersions: versionAll(clean, hlc) };
    await this.table(type).add(full);
    await this.ctx.db.syncOps.add(this.op(type, String(clean[ENTITY_TABLES[type].key]), 'create', hlc, {}, clean));
    return full as T;
  }

  /** Apply changes; `undefined` removes a field. Only changed fields are versioned and recorded. */
  async updateIn<T>(type: EntityType, id: string, changes: Row): Promise<T> {
    const current = (await this.table(type).get(id)) as (Row & { fieldVersions: FieldVersions; deletedAt?: string }) | undefined;
    if (!current) throw new Error('Record not found');
    const changed: Row = {};
    for (const [k, v] of Object.entries(changes)) {
      if (VERSION_FIELDS.has(k)) continue;
      const cur = current[k];
      const same = typeof v === 'object' && v !== null ? JSON.stringify(cur) === JSON.stringify(v) : cur === v;
      if (!same) changed[k] = v === undefined ? null : v;
    }
    if (Object.keys(changed).length === 0) return current as T;
    const hlc = this.ctx.clock.tick();
    const base: FieldVersions = {};
    const fv = { ...(current.fieldVersions ?? {}) };
    for (const k of Object.keys(changed)) {
      if (fv[k]) base[k] = fv[k]!;
      fv[k] = hlc;
    }
    const next: Row = { ...current, recordVersion: hlc, fieldVersions: fv };
    for (const [k, v] of Object.entries(changed)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    await this.table(type).put(next);
    await this.ctx.db.syncOps.add(this.op(type, id, 'update', hlc, base, changed));
    return next as T;
  }

  async setDeletedIn(type: EntityType, id: string, deleted: boolean): Promise<void> {
    const current = (await this.table(type).get(id)) as (Row & { fieldVersions: FieldVersions; deletedAt?: string }) | undefined;
    if (!current) throw new Error('Record not found');
    if (Boolean(current.deletedAt) === deleted) return;
    const hlc = this.ctx.clock.tick();
    const now = this.nowIso();
    const next: Row = { ...current, recordVersion: hlc, fieldVersions: { ...current.fieldVersions, deletedAt: hlc } };
    if ('updatedAt' in current) next.updatedAt = now;
    if (deleted) next.deletedAt = now;
    else delete next.deletedAt;
    await this.table(type).put(next);
    // A delete carries every field version the deleting device had seen, so concurrent edits can be detected.
    await this.ctx.db.syncOps.add(
      this.op(type, id, deleted ? 'delete' : 'restore', hlc, { ...current.fieldVersions }, deleted ? { deletedAt: now } : { deletedAt: null }),
    );
  }

  // ---------- Expenses ----------

  private expenseRecord(input: ValidExpenseInput & { transactionTime?: string; receiptNumber?: string; paymentMethod?: string }, extra: Partial<Expense>): Row {
    const now = this.nowIso();
    return {
      expenseId: newId(),
      householdId: this.ctx.householdId,
      kind: input.kind,
      merchantName: input.merchantName,
      merchantNormalized: normalizeMerchant(input.merchantName),
      transactionDate: input.transactionDate,
      transactionTime: input.transactionTime,
      createdAt: now,
      updatedAt: now,
      createdByMemberId: this.ctx.memberId,
      paidByMemberId: input.paidByMemberId,
      expenseType: input.expenseType,
      categoryId: input.categoryId,
      subcategoryId: input.subcategoryId,
      subtotalCents: input.subtotalCents,
      taxCents: input.taxCents,
      tipCents: input.tipCents,
      discountCents: input.discountCents,
      totalCents: input.totalCents,
      currencyCode: 'USD',
      notes: input.notes,
      receiptNumber: input.receiptNumber,
      paymentMethod: input.paymentMethod,
      source: 'manual',
      verificationStatus: 'verified',
      fieldProvenance: { merchantName: 'manual', totalCents: 'manual', transactionDate: 'manual' },
      ...extra,
    };
  }

  async createExpense(input: ValidExpenseInput, extra: Partial<Pick<Expense, 'source' | 'verificationStatus' | 'recurringExpenseId'>> = {}): Promise<Expense> {
    return this.tx(() => this.createIn<Expense>('expense', this.expenseRecord(input, extra)));
  }

  /** Update from validated form input. */
  async updateExpense(expenseId: string, input: ValidExpenseInput, extra: Partial<Pick<Expense, 'verificationStatus' | 'recurringExpenseId'>> = {}): Promise<Expense> {
    return this.tx(async () => {
      const current = await this.ctx.db.expenses.get(expenseId);
      if (!current) throw new Error('Expense not found');
      if (current.deletedAt) throw new Error('Restore the expense before editing it');
      const changes: Row = {
        kind: input.kind,
        merchantName: input.merchantName,
        merchantNormalized: normalizeMerchant(input.merchantName),
        transactionDate: input.transactionDate,
        totalCents: input.totalCents,
        subtotalCents: input.subtotalCents,
        taxCents: input.taxCents,
        tipCents: input.tipCents,
        discountCents: input.discountCents,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId,
        paidByMemberId: input.paidByMemberId,
        expenseType: input.expenseType,
        notes: input.notes,
        ...extra,
      };
      // Anything the user changed by hand becomes 'manual'.
      const prov = { ...(current.fieldProvenance ?? {}) };
      let provChanged = false;
      for (const k of Object.keys(prov)) {
        if (k in changes && (current as unknown as Row)[k] !== changes[k] && prov[k] !== 'manual') {
          prov[k] = 'manual';
          provChanged = true;
        }
      }
      if (provChanged) changes.fieldProvenance = prov;
      const probe = { ...current } as Row;
      const anyChange = Object.entries(changes).some(([k, v]) => JSON.stringify(probe[k]) !== JSON.stringify(v));
      if (anyChange) changes.updatedAt = this.nowIso();
      const next = await this.updateIn<Expense>('expense', expenseId, changes);
      // Keep the receipt's retention deadline tied to the (corrected) transaction date.
      if (current.receiptId && current.transactionDate !== input.transactionDate) {
        const r = await this.ctx.db.receipts.get(current.receiptId);
        if (r && r.deletionStatus === 'active' && r.retentionBasis === 'transaction') {
          await this.updateIn('receipt', r.receiptId, { transactionDate: input.transactionDate, retentionDeadline: addYearsClamped(input.transactionDate, 2) });
        }
      }
      return next;
    });
  }

  async deleteExpense(expenseId: string): Promise<void> {
    await this.tx(() => this.setDeletedIn('expense', expenseId, true));
  }

  async restoreExpense(expenseId: string): Promise<void> {
    await this.tx(() => this.setDeletedIn('expense', expenseId, false));
  }

  /** Create an expense from a reviewed receipt, its line items, and the receipt metadata + local image, atomically. */
  async createExpenseFromReceipt(input: ReceiptExpenseInput, timezone: string): Promise<{ expense: Expense; receipt?: Receipt }> {
    return this.tx(async () => {
      const expense = await this.createIn<Expense>(
        'expense',
        this.expenseRecord(input.expense, {
          source: input.image ? 'receipt' : 'manual',
          verificationStatus: input.verificationStatus,
          fieldProvenance: input.provenance,
          ocrConfidence: input.ocrConfidence,
        }),
      );
      for (const li of input.lineItems) {
        await this.createIn<ExpenseLineItem>('lineItem', {
          lineItemId: newId(),
          expenseId: expense.expenseId,
          description: sanitizeText(li.description, 120),
          quantity: li.quantity,
          unitPriceCents: li.unitPriceCents,
          totalCents: li.totalCents,
          confidence: li.confidence,
          manuallyVerified: li.manuallyVerified,
        });
      }
      let receipt: Receipt | undefined;
      if (input.image) {
        const today = todayIn(timezone);
        const { deadline, basis } = retentionDeadlineFor(input.expense.transactionDate, today);
        receipt = await this.createIn<Receipt>('receipt', {
          receiptId: newId(),
          expenseId: expense.expenseId,
          mimeType: input.image.mimeType,
          originalFileName: input.image.originalFileName ? sanitizeText(input.image.originalFileName, 100) : undefined,
          fileSizeBytes: input.image.bytes.byteLength,
          imageHash: input.image.hash,
          encrypted: input.encryptImages,
          transactionDate: input.expense.transactionDate,
          retentionDeadline: deadline,
          retentionBasis: basis,
          uploadStatus: 'pending',
          uploadAttempts: 0,
          deletionStatus: 'active',
          deletionAttempts: 0,
        });
        await this.ctx.db.receiptBlobs.put({ receiptId: receipt.receiptId, original: input.image.bytes, thumbnail: input.image.thumbnail, mimeType: input.image.mimeType });
        await this.updateIn('expense', expense.expenseId, { receiptId: receipt.receiptId });
        expense.receiptId = receipt.receiptId;
      }
      return { expense, receipt };
    }, ['receiptBlobs']);
  }

  // ---------- Receipts ----------

  /** Attach a receipt image (and optional line items) to an existing expense that has none. */
  async attachReceipt(
    expenseId: string,
    image: NonNullable<ReceiptExpenseInput['image']>,
    opts: { encryptImages: boolean; timezone: string; lineItems?: ReceiptExpenseInput['lineItems'] },
  ): Promise<Receipt> {
    return this.tx(async () => {
      const exp = await this.ctx.db.expenses.get(expenseId);
      if (!exp || exp.deletedAt) throw new Error('Expense not found');
      if (exp.receiptId) {
        const existing = await this.ctx.db.receipts.get(exp.receiptId);
        if (existing && existing.deletionStatus !== 'deleted') throw new Error('This expense already has a receipt. Delete that image first.');
      }
      const { deadline, basis } = retentionDeadlineFor(exp.transactionDate, todayIn(opts.timezone));
      const receipt = await this.createIn<Receipt>('receipt', {
        receiptId: newId(),
        expenseId,
        mimeType: image.mimeType,
        originalFileName: image.originalFileName ? sanitizeText(image.originalFileName, 100) : undefined,
        fileSizeBytes: image.bytes.byteLength,
        imageHash: image.hash,
        encrypted: opts.encryptImages,
        transactionDate: exp.transactionDate,
        retentionDeadline: deadline,
        retentionBasis: basis,
        uploadStatus: 'pending',
        uploadAttempts: 0,
        deletionStatus: 'active',
        deletionAttempts: 0,
      });
      await this.ctx.db.receiptBlobs.put({ receiptId: receipt.receiptId, original: image.bytes, thumbnail: image.thumbnail, mimeType: image.mimeType });
      for (const li of opts.lineItems ?? []) {
        await this.createIn<ExpenseLineItem>('lineItem', {
          lineItemId: newId(), expenseId, description: sanitizeText(li.description, 120), quantity: li.quantity, unitPriceCents: li.unitPriceCents,
          totalCents: li.totalCents, confidence: li.confidence, manuallyVerified: li.manuallyVerified,
        });
      }
      await this.updateIn('expense', expenseId, { receiptId: receipt.receiptId, updatedAt: this.nowIso() });
      return receipt;
    }, ['receiptBlobs']);
  }


  async updateReceipt(receiptId: string, changes: Partial<Receipt>): Promise<Receipt> {
    return this.tx(() => this.updateIn<Receipt>('receipt', receiptId, changes as Row));
  }

  // ---------- Categories ----------

  async createCategory(name: string, opts: { parentCategoryId?: string; icon?: string; color?: string } = {}): Promise<Category> {
    const clean = sanitizeText(name, 60);
    if (!clean) throw new Error('Enter a category name');
    return this.tx(async () => {
      const existing = await this.ctx.db.categories.toArray();
      if (existing.some((c) => !c.isArchived && c.name.toLowerCase() === clean.toLowerCase() && c.parentCategoryId === opts.parentCategoryId)) {
        throw new Error('A category with that name already exists');
      }
      if (opts.parentCategoryId) {
        const parent = existing.find((c) => c.categoryId === opts.parentCategoryId);
        if (!parent || parent.parentCategoryId) throw new Error('Subcategories can only be one level deep');
      }
      return this.createIn<Category>('category', {
        categoryId: newId(),
        name: clean,
        icon: opts.icon ?? '🏷️',
        color: opts.color ?? '#607d8b',
        isDefault: false,
        isArchived: false,
        parentCategoryId: opts.parentCategoryId,
      });
    });
  }

  async updateCategory(categoryId: string, changes: Partial<Pick<Category, 'name' | 'icon' | 'color' | 'isArchived'>>): Promise<void> {
    const clean: Row = { ...changes };
    if (typeof clean.name === 'string') {
      clean.name = sanitizeText(clean.name, 60);
      if (!clean.name) throw new Error('Enter a category name');
    }
    await this.tx(() => this.updateIn('category', categoryId, clean));
  }

  // ---------- Household & members ----------

  async renameHousehold(name: string): Promise<void> {
    const clean = sanitizeText(name, 60);
    if (!clean) throw new Error('Enter a household name');
    await this.tx(() => this.updateIn('household', this.ctx.householdId, { displayName: clean }));
  }

  async renameMember(memberId: string, displayName: string): Promise<void> {
    const clean = sanitizeText(displayName, 40);
    if (!clean) throw new Error('Enter a name');
    await this.tx(() => this.updateIn('member', memberId, { displayName: clean }));
  }

  // ---------- Budgets ----------

  async saveBudget(b: {
    budgetId?: string;
    categoryId?: string;
    monthlyLimitCents: Cents;
    startMonth: MonthKey;
    endMonth?: MonthKey;
    alertThresholdPercent: number;
    scope: BudgetScope;
    isActive: boolean;
  }): Promise<Budget> {
    if (!Number.isSafeInteger(b.monthlyLimitCents) || b.monthlyLimitCents <= 0) throw new Error('Enter a monthly limit above zero');
    if (!(b.alertThresholdPercent >= 1 && b.alertThresholdPercent <= 100)) throw new Error('Warning threshold must be 1–100%');
    if (b.endMonth && b.endMonth < b.startMonth) throw new Error('End month is before start month');
    return this.tx(async () => {
      const all = await this.ctx.db.budgets.toArray();
      const clash = all.find(
        (x) => !x.deletedAt && x.budgetId !== b.budgetId && (x.categoryId ?? '') === (b.categoryId ?? '') && x.isActive && b.isActive &&
          !(x.endMonth && x.endMonth < b.startMonth) && !(b.endMonth && b.endMonth < x.startMonth),
      );
      if (clash) throw new Error(b.categoryId ? 'This category already has an active budget for those months' : 'An overall budget already covers those months');
      const fields: Row = {
        categoryId: b.categoryId,
        monthlyLimitCents: b.monthlyLimitCents,
        currencyCode: 'USD',
        startMonth: b.startMonth,
        endMonth: b.endMonth,
        alertThresholdPercent: b.alertThresholdPercent,
        scope: b.scope,
        isActive: b.isActive,
      };
      if (b.budgetId) return this.updateIn<Budget>('budget', b.budgetId, fields);
      return this.createIn<Budget>('budget', { budgetId: newId(), ...fields });
    });
  }

  async deleteBudget(budgetId: string): Promise<void> {
    await this.tx(() => this.setDeletedIn('budget', budgetId, true));
  }

  // ---------- Recurring ----------

  async saveRecurring(r: Omit<RecurringExpense, 'recordVersion' | 'fieldVersions' | 'recurringExpenseId' | 'currencyCode'> & { recurringExpenseId?: string }): Promise<RecurringExpense> {
    if (!sanitizeText(r.merchantName, 120)) throw new Error('Enter a name');
    if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 52) throw new Error('Repeat interval must be 1–52');
    const fields: Row = { ...r, merchantName: sanitizeText(r.merchantName, 120), description: sanitizeText(r.description, 200), currencyCode: 'USD' };
    delete fields.recurringExpenseId;
    return this.tx(async () => {
      if (r.recurringExpenseId) return this.updateIn<RecurringExpense>('recurring', r.recurringExpenseId, fields);
      return this.createIn<RecurringExpense>('recurring', { recurringExpenseId: newId(), ...fields });
    });
  }

  async deleteRecurring(id: string): Promise<void> {
    await this.tx(() => this.setDeletedIn('recurring', id, true));
  }

  /** Link an expense to a recurring bill occurrence and advance the due date. */
  async markRecurringPaid(recurringId: string, expenseId: string, nextDueDate: IsoDate): Promise<void> {
    await this.tx(async () => {
      const exp = await this.ctx.db.expenses.get(expenseId);
      if (!exp || exp.deletedAt) throw new Error('Expense not found');
      if (exp.recurringExpenseId && exp.recurringExpenseId !== recurringId) throw new Error('That expense is already linked to another recurring bill');
      await this.updateIn('expense', expenseId, { recurringExpenseId: recurringId });
      await this.updateIn('recurring', recurringId, { lastMatchedExpenseId: expenseId, nextDueDate });
    });
  }

  async skipRecurring(recurringId: string, nextDueDate: IsoDate): Promise<void> {
    await this.tx(() => this.updateIn('recurring', recurringId, { nextDueDate }));
  }

  // ---------- Merchant rules ----------

  async saveMerchantRule(pattern: string, categoryId: string): Promise<MerchantRule> {
    const norm = normalizeMerchant(pattern);
    if (norm.length < 2) throw new Error('Merchant text is too short');
    return this.tx(async () => {
      const existing = (await this.ctx.db.merchantRules.toArray()).find((r) => !r.deletedAt && r.merchantPattern === norm);
      if (existing) return this.updateIn<MerchantRule>('merchantRule', existing.ruleId, { categoryId, updatedAt: this.nowIso() });
      return this.createIn<MerchantRule>('merchantRule', {
        ruleId: newId(),
        merchantPattern: norm,
        categoryId,
        priority: 100,
        createdByMemberId: this.ctx.memberId,
        updatedAt: this.nowIso(),
      });
    });
  }

  async deleteMerchantRule(ruleId: string): Promise<void> {
    await this.tx(() => this.setDeletedIn('merchantRule', ruleId, true));
  }

  async pendingOpCount(): Promise<number> {
    return this.ctx.db.syncOps.where('syncStatus').equals('pending').count();
  }
}

// ---------- Household setup (first run) ----------

export interface SetupInput {
  householdName: string;
  memberNames: [string, string];
  thisDeviceMemberIndex: 0 | 1;
  timezone?: string;
}

/** Fixed early version for default categories so both spouses' devices create identical records. */
export const SEED_HLC = '000000000000000:00000:seed';

export function defaultCategoryRecords(): Category[] {
  return DEFAULT_CATEGORIES.map((c) => {
    const base = { ...c, isDefault: true, isArchived: false };
    return { ...base, recordVersion: SEED_HLC, fieldVersions: versionAll(base, SEED_HLC) };
  });
}

async function initDeviceSettings(db: LedgerDb, deviceId: string, clock: HybridClock): Promise<void> {
  await setSetting(db, 'deviceId', deviceId);
  await setSetting(db, 'hlcState', clock.snapshot);
  await setSetting(db, 'autoLockMinutes', 5);
  await setSetting(db, 'lastBackupAt', null);
  await setSetting(db, 'lastSyncAt', null);
}

/** Creates the household, two members, default categories and device identity. Refuses if already set up. */
export async function setupHousehold(db: LedgerDb, input: SetupInput): Promise<{ householdId: string; memberId: string; deviceId: string }> {
  return db.transaction('rw', [db.household, db.members, db.categories, db.syncOps, db.settings], async () => {
    if ((await db.household.count()) > 0) throw new Error('Household already set up on this device');
    const deviceId = newId();
    const clock = new HybridClock(deviceId);
    const now = new Date().toISOString();
    const householdId = newId();
    const ops: SyncOperation[] = [];
    const add = (entityType: EntityType, entityId: string, base: Row): Row => {
      const hlc = clock.tick();
      ops.push({
        operationId: newId(), entityType, entityId, operationType: 'create', recordVersion: hlc, baseFieldVersions: {},
        payload: base, createdAt: now, deviceId, syncStatus: 'pending', schemaVersion: SCHEMA_VERSION,
      });
      return { ...base, recordVersion: hlc, fieldVersions: versionAll(base, hlc) };
    };
    const hh = {
      householdId,
      displayName: sanitizeText(input.householdName, 60) || 'Our household',
      createdAt: now,
      schemaVersion: SCHEMA_VERSION,
      timezone: input.timezone ?? DEFAULT_TIMEZONE,
      currencyCode: 'USD',
    };
    await db.household.add(add('household', householdId, hh) as unknown as Household);
    const members = input.memberNames.map((n, i) => ({
      memberId: newId(),
      householdId,
      displayName: sanitizeText(n, 40) || (i === 0 ? 'Spouse A' : 'Spouse B'),
      role: (i === 0 ? 'owner' : 'member') as HouseholdMember['role'],
      createdAt: now,
      status: 'active' as const,
    }));
    for (const m of members) await db.members.add(add('member', m.memberId, m) as unknown as HouseholdMember);
    await db.categories.bulkAdd(defaultCategoryRecords());
    await db.syncOps.bulkAdd(ops);

    const memberId = members[input.thisDeviceMemberIndex]!.memberId;
    await initDeviceSettings(db, deviceId, clock);
    await setSetting(db, 'householdId', householdId);
    await setSetting(db, 'memberId', memberId);
    return { householdId, memberId, deviceId };
  });
}

/** Device identity for a device that joins via Drive or a backup (no household records created). */
export async function ensureDeviceIdentity(db: LedgerDb): Promise<string> {
  let deviceId = await getSetting(db, 'deviceId');
  if (!deviceId) {
    deviceId = newId();
    await initDeviceSettings(db, deviceId, new HybridClock(deviceId));
  }
  return deviceId;
}

/** Build a repo from persisted device settings, or null if this device isn't set up yet. */
export async function loadRepo(db: LedgerDb): Promise<LedgerRepo | null> {
  const [deviceId, householdId, memberId, hlcState] = await Promise.all([
    getSetting(db, 'deviceId'),
    getSetting(db, 'householdId'),
    getSetting(db, 'memberId'),
    getSetting(db, 'hlcState'),
  ]);
  if (!deviceId || !householdId || !memberId) return null;
  return new LedgerRepo({ db, deviceId, householdId, memberId, clock: new HybridClock(deviceId, hlcState) });
}
