-- =====================================================================
-- Everwake Clinic · 005 · appointments
--
--   appointments        held → booked → confirmed → arrived → in_visit
--                       → done | no_show | cancelled. A `slot` booking is
--                       a fixed time; a `queue` booking is a number in a
--                       session (الدور) with an estimated time.
--                       Two exclusion constraints make double booking
--                       impossible: one doctor, one time — and one chair
--                       (or room, or laser), one time.
--   appointment_events  every step, by whom
--   booking_drafts      the booking a WhatsApp chat is putting together
--   waitlist            people who want an earlier time
--
--   doctor_sessions()   the sessions on given days: schedules, then the
--                       day's exceptions (off · changed · extra)
--   available_slots()   the one place free times are worked out — the
--                       agent, the dashboard and the checks all use it
--   book_appointment()  the one place an appointment is made or held
--   booking_tool()      the agent's tool (find_slots · update · summary ·
--                       book · cancel · reschedule · confirm ·
--                       accept_delay · status · join_waitlist · take_offer
--                       · next_plan_session · accept_plan)
-- =====================================================================

create table clinic.appointments (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references clinic.tenants(id) on delete cascade,
  ref_no             text,
  doctor_id          uuid not null references clinic.doctors(id) on delete restrict,
  location_id        uuid not null references clinic.locations(id) on delete restrict,
  resource_id        uuid references clinic.resources(id) on delete set null,
  service_id         uuid references clinic.services(id) on delete set null,
  patient_id         bigint references clinic.patients(id) on delete set null,
  contact_id         bigint references clinic.contacts(id) on delete set null,
  wa_id              text,
  conversation_id    bigint references clinic.conversations(id) on delete set null,
  status             text not null default 'booked'
                     check (status in ('held', 'booked', 'confirmed', 'arrived', 'in_visit', 'done', 'no_show', 'cancelled')),
  source             text not null default 'dashboard' check (source in ('whatsapp', 'dashboard', 'phone', 'walk_in', 'web', 'plan')),
  mode               text not null default 'slot' check (mode in ('slot', 'queue')),
  session_date       date not null,
  starts_at          timestamptz not null,   -- slot: the visit · queue: when the session starts
  ends_at            timestamptz not null,   -- slot: the visit's end · queue: when the session ends
  queue_no           int,
  est_at             timestamptz,            -- when they will likely go in (slot: = starts_at)
  original_starts_at timestamptz,            -- before any delay or move
  delay_minutes      int not null default 0,
  reason             text,                   -- in the patient's own words
  urgency            text not null default 'routine' check (urgency in ('routine', 'soon', 'urgent', 'emergency')),
  is_new_patient     boolean not null default false,
  is_follow_up       boolean not null default false,
  price              numeric(12, 2),
  price_max          numeric(12, 2),
  price_kind         text,
  price_text         text,
  plan_item_id       bigint references clinic.treatment_plan_items(id) on delete set null,
  hold_expires_at    timestamptz,
  confirmed_at       timestamptz,
  arrived_at         timestamptz,
  visit_started_at   timestamptz,
  visit_ended_at     timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text,
  cancelled_by       text check (cancelled_by in ('patient', 'clinic', 'system')),
  at_risk_alerted_at timestamptz,
  manage_token       text not null unique default clinic.random_token(),
  payment_status     text not null default 'none' check (payment_status in ('none', 'pending', 'paid', 'refunded')),
  staff_notes        text,
  pre_visit          jsonb not null default '{}'::jsonb,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, ref_no),
  check (ends_at > starts_at),
  constraint appointments_doctor_free exclude using gist
    (doctor_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
    where (mode = 'slot' and status in ('held', 'booked', 'confirmed', 'arrived', 'in_visit'))
    deferrable initially immediate,
  constraint appointments_resource_free exclude using gist
    (resource_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
    where (resource_id is not null and mode = 'slot' and status in ('held', 'booked', 'confirmed', 'arrived', 'in_visit'))
    deferrable initially immediate
);
create unique index appointments_queue_uidx on clinic.appointments (doctor_id, location_id, session_date, queue_no)
  where queue_no is not null and status in ('held', 'booked', 'confirmed', 'arrived', 'in_visit');
create index appointments_day_idx on clinic.appointments (tenant_id, session_date, doctor_id);
create index appointments_patient_idx on clinic.appointments (patient_id, starts_at desc);
create index appointments_wa_idx on clinic.appointments (tenant_id, wa_id, starts_at desc);

alter table clinic.encounters add constraint encounters_appointment_fk
  foreign key (appointment_id) references clinic.appointments(id) on delete set null;
alter table clinic.documents add constraint documents_appointment_fk
  foreign key (appointment_id) references clinic.appointments(id) on delete set null;

create table clinic.appointment_events (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references clinic.tenants(id) on delete cascade,
  appointment_id bigint not null references clinic.appointments(id) on delete cascade,
  kind           text not null,
  detail         jsonb not null default '{}'::jsonb,
  by_user        uuid,
  by_role        text not null default 'staff' check (by_role in ('agent', 'staff', 'system', 'patient')),
  created_at     timestamptz not null default now()
);
create index appointment_events_appt_idx on clinic.appointment_events (appointment_id, created_at);

create table clinic.booking_drafts (
  tenant_id   uuid not null references clinic.tenants(id) on delete cascade,
  wa_id       text not null,
  data        jsonb not null default '{}'::jsonb,   -- {patient{…}, doctor_id, location_id, service_id, reason, urgency, slot{…}, last_offered[…]}
  hold_id     bigint references clinic.appointments(id) on delete set null,
  changed_at  timestamptz not null default clock_timestamp(),
  summary_at  timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, wa_id)
);

create table clinic.waitlist (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references clinic.tenants(id) on delete cascade,
  patient_id    bigint references clinic.patients(id) on delete cascade,
  contact_id    bigint references clinic.contacts(id) on delete cascade,
  wa_id         text,
  doctor_id     uuid references clinic.doctors(id) on delete cascade,
  location_id   uuid references clinic.locations(id) on delete cascade,
  service_id    uuid references clinic.services(id) on delete set null,
  appointment_id bigint references clinic.appointments(id) on delete set null,  -- the later one they hold now
  from_date     date not null default current_date,
  to_date       date,
  band          text not null default 'any' check (band in ('any', 'morning', 'afternoon', 'evening')),
  status        text not null default 'waiting' check (status in ('waiting', 'offered', 'booked', 'expired', 'cancelled')),
  offered_slot  jsonb,
  offered_at    timestamptz,
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index waitlist_tenant_idx on clinic.waitlist (tenant_id, status, doctor_id);

create trigger appointments_touch before update on clinic.appointments for each row execute function clinic.touch_updated_at();
create trigger appointments_audit after insert or update or delete on clinic.appointments for each row execute function clinic.audit_change();

-- ---------------------------------------------------------------------
-- Time
-- ---------------------------------------------------------------------
create or replace function clinic.tenant_tz(p_tenant uuid)
returns text language sql stable as $$
  select coalesce((select timezone from clinic.tenants where id = p_tenant), 'Africa/Cairo')
$$;

create or replace function clinic.local_today(p_tenant uuid)
returns date language sql stable as $$
  select (now() at time zone clinic.tenant_tz(p_tenant))::date
$$;

create or replace function clinic.band_of(p_local time)
returns text language sql immutable as $$
  select case when p_local < '12:00' then 'morning' when p_local < '17:00' then 'afternoon' else 'evening' end
$$;

-- "السبت 15/11 الساعة 5:30 م" · with relative words for today and tomorrow when asked
create or replace function clinic.when_words(p_at timestamptz, p_tz text, p_lang text default 'ar', p_relative boolean default false)
returns text language sql stable as $$
  with x as (select (p_at at time zone p_tz) as l, (now() at time zone p_tz)::date as today)
  select case
    when p_lang = 'en' then
      case when p_relative and x.l::date = x.today then 'today'
           when p_relative and x.l::date = x.today + 1 then 'tomorrow (' || clinic.day_name(extract(dow from x.l)::int, 'en') || ' ' || to_char(x.l, 'DD/MM') || ')'
           else clinic.day_name(extract(dow from x.l)::int, 'en') || ' ' || to_char(x.l, 'DD/MM') end
      || ' at ' || clinic.clock_text(x.l::time, 'en')
    else
      case when p_relative and x.l::date = x.today then 'النهارده'
           when p_relative and x.l::date = x.today + 1 then 'بكره ' || clinic.day_name(extract(dow from x.l)::int, 'ar') || ' ' || to_char(x.l, 'DD/MM')
           else clinic.day_name(extract(dow from x.l)::int, 'ar') || ' ' || to_char(x.l, 'DD/MM') end
      || ' الساعة ' || clinic.clock_text(x.l::time, 'ar') end
  from x
$$;

create or replace function clinic.appt_when(a clinic.appointments, p_lang text default 'ar', p_relative boolean default false)
returns text language plpgsql stable as $$
declare tz text := clinic.tenant_tz(a.tenant_id);
begin
  if a.mode = 'queue' then
    return case when p_lang = 'en'
      then clinic.when_words(a.starts_at, tz, 'en', p_relative) || ' session — queue number ' || a.queue_no
           || coalesce(', about ' || clinic.clock_text((coalesce(a.est_at, a.starts_at) at time zone tz)::time, 'en'), '')
      else replace(clinic.when_words(a.starts_at, tz, 'ar', p_relative), ' الساعة ', ' — بداية الكشف ')
           || '، دور رقم ' || a.queue_no
           || coalesce('، حوالي ' || clinic.clock_text((coalesce(a.est_at, a.starts_at) at time zone tz)::time, 'ar'), '') end;
  end if;
  return clinic.when_words(a.starts_at, tz, p_lang, p_relative);
end $$;

create or replace function clinic.manage_link(a clinic.appointments)
returns text language sql stable as $$
  select case when coalesce(clinic.merged_settings(t.settings) ->> 'public_url', '') <> ''
              then rtrim(clinic.merged_settings(t.settings) ->> 'public_url', '/') || '/a/' || a.manage_token end
    from clinic.tenants t where t.id = a.tenant_id
$$;

create or replace function clinic.appointment_view(a clinic.appointments, p_lang text default 'ar')
returns jsonb language plpgsql stable as $$
declare tz text := clinic.tenant_tz(a.tenant_id);
begin
  return jsonb_build_object(
    'id', a.id, 'ref_no', a.ref_no, 'status', a.status, 'mode', a.mode,
    'doctor_id', a.doctor_id, 'doctor', clinic.doctor_label(a.doctor_id, p_lang),
    'location_id', a.location_id, 'location', clinic.location_label(a.location_id, p_lang),
    'service_id', a.service_id, 'service', (select case when p_lang = 'en' then coalesce(s.name_en, s.name_ar) else s.name_ar end from clinic.services s where s.id = a.service_id),
    'patient_id', a.patient_id, 'patient', (select full_name from clinic.patients where id = a.patient_id),
    'starts_at', a.starts_at, 'ends_at', a.ends_at, 'est_at', a.est_at, 'queue_no', a.queue_no,
    'date', a.session_date, 'day', clinic.day_name(extract(dow from a.session_date)::int, p_lang),
    'time', to_char(coalesce(a.est_at, a.starts_at) at time zone tz, 'HH24:MI'),
    'when', clinic.appt_when(a, p_lang, false),
    'price_text', a.price_text, 'price', a.price, 'is_follow_up', a.is_follow_up,
    'delay_minutes', a.delay_minutes, 'original_time', case when a.original_starts_at is not null
                                                       then to_char(a.original_starts_at at time zone tz, 'HH24:MI') end,
    'hold_expires_at', a.hold_expires_at, 'link', clinic.manage_link(a));
end $$;

create or replace function clinic.log_appt(p_appt bigint, p_kind text, p_detail jsonb default '{}'::jsonb, p_role text default null)
returns void language sql as $$
  insert into clinic.appointment_events (tenant_id, appointment_id, kind, detail, by_user, by_role)
  select a.tenant_id, a.id, p_kind, coalesce(p_detail, '{}'::jsonb), clinic.current_user_id(),
         coalesce(p_role, case when clinic.current_user_id() is null then 'system' else 'staff' end)
    from clinic.appointments a where a.id = p_appt
$$;

-- ---------------------------------------------------------------------
-- Sessions on given days: the schedules, then each day's exceptions
-- ---------------------------------------------------------------------
create or replace function clinic.doctor_sessions(p_tenant uuid, p_from date, p_to date,
                                                  p_doctor uuid default null, p_location uuid default null)
returns table (doctor_id uuid, location_id uuid, schedule_id uuid, session_date date, starts_at timestamptz,
               ends_at timestamptz, mode text, slot_minutes int, capacity int, online boolean)
language plpgsql stable as $$
declare
  tz text := clinic.tenant_tz(p_tenant);
  d  date;
  sc record;
  ex record;
  v_start time; v_end time;
begin
  if p_to < p_from or p_to - p_from > 120 then return; end if;
  d := p_from;
  while d <= p_to loop
    -- regular sessions, unless a whole-day 'off' or a 'changed' replaces them
    for sc in
      select s.* from clinic.schedules s join clinic.doctors dr on dr.id = s.doctor_id
       where s.tenant_id = p_tenant and s.is_active and dr.is_active
         and (p_doctor is null or s.doctor_id = p_doctor)
         and (p_location is null or s.location_id = p_location)
         and s.weekday = extract(dow from d)::int
         and (s.valid_from is null or s.valid_from <= d) and (s.valid_to is null or s.valid_to >= d)
    loop
      if exists (select 1 from clinic.schedule_exceptions e
                  where e.doctor_id = sc.doctor_id and e.on_date = d and e.kind in ('off', 'changed')
                    and (e.location_id is null or e.location_id = sc.location_id)
                    and (e.kind = 'changed' or e.start_time is null)) then
        continue;
      end if;
      v_start := sc.start_time; v_end := sc.end_time;
      -- part of the day off: keep what is left before it (and after it, as a second piece)
      select * into ex from clinic.schedule_exceptions e
       where e.doctor_id = sc.doctor_id and e.on_date = d and e.kind = 'off' and e.start_time is not null
         and (e.location_id is null or e.location_id = sc.location_id)
         and e.start_time < case when v_end <= v_start then '24:00'::time else v_end end and e.end_time > v_start
       limit 1;
      if ex.id is not null then
        if ex.start_time > v_start then
          doctor_id := sc.doctor_id; location_id := sc.location_id; schedule_id := sc.id; session_date := d;
          starts_at := (d + v_start) at time zone tz; ends_at := (d + ex.start_time) at time zone tz;
          mode := sc.mode; slot_minutes := sc.slot_minutes; capacity := sc.capacity; online := sc.online_booking;
          return next;
        end if;
        if ex.end_time < (case when v_end <= v_start then '24:00'::time else v_end end) then
          doctor_id := sc.doctor_id; location_id := sc.location_id; schedule_id := sc.id; session_date := d;
          starts_at := (d + ex.end_time) at time zone tz;
          ends_at := (d + v_end + case when v_end <= v_start then interval '1 day' else interval '0' end) at time zone tz;
          mode := sc.mode; slot_minutes := sc.slot_minutes; capacity := sc.capacity; online := sc.online_booking;
          return next;
        end if;
        ex := null;
        continue;
      end if;
      doctor_id := sc.doctor_id; location_id := sc.location_id; schedule_id := sc.id; session_date := d;
      starts_at := (d + v_start) at time zone tz;
      ends_at := (d + v_end + case when v_end <= v_start then interval '1 day' else interval '0' end) at time zone tz;
      mode := sc.mode; slot_minutes := sc.slot_minutes; capacity := sc.capacity; online := sc.online_booking;
      return next;
    end loop;
    -- changed hours and extra sessions
    for ex in
      select e.*, (select s2.mode from clinic.schedules s2 where s2.doctor_id = e.doctor_id and s2.is_active
                    and (e.location_id is null or s2.location_id = e.location_id) order by s2.created_at limit 1) as base_mode,
             (select s2.slot_minutes from clinic.schedules s2 where s2.doctor_id = e.doctor_id and s2.is_active
                    and (e.location_id is null or s2.location_id = e.location_id) order by s2.created_at limit 1) as base_slot,
             coalesce(e.location_id, (select s2.location_id from clinic.schedules s2 where s2.doctor_id = e.doctor_id and s2.is_active
                                       order by s2.created_at limit 1)) as loc
        from clinic.schedule_exceptions e join clinic.doctors dr on dr.id = e.doctor_id and dr.is_active
       where e.tenant_id = p_tenant and e.on_date = d and e.kind in ('changed', 'extra')
         and e.start_time is not null and e.end_time is not null
         and (p_doctor is null or e.doctor_id = p_doctor)
         and (p_location is null or coalesce(e.location_id, p_location) = p_location)
    loop
      if ex.loc is null then continue; end if;
      doctor_id := ex.doctor_id; location_id := ex.loc; schedule_id := null; session_date := d;
      starts_at := (d + ex.start_time) at time zone tz;
      ends_at := (d + ex.end_time + case when ex.end_time <= ex.start_time then interval '1 day' else interval '0' end) at time zone tz;
      mode := coalesce(ex.mode, ex.base_mode, 'slots'); slot_minutes := coalesce(ex.slot_minutes, ex.base_slot, 15);
      capacity := ex.capacity; online := true;
      return next;
    end loop;
    d := d + 1;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Price for a booking: a consultation inside the doctor's follow-up
-- window becomes the follow-up (إعادة / استشارة)
-- ---------------------------------------------------------------------
create or replace function clinic.booking_price(p_service uuid, p_doctor uuid, p_location uuid, p_patient bigint default null)
returns jsonb language plpgsql stable as $$
declare
  s     clinic.services%rowtype;
  d     clinic.doctors%rowtype;
  v_fu  uuid;
  v_last timestamptz;
  v_pr  jsonb;
begin
  select * into s from clinic.services where id = p_service;
  select * into d from clinic.doctors where id = p_doctor;
  if p_patient is not null and s.category = 'consultation' then
    select max(a.starts_at) into v_last from clinic.appointments a
     where a.patient_id = p_patient and a.doctor_id = p_doctor and a.status = 'done';
    if v_last is not null and v_last > now() - make_interval(days => d.follow_up_days) then
      select x.id into v_fu from clinic.services x
       where x.tenant_id = s.tenant_id and x.is_active and x.category = 'follow_up'
         and clinic.service_offered(x.id, p_doctor, p_location)
       order by x.sort limit 1;
      if v_fu is not null then
        v_pr := clinic.service_price(v_fu, p_doctor, p_location);
        return v_pr || jsonb_build_object('service_id', v_fu, 'is_follow_up', true, 'last_visit', v_last,
                                          'follow_up_until', (v_last + make_interval(days => d.follow_up_days))::date);
      end if;
    end if;
  end if;
  return clinic.service_price(p_service, p_doctor, p_location) || jsonb_build_object('service_id', p_service, 'is_follow_up', false);
end $$;

-- the doctor's usual first visit
create or replace function clinic.default_service(p_doctor uuid, p_follow_up boolean default false)
returns uuid language sql stable as $$
  select s.id from clinic.services s join clinic.doctors d on d.id = p_doctor and d.tenant_id = s.tenant_id
   where s.is_active and s.bookable and s.category = case when p_follow_up then 'follow_up' else 'consultation' end
     and clinic.service_offered(s.id, p_doctor)
   order by s.sort, s.code limit 1
$$;

-- ---------------------------------------------------------------------
-- Free times
-- p = {doctor_id?, location_id?, service_id?, patient_id?, from?, to?,
--      band?, after?, time_from?, time_to?, limit?, staff?, ignore_appointment?}
-- ---------------------------------------------------------------------
create or replace function clinic.available_slots(p_tenant uuid, p jsonb)
returns jsonb language plpgsql stable as $$
declare
  t         clinic.tenants%rowtype;
  st        jsonb;
  tz        text;
  v_staff   boolean := coalesce((p ->> 'staff')::boolean, false);
  v_doctor  uuid := nullif(p ->> 'doctor_id', '')::uuid;
  v_loc     uuid := nullif(p ->> 'location_id', '')::uuid;
  v_service uuid := nullif(p ->> 'service_id', '')::uuid;
  v_patient bigint := nullif(p ->> 'patient_id', '')::bigint;
  v_ignore  bigint := nullif(p ->> 'ignore_appointment', '')::bigint;
  v_band    text := coalesce(nullif(p ->> 'band', ''), 'any');
  v_after   timestamptz := nullif(p ->> 'after', '')::timestamptz;
  v_tfrom   time := nullif(p ->> 'time_from', '')::time;
  v_tto     time := nullif(p ->> 'time_to', '')::time;
  v_limit   int := least(coalesce((p ->> 'limit')::int, 40), 200);
  v_today   date;
  v_from    date;
  v_to      date;
  v_earliest timestamptz;
  s         clinic.services%rowtype;
  v_age     numeric;
  v_dur     int;
  ses       record;
  v_t       timestamptz;
  v_end     timestamptz;
  v_local   timestamp;
  v_res     uuid;
  v_new     boolean;
  v_count   int;
  v_queue   int;
  v_cap     int;
  v_est     timestamptz;
  v_delay   int;
  out_slots jsonb := '[]'::jsonb;
  n         int := 0;
  v_reasons text[] := '{}';
  v_qmin    int;
  v_day_n   int;
  v_days    date[] := '{}';
  v_sugg    jsonb := '[]'::jsonb;
  v_last    timestamptz;
  x         jsonb;
begin
  select * into t from clinic.tenants where id = p_tenant;
  st := clinic.merged_settings(t.settings);
  tz := t.timezone;
  v_today := (now() at time zone tz)::date;
  v_qmin := coalesce((st -> 'booking' ->> 'queue_minutes')::int, 15);
  v_from := greatest(coalesce(nullif(p ->> 'from', '')::date, v_today), v_today);
  v_to := least(coalesce(nullif(p ->> 'to', '')::date, v_from + 13),
                v_today + case when v_staff then 365 else coalesce((st -> 'booking' ->> 'days_ahead')::int, 45) end);
  if v_to < v_from then
    return jsonb_build_object('slots', '[]'::jsonb, 'suggested', '[]'::jsonb, 'count', 0,
                              'none_because', jsonb_build_array('TOO_FAR_AHEAD'), 'days_ahead', st -> 'booking' -> 'days_ahead');
  end if;
  v_earliest := now() + case when v_staff then interval '0' else make_interval(mins => coalesce((st -> 'booking' ->> 'lead_minutes')::int, 60)) end;
  if v_after is not null and v_after > v_earliest then v_earliest := v_after; end if;

  if v_service is not null then select * into s from clinic.services where id = v_service and tenant_id = p_tenant; end if;
  if v_patient is not null then
    select clinic.age_years(birth_date) into v_age from clinic.patients where id = v_patient;
  elsif nullif(p ->> 'age', '') is not null then
    v_age := clinic.age_years((select b.birth_date from clinic.parse_birth(p ->> 'age') b));
  end if;
  if s.id is not null and v_age is not null and ((s.min_age is not null and v_age < s.min_age) or (s.max_age is not null and v_age > s.max_age)) then
    return jsonb_build_object('slots', '[]'::jsonb, 'suggested', '[]'::jsonb, 'count', 0, 'none_because', jsonb_build_array('AGE_NOT_SERVED'),
                              'ages', jsonb_build_object('min', s.min_age, 'max', s.max_age));
  end if;

  for ses in
    select x.*, d.accepts_new, d.specialty
      from clinic.doctor_sessions(p_tenant, v_from, v_to, v_doctor, v_loc) x
      join clinic.doctors d on d.id = x.doctor_id
     order by x.starts_at
  loop
    exit when n >= v_limit;
    if not v_staff and not ses.online then v_reasons := v_reasons || 'NOT_BOOKABLE_ONLINE'::text; continue; end if;
    if s.id is not null then
      if not clinic.service_offered(s.id, ses.doctor_id, ses.location_id) then continue; end if;
      if cardinality(s.days) > 0 and not (extract(dow from ses.session_date)::smallint = any(s.days)) then
        v_reasons := v_reasons || 'SERVICE_NOT_THAT_DAY'::text; continue;
      end if;
    end if;
    -- the doctors' rules, enforced here (the staff may book anything)
    if not v_staff then
      if exists (select 1 from clinic.agent_rules r where r.tenant_id = p_tenant and r.is_active and r.kind = 'no_booking_days'
                  and (r.doctor_id is null or r.doctor_id = ses.doctor_id)
                  and r.params -> 'days' @> to_jsonb(extract(dow from ses.session_date)::int)) then
        v_reasons := v_reasons || 'RULE_NO_BOOKING_DAY'::text; continue;
      end if;
      if v_age is not null and exists (select 1 from clinic.agent_rules r where r.tenant_id = p_tenant and r.is_active and r.kind = 'age_doctor'
                  and v_age < (r.params ->> 'max_age')::numeric and r.doctor_id is distinct from ses.doctor_id) then
        v_reasons := v_reasons || 'RULE_AGE_DOCTOR'::text; continue;
      end if;
      v_new := v_patient is null or not exists (select 1 from clinic.appointments a where a.patient_id = v_patient
                                                  and a.doctor_id = ses.doctor_id and a.status = 'done');
      if v_new and not ses.accepts_new then v_reasons := v_reasons || 'NOT_TAKING_NEW_PATIENTS'::text; continue; end if;
    else
      v_new := false;
    end if;

    -- a delay announced for this session: nothing new inside the late minutes
    select coalesce(sum(dn.minutes), 0) into v_delay from clinic.delay_notices dn
     where dn.doctor_id = ses.doctor_id and dn.session_date = ses.session_date and dn.kind = 'delay' and dn.status = 'sent'
       and (dn.location_id is null or dn.location_id = ses.location_id);

    v_dur := coalesce(case when s.id is not null then s.duration_min end, ses.slot_minutes);

    -- fixed times ------------------------------------------------------------
    if ses.mode in ('slots', 'both') then
      -- a late doctor shifts the whole grid
      v_t := ses.starts_at + make_interval(mins => v_delay);
      while v_t + make_interval(mins => v_dur) <= ses.ends_at + make_interval(mins => v_delay) and n < v_limit loop
        v_end := v_t + make_interval(mins => v_dur);
        v_local := v_t at time zone tz;
        if v_t >= v_earliest
           and (v_band = 'any' or clinic.band_of(v_local::time) = v_band)
           and (v_tfrom is null or v_local::time >= v_tfrom)
           and (v_tto is null or v_local::time <= v_tto)
           and not (v_new and not v_staff and exists (
                 select 1 from clinic.agent_rules r where r.tenant_id = p_tenant and r.is_active and r.kind = 'new_patients_until'
                    and (r.doctor_id is null or r.doctor_id = ses.doctor_id) and v_local::time > (r.params ->> 'time')::time))
           and not exists (select 1 from clinic.appointments a
                            where a.doctor_id = ses.doctor_id and a.mode = 'slot'
                              and a.status in ('held', 'booked', 'confirmed', 'arrived', 'in_visit')
                              and (a.status <> 'held' or a.hold_expires_at > now())
                              and a.id is distinct from v_ignore
                              and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(v_t, v_end, '[)')) then
          v_res := null;
          if s.resource_kind is not null then
            select r.id into v_res from clinic.resources r
             where r.location_id = ses.location_id and r.kind = s.resource_kind and r.is_active
               and not exists (select 1 from clinic.appointments a
                                where a.resource_id = r.id and a.mode = 'slot'
                                  and a.status in ('held', 'booked', 'confirmed', 'arrived', 'in_visit')
                                  and (a.status <> 'held' or a.hold_expires_at > now())
                                  and a.id is distinct from v_ignore
                                  and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(v_t, v_end, '[)'))
             order by r.sort limit 1;
          end if;
          if s.resource_kind is null or v_res is not null then
            out_slots := out_slots || jsonb_build_object(
              'kind', 'slot', 'doctor_id', ses.doctor_id, 'doctor', clinic.doctor_label(ses.doctor_id, 'ar'),
              'location_id', ses.location_id, 'location', clinic.location_label(ses.location_id, 'ar'),
              'resource_id', v_res, 'starts_at', v_t, 'ends_at', v_end, 'date', v_local::date,
              'time', to_char(v_local, 'HH24:MI'), 'band', clinic.band_of(v_local::time),
              'label_ar', clinic.when_words(v_t, tz, 'ar'), 'label_en', clinic.when_words(v_t, tz, 'en'));
            n := n + 1;
          elsif s.resource_kind is not null then
            v_reasons := v_reasons || 'NO_FREE_CHAIR'::text;
          end if;
        end if;
        v_t := v_t + make_interval(mins => ses.slot_minutes);
      end loop;
    end if;

    -- a queue number -----------------------------------------------------------
    if ses.mode in ('queue', 'both') and n < v_limit then
      select count(*), coalesce(max(a.queue_no), 0) into v_count, v_queue
        from clinic.appointments a
       where a.doctor_id = ses.doctor_id and a.location_id = ses.location_id and a.session_date = ses.session_date
         and a.mode = 'queue' and a.status in ('held', 'booked', 'confirmed', 'arrived', 'in_visit', 'done')
         and (a.status <> 'held' or a.hold_expires_at > now()) and a.id is distinct from v_ignore;
      v_cap := ses.capacity;
      v_est := ses.starts_at + make_interval(mins => v_delay + v_count * v_qmin);
      v_local := v_est at time zone tz;
      if (v_cap is null or v_count < v_cap)
         and ses.ends_at > v_earliest
         and (v_after is null or ses.starts_at >= v_after)      -- "a later one": the next session, not this one again
         and v_est < ses.ends_at + make_interval(mins => v_delay)
         and (v_band = 'any' or clinic.band_of((ses.starts_at at time zone tz)::time) = v_band)
         and (v_tfrom is null or v_local::time >= v_tfrom or (ses.ends_at at time zone tz)::time >= v_tfrom)
         and (v_tto is null or (ses.starts_at at time zone tz)::time <= v_tto) then
        out_slots := out_slots || jsonb_build_object(
          'kind', 'queue', 'doctor_id', ses.doctor_id, 'doctor', clinic.doctor_label(ses.doctor_id, 'ar'),
          'location_id', ses.location_id, 'location', clinic.location_label(ses.location_id, 'ar'),
          'starts_at', ses.starts_at, 'ends_at', ses.ends_at, 'date', ses.session_date,
          'queue_no', v_queue + 1, 'est_at', greatest(v_est, now()), 'time', to_char(greatest(v_est, now()) at time zone tz, 'HH24:MI'),
          'band', clinic.band_of((ses.starts_at at time zone tz)::time),
          'session', to_char(ses.starts_at at time zone tz, 'HH24:MI') || '–' || to_char(ses.ends_at at time zone tz, 'HH24:MI'),
          'label_ar', replace(clinic.when_words(ses.starts_at, tz, 'ar'), ' الساعة ', ' — بداية الكشف ')
                      || '، دور رقم ' || (v_queue + 1) || '، حوالي ' || clinic.clock_text((greatest(v_est, now()) at time zone tz)::time, 'ar'),
          'label_en', clinic.when_words(ses.starts_at, tz, 'en') || ' session — number ' || (v_queue + 1)
                      || ', about ' || clinic.clock_text((greatest(v_est, now()) at time zone tz)::time, 'en'),
          'left', case when v_cap is null then null else v_cap - v_count end);
        n := n + 1;
      elsif v_cap is not null and v_count >= v_cap then
        v_reasons := v_reasons || 'SESSION_FULL'::text;
      end if;
    end if;
  end loop;

  -- three to suggest: the first, then the first on other days, then spread through the day
  for x in select * from jsonb_array_elements(out_slots) loop
    exit when jsonb_array_length(v_sugg) >= 3;
    if not ((x ->> 'date')::date = any(v_days)) then
      v_sugg := v_sugg || x; v_days := v_days || (x ->> 'date')::date; v_last := (x ->> 'starts_at')::timestamptz;
    end if;
  end loop;
  if jsonb_array_length(v_sugg) < 3 then
    for x in select * from jsonb_array_elements(out_slots) loop
      exit when jsonb_array_length(v_sugg) >= 3;
      if not (v_sugg @> jsonb_build_array(x))
         and not exists (select 1 from jsonb_array_elements(v_sugg) y
                          where abs(extract(epoch from (y ->> 'starts_at')::timestamptz - (x ->> 'starts_at')::timestamptz)) < 5400
                            and y ->> 'kind' = x ->> 'kind' and y ->> 'doctor_id' = x ->> 'doctor_id') then
        v_sugg := v_sugg || x;
      end if;
    end loop;
  end if;
  select coalesce(jsonb_agg(z order by (z ->> 'starts_at')::timestamptz, z ->> 'kind'), '[]'::jsonb) into v_sugg
    from jsonb_array_elements(v_sugg) z;

  return jsonb_build_object('slots', out_slots, 'suggested', v_sugg, 'count', n,
                            'from', v_from, 'to', v_to,
                            'none_because', case when n = 0 then to_jsonb(array(select distinct unnest(v_reasons))) end);
end $$;

-- ---------------------------------------------------------------------
-- Make (or hold) an appointment — the only place one is created
-- p = {doctor_id, location_id, service_id?, kind 'slot'|'queue', starts_at (slot) | date (queue),
--      patient_id? | patient{full_name, age, sex, relation}, contact_id?, wa_id?, conversation_id?,
--      source, reason?, urgency?, status 'held'|'booked', staff?, plan_item_id?, notes?}
-- ---------------------------------------------------------------------
create or replace function clinic.book_appointment(p_tenant uuid, p jsonb)
returns jsonb language plpgsql as $$
declare
  t        clinic.tenants%rowtype;
  st       jsonb;
  tz       text;
  v_staff  boolean := coalesce((p ->> 'staff')::boolean, false);
  v_status text := coalesce(nullif(p ->> 'status', ''), 'booked');
  v_kind   text := coalesce(nullif(p ->> 'kind', ''), 'slot');
  v_doc    uuid := nullif(p ->> 'doctor_id', '')::uuid;
  v_loc    uuid := nullif(p ->> 'location_id', '')::uuid;
  v_svc    uuid := nullif(p ->> 'service_id', '')::uuid;
  v_patient bigint := nullif(p ->> 'patient_id', '')::bigint;
  v_contact bigint := nullif(p ->> 'contact_id', '')::bigint;
  v_at     timestamptz := nullif(p ->> 'starts_at', '')::timestamptz;
  v_date   date := nullif(p ->> 'date', '')::date;
  v_avail  jsonb;
  v_slot   jsonb;
  v_price  jsonb;
  v_new    boolean;
  v_seq    bigint;
  v_ref    text;
  a        clinic.appointments%rowtype;
  v_wa     text := nullif(p ->> 'wa_id', '');
begin
  select * into t from clinic.tenants where id = p_tenant;
  st := clinic.merged_settings(t.settings);
  tz := t.timezone;
  if v_doc is null then return jsonb_build_object('ok', false, 'error', 'DOCTOR_NEEDED'); end if;
  if v_svc is null then v_svc := clinic.default_service(v_doc); end if;
  if v_kind = 'slot' and v_at is null then return jsonb_build_object('ok', false, 'error', 'TIME_NEEDED'); end if;
  if v_kind = 'queue' and v_date is null then v_date := (v_at at time zone tz)::date; end if;
  if v_kind = 'queue' and v_date is null then return jsonb_build_object('ok', false, 'error', 'DATE_NEEDED'); end if;

  if v_patient is null and jsonb_typeof(p -> 'patient') = 'object' and v_status <> 'held' then
    v_patient := clinic.resolve_patient(p_tenant, v_contact, (p -> 'patient') || jsonb_build_object('created_via',
                   case when p ->> 'source' = 'whatsapp' then 'whatsapp' else 'dashboard' end));
  end if;

  -- is it really free? (the same function the agent offered it from)
  v_avail := clinic.available_slots(p_tenant, jsonb_build_object(
               'doctor_id', v_doc, 'location_id', v_loc, 'service_id', v_svc, 'patient_id', v_patient,
               'age', p -> 'patient' ->> 'age',
               'from', coalesce(v_date, (v_at at time zone tz)::date), 'to', coalesce(v_date, (v_at at time zone tz)::date),
               'staff', v_staff, 'limit', 200, 'ignore_appointment', p ->> 'ignore_appointment'));
  select x into v_slot from jsonb_array_elements(v_avail -> 'slots') x
   where x ->> 'kind' = v_kind
     and (v_kind = 'queue' or (x ->> 'starts_at')::timestamptz = v_at)
     and (v_loc is null or (x ->> 'location_id')::uuid = v_loc)
   limit 1;
  if v_slot is null then
    -- the staff may squeeze a patient in outside the grid, as long as the doctor is free then
    if v_staff and v_kind = 'slot' and coalesce((p ->> 'force')::boolean, false) and v_loc is not null then
      v_slot := jsonb_build_object('kind', 'slot', 'location_id', v_loc, 'starts_at', v_at,
                  'ends_at', v_at + make_interval(mins => coalesce((select duration_min from clinic.services where id = v_svc), 15)),
                  'date', (v_at at time zone tz)::date);
    else
      return jsonb_build_object('ok', false, 'error', 'SLOT_NOT_AVAILABLE',
                                'fact', 'that time is no longer free (or not bookable) — offer the suggested ones',
                                'suggested', (clinic.available_slots(p_tenant, jsonb_build_object(
                                               'doctor_id', v_doc, 'location_id', v_loc, 'service_id', v_svc, 'patient_id', v_patient,
                                               'from', coalesce(v_date, (v_at at time zone tz)::date), 'staff', v_staff, 'limit', 30)) -> 'suggested'),
                                'none_because', v_avail -> 'none_because');
    end if;
  end if;
  v_loc := (v_slot ->> 'location_id')::uuid;
  v_price := clinic.booking_price(v_svc, v_doc, v_loc, v_patient);
  v_new := v_patient is null or not exists (select 1 from clinic.appointments x where x.patient_id = v_patient and x.status = 'done');

  if v_status <> 'held' then
    update clinic.tenants set appt_seq = appt_seq + 1 where id = p_tenant returning appt_seq into v_seq;
    v_ref := t.ref_prefix || '-' || v_seq;
  end if;
  if v_wa is null and v_contact is not null then select wa_id into v_wa from clinic.contacts where id = v_contact; end if;
  if v_contact is null and v_wa is not null then select id into v_contact from clinic.contacts where tenant_id = p_tenant and wa_id = v_wa; end if;

  begin
    insert into clinic.appointments (tenant_id, ref_no, doctor_id, location_id, resource_id, service_id, patient_id, contact_id,
                                     wa_id, conversation_id, status, source, mode, session_date, starts_at, ends_at, queue_no, est_at,
                                     reason, urgency, is_new_patient, is_follow_up, price, price_max, price_kind, price_text,
                                     plan_item_id, hold_expires_at, staff_notes, created_by)
    values (p_tenant, v_ref, v_doc, v_loc, nullif(v_slot ->> 'resource_id', '')::uuid, (v_price ->> 'service_id')::uuid,
            v_patient, v_contact, v_wa,
            coalesce(nullif(p ->> 'conversation_id', '')::bigint, (select id from clinic.conversations where tenant_id = p_tenant and wa_id = v_wa)),
            v_status, coalesce(nullif(p ->> 'source', ''), 'dashboard'), v_kind, (v_slot ->> 'date')::date,
            (v_slot ->> 'starts_at')::timestamptz, (v_slot ->> 'ends_at')::timestamptz,
            case when v_kind = 'queue' then (v_slot ->> 'queue_no')::int end,
            case when v_kind = 'queue' then (v_slot ->> 'est_at')::timestamptz else (v_slot ->> 'starts_at')::timestamptz end,
            left(nullif(btrim(coalesce(p ->> 'reason', '')), ''), 500), coalesce(nullif(p ->> 'urgency', ''), 'routine'),
            v_new, coalesce((v_price ->> 'is_follow_up')::boolean, false),
            (v_price ->> 'price')::numeric, (v_price ->> 'price_max')::numeric, v_price ->> 'kind',
            v_price ->> 'text_ar', nullif(p ->> 'plan_item_id', '')::bigint,
            case when v_status = 'held' then now() + make_interval(mins => coalesce((st -> 'booking' ->> 'hold_minutes')::int, 15)) end,
            nullif(p ->> 'notes', ''), clinic.current_user_id())
    returning * into a;
  exception when exclusion_violation or unique_violation then
    return jsonb_build_object('ok', false, 'error', 'SLOT_TAKEN', 'fact', 'someone took that time a moment ago — offer another');
  end;

  perform clinic.log_appt(a.id, case when v_status = 'held' then 'held' else 'booked' end,
                          jsonb_build_object('source', a.source, 'when', clinic.appt_when(a)),
                          case when a.source = 'whatsapp' then 'agent' end);
  if v_status <> 'held' then
    perform clinic.after_booked(a.id);
  end if;
  select * into a from clinic.appointments where id = a.id;
  return jsonb_build_object('ok', true, 'appointment', clinic.appointment_view(a), 'price', v_price);
end $$;

-- after a booking is final: the reminders, the waitlist entry it answers, the patient's preferences
create or replace function clinic.after_booked(p_appt bigint)
returns void language plpgsql as $$
declare a clinic.appointments%rowtype;
begin
  select * into a from clinic.appointments where id = p_appt;
  perform clinic.schedule_reminders(a.id);
  -- a treatment plan's session
  if a.plan_item_id is not null then
    update clinic.treatment_plan_items set status = 'booked' where id = a.plan_item_id and status = 'planned';
    update clinic.treatment_plans pl set status = 'in_progress'
      from clinic.treatment_plan_items i where i.id = a.plan_item_id and pl.id = i.plan_id and pl.status in ('accepted', 'quoted');
  end if;
  if a.patient_id is not null then
    update clinic.patients
       set preferences = preferences || jsonb_build_object('doctor_id', a.doctor_id, 'location_id', a.location_id,
                                                           'band', clinic.band_of((a.starts_at at time zone clinic.tenant_tz(a.tenant_id))::time))
     where id = a.patient_id;
    update clinic.waitlist set status = 'booked'
     where patient_id = a.patient_id and doctor_id = a.doctor_id and status in ('waiting', 'offered') and a.session_date >= from_date;
  end if;
end $$;

-- turn a hold into a booking (the agent's "book", once the summary was confirmed)
create or replace function clinic.confirm_hold(p_appt bigint, p_patient bigint, p_reason text default null)
returns jsonb language plpgsql as $$
declare
  a     clinic.appointments%rowtype;
  t     clinic.tenants%rowtype;
  v_seq bigint;
  v_pr  jsonb;
begin
  select * into a from clinic.appointments where id = p_appt for update;
  if not found or a.status <> 'held' then return jsonb_build_object('ok', false, 'error', 'HOLD_GONE'); end if;
  if a.hold_expires_at < now() then
    -- the hold lapsed: book it again only if it is still free
    update clinic.appointments set status = 'cancelled', cancelled_at = now(), cancel_reason = 'hold expired', cancelled_by = 'system' where id = a.id;
    return jsonb_build_object('ok', false, 'error', 'HOLD_EXPIRED');
  end if;
  select * into t from clinic.tenants where id = a.tenant_id;
  update clinic.tenants set appt_seq = appt_seq + 1 where id = t.id returning appt_seq into v_seq;
  v_pr := clinic.booking_price(a.service_id, a.doctor_id, a.location_id, p_patient);
  update clinic.appointments
     set status = 'booked', ref_no = t.ref_prefix || '-' || v_seq, patient_id = p_patient, hold_expires_at = null,
         service_id = (v_pr ->> 'service_id')::uuid, is_follow_up = (v_pr ->> 'is_follow_up')::boolean,
         price = (v_pr ->> 'price')::numeric, price_max = (v_pr ->> 'price_max')::numeric, price_kind = v_pr ->> 'kind',
         price_text = v_pr ->> 'text_ar',
         is_new_patient = not exists (select 1 from clinic.appointments x where x.patient_id = p_patient and x.status = 'done'),
         reason = coalesce(left(nullif(btrim(coalesce(p_reason, '')), ''), 500), reason)
   where id = a.id returning * into a;
  perform clinic.log_appt(a.id, 'booked', jsonb_build_object('when', clinic.appt_when(a), 'from_hold', true), 'agent');
  perform clinic.after_booked(a.id);
  return jsonb_build_object('ok', true, 'appointment', clinic.appointment_view(a), 'price', v_pr);
end $$;

-- cancel: who and why, the reminders stop, the waitlist hears of the free time
create or replace function clinic.cancel_appointment(p_appt bigint, p_by text, p_reason text default null, p_notify boolean default false)
returns jsonb language plpgsql as $$
declare
  a    clinic.appointments%rowtype;
  st   jsonb;
  v_lang text;
begin
  select * into a from clinic.appointments where id = p_appt for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if a.status in ('cancelled', 'done', 'no_show') then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_' || upper(a.status), 'appointment', clinic.appointment_view(a));
  end if;
  update clinic.appointments
     set status = 'cancelled', cancelled_at = now(), cancelled_by = coalesce(p_by, 'clinic'),
         cancel_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300), hold_expires_at = null
   where id = a.id returning * into a;
  update clinic.appointment_reminders set status = 'cancelled' where appointment_id = a.id and status = 'scheduled';
  update clinic.delay_notice_items set status = 'cancelled', replied_at = coalesce(replied_at, now())
   where appointment_id = a.id and status in ('queued', 'sent');
  perform clinic.log_appt(a.id, 'cancelled', jsonb_build_object('by', p_by, 'reason', p_reason),
                          case p_by when 'patient' then 'patient' when 'system' then 'system' end);
  if p_notify and a.wa_id is not null and coalesce(a.ref_no, '') <> '' then
    select clinic.merged_settings(settings) into st from clinic.tenants where id = a.tenant_id;
    v_lang := clinic.contact_language(a.tenant_id, a.wa_id);
    perform clinic.queue_message(a.tenant_id, a.wa_id, 'booking_cancelled',
      clinic.render_template(st -> 'templates' ->> ('booking_cancelled_by_clinic_' || v_lang), clinic.message_vars(a, v_lang)
        || jsonb_build_object('reason', case when coalesce(p_reason, '') <> '' then ' — ' || p_reason else '' end)),
      p_template => 'booking_cancelled', p_meta => jsonb_build_object('appointment_id', a.id));
  end if;
  if a.ref_no is not null and a.starts_at > now() then
    perform clinic.offer_waitlist(a.id);
  end if;
  return jsonb_build_object('ok', true, 'appointment', clinic.appointment_view(a));
end $$;

-- move to another free time (same doctor unless given); reminders follow
create or replace function clinic.reschedule_appointment(p_appt bigint, p jsonb)
returns jsonb language plpgsql as $$
declare
  a      clinic.appointments%rowtype;
  tz     text;
  v_kind text;
  v_at   timestamptz := nullif(p ->> 'starts_at', '')::timestamptz;
  v_date date := nullif(p ->> 'date', '')::date;
  v_doc  uuid;
  v_loc  uuid;
  v_avail jsonb;
  v_slot jsonb;
  v_old  text;
  st     jsonb;
  v_lang text;
begin
  select * into a from clinic.appointments where id = p_appt for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if a.status not in ('booked', 'confirmed', 'held') then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_MOVE_' || upper(a.status));
  end if;
  tz := clinic.tenant_tz(a.tenant_id);
  v_doc := coalesce(nullif(p ->> 'doctor_id', '')::uuid, a.doctor_id);
  v_loc := nullif(p ->> 'location_id', '')::uuid;
  v_kind := coalesce(nullif(p ->> 'kind', ''), case when v_at is null and v_date is not null then 'queue' else 'slot' end);
  if v_kind = 'slot' and v_at is null then return jsonb_build_object('ok', false, 'error', 'TIME_NEEDED'); end if;
  v_old := clinic.appt_when(a);
  v_avail := clinic.available_slots(a.tenant_id, jsonb_build_object(
               'doctor_id', v_doc, 'location_id', v_loc, 'service_id', a.service_id, 'patient_id', a.patient_id,
               'from', coalesce(v_date, (v_at at time zone tz)::date), 'to', coalesce(v_date, (v_at at time zone tz)::date),
               'staff', coalesce((p ->> 'staff')::boolean, false), 'limit', 200, 'ignore_appointment', a.id));
  select x into v_slot from jsonb_array_elements(v_avail -> 'slots') x
   where x ->> 'kind' = v_kind and (v_kind = 'queue' or (x ->> 'starts_at')::timestamptz = v_at)
     and (v_loc is null or (x ->> 'location_id')::uuid = v_loc)
   limit 1;
  if v_slot is null and coalesce((p ->> 'staff')::boolean, false) and coalesce((p ->> 'force')::boolean, false) and v_kind = 'slot' then
    v_slot := jsonb_build_object('kind', 'slot', 'location_id', coalesce(v_loc, a.location_id), 'starts_at', v_at,
                                 'ends_at', v_at + (a.ends_at - a.starts_at), 'date', (v_at at time zone tz)::date);
  end if;
  if v_slot is null then
    return jsonb_build_object('ok', false, 'error', 'SLOT_NOT_AVAILABLE', 'fact', 'that time is not free — offer the suggested ones',
                              'suggested', (clinic.available_slots(a.tenant_id, jsonb_build_object(
                                 'doctor_id', v_doc, 'service_id', a.service_id, 'patient_id', a.patient_id,
                                 'from', coalesce(v_date, (v_at at time zone tz)::date), 'limit', 30, 'ignore_appointment', a.id)) -> 'suggested'));
  end if;
  begin
    update clinic.appointments
       set doctor_id = v_doc, location_id = (v_slot ->> 'location_id')::uuid,
           resource_id = nullif(v_slot ->> 'resource_id', '')::uuid, mode = v_kind,
           session_date = (v_slot ->> 'date')::date, starts_at = (v_slot ->> 'starts_at')::timestamptz,
           ends_at = (v_slot ->> 'ends_at')::timestamptz,
           queue_no = case when v_kind = 'queue' then (v_slot ->> 'queue_no')::int end,
           est_at = case when v_kind = 'queue' then (v_slot ->> 'est_at')::timestamptz else (v_slot ->> 'starts_at')::timestamptz end,
           original_starts_at = null, delay_minutes = 0, confirmed_at = null,
           status = case when status = 'held' then 'held' else 'booked' end,
           at_risk_alerted_at = null
     where id = a.id returning * into a;
  exception when exclusion_violation or unique_violation then
    return jsonb_build_object('ok', false, 'error', 'SLOT_TAKEN', 'fact', 'someone took that time a moment ago — offer another');
  end;
  update clinic.appointment_reminders set status = 'cancelled' where appointment_id = a.id and status = 'scheduled';
  update clinic.delay_notice_items set status = 'changed', replied_at = coalesce(replied_at, now())
   where appointment_id = a.id and status in ('queued', 'sent');
  if a.status <> 'held' then perform clinic.schedule_reminders(a.id); end if;
  perform clinic.log_appt(a.id, 'moved', jsonb_build_object('from', v_old, 'to', clinic.appt_when(a)),
                          case when clinic.current_user_id() is null then coalesce(p ->> 'by_role', 'agent') end);
  if coalesce((p ->> 'notify')::boolean, false) and a.wa_id is not null then
    select clinic.merged_settings(settings) into st from clinic.tenants where id = a.tenant_id;
    v_lang := clinic.contact_language(a.tenant_id, a.wa_id);
    perform clinic.queue_message(a.tenant_id, a.wa_id, 'booking_moved',
      clinic.render_template(st -> 'templates' ->> ('booking_moved_' || v_lang), clinic.message_vars(a, v_lang)),
      p_template => 'booking_moved', p_meta => jsonb_build_object('appointment_id', a.id));
  end if;
  return jsonb_build_object('ok', true, 'appointment', clinic.appointment_view(a), 'moved_from', v_old);
end $$;

-- the words every message about an appointment fills in
create or replace function clinic.message_vars(a clinic.appointments, p_lang text default 'ar')
returns jsonb language plpgsql stable as $$
declare
  co   clinic.contacts%rowtype;
  pt   clinic.patients%rowtype;
  rel  text;
  v_link text := clinic.manage_link(a);
  v_prep text;
begin
  select * into co from clinic.contacts where id = a.contact_id;
  select * into pt from clinic.patients where id = a.patient_id;
  select pc.relation into rel from clinic.patient_contacts pc where pc.patient_id = a.patient_id and pc.contact_id = a.contact_id;
  select case when p_lang = 'en' then coalesce(prep_en, prep_ar) else prep_ar end into v_prep from clinic.services where id = a.service_id;
  return jsonb_build_object(
    'name', clinic.first_name(coalesce(co.full_name, case when coalesce(rel, 'self') = 'self' then pt.full_name end), co.display_name),
    'for', case when pt.id is null or coalesce(rel, 'self') = 'self' then case when p_lang = 'en' then 'your' else 'حضرتك' end
                else split_part(pt.full_name, ' ', 1) || case when p_lang = 'en' then '''s' else '' end end,
    'patient', pt.full_name,
    'when', clinic.appt_when(a, p_lang, true),
    'doctor', clinic.doctor_label(a.doctor_id, p_lang),
    'location', clinic.location_label(a.location_id, p_lang),
    'service', (select case when p_lang = 'en' then coalesce(name_en, name_ar) else name_ar end from clinic.services where id = a.service_id),
    'ref_no', a.ref_no,
    'time', clinic.clock_text((coalesce(a.est_at, a.starts_at) at time zone clinic.tenant_tz(a.tenant_id))::time, p_lang),
    'prep', case when coalesce(v_prep, '') <> '' then E'\n' || v_prep else '' end,
    'link', case when v_link is not null then E'\n' || v_link else '' end);
end $$;

-- ---------------------------------------------------------------------
-- The waitlist: a freed time goes to the first person waiting for it
-- ---------------------------------------------------------------------
create or replace function clinic.offer_waitlist(p_appt bigint)
returns int language plpgsql as $$
declare
  a    clinic.appointments%rowtype;
  w    clinic.waitlist%rowtype;
  st   jsonb;
  v_lang text;
  tz   text;
  v_slot jsonb;
begin
  select * into a from clinic.appointments where id = p_appt;
  tz := clinic.tenant_tz(a.tenant_id);
  if a.starts_at < now() + interval '2 hours' then return 0; end if;
  select * into w from clinic.waitlist x
   where x.tenant_id = a.tenant_id and x.status = 'waiting' and x.wa_id is not null
     and (x.doctor_id is null or x.doctor_id = a.doctor_id)
     and (x.location_id is null or x.location_id = a.location_id)
     and a.session_date >= x.from_date and (x.to_date is null or a.session_date <= x.to_date)
     and (x.band = 'any' or x.band = clinic.band_of((a.starts_at at time zone tz)::time))
     and (x.patient_id is null or x.patient_id is distinct from a.patient_id)
   order by x.created_at limit 1 for update skip locked;
  if w.id is null then return 0; end if;
  v_slot := jsonb_build_object('kind', a.mode, 'doctor_id', a.doctor_id, 'location_id', a.location_id,
                               'service_id', coalesce(w.service_id, a.service_id), 'starts_at', a.starts_at,
                               'date', a.session_date, 'label_ar', clinic.appt_when(a, 'ar'));
  update clinic.waitlist set status = 'offered', offered_slot = v_slot, offered_at = now() where id = w.id;
  select clinic.merged_settings(settings) into st from clinic.tenants where id = a.tenant_id;
  v_lang := clinic.contact_language(a.tenant_id, w.wa_id);
  perform clinic.queue_message(a.tenant_id, w.wa_id, 'waitlist_offer',
    clinic.render_template(st -> 'templates' ->> ('waitlist_offer_' || v_lang),
      jsonb_build_object('name', (select clinic.first_name(full_name, display_name) from clinic.contacts where id = w.contact_id),
                         'for', coalesce((select split_part(full_name, ' ', 1) from clinic.patients where id = w.patient_id), 'حضرتك'),
                         'doctor', clinic.doctor_label(a.doctor_id, v_lang), 'when', clinic.appt_when(a, v_lang, true))),
    p_template => 'waitlist_offer', p_meta => jsonb_build_object('waitlist_id', w.id));
  update clinic.conversations set state = state || jsonb_build_object('pending_offer', jsonb_build_object(
           'waitlist_id', w.id, 'slot', v_slot, 'at', now()))
   where tenant_id = a.tenant_id and wa_id = w.wa_id;
  return 1;
end $$;

-- ---------------------------------------------------------------------
-- Treatment plans: the quote on WhatsApp, acceptance, one session at a time
-- ---------------------------------------------------------------------
create or replace function clinic.plan_total(p_plan bigint)
returns numeric language sql stable as $$
  select coalesce(sum(i.price), 0) - coalesce((select discount from clinic.treatment_plans where id = p_plan), 0)
    from clinic.treatment_plan_items i where i.plan_id = p_plan and i.status <> 'cancelled'
$$;

create or replace function clinic.plan_text(p_plan bigint, p_lang text default 'ar')
returns text language plpgsql stable as $$
declare
  pl  clinic.treatment_plans%rowtype;
  t   clinic.tenants%rowtype;
  i   record;
  out text[] := '{}';
  n   int := 0;
  v_sub numeric := 0;
begin
  select * into pl from clinic.treatment_plans where id = p_plan;
  select * into t from clinic.tenants where id = pl.tenant_id;
  out := out || format(case when p_lang = 'en' then 'Treatment plan for %s with %s:' else 'خطة العلاج لـ %s مع %s:' end,
                       (select split_part(full_name, ' ', 1) from clinic.patients where id = pl.patient_id),
                       clinic.doctor_label(pl.doctor_id, p_lang));
  for i in select * from clinic.treatment_plan_items where plan_id = p_plan and status <> 'cancelled' order by seq, id loop
    n := n + 1;
    v_sub := v_sub + coalesce(i.price, 0);
    out := out || format('%s) %s%s — %s%s', n,
                         case when i.tooth is not null then case when p_lang = 'en' then 'tooth ' else 'سنة ' end || i.tooth || ' · ' else '' end,
                         i.label,
                         case when i.price is null then case when p_lang = 'en' then 'price after the check-up' else 'السعر بعد الكشف' end
                              else clinic.fmt_money(i.price) || case when p_lang = 'en' then ' EGP' else ' ' || t.currency_symbol_ar end end,
                         case when i.sessions > 1 then format(case when p_lang = 'en' then ' (%s sessions)' else ' (%s جلسات)' end, i.sessions) else '' end);
  end loop;
  if pl.discount > 0 then
    out := out || format(case when p_lang = 'en' then 'Total %s, discount %s = %s EGP' else 'الإجمالي %s، خصم %s = %s %s' end,
                         clinic.fmt_money(v_sub), clinic.fmt_money(pl.discount), clinic.fmt_money(v_sub - pl.discount), t.currency_symbol_ar);
  else
    out := out || format(case when p_lang = 'en' then 'Total %s EGP' else 'الإجمالي %s %s' end, clinic.fmt_money(v_sub), t.currency_symbol_ar);
  end if;
  if coalesce(pl.notes, '') <> '' then out := out || pl.notes; end if;
  return array_to_string(out, E'\n');
end $$;

create or replace function clinic.plan_quote(p_plan bigint)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  pl     clinic.treatment_plans%rowtype;
  v_wa   text;
  v_lang text;
  r      jsonb;
begin
  select * into pl from clinic.treatment_plans where id = p_plan for update;
  if not found then raise exception 'no such plan'; end if;
  perform clinic.require_role(pl.tenant_id, array['owner', 'manager', 'doctor', 'nurse']);
  select c.wa_id into v_wa from clinic.patient_contacts pc join clinic.contacts c on c.id = pc.contact_id
   where pc.patient_id = pl.patient_id order by (pc.relation = 'self') desc, pc.created_at limit 1;
  if v_wa is null then return jsonb_build_object('ok', false, 'error', 'NO_WHATSAPP', 'fact', 'the patient has no WhatsApp on file'); end if;
  v_lang := clinic.contact_language(pl.tenant_id, v_wa);
  r := clinic.queue_message(pl.tenant_id, v_wa, 'plan_quote',
         clinic.plan_text(pl.id, v_lang) || E'\n\n' ||
         case when v_lang = 'en' then 'If you agree, reply "OK" and we will book the first session.'
              else 'لو موافق ابعت "موافق" ونحجزلك أول جلسة.' end,
         p_sender => 'staff', p_user => clinic.current_user_id(), p_template => 'plan_quote',
         p_meta => jsonb_build_object('plan_id', pl.id));
  update clinic.treatment_plans set status = 'quoted', quoted_at = now() where id = pl.id and status in ('draft', 'quoted');
  update clinic.conversations set state = state || jsonb_build_object('pending_plan', jsonb_build_object('plan_id', pl.id, 'at', now()))
   where tenant_id = pl.tenant_id and wa_id = v_wa;
  return jsonb_build_object('ok', true, 'sent_to', v_wa) || r;
end $$;

-- the next item of a plan that still needs a session, and the earliest day for it
create or replace function clinic.plan_next(p_plan bigint)
returns jsonb language plpgsql stable as $$
declare
  i      clinic.treatment_plan_items%rowtype;
  pl     clinic.treatment_plans%rowtype;
  v_last timestamptz;
begin
  select * into pl from clinic.treatment_plans where id = p_plan;
  select * into i from clinic.treatment_plan_items
   where plan_id = p_plan and status in ('planned', 'in_progress') and done_sessions < sessions
     and not exists (select 1 from clinic.appointments a where a.plan_item_id = treatment_plan_items.id
                      and a.status in ('booked', 'confirmed', 'arrived', 'in_visit'))
   order by seq, id limit 1;
  if i.id is null then return null; end if;
  select max(a.starts_at) into v_last from clinic.appointments a
    join clinic.treatment_plan_items x on x.id = a.plan_item_id where x.plan_id = p_plan and a.status = 'done';
  return jsonb_build_object('plan_id', p_plan, 'item_id', i.id, 'label', i.label, 'tooth', i.tooth, 'service_id', i.service_id,
                            'session', i.done_sessions + 1, 'of', i.sessions, 'doctor_id', pl.doctor_id,
                            'earliest', greatest(clinic.local_today(pl.tenant_id),
                                                 coalesce((v_last at time zone clinic.tenant_tz(pl.tenant_id))::date
                                                          + coalesce(i.session_gap_days, 7), clinic.local_today(pl.tenant_id))));
end $$;

-- ---------------------------------------------------------------------
-- The agent's tool
-- ---------------------------------------------------------------------
create or replace function clinic.booking_tool(p_tenant uuid, p_wa text, p_action text, p_details text)
returns jsonb language plpgsql as $$
declare
  t        clinic.tenants%rowtype;
  st       jsonb;
  tz       text;
  v        jsonb;
  v_action text := lower(btrim(coalesce(p_action, '')));
  conv     clinic.conversations%rowtype;
  co       clinic.contacts%rowtype;
  dr       clinic.booking_drafts%rowtype;
  d        jsonb;
  a        clinic.appointments%rowtype;
  problems jsonb := '[]'::jsonb;
  missing  text[] := '{}';
  upcoming jsonb;
  known    jsonb;
  v_changed boolean := false;
  v_doc    uuid; v_loc uuid; v_svc uuid; v_pat bigint;
  v_avail  jsonb;
  v_slot   jsonb;
  v_opt    int;
  v_at     timestamptz;
  v_date   date;
  v_txt    text;
  v_res    jsonb;
  v_lang   text;
  v_hold   jsonb;
  v_cands  int;
  v_plan   jsonb;
  v_item   record;
begin
  select * into t from clinic.tenants where id = p_tenant;
  st := clinic.merged_settings(t.settings);
  tz := t.timezone;
  v_lang := clinic.contact_language(p_tenant, p_wa);
  begin
    v := coalesce(nullif(btrim(coalesce(p_details, '')), '')::jsonb, '{}'::jsonb);
  exception when others then
    v := '{}'::jsonb;
    problems := problems || jsonb_build_object('problem', 'BAD_DETAILS_JSON', 'fact', 'details must be a JSON object');
  end;
  if jsonb_typeof(v) <> 'object' then v := '{}'::jsonb; end if;
  select * into conv from clinic.conversations where tenant_id = p_tenant and wa_id = p_wa;
  select * into co from clinic.contacts where id = conv.contact_id;
  known := clinic.contact_patients(co.id);
  upcoming := coalesce((select jsonb_agg(clinic.appointment_view(x, v_lang) order by x.starts_at)
                          from clinic.appointments x
                         where x.tenant_id = p_tenant and (x.wa_id = p_wa or x.contact_id = co.id)
                           and x.status in ('booked', 'confirmed') and x.ends_at > now()), '[]'::jsonb);

  if v_action not in ('find_slots', 'update', 'summary', 'book', 'cancel', 'reschedule', 'confirm', 'accept_delay',
                      'status', 'join_waitlist', 'take_offer', 'next_plan_session', 'accept_plan') then
    return jsonb_build_object('ok', false, 'error', 'UNKNOWN_ACTION',
      'fact', 'action is one of: find_slots, update, summary, book, cancel, reschedule, confirm, accept_delay, status, join_waitlist, take_offer, next_plan_session, accept_plan');
  end if;

  -- the appointment a reply is about: by ref_no, else the one a reminder / delay notice asked about, else the next one
  if v_action in ('cancel', 'reschedule', 'confirm', 'accept_delay') then
    select * into a from clinic.appointments x
     where x.tenant_id = p_tenant and (x.wa_id = p_wa or x.contact_id = co.id)
       and x.status in ('booked', 'confirmed') and x.ends_at > now()
       and (nullif(v ->> 'ref_no', '') is null or upper(x.ref_no) = upper(btrim(v ->> 'ref_no')))
     order by (x.id::text = coalesce(conv.state -> 'pending_delay' ->> 'appointment_id', conv.state -> 'pending_reminder' ->> 'appointment_id', '')) desc,
              x.starts_at
     limit 1;
  end if;

  -- ---- confirm / accept a delay --------------------------------------------
  if v_action in ('confirm', 'accept_delay') then
    if a.id is null then return jsonb_build_object('ok', false, 'error', 'NO_UPCOMING_APPOINTMENT', 'upcoming', upcoming); end if;
    update clinic.appointments set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()) where id = a.id returning * into a;
    update clinic.delay_notice_items set status = 'accepted', replied_at = now() where appointment_id = a.id and status = 'sent';
    perform clinic.log_appt(a.id, case when v_action = 'accept_delay' then 'delay_accepted' else 'confirmed' end, '{}'::jsonb, 'patient');
    update clinic.conversations set state = state - 'pending_reminder' - 'pending_delay' where id = conv.id;
    return jsonb_build_object('ok', true, 'status', case when v_action = 'accept_delay' then 'DELAY_ACCEPTED' else 'CONFIRMED' end,
                              'appointment', clinic.appointment_view(a, v_lang),
                              'fact', case when v_action = 'accept_delay' then 'the new time is confirmed' else 'confirmed — the clinic sees it' end);
  end if;

  -- ---- cancel ------------------------------------------------------------------
  if v_action = 'cancel' then
    select * into dr from clinic.booking_drafts where tenant_id = p_tenant and wa_id = p_wa;
    if dr.wa_id is not null and nullif(v ->> 'ref_no', '') is null and (a.id is null or coalesce((v ->> 'draft')::boolean, false)) then
      if dr.hold_id is not null then
        update clinic.appointments set status = 'cancelled', cancelled_at = now(), cancelled_by = 'patient', cancel_reason = 'draft dropped'
         where id = dr.hold_id and status = 'held';
      end if;
      delete from clinic.booking_drafts where tenant_id = p_tenant and wa_id = p_wa;
      return jsonb_build_object('ok', true, 'status', 'DRAFT_DISCARDED', 'upcoming', upcoming);
    end if;
    if a.id is null then return jsonb_build_object('ok', false, 'error', 'NOTHING_TO_CANCEL', 'upcoming', upcoming); end if;
    v_res := clinic.cancel_appointment(a.id, 'patient', coalesce(nullif(v ->> 'reason', ''), 'cancelled by the patient on WhatsApp'));
    update clinic.conversations set state = state - 'pending_reminder' - 'pending_delay' where id = conv.id;
    return v_res || jsonb_build_object('status', 'CANCELLED', 'fact', 'cancelled; the clinic sees it');
  end if;

  -- ---- status ------------------------------------------------------------------
  if v_action = 'status' then
    select * into dr from clinic.booking_drafts where tenant_id = p_tenant and wa_id = p_wa;
    return jsonb_build_object('ok', true, 'upcoming', upcoming, 'draft', dr.data, 'known_patients', known,
                              'waitlist', (select jsonb_agg(jsonb_build_object('id', w.id, 'doctor', clinic.doctor_label(w.doctor_id, 'ar'),
                                                                               'status', w.status, 'to', w.to_date))
                                             from clinic.waitlist w where w.tenant_id = p_tenant and w.wa_id = p_wa and w.status in ('waiting', 'offered')));
  end if;

  -- ---- the draft ---------------------------------------------------------------
  insert into clinic.booking_drafts (tenant_id, wa_id) values (p_tenant, p_wa)
  on conflict (tenant_id, wa_id) do nothing;
  select * into dr from clinic.booking_drafts where tenant_id = p_tenant and wa_id = p_wa for update;
  d := dr.data;

  -- whatever the patient said about who, which doctor, what for (all actions take them)
  if jsonb_typeof(v -> 'patient') = 'object' then v := v || (v -> 'patient'); end if;
  if nullif(v ->> 'patient_id', '') is not null and exists (
       select 1 from jsonb_array_elements(known) k where k ->> 'id' = v ->> 'patient_id') then
    d := d || jsonb_build_object('patient', jsonb_build_object('patient_id', (v ->> 'patient_id')::bigint));
    v_changed := true;
  elsif v ? 'full_name' or v ? 'age' or v ? 'sex' or v ? 'relation' then
    d := d || jsonb_build_object('patient', coalesce(d -> 'patient', '{}'::jsonb) - 'patient_id' || jsonb_strip_nulls(jsonb_build_object(
           'full_name', nullif(btrim(v ->> 'full_name'), ''), 'age', nullif(btrim(v ->> 'age'), ''),
           'sex', case when v ->> 'sex' in ('male', 'female') then v ->> 'sex' end,
           'relation', nullif(v ->> 'relation', ''))));
    -- a known family member named again
    if nullif(btrim(v ->> 'full_name'), '') is not null then
      v_pat := (select (k ->> 'id')::bigint from jsonb_array_elements(known) k
                 where clinic.norm(k ->> 'full_name') = clinic.norm(v ->> 'full_name')
                    or clinic.norm(k ->> 'first_name') = split_part(clinic.norm(v ->> 'full_name'), ' ', 1) limit 1);
      if v_pat is not null then d := jsonb_set(d, '{patient,patient_id}', to_jsonb(v_pat)); end if;
    elsif v ->> 'relation' = 'self' then
      v_pat := (select (k ->> 'id')::bigint from jsonb_array_elements(known) k where k ->> 'relation' = 'self' limit 1);
      if v_pat is not null then d := jsonb_set(d, '{patient,patient_id}', to_jsonb(v_pat)); end if;
    end if;
    v_changed := true;
  end if;
  if nullif(v ->> 'doctor', '') is not null then
    v_doc := clinic.match_doctor(p_tenant, v ->> 'doctor');
    if v_doc is null then problems := problems || jsonb_build_object('problem', 'DOCTOR_UNKNOWN', 'said', v ->> 'doctor');
    elsif (d ->> 'doctor_id') is distinct from v_doc::text then d := d || jsonb_build_object('doctor_id', v_doc); v_changed := true; end if;
  end if;
  if nullif(v ->> 'location', '') is not null then
    v_loc := clinic.match_location(p_tenant, v ->> 'location');
    if v_loc is null then problems := problems || jsonb_build_object('problem', 'LOCATION_UNKNOWN', 'said', v ->> 'location');
    elsif (d ->> 'location_id') is distinct from v_loc::text then d := d || jsonb_build_object('location_id', v_loc); v_changed := true; end if;
  end if;
  if nullif(v ->> 'service', '') is not null then
    v_svc := clinic.match_service(p_tenant, v ->> 'service', nullif(d ->> 'doctor_id', '')::uuid);
    if v_svc is null then v_svc := clinic.match_service(p_tenant, v ->> 'service'); end if;
    if v_svc is null then problems := problems || jsonb_build_object('problem', 'SERVICE_UNKNOWN', 'said', v ->> 'service',
                                                                     'fact', 'not on the clinic''s list — offer a check-up, or ask the doctor (ask_team)');
    elsif not (select bookable from clinic.services where id = v_svc) then
      problems := problems || jsonb_build_object('problem', 'SERVICE_NOT_BOOKABLE', 'service', (select name_ar from clinic.services where id = v_svc),
                                                 'fact', 'this is arranged after a check-up — book the check-up');
    elsif (d ->> 'service_id') is distinct from v_svc::text then d := d || jsonb_build_object('service_id', v_svc); v_changed := true; end if;
  end if;
  if v ? 'reason' and nullif(btrim(v ->> 'reason'), '') is not null then d := d || jsonb_build_object('reason', left(btrim(v ->> 'reason'), 500)); v_changed := true; end if;
  if v ->> 'urgency' in ('routine', 'soon', 'urgent', 'emergency') then d := d || jsonb_build_object('urgency', v ->> 'urgency'); end if;
  if v ->> 'kind' in ('slot', 'queue') then d := d || jsonb_build_object('kind', v ->> 'kind'); end if;

  -- one doctor does it → that is the doctor; one place → that is the place
  v_svc := nullif(d ->> 'service_id', '')::uuid;
  if d ->> 'doctor_id' is null then
    select count(*), (array_agg(x.id))[1] into v_cands, v_doc from clinic.doctors x
     where x.tenant_id = p_tenant and x.is_active and (v_svc is null or clinic.service_offered(v_svc, x.id));
    if v_cands = 1 then d := d || jsonb_build_object('doctor_id', v_doc); end if;
  end if;
  v_doc := nullif(d ->> 'doctor_id', '')::uuid;
  if v_svc is null and v_doc is not null then v_svc := clinic.default_service(v_doc); end if;
  v_loc := nullif(d ->> 'location_id', '')::uuid;
  v_pat := nullif(d -> 'patient' ->> 'patient_id', '')::bigint;

  -- ---- accept a quoted treatment plan -------------------------------------------
  if v_action = 'accept_plan' then
    select pl.id into v_opt from clinic.treatment_plans pl
     where pl.tenant_id = p_tenant and pl.status = 'quoted'
       and pl.id = coalesce(nullif(v ->> 'plan_id', '')::bigint, nullif(conv.state -> 'pending_plan' ->> 'plan_id', '')::bigint,
                            (select x.id from clinic.treatment_plans x join clinic.patient_contacts pc on pc.patient_id = x.patient_id
                              where pc.contact_id = co.id and x.status = 'quoted' order by x.quoted_at desc limit 1));
    if v_opt is null then return jsonb_build_object('ok', false, 'error', 'NO_QUOTED_PLAN'); end if;
    update clinic.treatment_plans set status = 'accepted', accepted_at = now() where id = v_opt;
    update clinic.conversations set state = state - 'pending_plan' where id = conv.id;
    v_action := 'next_plan_session';
    v := v || jsonb_build_object('plan_id', v_opt);
  end if;

  -- ---- the next session of a treatment plan ---------------------------------------
  if v_action = 'next_plan_session' then
    select pl.id into v_opt from clinic.treatment_plans pl join clinic.patient_contacts pc on pc.patient_id = pl.patient_id
     where pl.tenant_id = p_tenant and pc.contact_id = co.id and pl.status in ('accepted', 'in_progress')
       and (nullif(v ->> 'plan_id', '') is null or pl.id = (v ->> 'plan_id')::bigint)
     order by pl.accepted_at desc nulls last limit 1;
    v_plan := case when v_opt is not null then clinic.plan_next(v_opt) end;
    if v_plan is null then return jsonb_build_object('ok', false, 'error', 'NO_PLAN_SESSION_DUE'); end if;
    d := d || jsonb_build_object('doctor_id', v_plan ->> 'doctor_id', 'service_id', v_plan ->> 'service_id',
                                 'plan_item_id', (v_plan ->> 'item_id')::bigint,
                                 'patient', jsonb_build_object('patient_id', (select patient_id from clinic.treatment_plans where id = v_opt)),
                                 'reason', (v_plan ->> 'label') || ' — ' || (v_plan ->> 'session') || '/' || (v_plan ->> 'of'));
    v_doc := (v_plan ->> 'doctor_id')::uuid; v_svc := nullif(v_plan ->> 'service_id', '')::uuid;
    v_pat := (select patient_id from clinic.treatment_plans where id = v_opt);
    v := v || jsonb_build_object('from', greatest(coalesce(nullif(v ->> 'from', '')::date, (v_plan ->> 'earliest')::date), (v_plan ->> 'earliest')::date));
    v_changed := true;
    v_action := 'find_slots';
  end if;

  -- ---- an offered waitlist time -----------------------------------------------------
  if v_action = 'take_offer' then
    v_slot := conv.state -> 'pending_offer' -> 'slot';
    if v_slot is null then return jsonb_build_object('ok', false, 'error', 'NO_OFFER'); end if;
    d := d || jsonb_build_object('doctor_id', v_slot ->> 'doctor_id', 'location_id', v_slot ->> 'location_id',
                                 'service_id', v_slot ->> 'service_id',
                                 'patient', coalesce(d -> 'patient', jsonb_build_object('patient_id',
                                              (select patient_id from clinic.waitlist where id = (conv.state -> 'pending_offer' ->> 'waitlist_id')::bigint))));
    v := v || jsonb_build_object('starts_at', v_slot ->> 'starts_at', 'kind', v_slot ->> 'kind', 'date', v_slot ->> 'date');
    v_doc := (v_slot ->> 'doctor_id')::uuid; v_loc := (v_slot ->> 'location_id')::uuid; v_svc := nullif(v_slot ->> 'service_id', '')::uuid;
    v_pat := nullif(d -> 'patient' ->> 'patient_id', '')::bigint;
    update clinic.conversations set state = state - 'pending_offer' where id = conv.id;
    v_action := 'update';
  end if;

  -- ---- free times ---------------------------------------------------------------
  if v_action = 'find_slots' or (v_action = 'reschedule' and coalesce(v ->> 'option', v ->> 'starts_at', v ->> 'time', '') = '') then
    if v_action = 'reschedule' then
      if a.id is null then return jsonb_build_object('ok', false, 'error', 'NOTHING_TO_MOVE', 'upcoming', upcoming); end if;
      v_doc := coalesce(v_doc, a.doctor_id); v_svc := coalesce(a.service_id, v_svc); v_pat := coalesce(a.patient_id, v_pat);
      d := d || jsonb_build_object('rescheduling', a.id);
    end if;
    if v_doc is null and v_svc is null then
      -- every doctor (polyclinic, no service named yet): ask which speciality instead of listing everyone's times
      if (select count(*) from clinic.doctors where tenant_id = p_tenant and is_active) > 1 then
        update clinic.booking_drafts set data = d, changed_at = case when v_changed then clock_timestamp() else changed_at end, updated_at = now()
         where tenant_id = p_tenant and wa_id = p_wa;
        return jsonb_build_object('ok', false, 'error', 'WHICH_DOCTOR',
          'fact', 'several doctors here — work out the speciality from the complaint, or ask which doctor',
          'doctors', (select jsonb_agg(jsonb_build_object('code', x.code, 'name', clinic.doctor_label(x.id, 'ar'), 'specialty', x.specialty))
                        from clinic.doctors x where x.tenant_id = p_tenant and x.is_active));
      end if;
    end if;
    v_at := null;
    if coalesce(v ->> 'after', '') = 'last_offered' then
      v_at := (select max((x ->> 'starts_at')::timestamptz) from jsonb_array_elements(coalesce(d -> 'last_offered', '[]'::jsonb)) x) + interval '1 minute';
    elsif nullif(v ->> 'after', '') is not null then
      begin v_at := (v ->> 'after')::timestamptz; exception when others then v_at := null; end;
    end if;
    v_avail := clinic.available_slots(p_tenant, jsonb_strip_nulls(jsonb_build_object(
                 'doctor_id', v_doc, 'location_id', v_loc, 'service_id', v_svc, 'patient_id', v_pat,
                 'age', d -> 'patient' ->> 'age',
                 'from', nullif(coalesce(v ->> 'from', v ->> 'date'), ''), 'to', nullif(coalesce(v ->> 'to', v ->> 'date'), ''),
                 'band', nullif(v ->> 'band', ''), 'after', v_at,
                 'time_from', nullif(v ->> 'time_from', ''), 'time_to', nullif(v ->> 'time_to', ''),
                 'ignore_appointment', case when v_action = 'reschedule' then a.id end, 'limit', 60)));
    -- nothing that day: the next days, so the agent always has something to offer
    if jsonb_array_length(v_avail -> 'suggested') = 0 and nullif(coalesce(v ->> 'to', v ->> 'date'), '') is not null then
      v_res := clinic.available_slots(p_tenant, jsonb_strip_nulls(jsonb_build_object(
                 'doctor_id', v_doc, 'location_id', v_loc, 'service_id', v_svc, 'patient_id', v_pat,
                 'from', (coalesce(v ->> 'to', v ->> 'date'))::date + 1, 'band', nullif(v ->> 'band', ''),
                 'ignore_appointment', case when v_action = 'reschedule' then a.id end, 'limit', 60)));
    end if;
    select coalesce(jsonb_agg(x || jsonb_build_object('option', n)), '[]'::jsonb) into v_res
      from jsonb_array_elements(case when jsonb_array_length(v_avail -> 'suggested') > 0 then v_avail -> 'suggested'
                                     else coalesce(v_res -> 'suggested', '[]'::jsonb) end) with ordinality as s(x, n);
    d := d || jsonb_build_object('last_offered', v_res);
    update clinic.booking_drafts set data = d, changed_at = case when v_changed then clock_timestamp() else changed_at end, updated_at = now()
     where tenant_id = p_tenant and wa_id = p_wa;
    update clinic.conversations set state = state || jsonb_build_object('last_offered', v_res) where id = conv.id;
    return jsonb_build_object('ok', true, 'status', case when jsonb_array_length(v_res) > 0 then 'OPTIONS' else 'NO_FREE_TIME' end,
                              'options', v_res, 'more_free_times', greatest((v_avail ->> 'count')::int - 3, 0),
                              'on_requested_day', jsonb_array_length(v_avail -> 'suggested') > 0,
                              'none_because', v_avail -> 'none_because',
                              'price', case when v_svc is not null and v_doc is not null then clinic.booking_price(v_svc, v_doc, v_loc, v_pat) end,
                              'plan_session', v_plan, 'rescheduling', case when a.id is not null and d ? 'rescheduling' then clinic.appointment_view(a, v_lang) end,
                              'fact', 'offer these (by their label) — nothing is held until the patient picks one');
  end if;

  -- ---- choosing a time (update / reschedule) -----------------------------------------
  v_slot := null;
  if nullif(v ->> 'option', '') is not null then
    v_opt := (v ->> 'option')::int;
    select x into v_slot from jsonb_array_elements(coalesce(d -> 'last_offered', conv.state -> 'last_offered', '[]'::jsonb)) x
     where (x ->> 'option')::int = v_opt;
    if v_slot is null then problems := problems || jsonb_build_object('problem', 'OPTION_UNKNOWN', 'said', v ->> 'option',
                                                                      'fact', 'that option was not offered — find_slots first'); end if;
  elsif nullif(v ->> 'starts_at', '') is not null or (nullif(v ->> 'date', '') is not null and nullif(v ->> 'time', '') is not null)
        or (v ->> 'kind' = 'queue' and nullif(v ->> 'date', '') is not null) then
    begin
      if nullif(v ->> 'starts_at', '') is not null then
        v_at := (v ->> 'starts_at')::timestamptz;
      elsif nullif(v ->> 'time', '') is not null then
        v_txt := btrim(v ->> 'time'); if v_txt ~ '^\d{1,2}$' then v_txt := v_txt || ':00'; end if;
        v_at := ((v ->> 'date')::date + v_txt::time) at time zone tz;
      end if;
      v_date := coalesce(nullif(v ->> 'date', '')::date, (v_at at time zone tz)::date);
      v_slot := jsonb_strip_nulls(jsonb_build_object('kind', coalesce(nullif(v ->> 'kind', ''), case when v_at is null then 'queue' else 'slot' end),
                                                     'starts_at', v_at, 'date', v_date,
                                                     'doctor_id', coalesce(v_doc, a.doctor_id), 'location_id', v_loc));
    exception when others then
      problems := problems || jsonb_build_object('problem', 'TIME_FORMAT', 'fact', 'send date YYYY-MM-DD and time HH:MM (24h), or option N');
    end;
  end if;

  if v_action = 'reschedule' then
    if a.id is null then return jsonb_build_object('ok', false, 'error', 'NOTHING_TO_MOVE', 'upcoming', upcoming); end if;
    if v_slot is null then return jsonb_build_object('ok', false, 'error', 'NEW_TIME_NEEDED', 'problems', problems); end if;
    v_res := clinic.reschedule_appointment(a.id, jsonb_build_object(
               'starts_at', v_slot ->> 'starts_at', 'date', v_slot ->> 'date', 'kind', v_slot ->> 'kind',
               'doctor_id', coalesce(v_slot ->> 'doctor_id', a.doctor_id::text), 'location_id', v_slot ->> 'location_id', 'by_role', 'patient'));
    if (v_res ->> 'ok')::boolean then
      update clinic.conversations set state = state - 'pending_reminder' - 'pending_delay' - 'last_offered' where id = conv.id;
      delete from clinic.booking_drafts where tenant_id = p_tenant and wa_id = p_wa and hold_id is null;
    end if;
    return v_res || jsonb_build_object('status', case when (v_res ->> 'ok')::boolean then 'MOVED' else 'NOT_MOVED' end);
  end if;

  -- a time picked → hold it (a new hold replaces the old one)
  if v_slot is not null then
    if v_slot ->> 'doctor_id' is not null then
      d := d || jsonb_build_object('doctor_id', v_slot ->> 'doctor_id'); v_doc := (v_slot ->> 'doctor_id')::uuid;
    end if;
    if v_slot ->> 'location_id' is not null then d := d || jsonb_build_object('location_id', v_slot ->> 'location_id'); end if;
    if v_doc is null then
      problems := problems || jsonb_build_object('problem', 'DOCTOR_NEEDED', 'fact', 'which doctor? (find_slots first)');
    else
      if v_svc is null then v_svc := clinic.default_service(v_doc); end if;
      if dr.hold_id is not null then
        update clinic.appointments set status = 'cancelled', cancelled_at = now(), cancelled_by = 'patient', cancel_reason = 'another time chosen'
         where id = dr.hold_id and status = 'held';
      end if;
      v_hold := clinic.book_appointment(p_tenant, jsonb_build_object(
                  'doctor_id', v_doc, 'location_id', v_slot ->> 'location_id', 'service_id', v_svc,
                  'kind', coalesce(v_slot ->> 'kind', 'slot'), 'starts_at', v_slot ->> 'starts_at', 'date', v_slot ->> 'date',
                  'patient_id', v_pat, 'patient', d -> 'patient', 'contact_id', co.id, 'wa_id', p_wa, 'conversation_id', conv.id,
                  'source', 'whatsapp', 'status', 'held', 'reason', d ->> 'reason', 'urgency', d ->> 'urgency',
                  'plan_item_id', d ->> 'plan_item_id'));
      if (v_hold ->> 'ok')::boolean then
        dr.hold_id := (v_hold -> 'appointment' ->> 'id')::bigint;
        d := d || jsonb_build_object('service_id', v_hold -> 'appointment' ->> 'service_id',
                                     'location_id', v_hold -> 'appointment' ->> 'location_id',
                                     'slot', jsonb_build_object('label_ar', v_hold -> 'appointment' ->> 'when',
                                                                'starts_at', v_hold -> 'appointment' ->> 'starts_at',
                                                                'kind', v_hold -> 'appointment' ->> 'mode'));
        v_changed := true;
      else
        dr.hold_id := null;
        d := d - 'slot';
        problems := problems || jsonb_build_object('problem', v_hold ->> 'error', 'fact', v_hold ->> 'fact',
                                                   'suggested', v_hold -> 'suggested', 'none_because', v_hold -> 'none_because');
      end if;
    end if;
  end if;

  update clinic.booking_drafts
     set data = d, hold_id = dr.hold_id, updated_at = now(),
         changed_at = case when v_changed then clock_timestamp() else changed_at end
   where tenant_id = p_tenant and wa_id = p_wa
  returning * into dr;

  -- ---- what is still missing ----------------------------------------------------------
  if dr.hold_id is not null then select * into a from clinic.appointments where id = dr.hold_id; end if;
  if a.id is not null and (a.status <> 'held' or a.hold_expires_at < now()) then
    a := null; d := d - 'slot';
    update clinic.booking_drafts set hold_id = null, data = d where tenant_id = p_tenant and wa_id = p_wa returning * into dr;
    problems := problems || jsonb_build_object('problem', 'HOLD_EXPIRED', 'fact', 'the time was held too long — find_slots again');
  end if;
  if (d -> 'patient' ->> 'patient_id') is null then
    if coalesce(d -> 'patient' ->> 'full_name', '') = '' then
      missing := missing || case when jsonb_array_length(known) > 0 then 'who_is_it_for (one of known_patients, or a new name)' else 'patient_full_name' end;
    end if;
    if (st -> 'booking' -> 'new_patient_fields') ? 'age' and coalesce(d -> 'patient' ->> 'age', '') = '' then missing := missing || 'patient_age'::text; end if;
  end if;
  if d ->> 'doctor_id' is null then missing := missing || 'doctor'::text; end if;
  if a.id is null then missing := missing || 'time (find_slots, then update with option)'::text; end if;

  -- ---- summary ----------------------------------------------------------------------
  if v_action = 'summary' then
    if cardinality(missing) > 0 then
      return jsonb_build_object('ok', false, 'error', 'NOT_READY', 'missing', to_jsonb(missing), 'problems', problems, 'draft', d);
    end if;
    update clinic.booking_drafts set summary_at = clock_timestamp() where tenant_id = p_tenant and wa_id = p_wa;
    v_res := clinic.booking_price(a.service_id, a.doctor_id, a.location_id, nullif(d -> 'patient' ->> 'patient_id', '')::bigint);
    return jsonb_build_object('ok', true, 'status', 'SUMMARY_READY',
      'summary_text', case when v_lang = 'en' then
           format(E'%s with %s\n%s — %s\nFor: %s\nPrice: %s%s', coalesce((select coalesce(name_en, name_ar) from clinic.services where id = (v_res ->> 'service_id')::uuid), 'Visit'),
                  clinic.doctor_label(a.doctor_id, 'en'), clinic.appt_when(a, 'en'), clinic.location_label(a.location_id, 'en'),
                  coalesce((select full_name from clinic.patients where id = nullif(d -> 'patient' ->> 'patient_id', '')::bigint), d -> 'patient' ->> 'full_name'),
                  v_res ->> 'text_en', case when (v_res ->> 'is_follow_up')::boolean then ' (follow-up)' else '' end)
         else
           format(E'%s مع %s\n%s — %s\nالحجز لـ: %s\nالسعر: %s%s', coalesce((select name_ar from clinic.services where id = (v_res ->> 'service_id')::uuid), 'كشف'),
                  clinic.doctor_label(a.doctor_id, 'ar'), clinic.appt_when(a, 'ar'), clinic.location_label(a.location_id, 'ar'),
                  coalesce((select full_name from clinic.patients where id = nullif(d -> 'patient' ->> 'patient_id', '')::bigint), d -> 'patient' ->> 'full_name'),
                  v_res ->> 'text_ar', case when (v_res ->> 'is_follow_up')::boolean then ' (إعادة)' else '' end) end,
      'price', v_res, 'hold_expires_at', a.hold_expires_at);
  end if;

  -- ---- book ---------------------------------------------------------------------------
  if v_action = 'book' then
    if cardinality(missing) > 0 then
      return jsonb_build_object('ok', false, 'error', 'NOT_READY', 'missing', to_jsonb(missing), 'problems', problems);
    end if;
    if dr.summary_at is null or dr.summary_at < dr.changed_at then
      return jsonb_build_object('ok', false, 'error', 'SUMMARY_NOT_CONFIRMED',
                                'fact', 'show the summary (action summary) and get a yes before booking');
    end if;
    v_pat := clinic.resolve_patient(p_tenant, co.id, coalesce(d -> 'patient', '{}'::jsonb) || jsonb_build_object('created_via', 'whatsapp'));
    if v_pat is null then return jsonb_build_object('ok', false, 'error', 'NOT_READY', 'missing', jsonb_build_array('patient_full_name')); end if;
    v_res := clinic.confirm_hold(a.id, v_pat, d ->> 'reason');
    if not (v_res ->> 'ok')::boolean then
      update clinic.booking_drafts set hold_id = null, data = d - 'slot' where tenant_id = p_tenant and wa_id = p_wa;
      return v_res || jsonb_build_object('fact', 'the held time lapsed — find_slots again and offer');
    end if;
    delete from clinic.booking_drafts where tenant_id = p_tenant and wa_id = p_wa;
    update clinic.conversations set state = state - 'last_offered' where id = conv.id;
    select * into a from clinic.appointments where id = a.id;
    return v_res || jsonb_build_object('status', 'BOOKED',
      'location', (select jsonb_build_object('name', l.name_ar, 'address', l.address_ar, 'directions', l.directions_ar,
                                             'maps_url', l.maps_url, 'lat', l.lat, 'lng', l.lng)
                     from clinic.locations l where l.id = a.location_id),
      'prep', (select case when v_lang = 'en' then coalesce(prep_en, prep_ar) else prep_ar end from clinic.services where id = a.service_id),
      'fact', 'booked — give the booking number, the day and time, the place; the reminders go out by themselves');
  end if;

  -- ---- join the waitlist -----------------------------------------------------------------
  if v_action = 'join_waitlist' then
    insert into clinic.waitlist (tenant_id, patient_id, contact_id, wa_id, doctor_id, location_id, service_id, to_date, band)
    values (p_tenant, v_pat, co.id, p_wa, v_doc, v_loc, v_svc, nullif(v ->> 'to', '')::date,
            case when v ->> 'band' in ('morning', 'afternoon', 'evening') then v ->> 'band' else 'any' end);
    return jsonb_build_object('ok', true, 'status', 'ON_WAITLIST', 'fact', 'they get a message the moment an earlier time frees up');
  end if;

  -- ---- update -----------------------------------------------------------------------------
  return jsonb_build_object('ok', jsonb_array_length(problems) = 0, 'status', case when v_changed then 'SAVED' else 'UNCHANGED' end,
                            'draft', d - 'last_offered', 'held', case when a.id is not null then clinic.appointment_view(a, v_lang) end,
                            'missing', to_jsonb(missing), 'problems', problems,
                            'ready_for_summary', cardinality(missing) = 0, 'known_patients', known, 'upcoming', upcoming);
end $$;
