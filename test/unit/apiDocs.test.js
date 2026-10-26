import { describe, expect, it } from 'vitest';
import {
  collectionToHtml,
  escapeHtml,
  suggestDocsName,
} from '../../src/lib/apiDocs.js';

const SECRET = 'super-secret-value';

function fixture() {
  return {
    id: 'col_1',
    name: 'Payments & <API>',
    description: 'Docs for "payments" & <script>alert(1)</script>',
    variables: [
      { key: 'baseUrl', value: 'https://api.test', enabled: true, type: 'default' },
      { key: 'token', value: SECRET, enabled: true, type: 'secret' },
    ],
    items: [
      {
        id: 'folder_1',
        type: 'folder',
        name: 'Users & <Folder>',
        description: 'A <folder> & its "things"',
        items: [
          {
            id: 'req_1',
            type: 'request',
            name: 'List <Users>',
            method: 'GET',
            url: 'https://api.test/users?q=1&page=2',
            description: 'Returns "users" & <script>alert(1)</script>',
            params: [
              { key: 'q', value: 'a&b', enabled: true },
              { key: 'page', value: '2', enabled: false },
            ],
            headers: [{ key: 'X-Test', value: '<value> & "quoted"' }],
            body: { mode: 'json', raw: '{"a":1,"b":"<script>alert(1)</script>"}' },
            auth: { type: 'bearer', bearer: { token: 'auth-secret-token' } },
            examples: [
              {
                name: 'First <example>',
                savedAt: '2026-01-01T00:00:00.000Z',
                request: { method: 'GET', url: 'https://api.test/users?q=1&page=2' },
                response: {
                  status: 201,
                  statusText: 'Created',
                  contentType: 'application/json',
                  headers: [],
                  body: '{"ok":true}',
                },
              },
            ],
          },
          {
            id: 'req_2',
            type: 'request',
            name: 'Raw body',
            method: 'POST',
            url: 'https://api.test/raw',
            params: [],
            headers: [],
            body: { mode: 'raw', raw: 'line one\n<not-json> & "x"' },
            auth: { type: 'inherit' },
            examples: [],
          },
        ],
      },
      {
        id: 'req_3',
        type: 'request',
        name: 'Form request',
        method: 'DELETE',
        url: 'https://api.test/{{id}}/form',
        params: [],
        headers: [],
        body: {
          mode: 'form-urlencoded',
          form: [
            { key: 'name', value: 'A & B', enabled: true },
            { key: 'skip', value: 'me', enabled: false },
          ],
        },
        auth: { type: 'apikey', apikey: { key: 'k', value: 'v' } },
        examples: [],
      },
    ],
  };
}

function anchors(html) {
  const tocHrefs = [...html.matchAll(/<li class="toc-[^"]*[^>]*><a href="#([^"]+)"/g)].map(
    (m) => m[1]
  );
  const ids = [...html.matchAll(/<(?:article|section)[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  return { tocHrefs, ids };
}

describe('collectionToHtml', () => {
  it('emits a self-contained document with structure, counts and an anchored TOC', () => {
    const html = collectionToHtml(fixture(), {
      workspaceName: 'Local <Workspace>',
      generatedAt: '2026-10-27T12:00:00.000Z',
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Payments &amp; &lt;API&gt; — API docs</title>');
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('Workspace: Local &lt;Workspace&gt;');
    expect(html).toContain('Generated 2026-10-27T12:00:00.000Z');
    expect(html).toContain('3 requests · 1 folder');

    expect((html.match(/<article class="request"/g) || []).length).toBe(3);
    expect((html.match(/<section class="folder"/g) || []).length).toBe(1);

    const { tocHrefs, ids } = anchors(html);
    expect(tocHrefs.length).toBe(5); // variables + 1 folder + 3 requests
    expect(new Set(tocHrefs).size).toBe(tocHrefs.length);
    for (const href of tocHrefs) expect(ids).toContain(href);
    for (const id of ids) expect(tocHrefs).toContain(id);
  });

  it('escapes every interpolated value', () => {
    const html = collectionToHtml(fixture(), { generatedAt: '2026-10-27T12:00:00.000Z' });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<Folder>');
    expect(html).not.toContain('<Users>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Users &amp; &lt;Folder&gt;');
    expect(html).toContain('List &lt;Users&gt;');
    expect(html).toContain('&lt;value&gt; &amp; &quot;quoted&quot;');
    expect(html).toContain('https://api.test/users?q=1&amp;page=2');
    expect(escapeHtml('<a href="x">&\'')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;'
    );
  });

  it('renders params, headers, pretty JSON and verbatim non-JSON bodies', () => {
    const html = collectionToHtml(fixture(), { generatedAt: '2026-10-27T12:00:00.000Z' });

    expect(html).toContain('<h4>Query parameters</h4>');
    expect(html).toContain('<th>Enabled</th>');
    expect(html).toContain('<td>a&amp;b</td>');
    expect(html).toContain('<td>no</td>');
    expect(html).toContain('<h4>Headers</h4>');
    expect(html).toContain('<td>X-Test</td>');

    // JSON body is pretty-printed (quotes escaped by escapeHtml).
    expect(html).toMatch(/<pre>\{[\s\S]*?&quot;a&quot;: 1/);
    // Non-JSON body stays verbatim inside <pre>.
    expect(html).toContain('<pre>line one\n&lt;not-json&gt; &amp; &quot;x&quot;</pre>');
    // Form rows become a table.
    expect(html).toContain('<h4>Body (form-urlencoded)</h4>');
    expect(html).toContain('<td>name</td><td>A &amp; B</td><td>yes</td>');
    expect(html).toContain('<td>skip</td><td>me</td><td>no</td>');
  });

  it('shows the auth type but never credentials', () => {
    const html = collectionToHtml(fixture(), { generatedAt: '2026-10-27T12:00:00.000Z' });
    expect(html).toContain('Auth: <code>bearer</code>');
    expect(html).toContain('Auth: <code>inherit</code>');
    expect(html).toContain('Auth: <code>apikey</code>');
    expect(html).not.toContain('auth-secret-token');
  });

  it('includes saved examples by default and omits them on request', () => {
    const withExamples = collectionToHtml(fixture(), {
      generatedAt: '2026-10-27T12:00:00.000Z',
    });
    expect(withExamples).toContain('Saved examples');
    expect(withExamples).toContain('First &lt;example&gt;');
    expect(withExamples).toContain('201 Created');
    expect(withExamples).toContain('application/json');
    expect(withExamples).toMatch(/&quot;ok&quot;: true/);

    const without = collectionToHtml(fixture(), {
      generatedAt: '2026-10-27T12:00:00.000Z',
      includeExamples: false,
    });
    expect(without).not.toContain('Saved examples');
    expect(without).not.toContain('First &lt;example&gt;');
    expect(without).not.toContain('201 Created');
  });

  it('never emits plaintext secret variable values', () => {
    const html = collectionToHtml(fixture(), { generatedAt: '2026-10-27T12:00:00.000Z' });
    expect(html).toContain('https://api.test');
    expect(html).toContain('(secret)');
    expect(html).not.toContain(SECRET);
  });

  it('produces valid HTML for an empty collection', () => {
    const html = collectionToHtml(
      { id: 'col_empty', name: 'Empty', description: '', variables: [], items: [] },
      { generatedAt: '2026-10-27T12:00:00.000Z' }
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('0 requests · 0 folders');
    expect(html).not.toContain('<article class="request"');
    expect(html).toContain('No requests in this collection.');
    expect(html.trim().endsWith('</html>')).toBe(true);
  });

  it('dedupes anchors for identical folders and requests', () => {
    const request = {
      type: 'request',
      name: 'Same',
      method: 'GET',
      url: 'https://api.test/same',
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'none' },
      examples: [],
    };
    const html = collectionToHtml(
      {
        name: 'Dupes',
        items: [
          { type: 'folder', name: 'Folder', items: [request, request] },
          { type: 'folder', name: 'Folder', items: [] },
        ],
      },
      { generatedAt: '2026-10-27T12:00:00.000Z' }
    );

    const { tocHrefs, ids } = anchors(html);
    expect(new Set(tocHrefs).size).toBe(tocHrefs.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tocHrefs).toEqual(
      expect.arrayContaining(['folder-folder', 'folder-folder-2', 'req-get-same-same', 'req-get-same-same-2'])
    );
  });

});

describe('suggestDocsName', () => {
  it('slugifies the collection name and appends the docs extension', () => {
    expect(suggestDocsName({ name: 'Payments API & Stuff' })).toBe(
      'payments-api-stuff-docs.html'
    );
    expect(suggestDocsName({ name: '   ' })).toBe('collection-docs.html');
    expect(suggestDocsName({})).toBe('collection-docs.html');
  });
});
