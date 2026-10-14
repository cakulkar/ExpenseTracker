# Manual test plan — real Google OAuth and Drive

The automated tests use a fake Google sign-in and a fake Drive. Run this plan once after setting up the OAuth client (OAUTH_SETUP.md) and after any change to `src/drive/` or `src/sync/`. You need the deployed site, the shared household Google account, and two devices (for example a Windows laptop and a phone).

Mark each step ✅ or ❌, and note the device and browser.

## A. Sign-in and household creation (Device 1)
1. Open the site, set up a new household with both names, and set a passcode.
2. **Sync & Drive → Connect Google Drive.** Google asks only to "See, edit, create and delete only the specific Google Drive files you use with this app". No other permissions are requested.
3. The recovery key is shown. Typing the wrong last group keeps the button disabled; the correct group enables it.
4. In drive.google.com: the `PocketLedger` folder contains `household.key.json`, `HouseholdSync/ops`, `HouseholdSync/snapshots`, `Receipts` and `Exports`.
5. Download one `ops-…bin` file and open it in a text editor. No merchant names or amounts are readable.

## B. Join (Device 2)
6. Choose **Join our household from Google Drive**, sign in to the same account, enter the recovery key, pick the spouse's name and set a passcode.
7. Device 1's expenses appear.

## C. Two-way sync and conflicts
8. Add an expense on each device, then tap **Sync now** on both (twice). Both devices show both expenses, with the correct "paid by".
9. Edit the same expense's amount on both devices before syncing, then sync both. Each device shows one conflict. Resolve it on one device and sync both. The conflict disappears on both, and the values match.

## D. Receipts
10. On the phone, use **Scan receipt → Take photo**, then crop and **Read receipt**. Fields are filled. Correct one, save, then sync.
11. Drive has `Receipts/<year>/<month>/<id>.bin`. Opening it in Drive shows nothing readable.
12. On the other device, open the expense and tap **View full image**. The image displays.
13. **Delete image**, then sync. The file is gone from Drive and **not** in Drive's trash. The expense remains.

## E. Token lifecycle
14. Leave the app open for more than 1 hour, then tap **Sync now**. It shows "Sign-in required"; tapping it signs in again and sync completes. Local entry works the whole time.
15. Revoke access at myaccount.google.com/permissions, then sync. You're asked to sign in again; nothing is lost.

## F. Offline
16. Turn on airplane mode, add 2 expenses, and close and reopen the app. They're still there, and the status shows changes pending. Turn airplane mode off, open the app, and confirm they sync.

## G. Install
17. Install on Windows (Edge), Android (Chrome) and iPhone (Safari → Add to Home Screen). The app opens in its own window with the PocketLedger icon.

## H. Retention (optional, slow)
18. Create an expense with a receipt dated more than 2 years ago (attach any photo), then sync. The image is deleted from Drive on that sync, the log shows "Deleted from Drive (verified)", and the expense remains.

## I. Quota (optional)
19. With a full Drive, scanning still works and sync shows "Drive storage full". After freeing space, uploads complete.
