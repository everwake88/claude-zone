// Asking a teammate to take a chat: accept, "No availability", expiry, limits.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, MIN } from './helpers.js';

after(teardown);

async function twoAgentsOneChat(t) {
  const a = await t.agent('Stressed');
  const { conversation_id: id } = await t.handoff();
  const b = await t.agent('Helper');
  return { a, b, id };
}

test('accepting moves the chat and keeps the original 10-minute deadline', async () => {
  const t = await setup();
  const { a, b, id } = await twoAgentsOneChat(t);
  await t.advance(3 * MIN);
  const req = await t.desk.requestTransfer(a, id, b.user.id, 'Angry customer, please help');
  assert.equal(t.hub.toasts(b.user.id, 'transfer_request').length, 1);
  await t.advance(20_000);
  const res = await t.desk.respondTransfer(b, req.id, true);
  assert.equal(res.status, 'accepted');
  const c = await t.conv(id);
  assert.equal(c.assigned_to, b.user.id);
  assert.equal(+c.hold_until, +c.waiting_since + 10 * MIN, 'remaining time carries over');
  const answer = t.hub.toasts(a.user.id, 'transfer_answer').at(-1);
  assert.equal(answer.status, 'accepted');
  const seg = await t.db.one(
    `SELECT end_reason FROM desk.assignments WHERE conversation_id = $1 AND user_id = $2`, [id, a.user.id],
  );
  assert.equal(seg.end_reason, 'transferred');
});

test('"No availability" keeps the chat with the asker', async () => {
  const t = await setup();
  const { a, b, id } = await twoAgentsOneChat(t);
  const req = await t.desk.requestTransfer(a, id, b.user.id);
  await t.desk.respondTransfer(b, req.id, false);
  assert.equal((await t.conv(id)).assigned_to, a.user.id);
  assert.equal(t.hub.toasts(a.user.id, 'transfer_answer').at(-1).status, 'declined');
  // The asker can immediately try someone else.
  const c2 = await t.agent('Third');
  await t.desk.requestTransfer(a, id, c2.user.id);
});

test('an unanswered request expires after 60 seconds', async () => {
  const t = await setup();
  const { a, b, id } = await twoAgentsOneChat(t);
  const req = await t.desk.requestTransfer(a, id, b.user.id);
  await t.advance(65_000);
  const r = await t.db.one('SELECT status FROM desk.transfer_requests WHERE id = $1', [req.id]);
  assert.equal(r.status, 'expired');
  await assert.rejects(t.desk.respondTransfer(b, req.id, true), /expired|already answered/);
  assert.equal((await t.conv(id)).assigned_to, a.user.id);
});

test('cannot ask someone who is Not ready, full, or yourself; one request at a time', async () => {
  const t = await setup({ settingsPatch: { max_chats: 2 } });
  const a = await t.agent('Asker');
  const { conversation_id: id } = await t.handoff();
  const idle = await t.agent('On Break', { ready: false });
  await assert.rejects(t.desk.requestTransfer(a, id, idle.user.id), /not Ready/);
  await assert.rejects(t.desk.requestTransfer(a, id, a.user.id), /not yourself/);
  const full = await t.agent('Full One');
  await t.desk.setStatus(a, 'not_ready'); // so both new chats go to Full One
  await t.handoff();
  await t.handoff(); // Full One now has 2 of 2
  const loads = await t.loads();
  assert.equal(loads[full.user.id], 2);
  await assert.rejects(t.desk.requestTransfer(a, id, full.user.id), /full/);
  const free = await t.agent('Free One');
  await t.desk.requestTransfer(a, id, free.user.id);
  const other = await t.agent('Other One');
  await assert.rejects(t.desk.requestTransfer(a, id, other.user.id), /Still waiting/);
});

test('accepting is refused when the helper has reached the cap meanwhile', async () => {
  const t = await setup({ settingsPatch: { max_chats: 1 } });
  const a = await t.agent('Giver');
  const { conversation_id: id } = await t.handoff();
  const b = await t.agent('Taker');
  const req = await t.desk.requestTransfer(a, id, b.user.id);
  await t.handoff(); // fills Taker to 1/1
  await assert.rejects(t.desk.respondTransfer(b, req.id, true), /already have 1\/1/);
  assert.equal((await t.conv(id)).assigned_to, a.user.id);
});

test('an SLA hop cancels a pending request', async () => {
  const t = await setup();
  const { a, b, id } = await twoAgentsOneChat(t);
  const c = await t.agent('Someone Else');
  await t.advance(9 * MIN + 30_000);
  const req = await t.desk.requestTransfer(a, id, b.user.id);
  await t.advance(45_000); // crosses 10:00 — the engine moves it first
  const r = await t.db.one('SELECT status FROM desk.transfer_requests WHERE id = $1', [req.id]);
  assert.equal(r.status, 'cancelled');
  assert.notEqual((await t.conv(id)).assigned_to, a.user.id);
  void c;
});

test('agents cannot act on chats that are not theirs; supervisors can', async () => {
  const t = await setup();
  const { a, b, id } = await twoAgentsOneChat(t);
  await assert.rejects(t.desk.sendReply(b, id, 'hi'), /now with Stressed/);
  await assert.rejects(t.desk.close(b, id), /now with Stressed/);
  const boss = await t.agent('Boss', { role: 'supervisor', ready: false });
  await t.reply(boss, id, 'Supervisor here');
  const c = await t.conv(id);
  assert.equal(c.waiting_since, null, 'a supervisor reply stops the clock too');
  assert.equal(c.assigned_to, a.user.id, 'and the chat stays with its agent');
  await t.desk.supervisorAssign(boss, id, b.user.id);
  assert.equal((await t.conv(id)).assigned_to, b.user.id);
});

test('the asker can withdraw a request before it is answered', async () => {
  const t = await setup();
  const { a, b, id } = await twoAgentsOneChat(t);
  const req = await t.desk.requestTransfer(a, id, b.user.id);
  await t.desk.cancelTransfer(a, req.id);
  const r = await t.db.one('SELECT status FROM desk.transfer_requests WHERE id = $1', [req.id]);
  assert.equal(r.status, 'cancelled');
  assert.equal(t.hub.toasts(b.user.id, 'transfer_gone').length, 1, 'the request card disappears for the teammate');
  await assert.rejects(t.desk.respondTransfer(b, req.id, true), /already answered or withdrawn/);
});
