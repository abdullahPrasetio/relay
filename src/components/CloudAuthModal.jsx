import React, { useState } from 'react';
import Modal from './Modal.jsx';

const TABS = [
  { id: 'login', label: 'Sign in' },
  { id: 'register', label: 'Create account' },
];

// Relay Cloud authentication. The modal owns only form state; credentials go
// straight to the injected sign-in/sign-up handlers (which talk to the main
// process) so no token ever reaches renderer storage.
export default function CloudAuthModal({ onClose, onSignIn, onSignUp }) {
  const [tab, setTab] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('Relay desktop');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const registering = tab === 'register';

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const action = registering ? onSignUp : onSignIn;
      const payload = registering
        ? { name: name.trim(), email: email.trim(), password, deviceLabel: deviceLabel.trim() }
        : { email: email.trim(), password, deviceLabel: deviceLabel.trim() };
      const res = await action(payload);
      if (res?.ok) {
        onClose();
        return;
      }
      setError(res?.error?.message || (registering ? 'Could not create the account.' : 'Sign in failed.'));
    } catch (err) {
      setError(err?.message || 'Cloud request failed.');
    } finally {
      setSubmitting(false);
    }
  }

  const footer = (
    <>
      <button type="button" className="mini-btn" onClick={onClose} disabled={submitting}>
        Cancel
      </button>
      <button type="submit" form="cloud-auth-form" className="mini-btn primary" disabled={submitting}>
        {submitting ? 'Working…' : registering ? 'Create account' : 'Sign in'}
      </button>
    </>
  );

  return (
    <Modal title="Relay Cloud" onClose={onClose} footer={footer} width={420}>
      <div className="cloud-auth-tabs" role="tablist" aria-label="Cloud authentication">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`cloud-auth-tab ${tab === entry.id ? 'active' : ''}`}
            onClick={() => {
              setTab(entry.id);
              setError('');
            }}
            data-testid={`cloud-tab-${entry.id}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <form id="cloud-auth-form" onSubmit={submit}>
        {registering && (
          <div className="form-row">
            <label htmlFor="cloud-name">Name</label>
            <input
              id="cloud-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
              autoComplete="name"
              required
            />
          </div>
        )}
        <div className="form-row">
          <label htmlFor="cloud-email">Email</label>
          <input
            id="cloud-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
            autoFocus
          />
        </div>
        <div className="form-row">
          <label htmlFor="cloud-password">Password</label>
          <input
            id="cloud-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={registering ? 'new-password' : 'current-password'}
            required
          />
        </div>
        <div className="form-row">
          <label htmlFor="cloud-device">Device label</label>
          <input
            id="cloud-device"
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value)}
            placeholder="Relay desktop"
          />
        </div>

        {error && (
          <div className="cloud-error" role="alert" data-testid="cloud-auth-error">
            {error}
          </div>
        )}
      </form>

      <p className="cloud-auth-hint">
        Sessions are stored by the desktop app; syncing is unavailable in the browser preview.
      </p>
    </Modal>
  );
}
