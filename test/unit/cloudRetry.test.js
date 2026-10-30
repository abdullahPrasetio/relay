import { describe, expect, it } from 'vitest';
import {
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  createRetryScheduler,
  isRetryableError,
} from '../../src/lib/useCloudSync.js';

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const scheduled = [];
  return {
    scheduled,
    pending,
    schedule(fn, ms) {
      const id = nextId++;
      pending.set(id, fn);
      scheduled.push({ id, ms });
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    runNext() {
      const entry = pending.entries().next();
      if (entry.done) return false;
      const [id, fn] = entry.value;
      pending.delete(id);
      fn();
      return true;
    },
  };
}

describe('createRetryScheduler', () => {
  it('re-arms with the next delay and runs the callback once per timer', () => {
    const timers = fakeTimers();
    const runs = [];
    let scheduler;
    scheduler = createRetryScheduler({
      schedule: timers.schedule,
      cancel: timers.cancel,
      nextDelay: (attempt) => 1000 * 2 ** attempt,
      maxDelayMs: 60000,
      onRun: () => runs.push(scheduler.attempt),
    });

    expect(scheduler.start()).toBe(1000);
    expect(scheduler.attempt).toBe(1);
    expect(scheduler.retryInMs).toBe(1000);
    expect(scheduler.scheduled).toBe(true);

    // A second failure while a timer is pending must not stack another timer.
    expect(scheduler.fail()).toBeNull();
    expect(timers.scheduled.map((entry) => entry.ms)).toEqual([1000]);

    expect(timers.runNext()).toBe(true);
    expect(runs).toEqual([1]);
    expect(scheduler.retryInMs).toBeNull();
    expect(scheduler.scheduled).toBe(false);

    // After the run the next attempt doubles; attempt index keeps climbing.
    expect(scheduler.fail()).toBe(2000);
    expect(timers.runNext()).toBe(true);
    expect(runs).toEqual([1, 2]);
    expect(scheduler.fail()).toBe(4000);
  });

  it('caps delays at maxDelayMs and falls back to the minimum for bad values', () => {
    const timers = fakeTimers();
    const capped = createRetryScheduler({
      schedule: timers.schedule,
      cancel: timers.cancel,
      nextDelay: () => 10 * 60 * 1000,
      maxDelayMs: 5000,
    });
    expect(capped.fail()).toBe(5000);

    const invalid = createRetryScheduler({
      schedule: timers.schedule,
      cancel: timers.cancel,
      nextDelay: () => Number.NaN,
    });
    expect(invalid.fail()).toBe(RETRY_MIN_MS);

    const negative = createRetryScheduler({
      schedule: timers.schedule,
      cancel: timers.cancel,
      nextDelay: () => -500,
    });
    expect(negative.fail()).toBe(RETRY_MIN_MS);

    const unbounded = createRetryScheduler({
      schedule: timers.schedule,
      cancel: timers.cancel,
      nextDelay: () => 10 ** 9,
    });
    expect(unbounded.fail()).toBe(RETRY_MAX_MS);
  });

  it('reset cancels the pending timer and forgets the attempt count', () => {
    const timers = fakeTimers();
    const runs = [];
    const scheduler = createRetryScheduler({
      schedule: timers.schedule,
      cancel: timers.cancel,
      nextDelay: (attempt) => 1000 * 2 ** attempt,
      onRun: () => runs.push(1),
    });

    expect(scheduler.fail()).toBe(1000);
    scheduler.reset();

    expect(timers.pending.size).toBe(0);
    expect(timers.runNext()).toBe(false);
    expect(runs).toHaveLength(0);
    expect(scheduler.attempt).toBe(0);
    expect(scheduler.retryInMs).toBeNull();
    expect(scheduler.scheduled).toBe(false);

    // A new failure after reset starts the backoff from the beginning.
    expect(scheduler.fail()).toBe(1000);
  });

  it('stop cancels the timer and prevents further scheduling until start', () => {
    const timers = fakeTimers();
    const runs = [];
    const scheduler = createRetryScheduler({
      schedule: timers.schedule,
      cancel: timers.cancel,
      nextDelay: () => 1000,
      onRun: () => runs.push(1),
    });

    scheduler.fail();
    scheduler.stop();

    expect(scheduler.stopped).toBe(true);
    expect(timers.pending.size).toBe(0);
    expect(timers.runNext()).toBe(false);
    expect(runs).toHaveLength(0);
    expect(scheduler.fail()).toBeNull();
    expect(scheduler.retryInMs).toBeNull();

    expect(scheduler.start()).toBe(1000);
    expect(scheduler.stopped).toBe(false);
    expect(timers.runNext()).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it('never keeps a stale handle when the timer fires synchronously', () => {
    let runs = 0;
    const scheduler = createRetryScheduler({
      schedule: (fn) => {
        fn();
        return Symbol('sync');
      },
      cancel: () => {},
      nextDelay: () => 0,
      maxDelayMs: 100,
      onRun: () => {
        runs += 1;
      },
    });

    expect(scheduler.fail()).toBe(0);
    expect(runs).toBe(1);
    expect(scheduler.retryInMs).toBeNull();
    expect(scheduler.scheduled).toBe(false);
    // Without a leaked handle the next failure can arm another attempt.
    expect(scheduler.fail()).toBe(0);
    expect(runs).toBe(2);
  });

  it('classifies retryable transport failures only', () => {
    expect(isRetryableError({ code: 'offline', status: 0 })).toBe(true);
    expect(isRetryableError({ code: 'internal', status: 500 })).toBe(true);
    expect(isRetryableError({ code: 'unauthorized', status: 401 })).toBe(false);
    expect(isRetryableError({ code: 'busy' })).toBe(false);
    expect(isRetryableError({ code: 'not_attached' })).toBe(false);
    expect(isRetryableError({ code: 'weird', status: 403 })).toBe(false);
    expect(isRetryableError({ code: 'weird', status: 422 })).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});
