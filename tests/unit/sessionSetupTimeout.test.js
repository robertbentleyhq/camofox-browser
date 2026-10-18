import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';

// A 1 ms bound guarantees session setup misses its deadline on a real server,
// so these tests exercise the wiring in getSession and handleRouteError.
const SETUP_STEPS = [
  'browser_launch', 'proxy_ip_lookup', 'launch_options', 'browser_start', 'google_probe',
  'proxy_assign', 'profile_load', 'profile_restore', 'context_create', 'session_hooks',
];

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function expectNothingPublished(serverUrl, userId) {
  // Give late setup work time to resolve and be cleaned up (AE2).
  await new Promise((r) => setTimeout(r, 3000));
  const tabs = await (await fetch(`${serverUrl}/tabs?userId=${userId}`)).json();
  expect(tabs.tabs).toEqual([]);
  const health = await (await fetch(`${serverUrl}/health`)).json();
  expect(health.activeSessions).toBe(0);
}

describe('session setup timeout on a real server', () => {
  let serverUrl;
  let tmpDir;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-setup-timeout-'));
    await startServer(0, {
      SESSION_SETUP_TIMEOUT_MS: '1',
      CAMOFOX_PROFILE_DIR: path.join(tmpDir, 'profiles'),
      CAMOFOX_COOKIES_DIR: path.join(tmpDir, 'cookies'),
    });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30000);

  test('POST /tabs answers a retryable 503 naming the stalled step and publishes nothing', async () => {
    const userId = `setup-timeout-tabs-${Date.now()}`;
    const { status, body } = await postJson(`${serverUrl}/tabs`, { userId, sessionKey: 'task1' });

    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'session_setup_timeout', retryable: true, recovery: 'retry' });
    expect(SETUP_STEPS).toContain(body.step);
    await expectNothingPublished(serverUrl, userId);
  }, 30000);

  test('POST /tabs/open answers the same 503 instead of the navigation-timeout path', async () => {
    const userId = `setup-timeout-open-${Date.now()}`;
    // Setup times out before the page would ever navigate, so the URL is never fetched.
    const { status, body } = await postJson(`${serverUrl}/tabs/open`, { userId, url: 'http://127.0.0.1:9/' });

    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'session_setup_timeout', retryable: true, recovery: 'retry' });
    expect(SETUP_STEPS).toContain(body.step);
    await expectNothingPublished(serverUrl, userId);
  }, 30000);
});
