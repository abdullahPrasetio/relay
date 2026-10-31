import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = `${process.env.RELAY_API_URL || 'http://127.0.0.1:18086'}/api/v1`;

// Opt-in: needs a running relay-api. Start one and set:
//   RELAY_CLOUD_E2E=1 RELAY_API_URL=http://127.0.0.1:18086 npx playwright test e2e/cloud.spec.js
test.skip(!process.env.RELAY_CLOUD_E2E, 'set RELAY_CLOUD_E2E=1 with a running relay-api');

test('cloud signup, attach workspace, and baseline push', async () => {
  test.setTimeout(90000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cloud-e2e-'));
  const email = `e2e-${Date.now()}@relay.test`;
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      RELAY_TEST_USER_DATA: userData,
      RELAY_API_URL: process.env.RELAY_API_URL || 'http://127.0.0.1:18086',
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.url-input', { timeout: 30000 });

    await page.getByTestId('cloud-status').click();
    await page.getByTestId('cloud-tab-register').click();
    await page.getByPlaceholder('Ada Lovelace').fill('E2E User');
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.locator('#cloud-auth-form input[type="password"]').fill('password123');
    await page.locator('button[form="cloud-auth-form"]').click();

    await expect(page.getByTestId('cloud-status')).toHaveAttribute('data-state', 'local', { timeout: 20000 });

    await page.locator('.ws-button').click();
    await page.locator('[data-testid^="ws-cloud-"]').first().click();
    await expect(page.getByTestId('cloud-status')).toHaveAttribute('data-state', 'synced', { timeout: 30000 });

    // Confirm against the real backend: the workspace exists and has entities.
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', deviceLabel: 'e2e' }),
    }).then((r) => r.json());
    const token = loginRes.data.accessToken;
    const wsRes = await fetch(`${API}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    expect(wsRes.data.length).toBeGreaterThan(0);

    const remoteId = wsRes.data[0].id;
    const pull = await fetch(`${API}/workspaces/${remoteId}/changes?since=0`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());

    expect(pull.data.changes.length).toBeGreaterThan(0);
    const kinds = new Set(pull.data.changes.map((c) => c.kind));
    expect(kinds.has('collection')).toBeTruthy();
    expect(kinds.has('globals')).toBeTruthy();

    // Device management UI lists the session created by this app.
    await page.getByTestId('devices-open').click();
    await expect(page.getByText('Relay desktop').first()).toBeVisible({ timeout: 10000 });
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
