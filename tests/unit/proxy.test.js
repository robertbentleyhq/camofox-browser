import {
  normalizePlaywrightProxy,
  LOCAL_PROXY_BYPASS_HOSTS,
  createProxyPool,
  buildProxyUrl,
  thordataProvider,
  genericBackconnectProvider,
  getProvider,
  registerProvider,
  shouldProbeGoogleAtLaunch,
} from '../../lib/proxy.js';

describe('normalizePlaywrightProxy', () => {
  test('decodes percent-encoded proxy credentials', () => {
    expect(normalizePlaywrightProxy({
      server: 'http://proxy.example.com:10001',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0%3DIuT',
    })).toEqual({
      server: 'http://proxy.example.com:10001',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0=IuT',
      bypass: LOCAL_PROXY_BYPASS_HOSTS,
    });
  });

  test('preserves raw credentials', () => {
    expect(normalizePlaywrightProxy({
      server: 'http://gate.proxy.com:7000',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0=IuT',
    })).toEqual({
      server: 'http://gate.proxy.com:7000',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0=IuT',
      bypass: LOCAL_PROXY_BYPASS_HOSTS,
    });
  });

  test('leaves malformed percent sequences unchanged', () => {
    expect(normalizePlaywrightProxy({
      server: 'http://proxy:1234',
      username: 'user%ZZ',
      password: 'pass%ZZ',
    })).toEqual({
      server: 'http://proxy:1234',
      username: 'user%ZZ',
      password: 'pass%ZZ',
      bypass: LOCAL_PROXY_BYPASS_HOSTS,
    });
  });

  test('passes through null proxy', () => {
    expect(normalizePlaywrightProxy(null)).toBeNull();
  });

  test('preserves an explicit proxy bypass list', () => {
    expect(normalizePlaywrightProxy({
      server: 'http://proxy:1234',
      bypass: 'internal.example.com',
    })).toEqual({
      server: 'http://proxy:1234',
      bypass: 'internal.example.com',
    });
  });
});

describe('thordataProvider', () => {
  test('builds sticky residential username with targeting', () => {
    expect(thordataProvider.buildSessionUsername('account123', {
      country: 'us',
      state: 'california',
      city: 'los angeles',
      sessionId: 'browser-abc123',
      sessionDurationMinutes: 10,
    })).toBe('td-customer-account123-country-us-state-california-city-losangeles-sessid-browserabc123-sesstime-10');
  });

  test('accepts a dashboard username with or without the provider prefix', () => {
    const options = {
      country: 'US',
      city: 'New York',
      sessionId: 'ctx:1',
    };
    expect(thordataProvider.buildSessionUsername('User Name', options))
      .toBe('td-customer-username-country-us-city-newyork-sessid-ctx1');
    expect(thordataProvider.buildSessionUsername('td-customer-User Name', options))
      .toBe('td-customer-username-country-us-city-newyork-sessid-ctx1');
  });

  test('declares capabilities', () => {
    expect(thordataProvider.canRotateSessions).toBe(true);
    expect(thordataProvider.launchRetries).toBe(1);
    expect(thordataProvider.probeGoogleAtLaunch).toBe(false);
    expect(thordataProvider.launchTimeoutMs).toBe(180000);
    expect(thordataProvider.name).toBe('thordata');
  });
});

describe('genericBackconnectProvider', () => {
  test('passes through username with session suffix', () => {
    expect(genericBackconnectProvider.buildSessionUsername('myuser', {
      sessionId: 'sess-123',
    })).toBe('myuser-sess-123');
  });

  test('returns bare username when no session', () => {
    expect(genericBackconnectProvider.buildSessionUsername('myuser', {})).toBe('myuser');
  });

  test('declares capabilities', () => {
    expect(genericBackconnectProvider.canRotateSessions).toBe(true);
    expect(genericBackconnectProvider.launchRetries).toBe(5);
    expect(genericBackconnectProvider.launchTimeoutMs).toBe(120000);
    expect(genericBackconnectProvider.name).toBe('generic');
  });
});

describe('getProvider / registerProvider', () => {
  test('returns built-in providers', () => {
    expect(getProvider('thordata')).toBe(thordataProvider);
    expect(getProvider('generic')).toBe(genericBackconnectProvider);
  });

  test('retired providers are not selectable', () => {
    expect(getProvider('dataimpulse')).toBeNull();
    expect(getProvider('decodo')).toBeNull();
  });

  test('returns null for unknown provider', () => {
    expect(getProvider('nonexistent')).toBeNull();
  });

  test('registers custom provider', () => {
    const custom = {
      name: 'brightdata',
      canRotateSessions: true,
      launchRetries: 3,
      launchTimeoutMs: 90000,
      buildSessionUsername: (base, opts) => `${base}_${opts.sessionId || 'default'}`,
      buildProxyUrl: () => null,
    };
    registerProvider('brightdata', custom);
    expect(getProvider('brightdata')).toBe(custom);
  });
});

describe('shouldProbeGoogleAtLaunch', () => {
  test('skips the launch-wide Google probe for Thordata', () => {
    expect(shouldProbeGoogleAtLaunch({
      canRotateSessions: true,
      probeGoogleAtLaunch: false,
    })).toBe(false);
  });

  test('keeps the launch probe for rotating providers that opt in', () => {
    expect(shouldProbeGoogleAtLaunch({
      canRotateSessions: true,
      probeGoogleAtLaunch: true,
    })).toBe(true);
  });
});

describe('createProxyPool', () => {
  test('returns null when no host for round robin', () => {
    expect(createProxyPool({ strategy: 'round_robin', host: '', ports: [10001], username: 'u', password: 'p' })).toBeNull();
  });

  test('returns null when no ports for round robin', () => {
    expect(createProxyPool({ strategy: 'round_robin', host: 'proxy.example.com', ports: [], username: 'u', password: 'p' })).toBeNull();
  });

  test('single port pool', () => {
    const pool = createProxyPool({ strategy: 'round_robin', host: 'proxy.example.com', ports: [7000], username: 'u', password: 'p' });
    expect(pool).not.toBeNull();
    expect(pool.mode).toBe('round_robin');
    expect(pool.canRotateSessions).toBe(false);
    expect(pool.launchRetries).toBe(1);
    expect(pool.launchTimeoutMs).toBe(60000);
    expect(pool.size).toBe(1);
    expect(pool.getLaunchProxy()).toEqual({ server: 'http://proxy.example.com:7000', username: 'u', password: 'p' });
  });

  test('multi-port round-robin', () => {
    const pool = createProxyPool({ strategy: 'round_robin', host: 'proxy.example.com', ports: [10001, 10002, 10003], username: 'u', password: 'p' });
    expect(pool.size).toBe(3);
    expect(pool.getLaunchProxy().server).toBe('http://proxy.example.com:10001');
    expect(pool.getNext().server).toBe('http://proxy.example.com:10001');
    expect(pool.getNext().server).toBe('http://proxy.example.com:10002');
    expect(pool.getNext().server).toBe('http://proxy.example.com:10003');
    expect(pool.getNext().server).toBe('http://proxy.example.com:10001');
  });

  test('backconnect pool with thordata provider (default)', () => {
    const pool = createProxyPool({
      strategy: 'backconnect',
      backconnectHost: 't.pr.thordata.net',
      backconnectPort: 9999,
      username: 'account123',
      password: 'p',
      country: 'us',
      state: 'california',
      sessionDurationMinutes: 10,
    });

    expect(pool.mode).toBe('backconnect');
    expect(pool.canRotateSessions).toBe(true);
    expect(pool.launchRetries).toBe(1);
    expect(pool.probeGoogleAtLaunch).toBe(false);
    expect(pool.launchTimeoutMs).toBe(180000);
    expect(pool.provider).toBe(thordataProvider);

    const launch = pool.getLaunchProxy('browser-1');
    expect(launch.server).toBe('http://t.pr.thordata.net:9999');
    expect(launch.username).toBe('td-customer-account123-country-us-state-california-sessid-browser1-sesstime-10');
    expect(launch.password).toBe('p');

    const next = pool.getNext('ctx-1');
    expect(next.username).toBe('td-customer-account123-country-us-state-california-sessid-ctx1-sesstime-10');
  });

  test('backconnect pool with explicit generic provider', () => {
    const pool = createProxyPool({
      strategy: 'backconnect',
      providerName: 'generic',
      backconnectHost: 'proxy.brightdata.com',
      backconnectPort: 22225,
      username: 'brd-customer-123',
      password: 'secret',
    });

    expect(pool.mode).toBe('backconnect');
    expect(pool.canRotateSessions).toBe(true);
    expect(pool.provider).toBe(genericBackconnectProvider);
    expect(pool.launchRetries).toBe(5);

    const launch = pool.getLaunchProxy('browser-1');
    expect(launch.server).toBe('http://proxy.brightdata.com:22225');
    expect(launch.username).toBe('brd-customer-123-browser-1');
  });

  test('rejects a configured retired or unknown provider instead of falling back', () => {
    expect(() => createProxyPool({
      strategy: 'backconnect',
      backconnectHost: 'proxy.example.com',
      backconnectPort: 9999,
      username: 'account',
      password: 'credential',
      providerName: 'decodo',
    })).toThrow('Unknown proxy provider "decodo"');
  });

  test('round_robin pool has null provider and no session rotation', () => {
    const pool = createProxyPool({ strategy: 'round_robin', host: 'proxy.example.com', ports: [8080], username: 'u', password: 'p' });
    expect(pool.provider).toBeNull();
    expect(pool.canRotateSessions).toBe(false);
  });
});

describe('buildProxyUrl', () => {
  test('returns null when pool is null', () => {
    expect(buildProxyUrl(null, {})).toBeNull();
  });

  test('builds backconnect proxy URL via provider', () => {
    const config = {
      strategy: 'backconnect',
      username: 'account123',
      password: 'u4q4iklLj3Jof0=IuT',
      backconnectHost: 't.pr.thordata.net',
      backconnectPort: 9999,
      country: 'us',
    };
    const pool = createProxyPool(config);
    const url = buildProxyUrl(pool, config);
    expect(url).toMatch(/^http:\/\/td-customer-account123.*@t\.pr\.thordata\.net:9999$/);
    expect(url).toContain(encodeURIComponent('u4q4iklLj3Jof0=IuT'));
  });

  test('builds round_robin proxy URL', () => {
    const config = {
      strategy: 'round_robin',
      host: 'us.proxy.com',
      ports: [10001, 10002],
      username: 'myuser',
      password: 'mypass',
    };
    const pool = createProxyPool(config);
    const url = buildProxyUrl(pool, config);
    expect(url).toBe('http://myuser:mypass@us.proxy.com:10001');
  });

  test('round_robin without auth', () => {
    const config = {
      strategy: 'round_robin',
      host: 'proxy.local',
      ports: [8080],
      username: '',
      password: '',
    };
    const pool = createProxyPool(config);
    const url = buildProxyUrl(pool, config);
    expect(url).toBe('http://proxy.local:8080');
  });

  test('returns null for backconnect pool with missing password', () => {
    const config = {
      strategy: 'backconnect',
      username: 'user',
      password: '',
      backconnectHost: 'gate.proxy.com',
      backconnectPort: 7000,
    };
    const pool = createProxyPool(config);
    expect(pool).toBeNull();
    expect(buildProxyUrl(pool, config)).toBeNull();
  });
});
