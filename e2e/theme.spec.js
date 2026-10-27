import { expect, test } from '@playwright/test';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

// Quit without deleting the user-data dir, so the second launch can prove the
// preference was persisted (localStorage lives inside that dir).
async function quitKeepingData({ app }) {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}

test('theme mode and accent apply immediately and survive a restart', async () => {
  const userData = makeUserData();
  let session = await launchAppAt(userData);
  let page = session.page;

  const html = page.locator('html');

  await page.getByTestId('appearance-open').click();
  await page.getByTestId('appearance-mode-light').click();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.getByTestId('appearance-mode-dark').click();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.getByTestId('appearance-accent-postman').click();
  await expect(html).toHaveAttribute('data-accent', 'postman');

  // Back to light: this is the combination that must persist.
  await page.getByTestId('appearance-mode-light').click();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.locator('.modal-head .icon-btn').click();
  await quitKeepingData(session);

  session = await launchAppAt(userData);
  page = session.page;
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'postman');

  await closeApp(session);
});
