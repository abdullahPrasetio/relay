import React, { useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { runCollection } from '../lib/runner.js';
import { varsToMap } from '../lib/variables.js';
import { parseDataFile } from '../lib/dataFile.js';

// Runs a collection (or folder) sequentially and shows a live report.
// `send` is the same transport the app uses. Variable mutations persist via
// onPersistScopes after the run completes.
export default function RunnerModal({
  title,
  requests,
  collection,
  environment,
  globals,
  send,
  onClose,
  onPersistScopes,
}) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: requests.length });
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);
  const [delay, setDelay] = useState(0);
  const [iterations, setIterations] = useState(1);
  const [data, setData] = useState(null); // parsed rows
  const [dataName, setDataName] = useState('');
  const [dataError, setDataError] = useState('');
  const dataFileRef = useRef(null);

  const runnable = useMemo(() => requests.filter((r) => (r.url || '').trim()), [requests]);

  function onDataFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseDataFile(reader.result, file.name);
        if (!rows.length) throw new Error('No rows found');
        setData(rows);
        setDataName(`${file.name} (${rows.length} rows)`);
        setDataError('');
      } catch (err) {
        setData(null);
        setDataName('');
        setDataError('Could not parse data file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function clearData() {
    setData(null);
    setDataName('');
    setDataError('');
  }

  // When a data file is loaded, iteration count = rows; otherwise user-set.
  const effectiveIterations = data ? data.length : Math.max(1, Number(iterations) || 1);

  async function run() {
    setRunning(true);
    setDone(false);
    setResults([]);
    setSummary(null);
    setProgress({ current: 0, total: runnable.length });

    const out = await runCollection({
      requests: runnable,
      send,
      environment: varsToMap(environment),
      collection: varsToMap(collection?.variables),
      globals: varsToMap(globals),
      collectionNode: collection,
      delayMs: Number(delay) || 0,
      data,
      iterations: effectiveIterations,
      onProgress: (stepResult, current, total) => {
        setResults((prev) => [...prev, stepResult]);
        setProgress({ current, total });
      },
    });

    setSummary(out.summary);
    setRunning(false);
    setDone(true);
    if (onPersistScopes) onPersistScopes(out.scopes);
  }

  return (
    <Modal title={`Run · ${title}`} onClose={onClose} width={680}>
      <div className="runner-controls">
        <span className="meta">{runnable.length} request(s)</span>
        <label className="runner-delay">
          Iterations
          <input
            type="number"
            min="1"
            value={data ? data.length : iterations}
            onChange={(e) => setIterations(e.target.value)}
            disabled={running || !!data}
            title={data ? 'Driven by the data file' : 'Number of times to run'}
          />
        </label>
        <label className="runner-delay">
          Delay (ms)
          <input
            type="number"
            min="0"
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            disabled={running}
          />
        </label>
        <button className="mini-btn" onClick={() => dataFileRef.current?.click()} disabled={running}>
          Data File…
        </button>
        <input
          ref={dataFileRef}
          type="file"
          accept=".csv,.json,text/csv,application/json"
          style={{ display: 'none' }}
          onChange={onDataFile}
        />
        <button className="send-btn" onClick={run} disabled={running || runnable.length === 0}>
          {running ? `Running ${progress.current}/${progress.total}…` : 'Run'}
        </button>
      </div>

      {(dataName || dataError) && (
        <div className="runner-data-row">
          {dataName && (
            <span className="meta">
              Data: {dataName}{' '}
              <button className="icon-btn" title="Remove data file" onClick={clearData}>
                <Icon name="close" size={13} />
              </button>
            </span>
          )}
          {dataError && <span className="meta" style={{ color: 'var(--red)' }}>{dataError}</span>}
        </div>
      )}

      {summary && (
        <div className="runner-summary">
          {summary.iterations > 1 && (
            <span className="meta">{summary.iterations} iterations</span>
          )}
          <span className="status-pill ok">{summary.requestsOk} ok</span>
          {summary.requestsFailed > 0 && (
            <span className="status-pill error">{summary.requestsFailed} failed</span>
          )}
          <span className={`meta ${summary.testsFailed === 0 ? 'tests-summary all-pass' : 'tests-summary some-fail'}`}>
            Tests: {summary.testsPassed} passed, {summary.testsFailed} failed
          </span>
        </div>
      )}

      <div className="runner-results">
        {results.length === 0 && !running && (
          <div className="response-empty">Click Run to execute the requests in order.</div>
        )}
        {results.map((r) => (
          <div key={r.index} className="runner-step">
            <div className="runner-step-head">
              {r.iteration != null && (
                <span className="iter-badge" title="Iteration">#{r.iteration}</span>
              )}
              <span className={`method-tag method-${r.method}`}>{r.method}</span>
              <span className="runner-step-name">{r.name}</span>
              {r.ok ? (
                <span className={`status-pill ${r.status < 400 ? 'ok' : 'error'}`}>{r.status}</span>
              ) : (
                <span className="status-pill error">ERR</span>
              )}
              <span className="meta">{r.timeMs} ms</span>
            </div>
            {!r.ok && r.error && <div className="runner-step-error">{r.error}</div>}
            {r.tests.length > 0 && (
              <div className="runner-step-tests">
                {r.tests.map((t, i) => (
                  <div key={i} className={`test-result ${t.passed ? 'pass' : 'fail'}`}>
                    <span className="test-icon">{t.passed ? '✓' : '✕'}</span>
                    <span className="test-name">{t.name}</span>
                    {!t.passed && t.error && <span className="test-error">{t.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
