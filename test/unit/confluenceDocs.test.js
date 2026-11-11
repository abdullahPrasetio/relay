import { describe, expect, it } from 'vitest';
import {
  collectionToConfluenceStorage,
  escapeXml,
  suggestConfluenceTitle,
} from '../../src/lib/confluenceDocs.js';

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
            url: 'https://api.test/users/:id?q=1&page=2',
            description: 'Returns "users" & <script>alert(1)</script>',
            params: [{ key: 'q', value: 'a&b', enabled: true }],
            headers: [{ key: 'X-Test', value: '<value> & "quoted"' }],
            body: {
              mode: 'json',
              raw: '{"a":1,"b":"<script>alert(1)</script>","user":{"email":"a@test.dev"}}',
            },
            fieldValidations: {
              path: {
                id: { rules: ['required', 'integer'], description: 'User id' },
              },
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
                response: {
                  status: 201,
                  statusText: 'Created',
                  contentType: 'application/json',
                  body: '{"ok":true}',
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('escapeXml', () => {
  it('escapes XML metacharacters and invalid control characters', () => {
    expect(escapeXml('<a & "b" \'c\'>')).toBe('&lt;a &amp; &quot;b&quot; &#39;c&#39;&gt;');
    expect(escapeXml('a\u0000b\u0007c')).toBe('abc');
  });
});

describe('collectionToConfluenceStorage', () => {
  it('renders headings, tables, code macros and examples', () => {
    const out = collectionToConfluenceStorage(fixture(), {
      workspaceName: 'Workspace & Co',
      generatedAt: '2026-10-27T12:00:00.000Z',
    });

    expect(out).toContain('<h1>Payments &amp; &lt;API&gt;</h1>');
    expect(out).toContain('Workspace &amp; Co');
    expect(out).toContain('<ac:structured-macro ac:name="toc">');
    expect(out).toContain('<h2>Users &amp; &lt;Folder&gt;</h2>');
    expect(out).toContain('<h3><span style="color:#2f7d32;">GET</span> List &lt;Users&gt;</h3>');
    expect(out).toContain('Query parameters');
    expect(out).toContain('<td>X-Test</td><td>&lt;value&gt; &amp; &quot;quoted&quot;</td>');
    expect(out).toContain('Saved examples');
    expect(out).toContain('First &lt;example&gt; — 201 Created');
    expect(out).toContain('<ac:parameter ac:name="language">json</ac:parameter>');
  });

  it('renders request and field descriptions with validation text', () => {
    const out = collectionToConfluenceStorage(fixture(), { generatedAt: '2026-10-27T12:00:00.000Z' });

    expect(out).toContain('<h3>Path variables</h3>');
    expect(out).toContain('<th>Validation</th>');
    expect(out).toContain('<th>Description</th>');
    expect(out).toContain('<td>REQUIRED INTEGER</td><td>User id</td>');
    expect(out).toContain('<td>REQUIRED STRING MIN 1 MAX 20</td>');
    expect(out).toContain('<td>Search &lt;term&gt;</td>');
    expect(out).toContain('<td>REQUIRED</td><td>Tenant key &amp; &lt;id&gt;</td>');
    expect(out).toContain('<h3>Body fields</h3>');
    expect(out).toContain('<td>user.email</td>');
    expect(out).toContain('<td>REQUIRED EMAIL</td><td>Primary email</td>');
  });

  it('never emits plaintext secrets or request auth credentials', () => {
    const out = collectionToConfluenceStorage(fixture());
    expect(out).toContain('(secret)');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('auth-secret-token');
    expect(out).toContain('Auth: bearer');
  });

  it('escapes user text outside code macros', () => {
    const out = collectionToConfluenceStorage(fixture());
    // Name/description are XML text; request bodies are code payloads (CDATA)
    // and keep their original markup on purpose.
    expect(out).toContain('Docs for &quot;payments&quot; &amp; &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('Returns &quot;users&quot; &amp; &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('splits a CDATA terminator inside a code macro', () => {
    const collection = {
      name: 'CDATA',
      items: [
        {
          type: 'request',
          name: 'Break',
          method: 'POST',
          url: '/x',
          body: { mode: 'raw', raw: 'before]]>after' },
        },
      ],
    };
    const out = collectionToConfluenceStorage(collection);
    expect(out).toContain(']]]]><![CDATA[>');
    expect(out).not.toContain('before]]>after');
  });

  it('omits examples when includeExamples is false', () => {
    const out = collectionToConfluenceStorage(fixture(), { includeExamples: false });
    expect(out).not.toContain('Saved examples');
    expect(out).not.toContain('First &lt;example&gt;');
    expect(out).toContain('List &lt;Users&gt;');
  });

  it('renders form and GraphQL bodies', () => {
    const collection = {
      name: 'Bodies',
      items: [
        {
          type: 'request',
          name: 'Form',
          method: 'POST',
          url: '/form',
          body: {
            mode: 'form-urlencoded',
            form: [{ key: 'a', value: '1', enabled: true }],
          },
        },
        {
          type: 'request',
          name: 'GQL',
          method: 'POST',
          url: '/graphql',
          body: {
            mode: 'graphql',
            graphql: { query: 'query { me }', variables: '{"a":1}' },
          },
        },
      ],
    };
    const out = collectionToConfluenceStorage(collection);
    expect(out).toContain('Body (form-urlencoded)');
    expect(out).toContain('<td>a</td><td>1</td><td>yes</td>');
    expect(out).toContain('GraphQL query');
    expect(out).toContain('GraphQL variables');
  });

  it('handles an empty collection', () => {
    const out = collectionToConfluenceStorage({ name: 'Empty', items: [] });
    expect(out).toContain('<h1>Empty</h1>');
    expect(out).toContain('0 requests · 0 folders');
    expect(out).toContain('Generated by Relay');
  });

  it('adds the attribution footer with support email and GitHub', () => {
    const out = collectionToConfluenceStorage(fixture());
    expect(out).toContain('mailto:temancode@gmail.com');
    expect(out).toContain('https://github.com/abdullahPrasetio');
    expect(out.trim().endsWith('</p>')).toBe(true);
  });

  it('renders the OpenAPI spec as a raw JSON code block', () => {
    const out = collectionToConfluenceStorage(fixture(), { contentMode: 'openapi' });
    expect(out).toContain('<h1>OpenAPI 3.0 Specification</h1>');
    expect(out).toContain('<ac:parameter ac:name="title">openapi.json</ac:parameter>');
    expect(out).toContain('"openapi": "3.0.3"');
    expect(out).not.toContain('<h1>Payments &amp; &lt;API&gt;</h1>');
  });

  it('embeds the spec in the swagger-open-api macro', () => {
    const out = collectionToConfluenceStorage(fixture(), { contentMode: 'swagger' });
    expect(out).toContain('<ac:structured-macro ac:name="swagger-open-api" ac:schema-version="1">');
    expect(out).toContain('"openapi": "3.0.3"');
    expect(out).toContain('Swagger UI - Payments &amp; &lt;API&gt;');
  });

  it('combines documentation and Swagger UI in the selected order', () => {
    const docFirst = collectionToConfluenceStorage(fixture(), {
      contentMode: 'both',
      contentOrder: 'doc_first',
    });
    expect(docFirst.indexOf('<h1>Payments &amp; &lt;API&gt;</h1>')).toBeLessThan(
      docFirst.indexOf('Swagger UI -')
    );

    const swaggerFirst = collectionToConfluenceStorage(fixture(), {
      contentMode: 'both',
      contentOrder: 'openapi_first',
    });
    expect(swaggerFirst.indexOf('Swagger UI -')).toBeLessThan(
      swaggerFirst.indexOf('<h1>Payments &amp; &lt;API&gt;</h1>')
    );
    expect(swaggerFirst).toContain('Section break');
  });

  it('uses the collection content options when no override is given', () => {
    const out = collectionToConfluenceStorage({
      ...fixture(),
      confluenceContentMode: 'openapi',
    });
    expect(out).toContain('<h1>OpenAPI 3.0 Specification</h1>');
  });
});

describe('suggestConfluenceTitle', () => {
  it('prefers the explicit title and trims it', () => {
    expect(suggestConfluenceTitle({ name: 'API', confluenceTitle: '  API docs  ' })).toBe(
      'API docs'
    );
    expect(suggestConfluenceTitle({ name: 'API', confluenceTitle: '' })).toBe('API');
  });
});
