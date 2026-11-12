import React, { useMemo, useState } from 'react';
import { diffLines, prettyForDiff } from '../lib/textDiff.js';

export default function ResponseDiff({ response, examples = [] }) {
  const candidates = useMemo(
    () => examples.filter((example) => typeof example?.response?.body === 'string'),
    [examples]
  );
  const [selectedId, setSelectedId] = useState(
    () => candidates[candidates.length - 1]?.id || ''
  );
  const selected =
    candidates.find((example) => example.id === selectedId) ||
    candidates[candidates.length - 1] ||
    null;

  const ops = useMemo(() => {
    if (!selected || !response) return [];
    return diffLines(
      prettyForDiff(selected.response.body),
      prettyForDiff(response.body)
    );
  }, [selected, response]);

  if (!candidates.length) {
    return <div className="diff-empty">Save a response as an example to compare it here.</div>;
  }

  let beforeLine = 0;
  let afterLine = 0;
  const adds = ops.filter((op) => op.type === 'add').length;
  const removes = ops.filter((op) => op.type === 'remove').length;

  return (
    <div className="response-diff" data-testid="response-diff">
      <div className="diff-toolbar">
        <select
          aria-label="Compare with example"
          value={selected?.id || ''}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {candidates.map((example) => (
            <option key={example.id} value={example.id}>
              {example.name || 'Example'}
            </option>
          ))}
        </select>
        <span className="diff-summary">
          <span className="diff-add-count">+{adds}</span>
          <span className="diff-remove-count">-{removes}</span>
        </span>
      </div>
      <div className="diff-body">
        {ops.map((op, index) => {
          if (op.type !== 'add') beforeLine += 1;
          if (op.type !== 'remove') afterLine += 1;
          return (
            <div key={index} className={`diff-line ${op.type}`}>
              <span className="diff-num">{op.type === 'add' ? '' : beforeLine}</span>
              <span className="diff-num">{op.type === 'remove' ? '' : afterLine}</span>
              <span className="diff-sign">
                {op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' '}
              </span>
              <span className="diff-text">{op.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
