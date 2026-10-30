import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Opt-in: needs relay-api with the comments endpoints.
//   RELAY_CLOUD_E2E=1 RELAY_API_URL=http://127.0.0.1:18093 npx playwright test e2e/comments.spec.js
test.skip(!process.env.RELAY_CLOUD_E2E, 'set RELAY_CLOUD_E2E=1 with a running relay-api');

const API = `${process.env.RELAY_API_URL || 'http://127.0.0.1:18093'}/api/v1`;
const wsName = `Comments E2E ${Date.now()}`;
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

test('post a comment on a request and see it in the UI', async () => {
  test.setTimeout(120000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cmt-e2e-'));
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify({
      schemaVersion: 2,
      workspaces: [
        {
          id: 'ws_cmt_local',
          name: wsName,
          collections: [
            {
              id: 'col_cmt',
              name: 'Comments',
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
      activeWorkspaceId: 'ws_cmt_local',
    })
  );
  const email = `cmt-e2e-${Date.now()}@relay.test`;
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      RELAY_TEST_USER_DATA: userData,
      RELAY_API_URL: process.env.RELAY_API_URL || 'http://127.0.0.1:18093',
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.url-input', { timeout: 30000 });

    await page.getByTestId('cloud-status').click();
    await page.getByTestId('cloud-tab-register').click();
    await page.getByPlaceholder('Ada Lovelace').fill('Comment E2E');
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.locator('#cloud-auth-form input[type="password"]').fill('password123');
    await page.locator('button[form="cloud-auth-form"]').click();
    await expect(page.getByTestId('cloud-status')).toHaveText(/Local only/, { timeout: 20000 });

    await page.locator('.ws-button').click();
    await page.locator('[data-testid="ws-cloud-ws_cmt_local"]').click();
    await expect(page.getByTestId('cloud-status')).toHaveText(/Synced/, { timeout: 30000 });

    await page.locator('.request-row', { hasText: 'GET ok' }).first().click();
    await page.getByTestId('comments-open').click();
    await expect(page.getByTestId('comments-modal')).toBeVisible();

    const body = `Looks good ${Date.now()}`;
    await page.getByTestId('comment-input').fill(body);
    await page.getByTestId('comment-post').click();
    await expect(page.getByTestId('comment-item').filter({ hasText: body })).toBeVisible({
      timeout: 15000,
    });

    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', deviceLabel: 'e2e' }),
    }).then((r) => r.json());
    const token = login.data.accessToken;
    const workspaces = await fetch(`${API}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const remote = workspaces.data.find((w) => w.name === wsName);
    expect(remote).toBeTruthy();

    const comments = await fetch(
      `${API}/workspaces/${remote.id}/comments?entityId=req_e2e`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then((r) => r.json());
    expect(comments.data.comments.some((c) => c.body === body)).toBeTruthy();
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
