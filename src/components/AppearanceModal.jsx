import React from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { ACCENTS, MODES } from '../lib/theme.js';

const MODE_ICONS = { system: 'monitor', light: 'sun', dark: 'moon' };

// Postman-style appearance settings: theme mode (system/light/dark) and accent
// color. Colors are defined in styles.css per accent id; the swatch element
// carries the same data-accent attribute, so it previews the real palette.
export default function AppearanceModal({ appearance, onChange, onClose }) {
  return (
    <Modal title="Appearance" onClose={onClose} width={480}>
      <div className="appearance-section">
        <div className="appearance-label">Theme</div>
        <div className="appearance-modes" role="group" aria-label="Theme mode">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`appearance-mode ${appearance.mode === mode.id ? 'active' : ''}`}
              onClick={() => onChange({ mode: mode.id })}
              data-testid={`appearance-mode-${mode.id}`}
              aria-pressed={appearance.mode === mode.id}
            >
              <Icon name={MODE_ICONS[mode.id]} size={15} />
              <span>{mode.label}</span>
            </button>
          ))}
        </div>
        <div className="appearance-hint">System follows the operating system setting.</div>
      </div>

      <div className="appearance-section">
        <div className="appearance-label">Accent color</div>
        <div className="appearance-accents">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              className={`appearance-accent ${appearance.accent === accent.id ? 'active' : ''}`}
              onClick={() => onChange({ accent: accent.id })}
              data-testid={`appearance-accent-${accent.id}`}
              aria-pressed={appearance.accent === accent.id}
              title={accent.label}
            >
              <span className="appearance-swatch" data-accent={accent.id} aria-hidden="true" />
              <span className="appearance-accent-label">{accent.label}</span>
              {appearance.accent === accent.id && (
                <span className="appearance-check" aria-hidden="true">
                  <Icon name="check" size={12} />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-preview" aria-hidden="true">
        <span className="appearance-preview-btn">Send</span>
        <span className="appearance-preview-pill">200 OK</span>
        <span className="appearance-preview-link">developer</span>
      </div>
    </Modal>
  );
}
