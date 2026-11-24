// Convert key/value rows to and from the line-oriented bulk editor used by
// headers and form bodies. Lines use "Key: Value" for headers and
// "Key=Value" for forms; a leading "# " preserves a disabled row.
const FORMATS = {
  header: { separator: ':', label: 'Header', empty: 'Key: Value' },
  form: { separator: '=', label: 'Field', empty: 'Key=Value' },
};

function formatFor(format) {
  return FORMATS[format] || FORMATS.header;
}

export function bulkRowsToText(rows, { format = 'header' } = {}) {
  const { separator } = formatFor(format);
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && String(row.key || '').trim())
    .filter((row) => row.type !== 'file')
    .map((row) => {
      const prefix = row.enabled === false ? '# ' : '';
      return `${prefix}${String(row.key).trim()}${separator} ${row.value ?? ''}`;
    })
    .join('\n');
}

export function bulkTextToRows(text, { format = 'header', keepRows = [] } = {}) {
  const { separator } = formatFor(format);
  const rows = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    let enabled = true;
    let disabledPrefix = false;
    if (line.startsWith('# ')) {
      enabled = false;
      disabledPrefix = true;
      line = line.slice(2).trim();
    } else if (line.startsWith('#')) {
      continue;
    }
    if (!line) continue;
    const at = line.indexOf(separator);
    // "# comment" is a comment, not a disabled key-only row.
    if (disabledPrefix && at < 0) continue;
    const key = (at < 0 ? line : line.slice(0, at)).trim();
    if (!key) continue;
    const value = at < 0 ? '' : line.slice(at + 1).trim();
    rows.push(
      format === 'form'
        ? { key, value, enabled, type: 'text' }
        : { key, value, enabled }
    );
  }
  return [...rows, ...(Array.isArray(keepRows) ? keepRows : [])];
}

export function bulkEditHint(format = 'header') {
  return format === 'form'
    ? 'One field per line: key=value. Start a line with "# " to keep it disabled.'
    : 'One header per line: Key: Value. Start a line with "# " to keep it disabled.';
}
