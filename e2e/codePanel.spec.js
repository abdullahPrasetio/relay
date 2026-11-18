import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

function seed() {
  return {
    schemaVersion: 3,
    activeWorkspaceId: 'ws_code',
    workspaces: [
      {
        id: 'ws_code',
        name: 'Code',
        collections: [
          {
            id: 'col_code',
            name: 'API',
            variables: [],
            items: [
              {
                id: 'req_code',
                type: 'request',
                name: 'Secret URL',
                method: 'GET',
                url: 'https://api.test/{{token}}',
              },
            ],
          },
        ],
        environments: [
          {
            id: 'env_code',
            name: 'Dev',
            variables: [
              { key: 'token', value: 'super-secret', enabled: true, type: 'secret' },
            ],
          },
        ],
        globals: [],
        history: [],
        activeEnvId: 'env_code',
      },
    ],
  };
}

test('code panel keeps secret values hidden until explicitly revealed', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData);
  const { page } = session;

  try {
    await page.getByTestId('collections-expand-all').click();
    await page.locator('.request-row', { hasText: 'Secret URL' }).click();
    await page.getByTitle('Generate code').click();

    const code = page.locator('.modal .code-block');
    await expect(code).toContainText('{{token}}');
    await expect(code).not.toContainText('super-secret');

    await page.getByTestId('code-include-secrets').check();
    await expect(code).toContainText('super-secret');
  } finally {
    await closeApp(session);
  }
});
