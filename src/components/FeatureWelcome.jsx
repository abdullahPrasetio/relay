import React from 'react';
import Modal from './Modal.jsx';

export default function FeatureWelcome({ onStart, onSkip }) {
  return (
    <Modal
      title="Welcome to Relay"
      onClose={onSkip}
      width={440}
      footer={
        <>
          <button type="button" className="mini-btn" onClick={onSkip} data-testid="feature-welcome-skip">
            Skip tour
          </button>
          <button type="button" className="send-btn" onClick={onStart} data-testid="feature-welcome-start">
            Start tour
          </button>
        </>
      }
    >
      <div className="feature-welcome" data-testid="feature-welcome">
        <div className="feature-welcome-kicker">A quick tour</div>
        <h2>Get to your first response faster</h2>
        <p>
          A short tour covers the request builder, environments, and the tools in the
          rail. Every tip appears once and can be skipped.
        </p>
        <div className="feature-welcome-list">
          <div><span />Build and send HTTP requests</div>
          <div><span />Keep secrets in environments</div>
          <div><span />Run collections, mocks, and protocols</div>
        </div>
      </div>
    </Modal>
  );
}
