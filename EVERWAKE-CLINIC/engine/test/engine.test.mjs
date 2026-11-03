// Whole WhatsApp conversations through the real engine code and the real database.
// Only the models are scripted; every Code node, every SQL function and the tools run for real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, connect, turn, evolutionPayload, sql } from './harness.mjs';

let db, tenant;
const say = (text, extra = {}) => ({ reply_messages: [text], ask_team: [], handoff: { needed: false, reason: '' }, language: 'ar', memory_note: '', ...extra });
const optionsText = (steps, i = 0) => steps[i].result.options.map(o => `${o.option}) ${o.label}`).join('\n');
const sat = async () => (await sql(db, `select (select d::date from generate_series(clinic.local_today($1) + 2, clinic.local_today($1) + 8, '1 day') d
                                          where extract(dow from d) = 6 limit 1)::text as r`, [tenant])).r;

before(async () => {
  freshDatabase();
  db = await connect();
  tenant = (await sql(db, `select id as r from clinic.tenants where slug = 'nile_clinics'`)).r;
});
after(async () => { if (db) await db.end(); });

test('a new patient books a cleaning: the day worked out in code, options, a hold, the summary, booked with the pin', async () => {
  const phone = '201011112222';
  const day = await sat();
  // 1. "Saturday evening, a cleaning"
  let t = await turn(db, evolutionPayload({ phone, pushName: 'Ahmed Samir', text: 'السلام عليكم، عايز احجز تنضيف جير يوم السبت بالليل' }), async (brief) => {
    assert.match(brief.facts_text, /PATIENTS THIS NUMBER BOOKS FOR: none yet — a new person\. A booking needs the patient's name and age/);
    assert.match(brief.facts_text, new RegExp(`«يوم السبت» = السبت \\d\\d/\\d\\d \\(${day}\\)`));
    assert.match(brief.facts_text, /«بالليل» = the evening/);
    assert.ok(brief.facts_text.includes(`→ for find_slots: ("date":"${day}","band":"evening")`), brief.facts_text);
    assert.match(brief.facts_text, /THEIR WORDS POINT TO: dentistry \(«جير»\) → د\. منى عادل/);
    assert.match(brief.business_text, /تنضيف جير وتلميع \/ Scaling and polishing — 600 ج/);
    assert.equal(brief.triage.level, null);
    return {
      plan: { read: 'new patient wants a cleaning Saturday evening', stage: 'choosing_time', objective: 'offer times', urgency: { level: 'none' } },
      tools: [{ action: 'find_slots', details: { service: 'تنظيف', date: day, band: 'evening' } }],
      reply: (steps) => say(`أهلاً بحضرتك، أنا نور من عيادات النيل 😊 تنضيف الجير والتلميع بـ 600 ج مع د. منى. المتاح السبت:\n${optionsText(steps)}\nأنهي ميعاد يناسبك؟`)
    };
  });
  assert.equal(t.route, 'agent');
  assert.equal(t.steps[0].result.status, 'OPTIONS', JSON.stringify(t.steps[0].result));
  assert.ok(t.steps[0].result.options.every(o => o.date === day && o.band === 'evening'));
  assert.deepEqual(t.checked.violations, [], 'every number in the reply is real');

  // 2. "the second one, I'm Ahmed Samir, 32"
  t = await turn(db, evolutionPayload({ phone, text: 'التاني، اسمي أحمد سمير وعندي 32 سنة' }), async (brief) => {
    assert.match(brief.facts_text, /OPTIONS OFFERED LAST \(they may answer with the number/);
    return {
      plan: { stage: 'confirming' },
      tools: [{ action: 'update', details: { option: 2, full_name: 'أحمد سمير', age: '32', relation: 'self', reason: 'تنضيف جير' } },
              { action: 'summary' }],
      reply: (steps) => say(`${steps[1].result.summary_text}\n\nأأكد الحجز؟`)
    };
  });
  assert.equal(t.steps[0].result.held.status, 'held');
  assert.equal(t.steps[1].result.status, 'SUMMARY_READY');
  assert.deepEqual(t.checked.violations, []);

  // 3. "yes" → booked; the number is added when she forgets it, and the location pin goes out
  t = await turn(db, evolutionPayload({ phone, text: 'تمام اكد' }), async (brief) => {
    assert.match(brief.facts_text, /summary: SHOWN and still matches — a yes means book/);
    return { plan: { stage: 'booked' }, tools: [{ action: 'book' }],
             reply: say('اتحجزلك يا أحمد ✅ مستنيينك السبت، وهيوصلك تذكير قبل الميعاد.') };
  });
  const ref = t.steps[0].result.appointment.ref_no;
  assert.match(ref, /^NC-\d+$/);
  assert.deepEqual(t.checked.violations, [], JSON.stringify(t.checked.violations));
  assert.ok(t.checked.decision.reply_messages.at(-1).endsWith(`رقم الحجز: ${ref}`));
  assert.equal(t.outbound.at(-1).kind, 'location');
  assert.equal(t.outbound.at(-1).place, 'المعادي');

  // 4. next time, they're someone the clinic knows
  t = await turn(db, evolutionPayload({ phone, text: 'هو الميعاد بتاعي امتى؟' }), async (brief) => {
    assert.match(brief.facts_text, /PATIENTS THIS NUMBER BOOKS FOR[\s\S]*أحمد سمير \[patient_id \d+\] \(themself\)/);
    assert.match(brief.facts_text, new RegExp(`UPCOMING VISITS:\\n  - ${ref} · أحمد سمير · تنضيف جير وتلميع · د\\. منى عادل · السبت`));
    return { plan: { stage: 'question' }, reply: say(`ميعادك السبت مع د. منى في المعادي، رقم الحجز ${ref} 😊`) };
  });
  assert.deepEqual(t.checked.violations, []);
});

test('"بعده": the times after the last ones offered, and a child booked by queue number from the same number', async () => {
  const phone = '201022223333';
  let t = await turn(db, evolutionPayload({ phone, text: 'عايز احجز لابني يوسف عنده 6 سنين عند دكتور كريم، عنده سخونية وكحة' }), async (brief) => {
    assert.match(brief.facts_text, /THEIR WORDS POINT TO: .*pediatrics \(«ابني»\) → د\. كريم حسن/);
    assert.match(brief.facts_text, /THEIR WORDS POINT TO: .*they named د\. كريم حسن|pediatrics/);
    return { plan: { stage: 'choosing_time' },
             tools: [{ action: 'find_slots', details: { doctor: 'كريم', full_name: 'يوسف أحمد', age: '6', relation: 'child', reason: 'سخونية وكحة' } }],
             reply: (steps) => say(`ألف سلامة على يوسف 🙏 د. كريم بيكشف بالدور:\n${optionsText(steps)}\nيناسبك أنهي يوم؟`) };
  });
  const first = t.steps[0].result.options;
  assert.equal(first[0].kind, 'queue');
  assert.deepEqual(t.checked.violations, [], JSON.stringify(t.checked.violations));

  t = await turn(db, evolutionPayload({ phone, text: 'لا بعده' }), async (brief) => {
    assert.match(brief.facts_text, /«بعده» = a time AFTER the last one offered/);
    assert.ok(brief.facts_text.includes('→ for find_slots: ("after":"last_offered")'));
    return { plan: { stage: 'choosing_time' }, tools: [{ action: 'find_slots', details: { after: 'last_offered' } }],
             reply: (steps) => say(`تمام، الأيام اللي بعد كده:\n${optionsText(steps)}`) };
  });
  const later = t.steps[0].result.options;
  assert.ok(later.length > 0 && later.every(o => o.date > first[first.length - 1].date), JSON.stringify(later));

  t = await turn(db, evolutionPayload({ phone, text: '1' }), async () => ({
    plan: { stage: 'confirming' }, tools: [{ action: 'update', details: { option: 1 } }, { action: 'summary' }],
    reply: (steps) => say(`${steps[1].result.summary_text}\n\nأأكد؟`)
  }));
  assert.match(t.steps[1].result.summary_text, /الحجز لـ: يوسف أحمد/);
  t = await turn(db, evolutionPayload({ phone, text: 'ايوه' }), async () => ({
    plan: { stage: 'booked' }, tools: [{ action: 'book' }], reply: (steps) => say(`تمام ✅ يوسف دوره رقم ${steps[0].result.appointment.queue_no}.`)
  }));
  assert.equal(t.steps[0].result.status, 'BOOKED');
  assert.equal(t.steps[0].result.appointment.mode, 'queue');
  assert.deepEqual(t.checked.violations, []);
  const kids = (await sql(db, `select count(*)::int as r from clinic.patient_contacts pc join clinic.contacts c on c.id = pc.contact_id
                               where c.wa_id = $1 and pc.relation = 'child'`, [phone])).r;
  assert.equal(kids, 1);
});

test('an emergency: the guidance goes first even when the reply forgot it, an alert on the dashboard, the doctor told', async () => {
  const phone = '201033334444';
  const t = await turn(db, evolutionPayload({ phone, text: 'ابني مش قادر يتنفس وشفايفه زرقا' }), async (brief) => {
    assert.equal(brief.triage.level, 'emergency');
    assert.match(brief.facts_text, /RED FLAGS: EMERGENCY — cannot breathe/);
    return { plan: { stage: 'emergency', urgency: { level: 'emergency', reason: 'child cannot breathe' } },
             reply: say('سلامته! تحب أحجزلك أقرب ميعاد مع د. كريم؟') };
  });
  assert.match(t.checked.decision.reply_messages[0], /^لو الحالة طارئة متستناش الميعاد: اتصل بالإسعاف 123/);
  assert.equal(t.checked.urgency, 'emergency');
  const alert = await sql(db, `select kind as r, severity from clinic.alerts where wa_id = $1`, [phone]);
  assert.equal(alert.r, 'emergency');
  assert.equal(alert.severity, 'critical');
  assert.equal((await sql(db, `select urgency as r from clinic.conversations where wa_id = $1`, [phone])).r, 'emergency');
  assert.ok((await sql(db, `select count(*)::int as r from clinic.outbox where purpose = 'staff_alert'`)).r >= 1, 'a doctor was told');
});

test('hard rails: an invented price, a dose, a booking that did not happen', async () => {
  const phone = '201044445555';
  // an invented price is dropped (the true one with the offer is fine)
  let t = await turn(db, evolutionPayload({ phone, text: 'التبييض بكام؟' }), async () => ({
    plan: { stage: 'prices' }, reply: say('التبييض بـ 3,000 ج وعليه خصم 20% الشهر ده، يعني 2,400 ج 😊\nوكمان التلميع بـ 450 ج بس.')
  }));
  assert.equal(t.checked.violations.length, 1, JSON.stringify(t.checked.violations));
  assert.match(t.checked.violations[0], /450/);
  assert.equal(t.checked.decision.reply_messages[0], 'التبييض بـ 3,000 ج وعليه خصم 20% الشهر ده، يعني 2,400 ج 😊');
  // a dose is the doctor's call
  t = await turn(db, evolutionPayload({ phone, text: 'سناني بتوجعني اخد ايه؟' }), async () => ({
    plan: { stage: 'question' }, reply: say('سلامتك 🙏 ممكن تاخد بنادول 500 مجم لحد الكشف.\nتحب أحجزلك أقرب ميعاد مع د. منى؟')
  }));
  assert.ok(t.checked.violations.some(v => /medicine or a dose/.test(v)), JSON.stringify(t.checked.violations));
  assert.deepEqual(t.checked.decision.reply_messages, ['تحب أحجزلك أقرب ميعاد مع د. منى؟']);
  // "booked" without book
  t = await turn(db, evolutionPayload({ phone, text: 'احجزلي بكره' }), async () => ({ plan: { stage: 'booking' }, reply: say('تمام اتحجزلك بكره 👍') }));
  assert.ok(t.checked.violations.some(v => /book did NOT return BOOKED/.test(v)));
});

test('the reminder\'s "1" confirms the visit it was about', async () => {
  const phone = '201055556666';
  const day = await sat();
  await sql(db, `select clinic.staff_book($1, jsonb_build_object('doctor_id', (select id from clinic.doctors where code = 'D1' and tenant_id = $1),
                   'service_id', clinic.match_service($1, 'كشف أسنان'), 'starts_at', (($2::date + time '20:00') at time zone 'Africa/Cairo'),
                   'patient', jsonb_build_object('full_name', 'منة الله', 'phone', '01055556666'), 'notify', false))`, [tenant, day]);
  await db.query(`update clinic.appointment_reminders set due_at = now() - interval '1 minute' where key = 'day_before'
                   and appointment_id = (select id from clinic.appointments where wa_id = $1)`, [phone]);
  await sql(db, 'select clinic.reminders_due()');
  const t = await turn(db, evolutionPayload({ phone, text: '1' }), async (brief) => {
    assert.match(brief.facts_text, /WHAT THEY ARE REPLYING TO[\s\S]*the clinic's reminder about NC-\d+[\s\S]*1 \/ coming = confirm/);
    assert.match(brief.history_text, /the clinic \(reminder\): أهلاً منة/);
    return { plan: { stage: 'reply_to_reminder' }, tools: [{ action: 'confirm' }], reply: say('تمام، مستنيينك 🌿') };
  });
  assert.equal(t.steps[0].result.status, 'CONFIRMED');
  assert.equal((await sql(db, `select status as r from clinic.appointments where wa_id = $1`, [phone])).r, 'confirmed');
});

test('the doctor\'s own WhatsApp: "I\'m 20 minutes late" → preview → yes → sent; the patient accepts the new time', async () => {
  const day = await sat();
  // a Saturday patient to tell
  const phone = '201066667777';
  await sql(db, `select clinic.staff_book($1, jsonb_build_object('doctor_id', (select id from clinic.doctors where code = 'D1' and tenant_id = $1),
                   'service_id', clinic.match_service($1, 'كشف أسنان'), 'starts_at', (($2::date + time '21:00') at time zone 'Africa/Cairo'),
                   'patient', jsonb_build_object('full_name', 'سلمى رضا', 'phone', '01066667777'), 'notify', false))`, [tenant, day]);
  const doctor = '201000000101';
  let t = await turn(db, evolutionPayload({ phone: doctor, text: 'هتأخر 20 دقيقة يوم السبت' }), async (brief) => {
    assert.match(brief.staff_prompt, /YOU ARE TALKING TO: د\. منى عادل — doctor/);
    assert.match(brief.staff_prompt, new RegExp(`«يوم السبت» = السبت \\d\\d/\\d\\d \\(${day}\\)`));
    return { tools: [{ action: 'delay', details: { minutes: 20, date: day } }],
             reply: (steps) => ({ reply_messages: [`هبعت لـ ${steps[0].result.count} مرضى إن الميعاد هيتأخر 20 دقيقة. أبعتلهم؟`], language: 'ar' }) };
  });
  assert.equal(t.route, 'staff');
  assert.equal(t.steps[0].result.status, 'PREVIEW');
  assert.deepEqual(t.checked.violations, []);
  t = await turn(db, evolutionPayload({ phone: doctor, text: 'تمام ابعت' }), async (brief) => {
    assert.match(brief.staff_prompt, /WAITING FOR THEIR YES: delay/);
    return { tools: [{ action: 'confirm' }], reply: (steps) => ({ reply_messages: [`✅ اتبعت لـ ${steps[0].result.messaged} مرضى.`], language: 'ar' }) };
  });
  assert.equal(t.steps[0].result.status, 'SENT');
  // the patient says OK
  t = await turn(db, evolutionPayload({ phone, text: 'تمام مفيش مشكلة' }), async (brief) => {
    assert.match(brief.facts_text, /the clinic's message that the doctor is 20 min late: NC-\d+ is now at 21:20 instead of 21:00/);
    return { plan: { stage: 'reply_to_delay' }, tools: [{ action: 'accept_delay' }], reply: say('شكراً لتفهمك 🙏 مستنيينك 9:20.') };
  });
  assert.equal(t.steps[0].result.status, 'DELAY_ACCEPTED');
  assert.equal((await sql(db, `select i.status as r from clinic.delay_notice_items i join clinic.appointments a on a.id = i.appointment_id
                               where a.wa_id = $1 order by i.id desc limit 1`, [phone])).r, 'accepted');
});

test('the doctor changes a price from WhatsApp; the next patient hears the new one', async () => {
  const doctor = '201000000101';
  let t = await turn(db, evolutionPayload({ phone: doctor, text: 'ارفع سعر التنضيف لـ 700' }), async () => ({
    tools: [{ action: 'catalog', details: { changes: [{ op: 'set_price', service: 'تنضيف', price: 700 }] } }],
    reply: (steps) => ({ reply_messages: [`${steps[0].result.summary_ar}\nأأكد؟`], language: 'ar' })
  }));
  assert.equal(t.steps[0].result.status, 'PREVIEW');
  t = await turn(db, evolutionPayload({ phone: doctor, text: 'اه' }), async () => ({
    tools: [{ action: 'confirm' }], reply: { reply_messages: ['✅ تمام، التنضيف بقى 700 ج.'], language: 'ar' }
  }));
  assert.equal(t.steps[0].result.status, 'APPLIED');
  t = await turn(db, evolutionPayload({ phone: '201077778888', text: 'التنضيف بكام؟' }), async (brief) => {
    assert.match(brief.business_text, /Scaling and polishing — 700 ج/);
    return { plan: { stage: 'prices' }, reply: say('تنضيف الجير والتلميع بـ 700 ج 😊') };
  });
  assert.deepEqual(t.checked.violations, []);
});

test('a voice note and a lab report: understood before the turn, the report kept on the record', async () => {
  const phone = '201088889999';
  let t = await turn(db, evolutionPayload({ phone, type: 'audio' }), async (brief) => {
    assert.match(brief.latest_text, /\[voice note \(6s\): «عايز احجز كشف اسنان بكره الساعة 6»\]/);
    assert.match(brief.facts_text, /«بكره» = /);
    assert.match(brief.facts_text, /«الساعه 6» = 18:00/);
    return { plan: { stage: 'choosing_time' }, reply: say('تمام! هشوفلك المتاح بكره.') };
  }, { media: { heard: 'عايز احجز كشف اسنان بكره الساعة 6' } });
  assert.equal(t.route, 'agent');
  t = await turn(db, evolutionPayload({ phone, type: 'pdf' }), async (brief) => {
    assert.match(brief.latest_text, /\[file \(lab\): CBC: Hb 10\.2 g\/dL \(low\)/);
    return { plan: { stage: 'question' }, reply: say('وصل التحليل، والدكتور هيشوفه في الكشف 🙏') };
  }, { media: { seen: '[lab] CBC: Hb 10.2 g/dL (low), WBC 7.1, from Al Borg lab, 2026-10-30.' } });
  const doc = await sql(db, `select kind as r, ai_summary from clinic.documents d join clinic.contacts c on c.id = d.contact_id where c.wa_id = $1`, [phone]);
  assert.equal(doc.r, 'lab');
  assert.match(doc.ai_summary, /Hb 10\.2/);
  assert.deepEqual(t.checked.violations, []);
});

test('after booking, the doctor\'s questions before the visit: one at a time, each answer kept on the visit', async () => {
  const phone = '201099990000';
  const day = await sat();
  let t = await turn(db, evolutionPayload({ phone, pushName: 'Reem', text: 'عايزة احجز كشف اسنان يوم السبت بالليل' }), async () => ({
    plan: { stage: 'choosing_time' }, tools: [{ action: 'find_slots', details: { service: 'كشف أسنان', date: day, band: 'evening' } }],
    reply: (steps) => say(`المتاح السبت:\n${optionsText(steps)}\nأنهي ميعاد يناسبك؟`)
  }));
  assert.equal(t.steps[0].result.status, 'OPTIONS', JSON.stringify(t.steps[0].result));
  t = await turn(db, evolutionPayload({ phone, text: 'الأول، ريم خالد 28 سنة' }), async () => ({
    plan: { stage: 'confirming' },
    tools: [{ action: 'update', details: { option: 1, full_name: 'ريم خالد', age: '28', sex: 'female', relation: 'self' } }, { action: 'summary' }],
    reply: (steps) => say(`${steps[1].result.summary_text}\n\nأأكد الحجز؟`)
  }));
  t = await turn(db, evolutionPayload({ phone, text: 'اه اكدي' }), async () => ({
    plan: { stage: 'booked' }, tools: [{ action: 'book' }], reply: say('اتحجزلك يا ريم ✅')
  }));
  const ref = t.steps[0].result.appointment.ref_no;

  // the next message: the questions are in FACTS, the answer is saved under the question
  t = await turn(db, evolutionPayload({ phone, text: 'شكرا' }), async (brief) => {
    assert.ok(brief.facts_text.includes(`PRE-VISIT QUESTIONS for ${ref}`), brief.facts_text);
    assert.match(brief.facts_text, /- last_dental: آخر مرة زرت دكتور أسنان كانت امتى؟/);
    assert.match(brief.facts_text, /- blood_thinners: /);
    assert.match(brief.facts_text, /- pregnancy: /);
    return { plan: { stage: 'pre_visit' }, reply: say('العفو 🌿 عشان الدكتورة تكون عارفة قبل ما تيجي: آخر مرة زرتي دكتور أسنان كانت امتى؟') };
  });
  assert.deepEqual(t.checked.violations, []);
  t = await turn(db, evolutionPayload({ phone, text: 'من سنة تقريبا' }), async (brief) => {
    assert.match(brief.facts_text, /PRE-VISIT QUESTIONS/);
    return { plan: { stage: 'pre_visit' }, tools: [{ action: 'pre_visit', details: { answers: { last_dental: 'من سنة تقريبا' } } }],
             reply: (steps) => say(`تمام 🙏 ${steps[0].result.still_to_ask[0].ask_ar}`) };
  });
  assert.equal(t.steps[0].result.status, 'SAVED', JSON.stringify(t.steps[0].result));
  assert.equal(t.steps[0].result.still_to_ask.length, 2);
  assert.equal((await sql(db, `select pre_visit ->> 'آخر مرة زرت دكتور أسنان كانت امتى؟' as r from clinic.appointments where ref_no = $1`, [ref])).r, 'من سنة تقريبا');
  t = await turn(db, evolutionPayload({ phone, text: 'لا مش باخد حاجة' }), async (brief) => {
    assert.doesNotMatch(brief.facts_text, /- last_dental:/, 'an answered question is not asked again');
    assert.match(brief.facts_text, /- blood_thinners: /);
    return { plan: { stage: 'pre_visit' }, tools: [{ action: 'pre_visit', details: { answers: { blood_thinners: 'لا مش باخد حاجة' } } }],
             reply: say('تمام، شكراً 🌿') };
  });
  assert.equal(t.steps[0].result.still_to_ask.length, 1);
});
