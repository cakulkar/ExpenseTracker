# Developer guide

## Requirements
- Node.js 20 or newer (CI uses 22) and npm.
- For end-to-end tests: Playwright's Chromium (`npx playwright install chromium`).
- Optional: Python 3 + Pillow, to regenerate icons (`npm run icons`).

## Commands

```bash
npm install                  # install dependencies
cp .env.example .env.local   # optional: add VITE_GOOGLE_CLIENT_ID for real Drive sync
npm run dev                  # dev server at http://localhost:5173 (copies OCR assets first)
npm run typecheck            # TypeScript checks
npm test                     # unit + integration tests (Vitest), including real OCR on a fixture image
npm run test:e2e             # builds with .env.e2e and runs Playwright (the 15 required flows + PWA/offline)
npm run build                # production build into dist/ (set VITE_BASE_PATH=/ExpenseTracker/ for Pages)
npm run preview              # serve the production build
npm run licenses             # regenerate docs/DEPENDENCIES.md and fail on non-permissive runtime licenses
```

`npm run ocr-assets` copies the Tesseract worker, WebAssembly core and English model into `public/tesseract/` (git-ignored). The `dev`, `build` and `test` scripts run it automatically.

## Rules the code follows
- **Money is integer cents.** Parse with `parseCents`, display with `formatCents`. Never `parseFloat` money.
- **Calendar dates are `YYYY-MM-DD` strings** in the household timezone. Instants are UTC ISO strings.
- **All writes go through `LedgerRepo`**, which saves locally and appends a `SyncOperation` with HLC field versions in one transaction. Use `repo.tx(() => repo.createIn/updateIn/setDeletedIn(...))` for new entity types.
- **Deletes are tombstones** (`deletedAt`).
- **Never log user data** (amounts, merchants, OCR text, keys, tokens).
- **Untrusted text** goes through `sanitizeText`. Never use `dangerouslySetInnerHTML`.
- **Schema changes:** add `this.version(n+1)` with `.upgrade()` and a migration test; bump `SCHEMA_VERSION` in `domain/types.ts` if op payloads change shape. Old app versions refuse newer sync files with a clear message.
- **Pure logic** belongs in `src/domain/` with unit tests.

## Testing approach

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | money, dates/timezone/DST/leap years, HLC, passcode, crypto, filters/totals, budgets, recurrence, insights, receipt parser (6 receipt fixtures), classification, duplicates, image helpers, CSV/XLSX/PDF |
| Integration | Vitest + fake-indexeddb + `tests/support/fakeDrive.ts` | IndexedDB CRUD, op log, tombstones, migrations, backups, two-device sync, conflicts, offline/retry, auth expiry, quota, tampering, schema versions, receipt upload/retry, retention, restart recovery, **real Tesseract OCR** |
| End-to-end | Playwright (Chromium) | The 15 required workflows with fake Google sign-in and fake Drive across two browser contexts; PWA install manifest and offline reload with the real service worker |
| Manual | docs/MANUAL_TEST_PLAN.md | Real Google OAuth and Drive |

`FakeDrive` implements the Drive v3 endpoints the app uses at the HTTP level, so the real `HttpDriveApi` client (backoff, error mapping, multipart upload) is exercised. It supports fault injection (`failNext`, `quotaFull`, invalid tokens).

## Extending categorization
Add merchants to `MERCHANT_ALIASES` or keywords to `KEYWORDS` in `src/domain/classify.ts`, and receipt layouts to `PROFILES` in `src/domain/receiptParser.ts`. Then add a fixture and test.
