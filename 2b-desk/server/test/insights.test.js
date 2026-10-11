// The "Track" journey with busy / idle verdicts, and the end-of-day report.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, MIN } from './helpers.js';
import { journey } from '../src/journey.js';
import { dayReport, agentsCsv } from '../src/reports.js';

after(teardown);

test('journey: who had the late chat, how loaded they were, busy or idle', async () => {
  const t = await setup();
  const ahmed = await t.agent('Ahmed');
  const { conversation_id: late } = await t.handoff({ category: 'complaint' });
  assert.equal((await t.conv(late)).assigned_to, ahmed.user.id);
  // Ahmed gets 6 more chats and works hard on them — but never answers `late`.
  const others = [];
  for (let i = 0; i < 6; i++) others.push((await t.handoff()).conversation_id);
  const sara = await t.agent('Sara');
  const omar = await t.agent('Omar', { ready: false });
  for (let minute = 0; minute < 10; minute++) {
    await t.desk.recordActivity(ahmed, 120, 35_000);
    if (minute < 6) await t.reply(ahmed, others[minute]);
    await t.advance(1 * MIN);
  }
  // At 10 minutes it moved to Sara, who does nothing for her minute.
  let c = await t.conv(late);
  assert.equal(c.assigned_to, sara.user.id);
  await t.desk.setStatus(omar, 'ready');
  await t.advance(70_000);
  c = await t.conv(late);
  assert.equal(c.assigned_to, omar.user.id);
  await t.reply(omar, late, 'Hi, I am sorry about that');

  const s = await t.settings.get();
  const j = await journey(t.db, late, { at: t.clock.now(), s });
  const [a, b, o] = j.segments;
  assert.equal(a.full_name, 'Ahmed');
  assert.equal(a.end_reason, 'timeout');
  assert.equal(a.load_at_start, 0);
  assert.equal(a.chats_during, 7, 'had 7 chats while this one waited');
  assert.equal(a.other_replies, 6);
  assert.ok(a.typing_ms > 5 * MIN, `typed for ${a.typing_ms}ms`);
  assert.equal(a.verdict, 'busy');
  assert.equal(b.full_name, 'Sara');
  assert.equal(b.other_replies, 0);
  assert.equal(b.verdict, 'idle');
  assert.equal(o.full_name, 'Omar');
  assert.equal(o.verdict, 'replied');
  assert.equal(j.waits.length, 1);
  assert.ok(j.first_response_ms > 11 * MIN);
});

test('day report: volumes by category and source, agent time, typing and timeouts', async () => {
  const t = await setup();
  // Egypt is on summer time (UTC+3) until late October: 06:00 UTC is 09:00 in Cairo.
  t.clock.set('2026-10-11T06:00:00Z');
  const a = await t.agent('Hana');
  const b = await t.agent('Karim', { ready: false });
  const mk = (channel, category, n) =>
    Promise.all(Array.from({ length: n }, (_, i) =>
      t.desk.ingestHandoff({ channel, external_id: `${channel}-${category}-${i}`, category })));
  await mk('whatsapp', 'sales', 3);
  await mk('instagram', 'complaint', 2);
  await mk('messenger', 'followup', 1);
  await t.desk.ingestMessage({ channel: 'whatsapp', external_id: 'ai-only-1', text: 'hi' });

  const mine = await t.db.q('SELECT id FROM desk.conversations WHERE assigned_to = $1 ORDER BY id', [a.user.id]);
  assert.equal(mine.length, 6);
  await t.desk.recordActivity(a, 200, 40_000);
  await t.advance(2 * MIN);
  for (const m of mine.slice(0, 4)) await t.reply(a, m.id);
  await t.desk.close(a, mine[0].id);
  await t.desk.setStatus(a, 'not_ready');
  await t.advance(10 * MIN);
  await t.desk.setStatus(a, 'ready');
  await t.desk.setStatus(b, 'ready');
  await t.advance(1 * MIN);

  const s = await t.settings.get();
  const r = await dayReport(t.db, { at: t.clock.now(), s });
  assert.equal(r.date, '2026-10-11');
  assert.equal(r.totals.new_chats, 6);
  assert.equal(r.totals.handled, 4);
  assert.equal(r.totals.resolved, 1);
  assert.equal(r.totals.contacts, 1, 'AI-only customers counted separately');
  const cat = Object.fromEntries(r.by_category.map((x) => [x.key, x.opened]));
  assert.deepEqual(cat, { inquiry: 0, sales: 3, complaint: 2, followup: 1 });
  const ch = Object.fromEntries(r.by_channel.map((x) => [x.key, x.opened]));
  assert.deepEqual(ch, { whatsapp: 3, messenger: 1, instagram: 2 });
  assert.equal(r.waits.answered, 4);
  assert.equal(r.waits.late, 0);

  const hana = r.agents.find((x) => x.full_name === 'Hana');
  assert.equal(hana.handled, 4);
  assert.equal(hana.replies, 4);
  assert.equal(hana.resolved, 1);
  assert.equal(hana.typing_ms, 40_000);
  assert.equal(hana.not_ready_ms, 10 * MIN);
  assert.ok(Math.abs(hana.ready_ms - 3 * MIN) < 2000, `ready ${hana.ready_ms}`);
  assert.ok(hana.checked_in_at);
  assert.equal(hana.checked_out_at, null);
  assert.ok(hana.timeline.length >= 3);

  const hours = r.hourly.filter((h) => h.opened);
  assert.equal(hours.length, 1);
  assert.equal(hours[0].hour, 9, 'grouped by Cairo local hour');

  const csv = agentsCsv(r, s.timezone);
  assert.match(csv, /Employee ID,Name,Role,Check-in/);
  assert.match(csv, /Hana/);
});

test('timeouts are counted per agent with their verdicts', async () => {
  const t = await setup();
  const lazy = await t.agent('Lazy');
  const { conversation_id: id } = await t.handoff();
  await t.agent('Rescuer');
  await t.advance(10 * MIN + 20_000);
  const s = await t.settings.get();
  const r = await dayReport(t.db, { at: t.clock.now(), s });
  const row = r.agents.find((x) => x.user_id === lazy.user.id);
  assert.equal(row.timeouts.total, 1);
  assert.equal(row.timeouts.idle, 1);
  const rescuer = r.agents.find((x) => x.full_name === 'Rescuer');
  assert.equal(rescuer.rescues, 1);
  void id;
});

test('CSV cells that look like formulas are neutralised', async () => {
  const csv = agentsCsv(
    {
      agents: [{
        employee_id: '=HYPERLINK("x")', full_name: '+cmd', role: 'agent', is_active: true, logged_ms: 0, ready_ms: 0,
        not_ready_ms: 0, typing_ms: 0, avg_wait_ms: null, timeouts: { total: 0, idle: 0 },
      }],
    },
    'Africa/Cairo',
  );
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'\+cmd/);
});
