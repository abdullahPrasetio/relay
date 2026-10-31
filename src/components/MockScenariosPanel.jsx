import React, { useEffect, useMemo, useState } from 'react';
import KeyValueEditor from './KeyValueEditor.jsx';
import Icon from './Icon.jsx';
import { uid } from '../lib/factory.js';
import {
  MOCK_OPERATORS,
  MOCK_SOURCES,
  normalizeMockConfig,
} from '../../shared/mockScenarios.js';

function scenarioDefaults(index) {
  return {
    id: uid('scn'),
    name: `Scenario ${index + 1}`,
    enabled: true,
    status: 200,
    statusText: 'OK',
    headers: [],
    body: '{\n  "ok": true\n}',
    contentType: 'application/json',
    delayMs: 0,
    isDefault: index === 0,
    conditions: [],
  };
}

// Per-request mock scenarios. The running server is updated by the Mock
// Server modal's "Reload routes" button; this tab only edits persisted config.
export default function MockScenariosPanel({ request, patch }) {
  const config = useMemo(() => normalizeMockConfig(request?.mock), [request?.mock]);
  const [selectedId, setSelectedId] = useState(config.scenarios[0]?.id || '');
  const selectedIndex = config.scenarios.findIndex((s) => s.id === selectedId);
  const selected = selectedIndex >= 0 ? config.scenarios[selectedIndex] : null;

  useEffect(() => {
    if (selectedId && config.scenarios.some((s) => s.id === selectedId)) return;
    setSelectedId(config.scenarios[0]?.id || '');
  }, [config.scenarios, selectedId]);

  const save = (next) => patch({ mock: normalizeMockConfig(next) });
  const setConfig = (p) => save({ ...config, ...p });

  function updateScenario(index, p) {
    const scenarios = config.scenarios.map((s, i) => (i === index ? { ...s, ...p } : s));
    save({ ...config, scenarios });
  }

  function addScenario() {
    const scenario = scenarioDefaults(config.scenarios.length);
    save({
      ...config,
      scenarios: [...config.scenarios, scenario],
      // Adding a second scenario should not silently change the default.
      activeScenarioId: config.activeScenarioId,
    });
    setSelectedId(scenario.id);
  }

  function removeScenario(id) {
    const scenarios = config.scenarios.filter((s) => s.id !== id);
    save({
      ...config,
      scenarios,
      activeScenarioId: config.activeScenarioId === id ? null : config.activeScenarioId,
    });
    if (selectedId === id) setSelectedId(scenarios[0]?.id || '');
  }

  function makeDefault(index) {
    const scenarios = config.scenarios.map((s, i) => ({ ...s, isDefault: i === index }));
    save({ ...config, scenarios });
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= config.scenarios.length) return;
    const scenarios = [...config.scenarios];
    [scenarios[index], scenarios[target]] = [scenarios[target], scenarios[index]];
    save({ ...config, scenarios });
  }

  function updateCondition(index, patchCondition) {
    const conditions = selected.conditions.map((c, i) =>
      i === index ? { ...c, ...patchCondition } : c
    );
    updateScenario(selectedIndex, { conditions });
  }

  if (!config.scenarios.length) {
    return (
      <div className="mock-scenario-empty">
        <p className="auth-hint">
          No scenarios yet. Requests without scenarios still serve their newest saved
          example; add a scenario to control status, body, headers and matching.
        </p>
        <button className="mini-btn" data-testid="mock-add-scenario" onClick={addScenario}>
          + Add scenario
        </button>
        <label className="settings-check" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            data-testid="mock-expose"
            checked={config.enabled}
            onChange={(e) => setConfig({ enabled: e.target.checked })}
          />
          Expose this request in the mock server
        </label>
      </div>
    );
  }

  return (
    <div className="mock-scenario-panel">
      <div className="mock-scenario-toolbar">
        <label className="settings-check">
          <input
            type="checkbox"
            data-testid="mock-expose"
            checked={config.enabled}
            onChange={(e) => setConfig({ enabled: e.target.checked })}
          />
          Expose in mock server
        </label>
        <label>
          Mode{' '}
          <select
            data-testid="mock-mode"
            value={config.mode}
            onChange={(e) => setConfig({ mode: e.target.value })}
          >
            <option value="auto">Auto (conditions)</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        {config.mode === 'manual' && (
          <label>
            Active{' '}
            <select
              data-testid="mock-active-scenario"
              value={config.activeScenarioId || ''}
              onChange={(e) => setConfig({ activeScenarioId: e.target.value || null })}
            >
              <option value="">Default / fallback</option>
              {config.scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mock-scenario-layout">
        <div className="mock-scenario-list">
          {config.scenarios.map((scenario, index) => (
            <div
              key={scenario.id}
              className={`mock-scenario-item ${scenario.id === selectedId ? 'active' : ''}`}
              data-testid={`mock-scenario-${scenario.id}`}
            >
              <button className="mock-scenario-select" onClick={() => setSelectedId(scenario.id)}>
                <span className="mock-scenario-name">{scenario.name}</span>
                <span className="badge">{scenario.status}</span>
                {scenario.isDefault && <span className="mock-default">default</span>}
              </button>
              <span className="mock-scenario-actions">
                <button
                  className="icon-btn"
                  title="Move up"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                >
                  <Icon name="chevronUp" size={12} />
                </button>
                <button
                  className="icon-btn"
                  title="Move down"
                  onClick={() => move(index, 1)}
                  disabled={index === config.scenarios.length - 1}
                >
                  <Icon name="chevronDown" size={12} />
                </button>
                <button
                  className="icon-btn"
                  title="Delete scenario"
                  onClick={() => removeScenario(scenario.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            </div>
          ))}
          <button className="mini-btn" data-testid="mock-add-scenario" onClick={addScenario}>
            + Add scenario
          </button>
        </div>

        {selected && (
          <div className="mock-scenario-editor">
            <div className="mock-fields">
              <div className="form-row">
                <label>Name</label>
                <input
                  data-testid="mock-scenario-name"
                  value={selected.name}
                  onChange={(e) => updateScenario(selectedIndex, { name: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Status</label>
                <input
                  data-testid="mock-scenario-status"
                  type="number"
                  min="100"
                  max="599"
                  value={selected.status}
                  onChange={(e) =>
                    updateScenario(selectedIndex, { status: Number(e.target.value) })
                  }
                />
              </div>
              <div className="form-row">
                <label>Content-Type</label>
                <input
                  value={selected.contentType}
                  onChange={(e) => updateScenario(selectedIndex, { contentType: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Delay (ms)</label>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  value={selected.delayMs}
                  onChange={(e) =>
                    updateScenario(selectedIndex, { delayMs: Number(e.target.value) })
                  }
                />
              </div>
            </div>

            <label className="settings-check">
              <input
                type="checkbox"
                checked={selected.enabled}
                onChange={(e) => updateScenario(selectedIndex, { enabled: e.target.checked })}
              />
              Enabled
            </label>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={selected.isDefault}
                onChange={(e) =>
                  e.target.checked
                    ? makeDefault(selectedIndex)
                    : updateScenario(selectedIndex, { isDefault: false })
                }
              />
              Default fallback
            </label>

            <div className="form-row">
              <label>Response body</label>
              <textarea
                data-testid="mock-scenario-body"
                className="body-text"
                style={{ minHeight: 120, fontFamily: 'ui-monospace, monospace' }}
                value={selected.body}
                onChange={(e) => updateScenario(selectedIndex, { body: e.target.value })}
                spellCheck={false}
              />
              <p className="auth-hint">
                Templates: <code>{'{{request.query.x}}'}</code>,{' '}
                <code>{'{{request.header.x}}'}</code>, <code>{'{{request.body.x.y}}'}</code>,{' '}
                <code>{'{{request.path.id}}'}</code>. Workspace secrets are never resolved.
              </p>
            </div>

            <div className="form-row">
              <label>Headers</label>
              <KeyValueEditor
                rows={selected.headers}
                onChange={(headers) => updateScenario(selectedIndex, { headers })}
                keyPlaceholder="Header"
                valuePlaceholder="Value"
              />
            </div>

            <div className="form-row">
              <label>Conditions (all must match)</label>
              {selected.conditions.length === 0 && (
                <p className="auth-hint">
                  No conditions: this scenario never matches in Auto mode; use it as the
                  default or select it in Manual mode.
                </p>
              )}
              {selected.conditions.map((condition, index) => (
                <div className="mock-condition-row" key={index}>
                  <select
                    data-testid={`mock-condition-source-${index}`}
                    value={condition.source}
                    onChange={(e) => updateCondition(index, { source: e.target.value })}
                  >
                    {MOCK_SOURCES.map((source) => (
                      <option key={source} value={source}>
                        {source}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="key"
                    value={condition.key}
                    onChange={(e) => updateCondition(index, { key: e.target.value })}
                  />
                  <select
                    value={condition.operator}
                    onChange={(e) => updateCondition(index, { operator: e.target.value })}
                  >
                    {MOCK_OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {operator}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="value"
                    value={condition.value}
                    disabled={
                      condition.operator === 'exists' || condition.operator === 'not_exists'
                    }
                    onChange={(e) => updateCondition(index, { value: e.target.value })}
                  />
                  <button
                    className="icon-btn"
                    title="Remove condition"
                    onClick={() =>
                      updateScenario(selectedIndex, {
                        conditions: selected.conditions.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
              <button
                className="mini-btn"
                data-testid="mock-add-condition"
                onClick={() =>
                  updateScenario(selectedIndex, {
                    conditions: [
                      ...selected.conditions,
                      {
                        source: 'query',
                        key: '',
                        operator: 'equals',
                        value: '',
                        enabled: true,
                      },
                    ],
                  })
                }
              >
                + Add condition
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
