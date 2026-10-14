import { expect, type BrowserContext, type Page } from '@playwright/test';
import { FakeDrive } from '../support/fakeDrive';

/** Fake Google Identity Services: grants a Drive token instantly. */
const GIS_STUB = `
window.google = { accounts: { oauth2: {
  initTokenClient: function (cfg) {
    var c = { callback: cfg.callback, requestAccessToken: function () {
      setTimeout(function () { c.callback({ access_token: 'token-1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' }); }, 20);
    } };
    return c;
  },
  revoke: function () {}
} } };`;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, DELETE, PATCH, OPTIONS',
};

/** Route Google sign-in and Drive for a browser context (one context = one device). */
export async function useFakeGoogle(context: BrowserContext, drive: FakeDrive): Promise<void> {
  await context.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: GIS_STUB }));
  await context.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    const buf = req.postDataBuffer();
    const res = drive.handle({ method: req.method(), url: req.url(), headers: await req.allHeaders(), body: buf ? new Uint8Array(buf) : undefined });
    await route.fulfill({ status: res.status, headers: { ...res.headers, ...CORS }, body: Buffer.from(res.body) });
  });
}

export const PASSCODE = '481937';

export async function enterPasscode(page: Page, code = PASSCODE): Promise<void> {
  await page.locator('#passcode').fill(code);
}

/** First-run setup of a new household on this device. */
export async function setupHousehold(page: Page, names: [string, string] = ['Chinu', 'Spouse'], me: 0 | 1 = 0): Promise<void> {
  await page.goto('./');
  await page.getByRole('button', { name: 'Set up a new household' }).click();
  await page.fill('#m0', names[0]);
  await page.fill('#m1', names[1]);
  await page.locator('.seg label').nth(me).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await enterPasscode(page);
  await expect(page.getByText('Enter it again')).toBeVisible();
  await enterPasscode(page);
  await expect(page.getByText('Household spending')).toBeVisible();
}

export async function addExpense(page: Page, e: { merchant: string; amount: string; date?: string; category?: string; personal?: boolean; refund?: boolean }): Promise<void> {
  await page.goto(e.refund ? './#/expenses/refund' : './#/expenses/new');
  await page.fill('#f-merchantName', e.merchant);
  await page.fill('#f-amount', e.amount);
  if (e.date) await page.fill('#f-transactionDate', e.date);
  if (e.category) await page.selectOption('#f-categoryId', e.category);
  if (e.personal) await page.locator('label', { hasText: 'Personal' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Expenses' })).toBeVisible();
}

/** Connect Drive on the first device; returns the recovery key shown to the user. */
export async function connectDrive(page: Page): Promise<string> {
  await page.goto('./#/sync');
  await page.getByRole('button', { name: 'Connect Google Drive' }).click();
  const keyEl = page.locator('.recovery-key');
  await expect(keyEl).toBeVisible();
  const groups = await keyEl.locator('span').allTextContents();
  await page.fill('#rk-check', groups[groups.length - 1]!);
  await page.getByRole('button', { name: 'I saved the recovery key' }).click();
  await expect(page.getByText(/Status: (Up to date|Uploading|Downloading|Local changes pending)/)).toBeVisible();
  return groups.join('-');
}

export async function syncNow(page: Page): Promise<void> {
  await page.goto('./#/sync');
  await page.getByRole('button', { name: /Sync now|Sign in & sync/ }).click();
  await expect(page.getByRole('heading', { name: /Status: (Up to date|Conflict needs attention)$/ })).toBeVisible();
}

/** Second device joins the household from Drive with the recovery key. */
export async function joinHousehold(page: Page, recoveryKey: string, memberName: string): Promise<void> {
  await page.goto('./');
  await page.getByRole('button', { name: 'Join our household from Google Drive' }).click();
  await page.fill('#join-key', recoveryKey);
  await page.getByRole('button', { name: 'Sign in and join' }).click();
  await expect(page.getByRole('heading', { name: 'Who uses this device?' })).toBeVisible();
  await page.locator('.seg label', { hasText: memberName }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await enterPasscode(page);
  await expect(page.getByText('Enter it again')).toBeVisible();
  await enterPasscode(page);
  await expect(page.getByText('Household spending')).toBeVisible();
}
