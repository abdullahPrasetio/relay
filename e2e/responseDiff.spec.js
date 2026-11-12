import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

let server;
let launched;

test.afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  if (launched) {
    await closeApp(launched);
    launched = null;
  }
});

test('compares the response with a saved example', async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: 2 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const userData = makeUserData();
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify(
      {
        schemaVersion: 3,
        activeWorkspaceId: 'ws_diff',
        workspaces: [
          {
            id: 'ws_diff',
            name: 'Default',
            collections: [
              {
                id: 'col_diff',
                name: 'Diff',
                variables: [],
                items: [
                  {
                    id: 'req_diff',
                    type: 'request',
                    name: 'Diff Request',
                    method: 'GET',
                    url,
                    examples: [
                      {
                        id: 'ex_base',
                        name: 'Baseline',
                        response: {
                          status: 200,
                          statusText: 'OK',
                          contentType: 'application/json',
                          headers: [],
                          body: '{\n  "value": 1\n}',
                        },
                      },
                    ],
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
      },
      null,
      2
    )
  );

  launched = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = launched;

  await page.getByTestId('collections-expand-all').click();
  await page.getByText('Diff Request', { exact: true }).click();
  await page.locator('.request-panel .send-btn').click();
  await expect(page.getByTestId('response-status')).toContainText('200');

  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await expect(page.getByTestId('response-diff')).toBeVisible();
  await expect(page.locator('.diff-line.add')).toContainText('"value": 2');
  await expect(page.locator('.diff-line.remove')).toContainText('"value": 1');
});
