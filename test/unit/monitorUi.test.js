import { describe, expect, it } from 'vitest';
import {
  CRON_PRESETS,
  canManageMonitors,
  cronLabel,
  flattenWorkspaceRequests,
  formatDuration,
  formatLastRun,
  formatNextRun,
  normalizeRuns,
  requestOptionLabel,
  summarizeRun,
} from '../../src/lib/monitorUi.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

describe('flattenWorkspaceRequests', () => {
  const workspace = {
    collections: [
      {
        id: 'c1',
        name: 'API',
        items: [
          { id: 'r1', type: 'request', name: 'List users', method: 'GET' },
          {
            id: 'f1',
            type: 'folder',
            name: 'Users',
            items: [
              { id: 'r2', type: 'request', name: 'Get user', method: 'POST' },
              { id: 'f2', type: 'folder', name: 'Admin', items: [
                { id: 'r3', type: 'request', name: 'Delete user', method: 'DELETE' },
              ] },
            ],
          },
          { id: 'r4', name: '  ' },
        ],
      },
      {
        id: 'c2',
        name: 'Legacy',
        requests: [{ id: 'r5', name: 'Old request', method: 'PUT' }],
      },
    ],
  };

  it('walks collections and folders, including legacy request arrays', () => {
    expect(flattenWorkspaceRequests(workspace)).toEqual([
      {
        id: 'r1',
        name: 'List users',
        method: 'GET',
        collectionId: 'c1',
        breadcrumb: 'API',
        path: 'API / List users',
      },
      {
        id: 'r2',
        name: 'Get user',
        method: 'POST',
        collectionId: 'c1',
        breadcrumb: 'API / Users',
        path: 'API / Users / Get user',
      },
      {
        id: 'r3',
        name: 'Delete user',
        method: 'DELETE',
        collectionId: 'c1',
        breadcrumb: 'API / Users / Admin',
        path: 'API / Users / Admin / Delete user',
      },
      {
        id: 'r4',
        name: 'Untitled',
        method: 'GET',
        collectionId: 'c1',
        breadcrumb: 'API',
        path: 'API / Untitled',
      },
      {
        id: 'r5',
        name: 'Old request',
        method: 'PUT',
        collectionId: 'c2',
        breadcrumb: 'Legacy',
        path: 'Legacy / Old request',
      },
    ]);
  });

  it('accepts a bare collections array and tolerates bad input', () => {
    expect(flattenWorkspaceRequests(workspace.collections)).toHaveLength(5);
    expect(flattenWorkspaceRequests(null)).toEqual([]);
    expect(flattenWorkspaceRequests([null, { id: 'c3' }])).toEqual([]);
    expect(
      flattenWorkspaceRequests([
        { id: 'c4', name: 'C4', items: [{ type: 'request', name: 'No id' }] },
      ])
    ).toEqual([]);
  });

  it('labels options by path, then name, then a fallback', () => {
    expect(requestOptionLabel({ path: 'API / List users', name: 'List users' })).toBe(
      'API / List users'
    );
    expect(requestOptionLabel({ name: 'List users' })).toBe('List users');
    expect(requestOptionLabel(null)).toBe('Unknown request');
  });
});

describe('cron presets', () => {
  it('exposes the three documented presets', () => {
    expect(CRON_PRESETS.map((preset) => preset.value)).toEqual([
      '*/5 * * * *',
      '0 * * * *',
      '0 9 * * *',
    ]);
  });

  it('labels presets and keeps custom expressions verbatim', () => {
    expect(cronLabel('*/5 * * * *')).toBe('Every 5 minutes');
    expect(cronLabel('0 * * * *')).toBe('Hourly');
    expect(cronLabel('0 9 * * *')).toBe('Daily at 09:00 UTC');
    expect(cronLabel('*/15 * * * *')).toBe('*/15 * * * *');
    expect(cronLabel('  ')).toBe('No schedule');
    expect(cronLabel(null)).toBe('No schedule');
  });
});

describe('role gating', () => {
  it('lets owners, admins, and editors mutate', () => {
    expect(canManageMonitors('owner')).toBe(true);
    expect(canManageMonitors('admin')).toBe(true);
    expect(canManageMonitors('editor')).toBe(true);
  });

  it('keeps viewers read-only and shows controls when the role is unknown', () => {
    expect(canManageMonitors('viewer')).toBe(false);
    expect(canManageMonitors('guest')).toBe(false);
    expect(canManageMonitors(null)).toBe(true);
    expect(canManageMonitors(undefined)).toBe(true);
    expect(canManageMonitors('')).toBe(true);
  });
});

describe('next and last run formatting', () => {
  it('formats upcoming schedules with compact units', () => {
    expect(formatNextRun(NOW + 5 * 60 * 1000, NOW)).toBe('in 5m');
    expect(formatNextRun(NOW + 2 * 60 * 60 * 1000, NOW)).toBe('in 2h');
    expect(formatNextRun(NOW + 3 * 24 * 60 * 60 * 1000, NOW)).toBe('in 3d');
    expect(formatNextRun(NOW + 30 * 1000, NOW)).toBe('in <1m');
    expect(formatNextRun(NOW - 1000, NOW)).toBe('due now');
  });

  it('falls back to a UTC date far in the future and handles bad values', () => {
    expect(formatNextRun('2026-11-20T08:05:00Z', NOW)).toBe('2026-11-20 08:05 UTC');
    expect(formatNextRun(null, NOW)).toBe('Not scheduled');
    expect(formatNextRun('bogus', NOW)).toBe('Not scheduled');
  });

  it('formats last runs relative to now, or Never', () => {
    expect(formatLastRun(NOW - 5 * 60 * 1000, NOW)).toBe('5m ago');
    expect(formatLastRun(NOW - 2 * 60 * 60 * 1000, NOW)).toBe('2h ago');
    expect(formatLastRun(NOW - 3 * 24 * 60 * 60 * 1000, NOW)).toBe('3d ago');
    expect(formatLastRun(null, NOW)).toBe('Never');
    expect(formatLastRun('bogus', NOW)).toBe('Never');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds, seconds, minutes, and hours', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(123)).toBe('123ms');
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65000)).toBe('1m 5s');
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(3600000)).toBe('1h');
    expect(formatDuration(3900000)).toBe('1h 5m');
  });

  it('returns a dash for missing or negative values', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration('bogus')).toBe('—');
  });
});

describe('summarizeRun', () => {
  it('describes a passing run', () => {
    expect(
      summarizeRun({
        id: 'run-1',
        ok: true,
        statusCode: 200,
        durationMs: 123,
        assertionFailures: 0,
        startedAt: '2026-10-30T11:55:00Z',
        finishedAt: '2026-10-30T11:55:00Z',
      })
    ).toEqual({
      ok: true,
      status: 'Passed',
      statusCode: 200,
      durationMs: 123,
      duration: '123ms',
      assertions: 0,
      assertionsLabel: '0 assertions failed',
      summary: 'Passed · 200 · 123ms',
      startedAt: '2026-10-30T11:55:00Z',
      finishedAt: '2026-10-30T11:55:00Z',
      error: '',
    });
  });

  it('describes a failing run with assertion failures and an error', () => {
    const summary = summarizeRun({
      ok: false,
      statusCode: 500,
      durationMs: 1500,
      assertionFailures: 2,
      error: 'boom',
    });
    expect(summary).toMatchObject({
      ok: false,
      status: 'Failed',
      statusCode: 500,
      duration: '1.5s',
      assertions: 2,
      assertionsLabel: '2 assertions failed',
      summary: 'Failed · 500 · 1.5s · 2 assertions failed',
      error: 'boom',
    });
  });

  it('handles a missing run and missing fields', () => {
    expect(summarizeRun(null)).toMatchObject({
      ok: false,
      status: 'No runs yet',
      summary: 'No runs yet',
      duration: '—',
      assertions: 0,
    });
    expect(summarizeRun({ ok: true, assertionFailures: 1 })).toMatchObject({
      status: 'Passed',
      statusCode: null,
      duration: '—',
      assertions: 1,
      assertionsLabel: '1 assertion failed',
      summary: 'Passed · 1 assertion failed',
    });
  });
});

describe('normalizeRuns', () => {
  it('accepts arrays, {runs}, and {data} payloads and drops junk', () => {
    expect(normalizeRuns([{ id: '1' }, null, { id: '2' }])).toEqual([{ id: '1' }, { id: '2' }]);
    expect(normalizeRuns({ runs: [{ id: '1' }] })).toEqual([{ id: '1' }]);
    expect(normalizeRuns({ data: [{ id: '1' }] })).toEqual([{ id: '1' }]);
    expect(normalizeRuns(null)).toEqual([]);
  });
});
