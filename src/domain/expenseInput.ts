/** Validation of the manual expense form. Returns field errors; never throws on user input. */
import { tryParseCents, type Cents } from './money';
import { isValidIsoDate, type IsoDate } from './dates';
import type { ExpenseKind, ExpenseType } from './types';

export interface ExpenseFormValues {
  kind: ExpenseKind;
  merchantName: string;
  transactionDate: string;
  amount: string;
  subtotal: string;
  tax: string;
  tip: string;
  discount: string;
  categoryId: string;
  subcategoryId: string;
  paidByMemberId: string;
  expenseType: ExpenseType;
  notes: string;
}

export interface ValidExpenseInput {
  kind: ExpenseKind;
  merchantName: string;
  transactionDate: IsoDate;
  totalCents: Cents;
  subtotalCents?: Cents;
  taxCents?: Cents;
  tipCents?: Cents;
  discountCents?: Cents;
  categoryId: string;
  subcategoryId?: string;
  paidByMemberId: string;
  expenseType: ExpenseType;
  notes: string;
}

export type FieldErrors = Partial<Record<keyof ExpenseFormValues, string>>;

export const MAX_MERCHANT_LEN = 120;
export const MAX_NOTES_LEN = 2000;

/** Strip control characters from untrusted text (user input, OCR, imported CSV). */
export function sanitizeText(s: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}

export function validateExpenseForm(
  v: ExpenseFormValues,
  known: { categoryIds: ReadonlySet<string>; memberIds: ReadonlySet<string> },
): { ok: true; value: ValidExpenseInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const merchantName = sanitizeText(v.merchantName, MAX_MERCHANT_LEN);
  if (!merchantName) errors.merchantName = 'Enter a merchant or description';
  if (!isValidIsoDate(v.transactionDate)) errors.transactionDate = 'Enter a valid date';

  const total = tryParseCents(v.amount);
  if (total === null) errors.amount = 'Enter an amount like 12.34';
  else if (total < 0) errors.amount = 'Amount cannot be negative';

  const optional = (raw: string, key: keyof FieldErrors): Cents | undefined => {
    if (raw.trim() === '') return undefined;
    const c = tryParseCents(raw);
    if (c === null) {
      errors[key] = 'Enter an amount like 1.23';
      return undefined;
    }
    return c;
  };
  const subtotalCents = optional(v.subtotal, 'subtotal');
  const taxCents = optional(v.tax, 'tax');
  const tipCents = optional(v.tip, 'tip');
  const discountCents = optional(v.discount, 'discount');

  if (!known.categoryIds.has(v.categoryId)) errors.categoryId = 'Choose a category';
  if (v.subcategoryId && !known.categoryIds.has(v.subcategoryId)) errors.subcategoryId = 'Choose a valid subcategory';
  if (!known.memberIds.has(v.paidByMemberId)) errors.paidByMemberId = 'Choose who paid';
  if (v.expenseType !== 'shared' && v.expenseType !== 'personal') errors.expenseType = 'Choose shared or personal';
  if (v.kind !== 'expense' && v.kind !== 'refund') errors.kind = 'Choose expense or refund';
  const notes = sanitizeText(v.notes, MAX_NOTES_LEN);

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind: v.kind,
      merchantName,
      transactionDate: v.transactionDate,
      totalCents: total!,
      subtotalCents,
      taxCents,
      tipCents,
      discountCents,
      categoryId: v.categoryId,
      subcategoryId: v.subcategoryId || undefined,
      paidByMemberId: v.paidByMemberId,
      expenseType: v.expenseType,
      notes,
    },
  };
}

/**
 * Soft arithmetic check: subtotal + tax + tip − discount ≈ total (±2¢).
 * Returns a warning string or null. Never blocks saving.
 */
export function breakdownWarning(i: Pick<ValidExpenseInput, 'totalCents' | 'subtotalCents' | 'taxCents' | 'tipCents' | 'discountCents'>): string | null {
  if (i.subtotalCents === undefined) return null;
  const expected = i.subtotalCents + (i.taxCents ?? 0) + (i.tipCents ?? 0) - (i.discountCents ?? 0);
  const diff = Math.abs(expected - i.totalCents);
  if (diff <= 2) return null;
  return `Subtotal + tax + tip − discount is ${(expected / 100).toFixed(2)}, which differs from the total by ${(diff / 100).toFixed(2)}. Saving anyway is fine if the receipt shows this.`;
}
