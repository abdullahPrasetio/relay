import React from 'react';
import {
  SECTION_LABELS,
  VALIDATION_RULES,
  VALIDATION_SECTIONS,
  collectValidationFields,
  countValidatedFields,
  hasValidation,
  normalizeFieldValidations,
  validationTokens,
} from '../lib/fieldValidations.js';

// Documentation metadata editor: the request description plus per-field
// validation rules shown in the exported HTML and Confluence docs. Nothing
// here changes how the request is sent or how the mock matches scenarios.
export default function RequestDocsPanel({ request, patch }) {
  const fields = collectValidationFields(request);
  const validations = normalizeFieldValidations(request?.fieldValidations);
  const documented = countValidatedFields(validations);

  function updateRule(section, key, nextRule) {
    const next = normalizeFieldValidations({
      ...validations,
      [section]: { ...validations[section], [key]: nextRule },
    });
    patch({ fieldValidations: next });
  }

  function clearRule(section, key) {
    const sectionRules = { ...validations[section] };
    delete sectionRules[key];
    patch({
      fieldValidations: normalizeFieldValidations({
        ...validations,
        [section]: sectionRules,
      }),
    });
  }

  const missing = VALIDATION_SECTIONS.every((section) => fields[section].length === 0);

  return (
    <div className="request-docs-panel" data-testid="request-docs-panel">
      <div className="form-row">
        <label htmlFor="request-description">Description</label>
        <textarea
          id="request-description"
          data-testid="request-description"
          className="docs-description-input"
          rows={4}
          value={request.description || ''}
          placeholder="What this request does, auth requirements, side effects..."
          onChange={(e) => patch({ description: e.target.value })}
        />
        <p className="auth-hint">
          Rendered by <strong>Export docs (HTML)</strong> and Confluence publishing.
        </p>
      </div>

      <div className="docs-section-head">
        <div>
          <div className="sent-section-title">Field validation</div>
          <p className="auth-hint">
            Documentation only. Mock scenarios keep using their conditions for request matching.
          </p>
        </div>
        <span className="badge" data-testid="validation-count">
          {documented} documented
        </span>
      </div>

      {missing ? (
        <div className="docs-empty">
          Add query params, path variables, headers, or a JSON/form body to document
          individual fields.
        </div>
      ) : (
        VALIDATION_SECTIONS.map((section) => {
          const list = fields[section];
          if (!list.length) return null;
          return (
            <section className="validation-group" key={section}>
              <h4>
                {SECTION_LABELS[section]} <span className="badge">{list.length}</span>
              </h4>
              <div className="validation-fields">
                {list.map((field) => (
                  <ValidationField
                    key={`${section}:${field.key}`}
                    section={section}
                    field={field}
                    rule={validations[section][field.key]}
                    onChange={(rule) => updateRule(section, field.key, rule)}
                    onClear={() => clearRule(section, field.key)}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function ValidationField({ section, field, rule, onChange, onClear }) {
  const current = rule || { rules: [], min: 0, max: 0, description: '' };
  const tokens = validationTokens(current);
  const slug = field.key.replace(/[^a-zA-Z0-9_-]+/g, '_');
  // Imported custom rules (for example "max:100") stay visible and removable.
  const customRules = current.rules.filter((value) => !VALIDATION_RULES.includes(value));
  const ruleOptions = [...VALIDATION_RULES, ...customRules];

  function toggle(ruleName) {
    const rules = current.rules.includes(ruleName)
      ? current.rules.filter((value) => value !== ruleName)
      : [...current.rules, ruleName];
    onChange({ ...current, rules });
  }

  return (
    <div
      className={`validation-field ${hasValidation(current) ? 'documented' : ''}`}
      data-testid={`validation-field-${section}-${slug}`}
    >
      <div className="validation-field-head">
        <span className="validation-section-tag">{SECTION_LABELS[section]}</span>
        <code className="validation-key">{field.key}</code>
        <span className="validation-example" title={field.value}>
          {field.value || '—'}
        </span>
        {tokens.length > 0 && (
          <span className="validation-tokens">
            {tokens.map((token) => (
              <span className="validation-token" key={token}>
                {token}
              </span>
            ))}
          </span>
        )}
        {hasValidation(current) && (
          <button
            type="button"
            className="mini-btn validation-clear"
            onClick={onClear}
            data-testid={`validation-clear-${section}-${slug}`}
          >
            Clear
          </button>
        )}
      </div>

      <div className="validation-rule-buttons" role="group" aria-label={`Rules for ${field.key}`}>
        {ruleOptions.map((ruleName) => (
          <button
            type="button"
            key={ruleName}
            className={`validation-rule ${current.rules.includes(ruleName) ? 'active' : ''}`}
            aria-pressed={current.rules.includes(ruleName)}
            data-rule={ruleName}
            onClick={() => toggle(ruleName)}
          >
            {ruleName}
          </button>
        ))}
      </div>

      <div className="validation-meta">
        <label>
          Min
          <input
            type="number"
            min="0"
            value={current.min || 0}
            onChange={(e) => onChange({ ...current, min: Number(e.target.value) || 0 })}
          />
        </label>
        <label>
          Max
          <input
            type="number"
            min="0"
            value={current.max || 0}
            onChange={(e) => onChange({ ...current, max: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="validation-description">
          Description
          <input
            type="text"
            value={current.description}
            placeholder="Optional description or custom error message"
            onChange={(e) => onChange({ ...current, description: e.target.value })}
          />
        </label>
      </div>
    </div>
  );
}
