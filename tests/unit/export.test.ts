import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { guessMapping, mapImportRows, parseCsv, safeCell, toCsv } from '../../src/export/csv';
import { buildCsv, buildPdfReport, buildXlsxReport, type ReportData } from '../../src/export/reports';
import type { Category, Expense, HouseholdMember } from '../../src/domain/types';

const cats = new Map<string, Category>([
  ['cat-groceries', { categoryId: 'cat-groceries', name: 'Groceries' } as Category],
  ['cat-uncategorized', { categoryId: 'cat-uncategorized', name: 'Uncategorized' } as Category],
]);
const members = new Map<string, HouseholdMember>([['a', { memberId: 'a', displayName: 'Chinu' } as HouseholdMember], ['b', { memberId: 'b', displayName: 'Spouse' } as HouseholdMember]]);
const e = (p: Partial<Expense>): Expense => ({
  expenseId: crypto.randomUUID(), householdId: 'h', kind: 'expense', merchantName: 'Kroger', merchantNormalized: 'kroger', transactionDate: '2026-10-05',
  createdAt: '', updatedAt: '', createdByMemberId: 'a', paidByMemberId: 'a', expenseType: 'shared', categoryId: 'cat-groceries', totalCents: 4510,
  currencyCode: 'USD', notes: '', source: 'manual', verificationStatus: 'verified', recordVersion: '', fieldVersions: {}, ...p,
});
const data = (expenses: Expense[]): ReportData => ({
  title: 'October 2026', rangeLabel: 'Oct 1 – Oct 31, 2026', expenses, categories: cats, categoryParents: new Map(), members,
  receipts: new Map(), budgets: [], month: '2026-10',
});

describe('CSV', () => {
  it('escapes quotes, commas, newlines and blocks formula injection', () => {
    expect(toCsv([['a,b', 'say "hi"', 'line1\nline2']])).toBe('"a,b","say ""hi""","line1\nline2"\r\n');
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeCell('-5')).toBe("'-5");
  });
  it('round-trips an export through the importer', () => {
    const csv = buildCsv(data([e({ notes: 'milk, "organic"' }), e({ kind: 'refund', totalCents: 500, merchantName: '=cmd', paidByMemberId: 'b', expenseType: 'personal' })]));
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(3);
    const mapping = guessMapping(rows[0]!);
    expect(mapping.date).toBe(0);
    const imported = mapImportRows(rows.slice(1), mapping, { categories: [...cats.values()], members: [...members.values()], defaultMemberId: 'a', uncategorizedId: 'cat-uncategorized' });
    expect(imported.every((r) => r.ok)).toBe(true);
    expect(imported[0]!.value).toMatchObject({ merchantName: 'Kroger', totalCents: 4510, kind: 'expense', categoryId: 'cat-groceries', notes: 'milk, "organic"' });
    expect(imported[1]!.value).toMatchObject({ merchantName: '=cmd', totalCents: 500, kind: 'refund', paidByMemberId: 'b', expenseType: 'personal' });
  });
  it('reports row errors with line numbers', () => {
    const rows = parseCsv('Date,Merchant,Amount\n2026-13-01,X,1\n10/05/2026,,abc\n10/05/2026,Ok,-2.50\n');
    const r = mapImportRows(rows.slice(1), guessMapping(rows[0]!), { categories: [], members: [], defaultMemberId: 'a', uncategorizedId: 'u' });
    expect(r[0]).toMatchObject({ ok: false, line: 2 });
    expect(r[1]!.errors).toEqual(expect.arrayContaining(['Merchant is missing', 'Amount is not a number']));
    expect(r[2]!.value).toMatchObject({ transactionDate: '2026-10-05', totalCents: 250, kind: 'refund' });
  });
});

describe('XLSX', () => {
  it('builds a valid workbook with transactions and category summary', () => {
    const bytes = buildXlsxReport(data([e({}), e({ totalCents: 1000, merchantName: 'A & B <test>' })]));
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/styles.xml']));
    const s1 = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(s1).toContain('A &amp; B &lt;test&gt;');
    expect(s1).toContain('<v>45.10</v>');
    expect(strFromU8(files['xl/worksheets/sheet2.xml']!)).toContain('<v>55.10</v>');
  });
});

describe('PDF', () => {
  it('produces a PDF document', async () => {
    const bytes = await buildPdfReport(data([e({}), e({ kind: 'refund', totalCents: 100 })]));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(2000);
  });
});
