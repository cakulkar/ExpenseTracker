/**
 * The 15 required end-to-end workflows, run in Chromium against the production build.
 * Google sign-in and Drive are faked (fixtures.ts); OCR runs for real in the browser.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { FakeDrive } from '../support/fakeDrive';
import { addExpense, connectDrive, enterPasscode, joinHousehold, setupHousehold, syncNow, useFakeGoogle } from './fixtures';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECEIPT = join(HERE, '../fixtures/images/kroger-receipt.jpg');
const SHELL_RECEIPT = join(HERE, '../fixtures/images/shell-receipt.jpg');

async function scanReceipt(page: Page, file: string) {
  await page.goto('./#/scan');
  await page.getByLabel('Choose receipt images').setInputFiles(file);
  await expect(page.getByRole('button', { name: 'Read receipt' })).toBeVisible();
  await page.getByRole('button', { name: 'Read receipt' }).click();
  await expect(page.getByRole('heading', { name: 'Check the details' })).toBeVisible({ timeout: 90_000 });
}

test('1, 6. create a manual expense and see it on the dashboard', async ({ page, context }) => {
  await useFakeGoogle(context, new FakeDrive());
  await setupHousehold(page);
  await addExpense(page, { merchant: 'Kroger', amount: '45.10' });
  await expect(page.getByText('Kroger').first()).toBeVisible();
  await page.goto('./#/');
  await expect(page.locator('.stat', { hasText: 'Household spending' })).toContainText('$45.10');
  await expect(page.getByText('Spending by category')).toBeVisible();
  await expect(page.locator('.legend')).toContainText('Groceries'); // suggested from the merchant name
});

test('2–5, 9. upload a receipt, OCR, correct a field, confirm the category, upload to Drive, detect the duplicate', async ({ page, context }) => {
  const drive = new FakeDrive();
  await useFakeGoogle(context, drive);
  await setupHousehold(page);
  await connectDrive(page);

  await scanReceipt(page, RECEIPT);
  // Extracted values
  await expect(page.locator('#rv-merchant')).toHaveValue('Kroger');
  await expect(page.locator('#rv-total')).toHaveValue('15.05');
  await expect(page.locator('#rv-date')).toHaveValue('2026-10-09');
  // Suggested category is shown with its reason
  await expect(page.locator('#rv-cat')).toHaveValue('cat-groceries');
  await expect(page.getByText(/Suggested: Kroger is a known merchant/)).toBeVisible();
  // Correct a field without rescanning
  await page.fill('#rv-notes', 'weekly shop');
  await page.fill('#rv-tip', '');
  const confirm = page.locator('label.check.confirm input');
  if (await confirm.count()) await confirm.check();
  await page.getByRole('button', { name: 'Save expense' }).click();
  await expect(page.getByText(/Saved Kroger · \$15\.05/)).toBeVisible();

  // Upload to Drive (encrypted)
  await syncNow(page);
  await expect.poll(() => drive.fileCount((f) => f.appProperties.kind === 'receipt')).toBe(1);
  const stored = [...drive.files.values()].find((f) => f.appProperties.kind === 'receipt')!;
  expect(Buffer.from(stored.data.slice(0, 4)).toString()).toBe('PLE1');
  await page.goto('./#/expenses');
  await expect(page.getByText('Receipt in Drive')).toBeVisible();

  // Same image again → duplicate warning, nothing deleted
  await scanReceipt(page, RECEIPT);
  await expect(page.getByText('Possible duplicate.')).toBeVisible();
  await expect(page.getByText('The same receipt image was already saved')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save expense' })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard this scan' }).click();
  await page.goto('./#/expenses');
  await expect(page.getByText('1 transaction')).toBeVisible();
});

test('7. set a budget and cross the warning threshold', async ({ page, context }) => {
  await useFakeGoogle(context, new FakeDrive());
  await setupHousehold(page);
  await page.goto('./#/budgets');
  await page.getByRole('button', { name: '+ Budget' }).click();
  await page.selectOption('#b-cat', 'cat-groceries');
  await page.fill('#b-limit', '100');
  await page.getByRole('button', { name: 'Save budget' }).click();
  await expect(page.getByText('Budget saved')).toBeVisible();
  await addExpense(page, { merchant: 'Kroger', amount: '85.00', category: 'cat-groceries' });
  await expect(page.getByText(/Groceries budget is 85% used/)).toBeVisible();
  await page.goto('./#/budgets');
  await expect(page.locator('.budget')).toContainText('$15.00');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '85');
  // The alert does not repeat for the same threshold
  await addExpense(page, { merchant: 'Kroger', amount: '1.00', category: 'cat-groceries' });
  await expect(page.getByText(/Groceries budget is \d+% used/)).toHaveCount(0);
});

test('8. add a recurring bill and mark it paid without creating a duplicate', async ({ page, context }) => {
  await useFakeGoogle(context, new FakeDrive());
  await setupHousehold(page);
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date()));
  await addExpense(page, { merchant: 'Netflix', amount: '15.99', date: today });
  await page.goto('./#/recurring');
  await page.getByRole('button', { name: '+ Recurring bill' }).click();
  await page.fill('#r-name', 'Netflix');
  await page.fill('#r-amt', '15.99');
  await page.fill('#r-anchor', today);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Recurring bill saved')).toBeVisible();
  await expect(page.getByText(/Due within 7 days|Overdue/)).toBeVisible();
  await page.getByRole('button', { name: 'Mark paid' }).click();
  await expect(page.getByText('This payment may already be entered.')).toBeVisible();
  await page.getByRole('button', { name: 'Link' }).click();
  await expect(page.getByText('Linked existing expense')).toBeVisible();
  await expect(page.getByText('Upcoming')).toBeVisible();
  await page.goto('./#/expenses');
  await expect(page.getByText('1 transaction')).toBeVisible();
  await expect(page.locator('.tag', { hasText: 'Recurring' })).toBeVisible();
});

test('10. export monthly expenses (CSV, XLSX, PDF)', async ({ page, context }) => {
  await useFakeGoogle(context, new FakeDrive());
  await setupHousehold(page);
  await addExpense(page, { merchant: 'Kroger', amount: '45.10' });
  await addExpense(page, { merchant: 'Return', amount: '5.10', refund: true });
  await page.goto('./#/reports');
  for (const [label, ext] of [['Download CSV', 'csv'], ['Download Excel (XLSX)', 'xlsx'], ['Download PDF report', 'pdf']] as const) {
    await page.getByRole('button', { name: label }).click();
    await expect(page.getByText('Export unencrypted data?')).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('dialog').getByRole('button', { name: /^Download/ }).click()]);
    expect(dl.suggestedFilename()).toMatch(new RegExp(`\\.${ext}$`));
    const path = await dl.path();
    const bytes = readFileSync(path!);
    if (ext === 'csv') {
      const text = bytes.toString('utf8');
      expect(text).toContain('Kroger');
      expect(text).toContain('-5.10');
    }
    if (ext === 'xlsx') expect(bytes.subarray(0, 2).toString()).toBe('PK');
    if (ext === 'pdf') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  }
});

test('11–13. offline entry syncs later; two members sync; a conflicting edit is resolved', async ({ browser }) => {
  const drive = new FakeDrive();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await useFakeGoogle(ctxA, drive);
  await useFakeGoogle(ctxB, drive);
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await setupHousehold(a, ['Chinu', 'Spouse'], 0);
  await addExpense(a, { merchant: 'Kroger', amount: '45.10' });
  const key = await connectDrive(a);
  await syncNow(a);

  // 12. Spouse joins on another device and sees the data
  await joinHousehold(b, key, 'Spouse');
  await b.goto('./#/expenses');
  await expect(b.getByText('Kroger')).toBeVisible();

  // 11. Offline entry on B, synced after reconnecting
  await ctxB.setOffline(true);
  await addExpense(b, { merchant: 'Corner Cafe', amount: '6.50' });
  await expect(b.getByText("You're offline")).toBeVisible();
  await expect(b.getByText('Corner Cafe')).toBeVisible();
  await ctxB.setOffline(false);
  await syncNow(b);
  await syncNow(a);
  await a.goto('./#/expenses');
  await expect(a.getByText('Corner Cafe')).toBeVisible();
  await expect(a.getByText(/Spouse paid/)).toBeVisible();

  // 13. Both change the amount before syncing → conflict on both, resolved once
  for (const [p, amt] of [[a, '50.00'], [b, '51.00']] as const) {
    await p.goto('./#/expenses');
    await p.getByText('Kroger').click();
    await p.fill('#f-amount', amt);
    await p.getByRole('button', { name: 'Save' }).click();
    await expect(p.getByRole('heading', { name: 'Expenses' })).toBeVisible();
  }
  await syncNow(a);
  await syncNow(b);
  await syncNow(a);
  await a.goto('./#/sync');
  await expect(a.getByRole('heading', { name: /Edits that need a decision \(1\)/ })).toBeVisible();
  await a.getByRole('button', { name: /Use “\$/ }).click();
  await expect(a.getByText('Conflict resolved')).toBeVisible();
  await syncNow(a);
  await syncNow(b);
  const amountA = await a.evaluate(async () => {
    const r = indexedDB.open('pocketledger');
    const db: IDBDatabase = await new Promise((ok) => (r.onsuccess = () => ok(r.result)));
    const all: Array<{ merchantName: string; totalCents: number }> = await new Promise((ok) => {
      const q = db.transaction('expenses').objectStore('expenses').getAll();
      q.onsuccess = () => ok(q.result);
    });
    return all.find((e) => e.merchantName === 'Kroger')!.totalCents;
  });
  await b.goto('./#/expenses');
  await expect(b.locator('.exp-row', { hasText: 'Kroger' })).toContainText(`$${(amountA / 100).toFixed(2)}`);
  await b.goto('./#/sync');
  await expect(b.getByText(/Edits that need a decision/)).toHaveCount(0);
  await ctxA.close();
  await ctxB.close();
});

test('14. a receipt image expires after two years but the expense stays', async ({ browser }) => {
  const drive = new FakeDrive();
  const ctx = await browser.newContext();
  await useFakeGoogle(ctx, drive);
  const page = await ctx.newPage();
  await setupHousehold(page);
  await connectDrive(page);
  await scanReceipt(page, SHELL_RECEIPT);
  await page.fill('#rv-merchant', 'Shell');
  await page.fill('#rv-total', '39.20');
  await page.fill('#rv-date', '2024-10-11');
  const confirm = page.locator('label.check.confirm input');
  if (await confirm.count()) await confirm.check();
  await page.getByRole('button', { name: 'Save expense' }).click();
  await expect(page.getByText(/Saved Shell/)).toBeVisible();
  await syncNow(page);
  await expect.poll(() => drive.fileCount((f) => f.appProperties.kind === 'receipt')).toBe(0); // 2024-10-11 + 2 years has passed by Oct 2026 → deleted on the same sync
  await page.goto('./#/expenses');
  await page.locator('.exp-row', { hasText: 'Shell' }).click();
  await expect(page.getByText(/Deleted .*\(expense kept\)/)).toBeVisible();
  await expect(page.locator('#f-amount')).toHaveValue('39.20');
  await page.goto('./#/sync');
  await page.getByText(/Deletion log on this device/).click();
  await expect(page.getByText('Deleted from Drive (verified)')).toBeVisible();
  await ctx.close();
});

test('15. restore an encrypted backup on a new device', async ({ browser }) => {
  const c1 = await browser.newContext({ acceptDownloads: true });
  await useFakeGoogle(c1, new FakeDrive());
  const p1 = await c1.newPage();
  await setupHousehold(p1);
  await addExpense(p1, { merchant: 'Backup Bakery', amount: '12.00' });
  await p1.goto('./#/reports');
  await p1.fill('#bk-pw', 'correct horse battery');
  await p1.fill('#bk-pw2', 'correct horse battery');
  const [dl] = await Promise.all([p1.waitForEvent('download'), p1.getByRole('button', { name: 'Download encrypted backup' }).click()]);
  const backupBytes = readFileSync((await dl.path())!);
  expect(backupBytes.toString('utf8')).not.toContain('Backup Bakery');
  await c1.close();

  const c2 = await browser.newContext();
  await useFakeGoogle(c2, new FakeDrive());
  const p2 = await c2.newPage();
  await p2.goto('./');
  await p2.getByRole('button', { name: 'Restore from a backup file' }).click();
  await p2.locator('#bk').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backupBytes });
  await p2.fill('#bk-pw', 'wrong password!!');
  await p2.getByRole('button', { name: 'Unlock backup' }).click();
  await expect(p2.getByText(/Wrong password/)).toBeVisible();
  await p2.fill('#bk-pw', 'correct horse battery');
  await p2.getByRole('button', { name: 'Unlock backup' }).click();
  await expect(p2.getByText(/1 expense records/)).toBeVisible();
  await p2.getByRole('button', { name: 'Continue' }).click();
  await enterPasscode(p2);
  await expect(p2.getByText('Enter it again')).toBeVisible();
  await enterPasscode(p2);
  await p2.goto('./#/expenses');
  await expect(p2.getByText('Backup Bakery')).toBeVisible();
  await c2.close();
});
