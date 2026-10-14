import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { amountsInLine, datesInLine, parseReceipt, timeInLine, uncertainCriticalFields, type OcrLine } from '../../src/domain/receiptParser';
import { classify, recordCorrection, rulePatternFor } from '../../src/domain/classify';
import { findDuplicates } from '../../src/domain/duplicates';
import type { Expense, MerchantRule, Receipt } from '../../src/domain/types';

const fixture = (name: string, confidence = 92): OcrLine[] =>
  readFileSync(join(__dirname, '../fixtures/receipts', name), 'utf8').split('\n').map((text: string) => ({ text, confidence }));
const opts = { today: '2026-10-14' };

describe('low-level extraction', () => {
  it('reads amounts including negatives and thousands', () => {
    expect(amountsInLine('SAVINGS 1.00-')).toEqual([-100]);
    expect(amountsInLine('TV $1,299.99')).toEqual([129999]);
    expect(amountsInLine('2 @ 3.49  6.98')).toEqual([349, 698]);
    expect(amountsInLine('10.09.26')).toEqual([1009]); // ambiguous; the date parser handles dates separately
  });
  it('reads US dates in several formats', () => {
    expect(datesInLine('10/09/26 6:42 PM')).toEqual(['2026-10-09']);
    expect(datesInLine('2026-10-11')).toEqual(['2026-10-11']);
    expect(datesInLine('Oct 4, 2026')).toEqual(['2026-10-04']);
    expect(datesInLine('4 October 2026')).toEqual(['2026-10-04']);
    expect(datesInLine('25/10/2026')).toEqual(['2026-10-25']);
    expect(datesInLine('13/45/2026')).toEqual([]);
  });
  it('reads times in 12h and 24h', () => {
    expect(timeInLine('6:42 PM')).toBe('18:42');
    expect(timeInLine('12:05 am')).toBe('00:05');
    expect(timeInLine('14:31:55')).toBe('14:31');
  });
});

describe('receipt parsing', () => {
  it('parses a Kroger receipt (BALANCE as total, savings, flags, quantity)', () => {
    const r = parseReceipt(fixture('kroger.txt'), opts);
    expect(r.retailerProfile).toBe('Kroger');
    expect(r.merchant?.value).toBe('Kroger');
    expect(r.date?.value).toBe('2026-10-09');
    expect(r.time?.value).toBe('18:42');
    expect(r.subtotal?.value).toBe(1405);
    expect(r.tax?.value).toBe(0);
    expect(r.total).toMatchObject({ value: 1405, provenance: 'extracted' });
    expect(r.discount?.value).toBe(100);
    expect(r.paymentMethod?.value).toBe('Visa');
    expect(r.paymentMethod?.source).not.toMatch(/4417/);
    expect(r.receiptNumber?.value).toBe('0045821');
    expect(r.lineItems.map((l) => l.description)).toEqual(['BANANAS', 'GREEK YOGURT', 'MILK 1 GAL', 'BREAD WHEAT']);
    expect(r.lineItems[1]).toMatchObject({ quantity: 2, unitPriceCents: 349, totalCents: 698 });
    expect(r.warnings).toEqual([]);
  });

  it('parses a fuel receipt', () => {
    const r = parseReceipt(fixture('shell.txt'), opts);
    expect(r.merchant?.value).toBe('Shell');
    expect(r.total?.value).toBe(3920);
    expect(r.date?.value).toBe('2026-10-11');
    expect(r.paymentMethod?.value).toBe('Debit card');
  });

  it('parses a restaurant receipt with tip and ignores suggested-tip lines', () => {
    const r = parseReceipt(fixture('restaurant.txt'), opts);
    expect(r.merchant?.value).toBe("Anita's Kitchen");
    expect(r.subtotal?.value).toBe(3225);
    expect(r.tax?.value).toBe(194);
    expect(r.tip?.value).toBe(600);
    expect(r.total?.value).toBe(4019);
    expect(r.lineItems).toHaveLength(3);
    expect(r.warnings).toEqual([]);
  });

  it('parses Walmart: ignores cash tendered/change and item flags', () => {
    const r = parseReceipt(fixture('walmart.txt'), opts);
    expect(r.merchant?.value).toBe('Walmart');
    expect(r.total?.value).toBe(3008);
    expect(r.tax?.value).toBe(170);
    expect(r.paymentMethod?.value).toBe('Cash');
    expect(r.date?.value).toBe('2026-10-02');
    expect(r.lineItems.map((l) => l.totalCents)).toEqual([1297, 347, 1194]);
  });

  it('marks an inferred total when no TOTAL line exists and never invents a date', () => {
    const r = parseReceipt(fixture('no_total.txt'), opts);
    expect(r.total).toMatchObject({ value: 800, provenance: 'inferred' });
    expect(r.date).toBeUndefined();
    expect(uncertainCriticalFields(r)).toEqual(expect.arrayContaining(['date', 'total']));
    expect(r.warnings.join(' ')).toMatch(/largest amount/);
  });

  it('warns (but still parses) when arithmetic does not add up', () => {
    const r = parseReceipt(fixture('mismatch.txt'), opts);
    expect(r.total?.value).toBe(2500);
    expect(r.warnings.join(' ')).toMatch(/doesn't add up/);
  });

  it('flags low OCR confidence on critical fields', () => {
    const r = parseReceipt(fixture('restaurant.txt', 40), opts);
    expect(uncertainCriticalFields(r)).toEqual(['merchant', 'date', 'total']);
  });

  it('handles empty input and hostile text safely', () => {
    expect(parseReceipt([], opts).warnings[0]).toMatch(/No text/);
    const r = parseReceipt([{ text: '<script>alert(1)</script>\u0000 TOTAL 5.00', confidence: 90 }], opts);
    expect(r.total?.value).toBe(500);
  });

  it('warns about future dates', () => {
    const r = parseReceipt([{ text: 'Shop', confidence: 90 }, { text: '12/30/2026', confidence: 90 }, { text: 'TOTAL 1.00', confidence: 90 }], opts);
    expect(r.warnings.join(' ')).toMatch(/future/);
  });
});

describe('classification', () => {
  it('maps known merchants', () => {
    expect(classify({ merchantName: 'KROGER #512' })).toMatchObject({ categoryId: 'cat-groceries', confidence: 'high' });
    expect(classify({ merchantName: 'NETFLIX.COM' }).categoryId).toBe('cat-subscriptions');
    expect(classify({ merchantName: "Anita's Kitchen" }).categoryId).toBe('cat-restaurants');
    expect(classify({ merchantName: 'Costco Gas #1234' }).categoryId).toBe('cat-fuel');
  });
  it('maps a fuel station to snacks when the receipt has no fuel', () => {
    expect(classify({ merchantName: 'Shell', lineItems: ['UNLEADED 39.20'] }).categoryId).toBe('cat-fuel');
    expect(classify({ merchantName: 'Shell', lineItems: ['DORITOS 2.49', 'COKE 1.99'] }).categoryId).toBe('cat-coffee');
  });
  it('uses line items and keywords for unknown merchants', () => {
    expect(classify({ merchantName: 'Joe Gas & Go', lineItems: [] }).categoryId).toBe('cat-fuel');
    expect(classify({ merchantName: 'Main Street Pharmacy' }).categoryId).toBe('cat-health');
    expect(classify({ merchantName: 'XYZ LLC', lineItems: ['RX 12345 COPAY 10.00'] }).categoryId).toBe('cat-health');
    expect(classify({ merchantName: 'XYZ LLC' })).toMatchObject({ categoryId: 'cat-uncategorized', confidence: 'low' });
    expect(classify({ merchantName: 'Rossi Pizza' }).categoryId).toBe('cat-restaurants');
  });
  it('household rules override built-ins', () => {
    const rules = [{ ruleId: 'r', merchantPattern: 'costco', categoryId: 'cat-household', priority: 100 } as MerchantRule];
    expect(classify({ merchantName: 'COSTCO WHOLESALE', rules })).toMatchObject({ categoryId: 'cat-household', confidence: 'high' });
  });
  it('offers a rule after repeated corrections', () => {
    let s = recordCorrection({}, 'target', 'cat-household');
    expect(s.offer).toBe(false);
    s = recordCorrection(s.stats, 'target', 'cat-household');
    expect(s.offer).toBe(true);
    expect(rulePatternFor('target store 1234')).toBe('target');
  });
});

describe('duplicate detection', () => {
  const e = (p: Partial<Expense>) => ({ expenseId: 'e1', merchantNormalized: 'kroger', transactionDate: '2026-10-09', totalCents: 1405, ...p }) as Expense;
  it('finds the same image, receipt number, or merchant+amount+date', () => {
    const exps = [e({}), e({ expenseId: 'e2', receiptNumber: '0045821' }), e({ expenseId: 'e3', deletedAt: 'x' })];
    const rcpts = [{ receiptId: 'r', expenseId: 'e1', imageHash: 'abc' } as Receipt];
    const m = findDuplicates({ imageHash: 'abc', merchantName: 'Kroger', transactionDate: '2026-10-10', totalCents: 1405, receiptNumber: '0045821' }, exps, rcpts);
    expect(m.map((x) => x.expense.expenseId).sort()).toEqual(['e1', 'e2']);
    expect(m.find((x) => x.expense.expenseId === 'e1')!.strength).toBe('certain');
  });
  it('does not flag different amounts or distant dates', () => {
    expect(findDuplicates({ merchantName: 'Kroger', transactionDate: '2026-10-09', totalCents: 1406 }, [e({})], [])).toHaveLength(0);
    expect(findDuplicates({ merchantName: 'Kroger', transactionDate: '2026-10-12', totalCents: 1405 }, [e({})], [])).toHaveLength(0);
  });
});

describe('image helpers', () => {
  it('validates type and size', async () => {
    const { validateImageFile } = await import('../../src/ocr/image');
    expect(validateImageFile({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(validateImageFile({ type: 'image/heic', size: 1000 })).toMatch(/HEIC/);
    expect(validateImageFile({ type: 'application/pdf', size: 1000 })).toMatch(/JPEG/);
    expect(validateImageFile({ type: 'image/png', size: 16 * 1024 * 1024 })).toMatch(/15 MB/);
  });
  it('stretches contrast and converts to grayscale', async () => {
    const { enhancePixels } = await import('../../src/ocr/image');
    const px = new Uint8ClampedArray([100, 100, 100, 255, 150, 150, 150, 255, 120, 130, 140, 255, 110, 110, 110, 255]);
    enhancePixels(px);
    expect(px[0]).toBe(0);
    expect(px[4]).toBe(255);
    expect(px[8]).toBe(px[9]);
  });
  it('repairs OCR-misread decimals only on labelled lines', () => {
    const r = parseReceipt([{ text: 'Shop', confidence: 90 }, { text: 'SUBTOTAL 15-05', confidence: 90 }, { text: 'TOTAL 15:05', confidence: 90 }, { text: '10/09/2026 6:42 PM', confidence: 90 }], opts);
    expect(r.subtotal?.value).toBe(1505);
    expect(r.total?.value).toBe(1505);
    expect(r.time?.value).toBe('18:42');
  });
});
