import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Opt-in: needs a running relay-api with the monitor worker command pointing at
// the built core bundle, plus the local target server on :18099.
//   RELAY_CLOUD_E2E=1 RELAY_API_URL=http://127.0.0.1:18092 npx playwright test e2e/monitors.spec.js
test.skip(!process.env.RELAY_CLOUD_E2E, 'set RELAY_CLOUD_E2E=1 with a running relay-api');

const API = `${process.env.RELAY_API_URL || 'http://127.0.0.1:18092'}/api/v1`;
const request = {
  id: 'req_e2e',
  name: 'GET ok',
  method: 'GET',
  url: 'http://127.0.0.1:18099/ok',
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
  id: 'ws_e2e_local',
  name: 'Monitors E2E',
  collections: [
    {
      id: 'col_e2e',
      name: 'E2E',
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
  const payload = {
    schemaVersion: 2,
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  };
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(payload, null, 2));
}

test('create a monitor and run it from the UI', async () => {
  test.setTimeout(120000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mon-e2e-'));
  seedData(userData);
  const email = `mon-e2e-${Date.now()}@relay.test`;
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      RELAY_TEST_USER_DATA: userData,
      RELAY_API_URL: process.env.RELAY_API_URL || 'http://127.0.0.1:18092',
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.url-input', { timeout: 30000 });

    // Sign up and link the seeded workspace.
    await page.getByTestId('cloud-status').click();
    await page.getByTestId('cloud-tab-register').click();
    await page.getByPlaceholder('Ada Lovelace').fill('Monitor E2E');
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.locator('#cloud-auth-form input[type="password"]').fill('password123');
    await page.locator('button[form="cloud-auth-form"]').click();
    await expect(page.getByTestId('cloud-status')).toHaveAttribute('data-state', 'local', { timeout: 20000 });

    await page.locator('.ws-button').click();
    await page.locator('[data-testid="ws-cloud-ws_e2e_local"]').click();
    await expect(page.getByTestId('cloud-status')).toHaveAttribute('data-state', 'synced', { timeout: 30000 });

    // Open monitors for the linked workspace.
    await page.locator('.ws-button').click();
    await page.getByTestId('ws-monitors-ws_e2e_local').click();
    await expect(page.getByTestId('workspace-monitors-modal')).toBeVisible();

    await page.locator('#monitor-name').fill('E2E monitor');
    await page.locator('#monitor-request').selectOption('req_e2e');
    await page.locator('#monitor-webhook').fill('http://127.0.0.1:18099/alert');
    await page.getByRole('button', { name: 'Create monitor' }).click();
    await expect(page.getByText('E2E monitor').first()).toBeVisible({ timeout: 20000 });

    // Run it now and inspect the recorded run.
    await page.getByTestId('workspace-monitors-modal').getByRole('button', { name: 'Run now' }).first().click();
    await expect(page.getByTestId('workspace-monitors-modal').getByRole('button', { name: 'Run now' }).first()).toBeEnabled({ timeout: 60000 });
    await page.getByTestId('workspace-monitors-modal').getByRole('button', { name: 'History' }).first().click();
    await expect(page.locator('.monitor-run-badge').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.monitor-run-code').first()).toHaveText('200');

    // The backend has the same monitor and a successful run.
    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', deviceLabel: 'e2e' }),
    }).then((r) => r.json());
    const token = login.data.accessToken;
    const workspaces = await fetch(`${API}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const remote = workspaces.data.find((w) => w.name === 'Monitors E2E');
    expect(remote).toBeTruthy();

    const list = await fetch(`${API}/workspaces/${remote.id}/monitors`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    expect(list.data.some((m) => m.name === 'E2E monitor')).toBeTruthy();

    const monitorId = list.data.find((m) => m.name === 'E2E monitor').id;
    const runs = await fetch(`${API}/monitors/${monitorId}/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    expect(runs.data.length).toBeGreaterThan(0);
    expect(runs.data[0].ok).toBe(true);
    expect(runs.data[0].statusCode).toBe(200);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
