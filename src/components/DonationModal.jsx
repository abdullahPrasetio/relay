import React from 'react';
import Modal from './Modal.jsx';
import qris from '../assets/qris.jpeg';

// Static QRIS donation code. The image is the owner's payment code, so it is
// bundled with the app instead of being fetched from a remote service.
export default function DonationModal({ onClose }) {
  const bridge = typeof window !== 'undefined' ? window.api : null;
  const open = (url) => bridge?.openExternal?.(url);

  return (
    <Modal
      title="Support Relay"
      onClose={onClose}
      width={420}
      footer={
        <button className="mini-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="donation-body">
        <p>
          Relay stays free and open source. If it saves you time, you can support its
          development by scanning the QRIS code below.
        </p>
        <div className="donation-qr">
          <img src={qris} alt="QRIS donation code" data-testid="donation-qr" />
        </div>
        <p className="auth-hint">
          Scan with any QRIS-enabled banking or e-wallet app. The amount is up to you.
        </p>
        <p className="auth-hint donation-links">
          Support:{' '}
          <a
            href="mailto:temancode@gmail.com"
            onClick={(e) => {
              e.preventDefault();
              open('mailto:temancode@gmail.com');
            }}
          >
            temancode@gmail.com
          </a>
          {' · '}
          <a
            href="https://github.com/abdullahPrasetio"
            onClick={(e) => {
              e.preventDefault();
              open('https://github.com/abdullahPrasetio');
            }}
          >
            github.com/abdullahPrasetio
          </a>
        </p>
      </div>
    </Modal>
  );
}
