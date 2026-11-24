import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

function seed() {
  return {
    schemaVersion: 3,
    activeWorkspaceId: 'ws_bulk',
    workspaces: [
      {
        id: 'ws_bulk',
        name: 'Default',
        collections: [
          {
            id: 'col_bulk',
            name: 'Bulk',
            variables: [],
            items: [
              {
                id: 'req_bulk',
                type: 'request',
                name: 'Bulk request',
                method: 'POST',
                url: 'http://localhost:3000/items',
                headers: [
                  { key: 'Accept', value: 'application/json', enabled: true },
                  { key: 'X-Old', value: 'old', enabled: false },
                ],
                body: {
                  mode: 'form-urlencoded',
                  form: [
                    { key: 'name', value: 'Old', enabled: true },
                    { key: 'disabled', value: 'yes', enabled: false },
                  ],
                },
              },
            ],
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

test('bulk edit replaces headers and form body fields', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData);
  const { page } = session;

  try {
    await page.waitForSelector('.collection-row');
    await page.getByTestId('collections-expand-all').click();
    await page.locator('.request-row', { hasText: 'Bulk request' }).click();

    const tabs = page.locator('.request-panel .tabs');
    await tabs.getByRole('button', { name: /^Headers/ }).click();
    await page.getByTestId('kv-bulk-edit').click();
    await page.getByTestId('kv-bulk-edit-text').fill(
      'Accept: text/plain\n# X-Disabled: no\nX-New: yes'
    );
    await page.getByTestId('kv-bulk-edit-apply').click();
    const values = () =>
      page.locator('.request-panel .kv input').evaluateAll((els) => els.map((el) => el.value));
    await expect.poll(values).toContain('text/plain');
    await expect.poll(values).toContain('X-New');
    await expect.poll(values).toContain('X-Disabled');

    await tabs.getByRole('button', { name: /^Body/ }).click();
    await page.getByTestId('kv-bulk-edit').click();
    await page.getByTestId('kv-bulk-edit-text').fill('name=Ada\nrole=admin');
    await page.getByTestId('kv-bulk-edit-apply').click();
    await expect.poll(values).toContain('Ada');
    await expect.poll(values).toContain('role');
  } finally {
    await closeApp(session);
  }
});
