import { expect, test } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

// Self-contained fake Confluence (Data Center PAT). No real credentials or
// network access are required.
function startFakeConfluence() {
  const state = {
    pages: {
      9: {
        id: '9',
        type: 'page',
        title: 'API Docs',
        space: { key: 'DOCS' },
        version: { number: 1 },
        _links: { base: '', webui: '/pages/9' },
      },
    },
    posts: [],
    puts: [],
    conflictNext: false,
  };
  const server = http.createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/rest/api/user/current') {
      json(200, { displayName: 'Confluence Tester', email: 'tester@example.com' });
      return;
    }
    if (req.method === 'GET' && p === '/rest/api/content/9') {
      json(200, state.pages[9]);
      return;
    }
    if (req.method === 'GET' && p === '/rest/api/content/10') {
      json(200, state.pages[10]);
      return;
    }
    if (req.method === 'GET' && p === '/rest/api/content') {
      const title = url.searchParams.get('title') || '';
      if (title === 'Taken title') {
        json(200, { results: [{ id: '77', title, version: { number: 1 } }] });
      } else {
        json(200, { results: [] });
      }
      return;
    }
    if (req.method === 'POST' && p === '/rest/api/content') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        state.posts.push(body);
        state.pages[10] = {
          id: '10',
          type: 'page',
          title: body.title,
          space: { key: body.space.key },
          version: { number: 1 },
          _links: { base: '', webui: '/pages/10' },
        };
        state.pages['10']._links.base = `http://127.0.0.1:${server.address().port}/wiki`;
        json(200, state.pages[10]);
      });
      return;
    }
    if (req.method === 'PUT' && p === '/rest/api/content/10') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (state.conflictNext) {
          state.conflictNext = false;
          json(409, { message: 'Version conflict' });
          return;
        }
        state.puts.push(body);
        state.pages[10] = {
          ...state.pages[10],
          title: body.title,
          version: { number: body.version.number + 1 },
        };
        json(200, state.pages[10]);
      });
      return;
    }
    json(404, { message: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}`, state });
    });
  });
}

function seedWorkspace() {
  const request = {
    id: 'req_cf',
    name: 'List payments',
    method: 'GET',
    url: '{{baseUrl}}/payments',
    params: [{ key: 'limit', value: '10', enabled: true }],
    pathVars: [],
    headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
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
  return {
    schemaVersion: 3,
    workspaces: [
      {
        id: 'ws_cf',
        name: 'Confluence WS',
        collections: [
          {
            id: 'col_cf',
            name: 'Payments API',
            description: 'Payment endpoints',
            variables: [{ key: 'token', value: 'plain-secret-value', enabled: true, type: 'secret' }],
            auth: { type: 'none' },
            preRequest: '',
            tests: '',
            items: [request],
            confluencePageId: '',
            confluencePageUrl: '',
            confluenceTitle: '',
            confluenceSpaceKey: '',
            confluenceParentPageId: '',
            confluenceSyncedAt: null,
            confluenceVersion: null,
          },
        ],
        environments: [],
        globals: [],
        history: [],
        activeEnvId: null,
      },
    ],
    activeWorkspaceId: 'ws_cf',
  };
}

test('publishes update-only and create, and reports title conflicts', async () => {
  test.setTimeout(120000);
  const fake = await startFakeConfluence();
  const userData = makeUserData();
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify(seedWorkspace(), null, 2)
  );
  const session = await launchAppAt(userData);
  const { page } = session;
  const token = 'e2e-confluence-pat-secret';

  try {
    await page.locator('.ws-button').click();
    await page.getByTestId('ws-confluence').click();
    await page.getByTestId('confluence-base-url').fill(fake.base);
    await page.getByTestId('confluence-auth-method').selectOption('pat');
    await page.getByTestId('confluence-token').fill(token);
    await page.getByTestId('confluence-test').click();
    await expect(page.getByTestId('confluence-notice')).toContainText('Confluence Tester');
    await page.getByTestId('confluence-save').click();

    // Create: space + explicit parent are required.
    await page.locator('.collection-row .kebab-btn').first().click();
    await page.getByText('Sync to Confluence…').click();
    await page.getByTestId('confluence-page-title').fill('Payments docs');
    await page.getByTestId('confluence-space-key').fill('DOCS');
    await page.getByTestId('confluence-parent-id').fill('9');
    await page.getByTestId('confluence-create').click();
    await expect(page.getByTestId('confluence-sync-notice')).toContainText('Created page');
    expect(fake.state.posts).toHaveLength(1);
    expect(fake.state.posts[0].ancestors).toEqual([{ id: '9' }]);
    expect(fake.state.posts[0].title).toBe('Payments docs');
    await expect(page.getByTestId('confluence-linked-page')).toContainText('10');

    // Update: same title, version+1.
    await page.getByTestId('confluence-update').click();
    await expect(page.getByTestId('confluence-sync-notice')).toContainText('Updated page');
    expect(fake.state.puts).toHaveLength(1);
    expect(fake.state.puts[0].version.number).toBe(2);

    // Duplicate title is blocked before PUT.
    await page.getByTestId('confluence-page-title').fill('Taken title');
    await page.getByTestId('confluence-update').click();
    await expect(page.getByTestId('confluence-title-conflict')).toBeVisible();
    expect(fake.state.puts).toHaveLength(1);

    // Version conflict: explicit overwrite only.
    await page.getByTestId('confluence-page-title').fill('Payments docs');
    fake.state.conflictNext = true;
    await page.getByTestId('confluence-update').click();
    await expect(page.getByTestId('confluence-version-conflict')).toBeVisible();
    await page.getByTestId('confluence-overwrite').click();
    await expect(page.getByTestId('confluence-sync-notice')).toContainText('Updated page');
    expect(fake.state.puts).toHaveLength(2);

    // Wait for the debounced workspace save, then prove the token is encrypted.
    await expect
      .poll(() => {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(userData, 'rest-tamer-data.json'), 'utf8')
          );
          return Boolean(data.confluenceByWorkspace?.ws_cf?.tokenEnc);
        } catch {
          return false;
        }
      })
      .toBe(true);
    const rendererData = await page.evaluate(() => globalThis.api.loadData());
    expect(rendererData.confluenceByWorkspace).toBeUndefined();

    const data = fs.readFileSync(path.join(userData, 'rest-tamer-data.json'), 'utf8');
    expect(data).not.toContain(token);
    expect(data).toContain('tokenEnc');
    expect(data).toContain('"confluenceByWorkspace"');
  } finally {
    await closeApp(session);
    await new Promise((resolve) => fake.server.close(resolve));
  }
});
