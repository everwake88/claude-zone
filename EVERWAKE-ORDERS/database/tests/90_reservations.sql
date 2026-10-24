-- Table bookings: branches that book on WhatsApp or by phone only, the agent's
-- tool checking every value, the summary before sending, the ticket for the
-- branch, the team confirming (the customer hears it), the customer cancelling.

reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare
  t    uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam  uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  base jsonb := jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token');
  wa   text := '201444000001';
  tomorrow text := to_char((now() at time zone 'Africa/Cairo')::date + 1, 'YYYY-MM-DD');
  r jsonb; ctx jsonb; msg text;
begin
  perform everwake.intake(base || jsonb_build_object('external_id', 'rs1', 'wa_id', wa, 'phone', wa, 'push_name', 'Mona', 'text', 'عايزة أحجز ترابيزة'));

  -- nothing is booked on WhatsApp yet
  r := everwake.reservation_tool(t, wa, 'update', '{"guests": 4}');
  assert r ->> 'error' = 'NOT_TAKEN_ON_WHATSAPP', r::text;

  update everwake.branches set reservations = 'whatsapp', reservation_max_guests = 10 where id = zam;
  update everwake.branches set reservations = 'phone', reservation_note_ar = 'الحجز بالتليفون بس'
   where tenant_id = t and code <> 'zamalek';

  -- the phone-only branch: the number, not a booking
  r := everwake.reservation_tool(t, wa, 'update', '{"branch": "المعادي"}');
  assert exists (select 1 from jsonb_array_elements(r -> 'problems') p where p ->> 'problem' = 'BOOKED_BY_PHONE_ONLY'
                  and p ->> 'note' = 'الحجز بالتليفون بس' and p ->> 'phone' is not null), r::text;

  -- a natural first answer: branch, day, time, guests, occasion; the phone is their WhatsApp number already
  r := everwake.reservation_tool(t, wa, 'update', jsonb_build_object('branch', 'الزمالك', 'date', tomorrow, 'time', '21:00',
                                                                     'guests', 4, 'occasion', 'عيد ميلاد')::text);
  assert r ->> 'status' = 'SAVED' and (r -> 'missing') = '["full_name"]'::jsonb, r::text;
  assert r -> 'reservation' ->> 'phone' = '01444000001' and r -> 'reservation' ->> 'time_ar' = '9:00 بالليل', r::text;
  assert not (r ->> 'ready_for_summary')::boolean;
  r := everwake.reservation_tool(t, wa, 'summary', '');
  assert r ->> 'error' = 'NOT_READY';

  r := everwake.reservation_tool(t, wa, 'update', '{"full_name": "منى", "requests": "كرسي أطفال"}');
  assert (r ->> 'ready_for_summary')::boolean, r::text;
  r := everwake.reservation_tool(t, wa, 'submit', '');
  assert r ->> 'error' = 'SUMMARY_NOT_CONFIRMED', 'never sent before the summary: ' || r::text;

  r := everwake.reservation_tool(t, wa, 'summary', '');
  assert r ->> 'status' = 'SUMMARY_READY', r::text;
  msg := r ->> 'summary_text';
  assert msg like 'تفاصيل الحجز:%🏪 الفرع: الزمالك%الساعة 9:00 بالليل%👥 4 أشخاص%🎉 المناسبة: عيد ميلاد%👤 باسم: منى · 📞 01444000001%📝 طلبات خاصة: كرسي أطفال', msg;

  -- a change after the summary: the summary must be shown again
  r := everwake.reservation_tool(t, wa, 'update', '{"guests": 5}');
  assert r -> 'reservation' ->> 'summary' like 'shown before, but something changed%', r::text;
  r := everwake.reservation_tool(t, wa, 'submit', '');
  assert r ->> 'error' = 'SUMMARY_NOT_CONFIRMED';
  r := everwake.reservation_tool(t, wa, 'summary', '');
  r := everwake.reservation_tool(t, wa, 'submit', '');
  assert r ->> 'status' = 'REQUESTED' and r ->> 'ref_no' = 'NG-R1001', r::text;
  assert exists (select 1 from everwake.outbox where purpose = 'order_ticket' and to_jid = '201000000051'
                  and body like '🍽 طلب حجز ترابيزة NG-R1001%👥 5 أشخاص · 🎉 عيد ميلاد%👤 منى · 📞 01444000001%كرسي أطفال%صفحة الحجوزات%'),
         'the branch team gets the ticket';
  assert (select ops_notified from everwake.reservations where ref_no = 'NG-R1001');

  -- the agent sees it next turn
  ctx := everwake.turn_context(t, wa);
  assert (ctx -> 'reservation_setup' ->> 'enabled')::boolean;
  assert ctx -> 'reservation' = 'null'::jsonb or ctx -> 'reservation' is null, 'no booking in progress any more';
  assert ctx -> 'reservations_upcoming' -> 0 ->> 'ref_no' = 'NG-R1001' and ctx -> 'reservations_upcoming' -> 0 ->> 'status' = 'requested';
end $$;

-- every check on the values
do $$
declare
  t   uuid := (select id from everwake.tenants where slug = 'nile_grill');
  wa  text := '201444000002';
  d   date := (now() at time zone 'Africa/Cairo')::date;
  r jsonb;
begin
  perform everwake.intake(jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token', 'external_id', 'rs2', 'wa_id', wa,
                                             'phone', wa, 'push_name', 'Omar', 'text', 'حجز'));
  r := everwake.reservation_tool(t, wa, 'update', jsonb_build_object('branch', 'zamalek', 'date', to_char(d + 1, 'YYYY-MM-DD'), 'time', '05:00')::text);
  assert exists (select 1 from jsonb_array_elements(r -> 'problems') p where p ->> 'problem' = 'BRANCH_CLOSED_AT_THAT_TIME'), r::text;
  r := everwake.reservation_tool(t, wa, 'update', jsonb_build_object('date', to_char(d - 1, 'YYYY-MM-DD'), 'time', '21:00')::text);
  assert exists (select 1 from jsonb_array_elements(r -> 'problems') p where p ->> 'problem' = 'TOO_SOON'), r::text;
  r := everwake.reservation_tool(t, wa, 'update', jsonb_build_object('date', to_char(d + 60, 'YYYY-MM-DD'))::text);
  assert exists (select 1 from jsonb_array_elements(r -> 'problems') p where p ->> 'problem' = 'TOO_FAR_AHEAD'), r::text;
  r := everwake.reservation_tool(t, wa, 'update', jsonb_build_object('date', to_char(d + 2, 'YYYY-MM-DD'), 'guests', 30)::text);
  assert exists (select 1 from jsonb_array_elements(r -> 'problems') p where p ->> 'problem' = 'GROUP_TOO_LARGE' and (p ->> 'max_guests')::int = 10), r::text;
  assert not (r ->> 'ready_for_summary')::boolean;
  r := everwake.reservation_tool(t, wa, 'update', '{"date": "23/10", "time": "9pm", "phone": "abc", "guests": "two"}');
  assert (select count(*) from jsonb_array_elements(r -> 'problems') p
           where p ->> 'problem' in ('DATE_FORMAT', 'TIME_FORMAT', 'PHONE_FORMAT', 'GUESTS_FORMAT')) = 4, r::text;
  r := everwake.reservation_tool(t, wa, 'update', 'not json');
  assert exists (select 1 from jsonb_array_elements(r -> 'problems') p where p ->> 'problem' = 'BAD_DETAILS_JSON');
  r := everwake.reservation_tool(t, wa, 'fly', '');
  assert r ->> 'error' = 'UNKNOWN_ACTION';
  -- they change their mind: the draft is dropped
  r := everwake.reservation_tool(t, wa, 'cancel', '');
  assert r ->> 'status' = 'DRAFT_DISCARDED';
  assert not exists (select 1 from everwake.reservations where wa_id = wa);
end $$;

-- the cashier confirms on the dashboard: the customer hears it
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
declare rid bigint := (select id from everwake.reservations where ref_no = 'NG-R1001'); r jsonb;
begin
  assert (select count(*) from everwake.reservations where ref_no = 'NG-R1001') = 1, 'the team sees bookings';
  begin
    perform everwake.set_reservation_status(rid, 'seated');
    assert false, 'a request is confirmed before anyone is seated';
  exception when raise_exception then null;
  end;
  r := everwake.set_reservation_status(rid, 'confirmed');
  assert (r ->> 'notified')::boolean;
  assert exists (select 1 from everwake.outbox where wa_id = '201444000001' and purpose = 'order_status'
                  and body like 'تم تأكيد حجزك ✅ NG-R1001%🏪 الزمالك%· 👥 5%مستنيينك!'), 'confirmed on WhatsApp';
  r := everwake.set_reservation_status(rid, 'seated');
  assert (select status from everwake.reservations where id = rid) = 'seated';
  begin
    perform everwake.reservation_tool((select tenant_id from everwake.reservations where id = rid), 'x', 'status', '');
    assert false, 'the agent''s tool is not for dashboard users';
  exception when insufficient_privilege then null;
  end;
end $$;

-- a customer sends a booking, then cancels it on WhatsApp: the branch is told
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare
  t  uuid := (select id from everwake.tenants where slug = 'nile_grill');
  wa text := '201444000003';
  r jsonb;
begin
  perform everwake.intake(jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token', 'external_id', 'rs3', 'wa_id', wa,
                                             'phone', wa, 'push_name', 'Ali', 'text', 'حجز'));
  r := everwake.reservation_tool(t, wa, 'update', jsonb_build_object('branch', 'الزمالك', 'date', to_char((now() at time zone 'Africa/Cairo')::date + 3, 'YYYY-MM-DD'),
                                                                     'time', '20:30', 'guests', 2, 'full_name', 'علي')::text);
  perform everwake.reservation_tool(t, wa, 'summary', '');
  r := everwake.reservation_tool(t, wa, 'submit', '');
  assert r ->> 'status' = 'REQUESTED', r::text;
  r := everwake.reservation_tool(t, wa, 'cancel', '');
  assert r ->> 'status' = 'CANCELLED', r::text;
  assert exists (select 1 from everwake.outbox where purpose = 'order_ticket' and body like '❌ العميل لغى الحجز ' || (r -> 'reservation' ->> 'ref_no') || '%');
  -- the daily report counts them
  assert everwake.report_text(t, now() - interval '1 hour', now() + interval '1 minute') like '%🍽 الحجوزات: %', 'bookings in the report';
end $$;
