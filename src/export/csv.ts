/**
 * CSV export and import (RFC 4180). Exported cells that start with = + - @ (or tab/CR) are prefixed with an
 * apostrophe so spreadsheet apps don't execute them as formulas (CSV injection).
 */
import type { Category, Expense, HouseholdMember } from '../domain/types';
import { centsToInput, parseCents } from '../domain/money';
import { isValidIsoDate, toIsoDate } from '../domain/dates';
import { sanitizeText } from '../domain/expenseInput';

export const EXPORT_COLUMNS = [
  'Date', 'Merchant', 'Type', 'Amount', 'Signed amount', 'Category', 'Subcategory', 'Paid by', 'Entered by', 'Shared/Personal',
  'Subtotal', 'Tax', 'Tip', 'Discount', 'Payment method', 'Receipt number', 'Receipt', 'Recurring', 'Source', 'Verification', 'Notes', 'Expense ID',
] as const;

export interface ExportContext {
  categories: ReadonlyMap<string, Category>;
  members: ReadonlyMap<string, HouseholdMember>;
  receiptStatus: (e: Expense) => string;
}

export function safeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function quote(v: string): string {
  const s = safeCell(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const opt = (c?: number) => (c === undefined ? '' : centsToInput(c));

export function expenseRow(e: Expense, ctx: ExportContext): string[] {
  const cat = ctx.categories.get(e.categoryId);
  const sub = e.subcategoryId ? ctx.categories.get(e.subcategoryId) : undefined;
  return [
    e.transactionDate,
    e.merchantName,
    e.kind === 'refund' ? 'Refund' : 'Expense',
    centsToInput(e.totalCents),
    centsToInput(e.kind === 'refund' ? -e.totalCents : e.totalCents),
    cat?.name ?? '',
    sub?.name ?? '',
    ctx.members.get(e.paidByMemberId)?.displayName ?? '',
    ctx.members.get(e.createdByMemberId)?.displayName ?? '',
    e.expenseType === 'shared' ? 'Shared' : 'Personal',
    opt(e.subtotalCents),
    opt(e.taxCents),
    opt(e.tipCents),
    opt(e.discountCents),
    e.paymentMethod ?? '',
    e.receiptNumber ?? '',
    ctx.receiptStatus(e),
    e.recurringExpenseId ? 'Yes' : 'No',
    e.source,
    e.verificationStatus === 'verified' ? 'Verified' : 'Needs review',
    e.notes,
    e.expenseId,
  ];
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}

export function expensesToCsv(list: readonly Expense[], ctx: ExportContext): string {
  return '﻿' + toCsv([[...EXPORT_COLUMNS], ...list.map((e) => expenseRow(e, ctx))]);
}

/** RFC 4180 parser. Handles quotes, escaped quotes, CRLF/LF, and a UTF-8 BOM. */
export function parseCsv(text: string, maxRows = 20000): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new Error(`The file has more than ${maxRows} rows`);
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }
  return rows;
}

// ---------- Import ----------

export type ImportField = 'date' | 'merchant' | 'amount' | 'signedAmount' | 'type' | 'category' | 'paidBy' | 'sharedPersonal' | 'notes' | 'tax' | 'tip';

export const IMPORT_FIELDS: Array<{ field: ImportField; label: string; required?: boolean; guess: RegExp }> = [
  { field: 'date', label: 'Date', required: true, guess: /^(date|transaction date|posted)$/i },
  { field: 'merchant', label: 'Merchant / description', required: true, guess: /^(merchant|description|payee|name)$/i },
  { field: 'amount', label: 'Amount (positive)', guess: /^(amount|total)$/i },
  { field: 'signedAmount', label: 'Signed amount (negative = refund)', guess: /^signed amount$/i },
  { field: 'type', label: 'Type (Expense/Refund)', guess: /^(type|kind)$/i },
  { field: 'category', label: 'Category', guess: /^category$/i },
  { field: 'paidBy', label: 'Paid by', guess: /^paid by$/i },
  { field: 'sharedPersonal', label: 'Shared/Personal', guess: /^shared\/personal$/i },
  { field: 'notes', label: 'Notes', guess: /^(notes|memo)$/i },
  { field: 'tax', label: 'Tax', guess: /^tax$/i },
  { field: 'tip', label: 'Tip', guess: /^tip$/i },
];

export type ColumnMapping = Partial<Record<ImportField, number>>;

export function guessMapping(header: readonly string[]): ColumnMapping {
  const m: ColumnMapping = {};
  for (const f of IMPORT_FIELDS) {
    const idx = header.findIndex((h) => f.guess.test(h.trim()));
    if (idx >= 0) m[f.field] = idx;
  }
  return m;
}

export interface ImportRow {
  line: number;
  ok: boolean;
  errors: string[];
  value?: {
    transactionDate: string;
    merchantName: string;
    totalCents: number;
    kind: 'expense' | 'refund';
    categoryId: string;
    paidByMemberId: string;
    expenseType: 'shared' | 'personal';
    notes: string;
    taxCents?: number;
    tipCents?: number;
  };
}

function parseDate(s: string): string | null {
  const t = s.trim();
  if (isValidIsoDate(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = toIsoDate(y, Number(m[1]), Number(m[2]));
    return isValidIsoDate(d) ? d : null;
  }
  return null;
}

export function mapImportRows(
  rows: readonly string[][],
  mapping: ColumnMapping,
  ctx: { categories: readonly Category[]; members: readonly HouseholdMember[]; defaultMemberId: string; uncategorizedId: string },
): ImportRow[] {
  const byCatName = new Map(ctx.categories.map((c) => [c.name.toLowerCase(), c.categoryId]));
  const byMember = new Map(ctx.members.map((m) => [m.displayName.toLowerCase(), m.memberId]));
  const get = (r: readonly string[], f: ImportField) => (mapping[f] === undefined ? '' : (r[mapping[f]!] ?? '').trim());
  return rows.map((r, i) => {
    const errors: string[] = [];
    const date = parseDate(get(r, 'date'));
    if (!date) errors.push('Date is missing or not YYYY-MM-DD / MM/DD/YYYY');
    const merchant = sanitizeText(get(r, 'merchant').replace(/^'/, ''), 120);
    if (!merchant) errors.push('Merchant is missing');
    let cents: number | null = null;
    let kind: 'expense' | 'refund' = /refund|credit/i.test(get(r, 'type')) ? 'refund' : 'expense';
    try {
      if (get(r, 'signedAmount')) {
        const s = parseCents(get(r, 'signedAmount').replace(/^'/, ''), { allowNegative: true });
        cents = Math.abs(s);
        kind = s < 0 ? 'refund' : kind;
      } else if (get(r, 'amount')) {
        const a = parseCents(get(r, 'amount').replace(/^'/, ''), { allowNegative: true });
        cents = Math.abs(a);
        if (a < 0) kind = 'refund';
      }
    } catch {
      errors.push('Amount is not a number');
    }
    if (cents === null && !errors.some((e) => e.startsWith('Amount'))) errors.push('Amount is missing');
    const optCents = (f: ImportField) => {
      const v = get(r, f);
      if (!v) return undefined;
      try {
        return parseCents(v);
      } catch {
        errors.push(`${f} is not a number`);
        return undefined;
      }
    };
    const taxCents = optCents('tax');
    const tipCents = optCents('tip');
    const catName = get(r, 'category').toLowerCase();
    const categoryId = (catName && byCatName.get(catName)) || ctx.uncategorizedId;
    const paidBy = byMember.get(get(r, 'paidBy').toLowerCase()) ?? ctx.defaultMemberId;
    const expenseType = /personal/i.test(get(r, 'sharedPersonal')) ? 'personal' : 'shared';
    const ok = errors.length === 0;
    return {
      line: i + 2,
      ok,
      errors,
      value: ok
        ? { transactionDate: date!, merchantName: merchant, totalCents: cents!, kind, categoryId, paidByMemberId: paidBy, expenseType, notes: sanitizeText(get(r, 'notes'), 2000), taxCents, tipCents }
        : undefined,
    };
  });
}
