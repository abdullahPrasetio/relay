import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

const SERVER = 'http://127.0.0.1:45678';

async function configure(page) {
  await page.locator('.ws-button').click();
  await page.getByTestId('cloud-server').click();
  await expect(page.getByTestId('cloud-server-url')).toBeVisible();
  await page.getByTestId('cloud-server-url').fill(SERVER);
  await page.getByTestId('cloud-server-save').click();
  await expect(page.getByTestId('cloud-server-notice')).toContainText('Server URL saved');
  await expect(page.getByTestId('cloud-server-url')).toHaveValue(`${SERVER}/api/v1`);
}

async function config(page) {
  return page.evaluate(() => globalThis.api.cloud.getConfig());
}

test('changes and persists the Relay API server URL', async () => {
  const userData = makeUserData();
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify({
      schemaVersion: 3,
      workspaces: [
        {
          id: 'ws_cloud_server',
          name: 'Default',
          collections: [],
          environments: [],
          globals: [],
          history: [],
          activeEnvId: null,
        },
      ],
      activeWorkspaceId: 'ws_cloud_server',
    })
  );

  let session = await launchAppAt(userData, { RELAY_API_URL: '' });
  try {
    const res = await config(session.page);
    expect(res).toMatchObject({ ok: true, data: { locked: false } });
    await configure(session.page);

    const saved = await config(session.page);
    expect(saved.data.baseUrl).toBe(`${SERVER}/api/v1`);

    // The renderer store does not expose the main-owned setting.
    const data = await session.page.evaluate(() => globalThis.api.loadData());
    expect(data.cloudBaseUrl).toBeUndefined();

    // Restart with the same userData, no env override: the URL survives.
    await session.app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await session.app.close().catch(() => {});
    session = await launchAppAt(userData, { RELAY_API_URL: '' });
    const after = await config(session.page);
    expect(after.data.baseUrl).toBe(`${SERVER}/api/v1`);
  } finally {
    await closeApp(session);
  }
});
