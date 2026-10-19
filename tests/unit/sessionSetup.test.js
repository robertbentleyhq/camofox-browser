import { jest } from '@jest/globals';
import {
  SessionSetupTimeoutError,
  SessionSetupAbandonedError,
  createSetupTracker,
  tabCreateBudgetMs,
} from '../../lib/session-setup.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('createSetupTracker', () => {
  beforeEach(() => jest.useFakeTimers({ now: 0 }));
  afterEach(() => jest.useRealTimers());

  test('finished steps return results and log one timing each with merged fields', async () => {
    const log = jest.fn();
    const tracker = createSetupTracker({ timeoutMs: 100, log, fields: { userId: 'user-1' } });
    const result = { ready: true };
    expect(tracker.abandoned).toBe(false);
    expect(tracker.activeStep).toBeNull();
    const run = tracker.run(async (setup) => {
      expect(setup).toBe(tracker);
      const browser = await setup.step('browser_launch', async () => {
        expect(setup.activeStep).toBe('browser_launch');
        expect(setup.timings).toEqual({});
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'browser';
      });
      expect(browser).toBe('browser');
      expect(setup.activeStep).toBeNull();
      return setup.step('context_create', async () => {
        expect(setup.activeStep).toBe('context_create');
        await new Promise((resolve) => setTimeout(resolve, 20));
        return result;
      });
    });

    await jest.advanceTimersByTimeAsync(30);
    await expect(run).resolves.toBe(result);
    expect(log.mock.calls).toEqual([
      ['info', 'session setup step', { userId: 'user-1', step: 'browser_launch', ms: 10 }],
      ['info', 'session setup step', { userId: 'user-1', step: 'context_create', ms: 20 }],
    ]);
    for (const [, , data] of log.mock.calls) expect(typeof data.ms).toBe('number');
    expect(tracker.timings).toEqual({ browser_launch: 10, context_create: 20 });
    const copy = tracker.timings;
    copy.browser_launch = -1;
    expect(tracker.timings.browser_launch).toBe(10);
    expect(tracker.activeStep).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(100);
    expect(tracker.abandoned).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
  });

  test('a stalled step rejects at the overall deadline with the timeout contract', async () => {
    const tracker = createSetupTracker({ timeoutMs: 100, log: jest.fn() });
    const outcome = tracker.run((setup) => setup.step('browser_launch', () => new Promise(() => {})))
      .catch((err) => err);
    await jest.advanceTimersByTimeAsync(99);
    expect(tracker.abandoned).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(SessionSetupTimeoutError);
    expect(error).toMatchObject({
      name: 'SessionSetupTimeoutError',
      message: 'session setup timed out after 100ms during browser_launch',
      code: 'session_setup_timeout',
      statusCode: 503,
      retryable: true,
      step: 'browser_launch',
      elapsedMs: 100,
      timeoutMs: 100,
      timings: {},
    });
    expect(tracker.abandoned).toBe(true);
  });

  test('timeout log reports only finished timings and never resets the overall deadline', async () => {
    const log = jest.fn();
    const tracker = createSetupTracker({ timeoutMs: 100, log, fields: { userId: 'user-1' } });
    const outcome = tracker.run(async (setup) => {
      await setup.step('profile_load', () => new Promise((resolve) => setTimeout(resolve, 30)));
      await setup.step('context_create', () => new Promise(() => {}));
    }).catch((err) => err);

    await jest.advanceTimersByTimeAsync(100);
    const error = await outcome;
    expect(error.timings).toEqual({ profile_load: 30 });
    expect(log.mock.calls).toEqual([
      ['info', 'session setup step', { userId: 'user-1', step: 'profile_load', ms: 30 }],
      ['warn', 'session setup timed out', {
        userId: 'user-1', step: 'context_create', elapsedMs: 100, timeoutMs: 100,
        timings: { profile_load: 30 },
      }],
    ]);
  });

  test('onAbandon listeners run at the deadline while the stalled step is still pending', async () => {
    const log = jest.fn();
    const tracker = createSetupTracker({ timeoutMs: 100, log, fields: { userId: 'user-1' } });
    const hook = deferred();
    const order = [];
    tracker.onAbandon(() => { throw new Error('listener boom'); });
    tracker.onAbandon(() => order.push(['listener', tracker.abandoned, tracker.activeStep]));
    let stepSettled = false;
    const outcome = tracker.run(async (setup) => {
      try {
        await setup.step('session_hooks', () => hook.promise);
      } finally {
        stepSettled = true;
      }
    }).catch((err) => { order.push(['rejected']); return err; });

    await jest.advanceTimersByTimeAsync(99);
    expect(order).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(SessionSetupTimeoutError);
    expect(error.step).toBe('session_hooks');
    expect(order).toEqual([['listener', true, 'session_hooks'], ['rejected']]);
    expect(stepSettled).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', 'session setup abandon listener failed', {
      userId: 'user-1', error: 'listener boom',
    });
    hook.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(stepSettled).toBe(true);
  });

  test('steps started after abandonment reject without invoking their work', async () => {
    const tracker = createSetupTracker({ timeoutMs: 100, log: jest.fn() });
    const outcome = tracker.run(() => new Promise(() => {})).catch((err) => err);
    await jest.advanceTimersByTimeAsync(100);
    await outcome;
    const work = jest.fn();
    const error = await tracker.step('session_hooks', work).catch((err) => err);
    expect(error).toBeInstanceOf(SessionSetupAbandonedError);
    expect(error).toMatchObject({
      name: 'SessionSetupAbandonedError', code: 'session_setup_abandoned', step: 'session_hooks',
    });
    expect(work).not.toHaveBeenCalled();
    expect(tracker.abandoned).toBe(true);
  });

  test('AE2: a late context is cleaned once before abandonment stops the next step', async () => {
    const log = jest.fn();
    const tracker = createSetupTracker({ timeoutMs: 100, log });
    const work = deferred();
    const cleanup = deferred();
    const context = { close: jest.fn(() => cleanup.promise) };
    const onLate = jest.fn((result) => result.close());
    const next = jest.fn();
    let attempt;
    const outcome = tracker.run((setup) => {
      attempt = (async () => {
        await setup.step('context_create', () => work.promise, { onLate });
        await setup.step('session_hooks', next);
      })();
      return attempt;
    }).catch((err) => err);
    await jest.advanceTimersByTimeAsync(100);
    expect(await outcome).toBeInstanceOf(SessionSetupTimeoutError);

    let settled = false;
    const lateOutcome = attempt.catch((err) => { settled = true; return err; });
    work.resolve(context);
    await jest.advanceTimersByTimeAsync(0);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(onLate).toHaveBeenCalledWith(context);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    cleanup.resolve();
    await expect(lateOutcome).resolves.toBeInstanceOf(SessionSetupAbandonedError);
    expect(next).not.toHaveBeenCalled();
    expect(tracker.timings).toEqual({});
    expect(tracker.activeStep).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  test.each(['throw', 'reject'])('late cleanup failure (%s) logs a warning and stays abandoned', async (mode) => {
    const log = jest.fn();
    const tracker = createSetupTracker({ timeoutMs: 100, log, fields: { userId: 'user-1' } });
    const work = deferred();
    const cleanupError = new Error('close failed');
    const onLate = jest.fn(() => {
      if (mode === 'throw') throw cleanupError;
      return Promise.reject(cleanupError);
    });
    let attempt;
    const outcome = tracker.run((setup) => {
      attempt = setup.step('context_create', () => work.promise, { onLate });
      return attempt;
    }).catch((err) => err);
    await jest.advanceTimersByTimeAsync(100);
    await outcome;
    work.resolve({});
    await expect(attempt).rejects.toBeInstanceOf(SessionSetupAbandonedError);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith('warn', 'session setup late cleanup failed', {
      userId: 'user-1', step: 'context_create', error: 'close failed',
    });
    expect(tracker.timings).toEqual({});
  });

  test.each([
    ['proxy_ip_lookup', 'proxy_ip_lookup'],
    [null, 'proxy_assignment'],
  ])('timeout reads the current subStep %s with fallback to %s', async (detail, expectedStep) => {
    const log = jest.fn();
    const tracker = createSetupTracker({ timeoutMs: 100, log });
    let current = 'proxy_select';
    const subStep = jest.fn(() => current);
    const outcome = tracker.run((setup) => setup.step('proxy_assignment', () => new Promise(() => {}), { subStep }))
      .catch((err) => err);
    await jest.advanceTimersByTimeAsync(50);
    current = detail;
    await jest.advanceTimersByTimeAsync(50);
    expect((await outcome).step).toBe(expectedStep);
    expect(subStep).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', 'session setup timed out', expect.objectContaining({ step: expectedStep }));
  });

  test('a completed step does not leave a stale subStep for a timeout between steps', async () => {
    const tracker = createSetupTracker({ timeoutMs: 100, log: jest.fn() });
    const subStep = jest.fn(() => 'proxy_ip_lookup');
    const outcome = tracker.run(async (setup) => {
      await setup.step('proxy_assignment', () => 'proxy', { subStep });
      await new Promise(() => {});
    }).catch((err) => err);
    await jest.advanceTimersByTimeAsync(100);
    expect((await outcome).step).toBe('unknown');
    expect(subStep).not.toHaveBeenCalled();
  });

  test.each(['throw', 'reject'])('a non-timeout step error (%s) propagates unchanged without logs', async (mode) => {
    const log = jest.fn();
    const tracker = createSetupTracker({ timeoutMs: 100, log });
    const original = new Error('profile failed');
    const run = tracker.run((setup) => setup.step('profile_load', () => {
      if (mode === 'throw') throw original;
      return Promise.reject(original);
    }));
    await expect(run).rejects.toBe(original);
    expect(original).not.toBeInstanceOf(SessionSetupTimeoutError);
    expect(tracker.timings).toEqual({});
    expect(tracker.activeStep).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(100);
    expect(log).not.toHaveBeenCalled();
    expect(tracker.abandoned).toBe(false);
  });

  test('a step rejecting after timeout becomes an abandonment error without extra logs', async () => {
    const log = jest.fn();
    const tracker = createSetupTracker({ timeoutMs: 100, log });
    const work = deferred();
    const onLate = jest.fn();
    let step;
    const outcome = tracker.run((setup) => {
      step = setup.step('context_create', () => work.promise, { onLate });
      return step;
    }).catch((err) => err);
    await jest.advanceTimersByTimeAsync(100);
    await outcome;
    work.reject(new Error('context failed'));
    await expect(step).rejects.toMatchObject({ code: 'session_setup_abandoned', step: 'context_create' });
    expect(onLate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(tracker.timings).toEqual({});
  });

  test('an attempt rejecting after timeout does not emit unhandledRejection', async () => {
    jest.useRealTimers();
    const onUnhandled = jest.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const tracker = createSetupTracker({ timeoutMs: 10, log: jest.fn() });
      const work = deferred();
      await expect(tracker.run(() => work.promise)).rejects.toBeInstanceOf(SessionSetupTimeoutError);
      work.reject(new Error('late attempt failure'));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  test('run is single-use even while the first run is pending', async () => {
    const tracker = createSetupTracker({ timeoutMs: 100, log: jest.fn() });
    const work = deferred();
    const first = tracker.run(() => work.promise);
    const second = jest.fn();
    await expect(tracker.run(second)).rejects.toThrow('only run once');
    expect(second).not.toHaveBeenCalled();
    work.resolve('ready');
    await expect(first).resolves.toBe('ready');
    await expect(tracker.run(second)).rejects.toThrow('only run once');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('run propagates a synchronous callback error and clears the deadline', async () => {
    const log = jest.fn();
    const tracker = createSetupTracker({ timeoutMs: 100, log });
    const original = new Error('setup failed');
    await expect(tracker.run(() => { throw original; })).rejects.toBe(original);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(100);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('tabCreateBudgetMs', () => {
  test.each([
    [180000, 60000, 30000, 180000],
    [30000, 60000, 30000, 90000],
  ])('request %i, setup %i, handler %i yields %i ms', (requestTimeoutMs, setupTimeoutMs, handlerTimeoutMs, expected) => {
    expect(tabCreateBudgetMs({ requestTimeoutMs, setupTimeoutMs, handlerTimeoutMs })).toBe(expected);
  });
});
