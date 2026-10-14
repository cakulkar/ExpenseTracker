# Acceptance checklist, limitations and status

Test results below were produced on 2026-10-14 in the build environment (Linux, Node 22, Chromium 141):

- `npm run typecheck`: clean
- `npm test`: **13 files, 140 tests passed**, including real Tesseract OCR on a fixture receipt
- `npm run test:e2e`: **9 Playwright tests passed**, run twice with no failures. They cover all 15 required workflows plus PWA/offline.
- `npm run licenses`: 499 packages audited; no runtime package outside the permissive allow-list
- `npm run build`: succeeds; 21 files (about 1.4 MB) precached for offline use; the OCR engine is cached on first use

**Not executed by me:** real Google OAuth and Drive (only the HTTP-level fake), Safari/WebKit, and physical iPhone, Android and Windows devices. Use [MANUAL_TEST_PLAN.md](MANUAL_TEST_PLAN.md) for those.

## Definition of done

| Requirement | Status | Evidence |
|---|---|---|
| Installable PWA on Windows/Android/iOS (documented browser support) | ✅ Built; ⚠️ not verified on physical devices | Manifest + service worker; `pwa.spec.ts`; INSTALL.md |
| Manual expense entry works offline | ✅ | `pwa.spec.ts` (offline reload + entry), flow 11 |
| Receipt OCR runs locally | ✅ | Self-hosted Tesseract; `ocr.test.ts`; flows 2–5 |
| Users can correct extracted values | ✅ | Review screen; flow 3 |
| Confirmed receipts upload to Google Drive | ✅ (fake Drive) | flow 5; `sync.test.ts` receipts |
| Receipt images scheduled for deletion after 2 years | ✅ | `retentionDeadlineFor`; flow 14; retention tests |
| Expense records remain after receipt deletion | ✅ | flow 14; retention tests |
| Two spouses can securely share household data | ✅ (fake Drive) | Recovery-key join; flow 12; `sync.test.ts` |
| Sync doesn't silently lose concurrent edits | ✅ | Field-level merge + conflict records; flow 13; conflict tests |
| Dashboard, charts, budgets, search, trends from real data | ✅ | flows 1, 6, 7; domain tests |
| Recurring expenses tracked without accidental duplicates | ✅ | Match-before-create; flow 8 |
| CSV, XLSX, PDF exports | ✅ | flow 10; `export.test.ts` |
| Local backup and restore | ✅ | Encrypted + plain; flow 15; repo tests |
| No bank connections or paid AI services | ✅ | Dependency list; CSP |
| No readable financial dataset uploaded to Drive | ✅ | Test scans every fake-Drive file for plaintext |
| Critical automated tests pass | ✅ | See above |
| Setup, installation, privacy and recovery docs | ✅ | docs/ |

## Feature checklist

**Platform**
- ✅ One React + TypeScript codebase; responsive desktop sidebar and mobile bottom navigation
- ✅ Manifest (name, icons including maskable, theme colors, standalone); HTTPS via GitHub Pages
- ✅ App-shell precache; OCR engine cached on first use; update prompt
- ✅ Camera capture (`capture="environment"`) and file upload; touch-friendly controls of 44 px or more
- ✅ Keyboard navigation, labelled form fields, skip link, focus moved to the page heading on navigation, live-region status messages, chart data tables for screen readers
- ✅ Visible sync status (8 states) and last-successful-sync time

**Household and security**
- ✅ Shared Google account; Drive scope `drive.file` only; no client secret; tokens in memory only
- ✅ Owner + member records; "who uses this device"; entered-by and paid-by on every expense; shared/personal labels
- ✅ Separate device settings; shared categories, budgets, rules and recurring bills
- ✅ Client-side AES-GCM-256 encryption; HKDF recovery key wrapping a random household key; non-extractable device key
- ✅ Join requires the recovery key, not just Google sign-in
- ✅ 6-digit passcode lock with backoff and auto-lock (honestly described); ❌ device biometric unlock (WebAuthn) not implemented
- ✅ Threat model; no secrets in the repo; no sensitive logging; CSV and XML escaping; validation of synced data

**Receipts**
- ✅ Photo, upload, batch of up to 20, retake/replace, EXIF orientation, rotate, crop (pointer and keyboard), contrast enhancement, all local
- ✅ JPEG/PNG/WebP validation, 15 MB limit, HEIC guidance
- ✅ Extracts merchant, date, time, receipt number, subtotal, tax, tip, discount, total, payment method (brand only), line items with quantity and unit price, confidence, and warnings
- ✅ Extracted / inferred / manual provenance shown and stored; nothing invented (inferred total clearly marked)
- ✅ Arithmetic checks are warnings only, tolerant of discounts and rounding
- ✅ Retailer profiles: Costco, Walmart, Target, Kroger, Meijer, fuel stations, restaurants
- ✅ Review screen with image, editable fields, suggested category and reason, low-confidence highlights, duplicate warning; confirmation required for uncertain critical fields
- ✅ Image stored in Drive after confirmation (encrypted by default); local original removed after upload; random file names
- ✅ Duplicate upload prevention (name and appProperties checks); retry with backoff; pending and failed uploads shown
- ✅ Editable categories (22 defaults, user categories, subcategories, archive); transparent rule engine (household rules → about 200 known merchants → line items → keywords); offers to remember repeated corrections as a synced rule
- ✅ Retention: transaction date + 2 years (America/Detroit), queued and retried, permanent delete plus verification, local cleanup, audit record, manual delete, status shown

**Ledger, budgets, recurring, reporting**
- ✅ Manual form with all fields; refund/credit type; edit, delete (tombstone), restore, detail view
- ✅ Search and filters by date, merchant, amount, category, payer, shared/personal, receipt, recurring, verification; sorting
- ✅ Duplicate detection by image hash, receipt number, and merchant + amount + date; never auto-deletes; keep both or attach the image to the existing expense
- ✅ Dashboard: 6 summary cards, donut, monthly bars, daily trend, budget vs actual, per-spouse comparison, recent transactions; month, custom range, scope, member and category filters applied consistently
- ✅ Budgets: overall and per category, custom threshold, start/end months, shared-only option; amount, spent, remaining, percent and over-budget shown; alerts deduplicated
- ✅ Recurring: weekly/monthly/quarterly/yearly with custom intervals; drift-free month-end and leap-year handling; upcoming and overdue; link existing or create new; skip
- ✅ Exports: CSV, XLSX (transactions, by category, by person), PDF monthly report; filters for date, category, merchant, amount, payer; warning before unencrypted export; works after receipts expire
- ✅ CSV import with column mapping, validation, duplicate check and preview
- ✅ Encrypted backup (download or save to Drive) and restore; plain backup with warning
- ✅ Rule-based insights with "How is this calculated?": category increase, near/over budget, bills due or overdue, large transactions, missing receipts, pending/failed uploads

## Known limitations (by design or platform)

1. **No background work while every device is closed.** Sync, receipt uploads and retention deletions run only while the app is open on some device. A deletion can therefore happen after its exact date; overdue deletions are shown.
2. **iOS:** no Background Sync; Safari may evict storage for non-installed sites; Google sign-in needs a tap after the hourly token expires.
3. **Google sign-in lasts about 1 hour per session** (browser token model, no refresh token). Re-signing in is a tap.
4. **Drive metadata is visible** to anyone in the Google account: number, size and timing of files, and device IDs in file names. Content is not.
5. **Receipt images aren't in backup files.** They live in Drive until expiry.
6. **OCR quality** depends on the photo. The parser is tuned for US receipts in English and was tested on synthetic receipts, not a large real-world set. Every field is editable.
7. **Rule-based categorization** guesses from merchant names. Big-box stores sell many kinds of things, so expect to correct some categories.
8. **One shared Google account.** Two separate Google accounts sharing one household (a shared Drive folder) aren't supported with the `drive.file` scope as implemented.
9. **Concurrent edits to the same field** are resolved automatically by clock and listed for review. They're never silently lost, but they still need a person to confirm.
10. **The passcode is an app lock, not encryption at rest.** Device security protects data in browser storage.
11. **Deleted expenses stay as tombstones** (so they can't come back through sync). They don't count in totals, and you can see them with "Show deleted".

## Incomplete or partially implemented

- **Device-authentication app lock** (Windows Hello, Face ID or fingerprint via WebAuthn): **not implemented.** The spec allowed a password alternative, which is the 6-digit passcode.
- **Merge of two existing expenses:** the duplicate flow can attach a new receipt image to an existing expense, but there's no field-by-field merge of two saved expenses. You keep both or delete one.
- **Per-line-item categories:** line items are stored and editable on the review screen, but they can't be assigned their own category or edited after saving.
- **Category icon and color editing:** user categories get a default icon and color; there's no editor in the UI.
- **Cross-browser automated testing:** end-to-end tests run on Chromium (desktop and mobile emulation) only. WebKit/Safari and Firefox weren't run.
- **Real Google OAuth/Drive:** verified only against the fake; needs the manual test plan.
