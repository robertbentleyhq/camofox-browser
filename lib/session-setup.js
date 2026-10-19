export class SessionSetupTimeoutError extends Error {
  constructor({ step, elapsedMs, timeoutMs, timings }) {
    super(`session setup timed out after ${timeoutMs}ms during ${step}`);
    this.name = 'SessionSetupTimeoutError';
    this.code = 'session_setup_timeout';
    this.statusCode = 503;
    this.step = step;
    this.elapsedMs = elapsedMs;
    this.timeoutMs = timeoutMs;
    this.timings = { ...timings };
    this.retryable = true;
  }
}

export class SessionSetupAbandonedError extends Error {
  constructor(step) {
    super(`session setup abandoned during ${step}`);
    this.name = 'SessionSetupAbandonedError';
    this.code = 'session_setup_abandoned';
    this.step = step;
  }
}

export function createSetupTracker({ timeoutMs, log, fields = {} }) {
  let abandoned = false;
  let activeStep = null;
  let activeSubStep = null;
  let started = false;
  const timings = {};
  const abandonListeners = [];

  const tracker = {
    get abandoned() { return abandoned; },
    get activeStep() { return activeStep; },
    get timings() { return { ...timings }; },

    // Runs fn synchronously when the deadline fires, while the stalled step is still
    // pending, so callers can retract work they already published.
    onAbandon(fn) {
      abandonListeners.push(fn);
    },

    async step(name, fn, { onLate, subStep } = {}) {
      if (abandoned) throw new SessionSetupAbandonedError(name);
      activeStep = name;
      activeSubStep = subStep;
      const startedAt = Date.now();

      try {
        const result = await fn();
        if (abandoned) {
          if (onLate) {
            try {
              await onLate(result);
            } catch (err) {
              log('warn', 'session setup late cleanup failed', {
                ...fields, step: name, error: err.message,
              });
            }
          }
          throw new SessionSetupAbandonedError(name);
        }

        const ms = Date.now() - startedAt;
        timings[name] = ms;
        log('info', 'session setup step', { ...fields, step: name, ms });
        return result;
      } catch (err) {
        if (abandoned) throw new SessionSetupAbandonedError(name);
        throw err;
      } finally {
        activeStep = null;
        activeSubStep = null;
      }
    },

    async run(fn) {
      if (started) throw new Error('session setup tracker can only run once');
      started = true;
      const startedAt = Date.now();
      let timer;
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          abandoned = true;
          for (const listener of abandonListeners) {
            try {
              listener();
            } catch (err) {
              log('warn', 'session setup abandon listener failed', { ...fields, error: err.message });
            }
          }
          const step = activeSubStep?.() || activeStep || 'unknown';
          const elapsedMs = Date.now() - startedAt;
          const finishedTimings = { ...timings };
          log('warn', 'session setup timed out', {
            ...fields, step, elapsedMs, timeoutMs, timings: finishedTimings,
          });
          reject(new SessionSetupTimeoutError({
            step, elapsedMs, timeoutMs, timings: finishedTimings,
          }));
        }, timeoutMs);
      });
      const attempt = (async () => fn(tracker))();
      attempt.catch(() => {});

      try {
        return await Promise.race([attempt, deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  return tracker;
}

export function tabCreateBudgetMs({ requestTimeoutMs, setupTimeoutMs, handlerTimeoutMs }) {
  return Math.max(requestTimeoutMs, setupTimeoutMs + handlerTimeoutMs);
}
