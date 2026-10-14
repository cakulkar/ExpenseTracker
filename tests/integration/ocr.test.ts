/**
 * Runs the real Tesseract.js engine (Node build, same model files the app self-hosts) on a fixture receipt
 * image and feeds its output through the app's parser.
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorker } from 'tesseract.js';
import { parseReceipt, type OcrLine } from '../../src/domain/receiptParser';
import { classify } from '../../src/domain/classify';
import { linesFromTesseract } from '../../src/ocr/lines';

const root = join(__dirname, '../..');

describe('real OCR on a fixture receipt', () => {
  it('extracts merchant, date, total and category from a photographed-style receipt', async () => {
    const worker = await createWorker('eng', 1, { langPath: join(root, 'public/tesseract/lang'), gzip: true, cacheMethod: 'none' });
    try {
      const img = readFileSync(join(root, 'tests/fixtures/images/kroger-receipt.jpg'));
      const { data } = await worker.recognize(img, {}, { blocks: true, text: true });
      const lines: OcrLine[] = linesFromTesseract(data);
      expect(lines.length).toBeGreaterThan(8);
      const r = parseReceipt(lines, { today: '2026-10-14' });
      expect(r.merchant?.value).toBe('Kroger');
      expect(r.date?.value).toBe('2026-10-09');
      expect(r.total?.value).toBe(1505);
      expect(r.subtotal?.value).toBe(1505);
      expect(r.lineItems.length).toBeGreaterThanOrEqual(3);
      expect(classify({ merchantName: r.merchant!.value, lineItems: r.lineItems.map((l) => l.description) }).categoryId).toBe('cat-groceries');
    } finally {
      await worker.terminate();
    }
  }, 120_000);
});
