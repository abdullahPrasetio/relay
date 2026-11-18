import React, { useState } from 'react';
import Icon from './Icon.jsx';

// Password input with an explicit reveal toggle. Used by auth and settings
// forms; VarInput has the same behavior for {{variable}} password fields.
export default function PasswordInput({ value, onChange, className = '', ...props }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className="password-input-wrap">
      <input
        {...props}
        type={revealed ? 'text' : 'password'}
        className={`${className} has-reveal`.trim()}
        value={value}
        onChange={onChange}
      />
      <button
        type="button"
        className="var-reveal-btn"
        title={revealed ? 'Hide value' : 'Show value'}
        aria-label={revealed ? 'Hide value' : 'Show value'}
        onClick={() => setRevealed((current) => !current)}
      >
        <Icon name={revealed ? 'eyeOff' : 'eye'} size={14} />
      </button>
    </span>
  );
}
