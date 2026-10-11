// Capacity routing: who receives chats, and how many.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, MIN } from './helpers.js';

after(teardown);

test('100 chats over 4 ready agents: exactly 25 each, nobody over the cap', async () => {
  const t = await setup();
  const agents = [];
  for (const n of ['Ahmed', 'Sara', 'Omar', 'Mona']) agents.push(await t.agent(n));
  for (let i = 0; i < 100; i++) await t.handoff();
  const loads = await t.loads();
  for (const a of agents) assert.equal(loads[a.user.id], 25, `${a.user.full_name} should hold 25`);
  const { n } = await t.db.one(`SELECT count(*)::int AS n FROM desk.conversations WHERE status = 'queued'`);
  assert.equal(n, 0);
});

test('100 chats over 5 ready agents: 20 each', async () => {
  const t = await setup();
  const agents = [];
  for (const n of ['A1', 'A2', 'A3', 'A4', 'A5']) agents.push(await t.agent(n));
  for (let i = 0; i < 100; i++) await t.handoff();
  const loads = await t.loads();
  for (const a of agents) assert.equal(loads[a.user.id], 20);
});

test('more chats than capacity: the rest wait, then go out oldest-first as room frees up', async () => {
  const t = await setup();
  const agents = [];
  for (const n of ['B1', 'B2', 'B3']) agents.push(await t.agent(n));
  const ids = [];
  for (let i = 0; i < 100; i++) {
    ids.push((await t.handoff()).conversation_id);
    await t.advance(1000); // each chat a second apart, so "oldest" is well defined
  }
  let loads = await t.loads();
  for (const a of agents) assert.equal(loads[a.user.id], 25);
  const queued = await t.db.q(`SELECT id FROM desk.conversations WHERE status = 'queued' ORDER BY id`);
  assert.equal(queued.length, 25);

  // B1 replies to and resolves one chat: the oldest waiting chat goes to B1.
  const mine = await t.db.one(
    `SELECT id FROM desk.conversations WHERE assigned_to = $1 ORDER BY id LIMIT 1`, [agents[0].user.id],
  );
  await t.reply(agents[0], mine.id);
  await t.desk.close(agents[0], mine.id);
  const first = await t.conv(queued[0].id);
  assert.equal(first.status, 'assigned');
  assert.equal(first.assigned_to, agents[0].user.id);
  loads = await t.loads();
  assert.equal(loads[agents[0].user.id], 25, 'still never above 25');
});

test('a 4th agent pressing Ready picks up the waiting chats', async () => {
  const t = await setup();
  for (const n of ['C1', 'C2', 'C3']) await t.agent(n);
  for (let i = 0; i < 90; i++) await t.handoff();
  const late = await t.agent('C4', { ready: false });
  let loads = await t.loads();
  assert.equal(loads[late.user.id], undefined, 'Not ready receives nothing');
  await t.desk.setStatus(late, 'ready');
  loads = await t.loads();
  assert.equal(loads[late.user.id], 15);
});

test('Not ready, logged-out and disconnected agents receive nothing', async () => {
  const t = await setup();
  const ready = await t.agent('Ready One');
  const notReady = await t.agent('Busy Two', { ready: false });
  const gone = await t.agent('Gone Three');
  await t.desk.logout(gone);
  const dropped = await t.agent('Dropped Four');
  dropped.dead = true; // stops sending heartbeats
  await t.advance(2 * MIN); // past the 90-second disconnect limit
  for (let i = 0; i < 10; i++) await t.handoff();
  const loads = await t.loads();
  assert.equal(loads[ready.user.id], 10);
  assert.equal(loads[notReady.user.id], undefined);
  assert.equal(loads[gone.user.id], undefined);
  assert.equal(loads[dropped.user.id], undefined);
  const st = await t.db.one('SELECT status, status_reason FROM desk.agent_state WHERE user_id = $1', [dropped.user.id]);
  assert.equal(st.status, 'offline');
  assert.equal(st.status_reason, 'disconnected');
});

test('per-agent cap override is respected', async () => {
  const t = await setup();
  const junior = await t.agent('Junior', { max_chats: 5 });
  const senior = await t.agent('Senior');
  for (let i = 0; i < 40; i++) await t.handoff();
  const loads = await t.loads();
  assert.equal(loads[junior.user.id], 5);
  assert.equal(loads[senior.user.id], 25);
  const { n } = await t.db.one(`SELECT count(*)::int AS n FROM desk.conversations WHERE status = 'queued'`);
  assert.equal(n, 10);
});

test('logout hands every chat back to the team; nothing is lost', async () => {
  const t = await setup();
  const a = await t.agent('Leaving');
  const b = await t.agent('Staying');
  for (let i = 0; i < 20; i++) await t.handoff();
  assert.deepEqual(Object.values(await t.loads()).sort(), [10, 10]);
  await t.desk.logout(a);
  const loads = await t.loads();
  assert.equal(loads[b.user.id], 20);
  assert.equal(loads[a.user.id], undefined);
  const sess = await t.db.one('SELECT checked_out_at, checkout_reason FROM desk.sessions WHERE id = $1', [a.session.id]);
  assert.ok(sess.checked_out_at);
  assert.equal(sess.checkout_reason, 'logout');
});

test('a dropped connection returns only the customers who are waiting; reconnecting comes back Not ready', async () => {
  const t = await setup();
  const a = await t.agent('Wifi Drop');
  const b = await t.agent('Solid');
  const c1 = (await t.handoff()).conversation_id; // a
  const c2 = (await t.handoff()).conversation_id; // b
  const c3 = (await t.handoff()).conversation_id; // a
  assert.equal((await t.conv(c1)).assigned_to, a.user.id);
  await t.reply(a, c1); // answered — no customer waiting
  a.dead = true;
  await t.advance(2 * MIN);
  assert.equal((await t.conv(c1)).assigned_to, a.user.id, 'answered chat stays');
  assert.equal((await t.conv(c3)).assigned_to, b.user.id, 'waiting customer moved on');
  assert.equal((await t.conv(c2)).assigned_to, b.user.id);
  a.dead = false;
  await t.desk.connected(a);
  const st = await t.db.one('SELECT status FROM desk.agent_state WHERE user_id = $1', [a.user.id]);
  assert.equal(st.status, 'not_ready');
});

test('30 minutes disconnected = checked out; the session no longer works', async () => {
  const t = await setup();
  const a = await t.agent('Laptop Closed');
  const b = await t.agent('Still Here');
  const c1 = (await t.handoff()).conversation_id;
  await t.reply(a, c1);
  a.dead = true;
  await t.advance(31 * MIN, { step: 60_000 });
  const sess = await t.db.one('SELECT checked_out_at, checkout_reason, last_seen_at FROM desk.sessions WHERE id = $1', [a.session.id]);
  assert.equal(sess.checkout_reason, 'timeout');
  assert.equal(+sess.checked_out_at, +sess.last_seen_at, 'check-out time is when they were last seen');
  assert.equal((await t.conv(c1)).assigned_to, b.user.id, 'even answered chats move after check-out');
  assert.equal(await t.desk.authenticate(a.token), null, 'must sign in again');
});
