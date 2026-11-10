import React, { useCallback, useEffect, useState } from 'react';
import CodeEditor from './CodeEditor.jsx';
import Icon from './Icon.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';
import { useDialogs } from './Dialogs.jsx';
import {
  MOCK_CONDITION_OPERATORS,
  MOCK_CONDITION_SOURCES,
  MOCK_LIMITS,
  MOCK_MODES,
  MOCK_RESPONSE_TYPES,
  buildScenarioPayload,
} from '../lib/mockPayload.js';
import {
  headerRows,
  mockErrorText,
  normalizeMockScenarios,
  scenarioSummary,
} from '../lib/mockUi.js';

function newCondition() {
  return { source: 'query', key: '', operator: 'equals', value: '' };
}

function initialForm(scenario) {
  return {
    name: scenario?.name || '',
    statusCode: String(scenario?.statusCode ?? 200),
    responseType: scenario?.responseType || 'text',
    fileName: scenario?.fileName || '',
    fileBase64: scenario?.fileBase64 || '',
    responseBody: scenario?.responseBody || '',
    isDefault: Boolean(scenario?.isDefault),
    orderIndex: String(scenario?.orderIndex ?? 0),
  };
}

function ScenarioForm({ scenario = null, busy = false, onSubmit, onCancel }) {
  const editing = Boolean(scenario?.id);
  const [form, setForm] = useState(() => initialForm(scenario));
  const [headers, setHeaders] = useState(() => headerRows(scenario?.responseHeaders));
  const [conditions, setConditions] = useState(() =>
    Array.isArray(scenario?.conditions) && scenario.conditions.length
      ? scenario.conditions.map((condition) => ({
          source: condition.source || 'query',
          key: condition.key || '',
          operator: condition.operator || 'equals',
          value: condition.value || '',
        }))
      : []
  );
  const [error, setError] = useState('');

  const patch = (next) => setForm((prev) => ({ ...prev, ...next }));

  function updateCondition(index, next) {
    setConditions((prev) => prev.map((condition, i) => (i === index ? { ...condition, ...next } : condition)));
  }

  function removeCondition(index) {
    setConditions((prev) => prev.filter((_, i) => i !== index));
  }

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MOCK_LIMITS.fileBytes) {
      setError(`File exceeds ${MOCK_LIMITS.fileBytes} bytes.`);
      return;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      patch({ fileName: file.name, fileBase64: base64 });
      setError('');
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  function submit(event) {
    event.preventDefault();
    setError('');
    try {
      const payload = buildScenarioPayload({
        ...form,
        statusCode: Number(form.statusCode),
        orderIndex: Number(form.orderIndex),
        responseHeaders: headers,
        conditions,
      });
      onSubmit?.(payload);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  return (
    <form className="mock-form mock-scenario-form" onSubmit={submit} data-testid="mock-scenario-form">
      <div className="mock-form-head">
        <strong>{editing ? `Edit ${scenario.name}` : 'New scenario'}</strong>
        <button type="button" className="mini-btn" onClick={onCancel} disabled={busy}>
          Back
        </button>
      </div>

      <div className="mock-form-grid">
        <div className="form-row">
          <label htmlFor="scenario-name">Name</label>
          <input
            id="scenario-name"
            data-testid="scenario-name"
            value={form.name}
            maxLength={MOCK_LIMITS.scenarioNameLength}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="scenario-status">Status code</label>
          <input
            id="scenario-status"
            data-testid="scenario-status"
            type="number"
            min="100"
            max="599"
            value={form.statusCode}
            onChange={(e) => patch({ statusCode: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="scenario-type">Response</label>
          <select
            id="scenario-type"
            data-testid="scenario-type"
            value={form.responseType}
            onChange={(e) => patch({ responseType: e.target.value })}
          >
            {MOCK_RESPONSE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type === 'file' ? 'File' : 'Text / JSON'}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="scenario-order">Order</label>
          <input
            id="scenario-order"
            type="number"
            min="0"
            max={MOCK_LIMITS.orderIndex}
            value={form.orderIndex}
            onChange={(e) => patch({ orderIndex: e.target.value })}
          />
        </div>
        <label className="mock-inline-check">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => patch({ isDefault: e.target.checked })}
          />
          Default scenario
        </label>
      </div>

      <div className="mock-section">
        <div className="mock-section-title">Conditions</div>
        {conditions.length === 0 ? (
          <div className="auth-hint">No conditions: this scenario only answers when pinned in manual mode.</div>
        ) : (
          <div className="mock-condition-list">
            {conditions.map((condition, index) => (
              <div className="mock-condition-row" key={index}>
                <select
                  value={condition.source}
                  onChange={(e) => updateCondition(index, { source: e.target.value })}
                  aria-label={`Condition ${index + 1} source`}
                >
                  {MOCK_CONDITION_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {source}
                    </option>
                  ))}
                </select>
                <input
                  value={condition.key}
                  placeholder="key / dotted path"
                  onChange={(e) => updateCondition(index, { key: e.target.value })}
                  aria-label={`Condition ${index + 1} key`}
                />
                <select
                  value={condition.operator}
                  onChange={(e) => updateCondition(index, { operator: e.target.value })}
                  aria-label={`Condition ${index + 1} operator`}
                >
                  {MOCK_CONDITION_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </select>
                <input
                  value={condition.value}
                  placeholder="value"
                  disabled={condition.operator === 'exists' || condition.operator === 'not_exists'}
                  onChange={(e) => updateCondition(index, { value: e.target.value })}
                  aria-label={`Condition ${index + 1} value`}
                />
                <button
                  type="button"
                  className="icon-btn"
                  title="Remove condition"
                  onClick={() => removeCondition(index)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="mini-btn"
          disabled={conditions.length >= MOCK_LIMITS.conditions}
          onClick={() => setConditions((prev) => [...prev, newCondition()])}
        >
          Add condition
        </button>
      </div>

      <div className="mock-section">
        <div className="mock-section-title">Response headers</div>
        <KeyValueEditor
          rows={headers}
          onChange={setHeaders}
          keyPlaceholder="Header"
          valuePlaceholder="Value"
        />
      </div>

      <div className="mock-section">
        <div className="mock-section-title">
          {form.responseType === 'file' ? 'Response file' : 'Response body'}
        </div>
        {form.responseType === 'file' ? (
          <div className="mock-file-row">
            <input type="file" onChange={chooseFile} data-testid="scenario-file" />
            <span className="auth-hint">
              {form.fileName
                ? `${form.fileName} (${Math.round((form.fileBase64.length * 3) / 4)} bytes)`
                : `Max ${MOCK_LIMITS.fileBytes} bytes; sent as base64.`}
            </span>
          </div>
        ) : (
          <div className="editor-box" style={{ height: 160 }}>
            <CodeEditor
              value={form.responseBody}
              onChange={(value) => patch({ responseBody: value })}
              language="json"
              height="100%"
            />
          </div>
        )}
      </div>

      {error && <div className="mock-error" role="alert">{error}</div>}

      <div className="mock-form-actions">
        <button type="submit" className="send-btn" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save scenario' : 'Create scenario'}
        </button>
        <button type="button" className="mini-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Scenario list + mode switch for one endpoint. Editing renders the form in
// place so the parent modal stays a single surface.
export default function MockScenarioEditor({ endpoint, api, canEdit = true, onBack, onChanged }) {
  const dialogs = useDialogs();
  const [scenarios, setScenarios] = useState(() =>
    normalizeMockScenarios(endpoint?.scenarios || [])
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(endpoint?.evaluationMode || 'auto');
  const [activeId, setActiveId] = useState(endpoint?.activeScenarioId || '');

  const load = useCallback(async () => {
    if (!api || typeof api.mockScenarios !== 'function') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.mockScenarios(endpoint.id);
      if (!res?.ok) {
        setError(mockErrorText(res, 'Could not load scenarios.'));
      } else {
        setScenarios(normalizeMockScenarios(res.data));
      }
    } catch (err) {
      setError(err?.message || 'Could not load scenarios.');
    } finally {
      setLoading(false);
    }
  }, [api, endpoint.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveMode(next) {
    const nextMode = next.mode ?? mode;
    const nextActive = next.activeId !== undefined ? next.activeId : activeId;
    setBusy(true);
    setError('');
    try {
      const res = await api.updateMock(endpoint.id, {
        evaluationMode: nextMode,
        activeScenarioId: nextMode === 'manual' && nextActive ? nextActive : null,
      });
      if (!res?.ok) {
        setError(mockErrorText(res, 'Could not update the evaluation mode.'));
        return;
      }
      setMode(res.data?.evaluationMode || nextMode);
      setActiveId(res.data?.activeScenarioId || '');
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'Could not update the evaluation mode.');
    } finally {
      setBusy(false);
    }
  }

  async function saveScenario(payload) {
    setBusy(true);
    setError('');
    try {
      const res = editing?.id
        ? await api.updateMockScenario(editing.id, payload)
        : await api.createMockScenario(endpoint.id, payload);
      if (!res?.ok) {
        setError(mockErrorText(res, 'Could not save the scenario.'));
        return;
      }
      setEditing(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'Could not save the scenario.');
    } finally {
      setBusy(false);
    }
  }

  async function removeScenario(scenario) {
    const ok = await dialogs.confirm(`Delete scenario "${scenario.name}"?`, {
      title: 'Delete scenario',
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.deleteMockScenario(scenario.id);
      if (!res?.ok) {
        setError(mockErrorText(res, 'Could not delete the scenario.'));
        return;
      }
      await load();
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'Could not delete the scenario.');
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <ScenarioForm
        scenario={editing.id ? editing : null}
        busy={busy}
        onSubmit={saveScenario}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="mock-scenarios" data-testid="mock-scenarios">
      <div className="mock-form-head">
        <strong>Scenarios · {endpoint.method} {endpoint.path}</strong>
        <button type="button" className="mini-btn" onClick={onBack}>
          Back to mocks
        </button>
      </div>

      <div className="mock-mode-row">
        <label htmlFor="mock-evaluation-mode">Evaluation</label>
        <select
          id="mock-evaluation-mode"
          value={mode}
          disabled={!canEdit || busy}
          onChange={(e) => saveMode({ mode: e.target.value })}
        >
          {MOCK_MODES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {mode === 'manual' && (
          <select
            value={activeId}
            disabled={!canEdit || busy}
            onChange={(e) => saveMode({ activeId: e.target.value })}
            aria-label="Active scenario"
          >
            <option value="">No pinned scenario</option>
            {scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
        )}
        {canEdit && (
          <button type="button" className="mini-btn" onClick={() => setEditing({})}>
            + New scenario
          </button>
        )}
      </div>

      {error && <div className="mock-error" role="alert">{error}</div>}

      {loading ? (
        <div className="team-empty">Loading scenarios…</div>
      ) : scenarios.length === 0 ? (
        <div className="team-empty">No scenarios yet.</div>
      ) : (
        <div className="mock-scenario-list">
          {scenarios.map((scenario) => (
            <div className="mock-scenario" key={scenario.id}>
              <div className="mock-scenario-main">
                <span className="mock-scenario-name">{scenario.name}</span>
                <span className="mock-pill">{scenario.statusCode}</span>
                {scenario.isDefault && <span className="mock-pill default">default</span>}
                <span className="mock-scenario-summary">{scenarioSummary(scenario)}</span>
              </div>
              <div className="mock-scenario-actions">
                {canEdit && (
                  <>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setEditing(scenario)}
                      disabled={busy}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="mini-btn danger"
                      onClick={() => removeScenario(scenario)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
