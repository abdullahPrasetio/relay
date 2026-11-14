/* global localStorage */
import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

test('update channel preference persists across modal reopen', async () => {
  const session = await launchApp();
  const { page } = session;

  try {
    await page.getByTestId('update-open').click();
    const channel = page.getByTestId('update-channel');
    await expect(channel).toHaveValue('beta');
    await channel.selectOption('stable');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('relay-update-channel')))
      .toBe('stable');

    await page.getByTestId('update-close').click();
    await page.getByTestId('update-open').click();
    await expect(page.getByTestId('update-channel')).toHaveValue('stable');
  } finally {
    await closeApp(session);
  }
});
