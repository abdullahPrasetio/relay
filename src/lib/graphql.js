// Pure GraphQL helpers: introspection request/response handling and schema
// driven completion candidates. Nothing in here touches Electron, Monaco, or
// the DOM, so it is safe to unit test directly.

// Minimal introspection query. It fetches the operation root types, every
// named type's fields/args, and enough TypeRef nesting to unwrap NON_NULL and
// LIST wrappers back to a named type (used for nested-field completion).
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      fields {
        name
        args { name }
        type { ...TypeRef }
      }
    }
  }
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType { kind name }
    }
  }
}`;

const OPERATIONS = ['query', 'mutation', 'subscription'];
const DEFAULT_ROOT_NAMES = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' };

function emptyResult() {
  return {
    types: [],
    fieldNames: [],
    rootFields: { query: [], mutation: [], subscription: [] },
    rootTypes: { query: null, mutation: null, subscription: null },
  };
}

function defaultRootName(operation) {
  return DEFAULT_ROOT_NAMES[operation] || 'Query';
}

// Unwrap NON_NULL/LIST wrappers to the underlying named type.
function unwrapTypeName(type) {
  if (typeof type === 'string') return type;
  let current = type;
  let guard = 0;
  while (current && !current.name && current.ofType && guard < 20) {
    current = current.ofType;
    guard += 1;
  }
  return current?.name || '';
}

// Normalize headers (array of {key,value,enabled} or a plain object) into the
// key/value shape the request engine expects, dropping disabled/empty rows.
function normalizeHeaders(headers) {
  const rows = [];
  if (Array.isArray(headers)) {
    for (const row of headers) {
      if (!row) continue;
      if (row.enabled === false) continue;
      if (typeof row === 'string') {
        if (row.trim()) rows.push({ key: row, value: '', enabled: true });
        continue;
      }
      const key = row.key ?? row.name;
      if (!key) continue;
      rows.push({ key: String(key), value: row.value ?? '', enabled: true });
    }
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key) rows.push({ key, value: value ?? '', enabled: true });
    }
  }
  return rows;
}

// Build the request the engine sends to fetch a schema. The user's explicit
// Content-Type wins; otherwise application/json is applied.
export function buildIntrospectionRequest({ url = '', headers } = {}) {
  const rows = normalizeHeaders(headers);
  const hasContentType = rows.some(
    (header) => String(header.key).toLowerCase() === 'content-type'
  );
  if (!hasContentType) {
    rows.push({ key: 'Content-Type', value: 'application/json', enabled: true });
  }
  return {
    method: 'POST',
    url: String(url ?? ''),
    headers: rows,
    body: {
      mode: 'json',
      raw: JSON.stringify({ query: INTROSPECTION_QUERY }),
    },
  };
}

// Turn an introspection response (object or JSON string) into the compact
// schema shape used by the UI. Missing/partial data is tolerated: a response
// without __schema returns { error } while `errors` from GraphQL executions are
// surfaced even when some data is present.
export function parseIntrospection(json) {
  const empty = emptyResult();
  let payload = json;

  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (err) {
      return { ...empty, error: `Invalid introspection JSON: ${err.message}` };
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ...empty, error: 'Introspection response is not an object' };
  }

  const errorMessages = Array.isArray(payload.errors)
    ? payload.errors
        .map((entry) => (entry && typeof entry === 'object' ? entry.message : entry))
        .filter((message) => typeof message === 'string' && message)
        .map(String)
    : [];

  const schema =
    payload.__schema && typeof payload.__schema === 'object'
      ? payload.__schema
      : payload.data && typeof payload.data === 'object'
        ? payload.data.__schema
        : null;

  if (!schema || typeof schema !== 'object') {
    return {
      ...empty,
      error: errorMessages[0] || 'Response does not contain a GraphQL schema',
      ...(errorMessages.length ? { errors: errorMessages } : {}),
    };
  }

  const types = [];
  const typeMap = new Map();
  for (const raw of Array.isArray(schema.types) ? schema.types : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name) continue;
    // Introspection machinery (__Type, __Schema, ...) is never useful for
    // query completion.
    if (raw.name.startsWith('__')) continue;

    const fields = Array.isArray(raw.fields)
      ? raw.fields
          .filter((field) => field && typeof field.name === 'string' && field.name)
          .map((field) => ({
            name: field.name,
            args: Array.isArray(field.args)
              ? field.args.map((arg) => arg && arg.name).filter(Boolean)
              : [],
            type: unwrapTypeName(field.type),
          }))
      : [];

    const type = {
      name: raw.name,
      kind: typeof raw.kind === 'string' ? raw.kind : 'OBJECT',
      fields,
    };
    types.push(type);
    typeMap.set(type.name, type);
  }

  const rootTypes = {
    query: schema.queryType?.name || null,
    mutation: schema.mutationType?.name || null,
    subscription: schema.subscriptionType?.name || null,
  };
  // Partial schemas sometimes omit queryType even though the conventional root
  // type is present; fall back to it when possible.
  for (const operation of OPERATIONS) {
    if (!rootTypes[operation]) {
      const guess = defaultRootName(operation);
      if (typeMap.has(guess)) rootTypes[operation] = guess;
    }
  }

  const rootFields = {};
  for (const operation of OPERATIONS) {
    const rootType = rootTypes[operation] ? typeMap.get(rootTypes[operation]) : null;
    rootFields[operation] = rootType ? rootType.fields.map((field) => field.name) : [];
  }

  const fieldNames = [
    ...new Set(types.flatMap((type) => type.fields.map((field) => field.name))),
  ].sort();

  const result = { types, fieldNames, rootFields, rootTypes };
  if (errorMessages.length) result.errors = errorMessages;
  return result;
}

// Strip comments and string literals so braces inside them do not confuse the
// context scanner.
function stripStringsAndComments(source) {
  const text = String(source ?? '');
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '"') {
      if (text.startsWith('"""', index)) {
        index += 3;
        while (index < text.length && !text.startsWith('"""', index)) index += 1;
        index = Math.min(index + 3, text.length);
      } else {
        index += 1;
        while (index < text.length && text[index] !== '"') {
          if (text[index] === '\\') index += 1;
          index += 1;
        }
        index += 1;
      }
      out += ' ';
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function tokenize(source) {
  const clean = stripStringsAndComments(source);
  const tokens = [];
  const re = /\.\.\.|[A-Za-z_][A-Za-z0-9_]*|[{}()[\]]/g;
  let match;
  while ((match = re.exec(clean)) !== null) {
    const value = match[0];
    if (value === '{' || value === '}' || value === '(' || value === ')' || value === '[' || value === ']') {
      tokens.push({ type: value });
    } else if (value === '...') {
      tokens.push({ type: '...' });
    } else {
      tokens.push({ type: 'ident', value });
    }
  }
  return tokens;
}

// Walk the text before the cursor and work out which selection set it is in.
// Returns the enclosing type (when resolvable), the root operation for that
// selection set, and whether the cursor is in a type position (`... on |`).
function detectContext(text, schema, typeMap) {
  const stack = [];
  let parenDepth = 0;
  let lastIdent = null;
  let operation = null;
  let onType = null;
  let expectingOn = false;

  const rootTypeName = (op) => {
    if (schema.rootTypes?.[op]) return schema.rootTypes[op];
    const guess = defaultRootName(op);
    return typeMap.has(guess) ? guess : null;
  };

  for (const token of tokenize(text)) {
    if (token.type === 'ident') {
      const name = token.value;
      if (expectingOn) {
        onType = name;
        expectingOn = false;
      } else if (name === 'on') {
        expectingOn = true;
      } else if (parenDepth === 0 && stack.length === 0 && OPERATIONS.includes(name)) {
        operation = name;
      }
      if (parenDepth === 0) lastIdent = name;
      continue;
    }
    if (token.type === '(') {
      parenDepth += 1;
      continue;
    }
    if (token.type === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (token.type === '{' && parenDepth === 0) {
      let typeName = null;
      let rootOperation = null;
      if (onType) {
        typeName = onType;
      } else if (operation) {
        rootOperation = operation;
        typeName = rootTypeName(operation);
      } else if (stack.length === 0) {
        // GraphQL's anonymous shorthand `{ field }` is always a query.
        rootOperation = 'query';
        typeName = rootTypeName('query');
      } else if (lastIdent) {
        const parentName = stack[stack.length - 1]?.typeName;
        const parent = parentName ? typeMap.get(parentName) : null;
        const field = parent?.fields?.find((entry) => entry.name === lastIdent);
        typeName = field?.type || null;
      }
      stack.push({ typeName, rootOperation });
      lastIdent = null;
      operation = null;
      onType = null;
      expectingOn = false;
      continue;
    }
    if (token.type === '}' && parenDepth === 0) {
      stack.pop();
      lastIdent = null;
      operation = null;
      onType = null;
      expectingOn = false;
    }
  }

  if (expectingOn) {
    return { insideBraces: true, typeName: null, rootOperation: null, expectingType: true };
  }
  const frame = stack.length ? stack[stack.length - 1] : null;
  return {
    insideBraces: stack.length > 0,
    typeName: frame?.typeName || null,
    rootOperation: frame?.rootOperation || null,
    expectingType: false,
  };
}

function trailingWord(text) {
  const match = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(text ?? ''));
  return match ? match[1] : '';
}

// Produce completion candidates for the cursor described by `linePrefix` (the
// full text before the cursor) and `word` (Monaco's current word).
export function graphqlCompletions({ schema, word = '', linePrefix = '' } = {}) {
  if (!schema || !Array.isArray(schema.types) || schema.types.length === 0) return [];

  const typeMap = new Map();
  for (const type of schema.types) {
    if (type?.name) typeMap.set(type.name, type);
  }

  const context = detectContext(linePrefix, schema, typeMap);
  const prefix = String(word || trailingWord(linePrefix)).toLowerCase();
  const matches = (label) => !prefix || String(label).toLowerCase().startsWith(prefix);

  const seen = new Set();
  const items = [];
  const add = (label, detail, insertText = label) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    items.push({ label, insertText, detail: detail || '' });
  };

  // Type position: `fragment F on |` or `... on |`.
  if (context.expectingType) {
    for (const type of schema.types) {
      if (type?.name && matches(type.name)) add(type.name, type.kind || 'type');
    }
    return items;
  }

  if (context.insideBraces) {
    let fields = null;
    const enclosing = context.typeName ? typeMap.get(context.typeName) : null;
    if (enclosing) {
      fields = enclosing.fields || [];
    } else if (context.rootOperation) {
      const names = schema.rootFields?.[context.rootOperation] || [];
      fields = names.map((name) => ({ name, args: [], type: '' }));
    }
    for (const field of fields || []) {
      if (!field?.name || !matches(field.name)) continue;
      const args = field.args?.length ? `(${field.args.join(', ')})` : '';
      add(field.name, `${field.type || 'field'}${args}`);
    }
    return items;
  }

  // Top level: operation keywords plus every schema type name.
  const roots = schema.rootFields || {};
  for (const operation of OPERATIONS) {
    const rootFieldNames = roots[operation];
    const hasRoot = Array.isArray(rootFieldNames) ? rootFieldNames.length > 0 : !!rootFieldNames;
    if (hasRoot && matches(operation)) add(operation, 'operation');
  }
  for (const type of schema.types) {
    if (type?.name && matches(type.name)) add(type.name, type.kind || 'type');
  }
  return items;
}
