import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

function seed() {
  return {
    schemaVersion: 3,
    activeWorkspaceId: 'ws_tools',
    workspaces: [
      {
        id: 'ws_tools',
        name: 'Default',
        collections: [
          {
            id: 'col_tools',
            name: 'Tools',
            variables: [],
            items: [
              {
                id: 'req_tools',
                type: 'request',
                name: 'Schema request',
                method: 'POST',
                url: 'http://localhost:3000/items',
                headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
                body: {
                  mode: 'raw',
                  rawFormat: 'json',
                  raw: '{"bizId":"BRIMERCHANT","amount":1500}',
                  schema: '',
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

test('saves header presets and generates a schema from raw JSON', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData);
  const { page } = session;

  try {
    await page.waitForSelector('.collection-row');
    await page.getByTestId('collections-expand-all').click();
    await page.locator('.request-row', { hasText: 'Schema request' }).click();

    const tabs = page.locator('.request-panel .tabs');
    await tabs.getByRole('button', { name: /^Headers/ }).click();
    await page.getByRole('button', { name: 'Save current' }).click();
    const dialog = page.locator('.modal');
    await dialog.locator('input').fill('Common');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const stored = await page.evaluate(() =>
      JSON.parse(globalThis.localStorage.getItem('relay-header-presets') || '[]')
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Common');
    expect(stored[0].headers[0]).toMatchObject({ key: 'Accept', value: 'application/json' });

    await tabs.getByRole('button', { name: /^Body/ }).click();
    await page.getByTestId('body-schema-toggle').click();
    await expect(page.getByTestId('body-schema-pane')).toBeVisible();
    await page.getByTestId('body-schema-generate').click();
    await expect(page.getByTestId('body-schema-pane')).toContainText('bizId');
    await expect(page.getByTestId('body-schema-pane')).toContainText('properties');
  } finally {
    await closeApp(session);
  }
});
