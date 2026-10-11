// The 15-minute rule: reminders, the 10-minute hand-over, 1-minute hops,
// the LATE flag, and what stops the clock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, MIN } from './helpers.js';

after(teardown);

test('reminders at 5 and 8 minutes, moved at 10, hops every minute, LATE at 15, until someone replies', async () => {
  const t = await setup();
  const ahmed = await t.agent('Ahmed');
  const { conversation_id: id } = await t.handoff();
  assert.equal((await t.conv(id)).assigned_to, ahmed.user.id);

  // Teammates join later with different loads; the hop must pick the least busy.
  const sara = await t.agent('Sara', { ready: false });
  const omar = await t.agent('Omar', { ready: false });
  const mona = await t.agent('Mona', { ready: false });

  await t.advance(4 * MIN + 50_000);
  assert.equal(t.hub.toasts(ahmed.user.id, 'reminder').length, 0, 'no reminder before 5 min');
  await t.advance(15_000);
  assert.equal(t.hub.toasts(ahmed.user.id, 'reminder').length, 1, 'first reminder at 5 min');
  await t.advance(3 * MIN);
  const reminders = t.hub.toasts(ahmed.user.id, 'reminder');
  assert.equal(reminders.length, 2, 'second reminder at 8 min');
  assert.ok(reminders[1].ms_left <= 7 * MIN && reminders[1].ms_left > 6 * MIN, 'tells how long is left');

  // Give the team different loads before the 10-minute mark.
  await t.desk.setStatus(sara, 'ready');
  await t.desk.setStatus(omar, 'ready');
  await t.desk.setStatus(mona, 'ready');
  for (let i = 0; i < 3; i++) await t.handoff(); // they spread over Sara, Omar, Mona (+ Ahmed)
  const loadsBefore = await t.loads();

  await t.advance(2 * MIN); // past 10:00
  let c = await t.conv(id);
  assert.notEqual(c.assigned_to, ahmed.user.id, 'taken from Ahmed at 10 min');
  const second = c.assigned_to;
  const minLoad = Math.min(
    ...[sara, omar, mona].map((a) => loadsBefore[a.user.id] ?? 0),
  );
  assert.equal(loadsBefore[second] ?? 0, minLoad, 'went to the least busy agent');
  const seg1 = await t.db.one(
    `SELECT * FROM desk.assignments WHERE conversation_id = $1 AND user_id = $2`, [id, ahmed.user.id],
  );
  assert.equal(seg1.end_reason, 'timeout');
  const heldMs = seg1.ended_at - seg1.started_at;
  assert.ok(heldMs >= 10 * MIN && heldMs < 10 * MIN + 20_000, `Ahmed held it ~10 min (${heldMs})`);

  // One minute later it hops again, to someone who has not had it yet.
  await t.advance(1 * MIN);
  c = await t.conv(id);
  const third = c.assigned_to;
  assert.notEqual(third, second);
  assert.notEqual(third, ahmed.user.id, 'prefers people who have not had it in this wait');
  assert.equal(c.breached_at, null, 'not late yet');

  // Past 15 minutes: LATE, and it keeps hopping.
  await t.advance(4 * MIN);
  c = await t.conv(id);
  assert.ok(c.breached_at, 'marked late');
  assert.equal(c.late_cycles, 1);
  const lateToasts = t.hub.sent.filter((s) => s.kind === 'toSupervisors' && s.payload.toast.kind === 'late');
  assert.equal(lateToasts.length, 1, 'supervisors alerted once');
  const transfers = c.transfers;
  assert.ok(transfers >= 5, `hopped every minute (${transfers} moves)`);

  // Somebody finally replies, 2 minutes late.
  await t.advance(2 * MIN);
  c = await t.conv(id);
  const holder = t.auths.get(c.assigned_to);
  await t.reply(holder, id, 'Sorry for the wait!');
  c = await t.conv(id);
  assert.equal(c.waiting_since, null, 'clock stopped');
  assert.equal(c.breached_at, null);
  const replied = await t.db.one(`SELECT data FROM desk.events WHERE type = 'replied' AND conversation_id = $1`, [id]);
  assert.ok(replied.data.late_ms >= 2 * MIN, `late by ~2+ min (${replied.data.late_ms})`);
  assert.equal(replied.data.first, true);
  const after = c.transfers;
  await t.advance(5 * MIN);
  assert.equal((await t.conv(id)).transfers, after, 'stops moving once answered');
});

test('a reply stops the clock; the next customer message gives the same agent a fresh 10 minutes', async () => {
  const t = await setup();
  const a = await t.agent('Holder');
  await t.agent('Other');
  const { conversation_id: id } = await t.handoff();
  const holder = (await t.conv(id)).assigned_to === a.user.id ? a : t.auths.get((await t.conv(id)).assigned_to);
  await t.advance(3 * MIN);
  await t.reply(holder, id);
  await t.advance(20 * MIN);
  assert.equal((await t.conv(id)).assigned_to, holder.user.id, 'answered chats never move');

  const c0 = await t.conv(id);
  await t.desk.ingestMessage({ channel: 'whatsapp', external_id: c0.external_id, text: 'Any update?' });
  let c = await t.conv(id);
  assert.ok(c.waiting_since);
  assert.equal(+c.hold_until - +c.waiting_since, 10 * MIN, 'fresh 10 minutes');
  await t.advance(9 * MIN);
  assert.equal((await t.conv(id)).assigned_to, holder.user.id);
  await t.advance(90_000);
  c = await t.conv(id);
  assert.notEqual(c.assigned_to, holder.user.id, 'moved after 10 minutes of silence');
});

test('the clock runs from the first unanswered message, not the latest one', async () => {
  const t = await setup();
  await t.agent('Solo');
  const { conversation_id: id } = await t.handoff();
  const c0 = await t.conv(id);
  await t.advance(6 * MIN);
  await t.desk.ingestMessage({ channel: 'whatsapp', external_id: c0.external_id, text: 'Hello??' });
  const c = await t.conv(id);
  assert.equal(+c.waiting_since, +c0.waiting_since);
});

test('a reply on its way protects the chat from being moved; a failed reply does not stop the clock', async () => {
  const t = await setup();
  const a = await t.agent('Typist');
  await t.agent('Backup');
  const { conversation_id: id } = await t.handoff();
  const holder = t.auths.get((await t.conv(id)).assigned_to);
  await t.advance(9 * MIN + 50_000);

  // n8n is slow: the reply takes 40 seconds to be confirmed and then fails.
  let release;
  t.outbound.respondWith(() => new Promise((r) => (release = r)));
  const { delivery } = await t.desk.sendReply(holder, id, 'On it!');
  await t.advance(20_000); // crosses the 10-minute mark while the reply is in flight
  assert.equal((await t.conv(id)).assigned_to, holder.user.id, 'not moved while sending');
  release({ ok: false, error: 'WhatsApp rejected the message' });
  await delivery;
  const failed = await t.db.one(`SELECT delivery, error FROM desk.messages WHERE sender = 'agent'`);
  assert.equal(failed.delivery, 'failed');
  let c = await t.conv(id);
  assert.ok(c.waiting_since, 'customer still waiting');
  assert.equal(t.hub.toasts(holder.user.id, 'send_failed').length, 1);
  await t.advance(30_000);
  c = await t.conv(id);
  assert.notEqual(c.assigned_to, holder.user.id, 'moves on once nothing is in flight');
  void a;
});

test('the SLA is measured to the moment Send was pressed', async () => {
  const t = await setup();
  await t.agent('Measured');
  const { conversation_id: id } = await t.handoff();
  const holder = t.auths.get((await t.conv(id)).assigned_to);
  await t.advance(14 * MIN);
  let release;
  t.outbound.respondWith(() => new Promise((r) => (release = r)));
  const { delivery } = await t.desk.sendReply(holder, id, 'Here you go');
  t.clock.advance(2 * MIN); // confirmation arrives after the 15-minute line
  release({ ok: true, external_id: 'x1' });
  await delivery;
  const ev = await t.db.one(`SELECT data FROM desk.events WHERE type = 'replied'`);
  assert.equal(ev.data.late_ms, 0, 'pressed Send at 14 min: on time');
});

test('when nobody else is free, the chat stays put and is flagged, then moves when someone frees up', async () => {
  const t = await setup({ settingsPatch: { max_chats: 1 } });
  const a = await t.agent('Full A');
  const b = await t.agent('Full B');
  const first = (await t.handoff()).conversation_id;
  const second = (await t.handoff()).conversation_id;
  const holderOfFirst = (await t.conv(first)).assigned_to;
  await t.advance(11 * MIN);
  assert.equal((await t.conv(first)).assigned_to, holderOfFirst, 'nowhere to go');
  const noTarget = await t.db.q(`SELECT 1 FROM desk.events WHERE type = 'no_target' AND conversation_id = $1`, [first]);
  assert.equal(noTarget.length, 1, 'logged once, not every minute');
  // The other agent answers and resolves their chat: room appears.
  const other = holderOfFirst === a.user.id ? b : a;
  await t.reply(other, second);
  await t.desk.close(other, second);
  await t.advance(1 * MIN);
  assert.equal((await t.conv(first)).assigned_to, other.user.id);
});

test('a chat that waited in the queue gets no stale reminders when it is finally assigned', async () => {
  const t = await setup();
  const { conversation_id: id } = await t.handoff();
  await t.advance(9 * MIN);
  const a = await t.agent('Latecomer');
  const c = await t.conv(id);
  assert.equal(c.assigned_to, a.user.id);
  assert.equal(c.reminders_sent, 2, 'both reminders already in the past');
  const toast = t.hub.toasts(a.user.id, 'assigned')[0];
  assert.ok(toast.ms_left <= 6 * MIN, 'the assignment says how little time is left');
  assert.equal(+c.hold_until, +c.assigned_at + 1 * MIN, 'first holder window already used: one hop');
});

test('a reply that lands past the SLA before the engine noticed still counts as a late wait', async () => {
  const t = await setup();
  await t.agent('Edge');
  const { conversation_id: id } = await t.handoff();
  const holder = t.auths.get((await t.conv(id)).assigned_to);
  await t.advance(14 * MIN + 55_000);
  t.clock.advance(10_000); // 15:05 — no engine tick in between
  await t.reply(holder, id);
  const c = await t.conv(id);
  assert.equal(c.late_cycles, 1);
  const ev = await t.db.one(`SELECT data FROM desk.events WHERE type = 'replied'`);
  assert.ok(ev.data.late_ms >= 5_000);
});
