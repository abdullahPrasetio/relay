import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

function seed() {
  return {
    schemaVersion: 3,
    activeWorkspaceId: 'ws_docs',
    workspaces: [
      {
        id: 'ws_docs',
        name: 'Docs Workspace',
        collections: [
          {
            id: 'col_docs',
            name: 'Orders API',
            description: 'Order lifecycle endpoints.',
            variables: [
              { key: 'API_KEY', value: 'secret-value', type: 'secret', enabled: true },
              { key: 'BASE_URL', value: 'https://api.test', type: 'default', enabled: true },
            ],
            items: [
              {
                id: 'req_docs',
                type: 'request',
                name: 'Create order',
                description: 'Creates an order for the current tenant.',
                method: 'POST',
                url: 'https://api.test/orders',
                headers: [{ key: 'Authorization', value: 'Bearer {{API_KEY}}', enabled: true }],
                params: [{ key: 'tenant', value: 'acme', enabled: true }],
                body: { mode: 'json', raw: '{"item":"sku-1"}' },
                fieldValidations: {
                  params: {
                    tenant: {
                      rules: ['required', 'string'],
                      min: 0,
                      max: 0,
                      description: 'Tenant identifier',
                    },
                  },
                },
              },
            ],
          },
        ],
        environments: [{ id: 'env_docs', name: 'Production', variables: [] }],
        globals: [],
        history: [],
        activeEnvId: 'env_docs',
      },
    ],
  };
}

test('renders workspace and collection documentation', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = session;

  try {
    await page.getByTestId('rail-docs').click();
    await expect(page.getByTestId('docs-workspace')).toBeVisible();
    await expect(page.getByTestId('docs-workspace')).toContainText('Docs Workspace');
    await expect(page.getByTestId('docs-workspace')).toContainText('Orders API');

    await page.getByTestId('docs-collection-col_docs').click();
    const docs = page.getByTestId('docs-collection');
    await expect(docs).toContainText('Order lifecycle endpoints.');
    await expect(docs).toContainText('Create order');
    await expect(docs).toContainText('Creates an order for the current tenant.');
    await expect(docs).toContainText('••••');
    await expect(docs).toContainText('1 params');
    await expect(docs).toContainText('1 documented fields');

    await docs.getByRole('button', { name: 'Open request' }).click();
    await expect(page.locator('.request-panel .tabs .tab.active')).toContainText('Docs');
  } finally {
    await closeApp(session);
  }
});
