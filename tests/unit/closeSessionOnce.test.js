import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPluginEvents } from '../../lib/plugins.js';

// Runs the real closeSession from server.js with stubbed collaborators. A setup that
// times out tears its session down late, after the stalled hook settles; by then
// DELETE /sessions or idle cleanup may already have closed that session.
const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '../../server.js'), 'utf8');

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`${signature} not found in server.js`);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(') {', start)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${signature} has no closing brace`);
}

function loadCloseSession(deps) {
  const body = [
    extractFunction(serverSrc, 'function closeSession('),
    extractFunction(serverSrc, 'async function closeSessionNow('),
  ].join('\n');
  const names = Object.keys(deps);
  return new Function(...names, `${body}\nreturn closeSession;`)(...names.map((n) => deps[n]));
}

describe('closeSession', () => {
  function setup() {
    const pluginEvents = createPluginEvents();
    const destroyed = [];
    pluginEvents.on('session:destroyed', ({ userId, reason }) => destroyed.push({ userId, reason }));
    const sessions = new Map();
    const closeSession = loadCloseSession({
      pluginEvents,
      sessions,
      normalizeUserId: String,
      clearSessionLocks: () => {},
      clearSessionDownloads: async () => {},
      refreshActiveTabsGauge: () => {},
      log: () => {},
    });
    let closed = false;
    const session = {
      context: { close: async () => { await new Promise((r) => setTimeout(r, 20)); closed = true; } },
      tabGroups: new Map(),
    };
    sessions.set('u1', session);
    return { closeSession, destroyed, sessions, session, isClosed: () => closed };
  }

  test('a second close of the same session emits no second session:destroyed', async () => {
    const { closeSession, destroyed, session } = setup();
    await closeSession('u1', session, { reason: 'user_delete' });
    await closeSession('u1', session, { reason: 'session_setup_timeout' });
    expect(destroyed).toEqual([{ userId: 'u1', reason: 'user_delete' }]);
  });

  test('concurrent closes emit session:destroyed once and both wait for the close', async () => {
    const { closeSession, destroyed, sessions, session, isClosed } = setup();
    const first = closeSession('u1', session, { reason: 'user_delete' });
    // A second caller (e.g. a Google rotation) must not get back control, and then
    // reuse the session, while the first close is still running.
    await closeSession('u1', session, { reason: 'google_rotate_context' });
    expect(isClosed()).toBe(true);
    expect(sessions.has('u1')).toBe(false);
    await first;
    expect(destroyed).toHaveLength(1);
  });

  test('closing an old session keeps a replacement stored under the same user', async () => {
    const { closeSession, sessions, session } = setup();
    const replacement = { context: { close: async () => {} }, tabGroups: new Map() };
    sessions.set('u1', replacement);
    await closeSession('u1', session, { reason: 'session_setup_timeout' });
    expect(sessions.get('u1')).toBe(replacement);
  });
});
