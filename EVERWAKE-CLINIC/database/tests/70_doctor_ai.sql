\i tests/fixtures/helpers.sql
-- stage 2: listening to the visit (consent first, only the clinical team, signing writes the
-- record only for what was ticked), audio retention, the assistant's rows kept per user, and the
-- pre-visit questions the WhatsApp assistant asks after a booking
do $$
declare
  t   uuid := pg_temp.tid();
  pid bigint;
  aid bigint;
begin
  insert into clinic.tenant_members (tenant_id, user_id, role, clinical, doctor_id, email, display_name) values
    (t, '00000000-0000-0000-0000-0000000007d1', 'doctor', true, pg_temp.doc('D1'), 'scribe-doc@example.com', 'د. منى'),
    (t, '00000000-0000-0000-0000-0000000007a1', 'receptionist', false, null, 'scribe-desk@example.com', 'الاستقبال')
  on conflict do nothing;
  insert into clinic.patients (tenant_id, full_name, sex, birth_date) values (t, 'مريضة التسجيل', 'female', '1990-03-01') returning id into pid;
  insert into clinic.appointments (tenant_id, ref_no, doctor_id, location_id, patient_id, status, mode, session_date, starts_at, ends_at, est_at)
  values (t, 'NC-T70', pg_temp.doc('D1'), pg_temp.loc('maadi'), pid, 'arrived', 'slot', clinic.local_today(t),
          now() - interval '5 minutes', now() + interval '25 minutes', now() - interval '5 minutes')
  returning id into aid;
end $$;

set role authenticated;

-- the receptionist cannot listen to a visit
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007a1","email":"scribe-desk@example.com"}', false);
do $$
declare aid bigint := (select id from clinic.appointments where ref_no = 'NC-T70');
begin
  begin
    perform clinic.recording_start(aid, '{"consent": true}');
    assert false, 'a receptionist cannot record a visit';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from clinic.recordings) = 0, 'and sees no recordings';
end $$;

-- the doctor: consent first, then chunks, the transcript, the extraction, and signing
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007d1","email":"scribe-doc@example.com"}', false);
do $$
declare
  aid bigint := (select id from clinic.appointments where ref_no = 'NC-T70');
  pid bigint := (select patient_id from clinic.appointments where ref_no = 'NC-T70');
  r jsonb; rid bigint; ctx jsonb;
begin
  r := clinic.recording_start(aid, '{}');
  assert r ->> 'error' = 'CONSENT_NEEDED', 'no recording without consent: ' || r::text;
  r := clinic.recording_start(aid, '{"consent": true}');
  assert (r ->> 'ok')::boolean, r::text;
  rid := (r ->> 'id')::bigint;
  assert (select status from clinic.appointments where id = aid) = 'in_visit', 'starting to record calls the patient in';
  assert (select audio_delete_after::date from clinic.recordings where id = rid) = (now() + interval '30 days')::date, 'audio kept 30 days by default';

  perform clinic.recording_chunk(rid, '{"seq": 0, "path": "t/r/0.webm", "ms": 20000, "text": "الضرس اللي تحت شمال بيوجعني"}');
  perform clinic.recording_chunk(rid, '{"seq": 1, "path": "t/r/1.webm", "ms": 12000, "text": "وعندي حساسية من البنسلين"}');
  perform clinic.recording_chunk(rid, '{"seq": 1, "path": "t/r/1.webm", "ms": 15000, "text": "وعندي حساسية من البنسلين"}');
  assert (select jsonb_array_length(chunks) from clinic.recordings where id = rid) = 2, 'a re-sent chunk replaces itself';
  assert (select duration_ms from clinic.recordings where id = rid) = 35000, 'the length adds up';

  perform clinic.recording_transcript(rid, '{"diarized": true, "segments": [{"id":"s1","speaker":"patient","start":0,"end":4,"text":"الضرس اللي تحت شمال بيوجعني"},{"id":"s2","speaker":"patient","start":20,"end":23,"text":"وعندي حساسية من البنسلين"}]}');
  r := clinic.scribe_save(rid, '{"extraction": {"fields": {"complaint.chief_complaint": {"value": "ألم في الضرس السفلي الأيسر", "quote": "الضرس اللي تحت شمال بيوجعني", "segment_ids": ["s1"], "confidence": 0.92}}}, "verification": {"unsupported": []}}');
  assert (r ->> 'ok')::boolean and (select status from clinic.recordings where id = rid) = 'review', r::text;

  ctx := clinic.visit_context(aid);
  assert ctx -> 'recording' ->> 'id' = rid::text and ctx -> 'run' -> 'extraction' -> 'fields' ? 'complaint.chief_complaint', 'the workspace sees the run';
  assert ctx -> 'template' ? 'schema', 'and the speciality form';
  assert ctx -> 'appointment' ? 'pre_visit', 'and what the patient answered before the visit';

  r := clinic.scribe_sign(rid, jsonb_build_object(
         'chief_complaint', 'ألم ضرس', 'data', '{"complaint": {"chief_complaint": "ألم في الضرس السفلي الأيسر"}}'::jsonb,
         'sources', '{"complaint.chief_complaint": {"quote": "الضرس اللي تحت شمال بيوجعني", "segment_ids": ["s1"]}}'::jsonb,
         'follow_up_date', (current_date + 7)::text,
         'add', '{"allergies": [{"substance": "بنسلين", "reaction": "طفح"}]}'::jsonb,
         'teeth', '[{"tooth": 37, "condition": "caries", "planned": "حشو عصب"}]'::jsonb,
         'treatment', '{"title": "خطة", "items": [{"tooth": 37, "label": "حشو عصب", "price": 1800}]}'::jsonb));
  assert (r ->> 'ok')::boolean and (r ->> 'records_added')::int = 1, r::text;
  assert (select status from clinic.encounters where id = (r ->> 'encounter_id')::bigint) = 'signed', 'the visit is signed';
  assert (select sources ? 'recording_id' from clinic.encounters where id = (r ->> 'encounter_id')::bigint), 'with its evidence';
  assert (select count(*) from clinic.allergies where patient_id = pid and substance = 'بنسلين' and source = 'scribe') = 1, 'the ticked allergy is on the record';
  assert (select condition from clinic.dental_chart where patient_id = pid and tooth = 37) = 'caries', 'tooth 37';
  assert (select count(*) from clinic.treatment_plan_items i join clinic.treatment_plans p on p.id = i.plan_id where p.patient_id = pid) = 1, 'and the plan';
  r := clinic.scribe_sign(rid, '{}');
  assert r ->> 'error' = 'ALREADY_SIGNED', 'signed once';
  assert clinic.recording_discard(rid) ->> 'error' = 'ALREADY_SIGNED', 'a signed recording is never set aside';
  assert (select count(*) from clinic.recordings where id = rid) = 1, 'the doctor sees the recording';

  -- the assistant's rows are the user's own
  insert into clinic.assistant_threads (tenant_id, user_id, title) values (pg_temp.tid(), clinic.current_user_id(), 'mine');
  insert into clinic.assistant_actions (tenant_id, user_id, tool, params) values (pg_temp.tid(), clinic.current_user_id(), 'announce_delay', '{"minutes": 20}');
  r := clinic.assistant_stats(pg_temp.tid(), current_date - 30, current_date);
  assert r ? 'bookings' and r ? 'by_source', r::text;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007a1","email":"scribe-desk@example.com"}', false);
do $$
begin
  assert (select count(*) from clinic.assistant_threads) = 0, 'another member never sees my chats with the assistant';
  assert (select count(*) from clinic.assistant_actions) = 0, 'nor my confirm cards';
  begin
    insert into clinic.assistant_threads (tenant_id, user_id, title) values (pg_temp.tid(), '00000000-0000-0000-0000-0000000007d1', 'not mine');
    assert false, 'and cannot write as someone else';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- audio past its days is listed for deletion, then marked
do $$
declare rid bigint := (select id from clinic.recordings order by id desc limit 1); r jsonb;
begin
  update clinic.recordings set audio_delete_after = now() - interval '1 minute' where id = rid;
  r := clinic.recordings_to_purge();
  assert jsonb_array_length(r) = 1 and jsonb_array_length(r -> 0 -> 'paths') = 2, r::text;
  assert clinic.recordings_purged(array[rid]) = 1;
  assert (select audio_deleted_at is not null and not (chunks -> 0 ? 'path') from clinic.recordings where id = rid), 'the paths go, the transcript stays';
  assert jsonb_array_length(clinic.recordings_to_purge()) = 0;
end $$;

-- pre-visit questions after a WhatsApp booking: the speciality's, minus what is on file
do $$
declare
  t uuid := pg_temp.tid(); wa text := '201555000070'; r jsonb; c jsonb; aid bigint; pid bigint; co bigint;
begin
  perform pg_temp.say(wa, 'عايزة أحجز');
  select id into co from clinic.contacts where tenant_id = t and wa_id = wa;
  insert into clinic.patients (tenant_id, full_name, sex) values (t, 'سلمى', 'female') returning id into pid;
  insert into clinic.patient_contacts (tenant_id, patient_id, contact_id, relation) values (t, pid, co, 'self');
  insert into clinic.appointments (tenant_id, ref_no, doctor_id, location_id, patient_id, contact_id, wa_id, status, mode, session_date, starts_at, ends_at, est_at)
  values (t, 'NC-T71', pg_temp.doc('D1'), pg_temp.loc('maadi'), pid, co, wa, 'booked', 'slot', clinic.local_today(t) + 3,
          now() + interval '3 days', now() + interval '3 days 30 minutes', now() + interval '3 days')
  returning id into aid;

  c := clinic.turn_context(t, wa);
  assert jsonb_array_length(c -> 'pre_visit_pending' -> 'questions') = 3, 'a dentist asks three: ' || coalesce((c -> 'pre_visit_pending')::text, 'null');
  insert into clinic.medications (tenant_id, patient_id, name) values (t, pid, 'أسبرين');
  assert jsonb_array_length(clinic.pre_visit_pending(aid)) = 2, 'medicines on file: no blood-thinner question';

  r := pg_temp.tool(wa, 'pre_visit', '{"answers": {"last_dental": "من سنتين", "pregnancy": "لا"}}');
  assert r ->> 'status' = 'SAVED' and jsonb_array_length(r -> 'still_to_ask') = 0, r::text;
  assert (select pre_visit ->> 'آخر مرة زرت دكتور أسنان كانت امتى؟' from clinic.appointments where id = aid) = 'من سنتين', 'kept under the question, for the doctor';
  assert clinic.turn_context(t, wa) -> 'pre_visit_pending' = 'null'::jsonb, 'nothing left to ask';
  r := pg_temp.tool(wa, 'pre_visit', '{"answers": "x"}');
  assert r ->> 'error' = 'ANSWERS_NEEDED', r::text;
end $$;
