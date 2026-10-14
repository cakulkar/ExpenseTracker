/**
 * Money handling. All amounts are integer cents (number, safe-integer range).
 * Parsing is done on the decimal string, never through floating-point math.
 */

export type Cents = number;

export const MAX_CENTS = 99_999_999_99; // $99,999,999.99 — far above any household expense

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyParseError';
  }
}

/**
 * Parse a user- or OCR-supplied amount into cents.
 * Accepts: "12", "12.5", "12.50", "$1,234.56", " 0.99 ", ".5", "(12.00)" (treated as negative), "-3.20".
 * Rejects: more than 2 decimal places, misplaced commas, letters, empty input.
 */
export function parseCents(input: string, opts: { allowNegative?: boolean } = {}): Cents {
  if (typeof input !== 'string') throw new MoneyParseError('Amount must be text');
  let s = input.trim();
  if (s === '') throw new MoneyParseError('Enter an amount');

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  if (s.startsWith('$')) s = s.slice(1).trim();
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  }

  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d*)?$/.test(s) || s === '' || s === '.') {
    throw new MoneyParseError('Use a number like 12.34');
  }
  const [intPartRaw = '', fracRaw = ''] = s.split('.');
  if (fracRaw.length > 2) throw new MoneyParseError('Use at most two decimal places');

  const intPart = intPartRaw.replace(/,/g, '') || '0';
  const frac = (fracRaw + '00').slice(0, 2);
  if (intPart.length > 12) throw new MoneyParseError('Amount is too large');

  const cents = Number(intPart) * 100 + Number(frac);
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) throw new MoneyParseError('Amount is too large');
  if (negative && cents !== 0) {
    if (!opts.allowNegative) throw new MoneyParseError('Amount cannot be negative — use a refund instead');
    return -cents;
  }
  return cents;
}

/** Non-throwing variant; returns null when the input is not a valid amount. */
export function tryParseCents(input: string, opts?: { allowNegative?: boolean }): Cents | null {
  try {
    return parseCents(input, opts);
  } catch {
    return null;
  }
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Format cents for display, e.g. 123456 -> "$1,234.56", -500 -> "-$5.00". */
export function formatCents(cents: Cents, currency = 'USD'): string {
  assertCents(cents);
  const fmt = currency === 'USD' ? usd : new Intl.NumberFormat('en-US', { style: 'currency', currency });
  // Intl takes a float; dividing a safe integer by 100 and formatting to 2 dp is exact for display.
  return fmt.format(cents / 100);
}

/** Format cents as a plain editable string, e.g. 123456 -> "1234.56". */
export function centsToInput(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function assertCents(value: unknown): asserts value is Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Money values must be integer cents');
  }
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('Sum overflow');
  return total;
}

/** Signed amount used in totals: refunds reduce spending. */
export function signedAmount(e: { totalCents: Cents; kind: 'expense' | 'refund' }): Cents {
  return e.kind === 'refund' ? -e.totalCents : e.totalCents;
}

/** Percentage (0..∞) of used/limit, rounded down to 1 decimal place, deterministic. */
export function percentOf(used: Cents, limit: Cents): number {
  if (limit <= 0) return used > 0 ? Infinity : 0;
  return Math.floor((used * 1000) / limit) / 10;
}
