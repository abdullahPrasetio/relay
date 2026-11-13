import React from 'react';
import Modal from './Modal.jsx';

export default function WhatsNewModal({ version, features, onShow, onDismiss }) {
  return (
    <Modal
      title={`What's new in Relay${version ? ` ${version}` : ''}`}
      onClose={onDismiss}
      width={560}
      footer={
        <button type="button" className="send-btn" onClick={onDismiss} data-testid="whats-new-dismiss">
          Got it
        </button>
      }
    >
      <div className="whats-new" data-testid="whats-new">
        <p className="auth-hint">
          New features are listed once. Open one to see where it lives.
        </p>
        <div className="whats-new-list">
          {features.map((feature) => (
            <div className="whats-new-row" key={feature.id}>
              <div className="whats-new-copy">
                <span className="whats-new-group">{feature.group}</span>
                <strong>{feature.title}</strong>
                <p>{feature.body}</p>
              </div>
              <button
                type="button"
                className="mini-btn"
                onClick={() => onShow(feature)}
                data-testid={`whats-new-show-${feature.id}`}
              >
                Show me
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
