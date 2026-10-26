import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Launch the built app (dist/ + dist-electron/) with an isolated user-data dir
// so tests never touch the developer's real Relay data. `npm run build:vite`
// must run first: `main` points at dist-electron/main.js.
export async function launchApp() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-'));
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, RELAY_TEST_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.url-input', { timeout: 30000 });
  return { app, page, userData };
}

export async function closeApp({ app, userData }) {
  try {
    await app.close();
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}
