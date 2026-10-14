# Security and privacy

See also [THREAT_MODEL.md](THREAT_MODEL.md).

## Where data lives

| Data | Where | Who can read it |
|---|---|---|
| Expenses, categories, budgets, rules | IndexedDB on each device | Anyone using that unlocked browser profile |
| Shared ledger (op batches and snapshots) | Google Drive, **AES-GCM-256 encrypted** | Only devices holding the household key |
| Receipt images | On the capturing device until uploaded, then Google Drive (**encrypted by default**) until 2 years after purchase | Devices holding the household key. If encryption is turned off, anyone with access to the Google account. |
| Household key | Each device, as a non-extractable Web Crypto key | Never leaves the device in usable form |
| Recovery key | Shown once; you store it | You |
| Passcode | Never stored; only a salted PBKDF2-SHA-256 hash (310,000 iterations) | — |
| Google access token | Memory only, about 1 hour | The running app |
| Downloaded exports and backups | Wherever you save them | Anyone with the file, unless it's an encrypted backup |

Google stores your receipt images because you asked for receipts to be kept in Drive. That's different from local-only storage: the files sit on Google's servers. With encryption on (the default), Google holds unreadable bytes. If you turn encryption off, the images are ordinary JPEGs readable by anyone who can sign in to the account.

**No analytics, advertising, crash reporting, AI services or bank connections.** The app makes network requests to its own site (for app files and the OCR engine) and to Google's sign-in and Drive endpoints. The Content-Security-Policy in `index.html` enforces this. Receipt text is read on the device by Tesseract (WebAssembly).

**Logging.** The code never logs amounts, merchants, notes, OCR text, passcodes, keys or tokens. Live-query errors are deliberately silent.

## Keys and secrets

- **Google sign-in** gives access to Drive files. The **recovery key** unlocks the data. Neither is enough alone.
- **Recovery key.** 160 random bits, turned into a key with HKDF-SHA-256. It wraps the 256-bit household key. Because it's random and long, offline guessing is infeasible.
- **6-digit passcode.** An app lock for each device: 5 free tries, then waits doubling from 30 seconds up to 1 hour, plus auto-lock after time in the background. It is **not** an encryption key, because a million combinations can be tried offline in minutes. It doesn't stop someone who controls your unlocked computer or browser profile (they could read IndexedDB directly or run code in the page). Keep the device's own screen lock and disk encryption on.
- **Encrypted backups** use a password you choose (12 or more characters) with PBKDF2-SHA-256 at 600,000 iterations. A weak password weakens the backup.
- **Nonces.** Every encryption uses a fresh random 96-bit IV, well within NIST limits for this volume of data.
- **No client secret** exists anywhere. The OAuth Client ID is public by design.

## Input handling

- User text, OCR text and CSV fields are stripped of control characters and length-limited. React escapes all output, and no raw HTML is rendered.
- CSV exports prefix cells that start with `= + - @` to prevent formula injection. XLSX text is XML-escaped.
- Remote sync data is authenticated by AES-GCM, and its op shape and record types are validated before they're applied. Forbidden keys (`__proto__` and similar) are rejected.
- Image uploads are checked for type and size before decoding.

## Implications

| Situation | Effect | What to do |
|---|---|---|
| Someone uses your unlocked phone | They can see the ledger | Rely on auto-lock and the passcode; keep the phone locked |
| Device stolen while locked | The passcode limits guessing in the app UI; data in browser storage is protected mainly by device encryption | Device PIN or biometrics plus disk encryption; join a new device with the recovery key |
| Google account compromised | The attacker can **delete or corrupt** Drive files but can't read the ledger or encrypted receipts | 2-Step Verification; keep encrypted backups; tampered files are rejected by GCM |
| Recovery key leaked **and** account compromised | The attacker can decrypt the Drive data | Create a new household (export, set up fresh, import) and store the new key safely |
| Recovery key forgotten | Existing devices keep working; new devices can't join | Restore an encrypted backup on new devices |
| Passcode forgotten | That device must be reset | Clear site data, then rejoin from Drive (recovery key) or restore a backup |
| Malicious browser extension or malware | Can read anything the page can | Out of scope for a web app; use trusted devices |

This is end-to-end encrypted between your devices **for data in Google Drive**. It isn't a defense against compromised devices.
