import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { useDialogs } from './Dialogs.jsx';
import {
  formatDateTime,
  formatDeviceActivity,
  normalizeDevices,
  shortId,
} from '../lib/deviceUi.js';

function errorMessage(res, fallback) {
  return res?.error?.message || fallback;
}

// Active Relay Cloud sessions for the signed-in user. Revoking a device drops
// its refresh token server-side, so that machine has to sign in again.
export default function CloudDevicesModal({ onClose, cloudBridge = null }) {
  const api = useMemo(
    () => cloudBridge || (typeof window !== 'undefined' ? window.api?.cloud : null),
    [cloudBridge]
  );
  const dialogs = useDialogs();

  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingId, setPendingId] = useState(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!api || typeof api.devices !== 'function') {
      setDevices([]);
      setLoading(false);
      setError('Device management requires the Relay desktop app.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.devices();
      if (seq !== requestSeq.current) return;
      if (!res?.ok) {
        setDevices([]);
        setError(errorMessage(res, 'Could not load your devices.'));
        return;
      }
      setDevices(normalizeDevices(res.data));
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setDevices([]);
      setError(err?.message || 'Could not load your devices.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
    return () => {
      requestSeq.current += 1;
    };
  }, [load]);

  async function revoke(device) {
    if (pendingId) return;
    const allow = await dialogs.confirm(
      `Revoke “${device.deviceLabel}”? That device is signed out immediately and must sign in again.`,
      { title: 'Revoke device', okLabel: 'Revoke', danger: true }
    );
    if (!allow) return;
    if (!api || typeof api.revokeDevice !== 'function') {
      setError('Device management requires the Relay desktop app.');
      return;
    }
    setPendingId(device.id);
    setError('');
    try {
      // The preload bridge takes a payload object; older bridges accepted the
      // bare id, so both shapes are forwarded.
      const res = await api.revokeDevice({ id: device.id });
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not revoke that device.'));
        return;
      }
      setDevices((previous) => previous.filter((entry) => entry.id !== device.id));
    } catch (err) {
      setError(err?.message || 'Could not revoke that device.');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Modal
      title="Devices"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="mini-btn" onClick={load} disabled={loading || !!pendingId}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="cloud-devices" data-testid="cloud-devices-modal">
        {error && (
          <div className="cloud-error" role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <div className="team-empty">Loading devices…</div>
        ) : devices.length === 0 ? (
          <div className="team-empty">
            {error ? 'No devices to show.' : 'No active devices. Sign in on another machine to see it here.'}
          </div>
        ) : (
          <ul className="device-list">
            {devices.map((device) => (
              <li key={device.id} className="device-row" data-testid="cloud-device-row">
                <div className="device-main">
                  <span className="device-label" title={device.deviceLabel}>
                    {device.deviceLabel}
                  </span>
                  <span className="device-meta">
                    <code title={device.id}>{shortId(device.id)}</code>
                    <span>{formatDeviceActivity(device)}</span>
                    {device.expiresAt ? (
                      <span title={`Session expires ${formatDateTime(device.expiresAt)}`}>
                        expires {formatDateTime(device.expiresAt)}
                      </span>
                    ) : null}
                  </span>
                </div>
                <button
                  type="button"
                  className="mini-btn danger"
                  onClick={() => revoke(device)}
                  disabled={!!pendingId}
                >
                  {pendingId === device.id ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
