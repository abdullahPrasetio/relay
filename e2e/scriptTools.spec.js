import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

test('script tools insert snippets and packages into the editor', async () => {
  const session = await launchApp();
  const { page } = session;
  try {
    await page.getByRole('button', { name: 'Pre-request', exact: true }).click();
    await expect(page.getByTestId('script-snippets-open')).toBeVisible();

    // The toolbar must sit inside the request pane without scrolling; it used
    // to be rendered below the editor and clipped by the split pane.
    const toolbarBox = await page.getByTestId('script-snippets-open').boundingBox();
    const paneBox = await page.locator('.split-top').boundingBox();
    expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height);
    expect(toolbarBox.y).toBeGreaterThanOrEqual(paneBox.y);

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
