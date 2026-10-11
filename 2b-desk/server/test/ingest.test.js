// What n8n sends: hand-offs from the AI and every customer message.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, MIN } from './helpers.js';

after(teardown);

test('a customer with no open chat stays with the AI, but is counted for the day', async () => {
  const t = await setup();
  const res = await t.desk.ingestMessage({ channel: 'ig', external_id: 'IGSID-1', text: 'Price of the iPhone?' });
  assert.equal(res.human_active, false);
  const again = await t.desk.ingestMessage({ channel: 'instagram', external_id: 'IGSID-1', text: 'Hello?' });
  assert.equal(again.human_active, false);
  const row = await t.db.one('SELECT channel, messages FROM desk.contacts_daily');
  assert.deepEqual(row, { channel: 'instagram', messages: 2 });
  const { n } = await t.db.one('SELECT count(*)::int AS n FROM desk.messages');
  assert.equal(n, 0, 'AI-only conversations are not stored by the desk');
});

test('a hand-off opens a chat with the AI history in order, and later messages join it', async () => {
  const t = await setup();
  await t.agent('Agent');
  const res = await t.desk.ingestHandoff({
    channel: 'facebook',
    external_id: 'PSID-77',
    customer_ref: '9001',
    customer_name: 'Mostafa',
    category: 'Complaint',
    summary: 'Order 12345 arrived damaged; customer is upset.',
    history: [
      { role: 'customer', text: 'My order came broken' },
      { role: 'assistant', text: 'Sorry to hear that! Can you share the order number?' },
      { role: 'customer', text: '12345' },
    ],
  });
  assert.equal(res.human_active, true);
  assert.equal(res.created, true);
  const c = await t.conv(res.conversation_id);
  assert.equal(c.channel, 'messenger');
  assert.equal(c.category, 'complaint');
  assert.equal(c.status, 'assigned');
  const msgs = await t.db.q('SELECT sender, body FROM desk.messages WHERE conversation_id = $1 ORDER BY created_at, id', [c.id]);
  assert.deepEqual(msgs.map((m) => m.sender), ['customer', 'ai', 'customer']);
  assert.equal(msgs[2].body, '12345');

  const m = await t.desk.ingestMessage({
    channel: 'messenger', external_id: 'PSID-77', text: 'Hello?', external_message_id: 'mid.1',
  });
  assert.equal(m.human_active, true);
  assert.equal(m.conversation_id, c.id);
  const dup = await t.desk.ingestMessage({
    channel: 'messenger', external_id: 'PSID-77', text: 'Hello?', external_message_id: 'mid.1',
  });
  assert.equal(dup.duplicate, true, 'n8n retries do not double messages');
  const { n } = await t.db.one('SELECT count(*)::int AS n FROM desk.messages WHERE conversation_id = $1', [c.id]);
  assert.equal(n, 4);
});

test('same customer, different id (a Facebook comment): matched through customer_ref', async () => {
  const t = await setup();
  await t.agent('Agent');
  const { conversation_id } = await t.handoff({ channel: 'messenger', external_id: 'PSID-1', customer_ref: '55' });
  const res = await t.desk.ingestMessage({
    channel: 'messenger', external_id: 'APP-SCOPED-ID', customer_ref: '55', text: 'nice', kind: 'comment',
  });
  assert.equal(res.conversation_id, conversation_id);
  const last = await t.db.one('SELECT body FROM desk.messages ORDER BY id DESC LIMIT 1');
  assert.match(last.body, /^💬 Comment on a post: nice/);
});

test('a second hand-off for an open chat does not duplicate it, and keeps a human re-label', async () => {
  const t = await setup();
  const a = await t.agent('Agent');
  const { conversation_id: id } = await t.handoff({ external_id: 'X@s.whatsapp.net', category: 'inquiry' });
  await t.desk.setCategory(a, id, 'followup');
  const again = await t.desk.ingestHandoff({ channel: 'whatsapp', external_id: 'X@s.whatsapp.net', category: 'sales' });
  assert.equal(again.conversation_id, id);
  assert.equal(again.created, false);
  const c = await t.conv(id);
  assert.equal(c.category, 'followup', 'the human decision wins');
  assert.equal(c.ai_category, 'sales');
});

test('resolving a chat hands the customer back to the AI', async () => {
  const t = await setup();
  const a = await t.agent('Agent');
  const { conversation_id: id } = await t.handoff({ external_id: 'Y@s.whatsapp.net' });
  await t.reply(a, id);
  await t.desk.close(a, id, 'Sorted');
  const res = await t.desk.ingestMessage({ channel: 'whatsapp', external_id: 'Y@s.whatsapp.net', text: 'thanks!' });
  assert.equal(res.human_active, false);
  const next = await t.handoff({ external_id: 'Y@s.whatsapp.net' });
  assert.notEqual(next.conversation_id, id, 'a new hand-off is a new chat');
});

test('the reply payload sent to n8n carries everything needed to deliver it', async () => {
  const t = await setup();
  const a = await t.agent('Agent');
  const { conversation_id: id } = await t.handoff({
    channel: 'whatsapp', external_id: '201001234567@s.whatsapp.net', customer_ref: '42',
  });
  await t.reply(a, id, 'مرحبا! هساعدك حالا');
  const p = t.outbound.sent[0];
  assert.equal(p.channel, 'whatsapp');
  assert.equal(p.external_id, '201001234567@s.whatsapp.net');
  assert.equal(p.phone, '201001234567');
  assert.equal(p.customer_ref, '42');
  assert.equal(p.text, 'مرحبا! هساعدك حالا');
  assert.equal(p.agent.name, 'Agent');
  const m = await t.db.one(`SELECT delivery, external_id FROM desk.messages WHERE sender = 'agent'`);
  assert.equal(m.delivery, 'sent');
  assert.ok(m.external_id);
});

test('bad input is rejected with a clear message', async () => {
  const t = await setup();
  await assert.rejects(t.desk.ingestMessage({ channel: 'telegram', external_id: '1', text: 'x' }), /channel must be/);
  await assert.rejects(t.desk.ingestHandoff({ channel: 'wa' }), /external_id is required/);
  void MIN;
});

test('the hand-off answer tells the AI whether someone is on shift and the queue position', async () => {
  const t = await setup();
  const nobody = await t.handoff();
  assert.equal(nobody.assigned, false);
  assert.equal(nobody.agents_ready, 0, 'nobody on shift: the AI can say when the team is back');
  assert.equal(nobody.queue_position, 1);
  const second = await t.handoff();
  assert.equal(second.queue_position, 2);
  await t.agent('Morning');
  const third = await t.handoff();
  assert.equal(third.assigned, true);
  assert.equal(third.agents_ready, 1);
  assert.equal(third.queue_position, 0);
});

test('replies longer than the channel allows are refused with a clear message', async () => {
  const t = await setup();
  const a = await t.agent('Long Writer');
  const { conversation_id: id } = await t.handoff({ channel: 'instagram', external_id: 'IGSID-long' });
  await assert.rejects(t.desk.sendReply(a, id, 'x'.repeat(1001)), /Instagram messages can be up to 1000 characters/);
  await t.reply(a, id, 'x'.repeat(1000));
  assert.equal(t.outbound.sent.length, 1);
});
