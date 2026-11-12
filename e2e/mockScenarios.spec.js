import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

function seed() {
  const request = {
    id: 'req_orders',
    name: 'Order',
    method: 'GET',
    url: 'https://api.example.com/orders/:id',
    params: [{ key: 'state', value: 'ok', enabled: true }],
    pathVars: [{ key: 'id', value: '42', enabled: true }],
    headers: [{ key: 'X-Tenant', value: 'acme', enabled: true }],
    body: {
      mode: 'json',
      raw: '{"customer":{"email":"dev@example.com"}}',
      form: [],
      graphql: { query: '', variables: '' },
    },
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
        {
          id: 'ok',
          name: 'OK',
          description: 'Healthy order',
          enabled: true,
          status: 200,
          statusText: 'OK',
          headers: [{ key: 'X-Scenario', value: 'ok', enabled: true }],
          body: '{"id":"{{request.path.id}}"}',
          contentType: 'application/json',
          delayMs: 0,
          isDefault: false,
          conditions: [{ source: 'query', key: 'state', operator: 'equals', value: 'ok' }],
        },
        {
          id: 'down',
          name: 'Down',
          description: 'Service unavailable',
          enabled: true,
          status: 503,
          statusText: 'Unavailable',
          headers: [],
          body: '{"error":"down"}',
          contentType: 'application/json',
          delayMs: 0,
          isDefault: true,
          conditions: [],
        },
      ],
    },
  };
  return {
    schemaVersion: 3,
    workspaces: [
      {
        id: 'ws_mock',
        name: 'Mock WS',
        collections: [
          {
            id: 'col_mock',
            name: 'Orders API',
            description: '',
            variables: [],
            auth: { type: 'none' },
            preRequest: '',
            tests: '',
            items: [request],
          },
        ],
        environments: [],
        globals: [],
        history: [],
        activeEnvId: null,
      },
    ],
    activeWorkspaceId: 'ws_mock',
  };
}

test('serves auto scenarios, runtime overrides, and reloaded defaults', async () => {
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
    await page.getByTestId('mock-start').click();
    await expect(page.getByTestId('mock-base-url')).toBeVisible({ timeout: 15000 });
    const base = (await page.getByTestId('mock-base-url').textContent()).trim();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Auto: condition match.
    const ok = await fetch(`${base}/orders/42?state=ok`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('{"id":"42"}');
    expect(ok.headers.get('x-scenario')).toBe('ok');

    // Auto: default fallback.
    const down = await fetch(`${base}/orders/42`);
    expect(down.status).toBe(503);
    expect(await down.text()).toBe('{"error":"down"}');

    // Manual runtime override wins over conditions; clearing restores auto.
    await page.getByTestId('mock-route-scenario-req_orders').selectOption('down');
    const forced = await fetch(`${base}/orders/42?state=ok`);
    expect(forced.status).toBe(503);

    await page.getByTestId('mock-route-scenario-req_orders').selectOption('');
    const autoAgain = await fetch(`${base}/orders/42?state=ok`);
    expect(autoAgain.status).toBe(200);

    // Edit the default scenario in the request tab, then reload routes in place.
    await page.locator('.modal-head button[title="Close"]').first().click();
    await page.getByTestId('collections-expand-all').click();
    await page.locator('.request-row', { hasText: 'Order' }).first().click();

    // Docs: request description + field rules are editable and survive tab
    // switches (the request object owns this state).
    await page.locator('.tabs .tab', { hasText: 'Docs' }).click();
    await page.getByTestId('request-description').fill('Order lookup with tenant isolation');
    const stateField = page.getByTestId('validation-field-params-state');
    await stateField.getByRole('button', { name: 'required', exact: true }).click();
    await stateField.getByRole('button', { name: 'string', exact: true }).click();
    await stateField.locator('.validation-description input').fill('Order state');
    await stateField.locator('.validation-meta input').first().fill('2');
    await expect(page.getByTestId('validation-count')).toHaveText('1 documented');
    await expect(page.getByTestId('validation-field-body-customer_email')).toBeVisible();
    await page.locator('.tabs .tab', { hasText: 'Params' }).click();
    await page.locator('.tabs .tab', { hasText: 'Docs' }).click();
    await expect(page.getByTestId('request-description')).toHaveValue(
      'Order lookup with tenant isolation'
    );
    await expect(stateField.getByRole('button', { name: 'required', exact: true })).toHaveClass(
      /active/
    );

    // Scenario description is shown in the list and editable.
    await page.locator('.tabs .tab', { hasText: 'Mock' }).click();
    await page.getByTestId('mock-scenario-down').click();
    await expect(page.getByTestId('mock-scenario-description')).toHaveValue(
      'Service unavailable'
    );
    await page.getByTestId('mock-scenario-description').fill('Service is down');
    await page.getByTestId('mock-scenario-body').fill('{"error":"changed"}');

    await page.getByTestId('mock-open').click();
    await page.getByTestId('mock-reload').click();
    const changed = await fetch(`${base}/orders/42`);
    expect(changed.status).toBe(503);
    expect(await changed.text()).toBe('{"error":"changed"}');

    // Still the same listener/port after reload.
    await expect(page.getByTestId('mock-base-url')).toHaveText(base);
  } finally {
    await closeApp(session);
  }
});
