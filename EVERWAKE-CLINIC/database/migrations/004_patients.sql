-- =====================================================================
-- Everwake Clinic · 004 · patients and their records
--
--   patients            the people seen (a file number, age, sex…); one
--                       WhatsApp contact can book for several of them
--   patient_contacts    who books for whom (self, child, parent, spouse…)
--
-- The medical record — clinical team only (row level security, 009):
--   conditions, allergies, medications      the running lists
--   patient_history     surgeries, family, social, obstetric, vaccines…
--   vitals              each measurement
--   documents           lab reports, X-rays, prescriptions, photos —
--                       from WhatsApp (read by the model) or uploaded
--   form_templates      a speciality's history form, copied per doctor
--   encounters          one visit's record against a form (draft → signed)
--   dental_chart        one row per tooth (FDI 11–48, children 51–85)
--   treatment_plans     teeth × services × prices, quoted on WhatsApp,
--   treatment_plan_items  then booked session by session (005)
--   record_access_log   who opened which record, when
-- =====================================================================

create table clinic.patients (
  id                   bigint generated always as identity primary key,
  tenant_id            uuid not null references clinic.tenants(id) on delete cascade,
  file_no              text not null,
  full_name            text not null,
  sex                  text check (sex in ('male', 'female')),
  birth_date           date,
  birth_date_estimated boolean not null default false,   -- only the age was given
  phone                text,
  national_id          text,
  blood_group          text check (blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  marital_status       text,
  occupation           text,
  address              text,
  insurance            text,
  tags                 text[] not null default '{}',
  notes                text,                               -- the front desk's note (not medical)
  preferences          jsonb not null default '{}'::jsonb, -- {"band":"evening","doctor_id":…,"location_id":…}
  first_visit_at       timestamptz,
  last_visit_at        timestamptz,
  visits_count         int not null default 0,
  no_show_count        int not null default 0,
  created_via          text not null default 'dashboard' check (created_via in ('dashboard', 'whatsapp', 'import', 'web')),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, file_no)
);
create index patients_tenant_idx on clinic.patients (tenant_id, last_visit_at desc nulls last);
create index patients_name_idx on clinic.patients (tenant_id, (clinic.norm(full_name)));
create index patients_phone_idx on clinic.patients (tenant_id, phone) where phone is not null;

create table clinic.patient_contacts (
  patient_id bigint not null references clinic.patients(id) on delete cascade,
  contact_id bigint not null references clinic.contacts(id) on delete cascade,
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  relation   text not null default 'self' check (relation in ('self', 'child', 'parent', 'spouse', 'sibling', 'relative', 'other')),
  created_at timestamptz not null default now(),
  primary key (patient_id, contact_id)
);
create index patient_contacts_contact_idx on clinic.patient_contacts (contact_id);

-- ---------------------------------------------------------------------
-- The medical record
-- ---------------------------------------------------------------------
create table clinic.form_templates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  doctor_id  uuid references clinic.doctors(id) on delete cascade,
  specialty  text not null,
  name       text not null,
  version    int not null default 1,
  schema     jsonb not null,         -- {sections:[{key,title_ar,title_en,fields:[{key,label_ar,label_en,type,unit,options}]}]}
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index form_templates_tenant_idx on clinic.form_templates (tenant_id, specialty);

create table clinic.encounters (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references clinic.tenants(id) on delete cascade,
  patient_id      bigint not null references clinic.patients(id) on delete cascade,
  appointment_id  bigint,                                  -- 005 adds the key
  doctor_id       uuid references clinic.doctors(id) on delete set null,
  template_id     uuid references clinic.form_templates(id) on delete set null,
  status          text not null default 'draft' check (status in ('draft', 'signed')),
  chief_complaint text,
  data            jsonb not null default '{}'::jsonb,      -- {section_key:{field_key:value}}
  sources         jsonb not null default '{}'::jsonb,      -- where each value came from (manual · scribe quote · assistant)
  assessment      text,
  plan            text,
  diagnoses       jsonb not null default '[]'::jsonb,      -- [{name, icd10}]
  follow_up_date  date,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  signed_at       timestamptz,
  signed_by       uuid,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index encounters_patient_idx on clinic.encounters (patient_id, started_at desc);

create table clinic.conditions (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  patient_id   bigint not null references clinic.patients(id) on delete cascade,
  name         text not null,
  icd10        text,
  status       text not null default 'active' check (status in ('active', 'chronic', 'resolved')),
  since        text,
  notes        text,
  source       text not null default 'manual' check (source in ('manual', 'scribe', 'assistant', 'agent', 'import')),
  encounter_id bigint references clinic.encounters(id) on delete set null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index conditions_patient_idx on clinic.conditions (patient_id);

create table clinic.allergies (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  patient_id   bigint not null references clinic.patients(id) on delete cascade,
  substance    text not null,
  reaction     text,
  severity     text check (severity in ('mild', 'moderate', 'severe')),
  status       text not null default 'active' check (status in ('active', 'inactive')),
  source       text not null default 'manual' check (source in ('manual', 'scribe', 'assistant', 'agent', 'import')),
  encounter_id bigint references clinic.encounters(id) on delete set null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index allergies_patient_idx on clinic.allergies (patient_id);

create table clinic.medications (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  patient_id   bigint not null references clinic.patients(id) on delete cascade,
  name         text not null,
  dose         text,
  route        text,
  frequency    text,
  duration     text,
  status       text not null default 'active' check (status in ('active', 'stopped')),
  started_on   date,
  stopped_on   date,
  prescribed_here boolean not null default false,
  notes        text,
  source       text not null default 'manual' check (source in ('manual', 'scribe', 'assistant', 'agent', 'import')),
  encounter_id bigint references clinic.encounters(id) on delete set null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index medications_patient_idx on clinic.medications (patient_id);

create table clinic.patient_history (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  patient_id   bigint not null references clinic.patients(id) on delete cascade,
  kind         text not null check (kind in ('surgery', 'family', 'social', 'obstetric', 'vaccination', 'hospitalization', 'other')),
  title        text not null,
  detail       text,
  data         jsonb not null default '{}'::jsonb,
  source       text not null default 'manual' check (source in ('manual', 'scribe', 'assistant', 'agent', 'import')),
  encounter_id bigint references clinic.encounters(id) on delete set null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index patient_history_patient_idx on clinic.patient_history (patient_id, kind);

create table clinic.vitals (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  patient_id   bigint not null references clinic.patients(id) on delete cascade,
  encounter_id bigint references clinic.encounters(id) on delete set null,
  taken_at     timestamptz not null default now(),
  bp_sys       int, bp_dia int, pulse int, temp_c numeric(4, 1), spo2 int, resp_rate int,
  weight_kg    numeric(6, 2), height_cm numeric(5, 1), glucose numeric(6, 1),
  head_cm      numeric(5, 1),
  notes        text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index vitals_patient_idx on clinic.vitals (patient_id, taken_at desc);

create table clinic.documents (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references clinic.tenants(id) on delete cascade,
  patient_id     bigint references clinic.patients(id) on delete cascade,
  contact_id     bigint references clinic.contacts(id) on delete set null,
  appointment_id bigint,
  message_id     bigint references clinic.messages(id) on delete set null,
  kind           text not null default 'other' check (kind in ('lab', 'imaging', 'prescription', 'photo', 'report', 'referral', 'other')),
  title          text,
  storage_path   text,
  url            text,
  mime           text,
  source         text not null default 'whatsapp' check (source in ('whatsapp', 'upload', 'scribe')),
  ai_summary     text,
  ai_values      jsonb,                -- lab values read from a report: [{name, value, unit, flag}]
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index documents_patient_idx on clinic.documents (patient_id, created_at desc);
create index documents_contact_idx on clinic.documents (contact_id, created_at desc);

create table clinic.dental_chart (
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  patient_id bigint not null references clinic.patients(id) on delete cascade,
  tooth      smallint not null check ((tooth / 10 between 1 and 4 and tooth % 10 between 1 and 8)
                                   or (tooth / 10 between 5 and 8 and tooth % 10 between 1 and 5)),   -- FDI
  condition  text not null default 'healthy'
             check (condition in ('healthy', 'caries', 'filled', 'root_canal', 'crown', 'bridge', 'implant', 'missing',
                                  'extraction_needed', 'impacted', 'fractured', 'sensitive', 'veneer', 'watch')),
  surfaces   text[] not null default '{}',     -- M O D B L (I for front teeth)
  planned    text,                             -- what is planned for it, in words
  notes      text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (patient_id, tooth)
);

create table clinic.treatment_plans (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references clinic.tenants(id) on delete cascade,
  patient_id  bigint not null references clinic.patients(id) on delete cascade,
  doctor_id   uuid references clinic.doctors(id) on delete set null,
  title       text not null default 'خطة العلاج',
  status      text not null default 'draft' check (status in ('draft', 'quoted', 'accepted', 'in_progress', 'done', 'cancelled')),
  discount    numeric(12, 2) not null default 0,
  notes       text,
  quoted_at   timestamptz,
  accepted_at timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index treatment_plans_patient_idx on clinic.treatment_plans (patient_id, created_at desc);

create table clinic.treatment_plan_items (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references clinic.tenants(id) on delete cascade,
  plan_id          bigint not null references clinic.treatment_plans(id) on delete cascade,
  seq              int not null default 1,
  tooth            smallint check (tooth is null or (tooth / 10 between 1 and 4 and tooth % 10 between 1 and 8)
                                  or (tooth / 10 between 5 and 8 and tooth % 10 between 1 and 5)),
  service_id       uuid references clinic.services(id) on delete set null,
  label            text not null,
  price            numeric(12, 2),
  sessions         int not null default 1,
  session_gap_days int,
  done_sessions    int not null default 0,
  status           text not null default 'planned' check (status in ('planned', 'booked', 'in_progress', 'done', 'cancelled')),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index treatment_plan_items_plan_idx on clinic.treatment_plan_items (plan_id, seq);

create table clinic.record_access_log (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  user_id    uuid,
  patient_id bigint references clinic.patients(id) on delete cascade,
  action     text not null default 'view' check (action in ('view', 'edit', 'export', 'print')),
  detail     text,
  at         timestamptz not null default now()
);
create index record_access_log_idx on clinic.record_access_log (tenant_id, at desc);

do $$
declare t text;
begin
  foreach t in array array['patients', 'form_templates', 'encounters', 'conditions', 'allergies', 'medications',
                           'patient_history', 'treatment_plans', 'treatment_plan_items'] loop
    execute format('create trigger %I before update on clinic.%I for each row execute function clinic.touch_updated_at()', t || '_touch', t);
  end loop;
  foreach t in array array['patients', 'encounters', 'conditions', 'allergies', 'medications', 'patient_history',
                           'treatment_plans', 'treatment_plan_items', 'form_templates'] loop
    execute format('create trigger %I after insert or update or delete on clinic.%I for each row execute function clinic.audit_change()', t || '_audit', t);
  end loop;
end $$;

create or replace function clinic.assign_file_no()
returns trigger language plpgsql security definer set search_path = clinic, pg_temp as $$
declare s bigint;
begin
  if new.file_no is null or btrim(new.file_no) = '' then
    loop
      update clinic.tenants set patient_seq = patient_seq + 1 where id = new.tenant_id returning patient_seq into s;
      new.file_no := s::text;
      exit when not exists (select 1 from clinic.patients where tenant_id = new.tenant_id and file_no = new.file_no);
    end loop;
  end if;
  return new;
end $$;
create trigger patients_file_no before insert on clinic.patients
  for each row execute function clinic.assign_file_no();

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function clinic.age_years(p_birth date, p_on date default current_date)
returns numeric language sql immutable as $$
  select case when p_birth is null then null
              else round((extract(year from age(p_on, p_birth)) + extract(month from age(p_on, p_birth)) / 12.0)::numeric, 1) end
$$;

create or replace function clinic.age_text(p_birth date, p_lang text default 'ar')
returns text language sql stable as $$
  select case
    when p_birth is null then null
    when age(current_date, p_birth) < interval '2 years' then
      (extract(year from age(current_date, p_birth)) * 12 + extract(month from age(current_date, p_birth)))::int::text
      || case when p_lang = 'en' then ' months' else ' شهر' end
    else extract(year from age(current_date, p_birth))::int::text || case when p_lang = 'en' then ' years' else ' سنة' end end
$$;

-- "30" / "30 سنة" / "8 شهور" / "1990-05-03" → a birth date (estimated when only an age)
create or replace function clinic.parse_birth(p text, p_today date default current_date)
returns table (birth_date date, estimated boolean) language plpgsql immutable as $$
declare
  s text := btrim(translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'));
  n numeric;
begin
  if s ~ '^\d{4}-\d{1,2}-\d{1,2}$' then
    birth_date := s::date; estimated := false; return next; return;
  end if;
  n := nullif(substring(s from '(\d+(?:\.\d+)?)'), '')::numeric;
  if n is null then return; end if;
  if s ~* '(شهر|شهور|month)' then
    birth_date := (p_today - make_interval(months => n::int))::date;
  elsif s ~* '(اسبوع|أسبوع|week)' then
    birth_date := (p_today - make_interval(days => (n * 7)::int))::date;
  elsif s ~* '(يوم|ايام|أيام|day)' then
    birth_date := (p_today - make_interval(days => n::int))::date;
  else
    if n > 120 then return; end if;
    birth_date := (p_today - make_interval(years => floor(n)::int, months => ((n - floor(n)) * 12)::int))::date;
  end if;
  estimated := true;
  return next;
end $$;

-- a patient as the agent sees them: never the medical record
create or replace function clinic.patient_brief(p_patient bigint)
returns jsonb language plpgsql stable as $$
begin
  return (
    select jsonb_build_object(
      'id', p.id, 'file_no', p.file_no, 'full_name', p.full_name, 'first_name', split_part(p.full_name, ' ', 1),
      'sex', p.sex, 'age', clinic.age_text(p.birth_date, 'ar'), 'age_years', clinic.age_years(p.birth_date),
      'last_visit_at', p.last_visit_at, 'visits_count', p.visits_count, 'preferences', p.preferences,
      'last_doctor', (select clinic.doctor_label(a.doctor_id, 'ar') from clinic.appointments a
                       where a.patient_id = p.id and a.status = 'done' order by a.starts_at desc limit 1),
      'last_doctor_id', (select a.doctor_id from clinic.appointments a
                          where a.patient_id = p.id and a.status = 'done' order by a.starts_at desc limit 1))
      from clinic.patients p where p.id = p_patient);
end $$;

-- record that someone opened a medical record
create or replace function clinic.log_record_access(p_patient bigint, p_action text default 'view', p_detail text default null)
returns void language plpgsql security definer set search_path = clinic, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from clinic.patients where id = p_patient;
  if v_tenant is null then return; end if;
  perform clinic.require_role(v_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  insert into clinic.record_access_log (tenant_id, user_id, patient_id, action, detail)
  values (v_tenant, clinic.current_user_id(), p_patient, coalesce(p_action, 'view'), p_detail);
end $$;

-- the patient a contact means: themself, or a family member by name
create or replace function clinic.contact_patients(p_contact bigint)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(clinic.patient_brief(pc.patient_id) || jsonb_build_object('relation', pc.relation)
                            order by (pc.relation = 'self') desc, p.last_visit_at desc nulls last), '[]'::jsonb)
    from clinic.patient_contacts pc join clinic.patients p on p.id = pc.patient_id and p.is_active
   where pc.contact_id = p_contact
$$;

-- find or create the patient behind a booking
create or replace function clinic.resolve_patient(p_tenant uuid, p_contact bigint, p jsonb)
returns bigint language plpgsql as $$
declare
  v_id    bigint := nullif(p ->> 'patient_id', '')::bigint;
  v_name  text := nullif(btrim(coalesce(p ->> 'full_name', '')), '');
  v_rel   text := coalesce(nullif(p ->> 'relation', ''), 'self');
  v_birth date;
  v_est   boolean;
  co      clinic.contacts%rowtype;
begin
  select * into co from clinic.contacts where id = p_contact;
  if v_id is not null and exists (select 1 from clinic.patients where id = v_id and tenant_id = p_tenant) then
    return v_id;
  end if;
  -- the same name among this contact's patients
  if v_name is not null then
    select pc.patient_id into v_id
      from clinic.patient_contacts pc join clinic.patients x on x.id = pc.patient_id
     where pc.contact_id = p_contact and (clinic.norm(x.full_name) = clinic.norm(v_name)
                                          or split_part(clinic.norm(x.full_name), ' ', 1) = split_part(clinic.norm(v_name), ' ', 1))
     order by (clinic.norm(x.full_name) = clinic.norm(v_name)) desc limit 1;
    if v_id is not null then return v_id; end if;
  elsif v_rel = 'self' then
    select pc.patient_id into v_id from clinic.patient_contacts pc where pc.contact_id = p_contact and pc.relation = 'self' limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  if v_name is null then return null; end if;
  select b.birth_date, b.estimated into v_birth, v_est from clinic.parse_birth(p ->> 'age') b;
  insert into clinic.patients (tenant_id, full_name, sex, birth_date, birth_date_estimated, phone, created_via)
  values (p_tenant, left(v_name, 120), nullif(p ->> 'sex', ''), v_birth, coalesce(v_est, false),
          case when v_rel = 'self' then co.phone end, coalesce(nullif(p ->> 'created_via', ''), 'whatsapp'))
  returning id into v_id;
  if p_contact is not null then
    insert into clinic.patient_contacts (patient_id, contact_id, tenant_id, relation)
    values (v_id, p_contact, p_tenant, case when v_rel in ('self', 'child', 'parent', 'spouse', 'sibling', 'relative', 'other') then v_rel else 'other' end)
    on conflict do nothing;
  end if;
  if v_rel = 'self' and co.id is not null and coalesce(co.full_name, '') = '' then
    update clinic.contacts set full_name = left(v_name, 120) where id = co.id;
  end if;
  return v_id;
end $$;
