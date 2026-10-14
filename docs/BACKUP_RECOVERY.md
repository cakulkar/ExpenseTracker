# Backup and recovery manual

Your ledger can survive the loss of a device in three independent ways:

1. **The other device.** Each device keeps a full copy in its browser storage.
2. **Google Drive.** It holds an encrypted copy (snapshots plus a change log) and the receipt images.
3. **Your backup files.** Encrypted backups you download or save to Drive.

## Things to keep safe (write them down)

| Item | Used for | If lost |
|---|---|---|
| **Household recovery key** (`XXXX-XXXX-…`, 8 groups) | Unlocking the Drive data on a new device | Existing devices keep working. New devices can only be set up from a backup. |
| **Backup password** (12+ characters) | Opening encrypted backup files | Those backup files can't be opened |
| **6-digit passcode** (per device) | Opening the app on that device | Reset that device (see below) |
| **Shared Gmail password + 2-Step Verification** | Reaching Drive | Use Google's account recovery |

Store the recovery key and backup password together: in a password manager both of you can reach, or printed and kept with important papers.

## Making backups

- **Reports & backup → Encrypted backup → Download encrypted backup.** This saves a `.plbackup.json` file encrypted with your password. It includes every expense, category, budget, recurring bill, rule and receipt record, but not receipt images.
- **Save encrypted backup to Drive** puts the same file in `PocketLedger/Exports/`.
- **Unencrypted backup** is a readable JSON file. The app warns you first. Use it only if you need to read the data in another tool.
- Suggested habit: one encrypted backup a month, kept off the phone (for example on your laptop or a USB drive).

The app shows "Last backup" in Settings.

## Recovery scenarios

### A phone is lost, replaced or reset
1. Install PocketLedger on the new device (see INSTALL.md).
2. Choose **Join our household from Google Drive**, sign in with the household Google account, and enter the **recovery key**.
3. Pick who uses the device, then set a new passcode. The app downloads the latest snapshot and changes.

Any changes the lost phone never synced are gone. Everything it synced is still in Drive.

### Forgot this device's passcode
The passcode can't be recovered or bypassed in the app.
1. If possible, sync first from the other device so nothing is lost.
2. Clear the site's data:
   - **iPhone:** delete the Home Screen app and reinstall it.
   - **Android/Chrome:** Settings → Site settings → All sites → cakulkar.github.io → Clear & reset.
   - **Windows Edge/Chrome:** uninstall the app, then clear site data.
3. Rejoin from Drive with the recovery key, or restore a backup.

### Lost the recovery key, but a device still works
Make an encrypted backup from the working device straight away. To make a new recovery key:
1. Restore that backup onto a fresh setup.
2. Disconnect from Drive and rename the old `PocketLedger` folder in Drive.
3. Connect again, which creates a new household key and recovery key.
4. Have the other device join with the new key.

### Google Drive data deleted or damaged
Devices keep working locally.
- **Damaged:** if sync reports that a file failed validation, remove the bad file from `PocketLedger/HouseholdSync/ops` (or restore the folder from Drive's trash).
- **Deleted:** if the whole folder was deleted, use **Disconnect** on each device and connect again from the device with the most complete data. This creates a new key. Then join from the other device.

### Both devices lost
Set up a new device and use **Restore from a backup file** with your latest encrypted backup and its password. If Drive still exists and you have the recovery key, use **Join our household from Google Drive** instead; that's usually more up to date.

### Restoring a backup on a device that already has data
**Reports & backup → Restore** replaces all ledger data on that device. If the device is connected to Drive, the restored records sync. Newer edits already in Drive win field by field, and restored records that Drive no longer has are uploaded again.

## Receipt images and backups

Backups contain receipt **metadata**, not images. Images live in Drive until their 2-year deadline. Once an image is deleted (automatically or by you), it can't be recovered by the app. The expense record and all its amounts stay forever unless you delete them.

## Local data retention

- Expense records stay on each device until you delete them, or erase the device in **Settings → Erase all data on this device**. The app warns you if changes haven't synced.
- Original receipt images are removed from the device once uploaded. Thumbnails stay until the image's retention deadline.
- The local sync log keeps uploaded changes for 60 days, then prunes them.
- **Uninstalling** the app or clearing site data deletes everything on that device. Sync or back up first.
- **iPhone/iPad** may clear website data that isn't installed to the Home Screen and hasn't been used for weeks. Always use the Home Screen app.
