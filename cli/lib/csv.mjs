// Minimal RFC 4180-ish CSV parser for `--data` files.
//
// Handles quoted fields, escaped quotes (""), CRLF/CR/LF row endings, a UTF-8
// BOM, and a mandatory header row. Returns an array of row objects; blank rows
// are dropped so a trailing newline does not create a phantom iteration.

/**
 * Parse CSV text into rows of string cells.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvRows(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // CRLF: swallow the CR; a lone CR also ends the row.
      if (source[i + 1] === '\n') continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell !== ''));
}

/**
 * Parse CSV text into an array of row objects keyed by the header row.
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  const [header, ...body] = parseCsvRows(text);
  if (!header || header.length === 0) return [];
  const keys = header.map((h) => String(h).trim());
  return body.map((cells) => {
    const out = {};
    keys.forEach((key, index) => {
      if (key) out[key] = cells[index] ?? '';
    });
    return out;
  });
}
