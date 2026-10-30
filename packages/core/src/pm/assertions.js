// Chai-style assertion surface for `pm.expect` (ROADMAP Fase 3.2).
//
// The script body runs inside `runInSandbox` (a separate vm realm), so every
// value an assertion sees may come from another realm. That rules out host
// `instanceof` checks against realm-local constructors and makes `Array.isArray`
// (which is cross-realm safe) and `Object.prototype.toString` the reliable
// primitives. Everything here is closed over host functions; no globals are
// injected into the sandbox beyond the `pm` object itself.
//
// Deliberately no lodash / chai dependency: the app ships without them and the
// subset below is small, so a hand-written implementation keeps the bundle
// lean and the semantics (and error messages) explicit.

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
    this.assertion = true;
  }
}

// `fmt` is used in every failure message, so it must never throw (circular
// objects, BigInt, symbols) and must quote strings the way chai does.
export function fmt(value) {
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (value === null) return 'null';
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Circular / getter that throws: fall through to String().
  }
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

function typeTag(value) {
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

export function isRegExp(value) {
  return typeTag(value) === 'regexp';
}

function isPlainObject(value) {
  return typeTag(value) === 'object';
}

// Structural equality. Handles arrays, plain objects, Date, RegExp and NaN
// across realms. Class instances compare by enumerable own keys, which is what
// scripts actually assert on (request/response snapshots are plain data).
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const tagA = typeTag(a);
  if (tagA !== typeTag(b)) return false;
  if (tagA === 'date') return a.getTime() === b.getTime();
  if (tagA === 'regexp') return String(a) === String(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key])
  );
}

// `{ a: 1 }` is "included in" `{ a: 1, b: 2 }` (chai's object subset rule).
function objectContains(actual, expected) {
  if (!isPlainObject(actual) || !isPlainObject(expected)) return false;
  return Object.keys(expected).every(
    (key) => Object.prototype.hasOwnProperty.call(actual, key) && deepEqual(actual[key], expected[key])
  );
}

const CHAIN_WORDS = [
  'to',
  'be',
  'been',
  'is',
  'that',
  'which',
  'and',
  'has',
  'have',
  'with',
  'at',
  'of',
  'same',
  'but',
  'does',
  'still',
  'also',
];

function actualTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// `expect(x).to.be.an.instanceof(Array)` and `expect(x).to.be.a('string')` both
// have to work, so `a`/`an` hand back a callable that also forwards every chain
// word, method and assertion getter to the underlying Expectation.
function makeTypeChain(expectation) {
  const chain = (type) => expectation._type(type);
  for (const word of CHAIN_WORDS) chain[word] = chain;
  const proto = Object.getPrototypeOf(expectation);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor' || key === 'a' || key === 'an' || key.startsWith('_')) continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (!descriptor) continue;
    if (typeof descriptor.value === 'function') {
      const method = descriptor.value;
      chain[key] = (...args) => method.apply(expectation, args);
    } else if (typeof descriptor.get === 'function') {
      Object.defineProperty(chain, key, {
        get: () => descriptor.get.call(expectation),
        enumerable: false,
        configurable: true,
      });
    }
  }
  return chain;
}

export class Expectation {
  constructor(actual) {
    this.actual = actual;
    this.negate = false;
    this.deep = false;
    for (const word of CHAIN_WORDS) this[word] = this;
  }

  get not() {
    this.negate = !this.negate;
    return this;
  }

  get deep() {
    this._deep = true;
    return this;
  }

  set deep(value) {
    this._deep = Boolean(value);
  }

  // `deep` is a getter in the class body above; the stored flag lives in
  // `_deep` so `deep` can stay a chainable property without recursion.
  _check(pass, message) {
    const negated = this.negate;
    const deep = this._deep === true;
    this.negate = false;
    this._deep = false;
    const ok = negated ? !pass : pass;
    if (ok) return this;
    const finalMessage = negated ? message.replace(/\bto\b/, 'not to') : message;
    throw new AssertionError(finalMessage);
  }

  // --- equality -----------------------------------------------------------
  equal(expected) {
    const pass = this._deep === true ? deepEqual(this.actual, expected) : this.actual === expected;
    return this._check(
      pass,
      `expected ${fmt(this.actual)} to ${this._deep === true ? 'deeply equal' : 'equal'} ${fmt(expected)}`
    );
  }

  eq(expected) {
    return this.equal(expected);
  }

  equals(expected) {
    return this.equal(expected);
  }

  eql(expected) {
    return this._check(
      deepEqual(this.actual, expected),
      `expected ${fmt(this.actual)} to deeply equal ${fmt(expected)}`
    );
  }

  // --- containment --------------------------------------------------------
  include(expected) {
    let pass = false;
    if (typeof this.actual === 'string') {
      pass = this.actual.includes(String(expected));
    } else if (Array.isArray(this.actual)) {
      pass = this.actual.some(
        (item) => deepEqual(item, expected) || objectContains(item, expected)
      );
    } else if (isPlainObject(this.actual)) {
      pass = objectContains(this.actual, expected);
    }
    return this._check(pass, `expected ${fmt(this.actual)} to include ${fmt(expected)}`);
  }

  includes(expected) {
    return this.include(expected);
  }

  contain(expected) {
    return this.include(expected);
  }

  contains(expected) {
    return this.include(expected);
  }

  members(list) {
    if (!Array.isArray(this.actual) || !Array.isArray(list)) {
      return this._check(false, `expected ${fmt(this.actual)} to be an array with members ${fmt(list)}`);
    }
    const deep = this._deep === true;
    let pass = this.actual.length === list.length;
    if (pass) {
      const used = new Set();
      pass = this.actual.every((item) => {
        const idx = list.findIndex(
          (candidate, i) => !used.has(i) && (deep ? deepEqual(candidate, item) : candidate === item)
        );
        if (idx < 0) return false;
        used.add(idx);
        return true;
      });
    }
    return this._check(pass, `expected ${fmt(this.actual)} to have the same members as ${fmt(list)}`);
  }

  // --- shape --------------------------------------------------------------
  lengthOf(n) {
    let length;
    if (this.actual == null) length = undefined;
    else if (typeof this.actual === 'string' || Array.isArray(this.actual)) length = this.actual.length;
    else if (typeof this.actual.length === 'number') length = this.actual.length;
    else if (typeof this.actual.size === 'number') length = this.actual.size;
    return this._check(
      length === n,
      `expected ${fmt(this.actual)} to have a length of ${fmt(n)} but got ${fmt(length)}`
    );
  }

  property(name, ...rest) {
    const target = this.actual;
    const exists =
      target != null &&
      (typeof target === 'object' || typeof target === 'function') &&
      name in Object(target);
    if (rest.length === 0) {
      return this._check(exists, `expected ${fmt(target)} to have property ${fmt(name)}`);
    }
    const wanted = rest[0];
    const valueOk = exists && (this._deep === true ? deepEqual(target[name], wanted) : target[name] === wanted);
    return this._check(
      valueOk,
      `expected ${fmt(target)} to have property ${fmt(name)} of ${fmt(wanted)} but got ${
        exists ? fmt(target[name]) : 'no such property'
      }`
    );
  }

  // --- strings / matching -------------------------------------------------
  match(pattern) {
    const regex = isRegExp(pattern) ? pattern : new RegExp(String(pattern));
    return this._check(
      regex.test(String(this.actual)),
      `expected ${fmt(this.actual)} to match ${fmt(String(pattern))}`
    );
  }

  // --- functions ----------------------------------------------------------
  throw(matcher) {
    if (typeof this.actual !== 'function') {
      return this._check(false, `expected ${fmt(this.actual)} to be a function`);
    }
    let thrown = null;
    try {
      this.actual();
    } catch (err) {
      thrown = err;
    }
    let pass = thrown !== null;
    let detail = '';
    if (pass && matcher != null) {
      const message = thrown && thrown.message != null ? String(thrown.message) : String(thrown);
      if (typeof matcher === 'string') {
        pass = message.includes(matcher);
        detail = ` with a message containing ${fmt(matcher)}`;
      } else if (isRegExp(matcher)) {
        pass = matcher.test(message);
        detail = ` with a message matching ${fmt(String(matcher))}`;
      } else if (typeof matcher === 'function') {
        pass =
          thrown instanceof matcher ||
          (thrown && thrown.constructor && thrown.constructor.name === matcher.name);
        detail = ` of type ${matcher.name || 'expected'}`;
      }
    }
    return this._check(
      pass,
      thrown === null
        ? `expected function to throw${detail} but it did not throw`
        : `expected function to throw${detail} but it threw ${fmt(
            thrown && thrown.message != null ? thrown.message : String(thrown)
          )}`
    );
  }

  instanceof(ctor) {
    const name = (ctor && ctor.name) || String(ctor);
    const pass =
      (typeof ctor === 'function' && this.actual instanceof ctor) ||
      typeTag(this.actual) === String(name).toLowerCase();
    return this._check(pass, `expected ${fmt(this.actual)} to be an instance of ${name}`);
  }

  // --- numbers ------------------------------------------------------------
  above(n) {
    return this._check(
      typeof this.actual === 'number' && this.actual > n,
      `expected ${fmt(this.actual)} to be above ${fmt(n)}`
    );
  }

  gt(n) {
    return this.above(n);
  }

  greaterThan(n) {
    return this.above(n);
  }

  below(n) {
    return this._check(
      typeof this.actual === 'number' && this.actual < n,
      `expected ${fmt(this.actual)} to be below ${fmt(n)}`
    );
  }

  lt(n) {
    return this.below(n);
  }

  lessThan(n) {
    return this.below(n);
  }

  least(n) {
    return this._check(
      typeof this.actual === 'number' && this.actual >= n,
      `expected ${fmt(this.actual)} to be at least ${fmt(n)}`
    );
  }

  gte(n) {
    return this.least(n);
  }

  most(n) {
    return this._check(
      typeof this.actual === 'number' && this.actual <= n,
      `expected ${fmt(this.actual)} to be at most ${fmt(n)}`
    );
  }

  lte(n) {
    return this.most(n);
  }

  within(low, high) {
    return this._check(
      typeof this.actual === 'number' && this.actual >= low && this.actual <= high,
      `expected ${fmt(this.actual)} to be within ${fmt(low)}..${fmt(high)}`
    );
  }

  oneOf(list) {
    const values = Array.isArray(list) ? list : [];
    const deep = this._deep === true;
    const pass = values.some((candidate) => (deep ? deepEqual(candidate, this.actual) : candidate === this.actual));
    return this._check(pass, `expected ${fmt(this.actual)} to be one of ${fmt(values)}`);
  }

  satisfy(fn) {
    if (typeof fn !== 'function') {
      return this._check(false, 'expected a predicate function for satisfy()');
    }
    return this._check(Boolean(fn(this.actual)), `expected ${fmt(this.actual)} to satisfy the predicate`);
  }

  // --- types --------------------------------------------------------------
  // `a`/`an` are callable language chains, like chai: both
  // `expect(x).to.be.a('string')` and `expect(x).to.be.an.instanceof(Array)`
  // must work, so each access returns a function carrying the assertion API.
  get a() {
    return makeTypeChain(this);
  }

  get an() {
    return makeTypeChain(this);
  }

  _type(type) {
    const wanted = String(type).toLowerCase();
    let pass;
    if (wanted === 'array') pass = Array.isArray(this.actual);
    else if (wanted === 'null') pass = this.actual === null;
    else if (wanted === 'object') pass = this.actual !== null && typeof this.actual === 'object';
    else if (wanted === 'undefined') pass = typeof this.actual === 'undefined';
    else if (
      wanted === 'string' ||
      wanted === 'number' ||
      wanted === 'boolean' ||
      wanted === 'function' ||
      wanted === 'symbol' ||
      wanted === 'bigint'
    ) {
      pass = typeof this.actual === wanted;
    } else if (typeof type === 'function') {
      pass = this.actual instanceof type || typeTag(this.actual) === String(type.name).toLowerCase();
    } else {
      pass = actualTypeOf(this.actual) === wanted;
    }
    return this._check(pass, `expected ${fmt(this.actual)} to be a ${wanted}`);
  }

  // --- literals -----------------------------------------------------------
  get ok() {
    return this._check(Boolean(this.actual), `expected ${fmt(this.actual)} to be truthy`);
  }

  get true() {
    return this._check(this.actual === true, `expected ${fmt(this.actual)} to be true`);
  }

  get false() {
    return this._check(this.actual === false, `expected ${fmt(this.actual)} to be false`);
  }

  get null() {
    return this._check(this.actual === null, `expected ${fmt(this.actual)} to be null`);
  }

  get undefined() {
    return this._check(typeof this.actual === 'undefined', `expected ${fmt(this.actual)} to be undefined`);
  }

  get exist() {
    return this._check(this.actual != null, `expected ${fmt(this.actual)} to exist`);
  }

  get NaN() {
    return this._check(
      typeof this.actual === 'number' && Number.isNaN(this.actual),
      `expected ${fmt(this.actual)} to be NaN`
    );
  }

  get empty() {
    let pass = false;
    if (this.actual != null) {
      if (typeof this.actual === 'string' || Array.isArray(this.actual)) pass = this.actual.length === 0;
      else if (typeof this.actual === 'object' && typeof this.actual.size === 'number') pass = this.actual.size === 0;
      else if (typeof this.actual === 'object') pass = Object.keys(this.actual).length === 0;
    }
    return this._check(pass, `expected ${fmt(this.actual)} to be empty`);
  }

  get json() {
    let pass = false;
    if (typeof this.actual === 'string') {
      try {
        JSON.parse(this.actual);
        pass = true;
      } catch {
        pass = false;
      }
    } else {
      pass = this.actual !== null && typeof this.actual === 'object';
    }
    return this._check(pass, `expected ${fmt(this.actual)} to be valid JSON`);
  }
}

export function expect(actual) {
  return new Expectation(actual);
}

expect.fail = (message) => {
  throw new AssertionError(message ? String(message) : 'expected assertion to fail');
};
