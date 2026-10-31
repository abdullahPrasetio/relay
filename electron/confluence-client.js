import { sendRequest } from '../packages/core/src/request-engine.js';
import { createSendContext } from '../packages/core/src/network-runtime.js';
import { DEFAULT_NETWORK_SETTINGS } from '../shared/networkSettings.js';

// Confluence REST client used only by the Electron main process.
//
// Security rules:
//   - the token never leaves this process;
//   - redirects are not followed (a 3xx usually means SSO/wrong base URL and
//     forwarding Authorization to another host would leak the token);
//   - TLS verification stays on unless the workspace explicitly opts out.

const TIMEOUT_MS = 15000;
const MAX_TITLE = 255;
const MAX_PAGE_ID = 100;

/**
 * Derive REST/web roots from the user's base URL.
 * Accepts both `https://org.atlassian.net`, `.../wiki`, and a full
 * `.../wiki/rest/api` URL.
 */
export function confluenceBase(raw) {
  const text = String(raw || '').trim().replace(/\/+$/, '');
  if (!text) return { ok: false, error: 'Base URL is required.' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'Base URL is not a valid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Base URL must use http or https.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Base URL must not contain credentials.' };
  }

  const path = url.pathname.replace(/\/+$/, '');
  const origin = url.origin;
  let apiPath;
  let webPath;

  if (/\/rest\/api$/.test(path)) {
    apiPath = path;
    webPath = path.slice(0, -'/rest/api'.length);
  } else if (/\/wiki$/.test(path)) {
    apiPath = `${path}/rest/api`;
    webPath = path;
  } else if (/(^|\.)atlassian\.net$/i.test(url.hostname)) {
    apiPath = `${path}/wiki/rest/api`;
    webPath = `${path}/wiki`;
  } else {
    apiPath = `${path}/rest/api`;
    webPath = path;
  }

  if (!webPath) webPath = '';
  return {
    ok: true,
    origin,
    baseUrl: `${origin}${path}`,
    apiBase: `${origin}${apiPath}`,
    webBase: `${origin}${webPath}`,
  };
}

/** Build the Authorization header for PAT (Bearer) or Cloud (Basic). */
export function authHeader({ authMethod, email } = {}, token) {
  if (!token) return { ok: false, error: 'Confluence token is missing.' };
  if (authMethod === 'pat') return { ok: true, value: `Bearer ${token}` };
  if (authMethod === 'cloud') {
    if (!email) return { ok: false, error: 'Email is required for Cloud API tokens.' };
    const basic = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
    return { ok: true, value: `Basic ${basic}` };
  }
  return { ok: false, error: 'Choose an authentication method.' };
}

function errorMessage(data, text, status) {
  const messages = [];
  if (data && typeof data === 'object') {
    if (Array.isArray(data.errorMessages)) messages.push(...data.errorMessages);
    if (typeof data.message === 'string') messages.push(data.message);
    if (typeof data.reason === 'string') messages.push(data.reason);
  }
  if (!messages.length && text) messages.push(String(text).slice(0, 300));
  return messages.filter(Boolean).join('; ') || `Confluence returned HTTP ${status}.`;
}

function statusCode(status) {
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return 'http_error';
}

function headerList(headers) {
  return Object.entries(headers).map(([key, value]) => ({ key, value: String(value) }));
}

async function requestJson({
  url,
  method = 'GET',
  headers = {},
  body,
  network,
  allowInsecureTls = false,
}) {
  const request = {
    method,
    url,
    params: [],
    headers: headerList({
      Accept: 'application/json',
      'User-Agent': 'Relay',
      ...headers,
    }),
    body:
      body === undefined
        ? { mode: 'none' }
        : { mode: 'raw', raw: JSON.stringify(body) },
    settings: {
      followRedirects: false,
      timeoutMs: TIMEOUT_MS,
      useCookieJar: false,
      ...(allowInsecureTls ? { verifyTls: false } : {}),
    },
  };
  const ctx = createSendContext({
    network: network || DEFAULT_NETWORK_SETTINGS,
    request,
  });
  try {
    const res = await sendRequest(request, { ...ctx.options, cookieJar: null });
    if (!res.ok) {
      return { ok: false, error: res.error || 'Network error', code: res.code };
    }
    const text = res.body == null ? '' : String(res.body);
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    // SSO/HTML responses can be 200 OK. Treat them as a configuration error,
    // never as a successful page payload.
    if (!data && /^\s*</.test(text)) {
      return {
        ok: false,
        status: res.status,
        code: 'html_response',
        error: 'Received HTML instead of JSON (possible SSO redirect). Check the base URL and credentials.',
      };
    }

    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        status: res.status,
        code: statusCode(res.status),
        error: errorMessage(data, text, res.status),
        data,
      };
    }

    return { ok: true, status: res.status, data, text };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: 'network_error' };
  } finally {
    ctx.cleanup();
  }
}

function validateId(value, label) {
  const text = String(value || '').trim();
  if (!text) return { ok: false, error: `${label} is required.` };
  if (text.length > MAX_PAGE_ID || /[/?#\s]/.test(text)) {
    return { ok: false, error: `${label} is invalid.` };
  }
  return { ok: true, value: text };
}

function validateTitle(value) {
  const text = String(value || '').trim();
  if (!text) return { ok: false, error: 'Page title is required.' };
  if (text.length > MAX_TITLE) {
    return { ok: false, error: `Page title must be at most ${MAX_TITLE} characters.` };
  }
  return { ok: true, value: text };
}

async function findTitle({
  base,
  auth,
  spaceKey,
  title,
  network,
  allowInsecureTls,
}) {
  if (!spaceKey) return { ok: false, error: 'Space key is required to check the page title.' };
  const query = new URLSearchParams({
    spaceKey,
    title,
    expand: 'version',
    limit: '1',
  });
  const res = await requestJson({
    url: `${base.apiBase}/content?${query}`,
    headers: { Authorization: auth },
    network,
    allowInsecureTls,
  });
  if (!res.ok) return res;
  const results = Array.isArray(res.data?.results) ? res.data.results : [];
  return { ok: true, match: results[0] || null };
}

function pageUrl(base, data, pageId) {
  const links = data?._links || {};
  if (typeof links.webui === 'string' && links.webui) {
    try {
      // `_links.webui` is often rooted at the site origin while `/wiki` lives
      // in `_links.base`; resolving a leading-slash path against the base
      // would silently drop the wiki prefix.
      if (/^https?:\/\//i.test(links.webui)) return links.webui;
      const root = String(links.base || base.webBase || base.origin).replace(/\/+$/, '');
      return new URL(`${root}/${links.webui.replace(/^\/+/, '')}`).toString();
    } catch {
      /* fall through */
    }
  }
  return `${base.webBase}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

/**
 * Test the stored connection. Returns the current user on success.
 */
export async function testConnection({ config, token, network } = {}) {
  const base = confluenceBase(config?.baseUrl);
  if (!base.ok) return base;
  const auth = authHeader(config, token);
  if (!auth.ok) return auth;
  const res = await requestJson({
    url: `${base.apiBase}/user/current`,
    headers: { Authorization: auth.value },
    network,
    allowInsecureTls: config?.allowInsecureTls === true,
  });
  if (!res.ok) return res;
  const user = res.data || {};
  return {
    ok: true,
    displayName: user.displayName || user.publicName || user.username || '',
    email: user.email || '',
  };
}

/**
 * Create or update a page.
 *
 * `force` re-reads the version after a 409 and retries once; the UI only sets
 * it after the user explicitly confirms overwriting a concurrent edit.
 */
export async function publishPage({
  config,
  token,
  pageId = '',
  title,
  content,
  spaceKey = '',
  parentPageId = '',
  force = false,
  network,
} = {}) {
  const base = confluenceBase(config?.baseUrl);
  if (!base.ok) return base;
  const auth = authHeader(config, token);
  if (!auth.ok) return auth;
  const safeTitle = validateTitle(title);
  if (!safeTitle.ok) return safeTitle;
  if (typeof content !== 'string') return { ok: false, error: 'Page content is missing.' };

  const headers = {
    Authorization: auth.value,
    'Content-Type': 'application/json',
    'X-Atlassian-Token': 'no-check',
  };
  const options = { network, allowInsecureTls: config?.allowInsecureTls === true };

  if (pageId) {
    const id = validateId(pageId, 'Page ID');
    if (!id.ok) return id;

    const current = await requestJson({
      url: `${base.apiBase}/content/${encodeURIComponent(id.value)}?expand=version,space`,
      headers,
      ...options,
    });
    if (!current.ok) {
      return current.code === 'not_found'
        ? { ...current, code: 'page_not_found', error: 'Confluence page not found. Check the page ID.' }
        : current;
    }

    const page = current.data || {};
    const currentSpace = page.space?.key || spaceKey;
    if (spaceKey && page.space?.key && page.space.key !== spaceKey) {
      return {
        ok: false,
        code: 'space_mismatch',
        status: current.status,
        error: `Page belongs to space ${page.space.key}, not ${spaceKey}.`,
      };
    }

    if (page.title !== safeTitle.value) {
      const found = await findTitle({
        base,
        auth: auth.value,
        spaceKey: currentSpace,
        title: safeTitle.value,
        ...options,
      });
      if (!found.ok) return found;
      if (found.match && String(found.match.id) !== String(id.value)) {
        return {
          ok: false,
          code: 'title_conflict',
          status: 409,
          error: `A page titled “${safeTitle.value}” already exists in this space.`,
          existingId: String(found.match.id),
          existingUrl: pageUrl(base, found.match, found.match.id),
        };
      }
    }

    const put = async (version) =>
      requestJson({
        url: `${base.apiBase}/content/${encodeURIComponent(id.value)}`,
        method: 'PUT',
        headers,
        body: {
          id: id.value,
          type: 'page',
          title: safeTitle.value,
          body: { storage: { value: content, representation: 'storage' } },
          version: { number: version },
        },
        ...options,
      });

    let res = await put(Number(page.version?.number || 0) + 1);
    if (!res.ok && res.code === 'conflict' && force) {
      const fresh = await requestJson({
        url: `${base.apiBase}/content/${encodeURIComponent(id.value)}?expand=version,space`,
        headers,
        ...options,
      });
      if (!fresh.ok) return fresh;
      res = await put(Number(fresh.data?.version?.number || 0) + 1);
    }
    if (!res.ok) {
      if (res.code === 'conflict') {
        return {
          ...res,
          error: 'This page changed since it was loaded. Review the conflict before overwriting.',
          currentVersion: Number(page.version?.number || 0),
        };
      }
      return res;
    }
    return {
      ok: true,
      pageId: id.value,
      version: Number(res.data?.version?.number || Number(page.version?.number || 0) + 1),
      url: pageUrl(base, res.data, id.value),
      created: false,
      title: safeTitle.value,
      spaceKey: currentSpace,
      parentPageId,
    };
  }

  // Create path: a space is mandatory, and a parent is required by policy so a
  // page can never land directly under the space root by accident.
  if (!spaceKey) return { ok: false, code: 'space_required', error: 'Space key is required to create a page.' };
  const parent = validateId(parentPageId, 'Parent page ID');
  if (!parent.ok) {
    return { ...parent, code: 'parent_required', error: 'Choose a parent page before creating a page.' };
  }

  const parentPage = await requestJson({
    url: `${base.apiBase}/content/${encodeURIComponent(parent.value)}?expand=space,version`,
    headers,
    ...options,
  });
  if (!parentPage.ok) {
    return {
      ...parentPage,
      code: 'parent_invalid',
      error: parentPage.code === 'not_found'
        ? 'Parent page not found.'
        : `Parent page could not be loaded: ${parentPage.error}`,
    };
  }
  const parentSpace = parentPage.data?.space?.key || '';
  if (parentPage.data?.type !== 'page') {
    return { ok: false, code: 'parent_invalid', error: 'Parent must be a page.' };
  }
  if (parentSpace && parentSpace !== spaceKey) {
    return {
      ok: false,
      code: 'parent_invalid',
      error: `Parent page belongs to space ${parentSpace}, not ${spaceKey}.`,
    };
  }

  const found = await findTitle({
    base,
    auth: auth.value,
    spaceKey,
    title: safeTitle.value,
    ...options,
  });
  if (!found.ok) return found;
  if (found.match) {
    return {
      ok: false,
      code: 'title_conflict',
      status: 409,
      error: `A page titled “${safeTitle.value}” already exists in this space.`,
      existingId: String(found.match.id),
      existingUrl: pageUrl(base, found.match, found.match.id),
    };
  }

  const res = await requestJson({
    url: `${base.apiBase}/content`,
    method: 'POST',
    headers,
    body: {
      type: 'page',
      title: safeTitle.value,
      space: { key: spaceKey },
      ancestors: [{ id: parent.value }],
      body: { storage: { value: content, representation: 'storage' } },
    },
    ...options,
  });
  if (!res.ok) return res;
  const newId = res.data?.id != null ? String(res.data.id) : '';
  if (!newId) return { ok: false, code: 'bad_response', error: 'Confluence did not return a page ID.' };
  return {
    ok: true,
    pageId: newId,
    version: Number(res.data?.version?.number || 1),
    url: pageUrl(base, res.data, newId),
    created: true,
    title: safeTitle.value,
    spaceKey,
    parentPageId: parent.value,
  };
}
