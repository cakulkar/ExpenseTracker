import type { Cents } from './money';
import type { IsoDate, MonthKey } from './dates';
import type { Hlc } from '../sync/hlc';

/** Version of the synchronized data format. Bump when an op payload changes shape. */
export const SCHEMA_VERSION = 2;

export type MemberRole = 'owner' | 'member';
export type ExpenseType = 'shared' | 'personal';
export type ExpenseKind = 'expense' | 'refund';
export type ExpenseSource = 'manual' | 'receipt' | 'import' | 'recurring';
export type VerificationStatus = 'verified' | 'needs_review';
export type Provenance = 'extracted' | 'inferred' | 'manual';

/** Per-field version map used for conflict detection. */
export type FieldVersions = Record<string, Hlc>;

export interface Versioned {
  /** HLC of the latest change to the record. */
  recordVersion: Hlc;
  fieldVersions: FieldVersions;
}

export interface Household extends Versioned {
  householdId: string;
  displayName: string;
  createdAt: string;
  schemaVersion: number;
  timezone: string;
  currencyCode: string;
  /** Opaque sync metadata (not used for secrets). */
  encryptedSyncMetadata?: string;
}

export interface HouseholdMember extends Versioned {
  memberId: string;
  householdId: string;
  displayName: string;
  role: MemberRole;
  createdAt: string;
  status: 'active' | 'removed';
}

export interface Expense extends Versioned {
  expenseId: string;
  householdId: string;
  kind: ExpenseKind;
  merchantName: string;
  merchantNormalized: string;
  transactionDate: IsoDate;
  /** "HH:MM" 24h, when printed on a receipt. */
  transactionTime?: string;
  createdAt: string;
  updatedAt: string;
  createdByMemberId: string;
  paidByMemberId: string;
  expenseType: ExpenseType;
  categoryId: string;
  subcategoryId?: string;
  subtotalCents?: Cents;
  taxCents?: Cents;
  tipCents?: Cents;
  discountCents?: Cents;
  /** Always >= 0. Refunds are expressed with kind = 'refund'. */
  totalCents: Cents;
  currencyCode: string;
  notes: string;
  receiptNumber?: string;
  /** Card brand or "Cash" only when clearly printed. Never card numbers. */
  paymentMethod?: string;
  receiptId?: string;
  recurringExpenseId?: string;
  source: ExpenseSource;
  verificationStatus: VerificationStatus;
  fieldProvenance?: Record<string, Provenance>;
  ocrConfidence?: number;
  deletedAt?: string;
}

export interface ExpenseLineItem extends Versioned {
  lineItemId: string;
  expenseId: string;
  description: string;
  quantity?: number;
  unitPriceCents?: Cents;
  totalCents: Cents;
  categoryId?: string;
  confidence?: number;
  manuallyVerified: boolean;
  deletedAt?: string;
}

export interface Category extends Versioned {
  categoryId: string;
  name: string;
  parentCategoryId?: string;
  icon: string;
  color: string;
  isDefault: boolean;
  isArchived: boolean;
}

export type BudgetScope = 'all' | 'shared';

export interface Budget extends Versioned {
  budgetId: string;
  /** Omitted = overall household budget. */
  categoryId?: string;
  monthlyLimitCents: Cents;
  currencyCode: string;
  startMonth: MonthKey;
  endMonth?: MonthKey;
  /** Warning threshold (default 80). The 100% alert always applies. */
  alertThresholdPercent: number;
  /** 'all' counts shared + personal spending; 'shared' counts shared spending only. */
  scope: BudgetScope;
  isActive: boolean;
  deletedAt?: string;
}

export type UploadStatus = 'local' | 'pending' | 'uploading' | 'uploaded' | 'failed';
export type DeletionStatus = 'active' | 'scheduled' | 'deleting' | 'deleted' | 'failed';

export interface Receipt extends Versioned {
  receiptId: string;
  expenseId: string;
  driveFileId?: string;
  mimeType: string;
  originalFileName?: string;
  fileSizeBytes: number;
  /** SHA-256 of the image bytes (hex). Used for duplicate detection. */
  imageHash: string;
  encrypted: boolean;
  uploadedAt?: string;
  transactionDate?: IsoDate;
  retentionDeadline: IsoDate;
  retentionBasis: 'transaction' | 'upload';
  uploadStatus: UploadStatus;
  uploadAttempts: number;
  nextUploadAt?: string;
  deletionStatus: DeletionStatus;
  deletionAttempts: number;
  nextDeletionAt?: string;
  deletedAt?: string;
}

export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export interface RecurringExpense extends Versioned {
  recurringExpenseId: string;
  merchantName: string;
  description: string;
  categoryId: string;
  expectedAmountCents: Cents;
  currencyCode: string;
  frequency: Frequency;
  interval: number;
  /** First due date; all later due dates are computed from it, so month-end dates never drift. */
  anchorDate: IsoDate;
  nextDueDate: IsoDate;
  paidByMemberId?: string;
  expenseType: ExpenseType;
  lastMatchedExpenseId?: string;
  isActive: boolean;
  deletedAt?: string;
}

export interface MerchantRule extends Versioned {
  ruleId: string;
  /** Normalized merchant text; matches when the normalized merchant contains it. */
  merchantPattern: string;
  categoryId: string;
  priority: number;
  createdByMemberId: string;
  updatedAt: string;
  deletedAt?: string;
}

export type EntityType =
  | 'household'
  | 'member'
  | 'expense'
  | 'lineItem'
  | 'category'
  | 'budget'
  | 'receipt'
  | 'recurring'
  | 'merchantRule';

export type OperationType = 'create' | 'update' | 'delete' | 'restore';

export interface SyncOperation {
  operationId: string;
  entityType: EntityType;
  entityId: string;
  operationType: OperationType;
  /** HLC of this operation. */
  recordVersion: Hlc;
  /** Field versions the editing device had seen; used to detect concurrent edits. */
  baseFieldVersions: FieldVersions;
  /** Changed fields (update; null = field removed), full record (create), deletedAt (delete), {} (restore). */
  payload: Record<string, unknown>;
  createdAt: string;
  deviceId: string;
  syncStatus: 'pending' | 'synced';
  schemaVersion: number;
  /**
   * Only on 'create' ops that carry an existing record (backup restore, snapshot replay):
   * the record's own per-field versions, so merging keeps the original ordering.
   */
  fieldVersions?: FieldVersions;
}

/** Local-only: a concurrent edit that needs a person to choose. */
export interface Conflict {
  conflictId: string;
  entityType: EntityType;
  entityId: string;
  field: string;
  /** Value kept automatically (higher clock), and the value that lost. */
  keptValue: unknown;
  otherValue: unknown;
  keptVersion: Hlc;
  otherVersion: Hlc;
  createdAt: string;
  resolvedAt?: string;
}

/** Local-only image bytes. Removed after upload (original) or at retention expiry (thumbnail). */
export interface ReceiptBlob {
  receiptId: string;
  /** Raw bytes (ArrayBuffer is the most reliable type to store in IndexedDB across browsers). */
  original?: ArrayBuffer;
  thumbnail?: ArrayBuffer;
  mimeType: string;
}

/** Local-only minimal audit of receipt image deletions. No image or OCR text. */
export interface DeletionAudit {
  receiptId: string;
  scheduledDeadline: IsoDate;
  status: 'deleted' | 'failed' | 'not_uploaded';
  completedAt?: string;
  verified: boolean;
  attempts: number;
}

/** Local-only record that a remote operation was applied (idempotency). */
export interface AppliedOp {
  operationId: string;
  appliedAt: string;
}

/** Device-local key/value settings. Never synchronized. */
export interface SettingRow {
  key: string;
  value: unknown;
}
