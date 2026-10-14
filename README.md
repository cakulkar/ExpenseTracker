# PocketLedger

A free, private household expense tracker for two people. It's one installable web app (PWA) for Windows, Android, iPhone and iPad.

- **Works offline.** Every entry is saved on the device first.
- **Receipts.** Snap a photo, and text is read **on the device** (Tesseract.js). You review and correct the details, it suggests a category, and it warns about duplicates.
- **Shared and encrypted.** Both spouses sync through the household's Google Drive. The ledger is encrypted on the device before upload; Google sees only unreadable files.
- **Receipt images** are kept in Drive (encrypted by default) and deleted automatically two years after the purchase date. The expense record stays.
- **Dashboard and planning:** dashboard and charts, monthly budgets with alerts, recurring bills, rule-based insights.
- **Your data:** CSV/XLSX/PDF exports, CSV import, encrypted backups.
- **Free and private:** no bank connections, ads, analytics or AI services, and no paid hosting, database or backend.

> PocketLedger is a website you install to your home screen or desktop. It's not a native app and isn't in any app store.

## Quick start (developers)

Requires Node.js 20 or newer.

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit + integration tests (includes real OCR)
npm run test:e2e     # Playwright end-to-end tests (run `npx playwright install chromium` once)
npm run build        # production build into dist/
```

## Guides

| Guide | For |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Installing on Windows, Android, iPhone/iPad, and setting up both devices |
| [docs/OAUTH_SETUP.md](docs/OAUTH_SETUP.md) | Creating the free Google Cloud OAuth Client ID |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Publishing free on GitHub Pages |
| [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md) | Recovery key, backups, lost devices, forgotten passcode |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Sync states and common problems |
| [docs/SECURITY.md](docs/SECURITY.md) · [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Privacy and security model |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design, database schema, sync protocol |
| [docs/DEVELOPER.md](docs/DEVELOPER.md) | Code layout, conventions, tests |
| [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) | Dependency and license inventory |
| [docs/MANUAL_TEST_PLAN.md](docs/MANUAL_TEST_PLAN.md) | Checking real Google OAuth and Drive |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | Acceptance checklist, limitations, what's incomplete |

## License

MIT
