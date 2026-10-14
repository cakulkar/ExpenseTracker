/**
 * Installability and offline behaviour with the real service worker enabled, on a phone-sized screen.
 */
import { expect, test } from '@playwright/test';
import { FakeDrive } from '../support/fakeDrive';
import { addExpense, enterPasscode, setupHousehold, useFakeGoogle } from './fixtures';

test.use({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('installable manifest, offline reload to the lock screen, offline entry, lock button', async ({ page, context }) => {
  await useFakeGoogle(context, new FakeDrive());
  const manifest = await (await page.request.get('manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ name: 'PocketLedger', display: 'standalone', start_url: '/ExpenseTracker/', scope: '/ExpenseTracker/' });
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));

  await setupHousehold(page);
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active);
  await page.reload(); // let the service worker control the page

  await enterPasscode(page);
  await expect(page.getByText('Household spending')).toBeVisible();
  await expect(page.locator('.bottomnav')).toBeVisible();
  await expect(page.locator('.sidenav')).toBeHidden();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Enter passcode' })).toBeVisible();
  await enterPasscode(page, '000000');
  await expect(page.getByText(/Wrong passcode/)).toBeVisible();
  await enterPasscode(page);
  await addExpense(page, { merchant: 'Offline Diner', amount: '23.40' });
  await expect(page.getByText('Offline Diner')).toBeVisible();
  await expect(page.getByText("You're offline")).toBeVisible();

  // Lock button
  await page.getByRole('button', { name: 'Lock app' }).click();
  await expect(page.getByRole('heading', { name: 'Enter passcode' })).toBeVisible();
  await context.setOffline(false);
});
