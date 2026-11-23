import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

function seed() {
  return {
    schemaVersion: 3,
    activeWorkspaceId: 'ws_dash',
    workspaces: [
      {
        id: 'ws_dash',
        name: 'Default',
        collections: [
          {
            id: 'col_dash',
            name: 'Brigate PO Sandbox',
            variables: [],
            items: [
              {
                id: 'fld_auth',
                type: 'folder',
                name: 'Auth',
                fieldValidations: {
                  headers: { 'X-Key': { rules: ['required'] } },
                },
                items: [
                  {
                    id: 'req_login',
                    type: 'request',
                    name: 'Login',
                    method: 'POST',
                    url: 'https://api.example.com/login',
                  },
                  {
                    id: 'req_refresh',
                    type: 'request',
                    name: 'Refresh Token',
                    method: 'POST',
                    url: 'https://api.example.com/refresh',
                  },
                ],
              },
              {
                id: 'req_health',
                type: 'request',
                name: 'Health Check',
                method: 'GET',
                url: 'https://api.example.com/health',
                headers: [{ key: 'X-Key', value: 'abc', enabled: true }],
              },
            ],
          },
        ],
        environments: [{ id: 'env_prod', name: 'Production', variables: [] }],
        globals: [],
        history: [
          {
            id: 'h1',
            at: new Date(Date.now() - 120000).toISOString(),
            method: 'GET',
            url: 'https://api.example.com/health',
            status: 200,
            ok: true,
            snapshot: {
              id: 'req_health',
              name: 'Health Check',
              method: 'GET',
              url: 'https://api.example.com/health',
            },
          },
          {
            id: 'h2',
            at: new Date(Date.now() - 3600000).toISOString(),
            method: 'POST',
            url: 'https://api.example.com/login',
            status: 401,
            ok: true,
            snapshot: {
              id: 'req_login',
              name: 'Login',
              method: 'POST',
              url: 'https://api.example.com/login',
            },
          },
        ],
        activeEnvId: 'env_prod',
      },
    ],
  };
}

test('workspace dashboard and collection bulk expansion', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = session;

  try {
    await expect(page.getByTestId('workspace-dashboard')).toBeVisible();
    await expect(page.locator('.req-tab-label')).toHaveText('Workspace');
    await expect(page.getByText('Welcome to Relay')).toBeVisible();
    await expect(page.getByTestId('workspace-dashboard').getByText('New collection')).toBeVisible();
    await expect(
      page.getByTestId('workspace-dashboard').getByRole('button', { name: /^Environments/ })
    ).toBeVisible();
    await expect(
      page.getByTestId('workspace-dashboard').getByText('Brigate PO Sandbox', { exact: true })
    ).toBeVisible();

    // Collections start collapsed; the bulk buttons reveal and hide the tree.
    await expect(page.locator('.request-row')).toHaveCount(0);
    await page.getByTestId('collections-expand-all').click();
    await expect(page.locator('.request-row')).toHaveCount(3);

    // Expansion is persisted per workspace across reloads.
    await page.reload();
    await page.waitForSelector('.collection-row');
    await expect(page.locator('.request-row')).toHaveCount(3);

    await page.getByTestId('collections-collapse-all').click();
    await expect(page.locator('.request-row')).toHaveCount(0);

    // Search must reveal matches even while collections are collapsed.
    await page.locator('.tree-search').fill('Login');
    await expect(page.locator('.request-row')).toHaveCount(1);
    await page.locator('.tree-search').fill('');
    await expect(page.locator('.request-row')).toHaveCount(0);

    // Starting a request dismisses the dashboard and reveals the editor.
    await page.getByTestId('dashboard-new-request').click();
    await expect(page.getByTestId('workspace-dashboard')).toHaveCount(0);
    await expect(page.locator('.url-input')).toBeVisible();

    // The + tab button is an explicit new request, so it skips the dashboard.
    await page.locator('.tabbar-add').click();
    await expect(page.getByTestId('workspace-dashboard')).toHaveCount(0);
    await expect(page.locator('.url-input')).toBeVisible();
  } finally {
    await closeApp(session);
  }
});

test('command palette searches requests and runs actions', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData);
  const { page } = session;
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

  try {
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await expect(page.getByTestId('command-input')).toBeFocused();

    await page.getByTestId('command-input').fill('Health Check');
    await page.getByTestId('command-item-request:req_health').click();
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await expect(page.locator('.url-input')).toHaveValue('https://api.example.com/health');

    await page.keyboard.press(`${mod}+k`);
    await page.getByTestId('command-input').fill('Appearance');
    await page.getByTestId('command-input').press('Enter');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await expect(page.getByTestId('appearance-mode-light')).toBeVisible();
  } finally {
    await closeApp(session);
  }
});

test('pins requests to the dashboard and persists them', async () => {
  test.setTimeout(60000);
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = session;

  try {
    await page.getByTestId('collections-expand-all').click();
    await page.locator('.request-row', { hasText: 'Health Check' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin to dashboard' }).click();

    const dashboard = page.getByTestId('workspace-dashboard');
    await expect(dashboard).toContainText('Pinned requests');
    await expect(dashboard.locator('.dashboard-recent-item', { hasText: 'Health Check' })).toHaveCount(1);

    await page.reload();
    await page.waitForSelector('[data-testid="workspace-dashboard"]');
    const reloaded = page.getByTestId('workspace-dashboard');
    await expect(reloaded.locator('.dashboard-recent-item', { hasText: 'Health Check' })).toHaveCount(1);

    await reloaded.locator('.dashboard-recent-item', { hasText: 'Health Check' }).click();
    await expect(page.locator('.url-input')).toHaveValue('https://api.example.com/health');
  } finally {
    await closeApp(session);
  }
});

test('MCP sensitive-data settings persist', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = session;

  try {
    await page.locator('.ws-button').click();
    const workspaceToggle = page.getByTestId('ws-mcp-sensitive').locator('input');
    await expect(workspaceToggle).not.toBeChecked();
    await workspaceToggle.check();
    await page.waitForTimeout(500);
    await page.locator('.kebab-backdrop').click({ position: { x: 5, y: 5 } });

    await page.reload();
    await page.waitForSelector('.ws-button');
    await page.locator('.ws-button').click();
    await expect(page.getByTestId('ws-mcp-sensitive').locator('input')).toBeChecked();
    await page.locator('.kebab-backdrop').click({ position: { x: 5, y: 5 } });

    await page.locator('.collection-name').click();
    await page.getByTestId('collection-mcp-access').selectOption('allow');
    await page.waitForTimeout(500);
    await page.locator('.modal-head .icon-btn').click();

    await page.reload();
    await page.waitForSelector('.collection-name');
    await page.locator('.collection-name').click();
    await expect(page.getByTestId('collection-mcp-access')).toHaveValue('allow');
  } finally {
    await closeApp(session);
  }
});

test('collection validation editor persists inherited rules', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = session;

  try {
    await page.locator('.collection-name').click();
    await page.getByRole('button', { name: 'Validation' }).click();
    const field = page.getByTestId('validation-field-headers-X-Key');
    await expect(field).toBeVisible();
    await field.getByRole('button', { name: 'required' }).click();
    await page.waitForTimeout(400);
    await page.locator('.modal-head .icon-btn').click();

    await page.reload();
    await page.waitForSelector('.collection-name');
    await page.locator('.collection-name').click();
    await page.getByRole('button', { name: 'Validation' }).click();
    await expect(page.getByTestId('validation-field-headers-X-Key')).toHaveClass(
      /documented/
    );
  } finally {
    await closeApp(session);
  }
});

test('folder validation editor opens from the folder menu', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = session;

  try {
    await page.getByTestId('collections-expand-all').click();
    await page.locator('.folder-row', { hasText: 'Auth' }).click({ button: 'right' });
    await page.getByText('Edit Validation', { exact: true }).click();
    await expect(page.locator('.modal-head')).toContainText('Validation · Auth');
    await expect(page.getByTestId('validation-field-headers-X-Key')).toBeVisible();
    await page.locator('.modal-head .icon-btn').click();
  } finally {
    await closeApp(session);
  }
});

test('secret scan finds neutral variables and marks them secret', async () => {
  const data = seed();
  data.workspaces[0].environments[0].variables.push({
    key: 'NEUTRAL_VALUE',
    value: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
    type: 'default',
    enabled: true,
  });
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(data, null, 2));
  const session = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = session;

  try {
    await page.locator('.ws-button').click();
    await page.getByTestId('ws-secret-scan').click();
    await expect(page.getByTestId('secret-scan-list')).toBeVisible();
    await expect(page.getByTestId('secret-scan-list')).toContainText('NEUTRAL_VALUE');
    await page.getByRole('button', { name: 'Mark as secret' }).click();
    await expect(page.getByText('No likely secrets found.')).toBeVisible();
  } finally {
    await closeApp(session);
  }
});

test('opening an empty saved request shows the editor, not the dashboard', async () => {
  // A saved request can legitimately be named "Untitled Request" with an empty
  // URL (sidebar "Add Request" creates exactly that). The dashboard must only
  // own the untouched launch tab, otherwise adding/opening such a request
  // leaves the welcome screen on top and the new request appears missing.
  const data = seed();
  data.workspaces[0].collections[0].items.push({
    id: 'req_blank',
    type: 'request',
    name: 'Untitled Request',
    method: 'GET',
    url: '',
  });
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(data, null, 2));
  const session = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = session;

  try {
    await page.waitForSelector('.collection-row');
    await page.getByTestId('collections-expand-all').click();
    await page.locator('.request-row', { hasText: 'Untitled Request' }).click();

    await expect(page.getByTestId('workspace-dashboard')).toHaveCount(0);
    await expect(page.locator('.url-input')).toBeVisible();
    await expect(page.locator('.req-tab-label.active, .req-tab.active')).toContainText('Untitled Request');
  } finally {
    await closeApp(session);
  }
});

test('sidebar Add Request opens the editor immediately', async () => {
  const userData = makeUserData();
  fs.writeFileSync(path.join(userData, 'rest-tamer-data.json'), JSON.stringify(seed(), null, 2));
  const session = await launchAppAt(userData, {}, { keepDashboard: true });
  const { page } = session;

  try {
    const collection = page.locator('.collection-row').first();
    await collection.getByTitle('Collection actions').click();
    await page.getByRole('button', { name: 'Add Request', exact: true }).click();

    await expect(page.getByTestId('workspace-dashboard')).toHaveCount(0);
    await expect(page.locator('.url-input')).toBeVisible();

    // Adding into a collapsed collection must reveal the new node too.
    await expect(page.locator('.request-row', { hasText: 'Untitled Request' })).toHaveCount(1);
  } finally {
    await closeApp(session);
  }
});
