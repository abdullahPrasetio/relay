import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

// The environment switcher used to be three buttons + a select in the header.
// It is now one pill with a menu; this covers the create/select flow so the
// header stays compact without losing functionality.
test('creates and selects an environment from the header menu', async () => {
  const session = await launchApp();
  const { page } = session;

  await page.getByTestId('env-trigger').click();
  await expect(page.getByTestId('env-menu')).toBeVisible();
  await expect(page.getByTestId('env-menu')).toContainText('No Environment');

  await page.getByText('New environment…').click();
  await page.locator('.modal input').fill('Staging');
  await page.locator('.modal input').press('Enter');

  // Creating an environment opens its variable editor.
  await expect(page.locator('.env-popover')).toBeVisible();
  await page.locator('.env-popover .icon-btn').last().click();

  await expect(page.getByTestId('env-trigger')).toContainText('Staging');

  await page.getByTestId('env-trigger').click();
  const activeItem = page.locator('.env-menu-item.active');
  await expect(activeItem).toContainText('Staging');

  await page.locator('.env-menu-item', { hasText: 'No Environment' }).click();
  await expect(page.getByTestId('env-trigger')).toContainText('No Environment');
  await expect(page.getByTestId('env-menu')).toHaveCount(0);

  await closeApp(session);
});
