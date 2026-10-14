# PocketLedger — Architecture

PocketLedger is one installable **Progressive Web App** for Windows, Android and iOS/iPadOS. It's static files on GitHub Pages, so there's no server, no paid service and no database. Data lives in each device's IndexedDB. The two spouses share an **encrypted** copy through the household's Google Drive.

```
┌──────────────── Device (browser / installed PWA) ────────────────┐
│ React UI ──► LedgerRepo ──► IndexedDB (Dexie)                    │
│                │  every write = record + SyncOperation (HLC)     │
│ Tesseract.js (WASM, self-hosted) ◄── receipt image (canvas)      │
│ Web Crypto: AES-GCM-256 · HKDF · PBKDF2                          │
│ SyncEngine ──► encrypt ──► Google Drive API (drive.file scope)   │
└──────────────────────────────────────────────────────────────────┘
                        │ HTTPS, Bearer token (memory only)
                ┌───────▼────────────────────────────┐
                │ Google Drive (shared household acct)│
                │ PocketLedger/ … encrypted files     │
                └─────────────────────────────────────┘
```

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Platform | Single React 19 + TypeScript PWA (Vite) | One codebase, free, no app store. A native iOS wrapper would need Apple's paid developer account. |
| Hosting | GitHub Pages + GitHub Actions | Free HTTPS. |
| Google account | One shared household Gmail on every device | No Drive sharing or invitations needed. |
| Drive scope | `drive.file` only | The narrowest scope. The app sees only files it created. |
| Member identity | Each device picks "who uses this device" | A shared Google account can't tell the spouses apart. |
| Daily unlock | 6-digit passcode per device | Fast to type. It's never used as an encryption key (see Security). |
| Shared-data encryption | Random 256-bit household key, wrapped by a 160-bit recovery key | Strong against offline guessing, even if the Gmail account is compromised. |
| Receipt images | Encrypted before upload by default, with a setting to turn this off | Most private option. |
| Timezone | `America/Detroit` | Used for "today", month boundaries and retention deadlines. |
| Money | Integer cents everywhere; refunds are a separate `kind` | No floating-point errors. |
| Charts | Hand-written accessible SVG | No chart library; each chart has a screen-reader data table. |
| XLSX | Custom SpreadsheetML writer plus `fflate` | Small dependency footprint. |

## Code layout

```
src/
  domain/        Pure, unit-tested logic (no I/O):
                 money, dates, expenseQuery (filters/totals), expenseInput (validation), budget, recurrence,
                 insights, classify (categorization), receiptParser (OCR text → fields), duplicates, categories, types
  db/            schema.ts (Dexie versions + migrations), repo.ts (all writes + op log), settings.ts, backup.ts
  crypto/        crypto.ts — envelopes, household key, recovery key, password backups, SHA-256
  drive/         driveApi.ts (Drive v3 client with backoff), auth.ts (Google Identity Services token model)
  sync/          hlc.ts, merge.ts (conflict-detecting merge), engine.ts (push/pull/snapshots/receipts/retention), status.ts
  ocr/           image.ts (EXIF, rotate, crop, contrast, thumbnails), ocr.ts (Tesseract worker), lines.ts
  export/        csv.ts (export + import), xlsx.ts, reports.ts (CSV/XLSX/PDF builders)
  lock/          passcode.ts
  ui/            App, Shell, router, contexts, screens/, components/, theme.css
tests/
  unit/ integration/   Vitest (+ fake-indexeddb, FakeDrive HTTP fake, real Tesseract in Node)
  e2e/                 Playwright: the 15 required flows + PWA offline test
  support/fakeDrive.ts In-memory Drive v3 HTTP fake (shared by Vitest and Playwright)
  fixtures/            Synthetic receipts (text + images), with no real personal data
scripts/         copy-ocr-assets.mjs, licenses.mjs, make_icons.py
```

## Local database (IndexedDB, Dexie) — schema version 2

| Table | Key | Synced | Notes |
|---|---|---|---|
| household | householdId | ✓ | name, timezone, currency, schemaVersion |
| members | memberId | ✓ | displayName, role (owner/member), status. No email or other personal data. |
| expenses | expenseId | ✓ | All spec fields, plus `kind` (expense/refund), transactionTime, receiptNumber, paymentMethod (brand only), fieldProvenance, ocrConfidence |
| lineItems | lineItemId | ✓ | description, quantity, unitPriceCents, totalCents, confidence, manuallyVerified |
| categories | categoryId | ✓ | 22 defaults with fixed IDs; user categories; one level of subcategories; archive |
| budgets | budgetId | ✓ | overall or per category; limit; warning %; **scope** (all / shared only); start/end month |
| receipts | receiptId | ✓ | Drive file ID, SHA-256 hash, encrypted flag, retention deadline/basis, upload and deletion status and attempts. **No image bytes.** |
| recurring | recurringExpenseId | ✓ | frequency, interval, **anchorDate**, nextDueDate, expected amount, lastMatchedExpenseId |
| merchantRules | ruleId | ✓ | normalized merchant pattern → category |
| syncOps | operationId | — | Local outgoing operation log |
| receiptBlobs | receiptId | — | Image bytes (ArrayBuffer): the original until uploaded, then a thumbnail until expiry |
| conflicts | conflictId | — | Concurrent edits waiting for a decision |
| deletionAudit | receiptId | — | Minimal record: deadline, result, time, verified, attempts |
| appliedOps / deferredOps | operationId | — | Idempotency and out-of-order handling |
| settings | key | — | Device-only: deviceId, memberId, passcode hash, household key, Drive IDs, cursors |

Every synced record carries `recordVersion` and `fieldVersions` (an HLC per field). Deletes are tombstones (`deletedAt`) that are never purged, so a deleted record can't come back.

**Migration v1 → v2** added `fieldVersions` to members and the household, `scope` to budgets, retry counters to receipts, and the local-only tables. Old version blocks are never edited. It's tested in `tests/integration/migrations.test.ts`.

## Encryption

```
Household Data Key (HDK) — 256-bit random, created once
  ├─ Drive: household.key.json = AES-GCM(HDK) under HKDF-SHA-256(recovery key, 16-byte salt)
  │          recovery key = 160 random bits shown as XXXX-XXXX-…-XXXX (Crockford base32); never stored anywhere
  └─ Each device: HDK as a NON-EXTRACTABLE CryptoKey in IndexedDB
Every uploaded blob: "PLE1" ‖ 96-bit random IV ‖ AES-GCM-256 ciphertext+tag, with associated data {type, id}
Password backups: PBKDF2-SHA-256 (600,000 iterations) → AES-GCM-256
```

## Sync protocol

Drive layout. Folder IDs are discovered at runtime and stored in device settings.

```
PocketLedger/
  household.key.json
  HouseholdSync/ops/        ops-<deviceId>-<seq 8 digits>.bin     (appProperties: deviceId, seq)
  HouseholdSync/snapshots/  snap-<time>-<deviceId>.bin            (latest 2 per device kept)
  Receipts/<yyyy>/<mm>/     <receiptId>.bin (encrypted) or .jpg   (appProperties: receiptId)
  Exports/                  optional encrypted backups
```

1. **Local first.** Each write updates IndexedDB and appends a `SyncOperation` in the same transaction. The UI never waits for the network.
2. **Push.** Pending ops are batched (up to 500) under a sequence number recorded *before* the upload. Before uploading, the device checks whether that file name already exists. A retry after a crash therefore never duplicates a batch, and the ops are marked synced only afterwards.
3. **Single writer per file.** A device only creates files named with its own device ID and never modifies them, so no locks are needed.
4. **Pull.** The device lists op files and keeps a per-device cursor (the last applied sequence). It applies only contiguous new batches; a gap waits for the next sync. Each file must decrypt (GCM tag), match the household, device and sequence in its name, and have a supported schema version. Otherwise sync stops with a clear error.
5. **Merge (`sync/merge.ts`).** Ops from all devices are applied in HLC order. For each field: if the local version is ≤ the version the remote had seen, take the remote value. Otherwise the edits were concurrent: equal values need nothing; different values keep the higher HLC on **both** devices (so they converge) and record a **Conflict** holding the other value. The user's choice is a new edit that resolves the conflict everywhere. A delete concurrent with an edit keeps the tombstone and records a conflict so the user can restore. Side-effect fields (upload status, `updatedAt`, …) resolve automatically by clock. Applied op IDs are remembered, so replays have no effect.
6. **Snapshots.** After every 300 pushed ops (and on the first connection), a device uploads an encrypted full snapshot including the cursors. A new device loads the newest snapshot that decrypts, then applies the ops after it.
7. **Guarantees.** Each file upload is atomic on Drive. Sync overall is **eventually consistent, not real-time**. It runs on open, on foreground, when the network returns, every 5 minutes while open, and 4 seconds after local changes. A Web Lock prevents two tabs from syncing at once. Nothing runs while all devices are closed.

## Receipts

Capture (camera, file, or up to 20 at once) → validate (JPEG/PNG/WebP, 15 MB or less) → decode with EXIF orientation → rotate/crop (pointer or keyboard) → JPEG at quality 0.85, longest edge 2000 px, plus a 320 px thumbnail → grayscale and contrast stretch for OCR → Tesseract (LSTM, English) → `parseReceipt` (labels, dates, US formats, retailer profiles for Costco, Walmart, Target, Kroger, Meijer, fuel stations and restaurants, OCR decimal repair on labelled lines) → arithmetic check (warning only) → `classify` → `findDuplicates` → review screen with source badges (read / guessed / entered by hand / low confidence / not found) → confirmation required for uncertain merchant, date or total → saved locally → uploaded at the next sync → the original is removed locally after upload, keeping only the thumbnail.

**Retention:** the deadline is the transaction date plus two calendar years in America/Detroit (Feb 29 becomes Feb 28), or the save date if no date is known. It moves if the expense date is corrected. The retention manager runs at app start and after every sync. It permanently deletes the Drive file (skipping the trash), confirms that Drive returns 404, clears local copies, marks the receipt deleted (synced) and writes an audit row. Failures retry after 1 min, 5 min, 30 min, 2 h, then 12 h, and can be retried manually. The expense is never touched.

## Budgets and recurring bills

- **Budgets.** Spending is the month's non-deleted expenses minus refunds. A category budget includes its subcategories, and each expense counts once. Scope *all* counts shared and personal spending; scope *shared* counts shared only. Alerts fire once per budget, month and threshold (the warning level and 100%).
- **Recurring bills.** Occurrence n is the anchor date plus n periods, with month-end clamping that doesn't drift (Jan 31 → Feb 28 → Mar 31). Bills are shown as overdue, due within 7 days, upcoming or paused. *Mark paid* first offers likely existing matches (same merchant or amount within ±10 days) before creating a new expense. Nothing is marked paid automatically.
