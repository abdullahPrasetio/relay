/* global localStorage */
import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

test('update channel preference persists across modal reopen', async () => {
  const session = await launchApp();
  const { page } = session;

  try {
    await page.getByTestId('update-open').click();
    const channel = page.getByTestId('update-channel');
    const initial = await channel.inputValue();
    const next = initial === 'stable' ? 'beta' : 'stable';
    await channel.selectOption(next);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('relay-update-channel')))
      .toBe(next);

    await page.getByTestId('update-close').click();
    await page.getByTestId('update-open').click();
    await expect(page.getByTestId('update-channel')).toHaveValue(next);
  } finally {
    await closeApp(session);
  }
});
