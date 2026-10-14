import { describe, expect, it } from 'vitest';
import { centsToInput, formatCents, parseCents, percentOf, signedAmount, sumCents, tryParseCents } from '../../src/domain/money';

describe('parseCents', () => {
  it.each([
    ['12', 1200], ['12.5', 1250], ['12.50', 1250], ['0.99', 99], ['.5', 50], ['$1,234.56', 123456],
    [' 7.01 ', 701], ['0', 0], ['1,000', 100000], ['0.10', 10], ['19.99', 1999],
  ])('parses %s -> %d', (input, expected) => {
    expect(parseCents(input)).toBe(expected);
  });

  it('avoids floating point error', () => {
    // 0.1 + 0.2 style problems: 1.15 * 100 = 114.99999999999999 in floats
    expect(parseCents('1.15')).toBe(115);
    expect(parseCents('4.35')).toBe(435);
    expect(parseCents('1.005'.slice(0, 4))).toBe(100);
  });

  it.each(['', 'abc', '1.234', '1,23.00', '12..3', '$', '.', '1 2', '1e5'])('rejects %s', (input) => {
    expect(() => parseCents(input)).toThrow();
  });

  it('rejects negatives by default and allows them on request', () => {
    expect(() => parseCents('-3.20')).toThrow(/refund/);
    expect(parseCents('-3.20', { allowNegative: true })).toBe(-320);
    expect(parseCents('(12.00)', { allowNegative: true })).toBe(-1200);
    expect(parseCents('-0.00')).toBe(0);
  });

  it('rejects absurdly large amounts', () => {
    expect(tryParseCents('1000000000000')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats US currency', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(-500)).toBe('-$5.00');
    expect(formatCents(0)).toBe('$0.00');
  });
  it('round-trips through the input format', () => {
    for (const c of [0, 1, 99, 100, 1050, 123456, -250]) {
      expect(parseCents(centsToInput(c), { allowNegative: true })).toBe(c);
    }
  });
  it('rejects non-integer cents', () => {
    expect(() => formatCents(1.5)).toThrow();
  });
});

describe('arithmetic', () => {
  it('sums integer cents exactly', () => {
    expect(sumCents([10, 20, 30])).toBe(60);
    expect(sumCents(Array(1000).fill(1))).toBe(1000);
    expect(() => sumCents([1.1])).toThrow();
  });
  it('treats refunds as negative', () => {
    expect(signedAmount({ totalCents: 500, kind: 'expense' })).toBe(500);
    expect(signedAmount({ totalCents: 500, kind: 'refund' })).toBe(-500);
  });
  it('computes percentages deterministically', () => {
    expect(percentOf(8000, 10000)).toBe(80);
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(5, 0)).toBe(Infinity);
  });
});
