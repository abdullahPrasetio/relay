import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

let wss;
let launched;

test.afterEach(async () => {
  if (launched) {
    await closeApp(launched);
    launched = null;
  }
  if (wss) {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    wss = null;
  }
});

test('reconnects after an unexpected WebSocket close', async () => {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  let connections = 0;
  wss.on('connection', (socket) => {
    connections += 1;
    if (connections === 1) {
      setTimeout(() => socket.close(4001, 'drop'), 100);
    }
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;

  const userData = makeUserData();
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify(
      {
        schemaVersion: 3,
        activeWorkspaceId: 'ws_reconnect',
        workspaces: [
          {
            id: 'ws_reconnect',
            name: 'Default',
            collections: [
              {
                id: 'col_ws',
                name: 'WebSocket',
                variables: [],
                items: [
                  {
                    id: 'req_ws',
                    type: 'request',
                    name: 'Socket',
                    method: 'GET',
                    url,
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
  await page.getByText('Socket', { exact: true }).click();
  await page.locator('.request-panel .send-btn').click();
  await expect(page.getByTestId('ws-status')).toContainText('Open');

  // The server drops the first socket; the panel reconnects automatically.
  await expect(page.getByTestId('ws-status')).toContainText('Reconnecting', {
    timeout: 5000,
  });
  await expect(page.getByTestId('ws-status')).toContainText('Open', {
    timeout: 15000,
  });
  expect(connections).toBeGreaterThanOrEqual(2);
});
