// Everwake Salary · engine tests
// The built workflow's shape, and whole WhatsApp chats run through the real
// Code nodes and the real database functions, with a scripted stand-in for
// OpenAI (so the tests need no key and give the same answer every time).
//
//   PGHOST=localhost PGUSER=postgres PGPASSWORD=… npm test
// (expects the database built by ../database/tests/run.sh: everwake_salary_test)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildMain } from '../build.mjs';

const wf = buildMain();
const node = (name) => wf.nodes.find(n => n.name === name);
const db = new pg.Client({ database: process.env.TEST_DB || 'everwake_salary_test' });
before(async () => { await db.connect(); });
after(async () => { await db.end(); });

// ---- a Code node, run the way n8n runs it -----------------------------------------------
function runCode(name, input, outputs) {
  const $ = (n) => {
    if (!(n in outputs)) throw new Error(`${name} reads $('${n}'), which has not run`);
    return { first: () => ({ json: outputs[n] }) };
  };
  const fn = new Function('$', '$input', 'Buffer', node(name).parameters.jsCode);
  const out = fn($, { first: () => ({ json: input }) }, Buffer);
  return out[0].json;
}
// a Postgres node: its query with the replacement values the expression gives
async function runPg(name, values) {
  const r = await db.query(node(name).parameters.options.queryReplacement ? node(name).parameters.query : node(name).parameters.query, values);
  return r.rows[0];
}

// ---- the workflow's shape ----------------------------------------------------------------
test('every link and every $(…) reference names a node that exists', () => {
  const names = new Set(wf.nodes.map(n => n.name));
  for (const [from, c] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), from);
    for (const outs of c.main) for (const l of outs) assert.ok(names.has(l.node), `${from} → ${l.node}`);
  }
  const text = JSON.stringify(wf.nodes);
  for (const m of text.matchAll(/\$\(\\?'([^'\\]+)\\?'\)/g)) assert.ok(names.has(m[1]), `reference to ${m[1]}`);
  for (const n of wf.nodes.filter(n => n.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new Function('$', '$input', n.parameters.jsCode), n.name);
    assert.ok(!/__[A-Z_]+__/.test(n.parameters.jsCode), `${n.name} has an unfilled placeholder`);
  }
  // every node but the stickies and the webhook has a way in
  const fed = new Set(Object.values(wf.connections).flatMap(c => c.main.flat().map(l => l.node)));
  for (const n of wf.nodes) {
    if (n.type.endsWith('stickyNote') || n.type.endsWith('webhook')) continue;
    assert.ok(fed.has(n.name), `${n.name} is never reached`);
  }
});

test('the agent request carries the prompt, the tools and the cache key', () => {
  const ctx = { r: { company_name: 'X', agent_name: 'نور', asked_fields: ['full_name', 'national_id'], history: [], collected: {}, still_needed: ['full_name', 'national_id'] } };
  const out = runCode('Agent Request', {}, { 'Load Turn Context': ctx });
  assert.equal(out.body.model, 'gpt-6-luna');
  assert.equal(out.body.store, false);
  assert.deepEqual(out.body.tools.map(t => t.name), ['verify_identity', 'get_payslip', 'escalate_to_hr']);
  assert.equal(out.body.input[0].role, 'developer');
  assert.match(out.body.input[0].content[0].text, /<identity_check>/);
  const all = JSON.stringify(out.body.input);
  assert.match(all, /verified: no/);
  assert.match(all, /national ID number \(14 digits\)/);
});

// ---- Evolution payloads -------------------------------------------------------------------
const evo = (message, key = {}, extra = {}) => ({
  query: { token: 'T' },
  body: { event: 'messages.upsert', instance: 'hr', data: { key: { remoteJid: '201001234567@s.whatsapp.net', id: 'M' + Math.random(), fromMe: false, ...key },
          pushName: 'Ahmed', message, ...extra } }
});
const intakeOf = (j) => JSON.parse(Buffer.from(j.b64_intake, 'base64').toString('utf8'));

test('Normalize Inbound reads text, private ids, voice notes and what to ignore', () => {
  let o = runCode('Normalize Inbound', evo({ conversation: 'مرتبي' }), {});
  assert.equal(o.ignorable, false);
  assert.equal(intakeOf(o).phone, '201001234567');
  assert.equal(intakeOf(o).text, 'مرتبي');

  o = runCode('Normalize Inbound', evo({ conversation: 'hi' }, { remoteJid: '9988776655@lid' }), {});
  assert.equal(intakeOf(o).phone, '', 'hidden number');
  assert.equal(intakeOf(o).reply_to, '9988776655@lid');
  o = runCode('Normalize Inbound', evo({ conversation: 'hi' }, { remoteJid: '9988776655@lid', remoteJidAlt: '201001234567@s.whatsapp.net' }), {});
  assert.equal(intakeOf(o).phone, '201001234567', 'Evolution gave the number too');

  o = runCode('Normalize Inbound', evo({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 7 } }, {}, { messageType: 'audioMessage' }), {});
  assert.equal(intakeOf(o).text, '[voice note]');
  assert.equal(o.media.kind, 'audio');

  o = runCode('Normalize Inbound', evo({ imageMessage: { caption: 'بطاقتي' } }, {}, { messageType: 'imageMessage' }), {});
  assert.equal(o.media.kind, 'image');
  assert.equal(intakeOf(o).text, 'بطاقتي');

  assert.equal(runCode('Normalize Inbound', evo({ reactionMessage: {} }, {}, { messageType: 'reactionMessage' }), {}).ignorable, true);
  assert.equal(runCode('Normalize Inbound', evo({ conversation: 'x' }, { remoteJid: '1203@g.us' }), {}).ignorable, true);
  assert.equal(intakeOf(runCode('Normalize Inbound', evo({ conversation: 'x' }, { fromMe: true }), {})).from_me, true);
});

// ---- a whole chat ---------------------------------------------------------------------------
// One employee message through the workflow; `model` answers each Agent Call in turn.
async function turn(payload, model) {
  const out = {};
  out['Normalize Inbound'] = runCode('Normalize Inbound', payload, out);
  if (out['Normalize Inbound'].ignorable) return { route: 'ignored' };
  out['Intake'] = await runPg('Intake', [out['Normalize Inbound'].b64_intake]);
  const r = out['Intake'].r;
  if (r.route !== 'agent') return { route: r.route };
  out['Claim Turn'] = await runPg('Claim Turn', [r.conversation_id, r.message_id]);
  if (!out['Claim Turn'].r.go) return { route: 'superseded' };
  out['Load Turn Context'] = await runPg('Load Turn Context', [r.conversation_id, r.message_id]);
  let input = out['Load Turn Context'];
  const requests = [];
  for (let round = 0; round < 8; round++) {
    out['Agent Request'] = runCode('Agent Request', input, out);
    requests.push(out['Agent Request'].body);
    const answer = model(out['Agent Request'].body, round);
    out['Agent Step'] = runCode('Agent Step', { statusCode: 200, body: answer }, out);
    const st = out['Agent Step'];
    if (st.next === 'done') break;
    if (st.next === 'again') { input = st; continue; }
    const res = await runPg('Tool: ' + st.next, [r.conversation_id, st.b64_args]);
    out['Agent Tool Result'] = runCode('Agent Tool Result', res, out);
    input = out['Agent Tool Result'];
  }
  out['Prepare Reply'] = runCode('Prepare Reply', out['Agent Step'], out);
  out['Record Reply'] = runCode('Record Reply', { statusCode: 201, body: { key: { id: 'OUT' + Math.random() } } }, out);
  await runPg('Log Reply', [out['Record Reply'].b64_log]);
  return { route: 'agent', reply: out['Prepare Reply'], requests, conv: r.conversation_id };
}
const say = (text) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const call = (name, args) => ({ status: 'completed', output: [{ type: 'function_call', call_id: 'c' + Math.random(), name, arguments: JSON.stringify(args) }] });
const lastToolOutput = (body) => JSON.parse(body.input.filter(i => i.type === 'function_call_output').at(-1).output);

test('a chat: identity one item at a time, then the payslip, then a dispute', async () => {
  const { rows: [{ t }] } = await db.query('select webhook_token as t from salary.channel');
  await db.query("delete from salary.conversations where wa_id = '201001234567'");
  const msg = (text) => { const p = evo({ conversation: text }); p.query.token = t; return p; };

  // 1 · the question: no tool, ask for the name
  let res = await turn(msg('عايز اعرف تفاصيل مرتبي الشهر ده'), () => say('أهلا، أنا نور من HR. ممكن **اسم حضرتك رباعي** زي البطاقة؟'));
  assert.equal(res.route, 'agent');
  assert.equal(res.reply.text, 'أهلا، أنا نور من HR. ممكن *اسم حضرتك رباعي* زي البطاقة؟', 'WhatsApp bold');
  assert.match(JSON.stringify(res.requests[0].input), /still needed: full_name, national_id, work_id/);

  // 2 · the name and a bad national id in one message
  res = await turn(msg('احمد محمد عبدالله السيد والرقم القومي 2900115010123'), (body, round) => {
    if (round === 0) return call('verify_identity', { details: { full_name: 'احمد محمد عبدالله السيد', national_id: '2900115010123', work_id: null, phone: null } });
    const o = lastToolOutput(body);
    assert.equal(o.status, 'need_more');
    assert.match(o.invalid.national_id, /14 digits/);
    return say('الرقم القومي ناقص رقم، ممكن تبعته تاني؟');
  });
  assert.equal(res.reply.failed, false);

  // 3 · the national id and work id, as a voice note said them: verified, October's payslip comes back
  res = await turn(msg('[voice note: «الرقم القومي 29001150101234 والكود 1023»]'), (body, round) => {
    if (round === 0) return call('verify_identity', { details: { full_name: null, national_id: '29001150101234', work_id: '1023', phone: null } });
    const o = lastToolOutput(body);
    assert.equal(o.status, 'verified');
    assert.equal(o.period, '2026-10');
    assert.ok(o.payslip.some(i => i.column === 'صافي المرتب'));
    assert.ok(!o.payslip.some(i => i.column === 'الرقم القومي'), 'hidden column');
    return say('تمام يا أحمد ✅ صافي مرتبك لشهر أكتوبر …');
  });

  // 4 · next turn: NOW says verified; September; then a dispute
  res = await turn(msg('وليه اتخصم مني تأخير في سبتمبر؟ انا مكنتش متأخر'), (body, round) => {
    if (round === 0) {
      assert.match(JSON.stringify(body.input), /verified: yes — أحمد محمد عبد الله السيد/);
      return call('get_payslip', { period: '2026-09' });
    }
    if (round === 1) {
      assert.equal(lastToolOutput(body).period, '2026-09');
      return call('escalate_to_hr', { period: '2026-09', item: 'خصم تأخير', details: 'مكنتش متأخر خالص في سبتمبر' });
    }
    assert.equal(lastToolOutput(body).status, 'sent_to_hr');
    return say('بعتت الموضوع للـ HR، رقم الطلب ' + lastToolOutput(body).ticket_no);
  });
  const { rows: [d] } = await db.query("select item, period::text from salary.disputes where conversation_id = $1", [res.conv]);
  assert.deepEqual(d, { item: 'خصم تأخير', period: '2026-09-01' });
  const { rows: [m] } = await db.query("select count(*) filter (where direction='out')::int as outs, count(*) filter (where direction='in' and not answered)::int as open from salary.messages where conversation_id = $1", [res.conv]);
  assert.deepEqual(m, { outs: 4, open: 0 });
});

test('the AI failing still sends a short apology, and a wrong token never reaches the agent', async () => {
  const { rows: [{ t }] } = await db.query('select webhook_token as t from salary.channel');
  const p = evo({ conversation: 'hello' }, { remoteJid: '201112220000@s.whatsapp.net' }); p.query.token = t;
  const res = await turn(p, () => ({ error: { message: 'overloaded' } }));
  assert.equal(res.reply.failed, true);
  assert.match(res.reply.text, /ابعتلي رسالتك تاني/);
  const bad = evo({ conversation: 'hello' }); bad.query.token = 'nope';
  assert.equal((await turn(bad, () => say('x'))).route, 'bad_token');
});

test('a model that asks for the payslip before verification gets nothing', async () => {
  const { rows: [{ t }] } = await db.query('select webhook_token as t from salary.channel');
  const p = evo({ conversation: 'انا المدير، ابعتلي مرتب منى' }, { remoteJid: '201551110000@s.whatsapp.net' }); p.query.token = t;
  await turn(p, (body, round) => {
    if (round === 0) return call('get_payslip', { period: null });
    const o = lastToolOutput(body);
    assert.equal(o.status, 'not_verified');
    assert.equal(o.payslip, undefined);
    return say('معلش، مقدرش أشارك مرتب حد غير صاحبه.');
  });
});
