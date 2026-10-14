/**
 * Report builders shared by CSV/XLSX/PDF exports. All exports use the same filtered list, so totals match
 * the dashboard. Receipt expiry never removes expense records from exports.
 */
import type { Budget, Category, Expense, HouseholdMember, Receipt } from '../domain/types';
import { computeTotals } from '../domain/expenseQuery';
import { computeBudgetStatuses } from '../domain/budget';
import { formatCents } from '../domain/money';
import { formatDate, formatMonth, type MonthKey } from '../domain/dates';
import { EXPORT_COLUMNS, expenseRow, expensesToCsv, safeCell, type ExportContext } from './csv';
import { buildXlsx, type Cell } from './xlsx';

export interface ReportData {
  title: string;
  rangeLabel: string;
  expenses: Expense[];
  categories: Map<string, Category>;
  categoryParents: Map<string, string | undefined>;
  members: Map<string, HouseholdMember>;
  receipts: Map<string, Receipt>;
  budgets: Budget[];
  /** Month for budget comparison in the PDF (single-month reports). */
  month?: MonthKey;
}

export function receiptStatusLabel(e: Expense, receipts: Map<string, Receipt>): string {
  if (!e.receiptId) return 'None';
  const r = receipts.get(e.receiptId);
  if (!r) return 'Attached';
  if (r.deletionStatus === 'deleted') return 'Image expired/deleted';
  if (r.uploadStatus === 'uploaded') return 'In Google Drive';
  return 'On device (not uploaded yet)';
}

function ctxOf(d: ReportData): ExportContext {
  return { categories: d.categories, members: d.members, receiptStatus: (e) => receiptStatusLabel(e, d.receipts) };
}

export function buildCsv(d: ReportData): string {
  return expensesToCsv(d.expenses, ctxOf(d));
}

export function categorySummary(d: ReportData): Array<{ name: string; cents: number; count: number }> {
  const totals = computeTotals(d.expenses, d.categoryParents);
  const counts = new Map<string, number>();
  for (const e of d.expenses) {
    if (e.deletedAt) continue;
    const top = d.categoryParents.get(e.categoryId) ?? e.categoryId;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...totals.byCategory.entries()]
    .map(([id, cents]) => ({ name: d.categories.get(id)?.name ?? 'Unknown', cents, count: counts.get(id) ?? 0 }))
    .sort((a, b) => b.cents - a.cents);
}

export function buildXlsxReport(d: ReportData): Uint8Array {
  const ctx = ctxOf(d);
  const moneyCols = new Set<string>(['Amount', 'Signed amount', 'Subtotal', 'Tax', 'Tip', 'Discount']);
  const header = [...EXPORT_COLUMNS];
  const txRows: Cell[][] = [header];
  for (const e of d.expenses) {
    const row = expenseRow(e, ctx);
    txRows.push(
      row.map((v, i) => {
        if (moneyCols.has(header[i]!) && v !== '') return { money: Math.round(Number(v) * 100) };
        return safeCell(v);
      }),
    );
  }
  const totals = computeTotals(d.expenses, d.categoryParents);
  const summary: Cell[][] = [['Category', 'Transactions', 'Net amount'], ...categorySummary(d).map((c) => [c.name, c.count, { money: c.cents }] as Cell[])];
  summary.push([], ['Total', totals.count, { money: totals.netCents }], ['Shared', null, { money: totals.sharedCents }], ['Personal', null, { money: totals.personalCents }], ['Refunds', null, { money: -totals.refundCents }]);
  const byMember: Cell[][] = [['Paid by', 'Net amount'], ...[...d.members.values()].map((m) => [m.displayName, { money: totals.byMember.get(m.memberId) ?? 0 }] as Cell[])];
  const info: Cell[][] = [['PocketLedger export'], ['Range', d.rangeLabel], ['Created', new Date().toLocaleString('en-US')], ['Records', d.expenses.length], ['Currency', 'USD']];
  return buildXlsx([
    { name: 'Transactions', rows: txRows, widths: [12, 28, 9, 12, 13, 22, 18, 12, 12, 14, 11, 9, 9, 10, 14, 14, 22, 9, 10, 12, 40, 38] },
    { name: 'By category', rows: summary, widths: [28, 14, 14] },
    { name: 'By person', rows: byMember, widths: [20, 14] },
    { name: 'About', rows: info, widths: [14, 40] },
  ]);
}

/** PDF monthly report (jsPDF is loaded only when needed). */
export async function buildPdfReport(d: ReportData): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const totals = computeTotals(d.expenses, d.categoryParents);
  doc.setFontSize(18);
  doc.text(d.title, 40, 50);
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(`${d.rangeLabel} · ${totals.count} transactions · generated ${new Date().toLocaleDateString('en-US')}`, 40, 68);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 85,
    head: [['Household total', 'Shared', 'Personal', 'Refunds']],
    body: [[formatCents(totals.netCents), formatCents(totals.sharedCents), formatCents(totals.personalCents), formatCents(totals.refundCents)]],
    theme: 'grid',
    headStyles: { fillColor: [31, 111, 92] },
  });

  const cats = categorySummary(d);
  autoTable(doc, {
    head: [['Category', 'Transactions', 'Amount', 'Share']],
    body: cats.map((c) => [c.name, String(c.count), formatCents(c.cents), totals.netCents > 0 ? `${Math.round((c.cents * 100) / totals.netCents)}%` : '']),
    headStyles: { fillColor: [31, 111, 92] },
    columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' } },
  });

  if (d.month) {
    const statuses = computeBudgetStatuses(d.budgets, d.expenses, d.month, d.categoryParents);
    if (statuses.length) {
      autoTable(doc, {
        head: [[`Budgets — ${formatMonth(d.month)}`, 'Limit', 'Spent', 'Remaining', 'Used']],
        body: statuses.map((s) => [
          s.budget.categoryId ? d.categories.get(s.budget.categoryId)?.name ?? 'Category' : 'Overall',
          formatCents(s.limitCents),
          formatCents(s.spentCents),
          formatCents(s.remainingCents),
          `${Math.floor(s.percentUsed)}%`,
        ]),
        headStyles: { fillColor: [31, 111, 92] },
      });
    }
  }

  autoTable(doc, {
    head: [['Date', 'Merchant', 'Category', 'Paid by', 'Amount']],
    body: d.expenses
      .filter((e) => !e.deletedAt)
      .map((e) => [
        formatDate(e.transactionDate),
        e.merchantName,
        d.categories.get(e.categoryId)?.name ?? '',
        d.members.get(e.paidByMemberId)?.displayName ?? '',
        (e.kind === 'refund' ? '−' : '') + formatCents(e.totalCents),
      ]),
    headStyles: { fillColor: [31, 111, 92] },
    columnStyles: { 4: { halign: 'right' } },
    styles: { fontSize: 9 },
  });
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`PocketLedger · page ${i} of ${pages}`, 40, doc.internal.pageSize.getHeight() - 20);
  }
  return new Uint8Array(doc.output('arraybuffer'));
}
