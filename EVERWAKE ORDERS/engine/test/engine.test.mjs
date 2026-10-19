// End-to-end conversations through the real engine code and database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, connect, turn, evolutionPayload, runCode, sql, callB64, unb64, manageCart } from './harness.mjs';

let db;
const ZAMALEK_PIN = { lat: 30.0610, lng: 31.2200 };
const quiet = (text, extra = {}) => ({
  reply_messages: [text], send_menu_images: false, send_item_photos: [], showed_order_summary: false,
  handoff: { needed: false, reason: '' }, language: 'ar', memory_note: '', ...extra });

before(async () => { freshDatabase(); db = await connect(); });
after(async () => { if (db) await db.end(); });

test('a new customer: pin → zone → cart with offers → details → summary → placed', async () => {
  const phone = '201011112222';

  // 1. a location pin: the zone picks the branch and the fee
  let t = await turn(db, evolutionPayload({ phone, pushName: 'Mona', location: ZAMALEK_PIN }), async () => ({
    plan: { read: 'shared a pin', stage: 'discovery', objective: 'welcome', actions: [] },
    reply: quiet('أهلاً بيكي في مشويات النيل! أنا نور. فرع الزمالك هيوصلك، تحبي تطلبي إيه؟')
  }), { geo: { street: 'شارع حسن صبري', district: 'الزمالك' } });
  assert.equal(t.route, 'agent');
  assert.match(t.brief.facts_text, /BRANCH: الزمالك \(code zamalek\) — chosen automatically from their location pin/);
  assert.match(t.brief.facts_text, /DELIVERY AREA: INSIDE the delivery zone "الزمالك" of الزمالك \(from their pin\) · delivery fee 20ج/);
  assert.match(t.brief.facts_text, /RETURNING CUSTOMER: no/);
  assert.match(t.brief.facts_text, /You are: نور \(Nour\) from مشويات النيل/);
  assert.match(t.brief.business_text, /ANSWERS THE RESTAURANT GAVE[\s\S]*العزومات/);
  assert.match(t.brief.menu_text, /M003 فرخة مشوية .*260ج/);
  assert.deepEqual(t.checked.violations, []);
  assert.equal(t.outbound.length, 1);
  assert.equal(t.outbound[0].reply_to, phone);
  assert.equal(t.outbound[0].base_url, 'https://evo.example.com');

  // 2. the order: choices in one go, a gift from an offer, VAT and the zone fee
  t = await turn(db, evolutionPayload({ phone, text: 'عايزة فرخة كاملة حارة وبيبسي، توصيل' }), async () => ({
    plan: { read: 'ordering', stage: 'building_cart', objective: 'add both', send_item_photos: ['M003'],
            actions: [{ tool: 'manage_cart', do: 'add M003 whole spicy, M009' }] },
    tools: [
      { tool: 'manage_cart', action: 'add', items: [{ menu_id: 'M003', quantity: 1, choices: [{ selected: ['فرخة كاملة', 'حار'] }] },
                                                   { menu_id: 'M009', quantity: 1 }] },
      { tool: 'save_customer_details', details: { delivery_method: 'توصيل' } }
    ],
    reply: quiet('تمام! فرخة كاملة حارة 480ج وبيبسي 20ج، ومعاهم بطاطس هدية. الإجمالي 590ج شامل الضريبة والتوصيل.\n\nأكملك البيانات؟',
                 { send_item_photos: ['M003'] })
  }));
  const cart = t.steps[0].result;
  assert.equal(cart.status, 'DONE');
  assert.equal(cart.subtotal, 500);
  assert.equal(cart.vat, 70);
  assert.equal(cart.delivery_fee, 20);
  assert.equal(cart.total, 590);
  assert.ok(cart.cart.some(l => l.menu_id === 'M007' && l.free_gift), 'free fries from the chicken offer');
  assert.deepEqual(cart.offers_almost.map(a => a.short_by), [100], '100 more for 10% off');
  assert.equal(t.steps[1].result.saved_fields[0], 'delivery_method');
  assert.deepEqual(t.checked.violations, []);
  assert.equal(t.outbound[0].kind, 'image', 'the dish photo goes first');
  assert.match(t.outbound[0].caption, /\*فرخة مشوية\* — 260ج/);
  assert.equal(t.outbound[1].kind, 'text');

  // 3. details, and an early place_order is refused until the summary is shown
  t = await turn(db, evolutionPayload({ phone, text: 'اسمي منى، عمارة 5 الدور 2 شقة 4، كاش، والعنوان صح' }), async (brief) => {
    assert.match(brief.facts_text, /STILL MISSING TO PLACE AN ORDER: .*name/);
    return {
      plan: { stage: 'giving_details', show_summary: true },
      tools: [
        { tool: 'save_customer_details', details: { full_name: 'منى', phone_confirmed: 'yes', address_building: '5', address_floor: '2',
                                                   address_apartment: '4', payment_method: 'كاش', address_confirmed: 'yes' } },
        { tool: 'manage_cart', action: 'place_order' }
      ],
      reply: quiet('ملخص طلبك:\n*فرخة مشوية* كاملة حار — 480ج\n*بيبسي* — 20ج\n*بطاطس محمرة* — هدية\nالمجموع 500ج · ضريبة 70ج · توصيل 20ج\n*الإجمالي 590ج*\nأأكد؟',
                   { showed_order_summary: true })
    };
  });
  assert.deepEqual(t.steps[0].result.still_missing_for_order, []);
  assert.equal(t.steps[0].result.delivery_area.status, 'INSIDE_A_ZONE');
  assert.equal(t.steps[1].result.status, 'NOT_PLACED');
  assert.ok(t.steps[1].result.reasons.some(r => r.code === 'SUMMARY_NOT_SHOWN'));
  assert.deepEqual(t.checked.violations, []);
  assert.equal(t.checked.decision.showed_order_summary, true);

  // 4. "yes" → placed, numbered, a ticket for the branch
  t = await turn(db, evolutionPayload({ phone, text: 'تمام أكدي' }), async (brief) => {
    assert.match(brief.facts_text, /ORDER SUMMARY: shown and STILL MATCHES/);
    return {
      plan: { stage: 'placed', place_order: true },
      tools: [{ tool: 'manage_cart', action: 'place_order' }],
      reply: (steps) => quiet(`تمام يا منى، طلبك اتسجل! رقمه ${steps[0].result.order_no} 🙏`)
    };
  });
  assert.equal(t.steps[0].result.status, 'PLACED');
  assert.equal(t.steps[0].result.order_no, 'NG-1001');
  assert.deepEqual(t.checked.violations, []);
  assert.equal(t.ticket.length, 1);
  assert.equal(t.ticket[0].ops_number, '201000000051');
  assert.match(t.ticket[0].text, /أوردر جديد NG-1001 — فرع الزمالك/);
  assert.match(t.ticket[0].text, /بطاطس محمرة × 1 = هدية/);
  assert.match(t.ticket[0].text, /الإجمالي: 590ج/);
  const o = await sql(db, "select status, total, delivery_fee, address_text from everwake.orders where order_no = 'NG-1001'");
  assert.equal(o.status, 'placed');
  assert.equal(Number(o.total), 590);
  assert.match(o.address_text, /عمارة 5، الدور 2، شقة 4/);

  // 5. a made-up price is caught, and the rewrite fixes it
  t = await turn(db, evolutionPayload({ phone, text: 'بكام كيلو الكفتة؟' }), async () => ({
    plan: { stage: 'support' },
    reply: quiet('كيلو الكفتة بـ 999ج'),
    rewrite: ['كيلو الكفتة بـ 480ج']
  }));
  assert.equal(t.checked.repair_used, true);
  assert.equal(t.checked.repair_source, 'rewrite');
  assert.equal(t.outbound[0].text, 'كيلو الكفتة بـ 480ج');
});

test('a returning customer: remembered, reorders, and a dish switched off blocks the placement', async () => {
  const phone = '201011112222';
  let t = await turn(db, evolutionPayload({ phone, text: 'عايزة نفس الطلب اللي فات' }), async (brief) => {
    assert.match(brief.facts_text, /RETURNING CUSTOMER: 1 previous order\(s\)/);
    assert.match(brief.facts_text, /NG-1001 .* total 590ج/);
    assert.match(brief.facts_text, /name on file from previous orders: منى/);
    assert.match(brief.facts_text, /SAVED ADDRESSES[\s\S]*\[saved_address \d+\]/);
    return {
      plan: { stage: 'building_cart', show_summary: true },
      tools: [{ tool: 'manage_cart', action: 'reorder_last' }],
      reply: quiet('رجعتلك نفس الطلب: فرخة كاملة حارة وبيبسي، والإجمالي 590ج. أأكد؟', { showed_order_summary: true })
    };
  });
  const re = t.steps[0].result;
  assert.equal(re.status, 'REORDERED');
  assert.equal(re.total, 590);
  assert.ok(re.cart.some(l => l.menu_id === 'M003' && l.choices.join(' ').includes('فرخة كاملة')));

  // the restaurant runs out of Pepsi in the dashboard
  await db.query(`select everwake.set_item_availability(id, false, null, null) from everwake.menu_items where code = 'M009'
                  and tenant_id = (select id from everwake.tenants where slug = 'nile_grill')`);
  t = await turn(db, evolutionPayload({ phone, text: 'أكدي' }), async (brief) => {
    assert.match(brief.facts_text, /NO LONGER AVAILABLE .*بيبسي/);
    assert.match(brief.menu_text, /M009 بيبسي .*خلصان دلوقتي/);
    return {
      plan: { stage: 'reviewing' },
      tools: [{ tool: 'manage_cart', action: 'place_order' }],
      reply: quiet('معلش، البيبسي خلص دلوقتي وشلته من الطلب. الإجمالي بقى 567.2ج. أأكد كده؟', { showed_order_summary: true })
    };
  });
  const np = t.steps[0].result;
  assert.equal(np.status, 'NOT_PLACED');
  assert.ok(np.reasons.some(r => r.code === 'MENU_CHANGED'), JSON.stringify(np.reasons));
  assert.ok(!np.cart.some(l => l.menu_id === 'M009'), 'pepsi taken out of the cart');
  assert.equal(np.total, 567.2);
  assert.deepEqual(t.checked.violations, []);
  await db.query(`update everwake.menu_items set is_available = true where code = 'M009'`);
});

test('the agent switch: one apology while OFF, "we\'re back" for everyone when ON, sent by the outbox', async () => {
  const tenant = (await sql(db, "select id from everwake.tenants where slug = 'nile_grill'")).id;
  await db.query('select everwake.set_agent_enabled($1, false, $2)', [tenant, 'Friday rush']);
  const phone = '201033334444';
  let t = await turn(db, evolutionPayload({ phone, pushName: 'Omar', text: 'السلام عليكم عايز أطلب' }), async () => { throw new Error('the agent must not run'); });
  assert.equal(t.route, 'paused');
  assert.equal(t.intake.send_apology, true);
  const ap = (await runCode('main/prepare_apology.js', { input: t.nodes.Intake, nodes: t.nodes }))[0];
  assert.match(ap.text, /^أهلاً Omar 🙏 معلش جداً/);
  assert.equal(ap.reply_to, phone);
  t = await turn(db, evolutionPayload({ phone, text: 'حد موجود؟' }), async () => { throw new Error('no'); });
  assert.equal(t.intake.send_apology, false, 'one apology only');

  const on = await sql(db, 'select everwake.set_agent_enabled($1, true) as r', [tenant]);
  assert.equal(on.r.notified, 1);
  const claim = await sql(db, "select everwake.outbox_claim(10, 'test') as r");
  const items = await runCode('outbox/split_batch.js', { input: claim });
  assert.equal(items.length, 1);
  assert.equal(items[0].purpose, 'resume_notice');
  assert.equal(items[0].to, phone);
  assert.match(items[0].text, /رجعنا نستقبل الطلبات/);
  const rec = (await runCode('outbox/record_result.js', { input: { body: { key: { id: 'EVO-1' } } }, nodes: { 'Send Loop': items[0] } }))[0];
  await callB64(db, 'outbox_result', rec.b64_result);
  const m = await sql(db, "select status, external_id from everwake.messages where wa_id = $1 and sender = 'system' and status <> 'received' order by id desc limit 1", [phone]);
  assert.equal(m.status, 'sent');
  assert.equal(m.external_id, 'EVO-1');

  // a failed send is retried, then marked failed with the reason
  await db.query('select everwake.queue_customer_message($1, $2, $3, $4)', [tenant, phone, 'order_status', 'test']);
  for (let i = 0; i < 3; i++) {
    await db.query("update everwake.outbox set not_before = now() where status = 'queued'");
    const c = await sql(db, "select everwake.outbox_claim(10, 'test') as r");
    const [it] = await runCode('outbox/split_batch.js', { input: c });
    const res = (await runCode('outbox/record_result.js', { input: { body: { response: { message: [{ exists: false }] } } }, nodes: { 'Send Loop': it } }))[0];
    await callB64(db, 'outbox_result', res.b64_result);
  }
  const f = await sql(db, "select status, last_error, attempts from everwake.outbox where body = 'test'");
  assert.equal(f.status, 'failed');
  assert.equal(f.attempts, 3);
  assert.equal(f.last_error, 'This number is not on WhatsApp.');
});

test('a takeover while the model is thinking: nothing is sent; staff replies reach the agent\'s memory', async () => {
  const phone = '201055556666';
  const tenant = (await sql(db, "select id from everwake.tenants where slug = 'nile_grill'")).id;
  let t = await turn(db, evolutionPayload({ phone, text: 'hello' }), async () => ({
    plan: {}, reply: quiet('Hi! I am Nour from Nile Grill.'),
    beforePersist: async () => {
      await db.query("select everwake.take_over(id, 'manager wants this one') from everwake.conversations where wa_id = $1", [phone]);
    }
  }));
  assert.equal(t.persisted.mode, 'human');
  assert.equal(t.outbound.length, 0, 'the agent stays quiet');

  // the manager replies from the dashboard, then hands back
  const conv = (await sql(db, 'select id from everwake.conversations where wa_id = $1', [phone])).id;
  await db.query('select everwake.send_staff_message($1, $2)', [conv, 'أهلاً، أنا أحمد مدير الفرع. الطلب هيوصلك خلال نص ساعة.']);
  await db.query('select everwake.hand_back($1)', [conv]);
  t = await turn(db, evolutionPayload({ phone, text: 'تمام شكراً' }), async (brief) => {
    assert.match(brief.history_text, /team member: أهلاً، أنا أحمد مدير الفرع/);
    assert.match(brief.facts_text, /A TEAM MEMBER handled this chat/);
    return { plan: {}, reply: quiet('العفو! لو احتجت أي حاجة أنا موجودة.') };
  });
  assert.equal(t.outbound.length, 1);
  void tenant;
});

test('a customer WhatsApp hides: asked for a number, recognised by it next time', async () => {
  const lid = '123456789012345';
  const t = await turn(db, evolutionPayload({ lid, pushName: '🌙', text: 'مرحبا عايز ساندوتش كفتة' }), async (brief) => {
    assert.match(brief.facts_text, /their phone number is HIDDEN by WhatsApp privacy/);
    return {
      plan: {},
      tools: [{ tool: 'save_customer_details', details: { phone: '01011112222' } }],
      reply: quiet('أكيد! ممكن رقم موبايل للطلب؟')
    };
  });
  assert.equal(t.outbound[0].reply_to, lid + '@lid', 'replies go to the full private id');
  assert.ok(t.steps[0].result.saved_fields.includes('phone'));
  const ident = await sql(db, "select count(*)::int as n from everwake.customer_identities where kind = 'phone' and value = '01011112222'");
  assert.equal(ident.n, 1);
});

test('outside every zone: no branch is forced, nothing is priced, pickup is the way', async () => {
  const phone = '201077778888';
  const t = await turn(db, evolutionPayload({ phone, location: { lat: 31.2001, lng: 29.9187 } }), async (brief) => {
    assert.match(brief.facts_text, /OUTSIDE every delivery zone/);
    assert.match(brief.facts_text, /BRANCH: NOT CHOSEN YET/);
    return { plan: {}, tools: [{ tool: 'manage_cart', action: 'add', items: [{ menu_id: 'M001', quantity: 1 }] }],
             reply: quiet('للأسف إحنا مش بنوصل للمكان ده، بس تقدر تستلم من فرع الزمالك.') };
  });
  assert.equal(t.steps[0].result.status, 'BRANCH_NEEDED');
  assert.equal(t.steps[0].result.written, false);
});

test('a promo code, a typed area, and a dish sold by weight', async () => {
  const phone = '201099990000';
  const intake = (await callB64(db, 'intake', (await runCode('main/normalize_inbound.js',
    { input: evolutionPayload({ phone, text: 'hi' }) }))[0].b64_intake)).r;
  let r = await manageCart(db, intake, 'set_branch', [], 'المعادي');
  assert.equal(r.status, 'BRANCH_SET');
  assert.equal(r.branch, 'المعادي');
  r = await manageCart(db, intake, 'add', [{ menu_id: 'M001', quantity: 0.6 }]);
  assert.equal(r.cart[0].quantity, 0.5, 'kilos round to the 0.25 step');
  assert.equal(r.subtotal, 240);
  r = await manageCart(db, intake, 'add', [{ menu_id: 'M002', quantity: 1 }]);
  assert.ok(r.problems.some(p => p.code === 'NOT_ON_THIS_BRANCH_MENU' && p.available_at.includes('الزمالك')), 'no lamb chops in Maadi');
  r = await manageCart(db, intake, 'apply_code', [{ promo_code: 'nile20' }]);
  assert.equal(r.status, 'CODE_APPLIED');
  assert.equal(r.discount_total, 20);
  // no pickup chosen yet → the branch's delivery fee (25) is in the total
  assert.equal(r.total, Math.round((240 - 20 + (240 - 20) * 0.14 + 25) * 100) / 100);
  r = await manageCart(db, intake, 'apply_code', [{ promo_code: 'FREEFOOD' }]);
  assert.equal(r.status, 'CODE_NOT_VALID');

  const details = await (await import('./harness.mjs')).saveDetails(db, intake, { delivery_method: 'delivery', address_area: 'دجلة', address_street: 'شارع 9' });
  assert.equal(details.delivery_area.status, 'INSIDE_A_ZONE');
  assert.equal(details.delivery_area.branch, 'المعادي');
  assert.equal(details.address_from, 'typed');
});

test('normalize: groups, reactions, voice notes and the restaurant\'s own phone', async () => {
  const group = evolutionPayload({ phone: '201000', text: 'hi' });
  group.body.data.key.remoteJid = '1203630@g.us';
  assert.equal((await runCode('main/normalize_inbound.js', { input: group }))[0].is_ignorable, true);
  assert.equal((await runCode('main/normalize_inbound.js', { input: evolutionPayload({ phone: '201000', type: 'reaction' }) }))[0].is_ignorable, true);
  const voice = (await runCode('main/normalize_inbound.js', { input: evolutionPayload({ phone: '201000', type: 'audio' }) }))[0];
  assert.equal(voice.customer_message, '[voice note]');
  const noToken = (await runCode('main/normalize_inbound.js', { input: { body: { event: 'messages.upsert', data: { key: { remoteJid: '201@s.whatsapp.net', id: 'x' }, message: { conversation: 'hi' } } }, query: {} } }))[0];
  assert.equal(noToken.is_ignorable, true, 'no instance → not ours');
  const mine = (await runCode('main/normalize_inbound.js', { input: evolutionPayload({ phone: '201011112222', text: 'أنا من الفرع', fromMe: true }) }))[0];
  const r = (await callB64(db, 'intake', mine.b64_intake)).r;
  assert.equal(r.route, 'from_me');
  const logged = (await callB64(db, 'log_phone_reply', mine.b64_intake)).r;
  assert.equal(logged.logged, true);
  assert.equal(unb64(mine.b64_intake).from_me, true);
});
