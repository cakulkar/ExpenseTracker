// Copies the self-hosted OCR engine into public/tesseract so receipt OCR runs fully
// locally and offline (no CDN). Runs automatically before `dev`, `build` and `test:e2e`.
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

const tjsDir = dirname(require.resolve('tesseract.js/package.json'));
const coreDir = dirname(createRequire(join(tjsDir, 'package.json')).resolve('tesseract.js-core/package.json'));
const langDir = dirname(require.resolve('@tesseract.js-data/eng/package.json'));

const out = join(root, 'public', 'tesseract');
mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });

const copies = [
  [join(tjsDir, 'dist', 'worker.min.js'), join(out, 'worker.min.js')],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']
    .filter((f) => existsSync(join(coreDir, f)))
    .map((f) => [join(coreDir, f), join(out, 'core', f)]),
  // "best_int" LSTM model: good accuracy, ~3 MB
  [join(langDir, '4.0.0_best_int', 'eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz')],
];

for (const [from, to] of copies) {
  if (!existsSync(to) || statSync(to).size !== statSync(from).size) copyFileSync(from, to);
}
console.log(`OCR assets ready in public/tesseract (${copies.length} files)`);
