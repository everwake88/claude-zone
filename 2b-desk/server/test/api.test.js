// End to end over real HTTP and WebSockets: n8n hands a chat over, the agent
// sees it live, replies, and the reply reaches a (mock) n8n.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createServer } from '../src/index.js';
import { sharedDb, teardown } from './helpers.js';

const SECRET = 'n8n-test-secret';
let app;
let base;
let n8n;
const n8nCalls = [];

before(async () => {
  const db = await sharedDb();
  await db.q('DROP SCHEMA IF EXISTS desk CASCADE');
  // A stand-in for the "2B — Desk Outbound Sender" workflow.
  n8n = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      n8nCalls.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, external_message_id: `wamid.${n8nCalls.length}` }));
    });
  });
  await new Promise((r) => n8n.listen(0, r));
  app = await createServer({
    db,
    log: { info() {}, warn() {}, error: console.error },
    config: {
      ingestSecret: SECRET,
      n8nSendUrl: `http://127.0.0.1:${n8n.address().port}/webhook/desk-send`,
      n8nSendSecret: 'sender-secret',
      bootstrapAdmin: { username: 'boss', password: 'boss-password-1', fullName: 'Boss', employeeId: '2B-000' },
      corsOrigins: [],
    },
  });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app?.close();
  await new Promise((r) => n8n?.close(r));
  await teardown();
});

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      inbox.push(msg);
      for (const w of [...waiters]) {
        if (w.match(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token })));
    ws.on('error', reject);
    const api = {
      ws,
      inbox,
      next(match, timeout = 3000) {
        const found = inbox.find(match);
        if (found) {
          inbox.splice(inbox.indexOf(found), 1);
          return Promise.resolve(found);
        }
        return new Promise((res, rej) => {
          const w = { match, resolve: (m) => (inbox.splice(inbox.indexOf(m), 1), res(m)) };
          waiters.push(w);
          setTimeout(() => rej(new Error('timed out waiting for a socket message')), timeout);
        });
      },
    };
    api.next((m) => m.t === 'hello').then(() => resolve(api), reject);
  });
}

test('the whole loop: login, Ready, hand-off, live push, reply to n8n, resolve', async () => {
  // Admin signs in and creates an agent.
  const boss = await call('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss-password-1' } });
  assert.equal(boss.status, 200);
  const created = await call('POST', '/api/users', {
    token: boss.data.token,
    body: { full_name: 'Nour Ali', username: 'nour', employee_id: '2B-014', role: 'agent' },
  });
  assert.equal(created.status, 200);
  assert.match(created.data.password, /^[a-z]+-[a-z]+-\d{4}$/, 'a first password is generated');

  const wrong = await call('POST', '/api/auth/login', { body: { username: 'nour', password: 'nope-nope' } });
  assert.equal(wrong.status, 401);

  const login = await call('POST', '/api/auth/login', { body: { username: 'NOUR', password: created.data.password } });
  assert.equal(login.status, 200, 'usernames are not case sensitive');
  const token = login.data.token;
  const me = await call('GET', '/api/me', { token });
  assert.equal(me.data.user.employee_id, '2B-014');
  assert.equal(me.data.state.status, 'not_ready', 'starts Not ready');
  assert.ok(me.data.session.checked_in_at, 'check-in recorded');
  assert.equal(me.data.settings.max_chats, 25);
  assert.equal(me.data.user.password_hash, undefined);

  const sock = await openSocket(token);
  await call('POST', '/api/me/status', { token, body: { status: 'ready' } });
  await sock.next((m) => m.t === 'me' && m.state.status === 'ready');

  // n8n: wrong secret, then a real hand-off.
  const denied = await call('POST', '/api/ingest/handoff', {
    body: { channel: 'whatsapp', external_id: '201001112223@s.whatsapp.net' },
    headers: { 'x-desk-secret': 'wrong' },
  });
  assert.equal(denied.status, 401);
  const handoff = await call('POST', '/api/ingest/handoff', {
    headers: { 'x-desk-secret': SECRET },
    body: [{
      channel: 'whatsapp', external_id: '201001112223@s.whatsapp.net', customer_ref: '77',
      customer_name: 'Youssef', category: 'sales', summary: 'Ready to buy Lenovo LOQ, wants installments',
      history: [{ role: 'customer', text: 'عايز اللابتوب ده بالتقسيط' }],
    }],
  });
  assert.equal(handoff.status, 200);
  assert.equal(handoff.data.human_active, true);
  const id = handoff.data.conversation_id;

  const assigned = await sock.next((m) => m.t === 'toast' && m.toast.kind === 'assigned');
  assert.equal(assigned.toast.conversation_id, id);
  const pushed = await sock.next((m) => m.t === 'conv' && m.conv.id === id);
  assert.equal(pushed.conv.assigned_name, 'Nour Ali');
  assert.ok(pushed.conv.hold_until);

  const list = await call('GET', '/api/conversations?scope=mine', { token });
  assert.equal(list.data.conversations.length, 1);
  const detail = await call('GET', `/api/conversations/${id}`, { token });
  assert.equal(detail.data.messages[0].body, 'عايز اللابتوب ده بالتقسيط');

  sock.ws.send(JSON.stringify({ t: 'watch', id }));
  sock.ws.send(JSON.stringify({ t: 'activity', k: 40, ms: 9000 }));

  // The customer writes again while waiting: AI must stay silent.
  const more = await call('POST', '/api/ingest/message', {
    headers: { 'x-desk-secret': SECRET },
    body: { channel: 'whatsapp', external_id: '201001112223@s.whatsapp.net', text: 'متاح؟' },
  });
  assert.equal(more.data.human_active, true);
  await sock.next((m) => m.t === 'msg' && m.msg.body === 'متاح؟');

  // The agent replies; n8n receives it with its secret.
  const sent = await call('POST', `/api/conversations/${id}/messages`, { token, body: { text: 'أيوه متاح! تحب أبعتلك التفاصيل؟' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.message.delivery, 'pending');
  const delivered = await sock.next((m) => m.t === 'msg' && m.msg.id === sent.data.message.id && m.msg.delivery === 'sent');
  assert.ok(delivered);
  assert.equal(n8nCalls.length, 1);
  assert.equal(n8nCalls[0].headers['x-desk-secret'], 'sender-secret');
  assert.equal(n8nCalls[0].body.phone, '201001112223');
  assert.equal(n8nCalls[0].body.text, 'أيوه متاح! تحب أبعتلك التفاصيل؟');

  // Another agent cannot open this chat; an agent cannot read reports.
  const other = await call('POST', '/api/users', {
    token: boss.data.token,
    body: { full_name: 'Other Agent', username: 'other', employee_id: '2B-015', password: 'other-pass-1' },
  });
  assert.equal(other.status, 200);
  const otherLogin = await call('POST', '/api/auth/login', { body: { username: 'other', password: 'other-pass-1' } });
  const peek = await call('GET', `/api/conversations/${id}`, { token: otherLogin.data.token });
  assert.equal(peek.status, 403);
  assert.equal((await call('GET', '/api/reports/day', { token })).status, 403);
  assert.equal((await call('GET', '/api/conversations?scope=open', { token })).status, 403);

  // The supervisor sees the journey and the report.
  const j = await call('GET', `/api/conversations/${id}/journey`, { token: boss.data.token });
  assert.equal(j.status, 200);
  assert.equal(j.data.segments[0].full_name, 'Nour Ali');
  const report = await call('GET', '/api/reports/day', { token: boss.data.token });
  assert.equal(report.data.totals.new_chats, 1);
  assert.equal(report.data.totals.handled, 1);
  const csv = await call('GET', '/api/reports/day.csv', { token: boss.data.token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Nour Ali/);

  // Resolve: the AI gets the customer back.
  await call('POST', `/api/conversations/${id}/close`, { token, body: { note: 'Sent installment details' } });
  const after = await call('POST', '/api/ingest/message', {
    headers: { 'x-desk-secret': SECRET },
    body: { channel: 'whatsapp', external_id: '201001112223@s.whatsapp.net', text: 'شكرا' },
  });
  assert.equal(after.data.human_active, false);

  // Logging out ends the session (check-out) and the socket is told.
  await call('POST', '/api/auth/logout', { token });
  await sock.next((m) => m.t === 'bye');
  assert.equal((await call('GET', '/api/me', { token })).status, 401);
  sock.ws.close();
});

test('settings: only admins change them, and bad values are refused', async () => {
  const boss = await call('POST', '/api/auth/login', { body: { username: 'boss', password: 'boss-password-1' } });
  const bad = await call('PUT', '/api/settings', { token: boss.data.token, body: { first_hold_minutes: 30 } });
  assert.equal(bad.status, 400, 'first hold longer than the SLA is refused');
  const ok = await call('PUT', '/api/settings', { token: boss.data.token, body: { reminder_minutes: [4, 7, 9] } });
  assert.deepEqual(ok.data.settings.reminder_minutes, [4, 7, 9]);
  const agentLogin = await call('POST', '/api/auth/login', { body: { username: 'other', password: 'other-pass-1' } });
  const denied = await call('PUT', '/api/settings', { token: agentLogin.data.token, body: { max_chats: 99 } });
  assert.equal(denied.status, 403);
});

test('login is throttled after repeated failures', async () => {
  let last;
  for (let i = 0; i < 11; i++) {
    last = await call('POST', '/api/auth/login', { body: { username: 'ghost', password: 'wrong-password' } });
  }
  assert.equal(last.status, 429);
});

test('the dashboard is served with a strict Content-Security-Policy', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const traversal = await fetch(base + '/..%2f..%2fserver%2fpackage.json');
  assert.notEqual(traversal.status, 200);
  const unknownApi = await call('GET', '/api/nope');
  assert.equal(unknownApi.status, 404);
});
