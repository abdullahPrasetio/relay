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
            body: {
              mode: 'json',
              raw: '{"a":1,"b":"<script>alert(1)</script>","user":{"email":"a@test.dev"}}',
            },
            fieldValidations: {
              params: {
                q: { rules: ['required', 'string'], min: 1, max: 20, description: 'Search <term>' },
              },
              headers: {
                'X-Test': { rules: ['required'], description: 'Tenant key & <id>' },
              },
              body: {
                a: { rules: ['integer'], min: 1, max: 9, description: 'Page size' },
                'user.email': { rules: ['email', 'required'], description: 'Primary email' },
              },
            },
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
        fieldValidations: {
          path: { id: { rules: ['required'], description: 'Resource id' } },
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
    expect(html).toContain('<th>Enabled</th>');

    // JSON body is pretty-printed (quotes escaped by escapeHtml).
    expect(html).toMatch(/<pre>\{[\s\S]*?&quot;a&quot;: 1/);
    // Non-JSON body stays verbatim inside <pre>.
    expect(html).toContain('<pre>line one\n&lt;not-json&gt; &amp; &quot;x&quot;</pre>');
    // Form rows become a table.
    expect(html).toContain('<h4>Body (form-urlencoded)</h4>');
    expect(html).toContain('<td>name</td><td>A &amp; B</td><td>yes</td>');
    expect(html).toContain('<td>skip</td><td>me</td><td>no</td>');
  });

  it('renders request and field descriptions with validation badges', () => {
    const html = collectionToHtml(fixture(), { generatedAt: '2026-10-27T12:00:00.000Z' });

    expect(html).toContain('<h4>Path variables</h4>');
    expect(html).toContain('<td>id</td><td></td><td>');
    expect(html).toContain('<td class="field-description">Resource id</td>');
    expect(html).toContain('<th>Validation</th>');
    expect(html).toContain('<th>Description</th>');
    expect(html).toContain('<span class="validation-token">REQUIRED</span>');
    expect(html).toContain('<span class="validation-token">MIN 1</span>');
    expect(html).toContain('<span class="validation-token">MAX 20</span>');
    expect(html).toContain('<td class="field-description">Search &lt;term&gt;</td>');
    expect(html).toContain('<td class="field-description">Tenant key &amp; &lt;id&gt;</td>');
    expect(html).toContain('<h4>Body fields</h4>');
    expect(html).toContain('<td>user.email</td>');
    expect(html).toContain('<td class="field-description">Primary email</td>');
    expect(html).toContain('Returns &quot;users&quot; &amp; &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('includes a validation legend and standard constraint tokens', () => {
    const html = collectionToHtml(
      {
        name: 'Validated',
        items: [
          {
            type: 'request',
            name: 'Create',
            method: 'POST',
            url: '/items',
            body: { mode: 'json', raw: '{"email":"a@test.dev"}' },
            fieldValidations: {
              body: {
                email: {
                  rules: ['required', 'email'],
                  minLength: 5,
                  pattern: '^.+@.+$',
                  enum: ['a@test.dev'],
                },
              },
            },
          },
        ],
      },
      { generatedAt: 'x' }
    );
    expect(html).toContain('Validation legend');
    expect(html).toContain('MIN LENGTH 5');
    expect(html).toContain('PATTERN');
    expect(html).toContain('ENUM 1');
  });

  it('applies collection and folder validation rules to nested requests', () => {
    const html = collectionToHtml(
      {
        name: 'Inherited',
        fieldValidations: {
          headers: { 'X-Key': { rules: ['required'], description: 'Tenant key' } },
        },
        items: [
          {
            type: 'folder',
            name: 'Folder',
            fieldValidations: {
              headers: { 'X-Key': { description: 'Folder key' } },
            },
            items: [
              {
                type: 'request',
                name: 'Get item',
                method: 'GET',
                url: '/items',
                headers: [{ key: 'X-Key', value: 'abc' }],
              },
            ],
          },
        ],
      },
      { generatedAt: 'x' }
    );
    expect(html).toContain('X-Key');
    expect(html).toContain('REQUIRED');
    expect(html).toContain('Folder key');
  });

  it('renders response field validation from saved examples', () => {
    const html = collectionToHtml(
      {
        name: 'Response docs',
        items: [
          {
            type: 'request',
            name: 'Get item',
            method: 'GET',
            url: '/items/1',
            examples: [
              {
                name: 'OK',
                response: {
                  status: 200,
                  contentType: 'application/json',
                  headers: [{ key: 'X-Trace', value: 'abc' }],
                  body: '{"id":1}',
                },
              },
            ],
            responseValidations: {
              body: { id: { rules: ['required', 'integer'], minimum: 1 } },
              headers: { 'X-Trace': { rules: ['string'] } },
            },
          },
        ],
      },
      { generatedAt: 'x' }
    );
    expect(html).toContain('Response fields');
    expect(html).toContain('Response body fields');
    expect(html).toContain('MIN VALUE 1');
    expect(html).toContain('X-Trace');
  });

  it('shows the auth type but never credentials', () => {
    const html = collectionToHtml(fixture(), { generatedAt: '2026-10-27T12:00:00.000Z' });
    expect(html).toContain('Auth: <code>bearer</code>');
    expect(html).toContain('Auth: <code>inherit</code>');
    expect(html).toContain('Auth: <code>apikey</code>');
    expect(html).not.toContain('auth-secret-token');
  });

  it('includes copyable cURL samples with redacted auth headers', () => {
    const html = collectionToHtml(fixture(), { generatedAt: '2026-10-27T12:00:00.000Z' });
    expect(html).toContain('<details class="curl-sample" open><summary>cURL</summary>');
    expect(html).toContain('curl --location --request GET');
    expect(html).toContain('class="copy-btn"');
    expect(html).toContain('Auth headers are redacted from this sample.');
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

describe('variable resolution, watermark and appendix', () => {
  it('resolves non-secret variables and leaves secrets redacted', () => {
    const html = collectionToHtml(fixture(), {
      generatedAt: '2026-10-27T12:00:00.000Z',
      environment: {
        name: 'Sandbox',
        variables: [{ key: 'id', value: '42', enabled: true, type: 'default' }],
      },
      globals: [{ key: 'region', value: 'ap-southeast', enabled: true, type: 'default' }],
      resolveVariables: true,
      author: 'Alice',
      preparedFor: 'Bob',
      watermark: true,
      includeCollectionSummary: true,
      includeCollectionJson: true,
    });

    expect(html).toContain('https://api.test/42/form');
    expect(html).toContain('Variables resolved from: Sandbox');
    expect(html).toContain('Prepared by Alice • For Bob');
    expect((html.match(/class="watermark watermark-/g) || []).length).toBe(6);
    expect(html).toContain('Collection appendix');
    expect(html).toContain('Collection summary');
    expect(html).toContain('Collection definition (JSON)');
    expect(html).toContain('&quot;key&quot;: &quot;baseUrl&quot;');
    expect(html).toContain('&quot;value&quot;: &quot;https://api.test&quot;');
    expect(html).toContain('&quot;value&quot;: &quot;••••&quot;');
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain('auth-secret-token');
  });

  it('can disable resolution and appendix output', () => {
    const html = collectionToHtml(fixture(), {
      generatedAt: '2026-10-27T12:00:00.000Z',
      resolveVariables: false,
      watermark: false,
      includeCollectionSummary: false,
      includeCollectionJson: false,
    });
    expect(html).toContain('https://api.test/{{id}}/form');
    expect(html).not.toContain('Collection appendix');
    expect(html).not.toContain('class="watermark"');
  });
});

describe('document templates and metadata', () => {
  it('renders template, theme, accent, author, recipient and disclaimer', () => {
    const html = collectionToHtml(fixture(), {
      generatedAt: '2026-10-27T12:00:00.000Z',
      template: 'professional',
      theme: 'dark',
      accent: '#ff0000',
      language: 'id',
      documentTitle: 'Custom <Docs>',
      author: 'Alice <Security>',
      preparedFor: 'Bob & Team',
      organization: 'Acme',
      version: '1.2',
      classification: 'Internal',
      disclaimer: 'No <liability> accepted.',
    });

    expect(html).toContain('<html lang="id" data-theme="dark" style="--accent: #ff0000">');
    expect(html).toContain('body class="docs-page template-professional"');
    expect(html).toContain('Disusun oleh');
    expect(html).toContain('Ditujukan untuk');
    expect(html).toContain('Penafian');
    expect(html).toContain('Custom &lt;Docs&gt;');
    expect(html).toContain('Alice &lt;Security&gt;');
    expect(html).toContain('Bob &amp; Team');
    expect(html).toContain('No &lt;liability&gt; accepted.');
    expect(html).not.toContain('Alice <Security>');
    expect(html).not.toContain('No <liability>');
  });

  it('supports minimal and system themes, and omits an empty disclaimer', () => {
    const html = collectionToHtml(fixture(), {
      generatedAt: '2026-10-27T12:00:00.000Z',
      template: 'minimal',
      theme: 'system',
      disclaimer: '',
    });
    expect(html).toContain('template-minimal');
    expect(html).toContain('data-theme="system"');
    expect(html).not.toContain('class="disclaimer"');
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
