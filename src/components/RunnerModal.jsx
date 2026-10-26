import React, { useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { runCollection } from '../lib/runner.js';
import { varsToMap } from '../lib/variables.js';
import { parseDataFile } from '../lib/dataFile.js';
import { toJsonReport, toJUnit, toHtml, suggestReportName } from '../lib/report.js';

const CONFIG_KEY = 'relay-runner-config';

const DEFAULT_CONFIG = {
  iterations: 1,
  delayMs: 0,
  retries: 0,
  retryDelayMs: 0,
  stopOnError: false,
  saveResponses: false,
  keepVariableValues: true,
  dataFile: '',
};

function loadConfig() {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_CONFIG;
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function downloadBlob(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Runs a collection (or folder) sequentially and shows a live report.
// `send` is the same transport the app uses. Variable mutations persist via
// onPersistScopes after the run completes.
export default function RunnerModal({
  title,
  requests,
  collection,
  chain = null,
  environment,
  globals,
  send,
  onClose,
  onPersistScopes,
}) {
  const initial = useMemo(() => loadConfig(), []);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: requests.length });
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);
  const [runOutput, setRunOutput] = useState(null);
  const [runMeta, setRunMeta] = useState(null);
  const [exportError, setExportError] = useState('');
  const [runError, setRunError] = useState('');
  const [delay, setDelay] = useState(initial.delayMs);
  const [iterations, setIterations] = useState(initial.iterations);
  const [retries, setRetries] = useState(initial.retries);
  const [retryDelay, setRetryDelay] = useState(initial.retryDelayMs);
  const [stopOnError, setStopOnError] = useState(initial.stopOnError === true);
  const [saveResponses, setSaveResponses] = useState(initial.saveResponses === true);
  const [keepVariableValues, setKeepVariableValues] = useState(initial.keepVariableValues !== false);
  const [data, setData] = useState(null); // parsed rows
  const [dataName, setDataName] = useState(initial.dataFile || '');
  const [dataError, setDataError] = useState('');
  const dataFileRef = useRef(null);
  const cancelRef = useRef(false);
  const currentRequestIdRef = useRef(null);

  const runnable = useMemo(() => requests.filter((r) => (r.url || '').trim()), [requests]);

  // Remember the last configuration. Data file *content* is never persisted;
  // only the label/path so the user can pick the same file again.
  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(CONFIG_KEY, JSON.stringify({
        iterations,
        delayMs: delay,
        retries,
        retryDelayMs: retryDelay,
        stopOnError,
        saveResponses,
        keepVariableValues,
        dataFile: dataName,
      }));
    } catch {
      // Storage may be unavailable (private mode); config persistence is optional.
    }
  }, [iterations, delay, retries, retryDelay, stopOnError, saveResponses, keepVariableValues, dataName]);

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

  async function stop() {
    cancelRef.current = true;
    const activeId = currentRequestIdRef.current;
    if (activeId && typeof window !== 'undefined' && window.api?.abortRequest) {
      try {
        await window.api.abortRequest(activeId);
      } catch {
        // The run is already flagged as cancelled; the abort is best-effort.
      }
    }
  }

  async function run() {
    cancelRef.current = false;
    currentRequestIdRef.current = null;
    const startedAt = new Date().toISOString();
    setRunning(true);
    setDone(false);
    setRunError('');
    setExportError('');
    setResults([]);
    setSummary(null);
    setRunOutput(null);
    setRunMeta(null);
    setProgress({ current: 0, total: runnable.length });

    try {
      const out = await runCollection({
        requests: runnable,
        send,
        environment: varsToMap(environment),
        collection: varsToMap(collection?.variables),
        globals: varsToMap(globals),
        collectionNode: collection,
        collectionChain: chain,
        delayMs: Number(delay) || 0,
        data,
        iterations: effectiveIterations,
        retries: Math.max(0, Number(retries) || 0),
        retryDelayMs: Math.max(0, Number(retryDelay) || 0),
        stopOnError,
        saveResponses,
        keepVariableValues,
        shouldStop: () => cancelRef.current,
        onRequestId: (id) => {
          currentRequestIdRef.current = id;
        },
        onProgress: (stepResult, current, total) => {
          setResults((prev) => [...prev, stepResult]);
          setProgress({ current, total });
        },
      });

      const finishedAt = new Date().toISOString();
      setSummary(out.summary);
      setRunOutput(out);
      setRunMeta({ name: title, startedAt, finishedAt });
      if (onPersistScopes) onPersistScopes(out.scopes);
    } catch (err) {
      setRunError(err?.message || String(err));
    } finally {
      setRunning(false);
      setDone(true);
    }
  }

  async function exportReport(format) {
    if (!runOutput) return;
    const meta = runMeta || {
      name: title,
      startedAt: null,
      finishedAt: new Date().toISOString(),
    };
    let text;
    let mime;
    if (format === 'json') {
      text = JSON.stringify(toJsonReport(runOutput, meta), null, 2);
      mime = 'application/json';
    } else if (format === 'junit') {
      text = toJUnit(runOutput, meta);
      mime = 'application/xml';
    } else {
      text = toHtml(runOutput, meta);
      mime = 'text/html';
    }
    const suggestedName = suggestReportName(meta, format);
    setExportError('');

    if (typeof window !== 'undefined' && window.api?.saveResponse) {
      try {
        const res = await window.api.saveResponse({ suggestedName, text });
        if (res?.error) setExportError(res.error);
      } catch (err) {
        setExportError(err?.message || String(err));
      }
      return;
    }

    downloadBlob(suggestedName, text, mime);
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
        {running && (
          <button
            className="mini-btn runner-stop-btn"
            onClick={stop}
            data-testid="runner-stop"
            title="Stop the run"
          >
            Stop
          </button>
        )}
      </div>

      <div className="runner-options">
        <label className="runner-delay">
          Retries
          <input
            type="number"
            min="0"
            value={retries}
            onChange={(e) => setRetries(e.target.value)}
            disabled={running}
            data-testid="runner-retries"
            title="Extra attempts for failed or 5xx requests"
          />
        </label>
        <label className="runner-delay">
          Retry delay (ms)
          <input
            type="number"
            min="0"
            value={retryDelay}
            onChange={(e) => setRetryDelay(e.target.value)}
            disabled={running}
            data-testid="runner-retry-delay"
          />
        </label>
        <label className="runner-check">
          <input
            type="checkbox"
            checked={stopOnError}
            onChange={(e) => setStopOnError(e.target.checked)}
            disabled={running}
            data-testid="runner-stop-on-error"
          />
          Stop on error
        </label>
        <label className="runner-check">
          <input
            type="checkbox"
            checked={saveResponses}
            onChange={(e) => setSaveResponses(e.target.checked)}
            disabled={running}
            data-testid="runner-save-responses"
          />
          Save responses
        </label>
        <label className="runner-check">
          <input
            type="checkbox"
            checked={keepVariableValues}
            onChange={(e) => setKeepVariableValues(e.target.checked)}
            disabled={running}
            data-testid="runner-keep-variables"
          />
          Keep variable values
        </label>
      </div>

      {(dataName || dataError) && (
        <div className="runner-data-row">
          {dataName && (
            <span className="meta">
              Data: {dataName}{' '}
              {!data && <span className="runner-data-hint">(select the file again to load rows)</span>}
              <button className="icon-btn" title="Remove data file" onClick={clearData}>
                <Icon name="close" size={13} />
              </button>
            </span>
          )}
          {dataError && <span className="meta" style={{ color: 'var(--red)' }}>{dataError}</span>}
        </div>
      )}

      {runError && <div className="runner-step-error">{runError}</div>}

      {summary && (
        <div className="runner-summary">
          {summary.iterations > 1 && (
            <span className="meta">{summary.iterations} iterations</span>
          )}
          <span className="status-pill ok">{summary.requestsOk} ok</span>
          {summary.requestsFailed > 0 && (
            <span className="status-pill error">{summary.requestsFailed} failed</span>
          )}
          {summary.requestsSkipped > 0 && (
            <span className="status-pill skip">{summary.requestsSkipped} skipped</span>
          )}
          {summary.retriedRequests > 0 && (
            <span className="meta">{summary.retriedRequests} retried</span>
          )}
          {(summary.aborted || summary.stoppedReason) && (
            <span className={`status-pill ${summary.aborted ? 'warn' : 'error'}`}>
              {summary.aborted
                ? `Aborted at step ${summary.stoppedAtStep ?? '?'}`
                : 'Stopped on error'}
            </span>
          )}
          <span className={`meta ${summary.testsFailed === 0 ? 'tests-summary all-pass' : 'tests-summary some-fail'}`}>
            Tests: {summary.testsPassed} passed, {summary.testsFailed} failed
          </span>
        </div>
      )}

      {done && runOutput && (
        <div className="runner-export">
          <span className="meta">Export:</span>
          <button className="mini-btn" onClick={() => exportReport('json')} data-testid="runner-export-json">
            JSON
          </button>
          <button className="mini-btn" onClick={() => exportReport('junit')} data-testid="runner-export-junit">
            JUnit
          </button>
          <button className="mini-btn" onClick={() => exportReport('html')} data-testid="runner-export-html">
            HTML
          </button>
          {exportError && <span className="runner-export-error">{exportError}</span>}
        </div>
      )}

      <div className="runner-results">
        {results.length === 0 && !running && (
          <div className="response-empty">Click Run to execute the requests in order.</div>
        )}
        {results.map((r) => (
          <div key={r.index} className={`runner-step${r.skipped ? ' is-skipped' : ''}`}>
            <div className="runner-step-head">
              {r.iteration != null && (
                <span className="iter-badge" title="Iteration">#{r.iteration}</span>
              )}
              <span className={`method-tag method-${r.method}`}>{r.method}</span>
              <span className="runner-step-name">{r.name}</span>
              {r.skipped ? (
                <span className="status-pill skip">SKIP</span>
              ) : r.ok ? (
                <span className={`status-pill ${r.status < 400 ? 'ok' : 'error'}`}>{r.status}</span>
              ) : (
                <span className="status-pill error">ERR</span>
              )}
              {r.attempts > 1 && (
                <span className="meta runner-attempts" title={`Attempts: ${r.attempts}`}>
                  ↻ {r.attempts} attempts
                </span>
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
