import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Opt-in: needs relay-api with mentions support.
//   RELAY_CLOUD_E2E=1 RELAY_API_URL=http://127.0.0.1:18095 npx playwright test e2e/mentions.spec.js
test.skip(!process.env.RELAY_CLOUD_E2E, 'set RELAY_CLOUD_E2E=1 with a running relay-api');

const API = `${process.env.RELAY_API_URL || 'http://127.0.0.1:18095'}/api/v1`;
const wsName = `Mentions E2E ${Date.now()}`;
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

test('renders a mention in comments and in the mentions feed', async () => {
  test.setTimeout(120000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mention-e2e-'));
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify({
      schemaVersion: 2,
      workspaces: [
        {
          id: 'ws_mention_local',
          name: wsName,
          collections: [
            {
              id: 'col_mention',
              name: 'Mentions',
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
      activeWorkspaceId: 'ws_mention_local',
    })
  );
  const email = `mention-e2e-${Date.now()}@relay.test`;
  const displayName = 'Mention E2E';
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      RELAY_TEST_USER_DATA: userData,
      RELAY_API_URL: process.env.RELAY_API_URL || 'http://127.0.0.1:18095',
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.url-input', { timeout: 30000 });

    await page.getByTestId('cloud-status').click();
    await page.getByTestId('cloud-tab-register').click();
    await page.getByPlaceholder('Ada Lovelace').fill(displayName);
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.locator('#cloud-auth-form input[type="password"]').fill('password123');
    await page.locator('button[form="cloud-auth-form"]').click();
    await expect(page.getByTestId('cloud-status')).toHaveAttribute('data-state', 'local', { timeout: 20000 });

    await page.locator('.ws-button').click();
    await page.locator('[data-testid="ws-cloud-ws_mention_local"]').click();
    await expect(page.getByTestId('cloud-status')).toHaveAttribute('data-state', 'synced', { timeout: 30000 });

    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', deviceLabel: 'e2e' }),
    }).then((r) => r.json());
    const token = login.data.accessToken;
    const userId = login.data.user.id;
    const workspaces = await fetch(`${API}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const remote = workspaces.data.find((w) => w.name === wsName);
    expect(remote).toBeTruthy();

    const body = `Please check @${displayName}`;
    const created = await fetch(`${API}/workspaces/${remote.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ entityId: request.id, body, mentions: [userId] }),
    }).then((r) => r.json());
    expect(created.data.mentions.length).toBe(1);

    // Comments modal highlights the mention.
    await page.locator('.request-row', { hasText: 'GET ok' }).first().click();
    await page.getByTestId('comments-open').click();
    await expect(page.getByTestId('comments-modal')).toBeVisible();
    await expect(page.getByTestId('comment-item').filter({ hasText: 'Please check' })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId('comment-mention-token').first()).toHaveText(`@${displayName}`);
    await expect(page.getByTestId('comment-mention-badge').first()).toBeVisible();

    // Mentions feed lists it for the mentioned user.
    await page.locator('.modal-head button[title="Close"]').first().click();
    await page.locator('.ws-button').click();
    await page.getByTestId('ws-mentions-ws_mention_local').click();
    await expect(page.getByTestId('mentions-modal')).toBeVisible();
    await expect(page.getByTestId('mention-item').filter({ hasText: 'Please check' })).toBeVisible({
      timeout: 15000,
    });

    const feed = await fetch(`${API}/workspaces/${remote.id}/mentions`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    expect(feed.data.comments.some((c) => c.body === body)).toBeTruthy();
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
