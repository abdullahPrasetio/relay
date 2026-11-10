import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

function scenario(id, extra = {}) {
  return {
    id,
    name: id,
    enabled: true,
    status: 200,
    statusText: 'OK',
    headers: [],
    contentType: 'application/json',
    body: `{"scenario":"${id}"}`,
    delayMs: 0,
    isDefault: false,
    conditions: [],
    ...extra,
  };
}

function seed() {
  return {
    schemaVersion: 3,
    workspaces: [
      {
        id: 'ws_mode',
        name: 'Mode WS',
        collections: [
          {
            id: 'col_mode',
            name: 'Mode API',
            description: '',
            variables: [],
            auth: { type: 'none' },
            preRequest: '',
            tests: '',
            items: [
              {
                id: 'req_orders',
                type: 'request',
                name: 'Order',
                method: 'GET',
                url: 'https://api.example.com/orders/:id',
                params: [],
                pathVars: [],
                headers: [],
                body: { mode: 'none', raw: '', form: [], graphql: { query: '', variables: '' } },
                auth: { type: 'none' },
                settings: {
                  timeoutMs: null,
                  followRedirects: null,
                  maxRedirects: null,
                  verifyTls: null,
                  proxyId: null,
                  useCookieJar: true,
                },
                grpc: {},
                preRequest: '',
                tests: '',
                examples: [],
                mock: {
                  enabled: true,
                  mode: 'auto',
                  activeScenarioId: null,
                  scenarios: [
                    scenario('ok', {
                      body: '{"id":"{{request.path.id}}"}',
                      conditions: [
                        { source: 'query', key: 'state', operator: 'equals', value: 'ok' },
                      ],
                    }),
                    scenario('down', { status: 503, isDefault: true, body: '{"error":"down"}' }),
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
    activeWorkspaceId: 'ws_mode',
  };
}

test('mock server: local and token-protected server modes', async () => {
  test.setTimeout(120000);
  const userData = makeUserData();
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify(seed(), null, 2)
  );
  const session = await launchAppAt(userData);
  const { page } = session;

  try {
    await page.getByTestId('mock-open').click();

    // ---- server mode requires a token ----
    await page.getByTestId('mock-mode').selectOption('server');
    await expect(page.getByTestId('mock-generate-token')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('mock-start')).toBeDisabled();

    await page.getByTestId('mock-generate-token').click();
    const tokenInput = page.getByTestId('mock-token');
    await expect(tokenInput).toBeVisible({ timeout: 10000 });
    const token = await tokenInput.inputValue();
    expect(token.startsWith('relay_mock_')).toBe(true);
    await expect(page.getByTestId('mock-start')).toBeEnabled();

    await page.getByTestId('mock-host').selectOption('0.0.0.0');
    await page.getByTestId('mock-start').click();
    await expect(page.getByTestId('mock-base-url')).toBeVisible({ timeout: 15000 });

    const status = await page.evaluate(() => globalThis.api.mockStatus());
    expect(status.running).toBe(true);
    expect(status.mode).toBe('server');
    expect(status.tokenRequired).toBe(true);
    expect(Array.isArray(status.urls) && status.urls.length >= 1).toBe(true);
    const base = status.url;
    expect(base).toMatch(/^http:\/\/.+:\d+$/);

    // No token -> 401; token via header and via query -> served.
    const anonymous = await fetch(`${base}/orders/1`);
    expect(anonymous.status).toBe(401);

    const wrong = await fetch(`${base}/orders/1`, {
      headers: { Authorization: 'Bearer relay_mock_wrong' },
    });
    expect(wrong.status).toBe(401);

    const authorized = await fetch(`${base}/orders/1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(503);
    expect(await authorized.text()).toBe('{"error":"down"}');

    const viaQuery = await fetch(`${base}/orders/1?state=ok&__token=${token}`);
    expect(viaQuery.status).toBe(200);
    expect(await viaQuery.text()).toBe('{"id":"1"}');

    // Per-call scenario override.
    const forced = await fetch(`${base}/orders/1?state=ok&__scenario=down&__token=${token}`);
    expect(forced.status).toBe(503);

    // ---- back to local mode: loopback only, no token ----
    await page.getByTestId('mock-mode').selectOption('local');
    await expect(page.getByTestId('mock-generate-token')).toHaveCount(0);
    await expect(page.getByTestId('mock-base-url')).toHaveCount(0);
    await page.getByTestId('mock-start').click();
    await expect(page.getByTestId('mock-base-url')).toHaveText(/^http:\/\/127\.0\.0\.1:\d+$/, {
      timeout: 15000,
    });

    const localStatus = await page.evaluate(() => globalThis.api.mockStatus());
    expect(localStatus.mode).toBe('local');
    expect(localStatus.tokenRequired).toBe(false);

    const open = await fetch(`${localStatus.url}/orders/1?state=ok`);
    expect(open.status).toBe(200);

    await page.getByTestId('mock-stop').click();
  } finally {
    await closeApp({ app: session.app, userData });
  }
});
