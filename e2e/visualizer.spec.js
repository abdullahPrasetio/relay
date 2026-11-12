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

test('renders pm.visualizer in a sandboxed tab', async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const userData = makeUserData();
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify(
      {
        schemaVersion: 3,
        activeWorkspaceId: 'ws_viz',
        workspaces: [
          {
            id: 'ws_viz',
            name: 'Default',
            collections: [
              {
                id: 'col_viz',
                name: 'Visualizer',
                variables: [],
                items: [
                  {
                    id: 'req_viz',
                    type: 'request',
                    name: 'Visualizer Request',
                    method: 'GET',
                    url,
                    tests:
                      "pm.visualizer.set('<h1>{{name}}</h1>', { name: 'Ada' });",
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
  await page.getByText('Visualizer Request', { exact: true }).click();
  await page.locator('.request-panel .send-btn').click();
  await expect(page.getByTestId('response-status')).toContainText('200');

  await page.getByRole('button', { name: 'Visualizer', exact: true }).click();
  const frame = page.frameLocator('[data-testid="visualizer-frame"]');
  await expect(frame.locator('h1')).toHaveText('Ada');
});
