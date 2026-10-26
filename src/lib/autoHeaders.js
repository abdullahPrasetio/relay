// Computes the headers the engine adds automatically, so the Headers tab can
// show them (read-only) the way Postman shows auto-generated headers.
// These mirror what request-engine.js / the transport actually send.

export function computeAutoHeaders(request) {
  const out = [];
  const explicit = new Set(
    (request.headers || [])
      .filter((h) => h.enabled !== false && h.key)
      .map((h) => h.key.toLowerCase())
  );
  const add = (key, value) => {
    if (!explicit.has(key.toLowerCase())) out.push({ key, value, auto: true });
  };

  // Host (from URL)
  try {
    let u = (request.url || '').trim();
    if (u) {
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      const url = new URL(u);
      add('Host', url.host);
    }
  } catch {
    /* ignore unparseable URL */
  }

  // Content-Type for body modes
  const mode = request.body?.mode;
  if (mode === 'json') add('Content-Type', 'application/json');
  else if (mode === 'form-urlencoded') add('Content-Type', 'application/x-www-form-urlencoded');
  else if (mode === 'form-data') add('Content-Type', 'multipart/form-data');

  // Standard headers the HTTP client adds
  add('User-Agent', 'RestTamer/1.0');
  add('Accept', '*/*');
  add('Accept-Encoding', 'gzip, deflate, br');
  add('Connection', 'keep-alive');

  return out;
}
