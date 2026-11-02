-- =====================================================================
-- Everwake Clinic · 012 · the doctor's AI (stage 2)
--
--   recordings          "listen to the visit": consent first, then the
--                       audio in 20-second chunks, the live transcript,
--                       and the diarised one (doctor · patient)
--   scribe_runs         what the AI filled in, with a quote from the
--                       transcript behind every field, and what the check
--                       found unsupported (left empty and flagged)
--   assistant_threads   the doctor's chats with their assistant
--   assistant_messages
--   assistant_actions   every change the assistant proposed, shown as a
--                       card to confirm, and what happened to it
--
-- Signing a visit writes the encounter and, only for what the doctor
-- ticked, the record (allergies, medicines, conditions), the teeth and the
-- treatment plan. Audio is deleted after settings.scribe.audio_days
-- (default 30); the transcript stays with the visit.
-- =====================================================================

set local client_min_messages = warning;

create table if not exists clinic.recordings (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references clinic.tenants(id) on delete cascade,
  patient_id         bigint references clinic.patients(id) on delete cascade,
  appointment_id     bigint references clinic.appointments(id) on delete set null,
  encounter_id       bigint references clinic.encounters(id) on delete set null,
  doctor_id          uuid references clinic.doctors(id) on delete set null,
  consent_at         timestamptz not null,
  consent_by         uuid,
  consent_text       text not null,
  status             text not null default 'recording'
                     check (status in ('recording', 'processing', 'review', 'signed', 'failed', 'discarded')),
  chunks             jsonb not null default '[]'::jsonb,      -- [{seq, path, ms, text}]
  duration_ms        int not null default 0,
  transcript         jsonb not null default '{"segments": []}'::jsonb,  -- {segments:[{id, speaker, start, end, text}]}
  diarized           boolean not null default false,
  language           text,
  audio_delete_after timestamptz,
  audio_deleted_at   timestamptz,
  error              text,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists recordings_appt_idx on clinic.recordings (appointment_id);
create index if not exists recordings_purge_idx on clinic.recordings (audio_delete_after) where audio_deleted_at is null;

create table if not exists clinic.scribe_runs (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  recording_id bigint not null references clinic.recordings(id) on delete cascade,
  models       jsonb not null default '{}'::jsonb,
  extraction   jsonb not null default '{}'::jsonb,   -- {fields:{"section.field":{value, quote, segment_ids, confidence, speaker}}, record:{...}, teeth:[...], plan:{...}}
  verification jsonb not null default '{}'::jsonb,   -- {supported:[], unsupported:[], flags:[{field, why}]}
  outputs      jsonb not null default '{}'::jsonb,   -- {soap, summary_ar, prescription, letters}
  usage        jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists scribe_runs_rec_idx on clinic.scribe_runs (recording_id, created_at desc);

create table if not exists clinic.assistant_threads (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  user_id    uuid not null,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assistant_threads_user_idx on clinic.assistant_threads (tenant_id, user_id, updated_at desc);

create table if not exists clinic.assistant_messages (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  thread_id  bigint not null references clinic.assistant_threads(id) on delete cascade,
  user_id    uuid not null,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null default '',
  parts      jsonb not null default '[]'::jsonb,     -- chips, tool steps, action card ids
  context    jsonb not null default '{}'::jsonb,     -- the page it was asked on
  created_at timestamptz not null default now()
);
create index if not exists assistant_messages_thread_idx on clinic.assistant_messages (thread_id, id);

create table if not exists clinic.assistant_actions (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  thread_id  bigint references clinic.assistant_threads(id) on delete cascade,
  user_id    uuid not null,
  tool       text not null,
  params     jsonb not null default '{}'::jsonb,
  preview    jsonb not null default '{}'::jsonb,
  summary    text,
  status     text not null default 'proposed' check (status in ('proposed', 'done', 'failed', 'dismissed')),
  result     jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists assistant_actions_user_idx on clinic.assistant_actions (tenant_id, user_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['recordings', 'assistant_threads'] loop
    execute format('drop trigger if exists touch on clinic.%I', t);
    execute format('create trigger touch before update on clinic.%I for each row execute function clinic.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Listening to the visit
-- ---------------------------------------------------------------------
-- p = {consent: true, consent_text?}
create or replace function clinic.recording_start(p_appt bigint, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  a   clinic.appointments%rowtype;
  st  jsonb;
  r   clinic.recordings%rowtype;
begin
  select * into a from clinic.appointments where id = p_appt;
  if not found then raise exception 'appointment not found'; end if;
  perform clinic.require_role(a.tenant_id, array['owner', 'manager', 'doctor', 'nurse']);
  perform clinic.require_clinical(a.tenant_id);
  if not coalesce((p ->> 'consent')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'CONSENT_NEEDED');
  end if;
  select clinic.merged_settings(settings) into st from clinic.tenants where id = a.tenant_id;
  insert into clinic.recordings (tenant_id, patient_id, appointment_id, doctor_id, consent_at, consent_by, consent_text,
                                 audio_delete_after, created_by)
  values (a.tenant_id, a.patient_id, a.id, a.doctor_id, now(), clinic.current_user_id(),
          coalesce(nullif(p ->> 'consent_text', ''), 'The patient agreed to the visit being recorded for the medical record.'),
          now() + make_interval(days => coalesce((st -> 'scribe' ->> 'audio_days')::int, 30)), clinic.current_user_id())
  returning * into r;
  if a.status in ('booked', 'confirmed', 'arrived') then
    perform clinic.set_appointment_status(a.id, 'in_visit', null, false);
  end if;
  return jsonb_build_object('ok', true, 'id', r.id, 'tenant_id', r.tenant_id, 'patient_id', r.patient_id);
end $$;

-- one chunk: where its audio is, how long it is, what it said
create or replace function clinic.recording_chunk(p_rec bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare r clinic.recordings%rowtype; v_seq int := (p ->> 'seq')::int;
begin
  select * into r from clinic.recordings where id = p_rec for update;
  if not found then raise exception 'recording not found'; end if;
  perform clinic.require_clinical(r.tenant_id);
  if r.status not in ('recording', 'processing') then return jsonb_build_object('ok', false, 'error', 'RECORDING_CLOSED'); end if;
  update clinic.recordings
     set chunks = (select coalesce(jsonb_agg(c order by (c ->> 'seq')::int), '[]'::jsonb)
                     from (select c from jsonb_array_elements(chunks) c where (c ->> 'seq')::int <> v_seq
                           union all select jsonb_build_object('seq', v_seq, 'path', p ->> 'path', 'ms', coalesce((p ->> 'ms')::int, 0),
                                                               'text', coalesce(p ->> 'text', ''), 'at', now())) z(c)),
         duration_ms = (select coalesce(sum((c ->> 'ms')::int), 0) from jsonb_array_elements(chunks) c where (c ->> 'seq')::int <> v_seq)
                       + coalesce((p ->> 'ms')::int, 0)
   where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- the whole transcript, once the doctor stops (diarised, or the chunks joined)
create or replace function clinic.recording_transcript(p_rec bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare r clinic.recordings%rowtype;
begin
  select * into r from clinic.recordings where id = p_rec for update;
  if not found then raise exception 'recording not found'; end if;
  perform clinic.require_clinical(r.tenant_id);
  update clinic.recordings
     set transcript = jsonb_build_object('segments', coalesce(p -> 'segments', '[]'::jsonb)),
         diarized = coalesce((p ->> 'diarized')::boolean, false), language = nullif(p ->> 'language', ''),
         status = case when status = 'recording' then 'processing' else status end
   where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- what the AI filled in and what the check found
create or replace function clinic.scribe_save(p_rec bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare r clinic.recordings%rowtype; v_id bigint;
begin
  select * into r from clinic.recordings where id = p_rec for update;
  if not found then raise exception 'recording not found'; end if;
  perform clinic.require_clinical(r.tenant_id);
  insert into clinic.scribe_runs (tenant_id, recording_id, models, extraction, verification, outputs, usage, created_by)
  values (r.tenant_id, r.id, coalesce(p -> 'models', '{}'::jsonb), coalesce(p -> 'extraction', '{}'::jsonb),
          coalesce(p -> 'verification', '{}'::jsonb), coalesce(p -> 'outputs', '{}'::jsonb), p -> 'usage', clinic.current_user_id())
  returning id into v_id;
  update clinic.recordings set status = case when status in ('recording', 'processing', 'failed') then 'review' else status end, error = null where id = r.id;
  return jsonb_build_object('ok', true, 'run_id', v_id);
end $$;

create or replace function clinic.recording_failed(p_rec bigint, p_error text)
returns void language plpgsql security definer set search_path = clinic, pg_temp as $$
declare r clinic.recordings%rowtype;
begin
  select * into r from clinic.recordings where id = p_rec;
  perform clinic.require_clinical(r.tenant_id);
  update clinic.recordings set status = 'failed', error = left(p_error, 500) where id = p_rec and status <> 'signed';
end $$;

-- everything the visit workspace needs for one appointment
create or replace function clinic.visit_context(p_appt bigint)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare a clinic.appointments%rowtype; v_tpl jsonb; v_spec text;
begin
  select * into a from clinic.appointments where id = p_appt;
  if not found then raise exception 'appointment not found'; end if;
  perform clinic.require_role(a.tenant_id, array['owner', 'manager', 'doctor', 'nurse']);
  perform clinic.require_clinical(a.tenant_id);
  select specialty into v_spec from clinic.doctors where id = a.doctor_id;
  select jsonb_build_object('id', f.id, 'name', f.name, 'specialty', f.specialty, 'schema', f.schema) into v_tpl
    from clinic.form_templates f where f.tenant_id = a.tenant_id
   order by (f.specialty = v_spec) desc, f.created_at limit 1;
  return jsonb_build_object(
    'appointment', clinic.appt_card(a, true),
    'doctor', jsonb_build_object('id', a.doctor_id, 'name', clinic.doctor_label(a.doctor_id, 'ar'), 'name_en', clinic.doctor_label(a.doctor_id, 'en'), 'specialty', v_spec),
    'template', v_tpl,
    'patient', (select to_jsonb(p) - 'tenant_id' || jsonb_build_object('age', clinic.age_text(p.birth_date, 'ar'), 'age_en', clinic.age_text(p.birth_date, 'en'))
                  from clinic.patients p where p.id = a.patient_id),
    'record', jsonb_build_object(
      'allergies', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'substance', x.substance, 'reaction', x.reaction)) from clinic.allergies x where x.patient_id = a.patient_id and x.status = 'active'), '[]'::jsonb),
      'medications', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'dose', x.dose)) from clinic.medications x where x.patient_id = a.patient_id and x.status = 'active'), '[]'::jsonb),
      'conditions', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name)) from clinic.conditions x where x.patient_id = a.patient_id and x.status <> 'resolved'), '[]'::jsonb),
      'teeth', coalesce((select jsonb_agg(to_jsonb(x) order by x.tooth) from clinic.dental_chart x where x.patient_id = a.patient_id), '[]'::jsonb)),
    'recording', (select to_jsonb(r) - 'tenant_id' from clinic.recordings r where r.appointment_id = a.id and r.status <> 'discarded' order by r.id desc limit 1),
    'run', (select to_jsonb(s) - 'tenant_id' from clinic.scribe_runs s join clinic.recordings r on r.id = s.recording_id
             where r.appointment_id = a.id and r.status <> 'discarded' order by s.id desc limit 1),
    'encounter', (select to_jsonb(e) from clinic.encounters e where e.appointment_id = a.id order by e.id desc limit 1),
    'terms', clinic.doctor_terms(a.tenant_id, a.doctor_id));
end $$;

-- the words this doctor says often (medicines, diagnoses), so the transcription spells them right
create or replace function clinic.doctor_terms(p_tenant uuid, p_doctor uuid)
returns jsonb language sql stable security definer set search_path = clinic, pg_temp as $$
  select coalesce(jsonb_agg(w), '[]'::jsonb) from (
    select w from (
      select m.name as w, count(*) n from clinic.medications m where m.tenant_id = p_tenant group by m.name
      union all
      select d ->> 'name', count(*) from clinic.encounters e, jsonb_array_elements(e.diagnoses) d
       where e.tenant_id = p_tenant and (p_doctor is null or e.doctor_id = p_doctor) group by d ->> 'name'
      union all
      select s.name_ar, 1 from clinic.services s where s.tenant_id = p_tenant and s.is_active
    ) z where w is not null group by w order by sum(n) desc limit 60) q
$$;

-- Signing. p = {template_id, chief_complaint, data, sources, assessment, plan, diagnoses, follow_up_date,
--              add:{allergies:[{substance, reaction}], medications:[{name, dose, frequency}], conditions:[{name}]},
--              teeth:[{tooth, condition, planned, surfaces}], treatment:{title, items:[{tooth, service_id, label, price, sessions}]}}
create or replace function clinic.scribe_sign(p_rec bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  r      clinic.recordings%rowtype;
  v_enc  jsonb;
  x      jsonb;
  n      int := 0;
  v_plan jsonb;
begin
  select * into r from clinic.recordings where id = p_rec for update;
  if not found then raise exception 'recording not found'; end if;
  perform clinic.require_role(r.tenant_id, array['owner', 'manager', 'doctor', 'nurse']);
  perform clinic.require_clinical(r.tenant_id);
  if r.status = 'signed' then return jsonb_build_object('ok', false, 'error', 'ALREADY_SIGNED', 'encounter_id', r.encounter_id); end if;

  v_enc := clinic.save_encounter(r.patient_id, jsonb_strip_nulls(jsonb_build_object(
             'id', (select id from clinic.encounters where appointment_id = r.appointment_id and status = 'draft' order by id desc limit 1),
             'appointment_id', r.appointment_id, 'doctor_id', r.doctor_id, 'template_id', p ->> 'template_id',
             'chief_complaint', p ->> 'chief_complaint', 'data', coalesce(p -> 'data', '{}'::jsonb),
             'sources', coalesce(p -> 'sources', '{}'::jsonb) || jsonb_build_object('recording_id', r.id),
             'assessment', p ->> 'assessment', 'plan', p ->> 'plan', 'diagnoses', p -> 'diagnoses',
             'follow_up_date', p ->> 'follow_up_date', 'sign', true)));

  for x in select * from jsonb_array_elements(coalesce(p -> 'add' -> 'allergies', '[]'::jsonb)) loop
    perform clinic.save_record(r.patient_id, 'allergies', jsonb_build_object('substance', x ->> 'substance', 'reaction', x ->> 'reaction',
              'source', 'scribe', 'encounter_id', (v_enc -> 'encounter' ->> 'id')::bigint)); n := n + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p -> 'add' -> 'medications', '[]'::jsonb)) loop
    perform clinic.save_record(r.patient_id, 'medications', jsonb_build_object('name', x ->> 'name', 'dose', x ->> 'dose', 'frequency', x ->> 'frequency',
              'duration', x ->> 'duration', 'prescribed_here', coalesce((x ->> 'prescribed_here')::boolean, false), 'source', 'scribe',
              'encounter_id', (v_enc -> 'encounter' ->> 'id')::bigint)); n := n + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p -> 'add' -> 'conditions', '[]'::jsonb)) loop
    perform clinic.save_record(r.patient_id, 'conditions', jsonb_build_object('name', x ->> 'name', 'source', 'scribe',
              'encounter_id', (v_enc -> 'encounter' ->> 'id')::bigint)); n := n + 1;
  end loop;
  if jsonb_typeof(p -> 'teeth') = 'array' and jsonb_array_length(p -> 'teeth') > 0 then
    perform clinic.set_teeth(r.patient_id, p -> 'teeth');
  end if;
  if jsonb_typeof(p -> 'treatment') = 'object' and jsonb_array_length(coalesce(p -> 'treatment' -> 'items', '[]'::jsonb)) > 0 then
    v_plan := clinic.save_plan(r.patient_id, (p -> 'treatment') || jsonb_build_object('doctor_id', r.doctor_id));
  end if;

  update clinic.recordings set status = 'signed', encounter_id = (v_enc -> 'encounter' ->> 'id')::bigint where id = r.id;
  return jsonb_build_object('ok', true, 'encounter_id', (v_enc -> 'encounter' ->> 'id')::bigint, 'records_added', n, 'plan_id', v_plan ->> 'id');
end $$;

-- after the visit: the patient's summary on WhatsApp, in the doctor's (edited) words
create or replace function clinic.visit_summary_send(p_appt bigint, p_text text)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare a clinic.appointments%rowtype; v_wa text;
begin
  select * into a from clinic.appointments where id = p_appt;
  if not found then raise exception 'appointment not found'; end if;
  perform clinic.require_role(a.tenant_id, array['owner', 'manager', 'doctor', 'nurse']);
  if coalesce(btrim(p_text), '') = '' then return jsonb_build_object('ok', false, 'error', 'EMPTY'); end if;
  v_wa := coalesce(a.wa_id, (select c.wa_id from clinic.patient_contacts pc join clinic.contacts c on c.id = pc.contact_id
                              where pc.patient_id = a.patient_id order by (pc.relation = 'self') desc limit 1));
  if v_wa is null then return jsonb_build_object('ok', false, 'error', 'NO_WHATSAPP'); end if;
  perform clinic.queue_message(a.tenant_id, v_wa, 'visit_summary', btrim(p_text), p_sender => 'staff', p_user => clinic.current_user_id(),
                               p_template => 'visit_summary', p_meta => jsonb_build_object('appointment_id', a.id));
  perform clinic.log_appt(a.id, 'summary_sent', '{}'::jsonb);
  return jsonb_build_object('ok', true, 'sent_to', v_wa);
end $$;

-- audio past its days: the dashboard's server deletes the files, then marks them
create or replace function clinic.recordings_to_purge(p_limit int default 200)
returns jsonb language sql stable security definer set search_path = clinic, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'paths', (select jsonb_agg(c ->> 'path') from jsonb_array_elements(r.chunks) c where c ->> 'path' is not null))), '[]'::jsonb)
    from (select * from clinic.recordings where audio_deleted_at is null and audio_delete_after < now() order by audio_delete_after limit p_limit) r
$$;
create or replace function clinic.recordings_purged(p_ids bigint[])
returns int language sql security definer set search_path = clinic, pg_temp as $$
  with u as (update clinic.recordings set audio_deleted_at = now(), chunks = (select coalesce(jsonb_agg(c - 'path'), '[]'::jsonb) from jsonb_array_elements(chunks) c)
              where id = any(p_ids) and audio_deleted_at is null returning 1)
  select count(*)::int from u
$$;

-- ---------------------------------------------------------------------
-- The assistant
-- ---------------------------------------------------------------------
-- the clinic's numbers for a period, for "how was this week?"
create or replace function clinic.assistant_stats(p_tenant uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  if p_to < p_from or p_to - p_from > 370 then raise exception 'pick up to a year'; end if;
  return (select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'bookings', count(*) filter (where a.status <> 'held'),
    'done', count(*) filter (where a.status = 'done'),
    'no_show', count(*) filter (where a.status = 'no_show'),
    'cancelled', count(*) filter (where a.status = 'cancelled'),
    'new_patients', count(*) filter (where a.is_new_patient and a.status not in ('cancelled', 'held')),
    'by_source', (select jsonb_object_agg(s, n) from (select x.source s, count(*) n from clinic.appointments x
                    where x.tenant_id = p_tenant and x.session_date between p_from and p_to and x.status not in ('held', 'cancelled') group by x.source) z),
    'by_doctor', (select jsonb_object_agg(clinic.doctor_label(d, 'ar'), n) from (select x.doctor_id d, count(*) n from clinic.appointments x
                    where x.tenant_id = p_tenant and x.session_date between p_from and p_to and x.status = 'done' group by x.doctor_id) z),
    'collected', coalesce(sum(a.price) filter (where a.status = 'done'), 0),
    'delays', (select count(*) from clinic.delay_notices dn where dn.tenant_id = p_tenant and dn.session_date between p_from and p_to and dn.kind = 'delay'))
    from clinic.appointments a where a.tenant_id = p_tenant and a.session_date between p_from and p_to);
end $$;

-- ---------------------------------------------------------------------
-- Pre-visit questions: the speciality's few, minus what is already known
-- ---------------------------------------------------------------------
create or replace function clinic.pre_visit_pending(p_appt bigint)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare a clinic.appointments%rowtype; v_spec text; v_sex text; v_out jsonb := '[]'::jsonb; q jsonb;
begin
  select * into a from clinic.appointments where id = p_appt;
  if not found then return '[]'::jsonb; end if;
  select specialty into v_spec from clinic.doctors where id = a.doctor_id;
  select sex into v_sex from clinic.patients where id = a.patient_id;
  for q in select * from jsonb_array_elements(coalesce((select pre_visit from clinic.specialty_presets where code = v_spec),
                                                       (select pre_visit from clinic.specialty_presets where code = 'general'), '[]'::jsonb)) loop
    continue when a.pre_visit ? (q ->> 'ask_ar');
    continue when q ->> 'sex' = 'female' and v_sex is distinct from 'female';
    continue when q ->> 'on_file' = 'allergies' and exists (select 1 from clinic.allergies x where x.patient_id = a.patient_id);
    continue when q ->> 'on_file' = 'medications' and exists (select 1 from clinic.medications x where x.patient_id = a.patient_id);
    continue when q ->> 'on_file' = 'conditions' and exists (select 1 from clinic.conditions x where x.patient_id = a.patient_id);
    v_out := v_out || jsonb_build_object('key', q ->> 'key', 'ask_ar', q ->> 'ask_ar', 'ask_en', q ->> 'ask_en');
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
alter table clinic.recordings enable row level security;
alter table clinic.scribe_runs enable row level security;
alter table clinic.assistant_threads enable row level security;
alter table clinic.assistant_messages enable row level security;
alter table clinic.assistant_actions enable row level security;

drop policy if exists clinical_read on clinic.recordings;
create policy clinical_read on clinic.recordings for select to authenticated
  using (tenant_id = any ((select clinic.my_clinical_tenant_ids())::uuid[]));
drop policy if exists clinical_read on clinic.scribe_runs;
create policy clinical_read on clinic.scribe_runs for select to authenticated
  using (tenant_id = any ((select clinic.my_clinical_tenant_ids())::uuid[]));
do $$ declare t text; begin
  foreach t in array array['assistant_threads', 'assistant_messages', 'assistant_actions'] loop
    execute format('drop policy if exists own_rows on clinic.%I', t);
    execute format('create policy own_rows on clinic.%I for all to authenticated
                      using (user_id = clinic.current_user_id() and tenant_id = any ((select clinic.my_tenant_ids())::uuid[]))
                      with check (user_id = clinic.current_user_id() and tenant_id = any ((select clinic.my_tenant_ids())::uuid[]))', t);
  end loop;
end $$;

grant select on clinic.recordings, clinic.scribe_runs to authenticated;
grant select, insert, update on clinic.assistant_threads, clinic.assistant_messages, clinic.assistant_actions to authenticated;
grant all on clinic.recordings, clinic.scribe_runs, clinic.assistant_threads, clinic.assistant_messages, clinic.assistant_actions to service_role;
grant execute on function
  clinic.recording_start(bigint, jsonb), clinic.recording_chunk(bigint, jsonb), clinic.recording_transcript(bigint, jsonb),
  clinic.scribe_save(bigint, jsonb), clinic.recording_failed(bigint, text), clinic.visit_context(bigint), clinic.doctor_terms(uuid, uuid),
  clinic.scribe_sign(bigint, jsonb), clinic.visit_summary_send(bigint, text), clinic.assistant_stats(uuid, date, date),
  clinic.pre_visit_pending(bigint)
  to authenticated;
revoke all on function clinic.recordings_to_purge(int), clinic.recordings_purged(bigint[]) from public;
grant execute on function clinic.recordings_to_purge(int), clinic.recordings_purged(bigint[]) to service_role;
