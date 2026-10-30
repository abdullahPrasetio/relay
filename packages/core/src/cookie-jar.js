// A minimal cookie jar: stores cookies from Set-Cookie and returns the ones
// that match a given URL (by domain + path) for the next request's Cookie
// header. Not a full RFC 6265 implementation, but covers the common cases
// (session cookies, domain/path scoping, Secure, expiry).

// Parse one Set-Cookie header line into a structured cookie.
export function parseSetCookie(line, requestUrl) {
  const segments = line.split(';').map((s) => s.trim());
  const [nameValue, ...attrs] = segments;
  const eq = nameValue.indexOf('=');
  if (eq < 0) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1);

  const cookie = {
    name,
    value,
    domain: '',
    path: '/',
    expires: null, // epoch ms, null = session
    secure: false,
    httpOnly: false,
  };

  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i >= 0 ? a.slice(0, i) : a).toLowerCase();
    const v = i >= 0 ? a.slice(i + 1) : '';
    if (k === 'domain') cookie.domain = v.replace(/^\./, '').toLowerCase();
    else if (k === 'path') cookie.path = v || '/';
    else if (k === 'expires') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) cookie.expires = t;
    } else if (k === 'max-age') {
      const secs = parseInt(v, 10);
      if (!Number.isNaN(secs)) cookie.expires = Date.now() + secs * 1000;
    } else if (k === 'secure') cookie.secure = true;
    else if (k === 'httponly') cookie.httpOnly = true;
  }

  // Default domain = request host.
  if (!cookie.domain && requestUrl) {
    try {
      cookie.domain = new URL(requestUrl).hostname.toLowerCase();
    } catch {
      /* ignore */
    }
  }
  return cookie;
}

// Insert/replace cookies from a response's Set-Cookie list into the jar.
// `jar` is an array of cookie objects (the persisted store). Returns a new jar.
export function storeCookies(jar, setCookieList, requestUrl) {
  const list = Array.isArray(setCookieList) ? setCookieList : setCookieList ? [setCookieList] : [];
  let next = [...(jar || [])];
  for (const line of list) {
    const c = parseSetCookie(line, requestUrl);
    if (!c) continue;
    // Replace a cookie with the same name+domain+path.
    next = next.filter(
      (x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path)
    );
    // A cookie with an expiry in the past deletes it (don't re-add).
    if (c.expires != null && c.expires <= Date.now()) continue;
    next.push(c);
  }
  return next;
}

function domainMatches(cookieDomain, host) {
  if (!cookieDomain) return false;
  if (cookieDomain === host) return true;
  // host is a subdomain of cookieDomain
  return host.endsWith('.' + cookieDomain);
}

function pathMatches(cookiePath, reqPath) {
  if (!cookiePath || cookiePath === '/') return true;
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/');
}

// Build the Cookie header value for a request URL from the jar.
export function cookieHeaderFor(jar, requestUrl) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  const reqPath = url.pathname || '/';
  const isHttps = url.protocol === 'https:';
  const now = Date.now();

  const matched = (jar || []).filter((c) => {
    if (c.expires != null && c.expires <= now) return false;
    if (c.secure && !isHttps) return false;
    return domainMatches(c.domain, host) && pathMatches(c.path, reqPath);
  });
  return matched.map((c) => `${c.name}=${c.value}`).join('; ');
}

// Drop expired cookies (housekeeping).
export function pruneExpired(jar) {
  const now = Date.now();
  return (jar || []).filter((c) => c.expires == null || c.expires > now);
}

// Coerce a user-supplied expiry into epoch ms. Accepts epoch ms numbers,
// numeric strings, and anything Date.parse understands (e.g. ISO-8601).
// Blank or unparseable values mean a session cookie (`null`).
export function coerceExpiry(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n > 0 ? n : null;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
}

// Validate + normalize one manually entered cookie for the jar.
export function normalizeCookie(input) {
  const name = String(input?.name ?? '').trim();
  if (!name) throw new Error('Cookie name is required');
  return {
    name,
    value: String(input?.value ?? ''),
    domain: normalizeDomain(input?.domain),
    path: String(input?.path || '/').trim() || '/',
    expires: coerceExpiry(input?.expires),
    secure: Boolean(input?.secure),
    httpOnly: Boolean(input?.httpOnly),
  };
}

// Insert or replace a manually edited cookie. Identity is name+domain+path,
// matching how response cookies are replaced. Returns a new jar.
export function upsertCookie(jar, cookie) {
  const next = normalizeCookie(cookie);
  const out = [...(jar || [])];
  const idx = out.findIndex(
    (c) => c.name === next.name && c.domain === next.domain && c.path === next.path
  );
  if (idx >= 0) out[idx] = next;
  else out.push(next);
  return out;
}

// Remove the cookie identified by name+domain+path. Returns a new jar.
export function deleteCookie(jar, { name, domain, path } = {}) {
  const target = {
    name: String(name ?? '').trim(),
    domain: normalizeDomain(domain),
    path: String(path || '/').trim() || '/',
  };
  return (jar || []).filter(
    (c) => !(c.name === target.name && c.domain === target.domain && c.path === target.path)
  );
}
