// Parse a data file (CSV or JSON) into an array of row objects for the
// data-driven Collection Runner, mirroring Postman's iteration data.

export function parseDataFile(text, filename = '') {
  const name = (filename || '').toLowerCase();
  const trimmed = (text || '').trim();
  if (!trimmed) return [];

  // JSON: expect an array of objects (Postman's data file format).
  if (name.endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((r) => r && typeof r === 'object');
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  }

  // Otherwise treat as CSV.
  return parseCsv(trimmed);
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
// embedded quotes ("" -> "), and CRLF/LF line endings. First row is headers.
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // handle CRLF: skip the \n after \r
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      field = '';
      rows.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  // flush last field/record if any content
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    rows.push(record);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    // skip fully-empty trailing rows
    if (cells.length === 1 && cells[0] === '') continue;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cells[idx] !== undefined ? cells[idx] : '';
    });
    out.push(obj);
  }
  return out;
}
