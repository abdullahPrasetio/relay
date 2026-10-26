import { _electron as electron, expect, test } from '@playwright/test';
import fs from 'node:fs';
import { closeApp, launchApp } from './helpers/app.js';

// Sessions are persisted in renderer localStorage under this key.
const SESSION_KEY = 'relay-session';

// Relaunch with the user-data dir of a previous launch (launchApp() always
// creates a fresh temp dir, so restarts need this local variant).
async function relaunch(userData) {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, RELAY_TEST_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.url-input', { timeout: 30000 });
  return { app, page, userData };
}

// A tab with unsaved edits opens the close-confirmation dialog, which
// app.close()/app.quit() would wait on forever. Exit the process directly;
// the session payload has already been read back from localStorage above.
async function forceQuit(app) {
  const child = app.process();
  const exited =
    !child || child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
          const timer = setTimeout(resolve, 10000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
  try {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0));
  } catch {
    /* the target can close before the evaluate reply arrives */
  }
  await exited;
  // Let Playwright observe the exit and release the Electron connection; a
  // bare app.exit() leaves its close bookkeeping pending.
  await app.close().catch(() => {});
}

function discard(userData) {
  fs.rmSync(userData, { recursive: true, force: true });
}

async function waitForStoredSession(page, { tabs, url }) {
  await page.waitForFunction(
    ({ key, tabCount, expectedUrl }) => {
      try {
        const raw = globalThis.localStorage.getItem(key);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!Array.isArray(data.tabs) || data.tabs.length !== tabCount) return false;
        if (!expectedUrl) return true;
        return data.tabs.some(
          (entry) => entry && entry.request && entry.request.url === expectedUrl
        );
      } catch {
        return false;
      }
    },
    { key: SESSION_KEY, tabCount: tabs, expectedUrl: url },
    { timeout: 15000 }
  );
}

test('restores the open tabs and active draft after a restart', async () => {
  const first = await launchApp();
  const { page } = first;

  await page.locator('.tabbar-add').click();
  await expect(page.locator('.req-tab')).toHaveCount(2);
  await page.locator('.url-input').fill('https://example.test/session');
  await expect(page.locator('.url-input')).toHaveValue('https://example.test/session');

  await waitForStoredSession(page, { tabs: 2, url: 'https://example.test/session' });

  await forceQuit(first.app);

  const second = await relaunch(first.userData);
  await expect(second.page.locator('.req-tab')).toHaveCount(2);
  await expect(second.page.locator('.url-input')).toHaveValue(
    'https://example.test/session'
  );
  await expect(second.page.locator('.req-tab.active')).toContainText(
    'https://example.test/session'
  );

  // The restored draft is still unsaved, so exit directly again.
  await forceQuit(second.app);
  discard(first.userData);
});

test('restores a second tab opened without edits after a restart', async () => {
  const first = await launchApp();
  const { page } = first;

  await page.locator('.tabbar-add').click();
  await expect(page.locator('.req-tab')).toHaveCount(2);
  await waitForStoredSession(page, { tabs: 2 });

  // No request edits: nothing to lose. Exit directly so the test does not
  // depend on the close handshake, then restart against the same user data.
  await forceQuit(first.app);

  const second = await relaunch(first.userData);
  await expect(second.page.locator('.req-tab')).toHaveCount(2);
  await expect(second.page.locator('.req-tab').nth(1)).toHaveClass(/active/);
  await expect(second.page.locator('.url-input')).toHaveValue('');

  await closeApp(second);
});
