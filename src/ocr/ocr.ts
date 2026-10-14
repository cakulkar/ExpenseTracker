/**
 * Local OCR with Tesseract.js. The worker, WebAssembly core and English model are self-hosted under
 * /tesseract/ (see scripts/copy-ocr-assets.mjs), so no receipt image or text is sent anywhere.
 * The first scan downloads ~3–4 MB of model files from this app's own site; after that they are cached
 * and OCR works offline.
 */
import type { OcrLine } from '../domain/receiptParser';
import { linesFromTesseract } from './lines';

type Worker = Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>>;

let workerPromise: Promise<Worker> | null = null;
let progressListener: ((p: number, status: string) => void) | null = null;

function assetBase(): string {
  return new URL(`${import.meta.env.BASE_URL}tesseract/`, window.location.origin).href;
}

async function getWorker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    const base = assetBase();
    return createWorker('eng', 1, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}core`,
      langPath: `${base}lang`,
      gzip: true,
      workerBlobURL: false,
      logger: (m: { status: string; progress: number }) => progressListener?.(m.progress, m.status),
    });
  })().catch((e) => {
    workerPromise = null;
    throw e;
  });
  return workerPromise;
}

export async function recognizeReceipt(image: HTMLCanvasElement | Blob, onProgress?: (p: number, status: string) => void): Promise<OcrLine[]> {
  progressListener = onProgress ?? null;
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
    return linesFromTesseract(data as Parameters<typeof linesFromTesseract>[0]);
  } finally {
    progressListener = null;
  }
}

/** Free OCR memory (e.g. when leaving the scan screen on a phone). */
export async function releaseOcr(): Promise<void> {
  const w = workerPromise;
  workerPromise = null;
  if (w) await (await w).terminate().catch(() => undefined);
}
