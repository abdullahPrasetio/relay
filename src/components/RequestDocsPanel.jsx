import React from 'react';
import {
  RESPONSE_VALIDATION_SECTIONS,
  SECTION_LABELS,
  VALIDATION_RULES,
  VALIDATION_SECTIONS,
  collectValidationFields,
  countResponseValidatedFields,
  countValidatedFields,
  hasValidation,
  isValidPattern,
  minMaxLabels,
  normalizeFieldValidations,
  normalizeResponseValidations,
  resolveRequestValidations,
  responseValidationFields,
  validationTokens,
} from '../lib/fieldValidations.js';

// Documentation metadata editor: the request description plus per-field
// validation rules shown in the exported HTML and Confluence docs. Nothing
// here changes how the request is sent or how the mock matches scenarios.
export default function RequestDocsPanel({ request, ancestors = [], patch }) {
  const effective = resolveRequestValidations(request, ancestors);
  const requestValidations = normalizeFieldValidations(request?.fieldValidations);
  const requestResponseValidations = normalizeResponseValidations(request?.responseValidations);
  const validations = effective.fieldValidations;
  const responseValidations = effective.responseValidations;
  const documented = countValidatedFields(validations);
  const responseDocumented = countResponseValidatedFields(responseValidations);
  const fields = collectValidationFields(request);
  const responseFields = responseValidationFields(request);
  for (const section of VALIDATION_SECTIONS) {
    const known = new Set(fields[section].map((field) => field.key));
    for (const key of Object.keys(validations[section])) {
      if (!known.has(key)) fields[section].push({ key, value: '' });
    }
  }
  for (const section of RESPONSE_VALIDATION_SECTIONS) {
    const known = new Set(responseFields[section].map((field) => field.key));
    for (const key of Object.keys(responseValidations[section])) {
      if (!known.has(key)) responseFields[section].push({ key, value: '' });
    }
  }

  function updateRule(section, key, nextRule) {
    const next = normalizeFieldValidations({
      ...requestValidations,
      [section]: { ...requestValidations[section], [key]: nextRule },
    });
    patch({ fieldValidations: next });
  }

  function clearRule(section, key) {
    const sectionRules = { ...requestValidations[section] };
    delete sectionRules[key];
    patch({
      fieldValidations: normalizeFieldValidations({
        ...requestValidations,
        [section]: sectionRules,
      }),
    });
  }

  const missing = VALIDATION_SECTIONS.every((section) => fields[section].length === 0);
  const responseMissing = RESPONSE_VALIDATION_SECTIONS.every(
    (section) => responseFields[section].length === 0
  );

  function updateResponseRule(section, key, nextRule) {
    const next = normalizeResponseValidations({
      ...requestResponseValidations,
      [section]: { ...requestResponseValidations[section], [key]: nextRule },
    });
    patch({ responseValidations: next });
  }

  function clearResponseRule(section, key) {
    const sectionRules = { ...requestResponseValidations[section] };
    delete sectionRules[key];
    patch({
      responseValidations: normalizeResponseValidations({
        ...requestResponseValidations,
        [section]: sectionRules,
      }),
    });
  }

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
                    inherited={!requestValidations[section][field.key]}
                    onChange={(rule) => updateRule(section, field.key, rule)}
                    onClear={() => clearRule(section, field.key)}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}

      <div className="docs-section-head" style={{ marginTop: 18 }}>
        <div>
          <div className="sent-section-title">Response validation</div>
          <p className="auth-hint">
            Based on the latest saved example. These rules document the response shape.
          </p>
        </div>
        <span className="badge" data-testid="response-validation-count">
          {responseDocumented} documented
        </span>
      </div>

      {responseMissing ? (
        <div className="docs-empty">
          Save an example with a JSON body or response headers to document the response.
        </div>
      ) : (
        RESPONSE_VALIDATION_SECTIONS.map((section) => {
          const list = responseFields[section];
          if (!list.length) return null;
          return (
            <section className="validation-group" key={`response-${section}`}>
              <h4>
                {section === 'body' ? 'Response body fields' : 'Response headers'}{' '}
                <span className="badge">{list.length}</span>
              </h4>
              <div className="validation-fields">
                {list.map((field) => (
                  <ValidationField
                    key={`response:${section}:${field.key}`}
                    scope="response"
                    section={section}
                    field={field}
                    rule={responseValidations[section][field.key]}
                    inherited={!requestResponseValidations[section][field.key]}
                    onChange={(rule) => updateResponseRule(section, field.key, rule)}
                    onClear={() => clearResponseRule(section, field.key)}
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

export function ValidationField({ section, field, rule, onChange, onClear, scope = 'request', inherited = false }) {
  const current = rule || { rules: [], min: 0, max: 0, description: '' };
  const tokens = validationTokens(current);
  const minMax = minMaxLabels(current);
  const slug = field.key.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const testPrefix = scope === 'response' ? 'response-validation' : 'validation';
  // Imported custom rules (for example "max:100") stay visible and removable.
  const patternInvalid = !isValidPattern(current.pattern);
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
      data-testid={`${testPrefix}-field-${section}-${slug}`}
    >
      <div className="validation-field-head">
        <span className="validation-section-tag">{SECTION_LABELS[section]}</span>
        <code className="validation-key">{field.key}</code>
        {inherited && rule && <span className="badge">inherited</span>}
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
        {hasValidation(current) && !inherited && (
          <button
            type="button"
            className="mini-btn validation-clear"
            onClick={onClear}
            data-testid={`${testPrefix}-clear-${section}-${slug}`}
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
          {minMax.min}
          <input
            type="number"
            min="0"
            value={current.min || 0}
            onChange={(e) => onChange({ ...current, min: Number(e.target.value) || 0 })}
          />
        </label>
        <label>
          {minMax.max}
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

      <details className="validation-advanced">
        <summary>More constraints</summary>
        <div className="validation-meta validation-advanced-grid">
          <label>
            Min length
            <input
              type="number"
              min="0"
              value={current.minLength ?? ''}
              data-testid={`${testPrefix}-minlength-${section}-${slug}`}
              onChange={(e) =>
                onChange({
                  ...current,
                  minLength: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Max length
            <input
              type="number"
              min="0"
              value={current.maxLength ?? ''}
              data-testid={`${testPrefix}-maxlength-${section}-${slug}`}
              onChange={(e) =>
                onChange({
                  ...current,
                  maxLength: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Min value
            <input
              type="number"
              value={current.minimum ?? ''}
              data-testid={`${testPrefix}-minimum-${section}-${slug}`}
              onChange={(e) =>
                onChange({
                  ...current,
                  minimum: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Max value
            <input
              type="number"
              value={current.maximum ?? ''}
              data-testid={`${testPrefix}-maximum-${section}-${slug}`}
              onChange={(e) =>
                onChange({
                  ...current,
                  maximum: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Min items
            <input
              type="number"
              min="0"
              value={current.minItems ?? ''}
              data-testid={`${testPrefix}-minitems-${section}-${slug}`}
              onChange={(e) =>
                onChange({
                  ...current,
                  minItems: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Max items
            <input
              type="number"
              min="0"
              value={current.maxItems ?? ''}
              data-testid={`${testPrefix}-maxitems-${section}-${slug}`}
              onChange={(e) =>
                onChange({
                  ...current,
                  maxItems: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Format
            <select
              value={current.format || ''}
              data-testid={`validation-format-${section}-${slug}`}
              onChange={(e) => onChange({ ...current, format: e.target.value })}
            >
              <option value="">—</option>
              <option value="email">email</option>
              <option value="uri">uri / url</option>
              <option value="uuid">uuid</option>
              <option value="date">date</option>
              <option value="date-time">date-time</option>
            </select>
          </label>
          <label>
            Pattern (regex)
            <input
              type="text"
              value={current.pattern || ''}
              placeholder="^[A-Z]{2}-\\d+$"
              data-testid={`${testPrefix}-pattern-${section}-${slug}`}
              aria-invalid={patternInvalid || undefined}
              onChange={(e) => onChange({ ...current, pattern: e.target.value })}
            />
            {patternInvalid && (
              <span className="validation-error" role="alert">
                Invalid regular expression
              </span>
            )}
          </label>
          <label className="validation-wide">
            Enum values (comma separated)
            <input
              type="text"
              value={(current.enum || []).join(', ')}
              placeholder="NEW, PAID, SHIPPED"
              data-testid={`validation-enum-${section}-${slug}`}
              onChange={(e) =>
                onChange({
                  ...current,
                  enum: e.target.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label>
            Example
            <input
              type="text"
              value={current.example || ''}
              onChange={(e) => onChange({ ...current, example: e.target.value })}
            />
          </label>
          <label>
            Default
            <input
              type="text"
              value={current.default || ''}
              onChange={(e) => onChange({ ...current, default: e.target.value })}
            />
          </label>
        </div>
      </details>
    </div>
  );
}
