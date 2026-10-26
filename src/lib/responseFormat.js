// Pure helpers for the response viewer. Kept free of React/DOM so they can be
// unit tested in the node vitest environment.

/** Escape text for safe insertion into HTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Offsets of every non-overlapping, case-insensitive match of `query`. */
export function findMatches(text, query) {
  const src = String(text ?? '');
  const needle = String(query ?? '');
  if (!needle) return [];
  const hay = src.toLowerCase();
  const lower = needle.toLowerCase();
  const out = [];
  let from = 0;
  while (from <= hay.length) {
    const at = hay.indexOf(lower, from);
    if (at === -1) break;
    out.push(at);
    from = at + lower.length;
  }
  return out;
}

/**
 * Split `text` into plain/match segments for the Raw view. The caller escapes
 * each segment, so response bytes are never interpreted as markup.
 */
export function highlightSegments(text, query, currentIndex = 0) {
  const src = String(text ?? '');
  const needle = String(query ?? '');
  const matches = findMatches(src, needle);
  if (matches.length === 0) return [{ text: src, match: false, current: false }];
  const safeIndex = ((currentIndex % matches.length) + matches.length) % matches.length;
  const segments = [];
  let cursor = 0;
  matches.forEach((at, i) => {
    if (at > cursor) segments.push({ text: src.slice(cursor, at), match: false, current: false });
    segments.push({
      text: src.slice(at, at + needle.length),
      match: true,
      current: i === safeIndex,
    });
    cursor = at + needle.length;
  });
  if (cursor < src.length) segments.push({ text: src.slice(cursor), match: false, current: false });
  return segments;
}

/** Parse a JSON body without throwing. */
export function parseJsonBody(body) {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false, value: null };
  }
}

/** Map a response Content-Type/body to a Monaco language id. */
export function detectLanguage(contentType, body) {
  const ct = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (ct.includes('json') || ct.endsWith('+json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml') || ct.endsWith('+xml')) return 'xml';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript';
  const text = String(body ?? '').trimStart();
  if (/^[[{]/.test(text) && parseJsonBody(body).ok) return 'json';
  if (/^(<\?xml|<!--|<[a-zA-Z])/.test(text)) return 'xml';
  return 'plaintext';
}

/**
 * Simple XML indenter for the Pretty view. It is deliberately conservative:
 * it only re-indents between tags and never validates the document.
 */
export function formatXml(xml) {
  const src = String(xml ?? '').trim();
  if (!src) return '';
  const tokens = src
    .replace(/>\s+</g, '><')
    .split(/(<[^>]+>)/g)
    .map((t) => t.trim())
    .filter((t) => t !== '');
  const lines = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      lines.push('  '.repeat(depth) + token);
    } else if (token.startsWith('<')) {
      lines.push('  '.repeat(depth) + token);
      const selfClosing = /\/>$/.test(token);
      const declaration = /^<[!?]/.test(token);
      const opening = /^<[^/!?][^>]*>$/.test(token);
      if (opening && !selfClosing && !declaration) depth += 1;
    } else {
      lines.push('  '.repeat(depth) + token);
    }
  }
  return lines.join('\n');
}

/** Pretty-printed body for the Monaco pretty view. */
export function prettyText(contentType, body) {
  const text = String(body ?? '');
  const language = detectLanguage(contentType, text);
  if (language === 'json') {
    const parsed = parseJsonBody(text);
    if (parsed.ok) return JSON.stringify(parsed.value, null, 2);
  }
  if (language === 'xml') return formatXml(text);
  return text;
}

/**
 * Does a JSON subtree contain a key or path matching `query`? Used by the tree
 * filter to hide branches that do not match.
 */
export function jsonSubtreeMatches(key, value, query, path = '') {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const currentPath = path ? `${path}.${key}` : String(key);
  if (String(key).toLowerCase().includes(q) || currentPath.toLowerCase().includes(q)) return true;
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => jsonSubtreeMatches(k, v, q, currentPath));
  }
  return false;
}
