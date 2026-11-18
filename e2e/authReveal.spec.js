import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

function seed() {
  return {
    schemaVersion: 3,
    activeWorkspaceId: 'ws_auth',
    workspaces: [
      {
        id: 'ws_auth',
        name: 'Auth',
        collections: [
          {
            id: 'col_auth',
            name: 'ESB',
            variables: [],
            auth: { type: 'basic', basic: { username: 'mma', password: 'secret-pass' } },
            items: [],
          },
        ],
        environments: [],
        globals: [],
        history: [],
        activeEnvId: null,
      },
    ],
  };
}

test('collection auth password has an eye toggle', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData);
  const { page } = session;

  try {
    await page.locator('.collection-name').first().click();
    await page.locator('.modal').getByRole('button', { name: 'Authorization' }).click();
    const password = page.locator('.auth-panel input[type="password"]');
    await expect(password).toHaveValue('secret-pass');
    await page.locator('.auth-panel .var-reveal-btn').click();
    await expect(page.locator('.auth-panel input[type="text"]').last()).toHaveValue('secret-pass');
    await page.locator('.auth-panel .var-reveal-btn').click();
    await expect(page.locator('.auth-panel input[type="password"]')).toHaveValue('secret-pass');
  } finally {
    await closeApp(session);
  }
});
