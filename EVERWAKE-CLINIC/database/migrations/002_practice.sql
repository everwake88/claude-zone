-- =====================================================================
-- Everwake Clinic · 002 · the practice: doctors, places, schedules, and
-- the catalogue the agent answers from
--
--   doctors              each with a speciality, a follow-up window and
--                        their own WhatsApp for staff commands
--   locations            where they see patients (a doctor can work at
--                        several on different days)
--   resources            dental chairs, rooms, a laser: a service can
--                        need one, and booking takes the doctor and a
--                        free one together
--   schedules            doctor × location × weekday windows, each in
--                        `slots` (fixed times), `queue` (a number, الدور,
--                        with an estimated time) or `both`
--   schedule_exceptions  a day off, an extra session, changed hours
--
-- The catalogue (one per clinic, per doctor where it differs):
--   services             every visit type, test and procedure with its
--                        price shape (fixed · a range · from · after the
--                        check-up · free), the unit it is priced per
--                        (visit, tooth, canal, jaw, session, area…),
--                        sessions, preparation and aftercare, who does
--                        it, on which days, for which ages
--   service_prices       a price for one doctor and/or one location
--   offers               dated discounts and packages
--   knowledge_entries    FAQs and policies
--   agent_rules          the doctor's rules: some enforced in code
--                        (new patients until a time, children under an
--                        age only with a doctor), and a free-text note
--   catalog_changes      every change the AI (or the editor) made, with
--                        before and after, so it can be undone
--   catalog_snapshot     what the agent reads every turn, rebuilt when
--                        catalog_rev moves (save → the next message knows)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Specialities: shipped presets (020 fills them). Global, not per clinic.
-- ---------------------------------------------------------------------
create table clinic.specialty_presets (
  code             text primary key check (code ~ '^[a-z_]{2,30}$'),
  name_ar          text not null,
  name_en          text not null,
  group_name       text not null default 'medical',
  keywords         text[] not null default '{}',       -- how patients describe a problem for this speciality
  starter_services jsonb not null default '[]'::jsonb,  -- [{name_ar,name_en,category,duration,price_kind,unit,sessions,session_gap_days,aliases[],aftercare_ar,resource_kind}]
  form_template    jsonb not null default '{}'::jsonb,  -- {sections:[{key,title_ar,title_en,fields:[{key,label_ar,label_en,type,unit,options[]}]}]}
  triage           jsonb not null default '[]'::jsonb,  -- [{level:'emergency'|'urgent', words:[…], why}]
  is_custom        boolean not null default false,
  sort             int not null default 100
);

-- ---------------------------------------------------------------------
-- Doctors and places
-- ---------------------------------------------------------------------
create table clinic.doctors (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references clinic.tenants(id) on delete cascade,
  code             text not null check (code ~ '^D[0-9]{1,3}$'),
  user_id          uuid,                       -- their dashboard login, when they have one
  name_ar          text not null,
  name_en          text,
  title_ar         text not null default 'د.',
  title_en         text not null default 'Dr.',
  gender           text check (gender in ('male', 'female')),
  specialty        text not null default 'general',
  sub_specialty_ar text,
  sub_specialty_en text,
  bio_ar           text,
  bio_en           text,
  photo_url        text,
  languages        text[] not null default '{ar}',
  color            text,                        -- their tint in the calendar
  ops_whatsapp     text,                        -- their own number: emergencies and staff commands
  follow_up_days   int not null default 14,     -- a visit within this many days of the last is a follow-up
  accepts_new      boolean not null default true,
  is_active        boolean not null default true,
  sort             int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, code)
);
create index doctors_tenant_idx on clinic.doctors (tenant_id, is_active);

alter table clinic.tenant_members
  add constraint tenant_members_doctor_fk foreign key (doctor_id) references clinic.doctors(id) on delete set null;

create table clinic.locations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references clinic.tenants(id) on delete cascade,
  code          text not null check (code ~ '^[a-z0-9_]{2,30}$'),
  name_ar       text not null,
  name_en       text,
  aliases       text[] not null default '{}',
  area_ar       text,
  address_ar    text,
  address_en    text,
  directions_ar text,                 -- "الدور التالت فوق صيدلية…"
  lat           double precision,
  lng           double precision,
  maps_url      text,
  phone         text,
  ops_whatsapp  text,
  is_active     boolean not null default true,
  sort          int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, code)
);

create table clinic.resources (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references clinic.tenants(id) on delete cascade,
  location_id uuid not null references clinic.locations(id) on delete cascade,
  kind        text not null default 'chair' check (kind ~ '^[a-z_]{2,20}$'),   -- chair · room · laser · bed …
  name_ar     text not null,
  name_en     text,
  is_active   boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index resources_location_idx on clinic.resources (location_id, kind) where is_active;

create table clinic.schedules (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references clinic.tenants(id) on delete cascade,
  doctor_id      uuid not null references clinic.doctors(id) on delete cascade,
  location_id    uuid not null references clinic.locations(id) on delete cascade,
  weekday        smallint not null check (weekday between 0 and 6),   -- 0 = Sunday … 6 = Saturday
  start_time     time not null,
  end_time       time not null,                                       -- at or before start = past midnight
  mode           text not null default 'slots' check (mode in ('slots', 'queue', 'both')),
  slot_minutes   int not null default 15 check (slot_minutes between 5 and 240),
  capacity       int check (capacity is null or capacity > 0),        -- the most patients in the session
  online_booking boolean not null default true,                       -- the agent may book it
  valid_from     date,
  valid_to       date,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index schedules_doctor_idx on clinic.schedules (doctor_id, weekday) where is_active;

create table clinic.schedule_exceptions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  doctor_id    uuid not null references clinic.doctors(id) on delete cascade,
  location_id  uuid references clinic.locations(id) on delete cascade,   -- null = everywhere
  on_date      date not null,
  kind         text not null check (kind in ('off', 'extra', 'changed')),
  start_time   time,                -- 'off' with times = only that part of the day
  end_time     time,
  mode         text check (mode in ('slots', 'queue', 'both')),
  slot_minutes int,
  capacity     int,
  reason       text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index schedule_exceptions_idx on clinic.schedule_exceptions (doctor_id, on_date);

-- ---------------------------------------------------------------------
-- The catalogue
-- ---------------------------------------------------------------------
create table clinic.services (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references clinic.tenants(id) on delete cascade,
  code             text not null check (code ~ '^S[0-9]{3,5}$'),   -- what the agent uses: S001…
  category         text not null default 'consultation'
                   check (category in ('consultation', 'follow_up', 'diagnostic', 'procedure', 'cosmetic', 'package', 'other')),
  specialty        text,                         -- null = any doctor of the clinic
  name_ar          text not null,
  name_en          text,
  aliases          text[] not null default '{}',
  description_ar   text,
  description_en   text,
  duration_min     int not null default 15 check (duration_min between 5 and 600),
  price_kind       text not null default 'fixed' check (price_kind in ('fixed', 'range', 'from', 'after_exam', 'free')),
  price            numeric(12, 2),               -- null with 'fixed' = not set yet: the agent asks the doctor
  price_max        numeric(12, 2),
  price_unit       text not null default 'visit'
                   check (price_unit in ('visit', 'tooth', 'canal', 'jaw', 'session', 'area', 'course', 'unit')),
  price_note_ar    text,                         -- "حسب نوع الزرعة والعظم"
  price_note_en    text,
  sessions         int not null default 1 check (sessions between 1 and 60),
  session_gap_days int,
  prep_ar          text,                         -- sent with the booking
  prep_en          text,
  aftercare_ar     text,                         -- sent when the visit is marked done
  aftercare_en     text,
  doctor_ids       uuid[] not null default '{}', -- empty = every doctor (of `specialty` when set)
  location_ids     uuid[] not null default '{}', -- empty = every location
  days             smallint[] not null default '{}',  -- weekdays it is offered; empty = every day
  min_age          numeric(5, 2),
  max_age          numeric(5, 2),
  needs_consult_first boolean not null default false,
  resource_kind    text,                         -- needs a free chair / room / laser
  deposit          numeric(12, 2),
  pay_online       text not null default 'off' check (pay_online in ('off', 'optional', 'deposit', 'full')),
  installments     boolean not null default false,
  agent_visible    boolean not null default true, -- the agent may mention it and its price
  bookable         boolean not null default true, -- the agent may book it directly
  is_active        boolean not null default true,
  sort             int not null default 0,
  source_import_id uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, code),
  check (price_kind <> 'range' or price_max is null or price is null or price_max >= price)
);
create index services_tenant_idx on clinic.services (tenant_id, is_active, sort);

create table clinic.service_prices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references clinic.tenants(id) on delete cascade,
  service_id  uuid not null references clinic.services(id) on delete cascade,
  doctor_id   uuid references clinic.doctors(id) on delete cascade,
  location_id uuid references clinic.locations(id) on delete cascade,
  price_kind  text check (price_kind in ('fixed', 'range', 'from', 'after_exam', 'free')),
  price       numeric(12, 2),
  price_max   numeric(12, 2),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (doctor_id is not null or location_id is not null)
);
create unique index service_prices_uidx on clinic.service_prices (service_id, doctor_id, location_id) nulls not distinct;

create table clinic.offers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references clinic.tenants(id) on delete cascade,
  title_ar       text not null,
  title_en       text,
  description_ar text,
  description_en text,
  kind           text not null default 'percent_off'
                 check (kind in ('percent_off', 'amount_off', 'fixed_price', 'package', 'free')),
  value          numeric(12, 2) not null default 0,
  service_ids    uuid[] not null default '{}',
  doctor_ids     uuid[] not null default '{}',
  starts_at      timestamptz,
  ends_at        timestamptz,
  days           smallint[] not null default '{}',
  is_active      boolean not null default true,
  sort           int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index offers_tenant_idx on clinic.offers (tenant_id, is_active);

create table clinic.knowledge_entries (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  doctor_id  uuid references clinic.doctors(id) on delete cascade,
  topic      text not null,
  content_ar text,
  content_en text,
  is_active  boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_entries_tenant_idx on clinic.knowledge_entries (tenant_id);

-- kind:
--   note                params {}                       the agent reads text_ar under its fixed safety rules
--   new_patients_until  params {"time":"21:00"}         no first visits after this local time
--   age_doctor          params {"max_age":6}            patients under max_age only with doctor_id
--   no_booking_days     params {"days":[5]}             the agent books nobody on these weekdays (doctor_id or all)
create table clinic.agent_rules (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references clinic.tenants(id) on delete cascade,
  kind       text not null default 'note' check (kind in ('note', 'new_patients_until', 'age_doctor', 'no_booking_days')),
  doctor_id  uuid references clinic.doctors(id) on delete cascade,
  service_id uuid references clinic.services(id) on delete cascade,
  params     jsonb not null default '{}'::jsonb,
  text_ar    text,
  text_en    text,
  is_active  boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agent_rules_tenant_idx on clinic.agent_rules (tenant_id) where is_active;

create table clinic.catalog_imports (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references clinic.tenants(id) on delete cascade,
  doctor_id    uuid references clinic.doctors(id) on delete set null,
  source_kind  text not null check (source_kind in ('pdf', 'image', 'url', 'text', 'csv')),
  source_url   text,
  files        jsonb not null default '[]'::jsonb,
  raw_text     text,
  status       text not null default 'uploaded' check (status in ('uploaded', 'extracting', 'review', 'published', 'failed')),
  extracted    jsonb,
  error        text,
  model        text,
  usage        jsonb,
  created_by   uuid,
  published_by uuid,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table clinic.catalog_changes (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references clinic.tenants(id) on delete cascade,
  source      text not null default 'dashboard' check (source in ('dashboard', 'whatsapp', 'assistant', 'import')),
  request     jsonb not null default '[]'::jsonb,   -- what was asked
  entries     jsonb not null default '[]'::jsonb,   -- [{op, table, id, label, before, after}]
  summary_ar  text,
  status      text not null default 'pending' check (status in ('pending', 'applied', 'undone', 'discarded')),
  created_by  uuid,
  created_by_name text,
  created_at  timestamptz not null default now(),
  applied_at  timestamptz,
  undone_at   timestamptz
);
create index catalog_changes_tenant_idx on clinic.catalog_changes (tenant_id, created_at desc);

create table clinic.catalog_snapshot (
  tenant_id    uuid primary key references clinic.tenants(id) on delete cascade,
  digest_text  text not null default '',
  lookup       jsonb not null default '{}'::jsonb,
  version_hash text not null default '',
  source_rev   bigint not null default 0,
  built_at     timestamptz not null default now(),
  valid_until  timestamptz
);

-- ---------------------------------------------------------------------
-- Codes, triggers
-- ---------------------------------------------------------------------
create or replace function clinic.assign_service_code()
returns trigger language plpgsql security definer set search_path = clinic, pg_temp as $$
declare s int;
begin
  if new.code is null or btrim(new.code) = '' then
    loop
      update clinic.tenants set service_seq = service_seq + 1 where id = new.tenant_id returning service_seq into s;
      new.code := 'S' || lpad(s::text, 3, '0');
      exit when not exists (select 1 from clinic.services where tenant_id = new.tenant_id and code = new.code);
    end loop;
  end if;
  new.code := upper(btrim(new.code));
  return new;
end $$;
create trigger services_assign_code before insert on clinic.services
  for each row execute function clinic.assign_service_code();

create or replace function clinic.assign_doctor_code()
returns trigger language plpgsql as $$
declare n int;
begin
  if new.code is null or btrim(new.code) = '' then
    select coalesce(max(substr(code, 2)::int), 0) + 1 into n from clinic.doctors where tenant_id = new.tenant_id;
    new.code := 'D' || n;
  end if;
  return new;
end $$;
create trigger doctors_assign_code before insert on clinic.doctors
  for each row execute function clinic.assign_doctor_code();

do $$
declare t text;
begin
  foreach t in array array['doctors', 'locations', 'resources', 'schedules', 'services', 'service_prices', 'offers',
                           'knowledge_entries', 'agent_rules', 'catalog_imports'] loop
    execute format('create trigger %I before update on clinic.%I for each row execute function clinic.touch_updated_at()',
                   t || '_touch', t);
  end loop;
  foreach t in array array['doctors', 'locations', 'resources', 'schedules', 'schedule_exceptions', 'services',
                           'service_prices', 'offers', 'knowledge_entries', 'agent_rules'] loop
    execute format('create trigger %I after insert or update or delete on clinic.%I for each row execute function clinic.bump_catalog_rev()',
                   t || '_rev', t);
  end loop;
  foreach t in array array['tenants', 'doctors', 'locations', 'resources', 'schedules', 'schedule_exceptions', 'services',
                           'service_prices', 'offers', 'knowledge_entries', 'agent_rules', 'tenant_members'] loop
    execute format('create trigger %I after insert or update or delete on clinic.%I for each row execute function clinic.audit_change()',
                   t || '_audit', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Words the agent and the dashboard share
-- ---------------------------------------------------------------------
create or replace function clinic.doctor_label(p_doctor uuid, p_lang text default 'ar')
returns text language sql stable as $$
  select case when p_lang = 'en' then concat_ws(' ', nullif(d.title_en, ''), coalesce(nullif(d.name_en, ''), d.name_ar))
              else concat_ws(' ', nullif(d.title_ar, ''), d.name_ar) end
    from clinic.doctors d where d.id = p_doctor
$$;

create or replace function clinic.location_label(p_location uuid, p_lang text default 'ar')
returns text language sql stable as $$
  select case when p_lang = 'en' then coalesce(nullif(l.name_en, ''), l.name_ar) else l.name_ar end
    from clinic.locations l where l.id = p_location
$$;

create or replace function clinic.day_name(p_dow int, p_lang text default 'ar')
returns text language sql immutable as $$
  select case when p_lang = 'en'
              then (array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])[p_dow + 1]
              else (array['الأحد','الاتنين','التلات','الأربع','الخميس','الجمعة','السبت'])[p_dow + 1] end
$$;

-- 17:30 → "5:30 م" / "5:30 pm"
create or replace function clinic.clock_text(p_time time, p_lang text default 'ar')
returns text language sql immutable as $$
  select case when p_time is null then null else
    ((extract(hour from p_time)::int + 11) % 12 + 1)::text
    || case when extract(minute from p_time)::int = 0 then '' else ':' || lpad(extract(minute from p_time)::int::text, 2, '0') end
    || case when p_lang = 'en' then case when extract(hour from p_time) < 12 then ' am' else ' pm' end
            else case when extract(hour from p_time) < 12 then ' ص' else ' م' end end end
$$;

create or replace function clinic.unit_text(p_unit text, p_lang text default 'ar')
returns text language sql immutable as $$
  select case when p_lang = 'en' then case p_unit
           when 'tooth' then 'per tooth' when 'canal' then 'per canal' when 'jaw' then 'per jaw'
           when 'session' then 'per session' when 'area' then 'per area' when 'course' then 'for the full course'
           when 'unit' then 'per unit' else '' end
         else case p_unit
           when 'tooth' then 'للسنة' when 'canal' then 'للقناة' when 'jaw' then 'للفك'
           when 'session' then 'للجلسة' when 'area' then 'للمنطقة' when 'course' then 'للكورس كامل'
           when 'unit' then 'للوحدة' else '' end end
$$;

-- the price as a patient hears it
create or replace function clinic.price_words(p_kind text, p_price numeric, p_max numeric, p_unit text,
                                              p_lang text default 'ar', p_symbol text default 'ج')
returns text language sql immutable as $$
  select btrim(case
    when p_kind = 'free' then case when p_lang = 'en' then 'free' else 'مجاناً' end
    when p_kind = 'after_exam' then case when p_lang = 'en' then 'priced after the check-up' else 'السعر بيتحدد بعد الكشف' end
    when p_price is null then case when p_lang = 'en' then 'price not on file' else 'السعر مش متسجل' end
    when p_kind = 'range' and p_max is not null then
      case when p_lang = 'en' then 'from ' || clinic.fmt_money(p_price) || ' to ' || clinic.fmt_money(p_max) || ' EGP'
           else 'من ' || clinic.fmt_money(p_price) || ' لـ ' || clinic.fmt_money(p_max) || ' ' || p_symbol end
    when p_kind in ('from', 'range') then
      case when p_lang = 'en' then 'from ' || clinic.fmt_money(p_price) || ' EGP'
           else 'يبدأ من ' || clinic.fmt_money(p_price) || ' ' || p_symbol end
    else case when p_lang = 'en' then clinic.fmt_money(p_price) || ' EGP' else clinic.fmt_money(p_price) || ' ' || p_symbol end
  end || ' ' || case when p_kind in ('free', 'after_exam') or p_price is null then '' else clinic.unit_text(p_unit, p_lang) end)
$$;

-- does this doctor (at this location) do this service?
create or replace function clinic.service_offered(p_service uuid, p_doctor uuid, p_location uuid default null)
returns boolean language sql stable as $$
  select exists (
    select 1 from clinic.services s
      join clinic.doctors d on d.id = p_doctor and d.tenant_id = s.tenant_id
     where s.id = p_service and s.is_active and d.is_active
       and (case when cardinality(s.doctor_ids) > 0 then p_doctor = any(s.doctor_ids)
                 else s.specialty is null or s.specialty = d.specialty end)
       and (p_location is null or cardinality(s.location_ids) = 0 or p_location = any(s.location_ids)))
$$;

-- the price for one doctor at one place: the most specific row wins
create or replace function clinic.service_price(p_service uuid, p_doctor uuid default null, p_location uuid default null)
returns jsonb language sql stable as $$
  with s as (select * from clinic.services where id = p_service),
  o as (
    select sp.* from clinic.service_prices sp
     where sp.service_id = p_service
       and (sp.doctor_id is null or sp.doctor_id = p_doctor)
       and (sp.location_id is null or sp.location_id = p_location)
       and (sp.doctor_id is not null or sp.location_id is not null)
     order by (sp.doctor_id is not null and sp.location_id is not null) desc, (sp.doctor_id is not null) desc
     limit 1)
  select jsonb_build_object(
           'kind', coalesce(o.price_kind, s.price_kind),
           'price', case when o.id is not null and (o.price is not null or o.price_kind is not null) then o.price else s.price end,
           'price_max', case when o.id is not null and (o.price is not null or o.price_kind is not null) then o.price_max else s.price_max end,
           'unit', s.price_unit,
           'note_ar', s.price_note_ar, 'note_en', s.price_note_en,
           'text_ar', clinic.price_words(coalesce(o.price_kind, s.price_kind),
                                         case when o.id is not null and (o.price is not null or o.price_kind is not null) then o.price else s.price end,
                                         case when o.id is not null and (o.price is not null or o.price_kind is not null) then o.price_max else s.price_max end,
                                         s.price_unit, 'ar', t.currency_symbol_ar),
           'text_en', clinic.price_words(coalesce(o.price_kind, s.price_kind),
                                         case when o.id is not null and (o.price is not null or o.price_kind is not null) then o.price else s.price end,
                                         case when o.id is not null and (o.price is not null or o.price_kind is not null) then o.price_max else s.price_max end,
                                         s.price_unit, 'en', t.currency_symbol_ar))
    from s join clinic.tenants t on t.id = s.tenant_id left join o on true
$$;

-- a service named in words (code, name, alias, or a close match)
create or replace function clinic.match_service(p_tenant uuid, p_text text, p_doctor uuid default null)
returns uuid language sql stable as $$
  with q as (select clinic.norm(p_text) as n, upper(btrim(coalesce(p_text, ''))) as code)
  select s.id
    from clinic.services s, q
   where s.tenant_id = p_tenant and s.is_active and q.n <> ''
     and (p_doctor is null or clinic.service_offered(s.id, p_doctor))
     and (s.code = q.code
          or clinic.norm(s.name_ar) = q.n or clinic.norm(coalesce(s.name_en, '')) = q.n
          or q.n = any (select clinic.norm(a) from unnest(s.aliases) a)
          or (length(q.n) >= 3 and (clinic.norm(s.name_ar) like '%' || q.n || '%'
                                    or clinic.norm(coalesce(s.name_en, '')) like '%' || q.n || '%'
                                    or q.n like '%' || clinic.norm(s.name_ar) || '%'
                                    or exists (select 1 from unnest(s.aliases) a where length(a) >= 3 and q.n like '%' || clinic.norm(a) || '%'))))
   order by (s.code = q.code) desc,
            (clinic.norm(s.name_ar) = q.n or clinic.norm(coalesce(s.name_en, '')) = q.n) desc,
            (q.n = any (select clinic.norm(a) from unnest(s.aliases) a)) desc,
            length(s.name_ar), s.sort
   limit 1
$$;

create or replace function clinic.match_doctor(p_tenant uuid, p_text text)
returns uuid language sql stable as $$
  with q as (select btrim(regexp_replace(clinic.norm(p_text), '^(د|دكتور|دكتوره|الدكتور|الدكتوره|dr|doctor)\s+', '')) as n,
                    upper(btrim(coalesce(p_text, ''))) as code)
  select d.id
    from clinic.doctors d, q
   where d.tenant_id = p_tenant and d.is_active and q.n <> ''
     and (d.code = q.code or clinic.norm(d.name_ar) = q.n or clinic.norm(coalesce(d.name_en, '')) = q.n
          or clinic.norm(d.name_ar) like q.n || '%' or clinic.norm(coalesce(d.name_en, '')) like q.n || '%'
          or (length(q.n) >= 3 and clinic.norm(d.name_ar) like '%' || q.n || '%')
          or d.specialty = q.n
          or exists (select 1 from clinic.specialty_presets sp where sp.code = d.specialty
                      and (clinic.norm(sp.name_ar) like '%' || q.n || '%' or lower(sp.name_en) like '%' || q.n || '%')))
   order by (d.code = q.code) desc, (clinic.norm(d.name_ar) = q.n) desc, d.sort
   limit 1
$$;

create or replace function clinic.match_location(p_tenant uuid, p_text text)
returns uuid language sql stable as $$
  with q as (select clinic.norm(p_text) as n)
  select l.id from clinic.locations l, q
   where l.tenant_id = p_tenant and l.is_active and q.n <> ''
     and (clinic.norm(l.code) = q.n or clinic.norm(l.name_ar) = q.n or clinic.norm(coalesce(l.name_en, '')) = q.n
          or q.n = any (select clinic.norm(a) from unnest(l.aliases) a)
          or (length(q.n) >= 3 and (clinic.norm(l.name_ar) like '%' || q.n || '%' or q.n like '%' || clinic.norm(l.name_ar) || '%'
                                    or clinic.norm(coalesce(l.area_ar, '')) like '%' || q.n || '%')))
   order by (clinic.norm(l.name_ar) = q.n) desc, l.sort
   limit 1
$$;

-- an offer running at a moment (in the clinic's time)
create or replace function clinic.offer_live(o clinic.offers, p_at timestamptz, p_tz text)
returns boolean language sql stable as $$
  select o.is_active
     and (o.starts_at is null or o.starts_at <= p_at)
     and (o.ends_at is null or o.ends_at > p_at)
     and (cardinality(o.days) = 0 or extract(dow from (p_at at time zone p_tz))::smallint = any(o.days))
$$;

-- ---------------------------------------------------------------------
-- The snapshot: what the agent reads every turn
-- ---------------------------------------------------------------------
create or replace function clinic.rebuild_snapshot(p_tenant uuid)
returns jsonb language plpgsql as $$
declare
  t        clinic.tenants%rowtype;
  lines    text[] := '{}';
  d        record;
  s        record;
  r        record;
  v_pr     jsonb;
  v_who    text;
  v_amounts numeric[] := '{}';
  v_services jsonb := '{}'::jsonb;
  v_doctors  jsonb := '{}'::jsonb;
  v_offers   jsonb := '[]'::jsonb;
  v_digest text;
  v_rows   text;
  v_until  timestamptz;
begin
  select * into t from clinic.tenants where id = p_tenant;
  if not found then return null; end if;

  -- doctors and when they see patients ---------------------------------
  lines := lines || 'DOCTORS'::text;
  for d in select * from clinic.doctors where tenant_id = p_tenant and is_active order by sort, code loop
    select string_agg(format('%s %s %s–%s (%s%s)',
                             l.name_ar, clinic.day_name(sc.weekday), to_char(sc.start_time, 'HH24:MI'), to_char(sc.end_time, 'HH24:MI'),
                             case sc.mode when 'slots' then 'by appointment' when 'queue' then 'by queue number' else 'appointment or queue' end,
                             case when not sc.online_booking then ', NOT bookable here — by phone' else '' end), '; '
                      order by l.sort, (sc.weekday + 1) % 7, sc.start_time)
      into v_rows
      from clinic.schedules sc join clinic.locations l on l.id = sc.location_id
     where sc.doctor_id = d.id and sc.is_active and l.is_active
       and (sc.valid_to is null or sc.valid_to >= (now() at time zone t.timezone)::date);
    lines := lines || format('- %s %s · %s%s%s · sees patients: %s',
                             d.code, clinic.doctor_label(d.id, 'ar'),
                             coalesce((select name_ar from clinic.specialty_presets where code = d.specialty), d.specialty),
                             coalesce(' (' || nullif(d.sub_specialty_ar, '') || ')', ''),
                             case when not d.accepts_new then ' · NOT taking new patients' else '' end,
                             coalesce(v_rows, 'no schedule on file'));
    v_doctors := v_doctors || jsonb_build_object(d.code, jsonb_build_object(
                   'id', d.id, 'name_ar', clinic.doctor_label(d.id, 'ar'), 'name_en', clinic.doctor_label(d.id, 'en'),
                   'specialty', d.specialty, 'follow_up_days', d.follow_up_days, 'accepts_new', d.accepts_new));
  end loop;

  lines := lines || ''::text || 'LOCATIONS'::text;
  for r in select * from clinic.locations where tenant_id = p_tenant and is_active order by sort loop
    lines := lines || format('- %s%s%s%s', r.name_ar,
                             coalesce(' — ' || nullif(r.address_ar, ''), ''),
                             coalesce(' (' || nullif(r.directions_ar, '') || ')', ''),
                             coalesce(' · map: ' || nullif(r.maps_url, ''), ''));
  end loop;

  -- services and prices --------------------------------------------------
  lines := lines || ''::text || ('SERVICES AND PRICES (' || t.currency || ') — the ONLY prices you may say'::text);
  for s in select * from clinic.services where tenant_id = p_tenant and is_active and agent_visible
            order by case category when 'consultation' then 0 when 'follow_up' then 1 when 'diagnostic' then 2 else 3 end, sort, code loop
    v_pr := clinic.service_price(s.id, null, null);
    v_amounts := v_amounts || array_remove(array[(v_pr ->> 'price')::numeric, (v_pr ->> 'price_max')::numeric, s.deposit], null);
    select string_agg(clinic.doctor_label(x, 'ar'), '، ') into v_who
      from unnest(s.doctor_ids) x;
    lines := lines || format('[%s] %s%s — %s%s · %s min%s%s%s%s%s%s',
      s.code, s.name_ar, coalesce(' / ' || nullif(s.name_en, ''), ''),
      v_pr ->> 'text_ar', coalesce(' (' || nullif(s.price_note_ar, '') || ')', ''),
      s.duration_min,
      case when s.sessions > 1 then format(' · %s sessions%s', s.sessions, coalesce(', ' || s.session_gap_days || ' days apart', '')) else '' end,
      case when v_who is not null then ' · only ' || v_who
           when s.specialty is not null then ' · ' || coalesce((select name_ar from clinic.specialty_presets where code = s.specialty), s.specialty) || ' doctors'
           else '' end,
      case when cardinality(s.days) > 0 then ' · only on ' || (select string_agg(clinic.day_name(x), '، ') from unnest(s.days) x) else '' end,
      case when s.min_age is not null or s.max_age is not null then format(' · ages %s–%s', coalesce(trim_scale(s.min_age)::text, '0'), coalesce(trim_scale(s.max_age)::text, 'any')) else '' end,
      case when s.needs_consult_first then ' · needs a check-up first' when not s.bookable then ' · NOT booked by you — the team arranges it after the check-up' else '' end,
      coalesce(' · aliases: ' || nullif(array_to_string(s.aliases, '، '), ''), ''));
    if coalesce(s.description_ar, '') <> '' then lines := lines || ('    ' || left(s.description_ar, 300)); end if;
    -- a doctor's or a place's own price
    for r in select sp.*, clinic.doctor_label(sp.doctor_id, 'ar') as dname, clinic.location_label(sp.location_id, 'ar') as lname
               from clinic.service_prices sp where sp.service_id = s.id loop
      v_pr := clinic.service_price(s.id, r.doctor_id, r.location_id);
      v_amounts := v_amounts || array_remove(array[(v_pr ->> 'price')::numeric, (v_pr ->> 'price_max')::numeric], null);
      lines := lines || format('    with %s: %s', concat_ws(' at ', r.dname, r.lname), v_pr ->> 'text_ar');
    end loop;
    v_services := v_services || jsonb_build_object(s.code, jsonb_build_object(
                    'id', s.id, 'name_ar', s.name_ar, 'name_en', s.name_en, 'category', s.category,
                    'duration', s.duration_min, 'price', clinic.service_price(s.id, null, null),
                    'sessions', s.sessions, 'bookable', s.bookable, 'resource_kind', s.resource_kind,
                    'prep_ar', s.prep_ar, 'aftercare_ar', s.aftercare_ar));
  end loop;

  -- offers running now (the snapshot expires when the next one starts or ends) --
  lines := lines || ''::text || 'OFFERS RUNNING NOW'::text;
  for r in select o.* from clinic.offers o where o.tenant_id = p_tenant and clinic.offer_live(o, now(), t.timezone) order by o.sort loop
    lines := lines || format('- %s%s%s%s', r.title_ar,
                             case r.kind when 'percent_off' then ' — ' || clinic.fmt_money(r.value) || '% off'
                                         when 'amount_off' then ' — ' || clinic.fmt_money(r.value) || ' ' || t.currency_symbol_ar || ' off'
                                         when 'fixed_price' then ' — for ' || clinic.fmt_money(r.value) || ' ' || t.currency_symbol_ar
                                         when 'package' then ' — package price ' || clinic.fmt_money(r.value) || ' ' || t.currency_symbol_ar
                                         else ' — free' end,
                             case when cardinality(r.service_ids) > 0 then ' on ' || (select string_agg(x.code || ' ' || x.name_ar, '، ') from clinic.services x where x.id = any(r.service_ids)) else '' end,
                             coalesce(' · until ' || to_char((r.ends_at at time zone t.timezone) - interval '1 second', 'YYYY-MM-DD'), '') || coalesce(' · ' || nullif(r.description_ar, ''), ''));
    v_amounts := v_amounts || r.value;
    -- the price after the offer, for each service it covers
    if r.kind in ('percent_off', 'amount_off') then
      v_amounts := v_amounts || coalesce((select array_agg(case r.kind when 'percent_off' then round(x.price * (100 - r.value) / 100, 2) else x.price - r.value end)
                                            from clinic.services x where x.id = any(r.service_ids) and x.price is not null), '{}');
    end if;
    v_offers := v_offers || jsonb_build_object('id', r.id, 'title_ar', r.title_ar, 'kind', r.kind, 'value', r.value);
  end loop;
  if lines[array_length(lines, 1)] = 'OFFERS RUNNING NOW' then lines := lines || '- none'::text; end if;
  select min(x) into v_until from (
    select starts_at as x from clinic.offers where tenant_id = p_tenant and is_active and starts_at > now()
    union all select ends_at from clinic.offers where tenant_id = p_tenant and is_active and ends_at > now()
    union all select date_trunc('day', now() at time zone t.timezone) at time zone t.timezone + interval '1 day') z;

  -- answers and policies ---------------------------------------------------
  lines := lines || ''::text || 'THE CLINIC''S OWN ANSWERS (use these words'' facts, never invent beyond them)'::text;
  for r in select * from clinic.knowledge_entries where tenant_id = p_tenant and is_active order by sort, topic loop
    lines := lines || format('- %s%s: %s', r.topic,
                             coalesce(' (' || clinic.doctor_label(r.doctor_id, 'ar') || ')', ''),
                             coalesce(nullif(r.content_ar, ''), r.content_en, ''));
  end loop;

  lines := lines || ''::text || 'THE DOCTORS'' RULES FOR YOU'::text;
  for r in select * from clinic.agent_rules where tenant_id = p_tenant and is_active order by sort, created_at loop
    lines := lines || ('- ' || case r.kind
      when 'note' then coalesce(r.text_ar, r.text_en, '')
      when 'new_patients_until' then format('no NEW patients after %s%s (enforced)', r.params ->> 'time',
                                            coalesce(' for ' || clinic.doctor_label(r.doctor_id, 'ar'), ''))
      when 'age_doctor' then format('patients younger than %s years only with %s (enforced)', r.params ->> 'max_age',
                                    coalesce(clinic.doctor_label(r.doctor_id, 'ar'), '?'))
      when 'no_booking_days' then format('no bookings on %s%s (enforced)',
                                         (select string_agg(clinic.day_name(x::int), '، ') from jsonb_array_elements_text(r.params -> 'days') x),
                                         coalesce(' for ' || clinic.doctor_label(r.doctor_id, 'ar'), ''))
      else '' end || coalesce(case when r.kind <> 'note' and coalesce(r.text_ar, '') <> '' then ' — ' || r.text_ar end, ''));
  end loop;

  v_digest := array_to_string(lines, E'\n');
  insert into clinic.catalog_snapshot as cs (tenant_id, digest_text, lookup, version_hash, source_rev, built_at, valid_until)
  values (p_tenant, v_digest,
          jsonb_build_object('services', v_services, 'doctors', v_doctors, 'offers', v_offers,
                             'amounts', coalesce((select jsonb_agg(distinct x) from unnest(v_amounts) x where x is not null), '[]'::jsonb)),
          md5(v_digest), t.catalog_rev, now(), v_until)
  on conflict (tenant_id) do update
    set digest_text = excluded.digest_text, lookup = excluded.lookup, version_hash = excluded.version_hash,
        source_rev = excluded.source_rev, built_at = now(), valid_until = excluded.valid_until;
  return jsonb_build_object('rev', t.catalog_rev, 'chars', length(v_digest));
end $$;

create or replace function clinic.ensure_snapshot(p_tenant uuid)
returns void language plpgsql as $$
begin
  if not exists (select 1 from clinic.catalog_snapshot s join clinic.tenants t on t.id = s.tenant_id
                  where s.tenant_id = p_tenant and s.source_rev >= t.catalog_rev
                    and (s.valid_until is null or s.valid_until > now())) then
    perform clinic.rebuild_snapshot(p_tenant);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Changing the catalogue in words: the doctor's WhatsApp (staff mode),
-- the dashboard assistant, or the editor. A change is shown first
-- (p_apply = false keeps it 'pending' with its before/after), then
-- applied by its id, and can be undone.
--
-- p_changes = [ {op, …}, … ]
--   set_price       service, price?, price_max?, price_kind?, unit?, doctor?, location?
--   add_service     name_ar, name_en?, category?, price?, price_max?, price_kind?, unit?, duration?,
--                   sessions?, session_gap_days?, description_ar?, aliases?, specialty?, doctor?
--   update_service  service, fields {any column}
--   remove_service  service                          (archived; undo brings it back)
--   add_faq / update_faq   topic, content_ar, content_en?
--   remove_faq      topic
--   add_offer       title_ar, kind?, value, services?, ends_at?, starts_at?
--   end_offer       offer (its title)
--   add_rule        text_ar  (or kind + params + doctor?)
--   remove_rule     text (words in it)
-- ---------------------------------------------------------------------
create or replace function clinic.catalog_put(p_table text, p_row jsonb)
returns void language plpgsql security definer set search_path = clinic, pg_temp as $$
declare cols text; ex text;
begin
  if p_table not in ('services', 'service_prices', 'offers', 'knowledge_entries', 'agent_rules') then
    raise exception 'not a catalogue table: %', p_table;
  end if;
  select string_agg(format('%I', a.attname), ', ' order by a.attnum),
         string_agg(format('excluded.%I', a.attname), ', ' order by a.attnum)
    into cols, ex
    from pg_attribute a
   where a.attrelid = ('clinic.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped
     and a.attname not in ('created_at', 'updated_at') and a.attidentity = '' and a.attgenerated = ''
     and (p_row ? a.attname);
  execute format('insert into clinic.%I (%s) select %s from jsonb_populate_record(null::clinic.%I, $1)
                  on conflict (id) do update set (%s) = row(%s)', p_table, cols, cols, p_table, cols, ex)
    using p_row;
end $$;

create or replace function clinic.catalog_change(p_tenant uuid, p_changes jsonb, p_apply boolean default false,
                                                 p_source text default 'dashboard')
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  t        clinic.tenants%rowtype;
  c        jsonb;
  v_op     text;
  v_entries jsonb := '[]'::jsonb;
  v_problems jsonb := '[]'::jsonb;
  v_lines  text[] := '{}';
  s        clinic.services%rowtype;
  k        clinic.knowledge_entries%rowtype;
  o        clinic.offers%rowtype;
  ru       clinic.agent_rules%rowtype;
  sp       clinic.service_prices%rowtype;
  v_sid    uuid;
  v_doc    uuid;
  v_loc    uuid;
  v_before jsonb;
  v_after  jsonb;
  v_id     bigint;
  v_kind   text;
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor']);
  select * into t from clinic.tenants where id = p_tenant;
  if jsonb_typeof(p_changes) = 'object' then p_changes := jsonb_build_array(p_changes); end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    return jsonb_build_object('ok', false, 'error', 'NO_CHANGES', 'fact', 'send changes as a list of {op, …}');
  end if;

  for c in select * from jsonb_array_elements(p_changes) loop
    v_op := lower(coalesce(c ->> 'op', ''));
    v_sid := null; v_doc := null; v_loc := null; v_before := null; v_after := null;
    if nullif(c ->> 'service', '') is not null then
      v_sid := clinic.match_service(p_tenant, c ->> 'service');
    end if;
    if nullif(c ->> 'doctor', '') is not null then v_doc := clinic.match_doctor(p_tenant, c ->> 'doctor'); end if;
    if nullif(c ->> 'location', '') is not null then v_loc := clinic.match_location(p_tenant, c ->> 'location'); end if;

    if v_op in ('set_price', 'update_service', 'remove_service') and v_sid is null then
      v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'SERVICE_NOT_FOUND', 'said', c ->> 'service');
      continue;
    end if;
    if nullif(c ->> 'doctor', '') is not null and v_doc is null then
      v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'DOCTOR_NOT_FOUND', 'said', c ->> 'doctor');
      continue;
    end if;

    if v_op = 'set_price' then
      select * into s from clinic.services where id = v_sid;
      v_kind := coalesce(nullif(c ->> 'price_kind', ''),
                         case when nullif(c ->> 'price_max', '') is not null then 'range'
                              when s.price_kind in ('after_exam', 'free') and nullif(c ->> 'price', '') is not null then 'fixed'
                              else null end);
      if v_doc is null and v_loc is null then
        v_before := to_jsonb(s);
        v_after := v_before || jsonb_strip_nulls(jsonb_build_object(
                     'price', (c ->> 'price')::numeric, 'price_max', (c ->> 'price_max')::numeric,
                     'price_kind', v_kind, 'price_unit', nullif(c ->> 'unit', '')));
        if v_kind is not null and v_kind <> 'range' and c ->> 'price_max' is null then v_after := v_after || '{"price_max": null}'; end if;
        v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'services', 'id', s.id,
                       'label', s.code || ' ' || s.name_ar, 'before', v_before, 'after', v_after);
        v_lines := v_lines || format('%s: %s ← %s', s.name_ar,
                     clinic.price_words(v_after ->> 'price_kind', (v_after ->> 'price')::numeric, (v_after ->> 'price_max')::numeric, v_after ->> 'price_unit', 'ar', t.currency_symbol_ar),
                     clinic.price_words(s.price_kind, s.price, s.price_max, s.price_unit, 'ar', t.currency_symbol_ar));
      else
        select * into sp from clinic.service_prices x
         where x.service_id = v_sid and x.doctor_id is not distinct from v_doc and x.location_id is not distinct from v_loc;
        v_before := case when sp.id is null then null else to_jsonb(sp) end;
        v_after := coalesce(v_before, jsonb_build_object('id', gen_random_uuid(), 'tenant_id', p_tenant, 'service_id', v_sid,
                                                         'doctor_id', v_doc, 'location_id', v_loc))
                   || jsonb_build_object('price', (c ->> 'price')::numeric, 'price_max', (c ->> 'price_max')::numeric,
                                         'price_kind', v_kind);
        v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'service_prices', 'id', v_after ->> 'id',
                       'label', (select code || ' ' || name_ar from clinic.services where id = v_sid), 'before', v_before, 'after', v_after);
        v_lines := v_lines || format('%s (%s): %s', (select name_ar from clinic.services where id = v_sid),
                     concat_ws(' · ', clinic.doctor_label(v_doc, 'ar'), clinic.location_label(v_loc, 'ar')),
                     clinic.price_words(coalesce(v_kind, 'fixed'), (c ->> 'price')::numeric, (c ->> 'price_max')::numeric,
                                        (select price_unit from clinic.services where id = v_sid), 'ar', t.currency_symbol_ar));
      end if;

    elsif v_op = 'add_service' then
      if coalesce(btrim(c ->> 'name_ar'), btrim(c ->> 'name_en'), '') = '' then
        v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'NAME_NEEDED'); continue;
      end if;
      if clinic.match_service(p_tenant, coalesce(c ->> 'name_ar', c ->> 'name_en')) is not null
         and (select clinic.norm(name_ar) from clinic.services where id = clinic.match_service(p_tenant, coalesce(c ->> 'name_ar', c ->> 'name_en')))
             = clinic.norm(coalesce(c ->> 'name_ar', c ->> 'name_en')) then
        v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'ALREADY_EXISTS', 'said', coalesce(c ->> 'name_ar', c ->> 'name_en'),
                                                       'fact', 'a service with this name exists — use set_price or update_service');
        continue;
      end if;
      v_after := jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid(), 'tenant_id', p_tenant,
        'name_ar', coalesce(nullif(btrim(c ->> 'name_ar'), ''), btrim(c ->> 'name_en')),
        'name_en', nullif(btrim(c ->> 'name_en'), ''),
        'category', coalesce(nullif(c ->> 'category', ''), 'procedure'),
        'price', (c ->> 'price')::numeric, 'price_max', (c ->> 'price_max')::numeric,
        'price_kind', coalesce(nullif(c ->> 'price_kind', ''),
                               case when nullif(c ->> 'price_max', '') is not null then 'range'
                                    when nullif(c ->> 'price', '') is null then 'after_exam' else 'fixed' end),
        'price_unit', coalesce(nullif(c ->> 'unit', ''), 'visit'),
        'duration_min', coalesce((c ->> 'duration')::int, 30),
        'sessions', coalesce((c ->> 'sessions')::int, 1),
        'session_gap_days', (c ->> 'session_gap_days')::int,
        'description_ar', nullif(c ->> 'description_ar', ''),
        'specialty', coalesce(nullif(c ->> 'specialty', ''), (select specialty from clinic.doctors where id = v_doc)),
        'aliases', case when jsonb_typeof(c -> 'aliases') = 'array' then c -> 'aliases' end,
        'doctor_ids', case when v_doc is not null then jsonb_build_array(v_doc) end,
        'sort', (select coalesce(max(sort), 0) + 10 from clinic.services where tenant_id = p_tenant)));
      v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'services', 'id', v_after ->> 'id',
                     'label', v_after ->> 'name_ar', 'before', null, 'after', v_after);
      v_lines := v_lines || format('+ %s — %s', v_after ->> 'name_ar',
                   clinic.price_words(v_after ->> 'price_kind', (v_after ->> 'price')::numeric, (v_after ->> 'price_max')::numeric, v_after ->> 'price_unit', 'ar', t.currency_symbol_ar));

    elsif v_op = 'update_service' then
      select * into s from clinic.services where id = v_sid;
      v_before := to_jsonb(s);
      v_after := v_before || (coalesce(c -> 'fields', '{}'::jsonb) - 'id' - 'tenant_id' - 'code' - 'created_at');
      v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'services', 'id', s.id,
                     'label', s.code || ' ' || s.name_ar, 'before', v_before, 'after', v_after);
      v_lines := v_lines || format('%s: %s', s.name_ar, (select string_agg(key, '، ') from jsonb_object_keys(coalesce(c -> 'fields', '{}'::jsonb)) key));

    elsif v_op = 'remove_service' then
      select * into s from clinic.services where id = v_sid;
      v_before := to_jsonb(s);
      v_after := v_before || '{"is_active": false}'::jsonb;
      v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'services', 'id', s.id,
                     'label', s.code || ' ' || s.name_ar, 'before', v_before, 'after', v_after);
      v_lines := v_lines || ('− ' || s.name_ar);

    elsif v_op in ('add_faq', 'update_faq', 'remove_faq') then
      select * into k from clinic.knowledge_entries x
       where x.tenant_id = p_tenant and x.is_active
         and (clinic.norm(x.topic) = clinic.norm(c ->> 'topic')
              or (length(clinic.norm(c ->> 'topic')) >= 3 and clinic.norm(x.topic) like '%' || clinic.norm(c ->> 'topic') || '%'))
       order by (clinic.norm(x.topic) = clinic.norm(c ->> 'topic')) desc limit 1;
      if v_op = 'remove_faq' then
        if k.id is null then v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'ANSWER_NOT_FOUND', 'said', c ->> 'topic'); continue; end if;
        v_before := to_jsonb(k); v_after := v_before || '{"is_active": false}'::jsonb;
        v_lines := v_lines || ('− ' || k.topic);
      elsif k.id is not null then
        v_before := to_jsonb(k);
        v_after := v_before || jsonb_strip_nulls(jsonb_build_object('content_ar', nullif(c ->> 'content_ar', ''), 'content_en', nullif(c ->> 'content_en', '')));
        v_lines := v_lines || format('%s: %s', k.topic, left(coalesce(v_after ->> 'content_ar', ''), 120));
      else
        if coalesce(btrim(c ->> 'topic'), '') = '' then
          v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'TOPIC_NEEDED'); continue;
        end if;
        v_after := jsonb_build_object('id', gen_random_uuid(), 'tenant_id', p_tenant, 'topic', btrim(c ->> 'topic'),
                                      'content_ar', nullif(c ->> 'content_ar', ''), 'content_en', nullif(c ->> 'content_en', ''),
                                      'doctor_id', v_doc);
        v_lines := v_lines || format('+ %s: %s', c ->> 'topic', left(coalesce(c ->> 'content_ar', c ->> 'content_en', ''), 120));
      end if;
      v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'knowledge_entries', 'id', v_after ->> 'id',
                     'label', v_after ->> 'topic', 'before', v_before, 'after', v_after);

    elsif v_op = 'add_offer' then
      v_after := jsonb_strip_nulls(jsonb_build_object(
        'id', gen_random_uuid(), 'tenant_id', p_tenant, 'title_ar', coalesce(nullif(c ->> 'title_ar', ''), c ->> 'title'),
        'kind', coalesce(nullif(c ->> 'kind', ''), 'percent_off'), 'value', coalesce((c ->> 'value')::numeric, 0),
        'description_ar', nullif(c ->> 'description_ar', ''),
        'service_ids', (select jsonb_agg(clinic.match_service(p_tenant, x)) from jsonb_array_elements_text(
                          case jsonb_typeof(c -> 'services') when 'array' then c -> 'services' else '[]'::jsonb end) x
                         where clinic.match_service(p_tenant, x) is not null),
        'starts_at', nullif(c ->> 'starts_at', '')::timestamptz,
        'ends_at', case when nullif(c ->> 'ends_at', '') ~ '^\d{4}-\d{2}-\d{2}$'
                        then ((c ->> 'ends_at')::date + 1)::timestamp at time zone t.timezone
                        else nullif(c ->> 'ends_at', '')::timestamptz end));
      if coalesce(v_after ->> 'title_ar', '') = '' then
        v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'TITLE_NEEDED'); continue;
      end if;
      v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'offers', 'id', v_after ->> 'id',
                     'label', v_after ->> 'title_ar', 'before', null, 'after', v_after);
      v_lines := v_lines || ('+ عرض: ' || (v_after ->> 'title_ar'));

    elsif v_op = 'end_offer' then
      select * into o from clinic.offers x
       where x.tenant_id = p_tenant and x.is_active
         and clinic.norm(x.title_ar) like '%' || clinic.norm(coalesce(c ->> 'offer', c ->> 'title', '')) || '%'
       order by x.created_at desc limit 1;
      if o.id is null then v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'OFFER_NOT_FOUND', 'said', coalesce(c ->> 'offer', c ->> 'title')); continue; end if;
      v_before := to_jsonb(o); v_after := v_before || '{"is_active": false}'::jsonb;
      v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'offers', 'id', o.id, 'label', o.title_ar, 'before', v_before, 'after', v_after);
      v_lines := v_lines || ('− عرض: ' || o.title_ar);

    elsif v_op = 'add_rule' then
      v_after := jsonb_strip_nulls(jsonb_build_object('id', gen_random_uuid(), 'tenant_id', p_tenant,
                   'kind', coalesce(nullif(c ->> 'kind', ''), 'note'), 'doctor_id', v_doc,
                   'params', coalesce(c -> 'params', '{}'::jsonb), 'text_ar', nullif(c ->> 'text_ar', ''), 'text_en', nullif(c ->> 'text_en', '')));
      if v_after ->> 'kind' = 'note' and coalesce(v_after ->> 'text_ar', v_after ->> 'text_en', '') = '' then
        v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'TEXT_NEEDED'); continue;
      end if;
      v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'agent_rules', 'id', v_after ->> 'id',
                     'label', coalesce(v_after ->> 'text_ar', v_after ->> 'kind'), 'before', null, 'after', v_after);
      v_lines := v_lines || ('+ قاعدة: ' || coalesce(v_after ->> 'text_ar', v_after ->> 'kind'));

    elsif v_op = 'remove_rule' then
      select * into ru from clinic.agent_rules x
       where x.tenant_id = p_tenant and x.is_active
         and clinic.norm(coalesce(x.text_ar, x.text_en, '')) like '%' || clinic.norm(coalesce(c ->> 'text', c ->> 'text_ar', '')) || '%'
       order by x.created_at desc limit 1;
      if ru.id is null then v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'RULE_NOT_FOUND', 'said', c ->> 'text'); continue; end if;
      v_before := to_jsonb(ru); v_after := v_before || '{"is_active": false}'::jsonb;
      v_entries := v_entries || jsonb_build_object('op', v_op, 'table', 'agent_rules', 'id', ru.id, 'label', coalesce(ru.text_ar, ru.kind), 'before', v_before, 'after', v_after);
      v_lines := v_lines || ('− قاعدة: ' || coalesce(ru.text_ar, ru.kind));
    else
      v_problems := v_problems || jsonb_build_object('op', v_op, 'problem', 'UNKNOWN_OP',
        'fact', 'op is one of set_price, add_service, update_service, remove_service, add_faq, update_faq, remove_faq, add_offer, end_offer, add_rule, remove_rule');
    end if;
  end loop;

  if jsonb_array_length(v_entries) = 0 then
    return jsonb_build_object('ok', false, 'error', 'NOTHING_TO_CHANGE', 'problems', v_problems);
  end if;

  insert into clinic.catalog_changes (tenant_id, source, request, entries, summary_ar, created_by, created_by_name)
  values (p_tenant, coalesce(p_source, 'dashboard'), p_changes, v_entries, array_to_string(v_lines, E'\n'),
          clinic.current_user_id(), clinic.my_name(p_tenant))
  returning id into v_id;

  if p_apply then
    return clinic.catalog_apply(v_id) || jsonb_build_object('problems', v_problems);
  end if;
  return jsonb_build_object('ok', true, 'status', 'PREVIEW', 'change_id', v_id, 'summary_ar', array_to_string(v_lines, E'\n'),
                            'entries', v_entries, 'problems', v_problems,
                            'fact', 'shown, not applied: apply it with the change_id once the doctor agrees');
end $$;

create or replace function clinic.catalog_apply(p_change bigint)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  ch clinic.catalog_changes%rowtype;
  e  jsonb;
begin
  select * into ch from clinic.catalog_changes where id = p_change for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'CHANGE_NOT_FOUND'); end if;
  perform clinic.require_role(ch.tenant_id, array['owner', 'manager', 'doctor']);
  if ch.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_' || upper(ch.status), 'change_id', ch.id);
  end if;
  for e in select * from jsonb_array_elements(ch.entries) loop
    perform clinic.catalog_put(e ->> 'table', e -> 'after');
  end loop;
  update clinic.catalog_changes set status = 'applied', applied_at = now() where id = ch.id;
  insert into clinic.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
  values (ch.tenant_id, clinic.current_user_id(), 'catalog_change', 'catalog_changes', ch.id::text,
          jsonb_build_object('source', ch.source, 'summary', ch.summary_ar));
  return jsonb_build_object('ok', true, 'status', 'APPLIED', 'change_id', ch.id, 'summary_ar', ch.summary_ar,
                            'fact', 'saved — the agent uses it from the next message');
end $$;

create or replace function clinic.catalog_undo(p_change bigint)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  ch clinic.catalog_changes%rowtype;
  e  jsonb;
begin
  select * into ch from clinic.catalog_changes where id = p_change for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'CHANGE_NOT_FOUND'); end if;
  perform clinic.require_role(ch.tenant_id, array['owner', 'manager', 'doctor']);
  if ch.status = 'pending' then
    update clinic.catalog_changes set status = 'discarded' where id = ch.id;
    return jsonb_build_object('ok', true, 'status', 'DISCARDED', 'change_id', ch.id);
  end if;
  if ch.status <> 'applied' then return jsonb_build_object('ok', false, 'error', 'ALREADY_' || upper(ch.status)); end if;
  for e in select x from jsonb_array_elements(ch.entries) with ordinality as a(x, n) order by n desc loop
    if e -> 'before' is null or jsonb_typeof(e -> 'before') = 'null' then
      execute format('delete from clinic.%I where id = $1', e ->> 'table') using (e ->> 'id')::uuid;
    else
      perform clinic.catalog_put(e ->> 'table', e -> 'before');
    end if;
  end loop;
  update clinic.catalog_changes set status = 'undone', undone_at = now() where id = ch.id;
  return jsonb_build_object('ok', true, 'status', 'UNDONE', 'change_id', ch.id, 'summary_ar', ch.summary_ar);
end $$;
