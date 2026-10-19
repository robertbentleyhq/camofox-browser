import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';

// Route-level orphan-tab cleanup on a real server: a create whose client goes away,
// or whose handler budget runs out, while navigation is in flight must close its tab
// without destroying the session or the user's other tabs.
// Budget for POST /tabs = max(handler, setup + handler) = 6 s with these settings.
const HANDLER_TIMEOUT_MS = 3000;
const SESSION_SETUP_TIMEOUT_MS = 3000;

async function postTabs(serverUrl, body, signal) {
  const res = await fetch(`${serverUrl}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return { status: res.status, body: await res.json() };
}

async function tabIds(serverUrl, userId) {
  const { tabs } = await (await fetch(`${serverUrl}/tabs?userId=${userId}`)).json();
  return tabs.map((t) => t.tabId);
}

describe('abandoned tab create on a real server', () => {
  let serverUrl;
  let tmpDir;
  let slowServer;
  let slowUrl;
  let fastUrl;
  const sockets = new Set();

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-tab-abandon-'));
    // /slow never answers within the test; /fast answers at once.
    slowServer = http.createServer((req, res) => {
      if (req.url === '/fast') return res.end('<title>fast</title>');
      setTimeout(() => res.end('<title>slow</title>'), 60000).unref();
    });
    slowServer.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => slowServer.listen(0, '127.0.0.1', r));
    const { port } = slowServer.address();
    slowUrl = `http://127.0.0.1:${port}/slow`;
    fastUrl = `http://127.0.0.1:${port}/fast`;
    await startServer(0, {
      HANDLER_TIMEOUT_MS: String(HANDLER_TIMEOUT_MS),
      SESSION_SETUP_TIMEOUT_MS: String(SESSION_SETUP_TIMEOUT_MS),
      CAMOFOX_PROFILE_DIR: path.join(tmpDir, 'profiles'),
      CAMOFOX_COOKIES_DIR: path.join(tmpDir, 'cookies'),
    });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
    for (const s of sockets) s.destroy();
    await new Promise((r) => slowServer.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30000);

  // A first create can race the startup browser launch past the short setup bound.
  async function warmTab(userId) {
    for (let i = 0; i < 5; i++) {
      const { status, body } = await postTabs(serverUrl, { userId, sessionKey: 'keep', url: fastUrl });
      if (status === 200) return body.tabId;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('warm-up tab create never succeeded');
  }

  test('client disconnect during navigation closes only that tab', async () => {
    const userId = `abandon-disconnect-${Date.now()}`;
    const keepId = await warmTab(userId);

    const controller = new AbortController();
    const pending = postTabs(serverUrl, { userId, sessionKey: 'task', url: slowUrl }, controller.signal).catch((err) => err);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await tabIds(serverUrl, userId)).length).toBe(2);
    controller.abort();
    expect((await pending).name).toBe('AbortError');

    await new Promise((r) => setTimeout(r, 1000));
    expect(await tabIds(serverUrl, userId)).toEqual([keepId]);
  }, 60000);

  test('handler timeout during navigation closes the tab', async () => {
    const userId = `abandon-timeout-${Date.now()}`;
    await warmTab(userId);

    const pending = postTabs(serverUrl, { userId, sessionKey: 'task', url: slowUrl });
    await new Promise((r) => setTimeout(r, 1500));
    const during = await tabIds(serverUrl, userId);
    expect(during.length).toBe(2);
    const { status } = await pending;
    expect(status).toBeGreaterThanOrEqual(400);

    await new Promise((r) => setTimeout(r, 1000));
    const after = await tabIds(serverUrl, userId);
    expect(after.length).toBeLessThan(2);
    // The timed-out tab is the one that must be gone.
    const timedOut = during.find((id) => !after.includes(id));
    expect(timedOut).toBeTruthy();
  }, 60000);
});
