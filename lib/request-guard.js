export class RequestAbandonedError extends Error {
  constructor(reason) {
    super(`request abandoned: ${reason}`);
    this.name = 'RequestAbandonedError';
    this.code = 'request_abandoned';
    this.reason = reason;
  }
}

export function isRequestAbandonedError(err) {
  return err instanceof RequestAbandonedError || err?.code === 'request_abandoned';
}

export function createRequestGuard(res, { log, fields = {} } = {}) {
  let aborted = false;
  let reason = null;
  const callbacks = new Set();

  function schedule(callback) {
    Promise.resolve().then(() => {
      if (!callback.active) return;
      callback.active = false;
      return callback.fn(reason);
    }).catch((err) => {
      log?.('warn', 'request abandon cleanup failed', { ...fields, reason, error: err.message });
    });
  }

  const guard = {
    get aborted() { return aborted; },
    get reason() { return reason; },

    abort(abortReason) {
      if (aborted) return;
      aborted = true;
      reason = abortReason;
      log?.('warn', 'request abandoned', { ...fields, reason });
      for (const callback of callbacks) schedule(callback);
      callbacks.clear();
    },

    onAbort(fn) {
      const callback = { fn, active: true };
      if (aborted) schedule(callback);
      else callbacks.add(callback);
      return () => {
        callback.active = false;
        callbacks.delete(callback);
      };
    },

    throwIfAborted() {
      if (aborted) throw new RequestAbandonedError(reason);
    },

    dispose() {
      res.removeListener('close', onClose);
      callbacks.clear();
    },
  };

  function onClose() {
    if (!res.writableFinished) guard.abort('client_disconnected');
  }

  res.on('close', onClose);
  return guard;
}
