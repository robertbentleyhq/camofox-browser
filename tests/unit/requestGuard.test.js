import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import {
  RequestAbandonedError,
  isRequestAbandonedError,
  createRequestGuard,
} from '../../lib/request-guard.js';

function response(writableFinished = false) {
  const res = new EventEmitter();
  res.writableFinished = writableFinished;
  return res;
}

function flushCleanup() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('createRequestGuard', () => {
  test('an unfinished response close aborts with client_disconnected and merged fields', () => {
    const res = response();
    const log = jest.fn();
    const guard = createRequestGuard(res, { log, fields: { userId: 'user-1' } });
    expect(guard.aborted).toBe(false);
    expect(guard.reason).toBeNull();
    res.emit('close');
    expect(guard.aborted).toBe(true);
    expect(guard.reason).toBe('client_disconnected');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', 'request abandoned', {
      userId: 'user-1', reason: 'client_disconnected',
    });
  });

  test('a finished response close does not abort or run cleanup', async () => {
    const res = response();
    const log = jest.fn();
    const guard = createRequestGuard(res, { log });
    const cleanup = jest.fn();
    guard.onAbort(cleanup);
    res.writableFinished = true;
    res.emit('close');
    await flushCleanup();
    expect(guard.aborted).toBe(false);
    expect(guard.reason).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test('abort is idempotent and callbacks run in registration order with the first reason', async () => {
    const log = jest.fn();
    const guard = createRequestGuard(response(), { log });
    const order = [];
    const first = jest.fn((reason) => order.push(['first', reason]));
    const second = jest.fn((reason) => order.push(['second', reason]));
    guard.onAbort(first);
    guard.onAbort(second);
    guard.abort('request_timeout');
    guard.abort('client_disconnected');
    expect(first).not.toHaveBeenCalled();
    await flushCleanup();
    const late = jest.fn((reason) => order.push(['late', reason]));
    guard.onAbort(late);
    await flushCleanup();
    expect(order).toEqual([
      ['first', 'request_timeout'], ['second', 'request_timeout'], ['late', 'request_timeout'],
    ]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect(guard.reason).toBe('request_timeout');
    expect(log).toHaveBeenCalledTimes(1);
  });

  test('throwIfAborted throws the request error contract and the predicate recognizes its code', () => {
    const guard = createRequestGuard(response());
    expect(() => guard.throwIfAborted()).not.toThrow();
    guard.abort('request_timeout');
    let error;
    try {
      guard.throwIfAborted();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RequestAbandonedError);
    expect(error).toMatchObject({
      name: 'RequestAbandonedError', code: 'request_abandoned', reason: 'request_timeout',
      message: 'request abandoned: request_timeout',
    });
    expect(isRequestAbandonedError(error)).toBe(true);
    expect(isRequestAbandonedError({ code: 'request_abandoned' })).toBe(true);
    expect(isRequestAbandonedError(new Error('request abandoned: request_timeout'))).toBe(false);
    expect(isRequestAbandonedError(null)).toBe(false);
    expect(isRequestAbandonedError(undefined)).toBe(false);
  });

  test('unregister prevents cleanup and is safe to call repeatedly', async () => {
    const guard = createRequestGuard(response());
    const cleanup = jest.fn();
    const unregister = guard.onAbort(cleanup);
    unregister();
    unregister();
    guard.abort('request_timeout');
    await flushCleanup();
    expect(cleanup).not.toHaveBeenCalled();
  });

  test('unregister can cancel a queued callback before it runs, including late registration', async () => {
    const guard = createRequestGuard(response());
    const cleanup = jest.fn();
    const unregister = guard.onAbort(cleanup);
    guard.abort('request_timeout');
    unregister();
    guard.onAbort(cleanup)();
    await flushCleanup();
    expect(cleanup).not.toHaveBeenCalled();
  });

  test('each registration runs once even when the same callback is registered twice', async () => {
    const guard = createRequestGuard(response());
    const cleanup = jest.fn();
    guard.onAbort(cleanup);
    guard.onAbort(cleanup);
    guard.abort('request_timeout');
    await flushCleanup();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  test('throwing and rejecting callbacks log failures without blocking later callbacks', async () => {
    const log = jest.fn();
    const guard = createRequestGuard(response(), { log, fields: { userId: 'user-1' } });
    guard.onAbort(() => { throw new Error('sync cleanup failed'); });
    guard.onAbort(() => Promise.reject(new Error('async cleanup failed')));
    const cleanup = jest.fn();
    guard.onAbort(cleanup);
    guard.abort('request_timeout');
    await flushCleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith('request_timeout');
    expect(log).toHaveBeenCalledWith('warn', 'request abandon cleanup failed', {
      userId: 'user-1', reason: 'request_timeout', error: 'sync cleanup failed',
    });
    expect(log).toHaveBeenCalledWith('warn', 'request abandon cleanup failed', {
      userId: 'user-1', reason: 'request_timeout', error: 'async cleanup failed',
    });
    expect(log).toHaveBeenCalledTimes(3);
  });

  test('a failing late callback uses the same cleanup error handling', async () => {
    const log = jest.fn();
    const guard = createRequestGuard(response(), { log });
    guard.abort('request_timeout');
    guard.onAbort(() => { throw new Error('late cleanup failed'); });
    const cleanup = jest.fn();
    guard.onAbort(cleanup);
    await flushCleanup();
    expect(cleanup).toHaveBeenCalledWith('request_timeout');
    expect(log).toHaveBeenLastCalledWith('warn', 'request abandon cleanup failed', {
      reason: 'request_timeout', error: 'late cleanup failed',
    });
  });

  test('cleanup failures are swallowed when no logger is supplied', async () => {
    const guard = createRequestGuard(response());
    guard.onAbort(() => { throw new Error('cleanup failed'); });
    guard.abort('request_timeout');
    await flushCleanup();
    expect(guard.aborted).toBe(true);
  });

  test('AE4: abort cleanup removes the tab from its group and closes the page once', async () => {
    const res = response();
    const guard = createRequestGuard(res);
    const page = { close: jest.fn(async () => {}) };
    const group = new Map([['tab-1', { page }]]);
    guard.onAbort(async () => {
      group.delete('tab-1');
      await page.close();
    });
    res.emit('close');
    guard.abort('request_timeout');
    await flushCleanup();
    expect(group.size).toBe(0);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test('a page arriving after abort is closed when cleanup registers and throwIfAborted throws', async () => {
    const res = response();
    const guard = createRequestGuard(res);
    const page = { close: jest.fn(async () => {}) };
    let resolvePage;
    const newPage = jest.fn(() => new Promise((resolve) => { resolvePage = resolve; }));
    const handler = (async () => {
      const createdPage = await newPage();
      guard.onAbort(() => createdPage.close());
      guard.throwIfAborted();
      return createdPage;
    })();
    res.emit('close');
    expect(page.close).not.toHaveBeenCalled();
    resolvePage(page);
    await expect(handler).rejects.toMatchObject({ code: 'request_abandoned', reason: 'client_disconnected' });
    await flushCleanup();
    expect(newPage).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test('dispose removes the close listener and clears pending callbacks', async () => {
    const res = response();
    const guard = createRequestGuard(res);
    const cleanup = jest.fn();
    guard.onAbort(cleanup);
    expect(res.listenerCount('close')).toBe(1);
    guard.dispose();
    guard.dispose();
    expect(res.listenerCount('close')).toBe(0);
    res.emit('close');
    expect(guard.aborted).toBe(false);
    guard.abort('request_timeout');
    await flushCleanup();
    expect(cleanup).not.toHaveBeenCalled();
  });

  test('dispose after abort preserves cleanup already scheduled by abort', async () => {
    const guard = createRequestGuard(response());
    const cleanup = jest.fn();
    guard.onAbort(cleanup);
    guard.abort('request_timeout');
    guard.dispose();
    await flushCleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
