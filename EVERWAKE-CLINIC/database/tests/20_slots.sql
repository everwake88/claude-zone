\i tests/fixtures/helpers.sql
-- sessions, free times in both modes, the doctors' rules, double booking, holds, chairs, follow-up pricing
do $$
declare
  t    uuid := pg_temp.tid();
  d1   uuid := pg_temp.doc('D1');
  d2   uuid := pg_temp.doc('D2');
  sat  date := pg_temp.next_dow(6);
  sun  date := pg_temp.next_dow(0);
  clean uuid := pg_temp.svc('تنضيف جير وتلميع');
  v    jsonb;
  r    jsonb; r2 jsonb;
  p1   bigint; p2 bigint; p3 bigint;
  a    bigint;
  n    int;
begin
  -- the sessions of a day
  assert (select count(*) from clinic.doctor_sessions(t, sat, sat, d1)) = 1, 'one Saturday session';
  assert (select to_char(starts_at at time zone 'Africa/Cairo', 'HH24:MI') from clinic.doctor_sessions(t, sat, sat, d1)) = '17:00';
  assert (select count(*) from clinic.doctor_sessions(t, sat, sat, d2)) = 0, 'no paediatrics on Saturday';

  -- a 40-minute cleaning on the 15-minute grid, new patients not after 21:00 (the agent)
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d1, 'service_id', clean, 'from', sat, 'to', sat, 'limit', 100));
  assert (v -> 'slots' -> 0 ->> 'time') = '17:00', v -> 'slots' -> 0 ->> 'time';
  assert not exists (select 1 from jsonb_array_elements(v -> 'slots') x where (x ->> 'time') > '21:00'), 'rule: no new patients after 21:00';
  -- the staff may book past it, up to the last start that ends by 22:00
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d1, 'service_id', clean, 'from', sat, 'to', sat, 'limit', 100, 'staff', true));
  assert (select max(x ->> 'time') from jsonb_array_elements(v -> 'slots') x) = '21:15', 'last cleaning start';

  -- patients
  insert into clinic.patients (tenant_id, full_name, sex, birth_date) values (t, 'سارة محمود', 'female', '1990-03-01') returning id into p1;
  insert into clinic.patients (tenant_id, full_name, sex, birth_date) values (t, 'مازن علي', 'male', '1985-07-01') returning id into p2;
  insert into clinic.patients (tenant_id, full_name, sex, birth_date) values (t, 'ليلى عمرو', 'female', '2019-01-01') returning id into p3;

  -- booked 18:00–18:40: the doctor is busy until then, the next start is 18:45
  r := clinic.book_appointment(t, jsonb_build_object('doctor_id', d1, 'service_id', clean, 'starts_at', pg_temp.at(sat, '18:00'), 'patient_id', p1, 'staff', true));
  assert (r ->> 'ok')::boolean, r::text;
  assert r -> 'appointment' ->> 'ref_no' like 'NC-%';
  assert (r -> 'appointment' ->> 'price')::numeric = 600;
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d1, 'service_id', clean, 'from', sat, 'to', sat, 'limit', 100));
  assert not exists (select 1 from jsonb_array_elements(v -> 'slots') x where x ->> 'time' in ('17:30', '17:45', '18:00', '18:15', '18:30')), 'busy around 18:00';
  assert exists (select 1 from jsonb_array_elements(v -> 'slots') x where x ->> 'time' = '18:45'), '18:45 free';
  assert exists (select 1 from jsonb_array_elements(v -> 'slots') x where x ->> 'time' = '17:15'), '17:15 free (ends 17:55)';

  -- the same time again is refused (the check, then the constraint)
  r := clinic.book_appointment(t, jsonb_build_object('doctor_id', d1, 'service_id', clean, 'starts_at', pg_temp.at(sat, '18:15'), 'patient_id', p2, 'staff', true));
  assert r ->> 'error' = 'SLOT_NOT_AVAILABLE', r::text;
  begin
    insert into clinic.appointments (tenant_id, doctor_id, location_id, session_date, starts_at, ends_at, status)
    values (t, d1, pg_temp.loc('maadi'), sat, pg_temp.at(sat, '18:10'), pg_temp.at(sat, '18:30'), 'booked');
    assert false, 'the exclusion constraint should refuse an overlap';
  exception when exclusion_violation then null;
  end;
  -- forced in by the staff outside the grid, when the doctor is free
  r := clinic.book_appointment(t, jsonb_build_object('doctor_id', d1, 'location_id', pg_temp.loc('maadi'), 'service_id', pg_temp.svc('أشعة صغيرة على سنة'),
                                 'starts_at', pg_temp.at(sat, '18:41'), 'patient_id', p2, 'staff', true, 'force', true));
  assert (r ->> 'ok')::boolean, r::text;
  perform clinic.cancel_appointment((r -> 'appointment' ->> 'id')::bigint, 'clinic', 'test');

  -- a hold keeps the time; once it lapses the time is free again
  r := clinic.book_appointment(t, jsonb_build_object('doctor_id', d1, 'service_id', clean, 'starts_at', pg_temp.at(sat, '19:00'), 'status', 'held',
                                 'source', 'whatsapp'));
  assert (r ->> 'ok')::boolean and r -> 'appointment' ->> 'ref_no' is null, 'a hold has no number';
  a := (r -> 'appointment' ->> 'id')::bigint;
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d1, 'service_id', clean, 'from', sat, 'to', sat, 'limit', 100));
  assert not exists (select 1 from jsonb_array_elements(v -> 'slots') x where x ->> 'time' = '19:00'), 'held';
  update clinic.appointments set hold_expires_at = now() - interval '1 minute' where id = a;
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d1, 'service_id', clean, 'from', sat, 'to', sat, 'limit', 100));
  assert exists (select 1 from jsonb_array_elements(v -> 'slots') x where x ->> 'time' = '19:00'), 'lapsed hold frees the time';
  perform clinic.housekeeping();
  assert (select status from clinic.appointments where id = a) = 'cancelled', 'housekeeping clears it';

  -- chairs: Nasr City has one chair, so the dentist's free time there needs it too
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d1, 'location_id', pg_temp.loc('nasr'), 'service_id', clean, 'from', sun, 'to', sun, 'limit', 3));
  assert (v -> 'slots' -> 0 ->> 'resource_id') is not null, 'a chair is chosen';

  -- queue numbers: 1, 2… with an estimated time 15 minutes apart
  r := clinic.book_appointment(t, jsonb_build_object('doctor_id', d2, 'kind', 'queue', 'date', sun, 'patient_id', p3, 'staff', true));
  assert (r ->> 'ok')::boolean and (r -> 'appointment' ->> 'queue_no')::int = 1, r::text;
  r2 := clinic.book_appointment(t, jsonb_build_object('doctor_id', d2, 'kind', 'queue', 'date', sun, 'patient_id', p1, 'staff', true));
  assert (r2 -> 'appointment' ->> 'queue_no')::int = 2;
  assert (r2 -> 'appointment' ->> 'time') = '18:15', r2 -> 'appointment' ->> 'time';
  -- a full session is not offered
  update clinic.schedules set capacity = 2 where doctor_id = d2;
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d2, 'from', sun, 'to', sun));
  assert jsonb_array_length(v -> 'slots') = 0 and v -> 'none_because' ? 'SESSION_FULL', v::text;
  update clinic.schedules set capacity = 20 where doctor_id = d2;

  -- a day off
  insert into clinic.schedule_exceptions (tenant_id, doctor_id, on_date, kind, reason) values (t, d1, sat, 'off', 'مؤتمر');
  assert (select count(*) from clinic.doctor_sessions(t, sat, sat, d1)) = 0, 'day off';
  delete from clinic.schedule_exceptions where doctor_id = d1 and on_date = sat;
  -- part of the day off: 19:00–20:00 → two pieces
  insert into clinic.schedule_exceptions (tenant_id, doctor_id, on_date, kind, start_time, end_time) values (t, d1, sat, 'off', '19:00', '20:00');
  assert (select count(*) from clinic.doctor_sessions(t, sat, sat, d1)) = 2, 'split around the break';
  delete from clinic.schedule_exceptions where doctor_id = d1 and on_date = sat;
  -- an extra session
  insert into clinic.schedule_exceptions (tenant_id, doctor_id, location_id, on_date, kind, start_time, end_time)
  values (t, d2, pg_temp.loc('nasr'), sat, 'extra', '10:00', '13:00');
  assert (select mode from clinic.doctor_sessions(t, sat, sat, d2)) = 'queue', 'extra session takes the doctor''s mode';
  delete from clinic.schedule_exceptions where doctor_id = d2 and on_date = sat;

  -- ages: fluoride is for children
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d1, 'service_id', pg_temp.svc('فلورايد للأطفال'), 'patient_id', p2, 'from', sat));
  assert v -> 'none_because' ? 'AGE_NOT_SERVED', v::text;
  -- the agent books nobody past days_ahead
  v := clinic.available_slots(t, jsonb_build_object('doctor_id', d1, 'from', clinic.local_today(t) + 200));
  assert v -> 'none_because' ? 'TOO_FAR_AHEAD', v::text;

  -- a check-up within the doctor's follow-up window is priced as the follow-up
  insert into clinic.appointments (tenant_id, doctor_id, location_id, service_id, patient_id, status, session_date, starts_at, ends_at, ref_no)
  values (t, d1, pg_temp.loc('maadi'), pg_temp.svc('كشف أسنان'), p2, 'done', clinic.local_today(t) - 5,
          now() - interval '5 days', now() - interval '5 days' + interval '20 minutes', 'NC-T1');
  v := clinic.booking_price(pg_temp.svc('كشف أسنان'), d1, pg_temp.loc('maadi'), p2);
  assert (v ->> 'is_follow_up')::boolean and (v ->> 'price')::numeric = 150, v::text;
  v := clinic.booking_price(pg_temp.svc('كشف أسنان'), d1, pg_temp.loc('maadi'), p1);
  assert not (v ->> 'is_follow_up')::boolean and (v ->> 'price')::numeric = 300, v::text;
end $$;
