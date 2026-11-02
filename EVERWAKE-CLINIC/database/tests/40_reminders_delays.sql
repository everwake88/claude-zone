\i tests/fixtures/helpers.sql
-- reminders and "at risk"; the doctor is late (preview → send → follow-up → no reply / accepted);
-- a cancelled session with new times offered; the doctor's WhatsApp commands
do $$
declare
  t    uuid := pg_temp.tid();
  d1   uuid := pg_temp.doc('D1');
  sat  date := pg_temp.next_dow(6);
  mon  date := pg_temp.next_dow(1, 3);
  clean uuid := pg_temp.svc('تنضيف جير وتلميع');
  chk  uuid := pg_temp.svc('كشف أسنان');
  r    jsonb; r2 jsonb;
  v    jsonb;
  a1 bigint; a2 bigint; a3 bigint;
  wa1 text := '201055550001'; wa2 text := '201055550002'; wa3 text := '201055550003';
  staff jsonb := jsonb_build_object('kind', 'doctor', 'role', 'doctor', 'doctor_id', pg_temp.doc('D1'), 'clinical', true, 'name', 'د. منى عادل');
  n    int;
  nb   timestamptz[];
begin
  -- three patients booked by the front desk for Saturday 19:00, 19:30, 20:00 (18:00 is taken by 20_slots) (they hear it on WhatsApp)
  r := clinic.staff_book(t, jsonb_build_object('doctor_id', d1, 'service_id', chk, 'starts_at', pg_temp.at(sat, '19:00'),
         'patient', jsonb_build_object('full_name', 'هبة خالد', 'phone', '01055550001', 'age', '28')));
  assert (r ->> 'ok')::boolean and (r ->> 'notified')::boolean, r::text;
  a1 := (r -> 'appointment' ->> 'id')::bigint;
  assert exists (select 1 from clinic.outbox where tenant_id = t and wa_id = wa1 and purpose = 'booking_confirmed'), 'told on WhatsApp';
  r := clinic.staff_book(t, jsonb_build_object('doctor_id', d1, 'service_id', chk, 'starts_at', pg_temp.at(sat, '19:30'),
         'patient', jsonb_build_object('full_name', 'عمر فتحي', 'phone', '01055550002')));
  a2 := (r -> 'appointment' ->> 'id')::bigint;
  r := clinic.staff_book(t, jsonb_build_object('doctor_id', d1, 'service_id', chk, 'starts_at', pg_temp.at(sat, '20:00'),
         'patient', jsonb_build_object('full_name', 'نادية سامي', 'phone', '01055550003')));
  a3 := (r -> 'appointment' ->> 'id')::bigint;

  -- reminders: the evening before at 19:00 and 3 hours before
  assert (select due_at from clinic.appointment_reminders where appointment_id = a1 and key = 'day_before') = pg_temp.at(sat - 1, '19:00');
  assert (select due_at from clinic.appointment_reminders where appointment_id = a1 and key = 'hours_before') = pg_temp.at(sat, '16:00');
  -- due now → sent, and the chat knows which visit a reply is about
  update clinic.appointment_reminders set due_at = now() - interval '1 minute' where appointment_id = a1 and key = 'day_before';
  n := clinic.reminders_due();
  assert n = 1, 'one reminder sent';
  assert exists (select 1 from clinic.outbox where wa_id = wa1 and purpose = 'reminder' and body like '%تذكير بميعاد حضرتك%' and body like '%https://clinic.everwake.tech/a/%'),
    (select body from clinic.outbox where wa_id = wa1 and purpose = 'reminder' limit 1);
  assert (select (state -> 'pending_reminder' ->> 'appointment_id')::bigint from clinic.conversations where tenant_id = t and wa_id = wa1) = a1;
  -- "1" confirms (the agent calls confirm with no ref: the reminder's visit)
  r := pg_temp.tool(wa1, 'confirm');
  assert (select status from clinic.appointments where id = a1) = 'confirmed', r::text;
  -- unconfirmed after the last reminder → at risk
  update clinic.appointment_reminders set status = 'sent', sent_at = now() - interval '2 hours' where appointment_id = a2;
  perform clinic.reminders_due();
  assert exists (select 1 from clinic.alerts where appointment_id = a2 and kind = 'at_risk'), 'at risk';
  assert not exists (select 1 from clinic.alerts where appointment_id = a1 and kind = 'at_risk'), 'confirmed is not at risk';

  -- the doctor is 20 minutes late on Saturday: preview first, nothing moves
  r := clinic.announce_delay(t, jsonb_build_object('doctor_id', d1, 'date', sat, 'minutes', 20, 'preview', true));
  assert r ->> 'status' = 'PREVIEW' and (r ->> 'count')::int = 4, r::text;   -- with 20_slots' patient (no WhatsApp)
  assert (select starts_at from clinic.appointments where id = a1) = pg_temp.at(sat, '19:00'), 'nothing moved on a preview';
  -- then sent
  r := clinic.announce_delay(t, jsonb_build_object('doctor_id', d1, 'date', sat, 'minutes', '20 دقيقة', 'reason', 'عملية طارئة'));
  assert r ->> 'status' = 'SENT' and (r ->> 'messaged')::int = 3, r::text;
  assert (select starts_at from clinic.appointments where id = a1) = pg_temp.at(sat, '19:20'), 'moved 20 minutes';
  assert (select original_starts_at from clinic.appointments where id = a2) = pg_temp.at(sat, '19:30'), 'original kept';
  assert (select delay_minutes from clinic.appointments where id = a3) = 20;
  assert exists (select 1 from clinic.outbox where wa_id = wa1 and purpose = 'delay_notice' and body like '%20 دقيقة%' and body like '%7:20 م%' and body like '%بدل 7 م%'),
    (select body from clinic.outbox where wa_id = wa1 and purpose = 'delay_notice');
  select array_agg(not_before order by not_before) into nb from clinic.outbox where purpose = 'delay_notice' and wa_id in (wa1, wa2, wa3);
  assert nb[3] - nb[1] >= interval '6 seconds', 'spaced 3 seconds apart';
  -- the late minutes are not offered to anyone new
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d1, 'service_id', chk, 'from', sat, 'to', sat, 'limit', 100));
  assert not exists (select 1 from jsonb_array_elements(v -> 'slots') x where x ->> 'time' in ('17:00', '17:15')), 'late minutes blocked';
  assert exists (select 1 from jsonb_array_elements(v -> 'slots') x where x ->> 'time' = '17:20'), 'after the delay is fine: ' || (v -> 'slots' -> 0 ->> 'time');
  -- the reply window: far-off visits wait the most (90 minutes)
  assert (select reply_due_at from clinic.delay_notice_items where appointment_id = a1) between now() + interval '89 minutes' and now() + interval '91 minutes';
  -- a visit 40 minutes away gets at least 10
  assert clinic.reply_wait(t, now() + interval '40 minutes') between now() + interval '9 minutes' and now() + interval '11 minutes';
  -- 2 hours away: 0.4 × 120 = 48 minutes, and not later than 30 minutes before
  assert clinic.reply_wait(t, now() + interval '120 minutes') between now() + interval '47 minutes' and now() + interval '49 minutes';
  -- 70 minutes away: 0.4 × 70 = 28, capped to 30 minutes before the start → 40
  assert clinic.reply_wait(t, now() + interval '70 minutes') between now() + interval '27 minutes' and now() + interval '41 minutes';

  -- patient 1 accepts, patient 2 says nothing, patient 3 changes the time
  r := pg_temp.tool(wa1, 'accept_delay');
  assert (select status from clinic.delay_notice_items where appointment_id = a1) = 'accepted', r::text;
  r := pg_temp.tool(wa3, 'reschedule', '{}'::jsonb);
  r := pg_temp.tool(wa3, 'reschedule', '{"option": 1}'::jsonb);
  assert r ->> 'status' = 'MOVED', r::text;
  assert (select status from clinic.delay_notice_items where appointment_id = a3) = 'changed';
  -- no answer: one follow-up, then "no reply" on the dashboard
  update clinic.delay_notice_items set reply_due_at = now() - interval '1 minute' where appointment_id = a2;
  n := clinic.delay_followups_due();
  assert n = 1 and exists (select 1 from clinic.outbox where wa_id = wa2 and purpose = 'delay_followup'), 'followed up';
  update clinic.delay_notice_items set reply_due_at = now() - interval '1 minute' where appointment_id = a2;
  perform clinic.delay_followups_due();
  assert (select status from clinic.delay_notice_items where appointment_id = a2) = 'no_reply';
  assert exists (select 1 from clinic.alerts where appointment_id = a2 and kind = 'no_reply');
  -- a second notice adds up
  r := clinic.announce_delay(t, jsonb_build_object('doctor_id', d1, 'date', sat, 'minutes', 10));
  assert (select delay_minutes from clinic.appointments where id = a1) = 30, 'adds up';
  assert (select starts_at from clinic.appointments where id = a1) = pg_temp.at(sat, '19:30');
  -- the day board shows the tally
  v := clinic.today_board(t, sat, d1);
  assert jsonb_array_length(v -> 'delays') = 2, v -> 'delays';

  -- the session on Monday cannot happen: both patients offered their two nearest times; "1" books
  r := clinic.staff_book(t, jsonb_build_object('doctor_id', d1, 'service_id', chk, 'starts_at', pg_temp.at(mon, '18:00'),
         'patient', jsonb_build_object('full_name', 'هبة خالد', 'phone', '01055550001'), 'notify', false));
  a1 := (r -> 'appointment' ->> 'id')::bigint;
  r := clinic.cancel_session(t, jsonb_build_object('doctor_id', d1, 'date', mon, 'preview', true));
  assert (r ->> 'count')::int >= 1, r::text;
  r := clinic.cancel_session(t, jsonb_build_object('doctor_id', d1, 'date', mon, 'reason', 'سفر'));
  assert r ->> 'status' = 'CANCELLED' and (r ->> 'messaged')::int >= 1, r::text;
  assert (select status from clinic.appointments where id = a1) = 'cancelled';
  assert (select count(*) from clinic.doctor_sessions(t, mon, mon, d1)) = 0, 'no new bookings that day';
  assert exists (select 1 from clinic.outbox where wa_id = wa1 and purpose = 'session_cancelled' and body like '%1) %'), 'options in the message';
  r := pg_temp.tool(wa1, 'update', '{"option": 1}');
  assert r -> 'held' ->> 'status' = 'held', r::text;
  r := pg_temp.tool(wa1, 'summary');
  r := pg_temp.tool(wa1, 'book');
  assert r ->> 'status' = 'BOOKED', r::text;

  -- the doctor's own WhatsApp: "هتأخر ربع ساعة" → preview → "تمام" → sent
  perform pg_temp.say('201000000101', 'هتأخر ربع ساعة');
  r := clinic.staff_tool(t, '201000000101', staff, 'delay', jsonb_build_object('minutes', 15, 'date', sat)::text);
  assert r ->> 'status' = 'PREVIEW', r::text;
  assert (select state -> 'staff_pending' ->> 'action' from clinic.conversations where tenant_id = t and wa_id = '201000000101') = 'delay';
  r := clinic.staff_tool(t, '201000000101', staff, 'confirm', '{}');
  assert r ->> 'status' = 'SENT', r::text;
  r := clinic.staff_tool(t, '201000000101', staff, 'confirm', '{}');
  assert r ->> 'error' = 'NOTHING_WAITING', 'confirmed once';
  -- prices by WhatsApp: "ارفع التنضيف لـ 700" → preview → yes → the snapshot has it; undo
  r := clinic.staff_tool(t, '201000000101', staff, 'catalog', '{"changes":[{"op":"set_price","service":"تنضيف","price":700}]}');
  assert r ->> 'status' = 'PREVIEW', r::text;
  r := clinic.staff_tool(t, '201000000101', staff, 'confirm', '{}');
  assert r ->> 'status' = 'APPLIED' and (select price from clinic.services where id = clean) = 700, r::text;
  assert (select created_by_name from clinic.catalog_changes order by id desc limit 1) = 'د. منى عادل';
  r := clinic.staff_tool(t, '201000000101', staff, 'undo', '{}');
  assert r ->> 'status' = 'UNDONE' and (select price from clinic.services where id = clean) = 600, r::text;
  -- the front desk may not change prices
  r := clinic.staff_tool(t, '201000000101', staff || '{"role":"receptionist"}', 'catalog', '{"changes":[{"op":"set_price","service":"تنضيف","price":1}]}');
  assert r ->> 'error' = 'NOT_ALLOWED';
  -- today's list
  r := clinic.staff_tool(t, '201000000101', staff, 'today', jsonb_build_object('date', sat)::text);
  assert jsonb_array_length(r -> 'appointments') >= 2, r::text;
end $$;
