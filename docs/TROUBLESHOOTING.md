# Troubleshooting

## Sync status meanings

| Status | Meaning | What to do |
|---|---|---|
| Local only | Drive isn't connected on this device | **Sync & Drive → Connect Google Drive**, or join with the recovery key |
| Up to date | Everything has been uploaded and downloaded | — |
| Local changes pending | Changes are saved here and waiting to upload | They'll upload at the next sync. Tap **Sync now** to send them now. |
| Uploading / Downloading | Sync is running | Wait |
| Sign-in required | The Google token expired (about every hour) or was revoked | Tap **Sign in & sync** |
| Drive storage full | Google refused uploads | Free up space in Google Drive (receipts are small; check other files and the trash) |
| Conflict needs attention | You both changed the same thing before syncing | **Sync & Drive → Edits that need a decision** |
| Sync failed | Network or Google error, or a damaged file | The app retries automatically. See the message on the Sync page. |
| Recovery key needed | Drive is set up but this device lost its key | Enter the recovery key on the Sync page |

## Common problems

**"Google sign-in is not configured"**
The build has no `VITE_GOOGLE_CLIENT_ID`. Set the `GOOGLE_CLIENT_ID` repository variable and redeploy (see DEPLOY.md and OAUTH_SETUP.md).

**Sign-in popup doesn't appear or closes immediately**
- Allow popups for the site.
- On iPhone, use the Home Screen app; Safari private mode can block it.
- Check that `https://cakulkar.github.io` is listed under **Authorized JavaScript origins** in Google Cloud.

**"Error 400: redirect_uri_mismatch" or "origin_mismatch"**
The authorized origin must be exactly `https://cakulkar.github.io`, with no path and no trailing slash.

**"Access blocked: app has not completed the Google verification process"**
Add the household Gmail as a **test user**, or publish the app (with only `drive.file`, no review is needed).

**"That recovery key doesn't match this household"**
Check for typos. The letters O and I/L are treated as 0 and 1, and spaces and dashes are ignored. Make sure you're signed in to the same Google account that created the household.

**Spouse's changes don't appear**
Both devices must sync: open the app on both, or tap **Sync now**. Both must be signed in to the **same** Google account.

**"A sync file failed validation"**
A file in `PocketLedger/HouseholdSync/ops` was changed or damaged. Sync stops rather than applying it. Find the newest `ops-…` file from the device named in the error, move it to Drive's trash, and sync again. That device re-uploads anything still pending.

**"Another device uses a newer version"**
Update this app: reload it, and tap **Update now** when shown.

**Receipt reading is poor**
- Flatten the receipt, use even light, and fill the frame.
- Crop to the receipt and keep **Improve contrast** on.
- Thermal receipts fade; scan them soon after purchase.
- Every field can be edited, and you can choose **Enter details by hand**.

**"HEIC photos can't be read"**
Take the photo with the in-app **Take photo** button, or set iPhone **Settings → Camera → Formats → Most Compatible**.

**The first scan is slow**
The OCR engine (about 4 MB) downloads once from the app's own site, then works offline.

**App asks for the passcode too often**
Settings → Security → Lock automatically after… (1–30 minutes in the background).

**The app shows an old version**
Close all of its windows and open it again; tap **Update now** if offered. On iPhone, remove and re-add the Home Screen icon only after syncing.

**Data disappeared on iPhone**
iOS may clear storage for sites not installed to the Home Screen. Rejoin from Drive with the recovery key, or restore a backup. Always open the app from the Home Screen icon.

## Developer issues

- `npm test` fails in `ocr.test.ts`: run `npm run ocr-assets`. `npm test` does this automatically through `pretest`.
- Playwright can't find a browser: run `npx playwright install chromium`.
- Port 4174 already in use when running e2e tests: stop the other preview server.
