import { describe, expect, it } from 'vitest';
import {
  conflictKindLabel,
  conflictName,
  conflictSummary,
  describeConflict,
  formatDateTime,
  formatDeviceActivity,
  formatDeviceLabel,
  formatRelativeTime,
  normalizeDevices,
  shortId,
} from '../../src/lib/deviceUi.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

describe('device id formatting', () => {
  it('truncates opaque ids and leaves short ones alone', () => {
    expect(shortId('9f1c2d3e-aaaa-bbbb-cccc-ddddeeeeffff')).toBe('9f1c2d3e');
    expect(shortId('abc')).toBe('abc');
    expect(shortId('abcdef', 3)).toBe('abc');
  });

  it('returns an empty string for missing values', () => {
    expect(shortId(null)).toBe('');
    expect(shortId(undefined)).toBe('');
    expect(shortId('   ')).toBe('');
  });
});

describe('date formatting', () => {
  it('renders UTC timestamps for audit-stable output', () => {
    expect(formatDateTime('2026-10-01T08:05:00Z')).toBe('2026-10-01 08:05 UTC');
    expect(formatDateTime(Date.UTC(2026, 0, 2, 3, 4))).toBe('2026-01-02 03:04 UTC');
  });

  it('rejects values that cannot be parsed', () => {
    expect(formatDateTime('not a date')).toBe('');
    expect(formatDateTime(null)).toBe('');
  });

  it('uses compact relative labels under a week', () => {
    expect(formatRelativeTime(NOW - 10 * 1000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 5 * 60 * 1000, NOW)).toBe('5m ago');
    expect(formatRelativeTime(NOW - 2 * 60 * 60 * 1000, NOW)).toBe('2h ago');
    expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60 * 1000, NOW)).toBe('3d ago');
  });

  it('clamps future timestamps and falls back to a date after a week', () => {
    expect(formatRelativeTime(NOW + 60 * 1000, NOW)).toBe('just now');
    expect(formatRelativeTime('2026-10-01T08:05:00Z', NOW)).toBe('2026-10-01 08:05 UTC');
    expect(formatRelativeTime('bogus', NOW)).toBe('');
  });
});

describe('device labels and activity', () => {
  it('reads camelCase, snake_case, and plain strings', () => {
    expect(formatDeviceLabel({ deviceLabel: '  MacBook  ' })).toBe('MacBook');
    expect(formatDeviceLabel({ device_label: 'Office PC' })).toBe('Office PC');
    expect(formatDeviceLabel('  Laptop ')).toBe('Laptop');
  });

  it('names blank devices', () => {
    expect(formatDeviceLabel({ deviceLabel: '   ' })).toBe('Unnamed device');
    expect(formatDeviceLabel(null)).toBe('Unnamed device');
  });

  it('prefers last use over creation time', () => {
    expect(
      formatDeviceActivity(
        { lastUsedAt: new Date(NOW - 5 * 60 * 1000).toISOString(), createdAt: NOW - 40 * 24 * 60 * 60 * 1000 },
        NOW
      )
    ).toBe('Last used 5m ago');
  });

  it('falls back to creation time and then to a neutral label', () => {
    expect(formatDeviceActivity({ createdAt: NOW - 2 * 60 * 60 * 1000 }, NOW)).toBe('Added 2h ago');
    expect(formatDeviceActivity({}, NOW)).toBe('Activity unknown');
    expect(
      formatDeviceActivity(
        { last_used_at: new Date(NOW - 24 * 60 * 60 * 1000).toISOString() },
        NOW
      )
    ).toBe('Last used 1d ago');
  });
});

describe('conflict labels', () => {
  it('maps known kinds and humanizes unknown ones', () => {
    expect(conflictKindLabel('request')).toBe('Request');
    expect(conflictKindLabel('collection')).toBe('Collection');
    expect(conflictKindLabel('globals')).toBe('Globals');
    expect(conflictKindLabel('mock_server')).toBe('Mock server');
    expect(conflictKindLabel(null)).toBe('Change');
  });

  it('prefers the local name, then the server name, then a short id', () => {
    expect(conflictName({ id: 'aaaaaaaa-bbbb', local: { payload: { name: 'Local' } } })).toBe('Local');
    expect(conflictName({ id: 'aaaaaaaa-bbbb', server: { payload: { name: 'Server' } } })).toBe(
      'Server'
    );
    expect(conflictName({ id: 'aaaaaaaa-bbbb', kind: 'globals' })).toBe('Globals');
    expect(conflictName({ id: 'aaaaaaaa-bbbb', kind: 'request' })).toBe('Change aaaaaaaa');
    expect(conflictName({ kind: 'request' })).toBe('Untitled change');
  });

  it('describes the entity and deletion state of both sides', () => {
    expect(describeConflict({ id: '1', kind: 'request', local: { payload: { name: 'List' } } })).toBe(
      'Request “List”'
    );
    expect(
      describeConflict({
        id: '1',
        kind: 'folder',
        local: { payload: { name: 'Users' }, deleted: false },
        server: { deleted: true },
      })
    ).toBe('Folder “Users” (deleted on server)');
    expect(
      describeConflict({ id: '1', kind: 'request', local: { deleted: true }, server: {} })
    ).toBe('Request “Change 1” (deleted locally)');
  });

  it('summarises counts for the banner and modal', () => {
    expect(conflictSummary([])).toBe('No conflicts');
    expect(conflictSummary(1)).toBe('1 conflict');
    expect(conflictSummary(4)).toBe('4 conflicts');
    expect(conflictSummary([{}, {}, {}])).toBe('3 conflicts');
    expect(conflictSummary(undefined)).toBe('No conflicts');
  });
});

describe('normalizeDevices', () => {
  it('accepts a bare array and camelCase fields', () => {
    expect(
      normalizeDevices([
        {
          id: 'dev-1',
          deviceLabel: 'MacBook',
          createdAt: '2026-10-01T08:05:00Z',
          lastUsedAt: '2026-10-02T09:00:00Z',
          expiresAt: '2026-11-01T09:00:00Z',
        },
      ])
    ).toEqual([
      {
        id: 'dev-1',
        deviceLabel: 'MacBook',
        createdAt: '2026-10-01T08:05:00Z',
        lastUsedAt: '2026-10-02T09:00:00Z',
        expiresAt: '2026-11-01T09:00:00Z',
      },
    ]);
  });

  it('unwraps {devices} and normalises snake_case', () => {
    expect(
      normalizeDevices({
        devices: [
          {
            id: 'dev-2',
            device_label: 'Office PC',
            created_at: '2026-10-01T08:05:00Z',
            last_used_at: null,
          },
        ],
      })
    ).toEqual([
      {
        id: 'dev-2',
        deviceLabel: 'Office PC',
        createdAt: '2026-10-01T08:05:00Z',
        lastUsedAt: null,
        expiresAt: null,
      },
    ]);
  });

  it('drops invalid duplicates and non-list payloads', () => {
    expect(
      normalizeDevices([
        { id: 'dev-1', deviceLabel: 'One' },
        { id: 'dev-1', deviceLabel: 'Duplicate' },
        { id: '', deviceLabel: 'No id' },
        null,
        { deviceLabel: 'Missing id' },
      ])
    ).toHaveLength(1);
    expect(normalizeDevices(null)).toEqual([]);
    expect(normalizeDevices('nope')).toEqual([]);
    expect(normalizeDevices({ devices: null })).toEqual([]);
  });
});
