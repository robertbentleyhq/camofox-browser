import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { getUserPersistencePaths } from '../../lib/persistence.js';

// The persistence plugin's session:created hook reads the bootstrap cookie file
// when a user has no saved profile. Making that file a FIFO with no writer stalls
// the hook until the test opens it, so setup times out inside session_hooks with
// a real server and the real plugin.
const SETUP_TIMEOUT_MS = 15000;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function activeSessions(serverUrl) {
  return (await (await fetch(`${serverUrl}/health`)).json()).activeSessions;
}

async function tabsFor(serverUrl, userId) {
  return (await (await fetch(`${serverUrl}/tabs?userId=${userId}`)).json()).tabs;
}

// Opening the write end gives the stalled hook (the reader) its EOF. The open is
// non-blocking: a blocking open with no reader parks a libuv thread in open(2)
// for good, and Node's exit then waits on that thread, so jest never exits.
async function releaseFifo(fifoPath) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      return;
    } catch (err) {
      if (err.code !== 'ENXIO' || Date.now() > deadline) throw new Error(`no reader on the FIFO: ${err.code}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

const describeFifo = process.platform === 'win32' ? describe.skip : describe;

describeFifo('session setup timeout inside session_hooks on a real server', () => {
  let serverUrl;
  let tmpDir;
  let profileDir;
  let fifoPath;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-hooks-timeout-'));
    profileDir = path.join(tmpDir, 'profiles');
    const cookiesDir = path.join(tmpDir, 'cookies');
    fs.mkdirSync(cookiesDir, { recursive: true });
    fifoPath = path.join(cookiesDir, 'cookies.txt');
    execFileSync('mkfifo', [fifoPath]);
    await startServer(0, {
      SESSION_SETUP_TIMEOUT_MS: String(SETUP_TIMEOUT_MS),
      CAMOFOX_PROFILE_DIR: profileDir,
      CAMOFOX_COOKIES_DIR: cookiesDir,
    });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await releaseFifo(fifoPath).catch(() => {});
    await stopServer();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30000);

  test('the timed-out session is retracted at once and its late cleanup spares the retry', async () => {
    const userId = `hooks-timeout-${Date.now()}`;
    const first = await postJson(`${serverUrl}/tabs`, { userId, sessionKey: 'task1' });
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ code: 'session_setup_timeout', step: 'session_hooks', retryable: true });

    // The hook is still stalled, yet nothing from the timed-out setup is published.
    expect(await activeSessions(serverUrl)).toBe(0);
    expect(await tabsFor(serverUrl, userId)).toEqual([]);

    // Give the user a saved profile so the retry's hook skips the stalled cookie read.
    const { userDir, storageStatePath } = getUserPersistencePaths(profileDir, userId);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));

    const retry = await postJson(`${serverUrl}/tabs`, { userId, sessionKey: 'task1' });
    expect(retry.status).toBe(200);
    expect(retry.body.tabId).toBeTruthy();

    // Let the first setup's hook finish; its late cleanup must not touch the retry.
    await releaseFifo(fifoPath);
    await new Promise((r) => setTimeout(r, 2000));
    const tabs = await tabsFor(serverUrl, userId);
    expect(tabs.map((t) => t.tabId)).toEqual([retry.body.tabId]);
    expect(await activeSessions(serverUrl)).toBe(1);
  }, SETUP_TIMEOUT_MS + 60000);
});
