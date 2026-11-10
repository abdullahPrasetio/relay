// Renderer-side helpers for the server mock tab. Kept out of components so the
// endpoint/log normalisation and error mapping are unit-testable.

export const MOCK_LOG_LIMIT = 50;

const MANAGE_ROLES = new Set(['owner', 'admin', 'editor']);

export function canManageMocks(role) {
  return role == null ? true : MANAGE_ROLES.has(String(role));
}

/** Map relay-api's HTTP status to the copy the plan specifies. */
export function mockErrorText(res, fallback = 'Mock request failed.') {
  const status = Number(res?.error?.status) || 0;
  const message = typeof res?.error?.message === 'string' ? res.error.message.trim() : '';
  if (status === 401) return 'Session expired — sign in again.';
  if (status === 403) return 'Editor role is required in this workspace.';
  if (status === 404) {
    return message || 'Mock or request not found (it may have been deleted).';
  }
  if (status === 409) return message || 'A mock already exists for this method and path.';
  if (status === 405) return 'The server does not support cloud mocks yet.';
  if (status === 429) return 'Too many mock requests — try again shortly.';
  return message || fallback;
}

export function normalizeMockEndpoints(data) {
  const source = data && typeof data === 'object' ? data : {};
  const endpoints = Array.isArray(source.endpoints) ? source.endpoints : [];
  return {
    mockBaseUrl: typeof source.mockBaseUrl === 'string' ? source.mockBaseUrl : '',
    endpoints: endpoints.filter((entry) => entry && typeof entry === 'object'),
  };
}

export function normalizeMockLogs(data) {
  const source = data && typeof data === 'object' ? data : {};
  const logs = Array.isArray(source.logs) ? source.logs : [];
  return logs.filter((entry) => entry && typeof entry === 'object');
}

export function normalizeMockScenarios(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.scenarios)
      ? data.scenarios
      : [];
  return list
    .filter((entry) => entry && typeof entry === 'object')
    .sort(
      (a, b) =>
        (Number(a.orderIndex) || 0) - (Number(b.orderIndex) || 0) ||
        String(a.name || '').localeCompare(String(b.name || ''))
    );
}

export function mockEndpointUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '/');
  return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

export function endpointScenarioCount(endpoint) {
  return Array.isArray(endpoint?.scenarios) ? endpoint.scenarios.length : 0;
}

export function scenarioSummary(scenario) {
  const conditions = Array.isArray(scenario?.conditions) ? scenario.conditions : [];
  if (!conditions.length) return 'default response';
  return conditions
    .map((condition) => {
      const source = condition?.source || 'query';
      const key = condition?.key || '?';
      const operator = condition?.operator || 'equals';
      const value = condition?.value;
      return value === undefined || value === '' || operator === 'exists' || operator === 'not_exists'
        ? `${source} ${key} ${operator}`
        : `${source} ${key} ${operator} ${value}`;
    })
    .join(' AND ');
}

export function formatMockTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export function formatLatency(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms)} ms` : '—';
}

export function headerRows(headers) {
  if (!headers || typeof headers !== 'object') return [];
  return Object.entries(headers).map(([key, value]) => ({
    key,
    value: value == null ? '' : String(value),
    enabled: true,
  }));
}

export function requestOptionLabel(option) {
  if (!option) return 'Unknown request';
  const method = option.method ? `${option.method} ` : '';
  return `${method}${option.path || option.name || 'Untitled request'}`;
}
