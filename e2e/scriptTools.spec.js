import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

test('script tools insert snippets and packages into the editor', async () => {
  const session = await launchApp();
  const { page } = session;
  try {
    await page.getByRole('button', { name: 'Pre-request', exact: true }).click();
    await expect(page.getByTestId('script-snippets-open')).toBeVisible();

    await page.getByTestId('script-snippets-open').click();
    await page.getByTestId('script-tools-search').fill('global variable');
    await page.getByTestId('script-item-get-global-variable').click();

    const editorLines = page.locator('.monaco-editor .view-lines').first();
    await expect(editorLines).toContainText('pm.globals.get');

    await page.getByTestId('script-packages-open').click();
    await page.getByTestId('script-tools-search').fill('lodash');
    await page.getByTestId('script-item-lodash').click();

    await expect(editorLines).toContainText("require('lodash')");
  } finally {
    await closeApp(session);
  }
});
