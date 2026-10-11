// Shared test setup: a clean "desk" schema in the desk_test database, a clock
// the tests can fast-forward, and a hub that records what would be pushed.
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createSettings } from '../src/settings.js';
import { createDesk } from '../src/desk.js';
import { hashPassword } from '../src/auth.js';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/desk_test';

export const MIN = 60_000;

export function fakeClock(start = '2026-10-11T07:00:00.000Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
    set(d) {
      t = new Date(d).getTime();
    },
  };
}

export function recordingHub() {
  const sent = [];
  const rec = (kind) => (...args) => sent.push({ kind, args });
  return {
    sent,
    conv: rec('conv'),
    message: rec('message'),
    note: rec('note'),
    team: rec('team'),
    me: rec('me'),
    toUser: (userId, payload) => sent.push({ kind: 'toUser', userId, payload }),
    toSupervisors: (payload) => sent.push({ kind: 'toSupervisors', payload }),
    endSession: rec('endSession'),
    toasts(userId, kind) {
      return sent
        .filter((s) => s.kind === 'toUser' && s.userId === userId && s.payload.t === 'toast')
        .map((s) => s.payload.toast)
        .filter((t) => !kind || t.kind === kind);
    },
    clear() {
      sent.length = 0;
    },
  };
}

export function fakeOutbound() {
  const sent = [];
  let behaviour = async () => ({ ok: true, external_id: `wamid.${sent.length}` });
  return {
    sent,
    enabled: true,
    async send(payload) {
      sent.push(payload);
      return behaviour(payload);
    },
    respondWith(fn) {
      behaviour = fn;
    },
  };
}

let shared;
export async function sharedDb() {
  if (!shared) shared = createDb(TEST_DB, { max: 5 });
  return shared;
}

// Pre-hashed once: scrypt is deliberately slow and tests create many users.
let pwHash;

export async function setup({ settingsPatch = {} } = {}) {
  const db = await sharedDb();
  await db.q('DROP SCHEMA IF EXISTS desk CASCADE');
  await migrate(db, { info: () => {} });
  const settings = createSettings(db);
  if (Object.keys(settingsPatch).length) await settings.update(settingsPatch);
  const clock = fakeClock();
  const hub = recordingHub();
  const outbound = fakeOutbound();
  const quiet = { info() {}, warn() {}, error: (...a) => console.error(...a) };
  const desk = createDesk({ db, clock, hub, outbound, settings, log: quiet });
  pwHash ??= await hashPassword('password-123');

  const auths = new Map(); // userId -> auth (logged-in sessions to keep alive)

  async function addUser(name, role = 'agent', extra = {}) {
    const username = name.toLowerCase().replace(/[^a-z0-9]+/g, '.');
    const row = await db.one(
      `INSERT INTO desk.users (employee_id, username, full_name, role, password_hash, max_chats)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [`2B-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, username, name, role, pwHash, extra.max_chats ?? null],
    );
    return row;
  }

  async function login(user) {
    const { token } = await desk.login({ username: user.username, password: 'password-123' });
    const auth = await desk.authenticate(token);
    auth.token = token;
    auths.set(user.id, auth);
    return auth;
  }

  async function agent(name, { ready = true, role = 'agent', ...extra } = {}) {
    const user = await addUser(name, role, extra);
    const auth = await login(user);
    if (ready) await desk.setStatus(auth, 'ready');
    return auth;
  }

  // Move time forward in steps, keeping logged-in dashboards alive (as their
  // heartbeats would) and running the engine like the real 5-second loop.
  async function advance(ms, { step = 15_000, alive = null } = {}) {
    let left = ms;
    while (left > 0) {
      const d = Math.min(step, left);
      clock.advance(d);
      left -= d;
      for (const [uid, auth] of auths) {
        if (alive && !alive.includes(uid)) continue;
        if (!auth.dead) await desk.touch(auth);
      }
      await desk.tick();
    }
  }

  let seq = 0;
  async function handoff(extra = {}) {
    seq += 1;
    return desk.ingestHandoff({
      channel: 'whatsapp',
      external_id: `20100000${String(seq).padStart(4, '0')}@s.whatsapp.net`,
      customer_name: `Customer ${seq}`,
      category: 'sales',
      summary: 'Wants a laptop',
      ...extra,
    });
  }

  async function conv(id) {
    return db.one('SELECT * FROM desk.conversations WHERE id = $1', [id]);
  }

  async function loads() {
    const rows = await db.q(
      `SELECT assigned_to AS id, count(*)::int AS n FROM desk.conversations
        WHERE status = 'assigned' GROUP BY assigned_to`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.n]));
  }

  async function reply(auth, convId, text = 'Hello, how can I help?') {
    const { delivery } = await desk.sendReply(auth, convId, text);
    await delivery;
  }

  return { db, desk, clock, hub, outbound, settings, addUser, login, agent, advance, handoff, conv, loads, reply, auths };
}

export async function teardown() {
  if (shared) {
    await shared.end();
    shared = null;
  }
}
