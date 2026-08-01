import crypto from 'crypto';

export const LOCAL_PROXY_BYPASS_HOSTS = 'localhost,127.0.0.1,::1';

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function decodeProxyCredential(value) {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizePlaywrightProxy(proxy) {
  if (!proxy) return proxy;
  return {
    ...proxy,
    username: decodeProxyCredential(proxy.username),
    password: decodeProxyCredential(proxy.password),
    bypass: proxy.bypass || LOCAL_PROXY_BYPASS_HOSTS,
  };
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function makeSessionId(prefix = 'sess') {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------
//
// A proxy provider shapes credentials and declares capabilities.
//
//   {
//     name:              string   -- e.g. 'thordata', 'brightdata', 'generic'
//     canRotateSessions: bool     -- per-context session rotation supported
//     probeGoogleAtLaunch: bool   -- whether startup must seek a Google-clean exit
//     launchRetries:     number   -- how many browser launch attempts
//     launchTimeoutMs:   number   -- per-attempt timeout
//     buildSessionUsername(baseUsername, options) -> string
//     buildProxyUrl(proxy, config) -> string | null
//   }
//
// options: { country, state, city, zip, sessionId, sessionDurationMinutes }
// ---------------------------------------------------------------------------

function sanitizeThordataValue(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Thordata residential proxy provider.
 * Username DSL: td-customer-{base}-country-{cc}-state-{st}-city-{city}-sessid-{id}-sesstime-{min}
 */
export const thordataProvider = {
  name: 'thordata',
  canRotateSessions: true,
  probeGoogleAtLaunch: false,
  launchRetries: 1,
  launchTimeoutMs: 180000,

  buildSessionUsername(baseUsername, options = {}) {
    const unprefixed = String(baseUsername || '').trim().replace(/^td-customer-/i, '');
    const username = sanitizeThordataValue(unprefixed);
    if (!username) return '';

    const parts = [`td-customer-${username}`];
    const country = sanitizeThordataValue(options.country);
    const state = sanitizeThordataValue(options.state);
    const city = sanitizeThordataValue(options.city);
    const sessionId = sanitizeThordataValue(options.sessionId);
    const sessionDurationMinutes = Number.isFinite(options.sessionDurationMinutes)
      ? Math.max(1, Math.min(90, Math.trunc(options.sessionDurationMinutes)))
      : null;

    if (country) parts.push(`country-${country}`);
    if (state) parts.push(`state-${state}`);
    if (city) parts.push(`city-${city}`);
    if (sessionId) parts.push(`sessid-${sessionId}`);
    if (sessionDurationMinutes) parts.push(`sesstime-${sessionDurationMinutes}`);

    return parts.join('-');
  },

  buildProxyUrl(proxy, config) {
    if (!proxy?.username || !config?.password) return null;
    const user = encodeURIComponent(proxy.username);
    const pass = encodeURIComponent(config.password);
    const host = config.backconnectHost;
    const port = config.backconnectPort;
    return `http://${user}:${pass}@${host}:${port}`;
  },
};

/**
 * Generic backconnect provider -- no username rewriting, just pass-through.
 * Works with any SOCKS/HTTP proxy that supports sticky sessions via
 * separate session IDs in the username field (e.g. BrightData, Oxylabs).
 */
export const genericBackconnectProvider = {
  name: 'generic',
  canRotateSessions: true,
  launchRetries: 5,
  launchTimeoutMs: 120000,

  buildSessionUsername(baseUsername, options = {}) {
    // Simple pass-through: base username + session suffix
    const base = String(baseUsername || '').trim();
    const sessionId = options.sessionId ? `-${String(options.sessionId).trim()}` : '';
    return `${base}${sessionId}`;
  },

  buildProxyUrl(proxy, config) {
    if (!proxy?.username || !config?.password) return null;
    const user = encodeURIComponent(proxy.username);
    const pass = encodeURIComponent(config.password);
    const host = config.backconnectHost;
    const port = config.backconnectPort;
    return `http://${user}:${pass}@${host}:${port}`;
  },
};

// Provider registry
const providers = {
  thordata: thordataProvider,
  generic: genericBackconnectProvider,
};

export function getProvider(name) {
  return providers[name] || null;
}

export function shouldProbeGoogleAtLaunch(proxyPool) {
  return Boolean(proxyPool?.canRotateSessions && proxyPool.probeGoogleAtLaunch);
}

export function registerProvider(name, provider) {
  providers[name] = provider;
}

// ---------------------------------------------------------------------------
// Proxy pool factory
// ---------------------------------------------------------------------------

function buildBackconnectProxy(config, provider, sessionId) {
  const username = provider.buildSessionUsername(config.username, {
    country: config.country,
    state: config.state,
    city: config.city,
    zip: config.zip,
    sessionId,
    sessionDurationMinutes: config.sessionDurationMinutes,
  });

  return {
    server: `http://${config.backconnectHost}:${config.backconnectPort}`,
    username,
    password: config.password,
    sessionId,
  };
}

/**
 * Create proxy strategy helpers.
 * - round_robin: per-context port rotation across a fixed pool
 * - backconnect: residential backconnect endpoint with sticky sessions (provider-shaped)
 */
export function createProxyPool(config) {
  const {
    strategy = 'round_robin',
    host,
    ports,
    username,
    password,
    backconnectHost,
    backconnectPort,
    providerName,
  } = config;

  if (strategy === 'backconnect') {
    if (!backconnectHost || !backconnectPort || !username || !password) return null;

    const provider = providerName ? getProvider(providerName) : thordataProvider;
    if (!provider) throw new Error(`Unknown proxy provider "${providerName}"`);

    return {
      mode: 'backconnect',
      provider,
      canRotateSessions: provider.canRotateSessions,
      probeGoogleAtLaunch: provider.probeGoogleAtLaunch !== false,
      launchRetries: provider.launchRetries,
      launchTimeoutMs: provider.launchTimeoutMs,
      size: 1,

      getLaunchProxy(sessionId = makeSessionId('browser')) {
        return buildBackconnectProxy(config, provider, sessionId);
      },

      getNext(sessionId = makeSessionId('ctx')) {
        return buildBackconnectProxy(config, provider, sessionId);
      },
    };
  }

  // round_robin -- no session rotation, single attempt
  if (!host || !ports || ports.length === 0) return null;

  let index = 0;

  function makeProxy(port) {
    return {
      server: `http://${host}:${port}`,
      username,
      password,
    };
  }

  return {
    mode: 'round_robin',
    provider: null,
    canRotateSessions: false,
    launchRetries: 1,
    launchTimeoutMs: 60000,
    size: ports.length,

    getLaunchProxy() {
      return makeProxy(ports[0]);
    },

    getNext() {
      const port = ports[index % ports.length];
      index++;
      return makeProxy(port);
    },
  };
}

// ---------------------------------------------------------------------------
// URL builder (for CLI tools like yt-dlp)
// ---------------------------------------------------------------------------

/**
 * Build a proxy URL string (http://user:pass@host:port) suitable for
 * CLI tools like yt-dlp --proxy.
 */
export function buildProxyUrl(pool, config) {
  if (!pool) return null;

  if (pool.mode === 'backconnect') {
    const proxy = pool.getLaunchProxy(makeSessionId('ytdlp'));
    if (pool.provider?.buildProxyUrl) {
      return pool.provider.buildProxyUrl(proxy, config);
    }
    // Fallback for pools without provider
    if (!proxy?.username || !config?.password) return null;
    const user = encodeURIComponent(proxy.username);
    const pass = encodeURIComponent(config.password);
    return `http://${user}:${pass}@${config.backconnectHost}:${config.backconnectPort}`;
  }

  // round_robin -- pick the first port
  if (!config?.host || !config?.ports?.length) return null;
  const user = config.username ? encodeURIComponent(config.username) : '';
  const pass = config.password ? encodeURIComponent(config.password) : '';
  const auth = user ? `${user}:${pass}@` : '';
  return `http://${auth}${config.host}:${config.ports[0]}`;
}
