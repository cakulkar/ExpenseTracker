# Google Cloud OAuth setup (free)

PocketLedger signs in to Google **only** to reach Google Drive for receipts and encrypted sync. It requests one
permission: `https://www.googleapis.com/auth/drive.file`, which lets the app see and manage **only the files it
created**. It can't read the rest of your Drive, your email, or anything else.

There is no client secret. The app uses Google Identity Services' browser "token model", which needs only a
public Client ID. Never create or paste a client secret anywhere in this project.

Since you both use **one shared household Gmail**, do these steps while signed in to that account.

## 1. Create a project
1. Go to https://console.cloud.google.com/ → project picker → **New project** → name `PocketLedger` → Create.
2. No billing account is needed for this.

## 2. Enable the Drive API
**APIs & Services → Library → Google Drive API → Enable.**

## 3. Configure the consent screen
In **APIs & Services → OAuth consent screen** (newer consoles call this **Google Auth Platform → Branding / Audience / Data access**):
1. **App name** `PocketLedger`, **user support email** the household Gmail, **developer contact** the same.
2. **Audience / User type:** External.
3. **Data access / Scopes → Add:** `.../auth/drive.file` only. It's a non-sensitive scope, so no Google verification
   review is required.
4. **Test users:** add the household Gmail.
5. **Publishing status.** Either choice is free:
   - *Testing*: fine for personal use with listed test users. Google may show an "unverified app" warning; click
     Continue.
   - *In production*: with only `drive.file`, you can publish without a verification review, which removes the 7-day
     consent expiry that applies to some flows in Testing mode.

## 4. Create the Client ID
**APIs & Services → Credentials → Create credentials → OAuth client ID**
- Application type: **Web application**, name `PocketLedger web`.
- **Authorized JavaScript origins**, origins only with no path:
  - `https://cakulkar.github.io`
  - `http://localhost:5173` (dev server)
  - `http://localhost:4173` (preview server)
- **Authorized redirect URIs:** leave empty. The token model uses a popup and needs no redirect URI.
- Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).

## 5. Give the Client ID to the app
- Local development: copy `.env.example` to `.env.local` and set `VITE_GOOGLE_CLIENT_ID=...`.
- GitHub Pages: add a repository **variable** `GOOGLE_CLIENT_ID` (see DEPLOY.md).

## Token lifecycle
- Access tokens last about **1 hour** and are kept **in memory only**. They're never written to IndexedDB,
  localStorage, logs or Drive.
- Browser apps using the token model get **no refresh token**. After expiry, automatic syncs pause and the status shows
  **Sign-in required**. Tapping **Sign in & sync** gets a new token; usually it's one tap, because Google remembers your consent.
  Local entry keeps working the whole time, and queued changes upload after signing in.
- Signing in is only used to reach Drive. Decrypting the household data also needs the recovery key.
- Revoke access any time at https://myaccount.google.com/permissions.
