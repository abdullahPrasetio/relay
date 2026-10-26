import { expect, test } from '@playwright/test';
import { closeApp, launchApp } from './helpers/app.js';

// Covers the Electron quit handshake: main vetoes the window close until the
// renderer answers, so unsaved work is never dropped silently.
let launched;

test.afterEach(async () => {
  if (launched) {
    await closeApp(launched);
    launched = null;
  }
});

async function requestWindowClose(app) {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.close();
  });
}

test('prompts before quitting with unsaved changes', async () => {
  launched = await launchApp();
  const { app, page } = launched;

  await page.locator('.url-input').fill('https://example.test/unsaved');
  await requestWindowClose(app);

  const discard = page.getByRole('button', { name: 'Discard and quit' });
  await expect(discard).toBeVisible();

  // Cancel keeps the window and the draft.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(discard).toHaveCount(0);
  await expect(page.locator('.url-input')).toHaveValue('https://example.test/unsaved');

  // Second attempt, this time discarding: the process must exit.
  const closed = app.waitForEvent('close', { timeout: 10000 });
  await requestWindowClose(app);
  await expect(discard).toBeVisible();
  await discard.click();
  await closed;
});

test('quits immediately when nothing is dirty', async () => {
  launched = await launchApp();
  const { app, page } = launched;

  const closed = app.waitForEvent('close', { timeout: 10000 });
  await requestWindowClose(app);

  await closed;
  // No dialog was needed; the renderer window is gone.
  expect(page.isClosed()).toBe(true);
});
