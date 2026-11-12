import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForAppReady } from './helpers/app.js';

// Opt-in: needs a running relay-api (with mock migrations applied).
//   RELAY_CLOUD_E2E=1 RELAY_API_URL=http://127.0.0.1:18092 npx playwright test e2e/cloud-mocks.spec.js
test.skip(!process.env.RELAY_CLOUD_E2E, 'set RELAY_CLOUD_E2E=1 with a running relay-api');

const API_ORIGIN = process.env.RELAY_API_URL || 'http://127.0.0.1:18092';
const API = `${API_ORIGIN}/api/v1`;
const request = {
  id: 'req_mock_e2e',
  name: 'Get order',
  method: 'GET',
  url: 'http://127.0.0.1:18099/orders/42',
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
};

const workspace = {
  id: 'ws_mock_e2e',
  name: 'Mocks E2E',
  collections: [
    {
      id: 'col_mock_e2e',
      name: 'Orders',
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
};

function seedData(userData) {
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify(
      { schemaVersion: 3, workspaces: [workspace], activeWorkspaceId: workspace.id },
      null,
      2
    )
  );
}

async function loginToken(email) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', deviceLabel: 'e2e' }),
  }).then((r) => r.json());
  return res.data.accessToken;
}

test('create, scenario-match, and generate server mocks from the UI', async () => {
  test.setTimeout(120000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mock-e2e-'));
  seedData(userData);
  const email = `mock-e2e-${Date.now()}@relay.test`;
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      RELAY_TEST_USER_DATA: userData,
      RELAY_API_URL: API_ORIGIN,
    },
  });

  try {
    const page = await app.firstWindow();
    await waitForAppReady(page);

    await page.getByTestId('cloud-status').click();
    await page.getByTestId('cloud-tab-register').click();
    await page.getByPlaceholder('Ada Lovelace').fill('Mock E2E');
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.locator('#cloud-auth-form input[type="password"]').fill('password123');
    await page.locator('button[form="cloud-auth-form"]').click();
    await expect(page.getByTestId('cloud-status')).toHaveAttribute('data-state', 'local', {
      timeout: 20000,
    });

    // A successful sign-in is visible without opening a modal: the header
    // shows the account email and the workspace menu has the account row.
    await expect(page.getByTestId('cloud-account')).toContainText(email);
    await page.locator('.ws-button').click();
    await expect(page.locator('.ws-account')).toContainText('Signed in as');
    await expect(page.locator('.ws-account')).toContainText(email);
    await page.locator('[data-testid="ws-cloud-ws_mock_e2e"]').click();
    await expect(page.getByTestId('cloud-status')).toHaveAttribute('data-state', 'synced', {
      timeout: 30000,
    });

    // Resolve the remote workspace id from the backend.
    const token = await loginToken(email);
    const workspaces = await fetch(`${API}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const remoteId = workspaces.data.find((entry) => entry.name === 'Mocks E2E')?.id;
    expect(remoteId).toBeTruthy();

    // Create one endpoint from the Cloud tab.
    await page.getByTestId('mock-open').click();
    await page.getByTestId('mock-tab-cloud').click();
    await expect(page.getByTestId('mock-cloud-tab')).toBeVisible();
    await page.getByTestId('mock-new').click();
    await page.locator('#mock-name').fill('Order detail');
    await page.locator('#mock-path').fill('/orders/{id}');
    await page.locator('#mock-status').fill('200');
    await page.getByRole('button', { name: 'Create mock' }).click();
    await expect(page.getByTestId('mock-cloud-endpoints')).toBeVisible({ timeout: 20000 });

    let res = await fetch(`${API_ORIGIN}/mock/${remoteId}/orders/42`);
    expect(res.status).toBe(200);

    // Add a scenario and verify it answers only when its query condition holds.
    await page.getByRole('button', { name: 'Scenarios' }).first().click();
    await expect(page.getByTestId('mock-scenarios')).toBeVisible();
    await page.getByRole('button', { name: '+ New scenario' }).click();
    await page.locator('#scenario-name').fill('paid');
    await page.locator('#scenario-status').fill('409');
    await page.getByRole('button', { name: 'Add condition' }).click();
    await page.getByLabel('Condition 1 key').fill('state');
    await page.getByLabel('Condition 1 value').fill('paid');
    await page.getByRole('button', { name: 'Create scenario' }).click();
    await expect(page.getByText('paid').first()).toBeVisible({ timeout: 20000 });

    res = await fetch(`${API_ORIGIN}/mock/${remoteId}/orders/42?state=paid`);
    expect(res.status).toBe(409);
    expect(res.headers.get('x-relay-mock-scenario')).toBe('paid');

    res = await fetch(`${API_ORIGIN}/mock/${remoteId}/orders/42`);
    expect(res.status).toBe(200);

    // Manual mode pins the scenario even without the query condition. The
    // select's change handler is async and controlled by the saved value, so
    // wait for the control to reflect the server response before fetching.
    await page.locator('#mock-evaluation-mode').selectOption('manual');
    await expect(page.locator('#mock-evaluation-mode')).toHaveValue('manual');
    await page.getByLabel('Active scenario').selectOption({ label: 'paid' });
    await expect(page.getByLabel('Active scenario')).not.toHaveValue('');
    res = await fetch(`${API_ORIGIN}/mock/${remoteId}/orders/42`);
    expect(res.status).toBe(409);

    // Generate from the collection is idempotent.
    await page.getByRole('button', { name: 'Back to mocks' }).click();
    await page.getByTestId('mock-generate-open').click();
    await page.getByLabel('Collection').selectOption('col_mock_e2e');
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(page.getByTestId('mock-generate-result')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(page.getByTestId('mock-generate-result')).toContainText('skipped', {
      timeout: 20000,
    });
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
