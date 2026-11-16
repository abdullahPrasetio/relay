import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

test('sets an unresolved URL variable directly from the token tooltip', async () => {
  const session = await launchApp();
  const { page } = session;

  try {
    const url = page.locator('.url-input');
    await url.fill('https://jsonplaceholder.typicode.com/posts/{{id}}');
    await url.hover();

    await expect(page.getByTestId('var-value-id')).toHaveText('variable is not defined');
    await page.getByTestId('var-edit-id').click();

    await page.getByTestId('variable-value').fill('1');
    await page.getByTestId('variable-save').click();

    await url.hover();
    await expect(page.getByTestId('var-value-id')).toHaveText('1');
  } finally {
    await closeApp(session);
  }
});
