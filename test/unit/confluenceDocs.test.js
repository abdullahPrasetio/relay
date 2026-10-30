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
            url: 'https://api.test/users?q=1&page=2',
            description: 'Returns "users" & <script>alert(1)</script>',
            params: [{ key: 'q', value: 'a&b', enabled: true }],
            headers: [{ key: 'X-Test', value: '<value> & "quoted"' }],
            body: { mode: 'json', raw: '{"a":1,"b":"<script>alert(1)</script>"}' },
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
});

describe('suggestConfluenceTitle', () => {
  it('prefers the explicit title and trims it', () => {
    expect(suggestConfluenceTitle({ name: 'API', confluenceTitle: '  API docs  ' })).toBe(
      'API docs'
    );
    expect(suggestConfluenceTitle({ name: 'API', confluenceTitle: '' })).toBe('API');
  });
});
