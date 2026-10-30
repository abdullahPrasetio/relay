import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { useDialogs } from './Dialogs.jsx';
import {
  ROLE_LABELS,
  assignableRoles,
  buildInviteLink,
  canManageMember,
  isManagerRole,
  shortId,
} from './teamUi.js';

const EXPIRY_OPTIONS = [
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' },
  { value: 720, label: '30 days' },
];

function errorMessage(res, fallback) {
  return res?.error?.message || fallback;
}

function pageOrigin() {
  if (typeof window === 'undefined') return '';
  const { location } = window;
  return location && /^https?:$/.test(location.protocol) ? location.origin : '';
}

function expiryLabel(value) {
  if (!value) return 'soon';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// navigator.clipboard needs a secure context; Electron file:// windows have
// it on modern builds, but a hidden textarea keeps copying working anywhere.
function legacyCopy(text) {
  if (typeof document === 'undefined' || !document.body) return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

// Workspace membership management: list members, change roles, remove
// members, and mint a single-use invite link. Every call goes through the
// main-process bridge; this component never sees cloud credentials.
export default function WorkspaceMembersModal({
  workspace,
  currentUserId = null,
  cloud: cloudBridge = null,
  reencryptSecrets = null,
  onClose,
}) {
  const dialogs = useDialogs();
  const api = useMemo(
    () => cloudBridge || (typeof window !== 'undefined' ? window.api?.cloud : null),
    [cloudBridge]
  );
  const remoteId = workspace?.cloud?.remoteId || null;

  const [members, setMembers] = useState([]);
  const [selfId, setSelfId] = useState(currentUserId || null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingUserId, setSavingUserId] = useState(null);
  const [removingUserId, setRemovingUserId] = useState(null);
  const [rotating, setRotating] = useState(false);
  const [rotationError, setRotationError] = useState('');
  const [inviteRole, setInviteRole] = useState('editor');
  const [expiryHours, setExpiryHours] = useState(72);
  const [invite, setInvite] = useState(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!remoteId) {
      setLoading(false);
      setError('This workspace is not linked to Relay Cloud.');
      return;
    }
    if (!api || typeof api.members !== 'function') {
      setLoading(false);
      setError('Team management requires the desktop app.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.members({ workspaceId: remoteId });
      if (seq !== requestSeq.current) return;
      if (!res?.ok) {
        setMembers([]);
        setError(errorMessage(res, 'Could not load workspace members.'));
      } else {
        setMembers(Array.isArray(res.data) ? res.data : []);
      }
    } catch (err) {
      if (seq === requestSeq.current) {
        setMembers([]);
        setError(err?.message || 'Could not load workspace members.');
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [api, remoteId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setSelfId(currentUserId || null);
  }, [currentUserId]);

  // `cloud.user` is memory-only in main, so after a restart the renderer may
  // not know who is signed in. Ask main once; without it the modal stays
  // read-only rather than guessing the caller's role.
  useEffect(() => {
    if (selfId || !api || typeof api.me !== 'function') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.me();
        const identity = res?.data?.user || res?.data;
        const id = identity?.id || identity?.userId;
        if (!cancelled && res?.ok && id) setSelfId(String(id));
      } catch {
        /* read-only fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, selfId]);

  const callerRole = useMemo(() => {
    if (!selfId) return null;
    const self = members.find((member) => member.userId === selfId);
    return self?.role || null;
  }, [members, selfId]);

  const manageRoles = assignableRoles(callerRole);

  useEffect(() => {
    const roles = assignableRoles(callerRole);
    if (!roles.length) return;
    setInviteRole((previous) => (roles.includes(previous) ? previous : roles[0]));
  }, [callerRole]);

  // A new invite belongs to one role/expiry pair; changing the draft must not
  // keep showing the previously generated (single-use) token.
  useEffect(() => {
    setInvite(null);
    setCopied(false);
    setCopyError('');
  }, [inviteRole, expiryHours]);

  async function changeRole(member, role) {
    if (!api || savingUserId || role === member.role) return;
    setSavingUserId(member.userId);
    setError('');
    try {
      const res = await api.updateMemberRole({
        workspaceId: remoteId,
        userId: member.userId,
        role,
      });
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not update this member.'));
        return;
      }
      setMembers((previous) =>
        previous.map((entry) =>
          entry.userId === member.userId
            ? { ...entry, ...(res.data || {}), userId: entry.userId, role }
            : entry
        )
      );
    } catch (err) {
      setError(err?.message || 'Could not update this member.');
    } finally {
      setSavingUserId(null);
    }
  }

  async function removeMember(member) {
    if (!api || removingUserId) return;
    const ok = await dialogs.confirm(
      `Remove ${shortId(member.userId)} from "${workspace?.name || 'this workspace'}"?`,
      { title: 'Remove member', okLabel: 'Remove', danger: true }
    );
    if (!ok) return;
    setRemovingUserId(member.userId);
    setError('');
    setRotationError('');
    let removed = false;
    try {
      const res = await api.removeMember({ workspaceId: remoteId, userId: member.userId });
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not remove this member.'));
        return;
      }
      setMembers((previous) => previous.filter((entry) => entry.userId !== member.userId));
      removed = true;
    } catch (err) {
      setError(err?.message || 'Could not remove this member.');
    } finally {
      setRemovingUserId(null);
    }
    if (!removed) return;

    // The removed device still holds the old key, so managers rotate it right
    // away. A rotation failure must not invalidate the removal that already
    // succeeded: it is reported inline for a later retry.
    if (!isManagerRole(callerRole) || typeof reencryptSecrets !== 'function') return;
    setRotating(true);
    try {
      const rotated = await reencryptSecrets(workspace?.id);
      if (!rotated?.ok) {
        setRotationError(
          rotated?.error?.message || 'Could not rotate the workspace key after removing this member.'
        );
      }
    } catch (err) {
      setRotationError(
        err?.message || 'Could not rotate the workspace key after removing this member.'
      );
    } finally {
      setRotating(false);
    }
  }

  async function generateInvite() {
    if (!api || creatingInvite) return;
    setCreatingInvite(true);
    setError('');
    setCopied(false);
    setCopyError('');
    try {
      const res = await api.createInvite({
        workspaceId: remoteId,
        role: inviteRole,
        expiresInHours: Number(expiryHours),
      });
      if (!res?.ok) {
        setInvite(null);
        setError(errorMessage(res, 'Could not create an invite link.'));
        return;
      }
      setInvite({
        ...(res.data || {}),
        link: buildInviteLink(res.data?.acceptPath, pageOrigin()),
      });
    } catch (err) {
      setInvite(null);
      setError(err?.message || 'Could not create an invite link.');
    } finally {
      setCreatingInvite(false);
    }
  }

  async function copyInvite() {
    if (!invite?.link) return;
    setCopyError('');
    let copiedOk = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(invite.link);
        copiedOk = true;
      }
    } catch {
      copiedOk = false;
    }
    if (!copiedOk) copiedOk = legacyCopy(invite.link);
    if (copiedOk) {
      setCopied(true);
    } else {
      setCopied(false);
      setCopyError('Copying failed. Select the link and copy it manually.');
    }
  }

  const canManage = isManagerRole(callerRole);

  return (
    <Modal
      title={`Team · ${workspace?.name || 'Workspace'}`}
      onClose={onClose}
      width={620}
      footer={
        <button type="button" className="mini-btn" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="team-modal" data-testid="workspace-members-modal">
        {error && (
          <div className="cloud-error team-error" role="alert">
            {error}
          </div>
        )}
        {rotating && (
          <div className="team-empty" role="status" data-testid="workspace-rotation-busy">
            Rotating workspace key…
          </div>
        )}
        {!rotating && rotationError && (
          <div className="cloud-error team-error" role="alert" data-testid="workspace-rotation-error">
            {rotationError}
          </div>
        )}

        <section className="team-section">
          <div className="team-section-head">
            <span className="team-section-title">Members</span>
            <button type="button" className="mini-btn" onClick={load} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {loading ? (
            <div className="team-empty">Loading members…</div>
          ) : members.length === 0 ? (
            <div className="team-empty">No members listed for this workspace.</div>
          ) : (
            <ul className="team-members">
              {members.map((member) => {
                const editable = canManageMember(callerRole, member, selfId);
                const busy = savingUserId === member.userId || removingUserId === member.userId;
                return (
                  <li key={member.userId} className="team-member">
                    <div className="team-member-id">
                      <code title={member.userId}>{shortId(member.userId)}</code>
                      {member.userId === selfId && <span className="team-badge">you</span>}
                      {member.userId !== selfId && member.invitedBy && (
                        <span className="team-member-sub">
                          invited by {shortId(member.invitedBy)}
                        </span>
                      )}
                    </div>
                    <div className="team-member-actions">
                      {editable ? (
                        <select
                          className="team-role-select"
                          value={member.role}
                          aria-label={`Role for ${shortId(member.userId)}`}
                          disabled={busy}
                          onChange={(event) => changeRole(member, event.target.value)}
                        >
                          {assignableRoles(callerRole).map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role] || role}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`team-role-pill role-${member.role || 'unknown'}`}>
                          {ROLE_LABELS[member.role] || member.role || 'member'}
                        </span>
                      )}
                      {editable && (
                        <button
                          type="button"
                          className="icon-btn team-remove"
                          title={`Remove ${shortId(member.userId)}`}
                          aria-label={`Remove ${shortId(member.userId)}`}
                          disabled={busy}
                          onClick={() => removeMember(member)}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && !canManage && (
            <p className="team-hint">
              Only workspace owners and admins can change roles, remove members, or invite people.
            </p>
          )}
        </section>

        {canManage && (
          <section className="team-section">
            <div className="team-section-head">
              <span className="team-section-title">Invite link</span>
            </div>
            <div className="team-invite-controls">
              <div className="form-row">
                <label htmlFor="team-invite-role">Role</label>
                <select
                  id="team-invite-role"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value)}
                  disabled={creatingInvite}
                >
                  {manageRoles.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role] || role}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label htmlFor="team-invite-expiry">Expires</label>
                <select
                  id="team-invite-expiry"
                  value={expiryHours}
                  onChange={(event) => setExpiryHours(Number(event.target.value))}
                  disabled={creatingInvite}
                >
                  {EXPIRY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="mini-btn primary"
                onClick={generateInvite}
                disabled={creatingInvite}
              >
                {creatingInvite ? 'Generating…' : 'Generate link'}
              </button>
            </div>

            {invite && (
              <div className="team-invite-result">
                <input
                  className="team-invite-link"
                  type="text"
                  readOnly
                  value={invite.link || invite.acceptPath || ''}
                  aria-label="Invite link"
                  onFocus={(event) => event.target.select()}
                />
                <button type="button" className="mini-btn" onClick={copyInvite}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
            {invite && (
              <p className="team-hint">
                This link is shown once and expires {expiryLabel(invite.expiresAt)}. Share it only
                with the intended person.
              </p>
            )}
            {copyError && <p className="team-hint team-copy-error">{copyError}</p>}
            {!invite && !copyError && (
              <p className="team-hint">
                Anyone with the link can join as {ROLE_LABELS[inviteRole] || inviteRole}. Generating
                a new link does not revoke older ones.
              </p>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
