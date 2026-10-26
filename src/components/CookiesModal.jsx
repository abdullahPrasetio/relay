import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';

// Shows the persistent cookie jar (cookies auto-stored from responses and
// auto-sent on matching requests), with a clear-all action.
export default function CookiesModal({ onClose }) {
  const [cookies, setCookies] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const hasBridge = typeof window !== 'undefined' && !!window.api?.getCookies;

  useEffect(() => {
    let mounted = true;
    if (hasBridge) {
      window.api.getCookies().then((c) => {
        if (mounted) {
          setCookies(c || []);
          setLoaded(true);
        }
      });
    } else {
      setLoaded(true);
    }
    return () => {
      mounted = false;
    };
  }, [hasBridge]);

  async function clearAll() {
    if (!hasBridge) return;
    await window.api.clearCookies();
    setCookies([]);
  }

  return (
    <Modal
      title="Cookies"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="mini-btn" onClick={onClose}>
            Close
          </button>
          <button
            className="send-btn"
            style={{ background: 'var(--red)' }}
            onClick={clearAll}
            disabled={cookies.length === 0}
          >
            Clear All
          </button>
        </>
      }
    >
      {!loaded && <div className="response-empty">Loading…</div>}
      {loaded && cookies.length === 0 && (
        <div className="response-empty">
          No cookies stored. Cookies set by responses are saved here and sent
          automatically on matching requests.
        </div>
      )}
      {loaded && cookies.length > 0 && (
        <table className="kv readonly">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Name</th>
              <th>Value</th>
              <th>Path</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {cookies.map((c, i) => (
              <tr key={i}>
                <td>{c.domain}</td>
                <td className="h-key">{c.name}</td>
                <td className="h-val">{c.value}</td>
                <td>{c.path}</td>
                <td>
                  {c.secure ? 'Secure ' : ''}
                  {c.httpOnly ? 'HttpOnly ' : ''}
                  {c.expires ? new Date(c.expires).toLocaleString() : 'session'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
