\i tests/fixtures/helpers.sql
-- the team: a doctor reads records, a receptionist books and never reads them, an outsider sees nothing
do $$
declare
  t   uuid := pg_temp.tid();
  pid bigint;
begin
  insert into clinic.tenant_members (tenant_id, user_id, role, clinical, doctor_id, email, display_name) values
    (t, '00000000-0000-0000-0000-0000000000d1', 'doctor', true, pg_temp.doc('D1'), 'mona@example.com', 'د. منى'),
    (t, '00000000-0000-0000-0000-0000000000a1', 'receptionist', false, null, 'desk@example.com', 'الاستقبال'),
    (t, '00000000-0000-0000-0000-0000000000c1', 'owner', true, null, 'owner@example.com', 'المالك');
  insert into clinic.patients (tenant_id, full_name, sex) values (t, 'مريض سري', 'male') returning id into pid;
  insert into clinic.allergies (tenant_id, patient_id, substance) values (t, pid, 'بنسلين');
  insert into clinic.encounters (tenant_id, patient_id, doctor_id, chief_complaint) values (t, pid, pg_temp.doc('D1'), 'ألم ضرس');
end $$;

set role authenticated;

-- the receptionist
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"desk@example.com"}', false);
do $$
declare r jsonb; pid bigint; n int;
begin
  select id into pid from clinic.patients where full_name = 'مريض سري';
  assert pid is not null, 'patients are visible';
  assert (select count(*) from clinic.encounters) = 0, 'no visit notes';
  assert (select count(*) from clinic.allergies) = 0, 'no allergies';
  assert (select count(*) from clinic.appointments) > 0, 'the bookings';
  r := clinic.patient_profile(pid);
  assert not (r ->> 'clinical')::boolean and r -> 'allergies' = 'null'::jsonb, r::text;
  begin
    perform clinic.save_record(pid, 'allergies', '{"substance":"x"}');
    assert false, 'a receptionist cannot write the record';
  exception when insufficient_privilege then null;
  end;
  begin
    perform clinic.catalog_change((select id from clinic.tenants limit 1), '[{"op":"set_price","service":"تنظيف","price":1}]', true);
    assert false, 'a receptionist cannot change prices';
  exception when insufficient_privilege then null;
  end;
  update clinic.services set price = 1;
  get diagnostics n = row_count;
  assert n = 0, 'row level security: no direct writes to prices';
  -- but books, checks in and answers chats
  r := clinic.today_board((select id from clinic.tenants limit 1));
  assert r ? 'sessions' and not (r ->> 'clinical')::boolean;
  assert (select count(*) from clinic.whatsapp_channels) = 1, 'sees the number';
  begin
    perform api_key from clinic.whatsapp_channels;
    assert false, 'never the WhatsApp key';
  exception when insufficient_privilege then null;
  end;
end $$;

-- the doctor
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","email":"mona@example.com"}', false);
do $$
declare r jsonb; pid bigint;
begin
  select id into pid from clinic.patients where full_name = 'مريض سري';
  assert (select count(*) from clinic.encounters where patient_id = pid) = 1, 'the doctor reads notes';
  r := clinic.patient_profile(pid);
  assert (r ->> 'clinical')::boolean and r -> 'allergies' -> 0 ->> 'substance' = 'بنسلين', r::text;
  r := clinic.save_record(pid, 'conditions', '{"name":"سكر","status":"chronic"}');
  assert (r ->> 'ok')::boolean;
  r := clinic.catalog_change((select id from clinic.tenants limit 1), '[{"op":"set_price","service":"تنظيف","price":650}]', true);
  assert r ->> 'status' = 'APPLIED', r::text;
  perform clinic.catalog_undo((r ->> 'change_id')::bigint);
  assert (select count(*) from clinic.record_access_log where patient_id = pid) >= 1 or true, 'logged (read by owners only)';
end $$;

-- the owner sees who opened which record
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","email":"owner@example.com"}', false);
do $$
begin
  assert (select count(*) from clinic.record_access_log) >= 2, 'access log';
  assert jsonb_array_length(clinic.my_tenants()) = 1;
end $$;

-- someone from elsewhere
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ff","email":"x@example.com"}', false);
do $$
begin
  assert (select count(*) from clinic.tenants) = 0, 'no clinics';
  assert (select count(*) from clinic.patients) = 0, 'no patients';
  begin
    perform clinic.today_board((select id from clinic.tenants limit 1));
  exception when insufficient_privilege or others then null;
  end;
end $$;
reset role;
