import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  buildInviteLink,
  canAssignRole,
  canManageMember,
  formatAuditAction,
  formatAuditTarget,
  formatAuditTimestamp,
  mergeAuditEvents,
  shortId,
} from '../../src/components/teamUi.js';

describe('team role matrix', () => {
  it('lets owners hand out every role', () => {
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'editor', 'viewer']);
  });

  it('caps admins below ownership', () => {
    expect(assignableRoles('admin')).toEqual(['admin', 'editor', 'viewer']);
  });

  it('gives editors, viewers, and unknown callers no options', () => {
    expect(assignableRoles('editor')).toEqual([]);
    expect(assignableRoles('viewer')).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
  });

  it('returns a copy so callers cannot mutate the matrix', () => {
    const roles = assignableRoles('owner');
    roles.push('intruder');
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'editor', 'viewer']);
  });

  it('checks single-role assignment', () => {
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'viewer')).toBe(true);
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('viewer', 'viewer')).toBe(false);
  });
});

describe('canManageMember', () => {
  it('allows managers to edit lower roles', () => {
    expect(canManageMember('owner', { userId: 'u2', role: 'admin' }, 'u1')).toBe(true);
    expect(canManageMember('admin', { userId: 'u2', role: 'editor' }, 'u1')).toBe(true);
  });

  it('blocks admins from touching owners', () => {
    expect(canManageMember('admin', { userId: 'u2', role: 'owner' }, 'u1')).toBe(false);
    expect(canManageMember('owner', { userId: 'u2', role: 'owner' }, 'u1')).toBe(true);
  });

  it('blocks self-management and non-managers', () => {
    expect(canManageMember('owner', { userId: 'u1', role: 'owner' }, 'u1')).toBe(false);
    expect(canManageMember('editor', { userId: 'u2', role: 'viewer' }, 'u1')).toBe(false);
    expect(canManageMember('owner', null, 'u1')).toBe(false);
  });
});

describe('shortId', () => {
  it('truncates long ids and keeps short ones', () => {
    expect(shortId('1234567890abcdef', 8)).toBe('12345678');
    expect(shortId('abc')).toBe('abc');
    expect(shortId('  abcdefghij  ', 4)).toBe('abcd');
  });

  it('handles empty values', () => {
    expect(shortId(null)).toBe('');
    expect(shortId(undefined)).toBe('');
    expect(shortId('   ')).toBe('');
  });
});

describe('formatAuditAction', () => {
  it('maps known actions', () => {
    expect(formatAuditAction('member.invited')).toBe('Invited member');
    expect(formatAuditAction('member.role_changed')).toBe('Changed member role');
    expect(formatAuditAction('workspace.deleted')).toBe('Deleted workspace');
  });

  it('humanizes unknown actions', () => {
    expect(formatAuditAction('custom.thing_done')).toBe('Custom thing done');
    expect(formatAuditAction('REVOKED: invite')).toBe('REVOKED invite');
  });

  it('handles missing actions', () => {
    expect(formatAuditAction('')).toBe('Unknown action');
    expect(formatAuditAction(null)).toBe('Unknown action');
  });
});

describe('formatAuditTimestamp', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();

  it('formats recent times as relative ages', () => {
    expect(formatAuditTimestamp(ago(10 * 1000), now)).toBe('just now');
    expect(formatAuditTimestamp(ago(5 * 60 * 1000), now)).toBe('5m ago');
    expect(formatAuditTimestamp(ago(3 * 60 * 60 * 1000), now)).toBe('3h ago');
    expect(formatAuditTimestamp(ago(2 * 24 * 60 * 60 * 1000), now)).toBe('2d ago');
  });

  it('clamps future timestamps to just now', () => {
    expect(formatAuditTimestamp(ago(-60 * 1000), now)).toBe('just now');
  });

  it('falls back to a UTC timestamp after a week', () => {
    expect(formatAuditTimestamp('2026-09-30T12:00:00Z', now)).toBe('2026-09-30 12:00 UTC');
  });

  it('accepts date objects and epoch milliseconds', () => {
    expect(formatAuditTimestamp(new Date(now - 90 * 1000), now)).toBe('1m ago');
    expect(formatAuditTimestamp(now - 90 * 1000, now)).toBe('1m ago');
  });

  it('returns an empty string for unusable input', () => {
    expect(formatAuditTimestamp('not-a-date', now)).toBe('');
    expect(formatAuditTimestamp(null, now)).toBe('');
  });
});

describe('formatAuditTarget', () => {
  it('renders primitives', () => {
    expect(formatAuditTarget('entity-1')).toBe('entity-1');
    expect(formatAuditTarget(42)).toBe('42');
  });

  it('prefers ids, then labels, for objects', () => {
    expect(formatAuditTarget({ userId: 'u9' })).toBe('u9');
    expect(formatAuditTarget({ name: 'Project X' })).toBe('Project X');
  });

  it('renders a dash for absent targets', () => {
    expect(formatAuditTarget(null)).toBe('—');
    expect(formatAuditTarget({})).toBe('—');
  });
});

describe('mergeAuditEvents', () => {
  it('deduplicates by id and sorts newest first', () => {
    const older = { id: '1', createdAt: '2026-10-01T10:00:00Z' };
    const newer = { id: '2', createdAt: '2026-10-02T10:00:00Z' };
    const updated = { id: '1', createdAt: '2026-10-01T10:00:00Z', action: 'member.removed' };

    const merged = mergeAuditEvents([older], [newer, updated]);
    expect(merged.map((event) => event.id)).toEqual(['2', '1']);
    expect(merged[1].action).toBe('member.removed');
  });

  it('skips rows without ids and tolerates empty pages', () => {
    expect(mergeAuditEvents([], [])).toEqual([]);
    expect(mergeAuditEvents(null, [{ createdAt: '2026-01-01T00:00:00Z' }])).toEqual([]);
  });
});

describe('buildInviteLink', () => {
  it('joins relative accept paths onto an http origin', () => {
    expect(buildInviteLink('/invite/abc', 'https://relay.test')).toBe(
      'https://relay.test/invite/abc'
    );
    expect(buildInviteLink('invite/abc', 'https://relay.test/')).toBe(
      'https://relay.test/invite/abc'
    );
  });

  it('keeps absolute links and bare paths', () => {
    expect(buildInviteLink('https://relay.test/invite/abc', 'https://other.test')).toBe(
      'https://relay.test/invite/abc'
    );
    expect(buildInviteLink('/invite/abc', 'file://')).toBe('/invite/abc');
    expect(buildInviteLink('', 'https://relay.test')).toBe('');
  });
});
