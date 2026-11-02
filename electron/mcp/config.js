// MCP client/token configuration helpers.
//
// The config lives in the main-process store:
//   { enabled, port, clients: [{ id, name, prefix, tokenHash, scopes,
//                                approval, createdAt, lastUsedAt }] }
// A raw token is returned exactly once (create/rotate) and never persisted:
// only its SHA-256 hex digest and a short display prefix are stored.

import crypto from 'node:crypto';
import { MCP_SCOPES } from '../../shared/mcpScopes.js';

export const DEFAULT_MCP_PORT = 47821;
export const MCP_PORT_MIN = 1024;
export const MCP_PORT_MAX = 65535;
export const MCP_MAX_CLIENTS = 20;
export const MCP_APPROVAL_POLICIES = ['always', 'session', 'never'];
export const MCP_TOKEN_PREFIX = 'relay_mcp_';
export const MCP_NAME_MAX = 60;

const APPROVAL_SET = new Set(MCP_APPROVAL_POLICIES);

export function isValidPort(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= MCP_PORT_MIN && value <= MCP_PORT_MAX;
}

export function isValidApproval(value) {
  return APPROVAL_SET.has(value);
}

/** Only known scopes, deduplicated, in catalogue order. */
export function normalizeScopes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const wanted = new Set(list.map((s) => String(s)));
  return MCP_SCOPES.filter((scope) => wanted.has(scope));
}

function normalizeName(raw) {
  return String(raw == null ? '' : raw).trim().slice(0, MCP_NAME_MAX);
}

function normalizeClient(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = normalizeName(raw.name);
  if (!name) return null;
  const scopes = normalizeScopes(raw.scopes);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newClientId(),
    name,
    prefix: typeof raw.prefix === 'string' ? raw.prefix : MCP_TOKEN_PREFIX,
    tokenHash: typeof raw.tokenHash === 'string' ? raw.tokenHash : '',
    scopes: scopes.length ? scopes : ['read'],
    approval: isValidApproval(raw.approval) ? raw.approval : 'always',
    createdAt:
      raw.createdAt == null || !Number.isFinite(Number(raw.createdAt))
        ? Date.now()
        : Number(raw.createdAt),
    lastUsedAt:
      raw.lastUsedAt == null || !Number.isFinite(Number(raw.lastUsedAt))
        ? null
        : Number(raw.lastUsedAt),
  };
}

/**
 * Coerce any persisted value into the MCP config shape. Unknown scopes and
 * approval values fall back to the safe default; names are trimmed, capped at
 * 60 chars and de-duplicated case-insensitively; at most 20 clients survive.
 */
export function normalizeMcpConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const clients = [];
  for (const entry of Array.isArray(input.clients) ? input.clients : []) {
    const client = normalizeClient(entry);
    if (!client) continue;
    const key = client.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clients.push(client);
    if (clients.length >= MCP_MAX_CLIENTS) break;
  }
  const port = Number(input.port);
  return {
    enabled: input.enabled === true,
    port: isValidPort(port) ? port : DEFAULT_MCP_PORT,
    clients,
  };
}

/** Shape the renderer may see: everything except the token digest. */
export function sanitizeMcpConfig(config) {
  const normalized = normalizeMcpConfig(config);
  return {
    enabled: normalized.enabled,
    port: normalized.port,
    clients: normalized.clients.map((client) => ({
      id: client.id,
      name: client.name,
      prefix: client.prefix,
      scopes: [...client.scopes],
      approval: client.approval,
      createdAt: client.createdAt,
      lastUsedAt: client.lastUsedAt,
    })),
  };
}

function newClientId() {
  return `mcp_${crypto.randomBytes(6).toString('hex')}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken() {
  return MCP_TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
}

/**
 * Create a client record plus its one-time token.
 * Throws on a bad name/scope/approval or when the client limit is reached.
 */
export function createClientRecord({ name, scopes, approval } = {}, config = null) {
  const normalizedName = normalizeName(name);
  if (!normalizedName) throw new Error('Client name is required.');
  const nextScopes = normalizeScopes(scopes);
  if (Array.isArray(scopes) && scopes.length && nextScopes.length !== scopes.length) {
    throw new Error('Unknown scope requested.');
  }
  const policy = approval == null ? 'always' : approval;
  if (!isValidApproval(policy)) throw new Error('Approval must be always, session, or never.');

  if (config) {
    const existing = normalizeMcpConfig(config);
    if (existing.clients.length >= MCP_MAX_CLIENTS) {
      throw new Error(`At most ${MCP_MAX_CLIENTS} MCP clients are allowed.`);
    }
    const clash = existing.clients.some(
      (client) => client.name.toLowerCase() === normalizedName.toLowerCase()
    );
    if (clash) throw new Error('An MCP client with that name already exists.');
  }

  const token = newToken();
  const client = {
    id: newClientId(),
    name: normalizedName,
    prefix: MCP_TOKEN_PREFIX + token.slice(MCP_TOKEN_PREFIX.length, MCP_TOKEN_PREFIX.length + 6),
    tokenHash: hashToken(token),
    scopes: nextScopes.length ? nextScopes : ['read'],
    approval: policy,
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  return { client, token };
}

/**
 * Find the client a bearer token belongs to. Compares SHA-256 digests with
 * timingSafeEqual so a wrong token leaks nothing about stored hashes.
 */
export function verifyToken(config, token) {
  if (typeof token !== 'string' || !token) return null;
  const digest = Buffer.from(hashToken(token), 'hex');
  const clients = normalizeMcpConfig(config).clients;
  let found = null;
  for (const client of clients) {
    if (!client.tokenHash || client.tokenHash.length !== digest.length * 2) continue;
    const stored = Buffer.from(client.tokenHash, 'hex');
    if (stored.length !== digest.length) continue;
    if (crypto.timingSafeEqual(stored, digest)) found = client;
  }
  return found;
}

/**
 * Merge a patch into one client record.
 * Returns `{ok:true, config, client}` or `{ok:false, error}`.
 */
export function updateClientRecord(config, id, patch = {}) {
  const base = normalizeMcpConfig(config);
  const index = base.clients.findIndex((client) => client.id === id);
  if (index < 0) return { ok: false, error: 'Unknown MCP client.' };
  const current = base.clients[index];
  const next = { ...current };

  if (patch.name !== undefined) {
    const name = normalizeName(patch.name);
    if (!name) return { ok: false, error: 'Client name is required.' };
    const clash = base.clients.some(
      (client) => client.id !== id && client.name.toLowerCase() === name.toLowerCase()
    );
    if (clash) return { ok: false, error: 'An MCP client with that name already exists.' };
    next.name = name;
  }
  if (patch.scopes !== undefined) {
    const scopes = normalizeScopes(patch.scopes);
    if (Array.isArray(patch.scopes) && patch.scopes.length && !scopes.length) {
      return { ok: false, error: 'Unknown scope requested.' };
    }
    next.scopes = scopes.length ? scopes : ['read'];
  }
  if (patch.approval !== undefined) {
    if (!isValidApproval(patch.approval)) {
      return { ok: false, error: 'Approval must be always, session, or never.' };
    }
    next.approval = patch.approval;
  }

  const clients = base.clients.slice();
  clients[index] = next;
  return { ok: true, config: { ...base, clients }, client: next };
}

/** Remove a client. Returns `{ok:true, config}` or `{ok:false, error}`. */
export function removeClient(config, id) {
  const base = normalizeMcpConfig(config);
  const clients = base.clients.filter((client) => client.id !== id);
  if (clients.length === base.clients.length) return { ok: false, error: 'Unknown MCP client.' };
  return { ok: true, config: { ...base, clients } };
}

/**
 * Replace a client's token. Returns `{ok:true, config, client, token}` or
 * `{ok:false, error}`; the raw token is the only copy.
 */
export function rotateClientToken(config, id) {
  const base = normalizeMcpConfig(config);
  const index = base.clients.findIndex((client) => client.id === id);
  if (index < 0) return { ok: false, error: 'Unknown MCP client.' };
  const token = newToken();
  const client = {
    ...base.clients[index],
    prefix: MCP_TOKEN_PREFIX + token.slice(MCP_TOKEN_PREFIX.length, MCP_TOKEN_PREFIX.length + 6),
    tokenHash: hashToken(token),
    lastUsedAt: null,
  };
  const clients = base.clients.slice();
  clients[index] = client;
  return { ok: true, config: { ...base, clients }, client, token };
}

/** Mark a client as used, at most once per minute (keeps disk writes rare). */
export function touchClient(config, id, now = Date.now()) {
  const base = normalizeMcpConfig(config);
  const index = base.clients.findIndex((client) => client.id === id);
  if (index < 0) return { config: base, changed: false };
  const current = base.clients[index];
  if (current.lastUsedAt && now - current.lastUsedAt < 60_000) {
    return { config: base, changed: false };
  }
  const clients = base.clients.slice();
  clients[index] = { ...current, lastUsedAt: now };
  return { config: { ...base, clients }, changed: true };
}
