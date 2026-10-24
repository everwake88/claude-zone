// End-to-end conversations through the real engine code and database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, connect, turn, evolutionPayload, runCode, sql, callB64, unb64, manageCart, psqlFile } from './harness.mjs';

let db;
const ZAMALEK_PIN = { lat: 30.0610, lng: 31.2200 };
const quiet = (text, extra = {}) => ({
  reply_messages: [text], send_menu_images: false, send_item_photos: [], showed_order_summary: false,
  handoff: { needed: false, reason: '' }, language: 'ar', memory_note: '', ...extra });

before(async () => {
  freshDatabase(); db = await connect();
  // the conversations order food: the demo branches are open whatever the hour the tests run
  await db.query(`update everwake.branches set hours = '{"default":[{"open":"00:00","close":"23:59"}]}'`);
});
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

test('moved over from Seagull: known by number or private id, and "same as last time" rebuilds the old order', async () => {
  psqlFile('tests/fixtures/legacy_seagull.sql');
  const tenant = (await sql(db, `insert into everwake.tenants (slug, name_ar, name_en, status, live_at)
                                 values ('seagull', 'سيجال', 'Seagull', 'live', now()) returning id as r`)).r;
  await db.query(`insert into everwake.whatsapp_channels (tenant_id, provider, label, phone_number, instance_name, base_url,
                                                          api_key, webhook_token, status)
                  values ($1, 'evolution', 'Main line', '201555000000', 'seagull', 'https://evo.example.com/', 'k', 'sg-token', 'connected')`,
                 [tenant]);
  const report = (await sql(db, `select everwake.import_legacy_schema($1::uuid, 'legacy_sg') as r`, [tenant])).r;
  assert.equal(report.orders_imported, 4);
  const sg = { instance: 'seagull', token: 'sg-token' };

  // she writes from the private id the old system knew her by
  let t = await turn(db, evolutionPayload({ lid: '123456789012345', pushName: 'Mona', text: 'زي المرة اللي فاتت', ...sg }), async (brief) => {
    assert.match(brief.facts_text, /RETURNING CUSTOMER: 1 previous order\(s\)/);
    assert.match(brief.facts_text, /SG-1042/);
    assert.match(brief.facts_text, /name on file from previous orders: منى/);
    return { plan: { stage: 'building_cart' }, tools: [{ tool: 'manage_cart', action: 'reorder_last' }],
             reply: quiet('رجعتلك نفس طلبك اللي فات من فرع جليم. تحبي أكمل عليه؟') };
  });
  assert.equal(String(t.intake.customer_id), (await sql(db, `select id::text as r from everwake.customers where tenant_id = $1 and lid = '123456789012345'`, [tenant])).r,
               'the imported customer, not a new one');
  let re = t.steps[0].result;
  assert.equal(re.status, 'REORDERED', JSON.stringify(re));
  assert.equal(re.branch, 'جليم', 'the branch of her last order');
  assert.deepEqual(re.cart.map(l => [l.menu_id, l.quantity]), [['M002', 2]]);
  assert.deepEqual(t.checked.violations, []);

  // he writes from his number: a weighed fish with two choice levels, priced from today's menu
  t = await turn(db, evolutionPayload({ phone: '201011111111', pushName: 'Omar', text: 'نفس الأوردر بتاع المرة اللي فاتت', ...sg }), async (brief) => {
    assert.match(brief.facts_text, /RETURNING CUSTOMER: 2 previous order\(s\)/);
    assert.match(brief.facts_text, /SG-1041/);
    return { plan: { stage: 'building_cart' }, tools: [{ tool: 'manage_cart', action: 'reorder_last' }],
             reply: quiet('رجعتلك نفس الطلب من فرع المكس. أكمل؟') };
  });
  re = t.steps[0].result;
  assert.equal(re.status, 'REORDERED', JSON.stringify(re));
  assert.equal(re.branch, 'المكس');
  const fish = re.cart.find(l => l.menu_id === 'M001');
  assert.ok(fish, JSON.stringify(re.cart));
  assert.equal(fish.quantity, 1.5);
  assert.ok(fish.choices.join(' ').includes('مشوي') && fish.choices.join(' ').includes('رز'), JSON.stringify(fish));
  assert.equal(fish.line_total, 675);
  assert.equal(fish.notes, 'من غير شطة');
  assert.ok(re.cart.some(l => l.menu_id === 'M002'));

  // the next order carries on the old numbering
  assert.equal((await sql(db, `select order_no_prefix || '-' || (order_seq + 1) as r from everwake.tenants where id = $1`, [tenant])).r, 'SG-1044');
});

test('a table booking: asked in two natural steps, a summary, sent to the branch team, never "confirmed" by the host', async () => {
  const phone = '201055556666';
  const tenant = (await sql(db, `select id as r from everwake.tenants where slug = 'nile_grill'`)).r;
  await db.query(`update everwake.branches set reservations = 'whatsapp', reservation_max_guests = 10 where tenant_id = $1 and code = 'zamalek'`, [tenant]);
  await db.query(`update everwake.branches set reservations = 'phone', reservation_note_ar = 'الحجز بالتليفون بس' where tenant_id = $1 and code <> 'zamalek'`, [tenant]);
  const tomorrow = (await sql(db, `select to_char((now() at time zone 'Africa/Cairo')::date + 1, 'YYYY-MM-DD') as r`)).r;

  // 1. "a table tomorrow": the day is saved, the rest is asked together
  let t = await turn(db, evolutionPayload({ phone, pushName: 'Karim', text: 'عايز أحجز ترابيزة بكرة' }), async (brief) => {
    assert.match(brief.facts_text, /TABLE BOOKINGS \(dine-in/);
    assert.match(brief.facts_text, /taken here on WhatsApp \(manage_reservation\) at: الزمالك \(code zamalek, up to 10 guests\)/);
    assert.match(brief.facts_text, /by phone only — give the number, do not take the booking: .*الحجز بالتليفون بس/);
    assert.ok(brief.facts_text.includes(`tomorrow `) && brief.facts_text.includes(tomorrow), 'the coming days, for the date');
    assert.equal(brief.reservations_on_whatsapp, true);
    return {
      plan: { stage: 'reservation', objective: 'start the booking', actions: [{ tool: 'manage_reservation', do: `update date ${tomorrow}` }] },
      tools: [{ tool: 'manage_reservation', action: 'update', details: JSON.stringify({ date: tomorrow }) }],
      reply: quiet('أكيد! بكرة في فرع الزمالك؟ تحب الساعة كام، وهتكونوا كام شخص؟')
    };
  });
  assert.equal(t.steps[0].result.status, 'SAVED', JSON.stringify(t.steps[0].result));
  assert.deepEqual(t.steps[0].result.missing, ['branch', 'time', 'guests', 'full_name']);
  assert.deepEqual(t.checked.violations, []);

  // 2. branch, time, guests and the occasion in one answer
  t = await turn(db, evolutionPayload({ phone, text: 'الزمالك الساعة 9 بالليل، هنكون 4، عيد ميلاد مراتي' }), async (brief) => {
    assert.match(brief.facts_text, new RegExp(`BOOKING IN PROGRESS: date ${tomorrow}`));
    assert.match(brief.facts_text, /phone 01055556666 \(their WhatsApp number/);
    assert.match(brief.facts_text, /still needed: which branch · the time · how many people · the name · summary: not shown yet/);
    return {
      plan: { stage: 'reservation', actions: [{ tool: 'manage_reservation', do: 'update branch zamalek, time 21:00, guests 4, occasion عيد ميلاد' }] },
      tools: [{ tool: 'manage_reservation', action: 'update', details: { branch: 'الزمالك', time: '21:00', guests: 4, occasion: 'عيد ميلاد' } }],
      reply: quiet('كل سنة وهي طيبة 🎉 الحجز يكون باسم مين؟ ولو حابب نجهز حاجة مخصوص للمناسبة قولي.')
    };
  });
  assert.deepEqual(t.steps[0].result.missing, ['full_name']);
  assert.equal(t.steps[0].result.reservation.time_ar, '9:00 مساءً');
  assert.deepEqual(t.checked.violations, []);

  // 3. the name and a request: the summary, shown as the tool wrote it
  t = await turn(db, evolutionPayload({ phone, text: 'باسم كريم، ولو ينفع ترابيزة جنب الشباك' }), async () => ({
    plan: { stage: 'reservation', actions: [{ tool: 'manage_reservation', do: 'update full_name كريم, requests' }, { tool: 'manage_reservation', do: 'summary' }] },
    tools: [{ tool: 'manage_reservation', action: 'update', details: { full_name: 'كريم', requests: 'ترابيزة جنب الشباك' } },
            { tool: 'manage_reservation', action: 'summary' }],
    reply: (steps) => quiet(`${steps[1].result.summary_text}\n\nكده تمام أبعته للفرع؟`)
  }));
  assert.equal(t.steps[1].result.status, 'SUMMARY_READY');
  assert.match(t.checked.decision.reply_messages[0], /👥 4 أشخاص\n🎉 المناسبة: عيد ميلاد\n👤 باسم: كريم · 📞 01055556666\n📝 طلبات خاصة: ترابيزة جنب الشباك/);
  assert.deepEqual(t.checked.violations, [], 'the day, the time and the phone are facts');

  // 4. yes: sent to the branch team with the customer's details; the reference is added when the host forgets it
  t = await turn(db, evolutionPayload({ phone, text: 'تمام ابعته' }), async (brief) => {
    assert.match(brief.facts_text, /summary: shown and still matches/);
    return {
      plan: { stage: 'reservation', actions: [{ tool: 'manage_reservation', do: 'submit' }] },
      tools: [{ tool: 'manage_reservation', action: 'submit' }],
      reply: quiet('تمام! بعتنا طلب الحجز لفرع الزمالك، وهيكلموك يأكدوا معاك قريب.')
    };
  });
  const ref = t.steps[0].result.ref_no;
  assert.equal(t.steps[0].result.status, 'REQUESTED');
  assert.match(ref, /^NG-R\d+$/);
  assert.deepEqual(t.checked.violations, []);
  assert.ok(t.checked.decision.reply_messages.at(-1).endsWith(`رقم طلب الحجز: ${ref}`), t.checked.decision.reply_messages.join('|'));
  const ticket = (await sql(db, `select body as r from everwake.outbox where purpose = 'order_ticket' and body like $1`, [`🍽 طلب حجز ترابيزة ${ref}%`])).r;
  assert.match(ticket, /🏪 فرع الزمالك[\s\S]*👥 4 أشخاص · 🎉 عيد ميلاد\n👤 كريم · 📞 01055556666\n📝 ترابيزة جنب الشباك/);

  // 5. "is it confirmed?" — it is not, and a reply that says so is rewritten
  t = await turn(db, evolutionPayload({ phone, text: 'هو الحجز اتأكد؟' }), async (brief) => {
    assert.match(brief.facts_text, new RegExp(`THEIR BOOKINGS:\\n  ${ref} · الزمالك · .* 9:00 مساءً · 4 guests · عيد ميلاد · REQUESTED`));
    assert.doesNotMatch(brief.facts_text, /BOOKING IN PROGRESS/);
    return { plan: { stage: 'reservation' }, reply: quiet('أيوه حجزك اتأكد ✅ مستنيينك بكرة!'),
             rewrite: [`لسه الفرع هيكلمك يأكد الحجز ${ref} — أول ما يأكدوا هيوصلك تأكيد هنا.`] };
  });
  assert.equal(t.checked.repair_used, true);
  assert.match(t.nodes['Check Reply'].violations[0], /booked or confirmed/);
  assert.match(t.checked.decision.reply_messages[0], /^لسه الفرع هيكلمك/);

  // 6. the team confirms on the dashboard: the customer hears it, and now the host may say so
  const rid = (await sql(db, `select id as r from everwake.reservations where ref_no = $1`, [ref])).r;
  await sql(db, `select everwake.set_reservation_status($1, 'confirmed') as r`, [rid]);
  assert.ok((await sql(db, `select count(*)::int as r from everwake.outbox where wa_id = $1 and purpose = 'order_status' and body like 'تم تأكيد حجزك ✅%'`, [phone])).r === 1);
  t = await turn(db, evolutionPayload({ phone, text: 'تمام شكراً' }), async (brief) => {
    assert.match(brief.facts_text, /CONFIRMED by the branch team/);
    return { plan: { stage: 'reservation' }, reply: quiet('العفو! حجزك متأكد، مستنيينك بكرة 🎉') };
  });
  assert.deepEqual(t.checked.violations, []);
  await db.query(`update everwake.branches set reservations = 'off', reservation_note_ar = null where tenant_id = $1`, [tenant]);
});

test('paying online: the link goes out with the order, "paid" only after Paymob says so', async () => {
  const phone = '201066667777';
  const tenant = (await sql(db, `select id as r from everwake.tenants where slug = 'nile_grill'`)).r;
  await sql(db, `select everwake.save_payment_account($1, $2) as r`, [tenant, { public_key: 'egy_pk_test_x', secret_key: 'egy_sk_test_y',
    hmac_secret: 'H', card_integration_id: '4097558', dashboard_url: 'https://dash.example', enabled: true }]);

  // they choose to pay online; the summary is shown
  let t = await turn(db, evolutionPayload({ phone, pushName: 'Karim', text: 'عايز فرخة كاملة حارة استلام من الزمالك، باسم كريم، والدفع أونلاين بالفيزا' }), async (brief) => {
    assert.match(brief.facts_text, /PAYMENT METHODS YOU MAY PROMISE: .*online \(payment_method "online": a secure payment link/);
    return {
      plan: { stage: 'reviewing', show_summary: true },
      tools: [
        { tool: 'save_customer_details', details: { full_name: 'كريم', phone_confirmed: 'yes', delivery_method: 'استلام', payment_method: 'أونلاين بالفيزا' } },
        { tool: 'manage_cart', action: 'set_branch', branch: 'zamalek' },
        { tool: 'manage_cart', action: 'add', items: [{ menu_id: 'M003', quantity: 1, choices: [{ selected: ['فرخة كاملة', 'حار'] }] }] }
      ],
      reply: (steps) => quiet(`ملخص طلبك:\n*فرخة مشوية* كاملة حار — 480ج\n*الإجمالي ${steps[2].result.total}ج*\nاستلام من الزمالك · الدفع أونلاين (لينك بعد التأكيد)\nأأكد؟`,
                              { showed_order_summary: true })
    };
  });
  assert.deepEqual(t.steps[0].result.rejected || [], []);
  assert.equal((await sql(db, `select state -> 'customer' ->> 'payment_method' as r from everwake.conversations where wa_id = $1`, [phone])).r, 'online');
  assert.deepEqual(t.checked.violations, []);

  // yes: placed, and the payment link rides with the confirmation even when the host forgets it
  t = await turn(db, evolutionPayload({ phone, text: 'تمام أكد' }), async () => ({
    plan: { stage: 'placed', place_order: true },
    tools: [{ tool: 'manage_cart', action: 'place_order' }],
    reply: (steps) => quiet(`تمام يا كريم، طلبك ${steps[0].result.order_no} اتسجل 👌`)
  }));
  const placed = t.steps[0].result;
  assert.equal(placed.status, 'PLACED', JSON.stringify(placed.reasons));
  assert.equal(placed.payment.status, 'LINK_READY', JSON.stringify(placed.payment));
  assert.match(placed.payment.link, /^https:\/\/dash\.example\/p\/[0-9a-f]{12}$/);
  assert.deepEqual(t.checked.violations, []);
  assert.ok(t.checked.decision.reply_messages.at(-1).endsWith(`لينك الدفع: ${placed.payment.link}`), t.checked.decision.reply_messages.join('|'));
  assert.match(t.ticket[0].text, /أونلاين \(لينك دفع\)/);

  // "I paid" before Paymob's notice: the host may not say it arrived
  t = await turn(db, evolutionPayload({ phone, text: 'دفعت خلاص' }), async (brief) => {
    assert.match(brief.facts_text, new RegExp(`payment: NOT PAID YET — link ${placed.payment.link.replace(/[.]/g, '\\.')}`));
    return { plan: { stage: 'support' }, reply: quiet('تمام اتدفع ✅ شكراً!'),
             rewrite: [`لسه الدفع موصلش عندنا — أول ما يوصل هيجيلك تأكيد هنا على طول. لو محتاج اللينك تاني: ${placed.payment.link}`] };
  });
  assert.equal(t.checked.repair_used, true);
  assert.match(t.nodes['Check Reply'].violations[0], /payment arrived/);
  assert.match(t.checked.decision.reply_messages[0], /^لسه الدفع موصلش/);

  // Paymob's notice (the dashboard checked its signature): paid, the customer and the branch hear it
  const ref = placed.payment.link.split('/').pop();
  const cents = Math.round(placed.total * 100);
  const r = (await sql(db, `select everwake.payment_callback($1, $2) as r`, [tenant, { merchant_order_id: ref, success: true, pending: false, amount_cents: cents }])).r;
  assert.equal(r.status, 'paid');
  assert.ok((await sql(db, `select count(*)::int as r from everwake.outbox where wa_id = $1 and body like 'تم استلام الدفع ✅%'`, [phone])).r === 1);
  t = await turn(db, evolutionPayload({ phone, text: 'وصل؟' }), async (brief) => {
    assert.match(brief.facts_text, /payment: PAID online/);
    return { plan: { stage: 'support' }, reply: quiet('أيوه، الدفع وصل ✅ وطلبك بيتجهز.') };
  });
  assert.deepEqual(t.checked.violations, []);
  await sql(db, `select everwake.save_payment_account($1, $2) as r`, [tenant, { enabled: false }]);
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

test('branches that differ: Maadi\'s own menu and choice prices, no seating there, cash only', async () => {
  const phone = '201077778888';
  const tenant = (await sql(db, `select id as r from everwake.tenants where slug = 'nile_grill'`)).r;
  const maadi = (await sql(db, `select id as r from everwake.branches where tenant_id = $1 and code = 'maadi'`, [tenant])).r;
  await sql(db, `update everwake.branches set dine_in = (code = 'zamalek'), payment_methods = case when code = 'maadi' then array['cash'] end,
                   reservations = 'off' where tenant_id = $1 returning 1 as r`, [tenant]);
  const sandwiches = `(select jsonb_agg(id) from everwake.menu_items where tenant_id = $1 and code in ('M004', 'M005'))`;
  await sql(db, `select everwake.branch_menu_update($1, $2, jsonb_build_object('items', ${sandwiches}, 'listed', false)) as r`, [tenant, maadi]);
  await sql(db, `insert into everwake.menu_option_branches (tenant_id, option_id, branch_id, item_id, price_delta)
                 select o.tenant_id, o.id, $2, g.item_id, 230 from everwake.menu_options o
                   join everwake.menu_option_groups g on g.id = o.group_id join everwake.menu_items i on i.id = g.item_id
                  where i.tenant_id = $1 and i.code = 'M003' and o.name_ar = 'فرخة كاملة' returning 1 as r`, [tenant, maadi]);

  // before a branch: each branch's payment methods; card is not taken in Maadi
  let t = await turn(db, evolutionPayload({ phone, pushName: 'Sara', text: 'عايزة فرخة كاملة حارة توصيل من فرع المعادي، والدفع كارت' }), async (brief) => {
    assert.match(brief.facts_text, /PAYMENT METHODS YOU MAY PROMISE — each branch its own: الزمالك: cash, card on delivery, InstaPay · المعادي: cash/);
    assert.match(brief.business_text, /المعادي .*NO seating — delivery and pickup only · pays: cash/);
    assert.match(brief.business_text, /الزمالك .*seating: yes/);
    return {
      plan: { stage: 'ordering' },
      tools: [
        { tool: 'manage_cart', action: 'set_branch', branch: 'maadi' },
        { tool: 'manage_cart', action: 'add', items: [{ menu_id: 'M003', quantity: 1, choices: [{ selected: ['فرخة كاملة', 'حار'] }] }] },
        { tool: 'save_customer_details', details: { delivery_method: 'توصيل', payment_method: 'كارت' } }
      ],
      reply: quiet('تمام، فرع المعادي بياخد كاش بس — ينفع كاش عند الاستلام؟')
    };
  });
  assert.equal(t.steps[1].result.cart[0].line_total, 500, 'Maadi\'s chicken 270 + its own whole-chicken price 230');
  assert.deepEqual(t.steps[2].result.rejected, [{ field: 'payment_method', reason: 'NOT_TAKEN_AT_THIS_BRANCH', accepted: ['cash'] }]);

  // Maadi's menu: no sandwiches (said to be at Zamalek), no shisha (dine-in only, no seating)
  t = await turn(db, evolutionPayload({ phone, text: 'طب الزمالك فيه كارت؟ خليها الزمالك بالكارت… لا لا خليها المعادي' }), async (brief) => {
    assert.match(brief.facts_text, /BRANCH: المعادي .*NO seating — delivery and pickup only/);
    assert.match(brief.facts_text, /PAYMENT METHODS YOU MAY PROMISE at المعادي: cash \(/);
    assert.match(brief.menu_text, /فرخة كاملة \+230ج/);
    assert.ok(!/M004|M005|M011/.test(brief.menu_text.split('### not on this branch')[0]), 'only Maadi\'s dishes in its menu');
    assert.match(brief.menu_text, /only at other branches:\n.*ساندوتش كفتة \(الزمالك\)/);
    assert.ok(!/شيشة/.test(brief.menu_text), 'a dine-in only dish is never offered where there is no seating');
    return {
      plan: { stage: 'ordering' },
      tools: [
        { tool: 'manage_cart', action: 'set_branch', branch: 'zamalek' },
        { tool: 'save_customer_details', details: { payment_method: 'card' } },
        { tool: 'manage_cart', action: 'set_branch', branch: 'maadi' },
        { tool: 'manage_cart', action: 'place_order' }
      ],
      reply: quiet('تمام رجعناها المعادي — هناك الدفع كاش بس.')
    };
  });
  assert.deepEqual(t.steps[1].result.rejected || [], [], 'Zamalek takes card');
  assert.deepEqual(t.steps[2].result.payment_not_taken_here, { method: 'card', this_branch_takes: ['cash'] });
  assert.ok(t.steps[3].result.reasons.some(x => x.code === 'PAYMENT_NOT_TAKEN_AT_BRANCH' && x.method === 'card'), JSON.stringify(t.steps[3].result.reasons));

  t = await turn(db, evolutionPayload({ phone, text: 'ماشي' }), async (brief) => {
    assert.match(brief.facts_text, /⚠ the payment method on file \(card on delivery\) is NOT taken at المعادي/);
    assert.match(brief.facts_text, /STILL MISSING TO PLACE AN ORDER: .*payment method/);
    return { plan: { stage: 'details' }, reply: quiet('تمام، هيبقى كاش عند الاستلام؟') };
  });

  await sql(db, `delete from everwake.menu_option_branches where branch_id = $1 returning 1 as r`, [maadi]);
  await sql(db, `select everwake.branch_menu_update($1, $2, jsonb_build_object('items', ${sandwiches}, 'listed', true)) as r`, [tenant, maadi]);
  await sql(db, `update everwake.branches set dine_in = null, payment_methods = null where tenant_id = $1 returning 1 as r`, [tenant]);
});

test('the Egyptian voice: نص كيلو, 01… numbers, no "العربة", and a villa has no floor to ask for', async () => {
  const phone = '201099991234';
  const tenant = (await sql(db, `select id as r from everwake.tenants where slug = 'nile_grill'`)).r;
  const before = (await sql(db, `select settings as r from everwake.tenants where id = $1`, [tenant])).r;
  await db.query(`update everwake.tenants set settings = settings || '{"required_fields": {"delivery": ["phone_confirmed", "full_name",
    "delivery_method", "address_area", "address_street", "address_building", "address_floor", "address_apartment"]}}' where id = $1`, [tenant]);
  try {
    const t = await turn(db, evolutionPayload({ phone, text: 'عايز نص كيلو بوري توصيل لدجلة شارع 9 فيلا 14، أنا أحمد' }), async () => ({
      plan: { read: 'order + address', stage: 'ordering', objective: 'add and save', actions: [] },
      tools: [
        { tool: 'manage_cart', action: 'set_branch', branch: 'المعادي' },
        { tool: 'manage_cart', action: 'add', items: [{ menu_id: 'M001', quantity: 0.5 }] },
        { tool: 'save_customer_details', details: { full_name: 'أحمد', delivery_method: 'توصيل', address_area: 'دجلة',
                                                    address_street: 'شارع 9', address_building: 'فيلا 14' } }
      ],
      reply: quiet('تمت إضافة 0.5 كيلو للعربة. هل رقم الواتساب المسجل +201099991234 هو رقم الطلب؟'),
      rewrite: ['تمام يا أحمد، نص كيلو بوري 👌 أطلب على 01099991234 ولا رقم تاني؟']
    }));
    assert.equal(t.steps[1].result.cart[0].say, 'نص كيلو', 'the cart says the weight the way people do');
    const left = t.steps[2].result.still_missing_for_order;
    assert.ok(!left.includes('address_floor') && !left.includes('address_apartment'), 'a villa: ' + JSON.stringify(left));
    const v = t.nodes['Check Reply'].violations.join('\n');
    assert.match(v, /sounds like a system/);
    assert.match(v, /local way: 01099991234/);
    assert.match(v, /نص كيلو/);
    assert.ok(!/not prices, totals/.test(v), 'the number in its local form is theirs: ' + v);
    assert.deepEqual(t.checked.decision.reply_messages, ['تمام يا أحمد، نص كيلو بوري 👌 أطلب على 01099991234 ولا رقم تاني؟']);
    assert.match(t.brief.facts_text, /their WhatsApp number: 01099991234/);
  } finally {
    await db.query(`update everwake.tenants set settings = $2 where id = $1`, [tenant, before]);
  }
});
