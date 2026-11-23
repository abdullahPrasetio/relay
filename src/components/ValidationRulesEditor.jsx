import React from 'react';
import { ValidationField } from './RequestDocsPanel.jsx';
import {
  RESPONSE_VALIDATION_SECTIONS,
  VALIDATION_SECTIONS,
  collectContainerValidationFields,
  countResponseValidatedFields,
  countValidatedFields,
  normalizeFieldValidations,
  normalizeResponseValidations,
} from '../lib/fieldValidations.js';

// Collection/folder validation editor. Rules are inherited by every request
// below the node; a request-level rule for the same field wins.
export default function ValidationRulesEditor({
  container,
  fieldValidations,
  responseValidations,
  onChange,
}) {
  const fieldRules = normalizeFieldValidations(fieldValidations);
  const responseRules = normalizeResponseValidations(responseValidations);
  const { fields, responseFields } = collectContainerValidationFields(container);
  const fieldCount = countValidatedFields(fieldRules);
  const responseCount = countResponseValidatedFields(responseRules);

  function setFieldRule(section, key, rule) {
    onChange({
      fieldValidations: normalizeFieldValidations({
        ...fieldRules,
        [section]: { ...fieldRules[section], [key]: rule },
      }),
    });
  }

  function clearFieldRule(section, key) {
    const next = { ...fieldRules[section] };
    delete next[key];
    onChange({
      fieldValidations: normalizeFieldValidations({ ...fieldRules, [section]: next }),
    });
  }

  function setResponseRule(section, key, rule) {
    onChange({
      responseValidations: normalizeResponseValidations({
        ...responseRules,
        [section]: { ...responseRules[section], [key]: rule },
      }),
    });
  }

  function clearResponseRule(section, key) {
    const next = { ...responseRules[section] };
    delete next[key];
    onChange({
      responseValidations: normalizeResponseValidations({
        ...responseRules,
        [section]: next,
      }),
    });
  }

  const hasAnyFields =
    VALIDATION_SECTIONS.some((section) => fields[section].length > 0) ||
    RESPONSE_VALIDATION_SECTIONS.some((section) => responseFields[section].length > 0);

  if (!hasAnyFields) {
    return (
      <div className="docs-empty">
        Add a request with parameters, headers, a body, or a saved example to get
        validation fields here.
      </div>
    );
  }

  return (
    <div className="validation-rules-editor">
      <p className="auth-hint" style={{ marginTop: 0 }}>
        These rules are inherited by every request below this node. A request rule
        for the same field overrides them.
      </p>
      <div className="docs-section-head">
        <div className="sent-section-title">Request validation</div>
        <span className="badge">{fieldCount} documented</span>
      </div>
      {VALIDATION_SECTIONS.map((section) => {
        const list = fields[section];
        if (!list.length) return null;
        return (
          <section className="validation-group" key={section}>
            <h4>
              {section === 'path'
                ? 'Path variables'
                : section === 'params'
                  ? 'Query parameters'
                  : section === 'headers'
                    ? 'Headers'
                    : 'Body fields'}{' '}
              <span className="badge">{list.length}</span>
            </h4>
            <div className="validation-fields">
              {list.map((field) => (
                <ValidationField
                  key={`${section}:${field.key}`}
                  section={section}
                  field={field}
                  rule={fieldRules[section][field.key]}
                  onChange={(rule) => setFieldRule(section, field.key, rule)}
                  onClear={() => clearFieldRule(section, field.key)}
                />
              ))}
            </div>
          </section>
        );
      })}

      <div className="docs-section-head" style={{ marginTop: 18 }}>
        <div className="sent-section-title">Response validation</div>
        <span className="badge">{responseCount} documented</span>
      </div>
      {RESPONSE_VALIDATION_SECTIONS.map((section) => {
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
                  rule={responseRules[section][field.key]}
                  onChange={(rule) => setResponseRule(section, field.key, rule)}
                  onClear={() => clearResponseRule(section, field.key)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
