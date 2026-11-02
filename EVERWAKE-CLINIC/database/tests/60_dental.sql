\i tests/fixtures/helpers.sql
-- the dental chart, a treatment plan quoted on WhatsApp, accepted, booked session by session, aftercare
do $$
declare
  t   uuid := pg_temp.tid();
  wa  text := '201077770001';
  pid bigint;
  plan bigint;
  r   jsonb;
  aid bigint;
  rct uuid := pg_temp.svc('حشو عصب');
  item bigint;
begin
  perform pg_temp.say(wa, 'عايز أعرف خطة العلاج');
  r := clinic.save_patient(t, '{"full_name":"خالد منصور","phone":"01077770001","age":"41","sex":"male"}');
  pid := (r ->> 'id')::bigint;
  assert exists (select 1 from clinic.patient_contacts pc join clinic.contacts c on c.id = pc.contact_id where pc.patient_id = pid and c.wa_id = wa),
    'linked to the WhatsApp contact';

  -- the chart
  r := clinic.set_teeth(pid, '[{"tooth":36,"condition":"caries","surfaces":["O","D"],"planned":"حشو عصب"},{"tooth":46,"condition":"caries"},{"tooth":18,"condition":"missing"}]');
  assert (select count(*) from clinic.dental_chart where patient_id = pid) = 3;
  begin
    perform clinic.set_teeth(pid, '[{"tooth":19}]');
    assert false, 'tooth 19 does not exist';
  exception when check_violation then null;
  end;

  -- the plan: root canal on 36, filling on 46, 200 off
  r := clinic.save_plan(pid, jsonb_build_object('doctor_id', pg_temp.doc('D1'), 'discount', 200, 'items', jsonb_build_array(
         jsonb_build_object('tooth', 36, 'service_id', rct, 'price', 2000),
         jsonb_build_object('tooth', 46, 'service_id', pg_temp.svc('حشو كومبوزيت (تجميلي)')))));
  plan := (r ->> 'id')::bigint;
  assert (r ->> 'total')::numeric = 2500, r::text;
  assert r ->> 'text' like '%سنة 36 · حشو عصب — 2,000 ج (2 جلسات)%' and r ->> 'text' like '%الإجمالي 2,700، خصم 200 = 2,500 ج%', r ->> 'text';

  -- quoted on WhatsApp; "موافق" accepts and offers the first session
  r := clinic.plan_quote(plan);
  assert (r ->> 'ok')::boolean and (select status from clinic.treatment_plans where id = plan) = 'quoted', r::text;
  assert exists (select 1 from clinic.outbox where wa_id = wa and purpose = 'plan_quote' and body like '%موافق%');
  r := pg_temp.tool(wa, 'accept_plan');
  assert r ->> 'status' = 'OPTIONS' and r -> 'plan_session' ->> 'label' = 'حشو عصب', r::text;
  assert (select status from clinic.treatment_plans where id = plan) = 'accepted';
  r := pg_temp.tool(wa, 'update', '{"option": 1}');
  assert r -> 'held' ->> 'status' = 'held', r::text;
  r := pg_temp.tool(wa, 'summary');
  r := pg_temp.tool(wa, 'book');
  assert r ->> 'status' = 'BOOKED', r::text;
  aid := (r -> 'appointment' ->> 'id')::bigint;
  select plan_item_id into item from clinic.appointments where id = aid;
  assert item is not null and (select status from clinic.treatment_plan_items where id = item) = 'booked', 'linked to the plan';
  assert (select status from clinic.treatment_plans where id = plan) = 'in_progress';

  -- the visit is done: the session counts, aftercare goes out, the next session is offered 7 days on
  r := clinic.set_appointment_status(aid, 'arrived');
  r := clinic.set_appointment_status(aid, 'in_visit');
  r := clinic.set_appointment_status(aid, 'done');
  assert (select done_sessions from clinic.treatment_plan_items where id = item) = 1;
  assert (select status from clinic.treatment_plan_items where id = item) = 'in_progress', '1 of 2';
  assert exists (select 1 from clinic.outbox where wa_id = wa and purpose = 'aftercare' and body like '%الطربوش%'), 'aftercare';
  assert exists (select 1 from clinic.outbox where wa_id = wa and purpose = 'plan_next' and body like '%2 من 2%'), 'next session offered';
  assert (clinic.plan_next(plan) ->> 'earliest')::date >= clinic.local_today(t) + 7, clinic.plan_next(plan)::text;
  assert (select visits_count from clinic.patients where id = pid) = 1;
  -- "1" books the next session straight from that message
  r := pg_temp.tool(wa, 'update', '{"option": 1}');
  assert r -> 'held' ->> 'status' = 'held', r::text;
  assert (r -> 'held' ->> 'date')::date >= clinic.local_today(t) + 7, 'spaced';
end $$;
