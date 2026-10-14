/**
 * Applying a remote operation to the local database — field-level, conflict-detecting merge.
 *
 * Every field carries the HLC of its last change. An update op lists, per changed field, the version the
 * editing device had seen ("base"). When applying remote change R to field f:
 *   - local version ≤ base  → this device hasn't changed f since the remote saw it → take R.
 *   - otherwise both devices changed f independently (concurrent):
 *       same value → nothing to decide;
 *       different → keep the value with the higher HLC on BOTH devices (so they converge),
 *                   and record a Conflict so a person can pick. Nothing is silently lost: the
 *                   other value is stored in the conflict record.
 * Deletes are tombstones (deletedAt). A delete concurrent with an edit keeps the delete and records a
 * conflict so the user can restore. Operations are idempotent (applied op IDs are remembered).
 * Must be called inside a Dexie transaction covering the synced tables, conflicts, appliedOps,
 * deferredOps and settings.
 */
import type { LedgerDb } from '../db/schema';
import { ENTITY_TABLES } from '../db/schema';
import { compareHlc, type Hlc, type HybridClock } from './hlc';
import { versionAll } from '../db/repo';
import { newId } from '../domain/ids';
import { isValidIsoDate } from '../domain/dates';
import { SCHEMA_VERSION, type Conflict, type EntityType, type FieldVersions, type SyncOperation } from '../domain/types';

export class UnsupportedSchemaError extends Error {
  constructor(public readonly version: number) {
    super('Another device uses a newer version of PocketLedger. Update this app to keep syncing.');
    this.name = 'UnsupportedSchemaError';
  }
}

/** Fields that change as a side effect; concurrent changes resolve by clock without asking the user. */
export const AUTO_FIELDS = new Set([
  'updatedAt', 'merchantNormalized', 'fieldProvenance', 'ocrConfidence', 'verificationStatus',
  'uploadStatus', 'uploadAttempts', 'nextUploadAt', 'uploadedAt', 'driveFileId',
  'deletionStatus', 'deletionAttempts', 'nextDeletionAt', 'nextDueDate', 'lastMatchedExpenseId', 'receiptId',
]);

const ENTITY_TYPES = new Set(Object.keys(ENTITY_TABLES));
const OP_TYPES = new Set(['create', 'update', 'delete', 'restore']);
const HLC_RE = /^\d{15}:\d{5}:.+$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type Row = Record<string, unknown> & { fieldVersions?: FieldVersions; recordVersion?: Hlc; deletedAt?: string };

export function validateOp(op: unknown): op is SyncOperation {
  const o = op as SyncOperation;
  return (
    !!o && typeof o === 'object' &&
    typeof o.operationId === 'string' && o.operationId.length <= 64 &&
    ENTITY_TYPES.has(o.entityType) &&
    typeof o.entityId === 'string' && o.entityId.length > 0 && o.entityId.length <= 128 &&
    OP_TYPES.has(o.operationType) &&
    typeof o.recordVersion === 'string' && HLC_RE.test(o.recordVersion) &&
    !!o.payload && typeof o.payload === 'object' && !Array.isArray(o.payload) &&
    Object.keys(o.payload).every((k) => !FORBIDDEN_KEYS.has(k)) &&
    !!o.baseFieldVersions && typeof o.baseFieldVersions === 'object' &&
    typeof o.schemaVersion === 'number'
  );
}

const isInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v);
const isOptInt = (v: unknown) => v === undefined || isInt(v);
const isStr = (v: unknown) => typeof v === 'string';

/** Minimal type validation of a merged record before it is written. */
export function validateRecord(type: EntityType, r: Row): boolean {
  switch (type) {
    case 'expense':
      return (
        isStr(r.expenseId) && isStr(r.merchantName) && isValidIsoDate(r.transactionDate) && isInt(r.totalCents) && (r.totalCents as number) >= 0 &&
        (r.kind === 'expense' || r.kind === 'refund') && (r.expenseType === 'shared' || r.expenseType === 'personal') && isStr(r.categoryId) &&
        isStr(r.paidByMemberId) && isOptInt(r.subtotalCents) && isOptInt(r.taxCents) && isOptInt(r.tipCents) && isOptInt(r.discountCents)
      );
    case 'category':
      return isStr(r.categoryId) && isStr(r.name);
    case 'budget':
      return isStr(r.budgetId) && isInt(r.monthlyLimitCents) && isStr(r.startMonth);
    case 'recurring':
      return isStr(r.recurringExpenseId) && isInt(r.expectedAmountCents) && isValidIsoDate(r.anchorDate) && isValidIsoDate(r.nextDueDate) && isInt(r.interval);
    case 'receipt':
      return isStr(r.receiptId) && isStr(r.expenseId) && isValidIsoDate(r.retentionDeadline);
    case 'lineItem':
      return isStr(r.lineItemId) && isStr(r.expenseId) && isInt(r.totalCents);
    case 'merchantRule':
      return isStr(r.ruleId) && isStr(r.merchantPattern) && isStr(r.categoryId);
    case 'member':
      return isStr(r.memberId) && isStr(r.displayName);
    case 'household':
      return isStr(r.householdId);
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function maxVersion(fv: FieldVersions): Hlc {
  let m = '';
  for (const v of Object.values(fv)) if (v > m) m = v;
  return m;
}

export interface ApplyOutcome {
  status: 'applied' | 'duplicate' | 'deferred' | 'rejected';
  conflicts: number;
}

export async function applyRemoteOp(db: LedgerDb, op: SyncOperation, clock: HybridClock, nowIso: () => string = () => new Date().toISOString()): Promise<ApplyOutcome> {
  if (!validateOp(op)) return { status: 'rejected', conflicts: 0 };
  if (op.schemaVersion > SCHEMA_VERSION) throw new UnsupportedSchemaError(op.schemaVersion);
  if (await db.appliedOps.get(op.operationId)) return { status: 'duplicate', conflicts: 0 };
  try {
    clock.receive(op.recordVersion);
  } catch {
    // Remote clock is implausibly far ahead; still merge by version but don't let it drag our clock.
  }

  const { table, key } = ENTITY_TABLES[op.entityType];
  const t = db.table(table);
  const current = (await t.get(op.entityId)) as Row | undefined;
  const R = op.recordVersion;
  let conflicts = 0;

  const markApplied = async () => {
    await db.appliedOps.put({ operationId: op.operationId, appliedAt: nowIso() });
    await db.deferredOps.delete(op.operationId);
  };

  const addConflict = async (field: string, kept: unknown, other: unknown, keptV: Hlc, otherV: Hlc) => {
    const existing = await db.conflicts.where('entityId').equals(op.entityId).filter((c) => c.field === field && !c.resolvedAt).first();
    const c: Conflict = {
      conflictId: existing?.conflictId ?? newId(),
      entityType: op.entityType,
      entityId: op.entityId,
      field,
      keptValue: kept,
      otherValue: other,
      keptVersion: keptV,
      otherVersion: otherV,
      createdAt: nowIso(),
    };
    await db.conflicts.put(c);
    conflicts++;
  };

  // ----- create -----
  if (op.operationType === 'create') {
    const payload = { ...op.payload } as Row;
    payload[key] = op.entityId;
    const fv = op.fieldVersions ?? versionAll(payload, R);
    if (!current) {
      const rec: Row = { ...payload, fieldVersions: fv, recordVersion: maxVersion(fv) || R };
      if (!validateRecord(op.entityType, rec)) return { status: 'rejected', conflicts: 0 };
      await t.put(rec);
      await markApplied();
      return { status: 'applied', conflicts: 0 };
    }
    // Same id created on two devices (default categories, restored backups): newest field wins.
    const next: Row = { ...current, fieldVersions: { ...(current.fieldVersions ?? {}) } };
    for (const [f, v] of Object.entries(payload)) {
      const rv = fv[f] ?? R;
      const lv = next.fieldVersions![f];
      if (!lv || compareHlc(rv, lv) > 0) {
        if (v === null || v === undefined) delete next[f];
        else next[f] = v;
        next.fieldVersions![f] = rv;
      }
    }
    next.recordVersion = maxVersion(next.fieldVersions!);
    if (!validateRecord(op.entityType, next)) return { status: 'rejected', conflicts: 0 };
    await t.put(next);
    await markApplied();
    return { status: 'applied', conflicts: 0 };
  }

  if (!current) {
    // The record's create hasn't arrived yet (should be rare since ops are applied in clock order).
    await db.deferredOps.put(op);
    return { status: 'deferred', conflicts: 0 };
  }

  const next: Row = { ...current, fieldVersions: { ...(current.fieldVersions ?? {}) } };
  const fv = next.fieldVersions!;
  const base = op.baseFieldVersions;

  // Edit-vs-delete detection
  if (op.operationType === 'delete' && !current.deletedAt) {
    const unseenLocalEdits = Object.entries(fv).filter(([f, lv]) => f !== 'deletedAt' && !AUTO_FIELDS.has(f) && (!base[f] || compareHlc(lv, base[f]!) > 0));
    if (unseenLocalEdits.length) await addConflict('__deleted__', 'deleted on another device', 'edited on this device', R, unseenLocalEdits.map(([, v]) => v).sort().at(-1)!);
  }
  if (op.operationType === 'update' && current.deletedAt && fv.deletedAt && (!base.deletedAt || compareHlc(fv.deletedAt, base.deletedAt) > 0)) {
    await addConflict('__deleted__', 'deleted on this device', 'edited on another device', fv.deletedAt, R);
  }

  for (const [f, raw] of Object.entries(op.payload)) {
    if (f === key || f === 'fieldVersions' || f === 'recordVersion') continue;
    const v = raw === null ? undefined : raw;
    const lv = fv[f];
    const bv = base[f];
    const take = () => {
      if (v === undefined) delete next[f];
      else next[f] = v;
      fv[f] = R;
    };
    if (!lv || (bv && compareHlc(lv, bv) <= 0)) {
      take();
      // A change built on top of the versions in an open conflict resolves it everywhere.
      const open = await db.conflicts.where('entityId').equals(op.entityId).filter((c) => c.field === f && !c.resolvedAt).toArray();
      for (const c of open) {
        if (bv && compareHlc(bv, c.keptVersion) >= 0 && compareHlc(bv, c.otherVersion) >= 0) await db.conflicts.put({ ...c, resolvedAt: nowIso() });
      }
      continue;
    }
    if (lv === R) continue; // already have this exact change
    if (sameValue(next[f], v)) {
      if (compareHlc(R, lv) > 0) fv[f] = R;
      continue;
    }
    // Concurrent, different values: the higher clock wins on every device.
    const remoteWins = compareHlc(R, lv) > 0;
    const localValue = next[f];
    if (remoteWins) take();
    if (!AUTO_FIELDS.has(f) && f !== 'deletedAt') {
      await addConflict(f, remoteWins ? v : localValue, remoteWins ? localValue : v, remoteWins ? R : lv, remoteWins ? lv : R);
    } else if (f === 'deletedAt') {
      await addConflict('__deleted__', next.deletedAt ? 'deleted' : 'restored', next.deletedAt ? 'restored' : 'deleted', remoteWins ? R : lv, remoteWins ? lv : R);
    }
  }
  next.recordVersion = maxVersion(fv);
  if (!validateRecord(op.entityType, next)) return { status: 'rejected', conflicts };
  await t.put(next);
  await markApplied();
  return { status: 'applied', conflicts };
}

/** Apply many remote ops in causal (clock) order. Re-tries previously deferred ops too. */
export async function applyRemoteOps(db: LedgerDb, ops: SyncOperation[], clock: HybridClock): Promise<{ applied: number; conflicts: number; rejected: number; deferred: number }> {
  const deferred = await db.deferredOps.toArray();
  const all = [...deferred, ...ops].sort((a, b) => compareHlc(a.recordVersion, b.recordVersion));
  let applied = 0;
  let conflicts = 0;
  let rejected = 0;
  let stillDeferred = 0;
  for (const op of all) {
    const r = await applyRemoteOp(db, op, clock);
    if (r.status === 'applied') applied++;
    if (r.status === 'rejected') rejected++;
    if (r.status === 'deferred') stillDeferred++;
    conflicts += r.conflicts;
  }
  return { applied, conflicts, rejected, deferred: stillDeferred };
}
