# Threat model

## Assets
1. Financial records: merchants, amounts, dates, notes, who paid.
2. Receipt images.
3. The household data key, recovery key, passcode and Google access token.
4. Availability: the ledger must not be lost.

## Trust boundaries
- **Trusted:** the user's own devices and browser while unlocked; the app code served from GitHub Pages over HTTPS.
- **Semi-trusted:** Google Drive. It stores and serves files reliably, but we assume it (or anyone who gets into the account) can read, modify, reorder or delete them.
- **Untrusted:** the network, receipt images and OCR text, imported CSV files, backup files, and any file found in Drive.

## Adversaries and mitigations

| # | Adversary or event | Attack | Mitigation | Residual risk |
|---|---|---|---|---|
| T1 | Person with the Google password | Reads Drive | All ledger data and (by default) images are AES-GCM encrypted; the key needs the recovery key | Metadata visible: file counts, sizes, times, device IDs in file names |
| T2 | Same | Modifies or swaps files | GCM authentication plus associated data binding type, device and sequence; header checks; sync stops on failure | Denial of service: sync stops until the bad file is removed |
| T3 | Same | Deletes files | Each device keeps a full local copy; snapshots and op logs are redundant; encrypted backups | If every device and backup is lost at once, data is lost |
| T4 | Same | Replays old op files | Op IDs are applied once (appliedOps); per-device cursors | — |
| T5 | Network attacker | Intercepts traffic | HTTPS only (GitHub Pages and Google APIs); strict CSP | — |
| T6 | Someone with an unlocked device | Opens the app | Passcode lock, background auto-lock, backoff on wrong codes | Can read IndexedDB with developer tools if the browser is unlocked |
| T7 | Thief with a locked device | Extracts storage | Device disk encryption (OS); the passcode isn't an encryption key | Depends on device security |
| T8 | Malicious CSV or backup file | Injection or prototype pollution | Text sanitizing, escaping, schema validation, CSV formula prefixing | — |
| T9 | Malicious receipt image | Exploit the image decoder or OCR | Browser decoders, WASM sandbox, type and size limits | Browser vulnerabilities |
| T10 | Supply chain (npm) | Malicious dependency | Minimal dependencies, lock file, license audit in CI, no runtime CDN | Inherent npm risk |
| T11 | Compromised GitHub account | Serves malicious app code | Protect GitHub with 2FA; updates need a click in installed apps | A user who updates gets the new code |
| T12 | Google OAuth token theft | Reuses the token | Token in memory only, about 1 hour, scope `drive.file` | Within that hour: Drive app files only |
| T13 | Clock skew between devices | Wrong merge order | Hybrid Logical Clock; remote clocks more than 1 day ahead are not adopted | Equal-ish edits resolve by HLC order but are always flagged as conflicts |

## Out of scope
Malware or malicious extensions on a user's device; Google itself acting maliciously beyond T1–T4; legal compulsion.

## Not claimed
- Real-time sync, or atomic multi-file transactions in Drive.
- Guaranteed deletion at an exact time, or deletion of copies the user downloaded, exported or backed up.
- That the 6-digit passcode protects data from someone with full access to the unlocked browser profile.
