import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import {
  authHeader,
  confluenceBase,
  publishPage,
  testConnection,
} from '../../electron/confluence-client.js';
import { DEFAULT_NETWORK_SETTINGS } from '../../shared/networkSettings.js';

const servers = [];

function startServer(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });
}

function json(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(text);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

describe('confluenceBase', () => {
  it('derives REST roots for Cloud, wiki URLs, and Data Center', () => {
    expect(confluenceBase('https://org.atlassian.net').apiBase).toBe(
      'https://org.atlassian.net/wiki/rest/api'
    );
    expect(confluenceBase('https://org.atlassian.net/wiki').apiBase).toBe(
      'https://org.atlassian.net/wiki/rest/api'
    );
    expect(confluenceBase('https://org.atlassian.net/wiki/rest/api').apiBase).toBe(
      'https://org.atlassian.net/wiki/rest/api'
    );
    expect(confluenceBase('https://confluence.example.com/').apiBase).toBe(
      'https://confluence.example.com/rest/api'
    );
  });

  it('rejects invalid or credentialed URLs', () => {
    expect(confluenceBase('').ok).toBe(false);
    expect(confluenceBase('ftp://org.test').ok).toBe(false);
    expect(confluenceBase('https://user:pass@org.test').ok).toBe(false);
    expect(confluenceBase('not a url').ok).toBe(false);
  });
});

describe('authHeader', () => {
  it('uses Bearer for PAT and Basic for Cloud', () => {
    expect(authHeader({ authMethod: 'pat' }, 'token').value).toBe('Bearer token');
    expect(authHeader({ authMethod: 'cloud', email: 'a@b.test' }, 'token').value).toBe(
      `Basic ${Buffer.from('a@b.test:token').toString('base64')}`
    );
    expect(authHeader({ authMethod: 'cloud' }, 'token').ok).toBe(false);
    expect(authHeader({ authMethod: 'pat' }, '').ok).toBe(false);
  });
});

describe('testConnection', () => {
  it('returns the current user and sends Basic auth', async () => {
    let auth = '';
    const { base } = await startServer((req, res) => {
      auth = req.headers.authorization || '';
      json(res, 200, { displayName: 'Ada', email: 'ada@test' });
    });
    const res = await testConnection({
      config: { baseUrl: base, authMethod: 'cloud', email: 'ada@test' },
      token: 'secret',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(res).toMatchObject({ ok: true, displayName: 'Ada', email: 'ada@test' });
    expect(auth).toBe(`Basic ${Buffer.from('ada@test:secret').toString('base64')}`);
  });
});

function updateServer({ title = 'Old', space = 'DOCS', conflict = false } = {}) {
  const calls = { puts: [], gets: [], posts: [] };
  let puts = 0;
  return startServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/rest/api/content/1') {
      calls.gets.push(url.search);
      json(res, 200, {
        id: '1',
        title,
        type: 'page',
        space: { key: space },
        version: { number: 3 },
        _links: { base: 'http://x/wiki', webui: '/spaces/DOCS/pages/1' },
      });
      return;
    }
    if (req.method === 'GET' && path === '/rest/api/content' && url.searchParams.has('title')) {
      calls.gets.push(url.search);
      json(res, 200, { results: [] });
      return;
    }
    if (req.method === 'PUT' && path === '/rest/api/content/1') {
      const body = JSON.parse(await readBody(req));
      calls.puts.push(body);
      puts += 1;
      if (conflict && puts === 1) {
        json(res, 409, { message: 'Version conflict' });
        return;
      }
      json(res, 200, {
        id: '1',
        title: body.title,
        version: { number: body.version.number + (conflict ? 3 : 0) },
        _links: { base: 'http://x/wiki', webui: '/spaces/DOCS/pages/1' },
      });
      return;
    }
    json(res, 404, { message: 'not found' });
  });
}

describe('publishPage update', () => {
  it('fetches the version and writes version+1', async () => {
    const { base } = await updateServer();
    const res = await publishPage({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      pageId: '1',
      title: 'Old',
      content: '<h1>hi</h1>',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(res).toMatchObject({ ok: true, pageId: '1', version: 4, created: false });
    expect(res.url).toBe('http://x/wiki/spaces/DOCS/pages/1');
  });

  it('reports a title conflict without writing', async () => {
    const calls = { puts: [] };
    const { base } = await startServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/rest/api/content/1') {
        json(res, 200, {
          id: '1',
          title: 'Old',
          type: 'page',
          space: { key: 'DOCS' },
          version: { number: 2 },
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/rest/api/content') {
        json(res, 200, { results: [{ id: '2', title: 'Taken', version: { number: 1 } }] });
        return;
      }
      if (req.method === 'PUT') calls.puts.push(await readBody(req));
      json(res, 200, {});
    });

    const res = await publishPage({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      pageId: '1',
      title: 'Taken',
      content: 'x',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(res).toMatchObject({ ok: false, code: 'title_conflict', existingId: '2' });
    expect(calls.puts).toHaveLength(0);
  });

  it('rejects a page in another space', async () => {
    const { base } = await updateServer({ space: 'OTHER' });
    const res = await publishPage({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      pageId: '1',
      title: 'Old',
      content: 'x',
      spaceKey: 'DOCS',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(res).toMatchObject({ ok: false, code: 'space_mismatch' });
  });

  it('surfaces 409 and can retry after an explicit force', async () => {
    const { base } = await updateServer({ conflict: true });
    const blocked = await publishPage({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      pageId: '1',
      title: 'Old',
      content: 'x',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(blocked).toMatchObject({ ok: false, code: 'conflict', currentVersion: 3 });

    const forced = await publishPage({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      pageId: '1',
      title: 'Old',
      content: 'x',
      force: true,
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(forced.ok).toBe(true);
  });
});

describe('publishPage create', () => {
  function createServer({ parentSpace = 'DOCS', parentType = 'page', existing = [] } = {}) {
    const calls = { posts: [], gets: [] };
    return {
      calls,
      server: startServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/rest/api/content/9') {
          calls.gets.push(url.search);
          json(res, 200, {
            id: '9',
            type: parentType,
            space: { key: parentSpace },
            version: { number: 1 },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/rest/api/content') {
          calls.gets.push(url.search);
          json(res, 200, { results: existing });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/rest/api/content') {
          const body = JSON.parse(await readBody(req));
          calls.posts.push(body);
          json(res, 200, {
            id: '10',
            title: body.title,
            version: { number: 1 },
            _links: { base: 'http://x/wiki', webui: '/spaces/DOCS/pages/10' },
          });
          return;
        }
        json(res, 404, { message: 'not found' });
      }),
    };
  }

  it('creates under the explicit parent and checks the title', async () => {
    const { server, calls } = createServer();
    const { base } = await server;
    const res = await publishPage({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      title: 'New page',
      content: '<p>x</p>',
      spaceKey: 'DOCS',
      parentPageId: '9',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(res).toMatchObject({ ok: true, pageId: '10', created: true });
    expect(calls.posts[0].ancestors).toEqual([{ id: '9' }]);
    expect(calls.posts[0].space).toEqual({ key: 'DOCS' });
    expect(calls.gets.some((q) => q.includes('title=New+page'))).toBe(true);
  });

  it('requires a parent and validates its type/space', async () => {
    const missingServer = createServer();
    const { base } = await missingServer.server;
    const missing = await publishPage({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      title: 'X',
      content: 'x',
      spaceKey: 'DOCS',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(missing).toMatchObject({ ok: false, code: 'parent_required' });

    const wrongSpace = createServer({ parentSpace: 'OTHER' });
    const wrong = await publishPage({
      config: { baseUrl: (await wrongSpace.server).base, authMethod: 'pat' },
      token: 'pat',
      title: 'X',
      content: 'x',
      spaceKey: 'DOCS',
      parentPageId: '9',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(wrong).toMatchObject({ ok: false, code: 'parent_invalid' });

    const wrongType = createServer({ parentType: 'blogpost' });
    const badType = await publishPage({
      config: { baseUrl: (await wrongType.server).base, authMethod: 'pat' },
      token: 'pat',
      title: 'X',
      content: 'x',
      spaceKey: 'DOCS',
      parentPageId: '9',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(badType).toMatchObject({ ok: false, code: 'parent_invalid' });
  });

  it('never posts when the title is taken', async () => {
    const { server, calls } = createServer({ existing: [{ id: '77', title: 'X' }] });
    const { base } = await server;
    const res = await publishPage({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      title: 'X',
      content: 'x',
      spaceKey: 'DOCS',
      parentPageId: '9',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(res).toMatchObject({ ok: false, code: 'title_conflict', existingId: '77' });
    expect(calls.posts).toHaveLength(0);
  });
});

describe('transport safety', () => {
  it('rejects redirects instead of forwarding the token', async () => {
    const { base } = await startServer((req, res) => {
      res.writeHead(302, { Location: 'https://evil.test/login' });
      res.end();
    });
    const res = await testConnection({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(res).toMatchObject({ ok: false, code: 'redirect' });
  });

  it('rejects an HTML/SSO response', async () => {
    const { base } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>login</html>');
    });
    const res = await testConnection({
      config: { baseUrl: base, authMethod: 'pat' },
      token: 'pat',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(res).toMatchObject({ ok: false, code: 'html_response' });
  });
});
