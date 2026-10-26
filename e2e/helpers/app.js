import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// Launch the built app (dist/ + dist-electron/) with an isolated user-data dir
// so tests never touch the developer's real Relay data. `npm run build:vite`
// must run first: `main` points at dist-electron/main.js.
export function makeUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-'));
}

export async function launchAppAt(userData) {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, RELAY_TEST_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.url-input', { timeout: 30000 });
  return { app, page, userData };
}

export async function launchApp() {
  return launchAppAt(makeUserData());
}

// Closing goes through the app's quit handshake: the window is vetoed until the
// renderer confirms, and a test that ends with a dirty tab deliberately never
// answers that prompt. So do not start a graceful close that would hang —
// exit the process and wait for it, then release Playwright's connection.
export async function closeApp({ app, userData }) {
  // `app.process()` throws once Playwright has torn the connection down (the
  // test may already have awaited the app's own close event).
  let child = null;
  try {
    child = app.process();
  } catch {
    child = null;
  }

  try {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0));
  } catch {
    /* target already gone */
  }

  if (child && child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  }

  await app.close().catch(() => {});

  if (userData) fs.rmSync(userData, { recursive: true, force: true });
}
