// pm.response surface (ROADMAP Fase 3.2).
//
// The engine's response object is plain data; this module wraps it once so test
// scripts see Postman's shape: `pm.response.code`, `.headers.get(...)`,
// `.json()`, `.text()`, `.to.have.status(...)` and the negation chain.
//
// A failed send (`{ ok: false, error }`) must produce an assertion *failure*
// with the transport's error in the message — never a TypeError from reading a
// missing response. Every accessor below is total: it answers for `{ok:false}`
// and for binary bodies (which have an empty `body` and a `bodyBase64`).

import { AssertionError, fmt, isRegExp } from './assertions.js';
import { buildHeadersApi, findHeader } from './headers.js';

function byteLength(text) {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(text) : text.length;
}

function describeFailure(response) {
  const err = response && response.error;
  return err ? String(err) : 'no response was received';
}

export function buildResponseApi(response) {
  const res = response || {};
  const ok = Boolean(res.ok);
  const code = ok ? Number(res.status) || 0 : 0;
  const statusText = res.statusText == null ? '' : String(res.statusText);
  const isBinary = Boolean(res.isBinary);
  const bodyText = ok && !isBinary ? String(res.body ?? '') : '';
  const size = typeof res.size === 'number' ? res.size : byteLength(bodyText);

  const gate = { negate: false };
  function check(pass, message) {
    const negated = gate.negate;
    gate.negate = false;
    const outcome = negated ? !pass : pass;
    if (outcome) return;
    throw new AssertionError(negated ? message.replace(/\bto\b/, 'not to') : message);
  }

  function statusLabel() {
    return `${code}${statusText ? ` ${statusText}` : ''}`;
  }

  const to = {
    get not() {
      gate.negate = true;
      return to;
    },
    have: {
      // Postman accepts a numeric code, a status text ("OK"), a code string
      // ("200"), or a RegExp matched against either.
      status(expected) {
        if (!ok) {
          return check(
            false,
            `expected response status ${fmt(expected)} but the request failed: ${describeFailure(res)}`
          );
        }
        let pass;
        let wanted;
        if (typeof expected === 'number') {
          pass = code === expected;
          wanted = String(expected);
        } else if (isRegExp(expected)) {
          pass = expected.test(String(code)) || expected.test(statusText);
          wanted = String(expected);
        } else {
          const text = String(expected ?? '').trim();
          pass =
            text === String(code) ||
            text.toLowerCase() === statusText.toLowerCase() ||
            (text.toLowerCase() === 'ok' && code >= 200 && code < 300);
          wanted = text;
        }
        return check(pass, `expected response status ${statusLabel()} to match ${fmt(wanted)}`);
      },
      header(name, expectedValue) {
        if (!ok) {
          return check(
            false,
            `expected response header ${fmt(name)} but the request failed: ${describeFailure(res)}`
          );
        }
        const hit = findHeader(res.headers || [], name);
        if (expectedValue === undefined) {
          return check(Boolean(hit), `expected response to have header ${fmt(name)}`);
        }
        let pass = Boolean(hit);
        if (pass) {
          if (isRegExp(expectedValue)) pass = expectedValue.test(String(hit.value));
          else pass = String(hit.value) === String(expectedValue);
        }
        return check(
          pass,
          `expected response header ${fmt(name)} to equal ${fmt(expectedValue)} but got ${fmt(
            hit ? hit.value : undefined
          )}`
        );
      },
      jsonBody() {
        let pass = false;
        if (ok && !isBinary) {
          try {
            JSON.parse(bodyText);
            pass = true;
          } catch {
            pass = false;
          }
        }
        return check(pass, 'expected response body to be valid JSON');
      },
      body(expected) {
        if (!ok) {
          return check(
            false,
            `expected response body ${fmt(expected)} but the request failed: ${describeFailure(res)}`
          );
        }
        const pass = isRegExp(expected)
          ? expected.test(bodyText)
          : bodyText === String(expected ?? '');
        return check(pass, `expected response body ${fmt(bodyText)} to match ${fmt(String(expected ?? ''))}`);
      },
    },
    get be() {
      return {
        get ok() {
          return check(ok && code >= 200 && code < 300, `expected a 2xx response but got ${statusLabel()}`);
        },
      };
    },
  };

  return {
    code,
    status: statusText,
    reason: () => statusText || (res.error ? String(res.error) : ''),
    responseTime: typeof res.timeMs === 'number' ? res.timeMs : 0,
    ok,
    headers: buildHeadersApi(res.headers || []),
    text: () => bodyText,
    json: () => {
      if (!ok) {
        throw new AssertionError(`cannot read response JSON: request failed (${describeFailure(res)})`);
      }
      if (isBinary) {
        throw new AssertionError('cannot read response JSON: the response body is binary');
      }
      try {
        return JSON.parse(bodyText);
      } catch (err) {
        throw new AssertionError(
          `response body is not valid JSON (${err.message}): ${fmt(bodyText.slice(0, 120))}`
        );
      }
    },
    size: () => size,
    to,
  };
}

// Wrap an engine response for pm.sendRequest callbacks/promises.
export function wrapScriptResponse(res) {
  const api = buildResponseApi(res);
  return { ...api, ok: Boolean(res && res.ok) };
}
