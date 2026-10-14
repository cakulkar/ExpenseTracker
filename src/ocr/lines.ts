import type { OcrLine } from '../domain/receiptParser';

interface TLine {
  text: string;
  confidence: number;
}
interface TesseractData {
  text?: string;
  confidence?: number;
  blocks?: Array<{ paragraphs?: Array<{ lines?: TLine[] }> }> | null;
}

/** Convert Tesseract.js output into ordered lines with per-line confidence. */
export function linesFromTesseract(data: TesseractData): OcrLine[] {
  const out: OcrLine[] = [];
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        const text = l.text.replace(/\s+$/, '');
        if (text.trim()) out.push({ text, confidence: l.confidence });
      }
    }
  }
  if (out.length === 0 && data.text) {
    for (const t of data.text.split('\n')) if (t.trim()) out.push({ text: t, confidence: data.confidence ?? 50 });
  }
  return out;
}
