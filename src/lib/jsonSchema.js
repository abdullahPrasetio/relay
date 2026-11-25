// Minimal JSON Schema generator used by the raw-body Schema panel. It favors a
// readable draft-07 object over clever inference: every object key is required,
// arrays merge their item types, and mixed arrays fall back to an empty schema.
function schemaFor(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array', items: {} };
    return { type: 'array', items: mergeSchemas(value.map(schemaFor)) };
  }
  const type = typeof value;
  if (type === 'object') {
    const properties = Object.create(null);
    for (const [key, child] of Object.entries(value)) properties[key] = schemaFor(child);
    return {
      type: 'object',
      properties,
      required: Object.keys(value),
    };
  }
  if (type === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'number' };
  }
  if (type === 'boolean') return { type: 'boolean' };
  if (type === 'string') return { type: 'string' };
  return {};
}

function mergeSchemas(schemas) {
  const list = schemas.filter(Boolean);
  if (list.length === 0) return {};
  const types = [...new Set(list.map((schema) => schema.type).filter(Boolean))];
  if (types.length !== 1) return {};
  const type = types[0];
  if (type === 'object') {
    const properties = Object.create(null);
    const required = new Set();
    for (const schema of list) {
      for (const [key, value] of Object.entries(schema.properties || {})) {
        properties[key] = properties[key] ? mergeSchemas([properties[key], value]) : value;
      }
      for (const key of schema.required || []) required.add(key);
    }
    return { type, properties, required: [...required] };
  }
  if (type === 'array') {
    return { type, items: mergeSchemas(list.map((schema) => schema.items || {})) };
  }
  return { type };
}

export function generateJsonSchema(value) {
  return schemaFor(value);
}

export function generateJsonSchemaText(text) {
  const parsed = JSON.parse(text || 'null');
  return JSON.stringify(generateJsonSchema(parsed), null, 2);
}
