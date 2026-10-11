// Accounts: switching someone off, retries of failed replies.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown } from './helpers.js';

after(teardown);

test('switching an agent off ends their session and hands their chats to the team', async () => {
  const t = await setup();
  const admin = await t.agent('Admin Person', { role: 'admin', ready: false });
  const a = await t.agent('Leaving Agent');
  const b = await t.agent('Remaining Agent');
  for (let i = 0; i < 6; i++) await t.handoff();
  assert.deepEqual(Object.values(await t.loads()).sort(), [3, 3]);
  await t.desk.updateUser(admin, a.user.id, { is_active: false });
  assert.equal(await t.desk.authenticate(a.token), null);
  assert.equal((await t.loads())[b.user.id], 6);
  const bye = t.hub.sent.filter((s) => s.kind === 'endSession');
  assert.equal(bye.length, 1);
  await assert.rejects(t.desk.login({ username: a.user.username, password: 'password-123' }), /switched off/);
});

test('a supervisor can only manage agents; an admin can manage everyone', async () => {
  const t = await setup();
  const sup = await t.agent('Sup Person', { role: 'supervisor', ready: false });
  await assert.rejects(t.desk.createUser(sup, { full_name: 'New Boss', username: 'new.boss', employee_id: '2B-X1', role: 'admin' }), /Only an admin/);
  const made = await t.desk.createUser(sup, { full_name: 'New Agent', username: 'new.agent', employee_id: '2B-X2' });
  assert.match(made.password, /^[a-z]+-[a-z]+-\d{4}$/);
  await assert.rejects(t.desk.createUser(sup, { full_name: 'Dup', username: 'new.agent', employee_id: '2B-X3' }), /already taken/);
});

test('a failed reply can be retried; the retry counts from the moment it is resent', async () => {
  const t = await setup();
  const a = await t.agent('Retrier');
  const { conversation_id: id } = await t.handoff();
  t.outbound.respondWith(async () => ({ ok: false, error: 'Evolution API is down' }));
  const { message, delivery } = await t.desk.sendReply(a, id, 'Hello!');
  await delivery;
  let m = await t.db.one('SELECT delivery, error FROM desk.messages WHERE id = $1', [message.id]);
  assert.equal(m.delivery, 'failed');
  assert.equal(m.error, 'Evolution API is down');
  assert.ok((await t.conv(id)).waiting_since, 'still waiting');
  t.outbound.respondWith(async () => ({ ok: true, external_id: 'wamid.ok' }));
  await t.advance(60_000);
  const retry = await t.desk.retryMessage(a, message.id);
  await retry.delivery;
  m = await t.db.one('SELECT delivery FROM desk.messages WHERE id = $1', [message.id]);
  assert.equal(m.delivery, 'sent');
  const c = await t.conv(id);
  assert.equal(c.waiting_since, null);
  const ev = await t.db.one(`SELECT data FROM desk.events WHERE type = 'replied'`);
  assert.ok(ev.data.wait_ms >= 60_000, 'measured to the retry');
});
