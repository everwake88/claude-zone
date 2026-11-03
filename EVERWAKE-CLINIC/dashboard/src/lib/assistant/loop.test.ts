// The assistant's loop with a scripted model and a recorded database: reading runs, changing
// only makes a card (and only the confirm runs it), and a receptionist never gets clinical tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageOf, runTurn, type Model, type ModelEvent } from './loop.ts';
import { applyProposal, instructions, toolsFor, type Db, type Proposal, type Who } from './tools.ts';

const doctor: Who = { tenant: 't1', role: 'doctor', clinical: true, name: 'د. منى', doctor_id: 'd1', lang: 'ar', timezone: 'Africa/Cairo', clinic: 'عيادات النيل' };
const desk: Who = { ...doctor, role: 'receptionist', clinical: false, doctor_id: null, name: 'الاستقبال' };

function fakeDb(answers: Record<string, unknown>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: Db = { rpc: async (fn, args = {}) => { calls.push({ fn, args }); return { data: answers[fn] ?? { ok: true }, error: null }; } };
  return { db, calls };
}
// a model that plays its steps in order; each step is a list of events
function scripted(steps: ModelEvent[][]) {
  const seen: unknown[][] = [];
  const model: Model = async function* ({ input }) {
    seen.push(JSON.parse(JSON.stringify(input)));
    for (const ev of steps.shift() || [{ type: 'text', delta: '…' } as ModelEvent]) yield ev;
  };
  return { model, seen };
}
const collect = () => { const out: { e: string; d: any }[] = []; return { out, emit: (e: string, d: unknown) => out.push({ e, d }) }; };

test('reading runs at once and its answer goes back to the model; the words stream', async () => {
  const { db, calls } = fakeDb({ patient_search: [{ id: 7, full_name: 'سارة محمود', file_no: '1001', phone: '201012345678', age: '29 سنة', last_visit_at: null }] });
  const { model, seen } = scripted([
    [{ type: 'call', call_id: 'c1', name: 'search_patients', arguments: '{"query":"سارة"}' }],
    [{ type: 'text', delta: 'لقيت ' }, { type: 'text', delta: 'سارة محمود، ملف 1001.' }]
  ]);
  const { out, emit } = collect();
  const r = await runTurn({ model, tools: toolsFor(doctor), who: doctor, db, history: [{ role: 'user', content: 'دوّر على سارة' }],
    instructions: instructions(doctor, '2026-11-03'), emit, propose: async () => 0 });
  assert.equal(r.text, 'لقيت سارة محمود، ملف 1001.');
  assert.deepEqual(calls.map(c => c.fn), ['patient_search']);
  assert.equal(calls[0].args.p_q, 'سارة');
  const back = seen[1].find((x: any) => x.type === 'function_call_output') as any;
  assert.match(back.output, /سارة محمود/);
  assert.deepEqual(out.filter(x => x.e === 'tool').map(x => x.d.status), ['running', 'done']);
  assert.deepEqual(out.find(x => x.e === 'tool' && x.d.status === 'done')!.d.chips, [{ kind: 'patient', id: 7, label: 'سارة محمود' }]);
  assert.deepEqual(r.parts.map(p => p.type), ['tool']);
});

test('changing only makes a card: the preview runs, the change does not — until the confirm', async () => {
  const { db, calls } = fakeDb({ dashboard_delay: { ok: true, count: 3, minutes: 20, doctor: 'د. منى', items: [{ patient: 'أحمد', old_time: '19:00', new_time: '19:20', whatsapp: true }] } });
  const { model } = scripted([
    [{ type: 'call', call_id: 'c1', name: 'announce_delay', arguments: '{"minutes":20}' }],
    [{ type: 'text', delta: 'جهزتلك الكارت: 3 مرضى هيتبلغوا. أكّد عليه.' }]
  ]);
  const { out, emit } = collect();
  const proposals: Proposal[] = [];
  const r = await runTurn({ model, tools: toolsFor(doctor), who: doctor, db, history: [{ role: 'user', content: 'هتأخر 20 دقيقة' }],
    instructions: '', emit, propose: async (p) => { proposals.push(p); return 41; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.p && (calls[0].args.p as any).preview, true, 'only the preview ran');
  assert.equal(proposals[0].tool, 'announce_delay');
  assert.deepEqual(proposals[0].params, { doctor_id: 'd1', minutes: 20, reason: null }, 'the doctor’s own sessions by default');
  assert.match(proposals[0].summary, /3 مرضى/);
  assert.equal(out.find(x => x.e === 'action')!.d.id, 41);
  assert.equal(r.parts[0].action_id, 41);
  // the confirm runs it, through the same function
  const done = await applyProposal('announce_delay', proposals[0].params, db, doctor);
  assert.equal(calls.at(-1)!.fn, 'dashboard_delay');
  assert.equal((calls.at(-1)!.args.p as any).preview, false);
  assert.ok(done.ok);
});

test('a receptionist gets no clinical tools, and a call to one runs nothing', async () => {
  const names = toolsFor(desk).map(t => t.name);
  assert.ok(names.includes('book') && names.includes('announce_delay') && names.includes('search_patients'));
  assert.ok(!names.includes('update_dental_chart') && !names.includes('build_treatment_plan'));
  assert.ok(!names.includes('catalog_change') && !names.includes('block_time'), 'prices and time off are for owners, managers and doctors');
  const { db, calls } = fakeDb({});
  const { model, seen } = scripted([[{ type: 'call', call_id: 'x', name: 'update_dental_chart', arguments: '{"patient_id":1,"teeth":[{"tooth":37,"condition":"caries"}]}' }], [{ type: 'text', delta: 'مش متاح ليا.' }]]);
  const { emit } = collect();
  await runTurn({ model, tools: toolsFor(desk), who: desk, db, history: [{ role: 'user', content: 'سجل تسوس في 37' }], instructions: '', emit, propose: async () => { throw new Error('no'); } });
  assert.equal(calls.length, 0);
  assert.match(JSON.stringify(seen[1]), /NOT_AVAILABLE/);
  assert.equal((await applyProposal('update_dental_chart', {}, db, desk)).summary, 'NOT_ALLOWED', 'nor can it be confirmed');
});

test('the visit’s tools exist on its page only, and go to the screen', async () => {
  assert.ok(!toolsFor(doctor).some(t => t.name === 'fill_visit_fields'));
  const onVisit: Who = { ...doctor, page: { kind: 'visit', appointment_id: 9 } };
  const tools = toolsFor(onVisit);
  assert.ok(tools.some(t => t.name === 'draft_prescription'));
  const { db, calls } = fakeDb({});
  const { model } = scripted([[{ type: 'call', call_id: 'v', name: 'fill_visit_fields', arguments: '{"fields":[{"key":"exam.hygiene","value":"جيدة"}]}' }], [{ type: 'text', delta: 'تمام، ملّيته.' }]]);
  const { out, emit } = collect();
  await runTurn({ model, tools, who: onVisit, db, history: [{ role: 'user', content: 'النضافة جيدة' }], instructions: instructions(onVisit, '2026-11-03'), emit, propose: async () => 0 });
  assert.equal(calls.length, 0);
  assert.deepEqual(out.find(x => x.e === 'client')!.d, { type: 'fill_visit_fields', payload: { fields: [{ key: 'exam.hygiene', value: 'جيدة' }] } });
  assert.match(instructions(onVisit, '2026-11-03'), /visit of appointment 9/);
});

test('the page is read from the address', () => {
  assert.deepEqual(pageOf('/c/nile/patients/12'), { kind: 'patient', patient_id: 12, path: '/c/nile/patients/12' });
  assert.equal(pageOf('/c/nile/visit/5').appointment_id, 5);
  assert.equal(pageOf('/c/nile/inbox?c=33').conversation_id, 33);
  assert.equal(pageOf('/c/nile').kind, 'today');
  assert.equal(pageOf('/c/nile/settings/agent').kind, 'other');
});
