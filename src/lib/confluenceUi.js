// Small, pure helpers shared by the Confluence settings/sync modals.

/** Accept a bare page ID or a Confluence page URL and return the ID. */
export function parsePageId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return text;
  try {
    const url = new URL(text);
    const fromQuery = url.searchParams.get('pageId');
    if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
    const match = /\/(?:pages|page)\/(\d+)/.exec(url.pathname);
    if (match) return match[1];
  } catch {
    /* not a URL: fall through to a path-like ID */
  }
  const match = /\/(?:pages|page)\/(\d+)/.exec(text);
  return match ? match[1] : '';
}

/** Page URL from a stored value, or a stable Confluence fallback. */
export function pageLink(config, pageId, storedUrl = '') {
  if (storedUrl) return storedUrl;
  const base = String(config?.baseUrl || '').replace(/\/+$/, '');
  if (!base || !pageId) return '';
  return `${base}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

export function validateSettingsDraft(draft) {
  const base = String(draft?.baseUrl || '').trim();
  if (!base) return 'Base URL is required.';
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Base URL must use http or https.';
    }
  } catch {
    return 'Base URL is not a valid URL.';
  }
  if (draft.authMethod === 'cloud' && !String(draft.email || '').trim()) {
    return 'Email is required for Cloud API tokens.';
  }
  if (!draft.hasToken && !String(draft.token || '').trim() && draft.clearToken !== true) {
    return 'API token or PAT is required.';
  }
  return '';
}

export function formatSyncTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}
