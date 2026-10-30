import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

// Proxy selection rules (request engine side).
//
// Precedence for a single request:
//   1. request.settings.proxyId === 'none'  -> never use a proxy
//   2. request.settings.proxyId === <id>    -> that profile, whatever the app mode
//   3. app mode 'manual'                    -> the active profile
//   4. app mode 'environment'               -> HTTP(S)_PROXY / NO_PROXY
//   5. app mode 'none'                      -> direct
//
// A missing profile, or one without a host, means "direct", never an error:
// deleting a proxy must not break saved requests. Proxy URLs are never logged
// (they can embed credentials).

/** Split a NO_PROXY-style value into normalized entries. */
export function splitBypass(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Does `hostname` match any bypass pattern? Supports `*`, `.suffix`, `*.suffix`. */
export function shouldBypass(hostname, bypass = []) {
  const host = String(hostname || '').toLowerCase();
  return bypass.some((raw) => {
    const p = String(raw).trim().toLowerCase();
    if (!p) return false;
    if (p === '*') return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    if (p.startsWith('.')) return host === p.slice(1) || host.endsWith(p);
    return host === p;
  });
}

/** Build a proxy URL (with credentials) from a stored profile. */
export function buildProxyUrl(profile) {
  if (!profile?.host) return '';
  const auth = profile.username
    ? `${encodeURIComponent(profile.username)}:${encodeURIComponent(profile.password || '')}@`
    : '';
  return `${profile.protocol}://${auth}${profile.host}:${profile.port}`;
}

/**
 * Resolve which proxy (if any) applies to `targetUrl`.
 * Returns `{ url, bypass }` or null.
 */
export function resolveProxy({ targetUrl, network, requestSettings }) {
  const proxyId = requestSettings?.proxyId;
  if (proxyId === 'none') return null;

  let profile = null;
  if (proxyId) {
    profile = network.proxies.find((p) => p.id === proxyId) || null;
  } else if (network.proxyMode === 'manual') {
    profile = network.proxies.find((p) => p.id === network.activeProxyId) || null;
  } else if (network.proxyMode === 'environment') {
    const isHttps = String(targetUrl || '').startsWith('https:');
    const raw = isHttps
      ? process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;
    if (!raw) return null;
    // Env proxy values are often scheme-less ("proxy.corp:8080").
    const url = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    return { url, bypass: splitBypass(process.env.NO_PROXY || process.env.no_proxy) };
  }

  if (!profile?.host) return null;
  return { url: buildProxyUrl(profile), bypass: profile.bypass || [] };
}

/** Create the right agent for a proxy + target pair. */
export function createProxyAgent(targetUrl, proxy) {
  const target = new URL(targetUrl);
  if (proxy.url.startsWith('socks')) return new SocksProxyAgent(proxy.url);
  return target.protocol === 'https:'
    ? new HttpsProxyAgent(proxy.url)
    : new HttpProxyAgent(proxy.url);
}
