/**
 * Deterministic receipt parser: OCR lines → candidate fields.
 *
 * Principles
 * - Never invent values. A field is either `extracted` (read from a labelled line), `inferred`
 *   (derived by a documented rule, e.g. "largest amount on the receipt" when no TOTAL line exists),
 *   or missing.
 * - Confidence (0–1) = OCR confidence of the source line × how certain the rule is.
 * - Arithmetic mismatches produce warnings, never rejections.
 * - OCR text is untrusted: it is length-limited and stripped of control characters.
 */
import { addDays, isValidIsoDate, toIsoDate, type IsoDate } from './dates';
import { findAlias } from './classify';
import { normalizeMerchant } from './expenseQuery';
import { sanitizeText } from './expenseInput';

export interface OcrLine {
  text: string;
  /** 0–100 from the OCR engine */
  confidence: number;
}

export interface ParsedField<T> {
  value: T;
  confidence: number;
  provenance: 'extracted' | 'inferred';
  /** The receipt line it came from (for the review screen). */
  source?: string;
}

export interface ParsedLineItem {
  description: string;
  quantity?: number;
  unitPriceCents?: number;
  totalCents: number;
  confidence: number;
}

export interface ParsedReceipt {
  merchant?: ParsedField<string>;
  date?: ParsedField<IsoDate>;
  time?: ParsedField<string>;
  receiptNumber?: ParsedField<string>;
  subtotal?: ParsedField<number>;
  tax?: ParsedField<number>;
  tip?: ParsedField<number>;
  discount?: ParsedField<number>;
  total?: ParsedField<number>;
  paymentMethod?: ParsedField<string>;
  currency: 'USD';
  lineItems: ParsedLineItem[];
  warnings: string[];
  /** Mean OCR confidence of all lines, 0–1. */
  ocrConfidence: number;
  retailerProfile?: string;
}

// ---------- amounts ----------

const AMOUNT_RE = /(-)?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\s?[.,]\s?(\d{2})(?!\d)\s*(-|CR\b)?/g;

/** All money amounts in a line, in cents, in order. "1.00-" and "-1.00" are negative. */
export function amountsInLine(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    // Skip things that look like dates (10.13.26) or times
    const digitAt = (m.index ?? 0) + m[0].search(/\d/);
    const before = digitAt > 0 ? line[digitAt - 1]! : '';
    if (/[\d/:.]/.test(before)) continue;
    const whole = Number(m[2]!.replace(/,/g, ''));
    const cents = whole * 100 + Number(m[3]);
    if (!Number.isSafeInteger(cents) || cents > 10_000_000_00) continue;
    out.push(m[1] || m[4] ? -cents : cents);
  }
  return out;
}

/**
 * OCR often reads the decimal point of a labelled amount as '-', ':' or ' ' ("TOTAL 15-05").
 * Only applied to labelled lines (TOTAL/TAX/…) and only to a trailing amount, never to dates/times.
 */
export function fixOcrDecimal(line: string): string {
  if (/\b(am|pm)\b|\d{1,2}\/\d{1,2}\//i.test(line)) return line;
  return line.replace(/(\d)\s?[-:]\s?(\d{2})\s*$/, '$1.$2');
}

function lastAmount(line: string): number | undefined {
  const a = amountsInLine(line);
  return a.length ? a[a.length - 1] : undefined;
}

// ---------- dates & times ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function yearFrom(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

export function datesInLine(line: string): IsoDate[] {
  const out: IsoDate[] = [];
  const l = line.toLowerCase();
  for (const m of l.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const d = toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (isValidIsoDate(d)) out.push(d);
  }
  // US order MM/DD/YY(YY); fall back to DD/MM when the first part can't be a month.
  for (const m of l.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = yearFrom(m[3]!);
    const us = toIsoDate(y, a, b);
    const eu = toIsoDate(y, b, a);
    if (isValidIsoDate(us)) out.push(us);
    else if (isValidIsoDate(eu)) out.push(eu);
  }
  for (const m of l.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    const d = toIsoDate(Number(m[3]), MONTHS.indexOf(m[1]!.slice(0, 3)) + 1, Number(m[2]));
    if (isValidIsoDate(d)) out.push(d);
  }
  for (const m of l.matchAll(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/g)) {
    const d = toIsoDate(Number(m[3]), MONTHS.indexOf(m[2]!) + 1, Number(m[1]));
    if (isValidIsoDate(d)) out.push(d);
  }
  return out;
}

export function timeInLine(line: string): string | undefined {
  const m = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?m?\.?\b/i.exec(line) ?? /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/.exec(line);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 23) return undefined;
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'p';
    if (h > 12 || h === 0) return undefined;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// ---------- retailer profiles ----------

interface RetailerProfile {
  name: string;
  match: RegExp;
  /** Extra lines that are NOT the final total. */
  notTotal?: RegExp;
  /** Additional labels that mean "final total". */
  totalLabel?: RegExp;
  /** Trailing tax/flag codes after item prices (e.g. " N", " T", " X"). */
  itemFlags?: RegExp;
}

const PROFILES: RetailerProfile[] = [
  { name: 'Costco', match: /costco/i, notTotal: /total number of items|items sold/i, itemFlags: /\s+[ANEY]\s*$/ },
  { name: 'Walmart', match: /wal-?mart|walmart/i, notTotal: /items sold|# items/i, itemFlags: /\s+[NXTOF]\s*$/ },
  { name: 'Target', match: /target/i, itemFlags: /\s+(?:N|T|NF|TF|F)\s*$/ },
  { name: 'Kroger', match: /kroger/i, totalLabel: /\bbalance\b/i, notTotal: /total savings|total coupons|fuel points/i, itemFlags: /\s+[BTF]{1,2}\s*$/ },
  { name: 'Meijer', match: /meijer/i, notTotal: /total savings|mperks/i, itemFlags: /\s+[NTF]\s*$/ },
  { name: 'Fuel station', match: /\b(shell|speedway|marathon|bp|mobil|exxon|sunoco|citgo|chevron|valero|circle k|sheetz|wawa|fuel)\b/i, totalLabel: /\bfuel\s+(sale|total)\b|\bsale\b/i },
  { name: 'Restaurant', match: /\b(server|table|guests?|check\s*#)\b/i, totalLabel: /\bamount\s+due\b|\bbalance\s+due\b/i },
];

// ---------- labels ----------

const SUBTOTAL = /\bsub\s*-?\s*tot(al)?\b|\bsubtl\b|\bmerchandise\s+total\b/i;
const TAX = /\b(sales\s+)?tax\b|\bhst\b|\bgst\b|\bvat\b/i;
const TAX_NOT = /pre-?tax|tax\s*exempt|non-?tax|taxable|tax\s*id|before\s+tax/i;
const TIP = /\b(tip|gratuity)\b/i;
const DISCOUNT = /\b(discount|savings|coupon|promo|you\s+saved|instant\s+savings|markdown|price\s+reduction|mfr\s+cpn|cpn)\b/i;
const TOTAL = /\b(grand\s+total|total\s+due|amount\s+due|balance\s+due|total)\b/i;
const TOTAL_NOT = /sub\s*-?\s*tot|total\s+(tax|savings|discount|coupons?|items?|qty|quantity|points)|tax\s+total|items?\s+total|you\s+saved|tip\s+total/i;
const PAYMENT_TENDER = /\b(visa|mastercard|master\s*card|mc|amex|american\s+express|discover|debit|credit|cash|ebt|apple\s*pay|google\s*pay|gift\s*card|change|tender|approved|auth|chip|contactless)\b/i;
const NON_ITEM = /\b(thank|welcome|store\s*#|st#|cashier|register|reg#|trans|terminal|tel|phone|www\.|\.com|survey|return|policy|items\s+sold|member|card\s*#|acct|account|auth|approval|ref|invoice|receipt|order\s*#|table|server|guests?|check|date|time)\b/i;

const PAYMENT_NAMES: Array<[RegExp, string]> = [
  [/\bvisa\b/i, 'Visa'],
  [/\b(mastercard|master\s*card)\b/i, 'Mastercard'],
  [/\b(amex|american\s+express)\b/i, 'American Express'],
  [/\bdiscover\b/i, 'Discover'],
  [/\bapple\s*pay\b/i, 'Apple Pay'],
  [/\bgoogle\s*pay\b/i, 'Google Pay'],
  [/\bebt\b/i, 'EBT'],
  [/\bgift\s*card\b/i, 'Gift card'],
  [/\bdebit\b/i, 'Debit card'],
  [/\bcash\b(?!\s*back)/i, 'Cash'],
];

const RECEIPT_NO = /\b(receipt|rcpt|trans(?:action)?|tran|invoice|inv|order|ticket|check|ref)\s*(?:#|no\.?|num(?:ber)?|id)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{2,24})\b/i;

function isMostlyLetters(s: string): boolean {
  const letters = (s.match(/[a-z]/gi) ?? []).length;
  return letters >= 3 && letters / Math.max(1, s.replace(/\s/g, '').length) >= 0.5;
}

const ADDRESS = /^\d+\s+\w+|\b(st|street|ave|avenue|rd|road|blvd|hwy|highway|dr|drive|ln|lane|suite|ste)\b\.?|\b[A-Z]{2}\s+\d{5}(-\d{4})?\b|\(\d{3}\)|\d{3}[-.\s]\d{3}[-.\s]\d{4}/i;
const HEADER_NOISE = /\b(welcome|thank|receipt|customer\s+copy|merchant\s+copy|sale|duplicate|copy)\b/i;

function clean(text: string): string {
  return sanitizeText(text.replace(/\s+/g, ' '), 200);
}

export interface ParseOptions {
  /** Today in the household timezone; dates later than today+1 get a warning. */
  today: IsoDate;
}

export function parseReceipt(rawLines: readonly OcrLine[], opts: ParseOptions): ParsedReceipt {
  const lines = rawLines
    .map((l) => ({ text: clean(l.text), conf: Math.max(0, Math.min(100, l.confidence)) / 100 }))
    .filter((l) => l.text.length > 0)
    .slice(0, 400);
  const warnings: string[] = [];
  const result: ParsedReceipt = { currency: 'USD', lineItems: [], warnings, ocrConfidence: 0 };
  if (lines.length === 0) {
    warnings.push('No text was found. Try a sharper, well-lit photo, or enter the details by hand.');
    return result;
  }
  result.ocrConfidence = Math.round((lines.reduce((s, l) => s + l.conf, 0) / lines.length) * 100) / 100;

  const headerText = lines.slice(0, 10).map((l) => l.text).join(' ');
  const profile = PROFILES.find((p) => p.match.test(headerText)) ?? PROFILES.find((p) => p.match.test(lines.map((l) => l.text).join(' ')));
  if (profile) result.retailerProfile = profile.name;

  // Merchant: a known chain in the first lines, otherwise the first name-like header line.
  for (const l of lines.slice(0, 8)) {
    const alias = findAlias(normalizeMerchant(l.text));
    if (alias) {
      result.merchant = { value: alias.name, confidence: Math.max(0.85, l.conf), provenance: 'extracted', source: l.text };
      break;
    }
  }
  if (!result.merchant) {
    const cand = lines.slice(0, 6).find((l) => isMostlyLetters(l.text) && !ADDRESS.test(l.text) && !HEADER_NOISE.test(l.text) && amountsInLine(l.text).length === 0);
    if (cand) result.merchant = { value: cand.text.slice(0, 80), confidence: cand.conf * 0.8, provenance: 'extracted', source: cand.text };
  }

  // Date / time / receipt number / payment method
  for (const l of lines) {
    if (!result.date) {
      const d = datesInLine(l.text)[0];
      if (d) result.date = { value: d, confidence: l.conf, provenance: 'extracted', source: l.text };
    }
    if (!result.time || (result.time.confidence < 0 && datesInLine(l.text).length)) {
      const labelled = SUBTOTAL.test(l.text) || TAX.test(l.text) || TOTAL.test(l.text) || TIP.test(l.text) || amountsInLine(l.text).length > 0;
      const t = labelled ? undefined : timeInLine(l.text);
      if (t) result.time = { value: t, confidence: l.conf, provenance: 'extracted', source: l.text };
    }
    if (!result.receiptNumber) {
      const m = RECEIPT_NO.exec(l.text);
      if (m && /\d/.test(m[2]!)) result.receiptNumber = { value: m[2]!.toUpperCase(), confidence: l.conf * 0.9, provenance: 'extracted', source: l.text };
    }
    if (!result.paymentMethod) {
      for (const [re, name] of PAYMENT_NAMES) {
        if (re.test(l.text)) {
          result.paymentMethod = { value: name, confidence: l.conf, provenance: 'extracted', source: l.text.replace(/\d{4,}/g, '••••') };
          break;
        }
      }
    }
  }
  if (result.date) {
    if (result.date.value > addDays(opts.today, 1)) {
      warnings.push('The date on the receipt is in the future. Check it.');
      result.date.confidence *= 0.5;
    } else if (result.date.value < addDays(opts.today, -3650)) {
      warnings.push('The date on the receipt is more than 10 years old. Check it.');
      result.date.confidence *= 0.5;
    }
  }

  // Labelled amounts
  const totals: Array<{ cents: number; conf: number; text: string; idx: number }> = [];
  let firstTotalIdx = lines.length;
  let taxSum = 0;
  let taxConf = 1;
  let taxSources: string[] = [];
  let totalTaxLine: { cents: number; conf: number; text: string } | undefined;
  let discountSum = 0;
  let discountConf = 1;
  let discountFound = false;

  const LABEL = new RegExp(`${SUBTOTAL.source}|${TAX.source}|${TIP.source}|${TOTAL.source}|\\bbalance\\b`, 'i');
  lines.forEach((l, idx) => {
    const t = l.text;
    let amt = lastAmount(t);
    if (amt === undefined && LABEL.test(t)) {
      amt = lastAmount(fixOcrDecimal(t));
      if (amt !== undefined) l.conf *= 0.8; // repaired reading: lower confidence so the user checks it
    }
    if (amt === undefined) return;
    if (SUBTOTAL.test(t)) {
      if (!result.subtotal) result.subtotal = { value: Math.abs(amt), confidence: l.conf, provenance: 'extracted', source: t };
      firstTotalIdx = Math.min(firstTotalIdx, idx);
      return;
    }
    if (TAX.test(t) && !TAX_NOT.test(t) && !/%\s*$/.test(t)) {
      if (/total\s+tax|tax\s+total/i.test(t)) totalTaxLine = { cents: Math.abs(amt), conf: l.conf, text: t };
      else {
        taxSum += Math.abs(amt);
        taxConf = Math.min(taxConf, l.conf);
        taxSources.push(t);
      }
      firstTotalIdx = Math.min(firstTotalIdx, idx);
      return;
    }
    if (TIP.test(t) && !/%/.test(t) && !/suggest/i.test(t)) {
      if (!result.tip) result.tip = { value: Math.abs(amt), confidence: l.conf, provenance: 'extracted', source: t };
      return;
    }
    if (DISCOUNT.test(t) && !(profile?.notTotal?.test(t) && /total/i.test(t))) {
      discountSum += Math.abs(amt);
      discountConf = Math.min(discountConf, l.conf);
      discountFound = true;
      return;
    }
    const isTotal = (TOTAL.test(t) || profile?.totalLabel?.test(t)) && !TOTAL_NOT.test(t) && !(profile?.notTotal?.test(t));
    if (isTotal && amt >= 0) {
      totals.push({ cents: amt, conf: l.conf, text: t, idx });
      firstTotalIdx = Math.min(firstTotalIdx, idx);
    }
  });
  if (totalTaxLine) {
    result.tax = { value: totalTaxLine.cents, confidence: totalTaxLine.conf, provenance: 'extracted', source: totalTaxLine.text };
  } else if (taxSources.length) {
    result.tax = { value: taxSum, confidence: taxConf, provenance: 'extracted', source: taxSources.join(' | ') };
  }
  taxSources = [];
  if (discountFound) result.discount = { value: discountSum, confidence: discountConf, provenance: 'extracted' };

  if (totals.length) {
    // Prefer an explicit "total"/"amount due" line whose amount is at least the subtotal; the last such line wins
    // (receipts often print TOTAL then the tender line).
    const sub = result.subtotal?.value ?? 0;
    const viable = totals.filter((x) => x.cents >= sub - 2);
    const pick = (viable.length ? viable : totals).reduce((best, x) => (x.cents > best.cents ? x : best));
    result.total = { value: pick.cents, confidence: pick.conf, provenance: 'extracted', source: pick.text };
  } else {
    // No TOTAL line: infer the largest amount (excluding change/cash tendered lines), clearly marked as inferred.
    let best: { cents: number; conf: number; text: string } | undefined;
    for (const l of lines) {
      if (/\bchange\b|\bcash\s+tend|\btendered\b/i.test(l.text)) continue;
      const amt = lastAmount(l.text);
      if (amt !== undefined && amt > 0 && (!best || amt > best.cents)) best = { cents: amt, conf: l.conf, text: l.text };
    }
    if (best) {
      result.total = { value: best.cents, confidence: best.conf * 0.5, provenance: 'inferred', source: best.text };
      warnings.push('No "Total" line was found. The largest amount was used as the total — please check it.');
    }
  }

  // Line items: priced lines before the first subtotal/tax/total line that aren't labels or tender lines.
  const headerEnd = Math.min(3, lines.length);
  for (let i = headerEnd; i < Math.min(firstTotalIdx, lines.length); i++) {
    const raw = lines[i]!.text;
    const t = profile?.itemFlags ? raw.replace(profile.itemFlags, '') : raw;
    const amounts = amountsInLine(t);
    if (amounts.length === 0) continue;
    if (SUBTOTAL.test(t) || TAX.test(t) || TOTAL.test(t) || TIP.test(t) || PAYMENT_TENDER.test(t) || NON_ITEM.test(t)) continue;
    const price = amounts[amounts.length - 1]!;
    if (price < 0 || DISCOUNT.test(t)) continue;
    let description = t.replace(AMOUNT_RE, ' ').replace(/\s[A-Z]\s*$/, '').replace(/\s+/g, ' ').trim();
    description = description.replace(/^\d{6,}\s*/, '').trim(); // leading SKU/UPC
    if (!/[a-z]{2,}/i.test(description)) continue;
    let quantity: number | undefined;
    let unitPriceCents: number | undefined;
    const qty = /(\d+(?:\.\d+)?)\s*(?:@|x|ea\s*@)\s*\$?(\d+\.\d{2})/i.exec(t) ?? (i > 0 ? /^(\d+(?:\.\d+)?)\s*(?:@|x)\s*\$?(\d+\.\d{2})/i.exec(lines[i - 1]!.text) : null);
    if (qty) {
      quantity = Number(qty[1]);
      unitPriceCents = Math.round(Number(qty[2]) * 100);
      description = description.replace(/(\d+(?:\.\d+)?)\s*(?:@|x|ea\s*@)\s*\$?/i, '').trim();
    }
    result.lineItems.push({ description: description.slice(0, 80), quantity, unitPriceCents, totalCents: price, confidence: lines[i]!.conf });
    if (result.lineItems.length >= 150) break;
  }

  // Arithmetic checks (warnings only)
  const w = arithmeticWarning(result);
  if (w) warnings.push(w);
  if (!result.merchant) warnings.push('The store name could not be read.');
  if (!result.date) warnings.push('No date was found on the receipt.');
  if (!result.total) warnings.push('No total was found on the receipt.');
  return result;
}

export const ARITHMETIC_TOLERANCE_CENTS = 2;

/** Checks totals with and without discounts (some receipts print subtotals already net of savings). */
export function arithmeticWarning(r: Pick<ParsedReceipt, 'subtotal' | 'tax' | 'tip' | 'discount' | 'total' | 'lineItems'>): string | null {
  const total = r.total?.value;
  if (total === undefined) return null;
  if (r.subtotal) {
    const base = r.subtotal.value + (r.tax?.value ?? 0) + (r.tip?.value ?? 0);
    const variants = [base, base - (r.discount?.value ?? 0)];
    if (variants.some((v) => Math.abs(v - total) <= ARITHMETIC_TOLERANCE_CENTS)) return null;
    return `Subtotal + tax${r.tip ? ' + tip' : ''}${r.discount ? ' (− discounts)' : ''} doesn't add up to the total. Check the amounts — some stores calculate differently, so you can still save.`;
  }
  return null;
}

/** Critical fields that must be confirmed by the user when missing, inferred or low-confidence. */
export const CRITICAL_FIELDS = ['merchant', 'date', 'total'] as const;
export const LOW_CONFIDENCE = 0.75;

export function uncertainCriticalFields(r: ParsedReceipt): Array<(typeof CRITICAL_FIELDS)[number]> {
  return CRITICAL_FIELDS.filter((f) => {
    const v = r[f];
    return !v || v.provenance === 'inferred' || v.confidence < LOW_CONFIDENCE;
  });
}
