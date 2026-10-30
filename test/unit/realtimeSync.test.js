import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PRESENCE_INTERVAL_MS,
  SYNC_THROTTLE_MS,
  createChangeThrottle,
  useRealtimeSync,
} from '../../src/lib/useRealtimeSync.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createChangeThrottle', () => {
  it('runs the first event immediately', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const runs = [];
    const throttle = createChangeThrottle({ run: () => runs.push(Date.now()) });

    throttle.trigger();

    expect(runs).toEqual([0]);
    expect(throttle.pending).toBe(false);
  });

  it('runs at most once per 500ms and coalesces a burst into one trailing call', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const runs = [];
    const throttle = createChangeThrottle({
      run: () => runs.push(Date.now()),
      schedule: (fn, ms) => setTimeout(fn, ms),
    });

    throttle.trigger(); // immediate at t=0
    vi.advanceTimersByTime(100);
    throttle.trigger(); // queued for t=500
    vi.advanceTimersByTime(100);
    throttle.trigger(); // coalesced
    vi.advanceTimersByTime(100);
    throttle.trigger(); // coalesced

    expect(runs).toEqual([0]);
    expect(throttle.pending).toBe(true);

    vi.advanceTimersByTime(199);
    expect(runs).toEqual([0]);
    vi.advanceTimersByTime(1);

    expect(runs).toEqual([0, 500]);
    expect(throttle.pending).toBe(false);
  });

  it('runs immediately again once the window has elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const runs = [];
    const throttle = createChangeThrottle({ run: () => runs.push(Date.now()) });

    throttle.trigger();
    vi.advanceTimersByTime(500);
    throttle.trigger();

    expect(runs).toEqual([1000, 1500]);
  });

  it('close cancels a pending call and ignores later triggers', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const run = vi.fn();
    const throttle = createChangeThrottle({ run });

    throttle.trigger();
    vi.advanceTimersByTime(100);
    throttle.trigger();
    throttle.close();

    vi.advanceTimersByTime(1000);
    throttle.trigger();

    expect(run).toHaveBeenCalledTimes(1);
    expect(throttle.pending).toBe(false);
  });

  it('swallows synchronous throw and async rejection from the sync', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const throwing = createChangeThrottle({
      run: () => {
        throw new Error('boom');
      },
    });
    expect(() => throwing.trigger()).not.toThrow();

    const rejecting = createChangeThrottle({ run: () => Promise.reject(new Error('nope')) });
    expect(() => rejecting.trigger()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('supports an injected clock and scheduler', () => {
    let clock = 0;
    const timers = [];
    const runs = [];
    const throttle = createChangeThrottle({
      run: () => runs.push(clock),
      intervalMs: 200,
      now: () => clock,
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      cancel: (handle) => {
        timers[handle] = null;
      },
    });

    throttle.trigger();
    clock = 50;
    throttle.trigger();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(150);

    clock = 200;
    timers[0].fn();
    expect(runs).toEqual([0, 200]);

    throttle.close();
    clock = 1000;
    throttle.trigger();
    expect(runs).toEqual([0, 200]);
  });

  it('requires a run function', () => {
    expect(() => createChangeThrottle({})).toThrow(/run/);
  });
});

describe('useRealtimeSync module', () => {
  it('exports the hook and the timing defaults', () => {
    expect(typeof useRealtimeSync).toBe('function');
    expect(SYNC_THROTTLE_MS).toBe(500);
    expect(PRESENCE_INTERVAL_MS).toBe(30000);
  });
});
