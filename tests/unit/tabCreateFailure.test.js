import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';

// A create that fails after the tab is registered never returns a tabId, so the
// caller cannot close that tab. The route must close it before answering.
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function tabsFor(serverUrl, userId) {
  // Cleanup runs in a microtask after the error reply, so wait briefly first.
  await new Promise((r) => setTimeout(r, 500));
  return (await (await fetch(`${serverUrl}/tabs?userId=${userId}`)).json()).tabs;
}

describe('failed tab create on a real server', () => {
  let serverUrl;
  let tmpDir;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-tab-fail-'));
    await startServer(0, {
      CAMOFOX_PROFILE_DIR: path.join(tmpDir, 'profiles'),
      CAMOFOX_COOKIES_DIR: path.join(tmpDir, 'cookies'),
    });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30000);

  test('POST /tabs closes the tab when the initial navigation fails', async () => {
    const userId = `tab-fail-tabs-${Date.now()}`;
    // Port 9 refuses connections, so navigation fails fast with no proxy retry.
    const { status } = await postJson(`${serverUrl}/tabs`, { userId, sessionKey: 'task1', url: 'http://127.0.0.1:9/' });

    expect(status).toBeGreaterThanOrEqual(400);
    expect(await tabsFor(serverUrl, userId)).toEqual([]);
  }, 60000);

  test('POST /tabs/open closes the tab when navigation fails', async () => {
    const userId = `tab-fail-open-${Date.now()}`;
    const { status } = await postJson(`${serverUrl}/tabs/open`, { userId, url: 'http://127.0.0.1:9/' });

    expect(status).toBeGreaterThanOrEqual(400);
    expect(await tabsFor(serverUrl, userId)).toEqual([]);
  }, 60000);
});
