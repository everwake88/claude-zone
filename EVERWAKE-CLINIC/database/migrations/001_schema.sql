-- =====================================================================
-- Everwake Clinic · 001 · clinics, the team, and the shared helpers
--
-- One engine, every clinic. A clinic (one doctor, or a polyclinic with
-- many) is a row in `tenants`; every other table carries tenant_id. The
-- dashboard, the WhatsApp agent and the reports all read the same rows.
--
-- The patterns are Everwake Orders' (EVERWAKE-ORDERS/database): who is
-- calling (current_user_id), roles checked inside SECURITY DEFINER
-- functions (require_role), row level security from my_tenant_ids(),
-- an audit trail of every dashboard edit, and a revision number that
-- makes a saved change reach the agent on its very next message.
--
-- Roles in a clinic:
--   owner         everything (usually the doctor who owns the clinic)
--   manager       everything but the team
--   doctor        their patients' records, the schedule, prices and rules
--   nurse         the day, check-in, vitals, reading the records
--   receptionist  bookings, patients' contact details, the inbox — never
--                 the medical record
-- `clinical` on each member decides who reads medical records; it starts
-- from the role and the owner can change it.
-- =====================================================================

create schema if not exists clinic;
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- Clinics
-- ---------------------------------------------------------------------
create table clinic.tenants (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z][a-z0-9_]{1,40}$'),
  name_ar            text not null default '',
  name_en            text not null default '',
  status             text not null default 'onboarding'
                     check (status in ('onboarding', 'live', 'suspended', 'cancelled')),
  plan               text not null default 'pilot',
  country            text not null default 'EG',
  timezone           text not null default 'Africa/Cairo',
  currency           text not null default 'EGP',
  currency_symbol_ar text not null default 'ج',
  default_language   text not null default 'ar' check (default_language in ('ar', 'en')),
  specialty          text not null default 'general',      -- the main one; doctors carry their own
  ref_prefix         text not null default 'CL' check (ref_prefix ~ '^[A-Z0-9]{1,6}$'),
  appt_seq           bigint not null default 1000,
  service_seq        int not null default 0,
  patient_seq        bigint not null default 1000,
  agent_enabled      boolean not null default true,
  current_pause_id   bigint,
  -- what the agent knows (Settings → Agent): about, contacts, insurance, persona
  profile            jsonb not null default '{}'::jsonb,
  -- how the clinic runs (booking rules, reminders, templates…), merged over default_settings()
  settings           jsonb not null default '{}'::jsonb,
  -- bumped by anything the agent reads; the catalogue snapshot rebuilds from it
  catalog_rev        bigint not null default 1,
  catalog_rev_txid   bigint,
  live_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table clinic.tenants is 'One row per clinic or polyclinic.';

create table clinic.platform_admins (
  user_id    uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

create table clinic.tenant_members (
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  user_id      uuid not null,
  role         text not null default 'receptionist'
               check (role in ('owner', 'manager', 'doctor', 'nurse', 'receptionist')),
  clinical     boolean not null default false,   -- may read medical records
  doctor_id    uuid,                              -- the doctor this member is (002 adds the key)
  location_ids uuid[],                            -- null = every location
  phone        text,                              -- their own WhatsApp: staff commands to the agent
  display_name text,
  email        text,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on clinic.tenant_members (user_id);
create index tenant_members_phone_idx on clinic.tenant_members (phone) where phone is not null;

create table clinic.tenant_invites (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  email        text not null check (email = lower(email)),
  role         text not null default 'receptionist'
               check (role in ('owner', 'manager', 'doctor', 'nurse', 'receptionist')),
  clinical     boolean,
  doctor_id    uuid,
  location_ids uuid[],
  invited_by   uuid,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  accepted_by  uuid,
  unique (tenant_id, email)
);

create table clinic.audit_log (
  id         bigint generated always as identity primary key,
  tenant_id  uuid references clinic.tenants(id) on delete cascade,
  user_id    uuid,
  action     text not null,
  entity     text,
  entity_id  text,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_idx on clinic.audit_log (tenant_id, created_at desc);

-- ---------------------------------------------------------------------
-- Who is calling. PostgREST puts the JWT in request.jwt.claims; the n8n
-- engine connects as a database role and has no user (null).
-- ---------------------------------------------------------------------
create or replace function clinic.current_user_id()
returns uuid language sql stable as $$
  select nullif(coalesce(
           nullif(current_setting('request.jwt.claim.sub', true), ''),
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
$$;

-- Arabic-aware matching key: the same rules as normalizeArabic() in the engine
create or replace function clinic.norm(t text)
returns text language sql immutable parallel safe as $$
  select btrim(regexp_replace(
           regexp_replace(
             translate(lower(coalesce(t, '')), 'أإآىةٱ٠١٢٣٤٥٦٧٨٩', 'ااايها0123456789'),
             '[ً-ٰٟـ]', '', 'g'),
           '[^a-z0-9ء-ي]+', ' ', 'g'))
$$;

create or replace function clinic.digits(t text)
returns text language sql immutable parallel safe as $$
  select regexp_replace(translate(coalesce(t, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '\D', '', 'g')
$$;

create or replace function clinic.fmt_money(n numeric)
returns text language sql immutable parallel safe as $$
  select case when n is null then null
              when n >= 1000 and n = round(n) then to_char(n, 'FM999,999,999')
              else trim_scale(round(n, 2))::text end
$$;

-- a phone number as WhatsApp writes it: 01xxxxxxxxx → 201xxxxxxxxx
create or replace function clinic.wa_phone(p text, p_country text default 'EG')
returns text language plpgsql immutable as $$
declare d text := clinic.digits(p);
begin
  if d like '00%' then d := substr(d, 3); end if;
  if coalesce(p_country, 'EG') = 'EG' then
    if d ~ '^01[0125][0-9]{8}$' then d := '2' || d;
    elsif d ~ '^1[0125][0-9]{8}$' then d := '20' || d;
    end if;
  end if;
  return case when length(d) between 8 and 15 then d end;
end $$;

create or replace function clinic.random_token()
returns text language sql volatile as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

create or replace function clinic.slugify(p text)
returns text language sql immutable as $$
  select left(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '_', 'g'),
                                            '^_+|_+$', '', 'g'), '^([0-9])', 'c\1'), 40)
$$;

create or replace function clinic.currency_symbol(p_currency text)
returns text language sql immutable as $$
  select case upper(p_currency)
    when 'EGP' then 'ج' when 'SAR' then 'ر.س' when 'AED' then 'د.إ' when 'QAR' then 'ر.ق'
    when 'KWD' then 'د.ك' when 'USD' then '$' when 'EUR' then '€' else upper(p_currency) end
$$;

-- ---------------------------------------------------------------------
-- Defaults. Stored settings are merged over these, so a new clinic works
-- on day one and every value can be changed from the dashboard.
-- Template placeholders: {name} the person we write to · {for} whose
-- appointment ("حضرتك" or the patient's first name) · {when} the day and
-- time in words · {doctor} · {location} · {link} the manage page · …
-- ---------------------------------------------------------------------
create or replace function clinic.default_settings()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'booking', jsonb_build_object(
      'lead_minutes', 60,          -- the soonest a patient can book from now
      'days_ahead', 45,            -- how far ahead
      'hold_minutes', 15,          -- a slot offered and chosen is kept this long while the patient confirms
      'new_patient_fields', jsonb_build_array('full_name', 'age'),
      'queue_minutes', 15,         -- the average visit, for the estimated time of a queue number
      'cancel_hours', 0),          -- the cancellation policy, in hours before (0 = any time)
    'reminders', jsonb_build_array(
      jsonb_build_object('key', 'day_before', 'kind', 'day_before', 'at', '19:00'),
      jsonb_build_object('key', 'hours_before', 'kind', 'hours_before', 'hours', 3)),
    'reminder_min_lead_minutes', 45,   -- a reminder closer than this to the visit is skipped
    'at_risk_after_minutes', 45,       -- unconfirmed this long after the last reminder → an alert
    'auto_no_show', true,
    'no_show_grace_minutes', 60,
    'delay', jsonb_build_object('reply_share', 0.4, 'reply_min_minutes', 10, 'reply_max_minutes', 90,
                                'before_start_minutes', 30),
    'emergency', jsonb_build_object('whatsapp_doctor', true, 'ambulance', '123'),
    'human_auto_release_minutes', 30,
    'phone_reply_takes_over', true,
    'auto_takeover_on_handoff', false,
    'aftercare_messages', true,
    'test_numbers', jsonb_build_array(),
    'allowed_links', jsonb_build_array(),
    'templates', jsonb_build_object(
      'reminder_day_before_ar', E'أهلاً {name} 👋 تذكير بميعاد {for} {when} مع {doctor} — {location}.\nلو تمام ابعت 1 ✅\nلو عايز تغيّر الميعاد ابعت 2\nولو هتلغي ابعت 3{link}',
      'reminder_day_before_en', E'Hi {name} 👋 A reminder of {for} appointment {when} with {doctor} — {location}.\nReply 1 to confirm ✅\nReply 2 to change the time\nReply 3 to cancel{link}',
      'reminder_hours_before_ar', E'أهلاً {name} 🌿 ميعاد {for} النهارده {when} مع {doctor} — {location}. مستنيينك.\nلو حصل أي ظرف ابعت 2 نغيّر الميعاد أو 3 للإلغاء{link}',
      'reminder_hours_before_en', E'Hi {name} 🌿 {for} appointment is today {when} with {doctor} — {location}. See you soon.\nIf something came up, reply 2 to change it or 3 to cancel{link}',
      'delay_notice_ar', E'أهلاً {name} 🙏 {doctor} هيتأخر النهارده حوالي {minutes} دقيقة، فميعاد {for} بقى {new_time} بدل {old_time}.\nيناسبك؟ ابعت:\n1 تمام ✅\n2 عايز ميعاد تاني\n3 إلغاء الحجز{link}',
      'delay_notice_en', E'Hi {name} 🙏 {doctor} is running about {minutes} minutes late today, so {for} appointment is now at {new_time} instead of {old_time}.\nDoes that work? Reply:\n1 OK ✅\n2 Another time\n3 Cancel{link}',
      'delay_followup_ar', E'{name}، محتاجين نتأكد بس 🙏 الميعاد الجديد {new_time} مناسب؟ ابعت 1 لو تمام، 2 لو عايز ميعاد تاني، أو 3 للإلغاء.',
      'delay_followup_en', E'{name}, just checking 🙏 does the new time {new_time} work? Reply 1 if OK, 2 for another time, or 3 to cancel.',
      'session_cancelled_ar', E'أهلاً {name} 🙏 بنعتذر جداً، {doctor} مش هيقدر يكشف {when}{reason}.\nنقدر نحجز لـ {for} أقرب ميعاد: {options}\nابعت رقم الميعاد اللي يناسبك أو قولنا يوم تاني.',
      'session_cancelled_en', E'Hi {name} 🙏 We are very sorry, {doctor} cannot see patients {when}{reason}.\nWe can book {for} the nearest time: {options}\nReply with the option that suits you, or tell us another day.',
      'booking_confirmed_ar', E'أهلاً {name} ✅ اتحجز لـ {for} {when} مع {doctor} — {location}. رقم الحجز {ref_no}.{prep}{link}',
      'booking_confirmed_en', E'Hi {name} ✅ {for} appointment is booked {when} with {doctor} — {location}. Booking number {ref_no}.{prep}{link}',
      'booking_moved_ar', E'أهلاً {name} 🗓️ ميعاد {for} مع {doctor} اتغيّر لـ {when}. لو مش مناسب ابعت 2 ونختار ميعاد تاني.{link}',
      'booking_moved_en', E'Hi {name} 🗓️ {for} appointment with {doctor} has moved to {when}. If that does not suit you, reply 2 and we will find another time.{link}',
      'booking_cancelled_by_clinic_ar', E'أهلاً {name} 🙏 بنعتذر، ميعاد {for} {when} مع {doctor} اتلغى{reason}. تحب نحجزلك ميعاد تاني؟',
      'booking_cancelled_by_clinic_en', E'Hi {name} 🙏 We are sorry, {for} appointment {when} with {doctor} was cancelled{reason}. Would you like another time?',
      'waitlist_offer_ar', E'أهلاً {name} 👋 فضي ميعاد أقرب مع {doctor}: {when}. تحب نحجزه لـ {for}؟ ابعت 1 للحجز.',
      'waitlist_offer_en', E'Hi {name} 👋 An earlier time opened up with {doctor}: {when}. Shall we book it for {for}? Reply 1 to book.',
      'aftercare_ar', E'ألف سلامة على {for} 🌿 دي تعليمات ما بعد {service}:\n{aftercare}\nلو في أي حاجة مقلقاك ابعتلنا هنا.',
      'aftercare_en', E'Get well soon 🌿 Here are the instructions after {service}:\n{aftercare}\nIf anything worries you, message us here.',
      'pause_apology_ar', 'أهلاً {name} 🙏 خط الحجز على الواتساب واقف شوية. أول ما يرجع هنبعتلك هنا على طول. لو الموضوع طارئ اتصل بالإسعاف 123 أو روح أقرب طوارئ.',
      'pause_apology_en', 'Hi {name} 🙏 Our WhatsApp booking line is paused for a little while. We will message you here as soon as it is back. If it is urgent, call an ambulance (123) or go to the nearest emergency room.',
      'resume_notice_ar', 'أهلاً {name} 👋 رجعنا نستقبل الحجوزات على الواتساب. ابعتلنا وإحنا معاك.',
      'resume_notice_en', 'Hi {name} 👋 We are back and taking bookings on WhatsApp. Just message us.'))
$$;

create or replace function clinic.default_profile()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'agent_name', jsonb_build_object('ar', 'نور', 'en', 'Nour'),
    'agent_gender', 'female',
    'about_ar', '', 'about_en', '', 'tone', '',
    'insurance', jsonb_build_array(),
    'contacts', jsonb_build_object('phone', '', 'whatsapp', '', 'emergency', '', 'email', ''),
    'website', '', 'instagram', '', 'facebook', '', 'google_maps_url', '', 'google_review_url', '',
    'emergency_text_ar', 'لو الحالة طارئة متستناش الميعاد: اتصل بالإسعاف 123 أو روح أقرب طوارئ فوراً.',
    'emergency_text_en', 'If this is an emergency, do not wait for an appointment: call an ambulance (123) or go to the nearest emergency room now.')
$$;

create or replace function clinic.merged_settings(p_settings jsonb)
returns jsonb language sql immutable as $$
  select clinic.default_settings()
         || coalesce(p_settings, '{}'::jsonb)
         || jsonb_build_object(
              'templates', (clinic.default_settings() -> 'templates') || coalesce(p_settings -> 'templates', '{}'::jsonb),
              'booking', (clinic.default_settings() -> 'booking') || coalesce(p_settings -> 'booking', '{}'::jsonb),
              'delay', (clinic.default_settings() -> 'delay') || coalesce(p_settings -> 'delay', '{}'::jsonb),
              'emergency', (clinic.default_settings() -> 'emergency') || coalesce(p_settings -> 'emergency', '{}'::jsonb))
$$;

create or replace function clinic.merged_profile(p_profile jsonb)
returns jsonb language sql immutable as $$
  select clinic.default_profile()
         || coalesce(p_profile, '{}'::jsonb)
         || jsonb_build_object(
              'agent_name', (clinic.default_profile() -> 'agent_name') || coalesce(p_profile -> 'agent_name', '{}'::jsonb),
              'contacts', (clinic.default_profile() -> 'contacts') || coalesce(p_profile -> 'contacts', '{}'::jsonb))
$$;

-- {name} style placeholders; an empty value leaves no stray space behind
create or replace function clinic.render_template(tpl text, vars jsonb)
returns text language plpgsql immutable as $$
declare
  k text; v text; out text := coalesce(tpl, '');
begin
  for k, v in select key, value from jsonb_each_text(coalesce(vars, '{}'::jsonb)) loop
    out := replace(out, '{' || k || '}', coalesce(v, ''));
  end loop;
  out := regexp_replace(out, '\{[a-z_]+\}', '', 'g');
  out := regexp_replace(out, '[ \t]+([،,.!؟?])', '\1', 'g');
  out := regexp_replace(out, '[ \t]{2,}', ' ', 'g');
  return btrim(out);
end $$;

-- a first name for a greeting: the given name, never a long WhatsApp nickname
create or replace function clinic.first_name(full_name text, display_name text)
returns text language sql immutable as $$
  select coalesce(
    nullif(split_part(btrim(coalesce(full_name, '')), ' ', 1), ''),
    case when length(btrim(coalesce(display_name, ''))) between 2 and 20
              and btrim(display_name) ~ '^[ء-يA-Za-z ]+$'
         then split_part(btrim(display_name), ' ', 1) end,
    '')
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
create or replace function clinic.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- anything the agent reads changed → the clinic's revision goes up once per transaction
create or replace function clinic.bump_catalog_rev()
returns trigger language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  t uuid := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
begin
  update clinic.tenants
     set catalog_rev = catalog_rev + 1, catalog_rev_txid = txid_current()
   where id = t and catalog_rev_txid is distinct from txid_current();
  return null;
end $$;

create or replace function clinic.tenants_before_update()
returns trigger language plpgsql as $$
begin
  if (new.profile, new.settings, new.name_ar, new.name_en, new.timezone, new.currency, new.currency_symbol_ar,
      new.default_language, new.status, new.specialty)
     is distinct from
     (old.profile, old.settings, old.name_ar, old.name_en, old.timezone, old.currency, old.currency_symbol_ar,
      old.default_language, old.status, old.specialty)
     and new.catalog_rev = old.catalog_rev then
    new.catalog_rev := old.catalog_rev + 1;
    new.catalog_rev_txid := txid_current();
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger tenants_before_update before update on clinic.tenants
  for each row execute function clinic.tenants_before_update();

-- who changed what, from the dashboard (the engine has no user and is not audited here)
create or replace function clinic.audit_change()
returns trigger language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  uid  uuid := clinic.current_user_id();
  diff jsonb;
  rid  text;
  tid  uuid;
  rowj jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
  if uid is null then return null; end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(to_jsonb(old) -> n.key, n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
     where n.key not in ('updated_at', 'catalog_rev', 'catalog_rev_txid', 'appt_seq', 'service_seq', 'patient_seq',
                         'api_key', 'cloud_access_token', 'webhook_token')
       and (to_jsonb(old) -> n.key) is distinct from n.value;
    if diff is null then return null; end if;
  else
    diff := rowj - 'api_key' - 'cloud_access_token' - 'webhook_token';
  end if;
  rid := coalesce(rowj ->> 'id', rowj ->> 'patient_id');
  tid := case when tg_table_name = 'tenants' then (rowj ->> 'id')::uuid else (rowj ->> 'tenant_id')::uuid end;
  insert into clinic.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
  values (tid, uid, lower(tg_op), tg_table_name, rid, diff);
  return null;
end $$;

-- ---------------------------------------------------------------------
-- Who may do what
-- ---------------------------------------------------------------------
create or replace function clinic.is_platform_admin()
returns boolean language sql stable security definer set search_path = clinic, pg_temp as $$
  select exists (select 1 from clinic.platform_admins a where a.user_id = clinic.current_user_id())
$$;

create or replace function clinic.member_role(p_tenant uuid)
returns text language sql stable security definer set search_path = clinic, pg_temp as $$
  select case
    when clinic.current_user_id() is null then null
    when clinic.is_platform_admin() then 'owner'
    else (select m.role from clinic.tenant_members m
           where m.tenant_id = p_tenant and m.user_id = clinic.current_user_id())
  end
$$;

-- no JWT (the engine, scripts) = trusted 'system'; a user without the role is refused
create or replace function clinic.require_role(p_tenant uuid, p_roles text[])
returns text language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare r text;
begin
  if clinic.current_user_id() is null then
    return 'system';
  end if;
  r := clinic.member_role(p_tenant);
  if r is null or not (r = any(p_roles)) then
    raise exception 'not allowed for this clinic' using errcode = '42501';
  end if;
  return r;
end $$;

-- medical records: members marked clinical (and the engine)
create or replace function clinic.can_see_clinical(p_tenant uuid)
returns boolean language sql stable security definer set search_path = clinic, pg_temp as $$
  select clinic.current_user_id() is null
      or clinic.is_platform_admin()
      or exists (select 1 from clinic.tenant_members m
                  where m.tenant_id = p_tenant and m.user_id = clinic.current_user_id() and m.clinical)
$$;

create or replace function clinic.require_clinical(p_tenant uuid)
returns void language plpgsql stable security definer set search_path = clinic, pg_temp as $$
begin
  if not clinic.can_see_clinical(p_tenant) then
    raise exception 'medical records are for the clinical team' using errcode = '42501';
  end if;
end $$;

create or replace function clinic.my_tenant_ids()
returns uuid[] language sql stable security definer set search_path = clinic, pg_temp as $$
  select case
    when clinic.current_user_id() is null then '{}'::uuid[]
    when clinic.is_platform_admin() then coalesce((select array_agg(id) from clinic.tenants), '{}')
    else coalesce((select array_agg(tenant_id) from clinic.tenant_members where user_id = clinic.current_user_id()), '{}')
  end
$$;

-- who changes the set-up: owners, managers and doctors
create or replace function clinic.my_editor_tenant_ids()
returns uuid[] language sql stable security definer set search_path = clinic, pg_temp as $$
  select case
    when clinic.current_user_id() is null then '{}'::uuid[]
    when clinic.is_platform_admin() then coalesce((select array_agg(id) from clinic.tenants), '{}')
    else coalesce((select array_agg(tenant_id) from clinic.tenant_members
                    where user_id = clinic.current_user_id() and role in ('owner', 'manager', 'doctor')), '{}')
  end
$$;

create or replace function clinic.my_clinical_tenant_ids()
returns uuid[] language sql stable security definer set search_path = clinic, pg_temp as $$
  select case
    when clinic.current_user_id() is null then '{}'::uuid[]
    when clinic.is_platform_admin() then coalesce((select array_agg(id) from clinic.tenants), '{}')
    else coalesce((select array_agg(tenant_id) from clinic.tenant_members
                    where user_id = clinic.current_user_id() and clinical), '{}')
  end
$$;

create or replace function clinic.my_name(p_tenant uuid)
returns text language sql stable security definer set search_path = clinic, pg_temp as $$
  select coalesce(m.display_name, m.email) from clinic.tenant_members m
   where m.tenant_id = p_tenant and m.user_id = clinic.current_user_id()
$$;
