-- =====================================================================
-- Everwake Clinic · 007 · reminders, "the doctor is late", cancelled
-- sessions, the doctor's WhatsApp commands, and housekeeping
--
-- Reminders. Each booking gets its reminders when it is made (default:
-- the evening before at 19:00, and 3 hours before; Settings → Reminders).
-- They ask the patient to confirm (1), change (2) or cancel (3); the agent
-- reads the reply knowing which appointment it was about. Still not
-- confirmed a while after the last one → an "at risk" alert.
--
-- "I'll be 20 minutes late". announce_delay() first shows who is affected
-- (preview), then moves every appointment of that session that has not
-- arrived, tells each patient the new time (3 seconds apart) with the
-- choice to accept, pick another time or cancel, and blocks the late
-- minutes for new bookings. A patient who does not answer is reminded
-- once — sooner when their visit is near:
--     wait = clamp(0.4 × (time to their original start), 10, 90) minutes,
--            and never later than 30 minutes before that start
-- — then shown on the dashboard as "no reply". A second notice adds up.
--
-- cancel_session() does the same for a session that cannot happen: each
-- patient is offered their two nearest times, and "1" or "2" books it.
--
-- staff_tool() is what the doctor (or the front desk) reaches from their
-- own WhatsApp number: today's list, a delay, a cancelled session, time
-- off, and changes to services, prices, offers, answers and rules.
-- Everything is shown first and done only after "تمام".
-- =====================================================================

create table clinic.appointment_reminders (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references clinic.tenants(id) on delete cascade,
  appointment_id bigint not null references clinic.appointments(id) on delete cascade,
  seq            int not null,
  key            text not null,
  due_at         timestamptz not null,
  status         text not null default 'scheduled' check (status in ('scheduled', 'sent', 'skipped', 'cancelled')),
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index appointment_reminders_due_idx on clinic.appointment_reminders (due_at) where status = 'scheduled';
create index appointment_reminders_appt_idx on clinic.appointment_reminders (appointment_id);

create table clinic.delay_notices (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references clinic.tenants(id) on delete cascade,
  doctor_id       uuid not null references clinic.doctors(id) on delete cascade,
  location_id     uuid references clinic.locations(id) on delete cascade,
  session_date    date not null,
  kind            text not null default 'delay' check (kind in ('delay', 'cancel_session')),
  minutes         int not null default 0,
  from_at         timestamptz,
  reason          text,
  status          text not null default 'sent' check (status in ('sent', 'cancelled')),
  via             text not null default 'dashboard' check (via in ('dashboard', 'whatsapp', 'assistant')),
  created_by      uuid,
  created_by_name text,
  counts          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz not null default now()
);
create index delay_notices_day_idx on clinic.delay_notices (tenant_id, session_date, doctor_id);

create table clinic.delay_notice_items (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references clinic.tenants(id) on delete cascade,
  notice_id      bigint not null references clinic.delay_notices(id) on delete cascade,
  appointment_id bigint not null references clinic.appointments(id) on delete cascade,
  wa_id          text,
  old_at         timestamptz,
  new_at         timestamptz,
  status         text not null default 'sent'
                 check (status in ('sent', 'accepted', 'changed', 'cancelled', 'no_reply', 'skipped')),
  reply_due_at   timestamptz,
  followed_up_at timestamptz,
  replied_at     timestamptz,
  options        jsonb,
  created_at     timestamptz not null default now()
);
create index delay_notice_items_due_idx on clinic.delay_notice_items (reply_due_at) where status = 'sent';
create index delay_notice_items_notice_idx on clinic.delay_notice_items (notice_id);

-- ---------------------------------------------------------------------
-- Reminders
-- ---------------------------------------------------------------------
create or replace function clinic.schedule_reminders(p_appt bigint)
returns int language plpgsql as $$
declare
  a      clinic.appointments%rowtype;
  st     jsonb;
  tz     text;
  r      jsonb;
  v_due  timestamptz;
  v_at   timestamptz;
  v_min  int;
  n      int := 0;
  v_seq  int := 0;
begin
  select * into a from clinic.appointments where id = p_appt;
  if a.status not in ('booked', 'confirmed') then return 0; end if;
  select clinic.merged_settings(settings), timezone into st, tz from clinic.tenants where id = a.tenant_id;
  v_at := coalesce(a.est_at, a.starts_at);
  v_min := coalesce((st ->> 'reminder_min_lead_minutes')::int, 45);
  delete from clinic.appointment_reminders where appointment_id = a.id and status = 'scheduled';
  for r in select * from jsonb_array_elements(coalesce(st -> 'reminders', '[]'::jsonb)) loop
    v_seq := v_seq + 1;
    v_due := case r ->> 'kind'
               when 'day_before' then ((a.session_date - 1) + coalesce(nullif(r ->> 'at', ''), '19:00')::time) at time zone tz
               when 'hours_before' then v_at - make_interval(mins => (coalesce((r ->> 'hours')::numeric, 3) * 60)::int)
               when 'same_day' then (a.session_date + coalesce(nullif(r ->> 'at', ''), '09:00')::time) at time zone tz
             end;
    if v_due is null or v_due <= now() or v_at - v_due < make_interval(mins => v_min) then continue; end if;
    -- two reminders an hour apart help nobody: keep the later one
    if exists (select 1 from clinic.appointment_reminders x where x.appointment_id = a.id and x.status = 'scheduled'
                and abs(extract(epoch from x.due_at - v_due)) < 3600) then
      delete from clinic.appointment_reminders x where x.appointment_id = a.id and x.status = 'scheduled'
         and abs(extract(epoch from x.due_at - v_due)) < 3600 and x.due_at < v_due;
      if exists (select 1 from clinic.appointment_reminders x where x.appointment_id = a.id and x.status = 'scheduled'
                  and abs(extract(epoch from x.due_at - v_due)) < 3600) then continue; end if;
    end if;
    insert into clinic.appointment_reminders (tenant_id, appointment_id, seq, key, due_at)
    values (a.tenant_id, a.id, v_seq, coalesce(r ->> 'key', r ->> 'kind'), v_due);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function clinic.reminders_due()
returns int language plpgsql as $$
declare
  r      record;
  st     jsonb;
  v_lang text;
  v_tpl  text;
  n      int := 0;
  q      jsonb;
begin
  for r in
    select ar.id as rid, ar.key, a.*
      from clinic.appointment_reminders ar join clinic.appointments a on a.id = ar.appointment_id
     where ar.status = 'scheduled' and ar.due_at <= now()
     order by ar.due_at
     for update of ar skip locked
     limit 200
  loop
    if r.status not in ('booked', 'confirmed') or r.wa_id is null
       or coalesce(r.est_at, r.starts_at) < now() + interval '15 minutes' then
      update clinic.appointment_reminders set status = 'skipped' where id = r.rid;
      continue;
    end if;
    select clinic.merged_settings(settings) into st from clinic.tenants where id = r.tenant_id;
    v_lang := clinic.contact_language(r.tenant_id, r.wa_id);
    v_tpl := st -> 'templates' ->> ('reminder_' || r.key || '_' || v_lang);
    if v_tpl is null then v_tpl := st -> 'templates' ->> ('reminder_day_before_' || v_lang); end if;
    q := clinic.queue_message(r.tenant_id, r.wa_id, 'reminder',
           clinic.render_template(v_tpl, clinic.message_vars((select x from clinic.appointments x where x.id = r.id), v_lang)),
           p_template => 'reminder_' || r.key, p_meta => jsonb_build_object('appointment_id', r.id, 'reminder_id', r.rid));
    update clinic.appointment_reminders set status = case when q ? 'outbox_id' then 'sent' else 'skipped' end, sent_at = now() where id = r.rid;
    if q ? 'outbox_id' then
      update clinic.conversations set state = state || jsonb_build_object('pending_reminder',
               jsonb_build_object('appointment_id', r.id, 'ref_no', r.ref_no, 'key', r.key, 'at', now()))
       where tenant_id = r.tenant_id and wa_id = r.wa_id;
      perform clinic.log_appt(r.id, 'reminder_sent', jsonb_build_object('key', r.key), 'system');
      n := n + 1;
    end if;
  end loop;

  -- not confirmed a while after the last reminder → "at risk"
  for r in
    select a.*, clinic.merged_settings(t.settings) as st
      from clinic.appointments a join clinic.tenants t on t.id = a.tenant_id
     where a.status = 'booked' and a.at_risk_alerted_at is null and a.starts_at > now()
       and exists (select 1 from clinic.appointment_reminders x where x.appointment_id = a.id and x.status = 'sent')
       and not exists (select 1 from clinic.appointment_reminders x where x.appointment_id = a.id and x.status = 'scheduled')
       and (select max(x.sent_at) from clinic.appointment_reminders x where x.appointment_id = a.id)
           < now() - make_interval(mins => coalesce((clinic.merged_settings(t.settings) ->> 'at_risk_after_minutes')::int, 45))
     limit 100
  loop
    update clinic.appointments set at_risk_alerted_at = now() where id = r.id;
    perform clinic.raise_alert(jsonb_build_object('tenant_id', r.tenant_id, 'kind', 'at_risk', 'appointment_id', r.id,
      'title', 'ميعاد لسه متأكدش', 'body', coalesce((select full_name from clinic.patients where id = r.patient_id), 'مريض') || ' — '
                                          || clinic.appt_when((select x from clinic.appointments x where x.id = r.id), 'ar', true)));
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- The doctor is late
-- p = {doctor_id | doctor, location_id?, date?, minutes, from_time?, reason?, preview?, via?, by_name?}
-- ---------------------------------------------------------------------
create or replace function clinic.resolve_doctor(p_tenant uuid, p jsonb)
returns uuid language plpgsql stable as $$
declare v uuid := nullif(p ->> 'doctor_id', '')::uuid;
begin
  if v is null and nullif(p ->> 'doctor', '') is not null then v := clinic.match_doctor(p_tenant, p ->> 'doctor'); end if;
  if v is null and (select count(*) from clinic.doctors where tenant_id = p_tenant and is_active) = 1 then
    select id into v from clinic.doctors where tenant_id = p_tenant and is_active;
  end if;
  return v;
end $$;

create or replace function clinic.reply_wait(p_tenant uuid, p_original timestamptz)
returns timestamptz language plpgsql stable as $$
declare
  st    jsonb := (select clinic.merged_settings(settings) -> 'delay' from clinic.tenants where id = p_tenant);
  v_left numeric := greatest(extract(epoch from p_original - now()) / 60, 0);
  v_wait numeric;
  v_due timestamptz;
begin
  v_wait := least(greatest(v_left * coalesce((st ->> 'reply_share')::numeric, 0.4), coalesce((st ->> 'reply_min_minutes')::numeric, 10)),
                  coalesce((st ->> 'reply_max_minutes')::numeric, 90));
  v_due := now() + make_interval(mins => v_wait::int);
  if v_due > p_original - make_interval(mins => coalesce((st ->> 'before_start_minutes')::int, 30)) then
    v_due := greatest(p_original - make_interval(mins => coalesce((st ->> 'before_start_minutes')::int, 30)),
                      now() + make_interval(mins => coalesce((st ->> 'reply_min_minutes')::int, 10)));
  end if;
  return v_due;
end $$;

create or replace function clinic.announce_delay(p_tenant uuid, p jsonb)
returns jsonb language plpgsql as $$
declare
  t        clinic.tenants%rowtype;
  st       jsonb;
  tz       text;
  v_doc    uuid := clinic.resolve_doctor(p_tenant, p);
  v_loc    uuid := nullif(p ->> 'location_id', '')::uuid;
  v_date   date := coalesce(nullif(p ->> 'date', '')::date, clinic.local_today(p_tenant));
  v_min    int := nullif(regexp_replace(coalesce(p ->> 'minutes', ''), '\D', '', 'g'), '')::int;
  v_from   timestamptz;
  v_prev   boolean := coalesce((p ->> 'preview')::boolean, false);
  a        clinic.appointments%rowtype;
  v_items  jsonb := '[]'::jsonb;
  v_notice bigint;
  v_item   bigint;
  v_lang   text;
  n        int := 0;
  v_sent   int := 0;
  v_old    timestamptz;
  v_due    timestamptz;
begin
  select * into t from clinic.tenants where id = p_tenant;
  st := clinic.merged_settings(t.settings);
  tz := t.timezone;
  if v_doc is null then
    return jsonb_build_object('ok', false, 'error', 'WHICH_DOCTOR',
      'doctors', (select jsonb_agg(clinic.doctor_label(id, 'ar')) from clinic.doctors where tenant_id = p_tenant and is_active));
  end if;
  if v_min is null or v_min < 5 or v_min > 240 then
    return jsonb_build_object('ok', false, 'error', 'MINUTES_NEEDED', 'fact', 'how many minutes late (5 to 240)?');
  end if;
  if nullif(p ->> 'location', '') is not null then v_loc := clinic.match_location(p_tenant, p ->> 'location'); end if;
  if nullif(p ->> 'from_time', '') is not null then v_from := (v_date + (p ->> 'from_time')::time) at time zone tz; end if;

  for a in
    select * from clinic.appointments x
     where x.tenant_id = p_tenant and x.doctor_id = v_doc and x.session_date = v_date
       and x.status in ('booked', 'confirmed') and (v_loc is null or x.location_id = v_loc)
       and (v_from is null or coalesce(x.est_at, x.starts_at) >= v_from)
     order by coalesce(x.est_at, x.starts_at)
  loop
    v_items := v_items || jsonb_build_object('appointment_id', a.id, 'ref_no', a.ref_no,
      'patient', (select full_name from clinic.patients where id = a.patient_id),
      'old_time', to_char(coalesce(a.est_at, a.starts_at) at time zone tz, 'HH24:MI'),
      'new_time', to_char((coalesce(a.est_at, a.starts_at) + make_interval(mins => v_min)) at time zone tz, 'HH24:MI'),
      'queue_no', a.queue_no, 'whatsapp', a.wa_id is not null);
  end loop;

  if v_prev then
    return jsonb_build_object('ok', true, 'status', 'PREVIEW', 'doctor', clinic.doctor_label(v_doc, 'ar'), 'date', v_date,
                              'minutes', v_min, 'count', jsonb_array_length(v_items), 'items', v_items,
                              'fact', format('%s patients would be told the new time — send only after a yes', jsonb_array_length(v_items)));
  end if;

  insert into clinic.delay_notices (tenant_id, doctor_id, location_id, session_date, kind, minutes, from_at, reason, via,
                                    created_by, created_by_name)
  values (p_tenant, v_doc, v_loc, v_date, 'delay', v_min, v_from, nullif(btrim(coalesce(p ->> 'reason', '')), ''),
          coalesce(nullif(p ->> 'via', ''), 'dashboard'), clinic.current_user_id(), coalesce(nullif(p ->> 'by_name', ''), clinic.my_name(p_tenant)))
  returning id into v_notice;

  -- everyone moves together; the overlap checks run at the end
  set constraints clinic.appointments_doctor_free, clinic.appointments_resource_free deferred;
  for a in
    select * from clinic.appointments x
     where x.tenant_id = p_tenant and x.doctor_id = v_doc and x.session_date = v_date
       and x.status in ('booked', 'confirmed', 'held') and (v_loc is null or x.location_id = v_loc)
       and (v_from is null or coalesce(x.est_at, x.starts_at) >= v_from)
     order by coalesce(x.est_at, x.starts_at) desc
  loop
    v_old := coalesce(a.original_starts_at, a.est_at, a.starts_at);
    update clinic.appointments
       set starts_at = case when mode = 'slot' then starts_at + make_interval(mins => v_min) else starts_at end,
           ends_at = case when mode = 'slot' then ends_at + make_interval(mins => v_min) else ends_at end,
           est_at = coalesce(est_at, starts_at) + make_interval(mins => v_min),
           original_starts_at = coalesce(original_starts_at, est_at, starts_at),
           delay_minutes = delay_minutes + v_min
     where id = a.id returning * into a;
    if a.status = 'held' then continue; end if;
    perform clinic.log_appt(a.id, 'delayed', jsonb_build_object('minutes', v_min, 'notice_id', v_notice));
    -- the reminders follow the new time
    update clinic.appointment_reminders set due_at = due_at + make_interval(mins => v_min)
     where appointment_id = a.id and status = 'scheduled' and key = 'hours_before';
    v_due := clinic.reply_wait(p_tenant, v_old);
    insert into clinic.delay_notice_items (tenant_id, notice_id, appointment_id, wa_id, old_at, new_at, status, reply_due_at)
    values (p_tenant, v_notice, a.id, a.wa_id, v_old, coalesce(a.est_at, a.starts_at),
            case when a.wa_id is null then 'skipped' else 'sent' end, case when a.wa_id is not null then v_due end)
    returning id into v_item;
    n := n + 1;
    if a.wa_id is not null then
      v_lang := clinic.contact_language(p_tenant, a.wa_id);
      perform clinic.queue_message(p_tenant, a.wa_id, 'delay_notice',
        clinic.render_template(st -> 'templates' ->> ('delay_notice_' || v_lang), clinic.message_vars(a, v_lang) || jsonb_build_object(
          'minutes', a.delay_minutes,
          'new_time', clinic.clock_text((coalesce(a.est_at, a.starts_at) at time zone tz)::time, v_lang),
          'old_time', clinic.clock_text((v_old at time zone tz)::time, v_lang))),
        p_not_before => now() + make_interval(secs => v_sent * 3), p_template => 'delay_notice',
        p_meta => jsonb_build_object('appointment_id', a.id, 'delay_item_id', v_item));
      update clinic.conversations set state = state || jsonb_build_object('pending_delay', jsonb_build_object(
               'item_id', v_item, 'appointment_id', a.id, 'ref_no', a.ref_no, 'minutes', a.delay_minutes,
               'new_time', to_char(coalesce(a.est_at, a.starts_at) at time zone tz, 'HH24:MI'),
               'old_time', to_char(v_old at time zone tz, 'HH24:MI'), 'at', now()))
       where tenant_id = p_tenant and wa_id = a.wa_id;
      v_sent := v_sent + 1;
    end if;
  end loop;
  update clinic.delay_notices set counts = jsonb_build_object('affected', n, 'messaged', v_sent) where id = v_notice;
  return jsonb_build_object('ok', true, 'status', 'SENT', 'notice_id', v_notice, 'doctor', clinic.doctor_label(v_doc, 'ar'),
                            'minutes', v_min, 'affected', n, 'messaged', v_sent, 'items', v_items,
                            'fact', format('%s patients are being told; you will see who accepted on the dashboard', v_sent));
end $$;

create or replace function clinic.delay_followups_due()
returns int language plpgsql as $$
declare
  r      record;
  st     jsonb;
  v_lang text;
  n      int := 0;
  tz     text;
begin
  for r in
    select i.id as iid, i.followed_up_at, i.new_at, i.wa_id as iwa, a.*
      from clinic.delay_notice_items i join clinic.appointments a on a.id = i.appointment_id
     where i.status = 'sent' and i.reply_due_at <= now()
     order by i.reply_due_at
     for update of i skip locked
     limit 200
  loop
    if r.status not in ('booked', 'confirmed') or coalesce(r.est_at, r.starts_at) < now() then
      update clinic.delay_notice_items set status = 'skipped' where id = r.iid;
      continue;
    end if;
    if r.status = 'confirmed' and r.confirmed_at > (select created_at from clinic.delay_notice_items where id = r.iid) then
      update clinic.delay_notice_items set status = 'accepted', replied_at = r.confirmed_at where id = r.iid;
      continue;
    end if;
    tz := clinic.tenant_tz(r.tenant_id);
    if r.followed_up_at is null then
      select clinic.merged_settings(settings) into st from clinic.tenants where id = r.tenant_id;
      v_lang := clinic.contact_language(r.tenant_id, r.iwa);
      perform clinic.queue_message(r.tenant_id, r.iwa, 'delay_followup',
        clinic.render_template(st -> 'templates' ->> ('delay_followup_' || v_lang),
          clinic.message_vars((select x from clinic.appointments x where x.id = r.id), v_lang)
          || jsonb_build_object('new_time', clinic.clock_text((coalesce(r.est_at, r.starts_at) at time zone tz)::time, v_lang))),
        p_template => 'delay_followup', p_meta => jsonb_build_object('appointment_id', r.id, 'delay_item_id', r.iid));
      update clinic.delay_notice_items
         set followed_up_at = now(),
             reply_due_at = greatest(least(now() + greatest(interval '10 minutes', (coalesce(r.est_at, r.starts_at) - now()) * 0.3),
                                           coalesce(r.est_at, r.starts_at) - interval '10 minutes'), now() + interval '5 minutes')
       where id = r.iid;
      n := n + 1;
    else
      update clinic.delay_notice_items set status = 'no_reply' where id = r.iid;
      perform clinic.raise_alert(jsonb_build_object('tenant_id', r.tenant_id, 'kind', 'no_reply', 'appointment_id', r.id,
        'body', coalesce((select full_name from clinic.patients where id = r.patient_id), 'مريض') || ' — '
                || to_char(coalesce(r.est_at, r.starts_at) at time zone tz, 'HH24:MI')));
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- A session that cannot happen: cancel it and offer each patient their two nearest times
-- ---------------------------------------------------------------------
create or replace function clinic.cancel_session(p_tenant uuid, p jsonb)
returns jsonb language plpgsql as $$
declare
  t        clinic.tenants%rowtype;
  st       jsonb;
  tz       text;
  v_doc    uuid := clinic.resolve_doctor(p_tenant, p);
  v_loc    uuid := nullif(p ->> 'location_id', '')::uuid;
  v_date   date := coalesce(nullif(p ->> 'date', '')::date, clinic.local_today(p_tenant));
  v_from   time := nullif(p ->> 'from_time', '')::time;
  v_prev   boolean := coalesce((p ->> 'preview')::boolean, false);
  v_reason text := nullif(btrim(coalesce(p ->> 'reason', '')), '');
  a        clinic.appointments%rowtype;
  v_items  jsonb := '[]'::jsonb;
  v_notice bigint;
  v_opts   jsonb;
  v_lang   text;
  v_txt    text;
  n        int := 0;
  v_sent   int := 0;
begin
  select * into t from clinic.tenants where id = p_tenant;
  st := clinic.merged_settings(t.settings);
  tz := t.timezone;
  if v_doc is null then return jsonb_build_object('ok', false, 'error', 'WHICH_DOCTOR'); end if;
  if nullif(p ->> 'location', '') is not null then v_loc := clinic.match_location(p_tenant, p ->> 'location'); end if;
  for a in select * from clinic.appointments x
            where x.tenant_id = p_tenant and x.doctor_id = v_doc and x.session_date = v_date
              and x.status in ('booked', 'confirmed') and (v_loc is null or x.location_id = v_loc)
              and (v_from is null or (coalesce(x.est_at, x.starts_at) at time zone tz)::time >= v_from)
            order by coalesce(x.est_at, x.starts_at) loop
    v_items := v_items || jsonb_build_object('appointment_id', a.id, 'ref_no', a.ref_no,
                 'patient', (select full_name from clinic.patients where id = a.patient_id),
                 'time', to_char(coalesce(a.est_at, a.starts_at) at time zone tz, 'HH24:MI'), 'whatsapp', a.wa_id is not null);
  end loop;
  if v_prev then
    return jsonb_build_object('ok', true, 'status', 'PREVIEW', 'doctor', clinic.doctor_label(v_doc, 'ar'), 'date', v_date,
                              'count', jsonb_array_length(v_items), 'items', v_items,
                              'fact', format('%s bookings would be cancelled, each patient offered their nearest times — only after a yes', jsonb_array_length(v_items)));
  end if;

  insert into clinic.schedule_exceptions (tenant_id, doctor_id, location_id, on_date, kind, start_time, end_time, reason, created_by)
  values (p_tenant, v_doc, v_loc, v_date, 'off', v_from, case when v_from is not null then '23:59'::time end, coalesce(v_reason, 'session cancelled'),
          clinic.current_user_id());
  insert into clinic.delay_notices (tenant_id, doctor_id, location_id, session_date, kind, reason, via, created_by, created_by_name)
  values (p_tenant, v_doc, v_loc, v_date, 'cancel_session', v_reason, coalesce(nullif(p ->> 'via', ''), 'dashboard'),
          clinic.current_user_id(), coalesce(nullif(p ->> 'by_name', ''), clinic.my_name(p_tenant)))
  returning id into v_notice;

  for a in select * from clinic.appointments x
            where x.tenant_id = p_tenant and x.doctor_id = v_doc and x.session_date = v_date
              and x.status in ('booked', 'confirmed') and (v_loc is null or x.location_id = v_loc)
              and (v_from is null or (coalesce(x.est_at, x.starts_at) at time zone tz)::time >= v_from)
            order by coalesce(x.est_at, x.starts_at) loop
    perform clinic.cancel_appointment(a.id, 'clinic', coalesce(v_reason, 'the doctor cancelled the session'), false);
    n := n + 1;
    if a.wa_id is null then continue; end if;
    v_opts := clinic.available_slots(p_tenant, jsonb_build_object('doctor_id', v_doc, 'service_id', a.service_id,
                                     'patient_id', a.patient_id, 'from', v_date, 'limit', 40)) -> 'suggested';
    select coalesce(jsonb_agg(x || jsonb_build_object('option', k)), '[]'::jsonb) into v_opts
      from jsonb_array_elements(v_opts) with ordinality as s(x, k) where k <= 2;
    v_lang := clinic.contact_language(p_tenant, a.wa_id);
    select string_agg(format(E'\n%s) %s', x ->> 'option', x ->> case when v_lang = 'en' then 'label_en' else 'label_ar' end), '')
      into v_txt from jsonb_array_elements(v_opts) x;
    perform clinic.queue_message(p_tenant, a.wa_id, 'session_cancelled',
      clinic.render_template(st -> 'templates' ->> ('session_cancelled_' || v_lang), clinic.message_vars(a, v_lang) || jsonb_build_object(
        'reason', case when v_reason is not null then ' (' || v_reason || ')' else '' end,
        'options', coalesce(v_txt, case when v_lang = 'en' then ' (tell us a day that suits you)' else ' (قولنا يوم يناسبك)' end))),
      p_not_before => now() + make_interval(secs => v_sent * 3), p_template => 'session_cancelled',
      p_meta => jsonb_build_object('appointment_id', a.id, 'notice_id', v_notice));
    insert into clinic.delay_notice_items (tenant_id, notice_id, appointment_id, wa_id, old_at, status, options)
    values (p_tenant, v_notice, a.id, a.wa_id, coalesce(a.est_at, a.starts_at), 'sent', v_opts);
    -- "1" / "2" books one: the booking in progress already has the doctor, the service, the patient and the options
    insert into clinic.booking_drafts as b (tenant_id, wa_id, data)
    values (p_tenant, a.wa_id, jsonb_build_object('doctor_id', v_doc, 'service_id', a.service_id, 'location_id', a.location_id,
                                                 'patient', jsonb_build_object('patient_id', a.patient_id), 'reason', a.reason,
                                                 'last_offered', v_opts, 'replacing', a.ref_no))
    on conflict (tenant_id, wa_id) do update set data = excluded.data, changed_at = clock_timestamp(), summary_at = null, updated_at = now();
    update clinic.conversations set state = state || jsonb_build_object('last_offered', v_opts, 'pending_reschedule',
             jsonb_build_object('cancelled_ref', a.ref_no, 'options', v_opts, 'at', now()))
     where tenant_id = p_tenant and wa_id = a.wa_id;
    v_sent := v_sent + 1;
  end loop;
  update clinic.delay_notices set counts = jsonb_build_object('affected', n, 'messaged', v_sent) where id = v_notice;
  return jsonb_build_object('ok', true, 'status', 'CANCELLED', 'notice_id', v_notice, 'affected', n, 'messaged', v_sent,
                            'fact', format('%s bookings cancelled; %s patients offered new times', n, v_sent));
end $$;

-- time off (a few hours or a day) — bookings already there are listed, not cancelled
create or replace function clinic.block_time(p_tenant uuid, p jsonb)
returns jsonb language plpgsql as $$
declare
  tz     text := clinic.tenant_tz(p_tenant);
  v_doc  uuid := clinic.resolve_doctor(p_tenant, p);
  v_loc  uuid := nullif(p ->> 'location_id', '')::uuid;
  v_date date := nullif(p ->> 'date', '')::date;
  v_to_date date := coalesce(nullif(p ->> 'to_date', '')::date, nullif(p ->> 'date', '')::date);
  v_from time := nullif(p ->> 'from_time', '')::time;
  v_to   time := nullif(p ->> 'to_time', '')::time;
  v_n    int;
  d      date;
begin
  if v_doc is null then return jsonb_build_object('ok', false, 'error', 'WHICH_DOCTOR'); end if;
  if v_date is null then return jsonb_build_object('ok', false, 'error', 'DATE_NEEDED'); end if;
  if v_to_date < v_date or v_to_date - v_date > 60 then return jsonb_build_object('ok', false, 'error', 'BAD_RANGE'); end if;
  select count(*) into v_n from clinic.appointments a
   where a.doctor_id = v_doc and a.session_date between v_date and v_to_date and a.status in ('booked', 'confirmed')
     and (v_loc is null or a.location_id = v_loc)
     and (v_from is null or (coalesce(a.est_at, a.starts_at) at time zone tz)::time >= v_from)
     and (v_to is null or (coalesce(a.est_at, a.starts_at) at time zone tz)::time < v_to);
  if coalesce((p ->> 'preview')::boolean, false) then
    return jsonb_build_object('ok', true, 'status', 'PREVIEW', 'doctor', clinic.doctor_label(v_doc, 'ar'), 'from', v_date, 'to', v_to_date,
                              'hours', case when v_from is not null then v_from::text || '–' || coalesce(v_to::text, 'end') end,
                              'bookings_inside', v_n,
                              'fact', case when v_n > 0 then format('%s bookings are already inside that time — they stay until cancelled', v_n)
                                           else 'no bookings inside' end);
  end if;
  d := v_date;
  while d <= v_to_date loop
    insert into clinic.schedule_exceptions (tenant_id, doctor_id, location_id, on_date, kind, start_time, end_time, reason, created_by)
    values (p_tenant, v_doc, v_loc, d, 'off', v_from, coalesce(v_to, case when v_from is not null then '23:59'::time end),
            nullif(p ->> 'reason', ''), clinic.current_user_id());
    d := d + 1;
  end loop;
  return jsonb_build_object('ok', true, 'status', 'BLOCKED', 'bookings_inside', v_n,
                            'fact', 'no new bookings in that time' || case when v_n > 0 then format(' — %s existing bookings still need a decision', v_n) else '' end);
end $$;

-- ---------------------------------------------------------------------
-- When a visit is done: the patient's numbers, aftercare, the plan's next session
-- ---------------------------------------------------------------------
create or replace function clinic.appointment_done(p_appt bigint)
returns void language plpgsql as $$
declare
  a      clinic.appointments%rowtype;
  st     jsonb;
  s      clinic.services%rowtype;
  v_lang text;
  i      clinic.treatment_plan_items%rowtype;
  v_next jsonb;
  v_opts jsonb;
  v_txt  text;
begin
  select * into a from clinic.appointments where id = p_appt;
  if a.patient_id is not null then
    update clinic.patients set visits_count = visits_count + 1, last_visit_at = coalesce(a.visit_started_at, a.starts_at),
                               first_visit_at = coalesce(first_visit_at, coalesce(a.visit_started_at, a.starts_at))
     where id = a.patient_id;
  end if;
  select clinic.merged_settings(settings) into st from clinic.tenants where id = a.tenant_id;
  select * into s from clinic.services where id = a.service_id;
  if a.wa_id is not null and coalesce((st ->> 'aftercare_messages')::boolean, true) and coalesce(s.aftercare_ar, s.aftercare_en, '') <> '' then
    v_lang := clinic.contact_language(a.tenant_id, a.wa_id);
    perform clinic.queue_message(a.tenant_id, a.wa_id, 'aftercare',
      clinic.render_template(st -> 'templates' ->> ('aftercare_' || v_lang), clinic.message_vars(a, v_lang)
        || jsonb_build_object('aftercare', case when v_lang = 'en' then coalesce(s.aftercare_en, s.aftercare_ar) else coalesce(s.aftercare_ar, s.aftercare_en) end)),
      p_not_before => now() + interval '20 minutes', p_template => 'aftercare', p_meta => jsonb_build_object('appointment_id', a.id));
  end if;
  -- a treatment plan session
  if a.plan_item_id is not null then
    update clinic.treatment_plan_items
       set done_sessions = done_sessions + 1,
           status = case when done_sessions + 1 >= sessions then 'done' else 'in_progress' end
     where id = a.plan_item_id returning * into i;
    update clinic.treatment_plans pl
       set status = case when not exists (select 1 from clinic.treatment_plan_items x where x.plan_id = pl.id and x.status not in ('done', 'cancelled'))
                         then 'done' else 'in_progress' end
     where pl.id = i.plan_id;
    v_next := clinic.plan_next(i.plan_id);
    if v_next is not null and a.wa_id is not null then
      v_opts := clinic.available_slots(a.tenant_id, jsonb_build_object('doctor_id', v_next ->> 'doctor_id', 'service_id', v_next ->> 'service_id',
                                       'patient_id', a.patient_id, 'from', v_next ->> 'earliest', 'limit', 40)) -> 'suggested';
      select coalesce(jsonb_agg(x || jsonb_build_object('option', k)), '[]'::jsonb) into v_opts
        from jsonb_array_elements(v_opts) with ordinality as s2(x, k) where k <= 2;
      v_lang := clinic.contact_language(a.tenant_id, a.wa_id);
      select string_agg(format(E'\n%s) %s', x ->> 'option', x ->> case when v_lang = 'en' then 'label_en' else 'label_ar' end), '')
        into v_txt from jsonb_array_elements(v_opts) x;
      if v_txt is not null then
        perform clinic.queue_message(a.tenant_id, a.wa_id, 'plan_next',
          case when v_lang = 'en' then format(E'The next session (%s, %s of %s) — shall we book one of these?%s\nReply with the number, or tell us another day.',
                                              v_next ->> 'label', v_next ->> 'session', v_next ->> 'of', v_txt)
               else format(E'الجلسة الجاية (%s — %s من %s). نحجزلك واحد من دول؟%s\nابعت رقم الميعاد أو قولنا يوم تاني.',
                           v_next ->> 'label', v_next ->> 'session', v_next ->> 'of', v_txt) end,
          p_not_before => now() + interval '30 minutes', p_template => 'plan_next', p_meta => jsonb_build_object('plan_id', i.plan_id));
        insert into clinic.booking_drafts as b (tenant_id, wa_id, data)
        values (a.tenant_id, a.wa_id, jsonb_build_object('doctor_id', v_next ->> 'doctor_id', 'service_id', v_next ->> 'service_id',
                                                        'patient', jsonb_build_object('patient_id', a.patient_id),
                                                        'plan_item_id', (v_next ->> 'item_id')::bigint, 'last_offered', v_opts,
                                                        'reason', (v_next ->> 'label') || ' — ' || (v_next ->> 'session') || '/' || (v_next ->> 'of')))
        on conflict (tenant_id, wa_id) do update set data = excluded.data, changed_at = clock_timestamp(), summary_at = null, hold_id = null;
        update clinic.conversations set state = state || jsonb_build_object('last_offered', v_opts, 'pending_plan_session', v_next)
         where tenant_id = a.tenant_id and wa_id = a.wa_id;
      end if;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- The doctor's (or the front desk's) own WhatsApp
-- p_staff = intake's `staff` ({kind, user_id, role, doctor_id, clinical, name})
-- actions: today · delay · cancel_session · block_time · catalog · confirm · discard · undo · patient
-- ---------------------------------------------------------------------
create or replace function clinic.staff_tool(p_tenant uuid, p_wa text, p_staff jsonb, p_action text, p_details text)
returns jsonb language plpgsql as $$
declare
  tz       text := clinic.tenant_tz(p_tenant);
  v        jsonb;
  v_action text := lower(btrim(coalesce(p_action, '')));
  conv     clinic.conversations%rowtype;
  v_pend   jsonb;
  v_res    jsonb;
  v_role   text := coalesce(p_staff ->> 'role', 'receptionist');
  v_doc    uuid;
  v_date   date;
begin
  begin
    v := coalesce(nullif(btrim(coalesce(p_details, '')), '')::jsonb, '{}'::jsonb);
  exception when others then v := '{}'::jsonb;
  end;
  if jsonb_typeof(v) <> 'object' then v := '{}'::jsonb; end if;
  select * into conv from clinic.conversations where tenant_id = p_tenant and wa_id = p_wa;
  v_pend := conv.state -> 'staff_pending';
  -- "my" schedule: a doctor's own number means their own sessions unless they name another doctor
  v_doc := coalesce(case when nullif(v ->> 'doctor', '') is not null then clinic.match_doctor(p_tenant, v ->> 'doctor') end,
                    nullif(p_staff ->> 'doctor_id', '')::uuid);
  v_date := coalesce(nullif(v ->> 'date', '')::date, clinic.local_today(p_tenant));

  if v_action = 'today' then
    return jsonb_build_object('ok', true, 'date', v_date,
      'appointments', coalesce((select jsonb_agg(jsonb_build_object(
                          'time', to_char(coalesce(a.est_at, a.starts_at) at time zone tz, 'HH24:MI'), 'queue_no', a.queue_no,
                          'patient', p.full_name, 'service', s.name_ar, 'status', a.status, 'doctor', clinic.doctor_label(a.doctor_id, 'ar'),
                          'reason', case when coalesce((p_staff ->> 'clinical')::boolean, false) then a.reason end,
                          'new', a.is_new_patient, 'delay', a.delay_minutes) order by coalesce(a.est_at, a.starts_at))
                          from clinic.appointments a left join clinic.patients p on p.id = a.patient_id
                          left join clinic.services s on s.id = a.service_id
                         where a.tenant_id = p_tenant and a.session_date = v_date
                           and a.status in ('booked', 'confirmed', 'arrived', 'in_visit', 'done', 'no_show')
                           and (v_doc is null or a.doctor_id = v_doc)), '[]'::jsonb),
      'sessions', coalesce((select jsonb_agg(jsonb_build_object('doctor', clinic.doctor_label(x.doctor_id, 'ar'),
                              'location', clinic.location_label(x.location_id, 'ar'),
                              'from', to_char(x.starts_at at time zone tz, 'HH24:MI'), 'to', to_char(x.ends_at at time zone tz, 'HH24:MI'), 'mode', x.mode))
                              from clinic.doctor_sessions(p_tenant, v_date, v_date, v_doc) x), '[]'::jsonb));
  end if;

  if v_action in ('delay', 'cancel_session', 'block_time') then
    v := v || jsonb_build_object('doctor_id', v_doc, 'preview', true, 'via', 'whatsapp', 'by_name', p_staff ->> 'name');
    v_res := case v_action when 'delay' then clinic.announce_delay(p_tenant, v)
                           when 'cancel_session' then clinic.cancel_session(p_tenant, v)
                           else clinic.block_time(p_tenant, v) end;
    if (v_res ->> 'ok')::boolean then
      update clinic.conversations set state = state || jsonb_build_object('staff_pending',
               jsonb_build_object('action', v_action, 'params', v - 'preview', 'at', now()))
       where id = conv.id;
    end if;
    return v_res || jsonb_build_object('waiting_for', 'a yes from the doctor (then action confirm)');
  end if;

  if v_action = 'catalog' then
    if v_role not in ('owner', 'manager', 'doctor') then
      return jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED', 'fact', 'prices and services are changed by the doctor or the clinic manager');
    end if;
    v_res := clinic.catalog_change(p_tenant, coalesce(v -> 'changes', v), false, 'whatsapp');
    if (v_res ->> 'ok')::boolean then
      update clinic.catalog_changes set created_by = nullif(p_staff ->> 'user_id', '')::uuid, created_by_name = p_staff ->> 'name'
       where id = (v_res ->> 'change_id')::bigint;
      update clinic.conversations set state = state || jsonb_build_object('staff_pending',
               jsonb_build_object('action', 'catalog', 'change_id', v_res ->> 'change_id', 'at', now()))
       where id = conv.id;
    end if;
    return v_res || jsonb_build_object('waiting_for', 'a yes from the doctor (then action confirm)');
  end if;

  if v_action = 'confirm' then
    if v_pend is null or (v_pend ->> 'at')::timestamptz < now() - interval '30 minutes' then
      return jsonb_build_object('ok', false, 'error', 'NOTHING_WAITING', 'fact', 'nothing is waiting for a yes (or it is older than 30 minutes) — ask again');
    end if;
    update clinic.conversations set state = state - 'staff_pending' where id = conv.id;
    v_res := case v_pend ->> 'action'
      when 'delay' then clinic.announce_delay(p_tenant, (v_pend -> 'params') || '{"preview": false}')
      when 'cancel_session' then clinic.cancel_session(p_tenant, (v_pend -> 'params') || '{"preview": false}')
      when 'block_time' then clinic.block_time(p_tenant, (v_pend -> 'params') || '{"preview": false}')
      when 'catalog' then clinic.catalog_apply((v_pend ->> 'change_id')::bigint)
    end;
    if v_pend ->> 'action' = 'catalog' then
      update clinic.conversations set state = state || jsonb_build_object('staff_last_change', v_pend ->> 'change_id') where id = conv.id;
    end if;
    return coalesce(v_res, jsonb_build_object('ok', false, 'error', 'UNKNOWN_PENDING'));
  end if;

  if v_action = 'discard' then
    if v_pend ->> 'action' = 'catalog' then perform clinic.catalog_undo((v_pend ->> 'change_id')::bigint); end if;
    update clinic.conversations set state = state - 'staff_pending' where id = conv.id;
    return jsonb_build_object('ok', true, 'status', 'DISCARDED');
  end if;

  if v_action = 'undo' then
    if v_role not in ('owner', 'manager', 'doctor') then return jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); end if;
    return clinic.catalog_undo(coalesce(nullif(v ->> 'change_id', '')::bigint, nullif(conv.state ->> 'staff_last_change', '')::bigint,
      (select id from clinic.catalog_changes where tenant_id = p_tenant and source = 'whatsapp' and status = 'applied' order by applied_at desc limit 1)));
  end if;

  if v_action = 'patient' then
    return jsonb_build_object('ok', true, 'patients', coalesce((
      select jsonb_agg(clinic.patient_brief(p.id) || jsonb_build_object('phone', p.phone,
               'next', (select clinic.appointment_view(a) from clinic.appointments a where a.patient_id = p.id
                          and a.status in ('booked', 'confirmed') and a.starts_at > now() order by a.starts_at limit 1)))
        from (select * from clinic.patients x where x.tenant_id = p_tenant and x.is_active
                and (clinic.norm(x.full_name) like '%' || clinic.norm(coalesce(v ->> 'q', '')) || '%'
                     or x.file_no = btrim(coalesce(v ->> 'q', '')) or x.phone like '%' || clinic.digits(coalesce(v ->> 'q', 'x')) || '%')
              order by x.last_visit_at desc nulls last limit 5) p), '[]'::jsonb));
  end if;

  return jsonb_build_object('ok', false, 'error', 'UNKNOWN_ACTION',
                            'fact', 'action is one of: today, delay, cancel_session, block_time, catalog, confirm, discard, undo, patient');
end $$;

-- ---------------------------------------------------------------------
-- Housekeeping (every minute, from the n8n outbox workflow)
-- ---------------------------------------------------------------------
create or replace function clinic.housekeeping()
returns jsonb language plpgsql as $$
declare
  n_release int; n_locks int; n_stuck int; n_buf int; n_hold int; n_rem int; n_delay int; n_noshow int; n_wait int;
begin
  with idle as (
    select c.id, c.human_since from clinic.conversations c join clinic.tenants t on t.id = c.tenant_id
     where c.mode = 'human'
       and coalesce((clinic.merged_settings(t.settings) ->> 'human_auto_release_minutes')::int, 0) > 0
       and coalesce(c.human_last_activity_at, c.human_since, c.updated_at)
           < now() - make_interval(mins => (clinic.merged_settings(t.settings) ->> 'human_auto_release_minutes')::int))
  update clinic.conversations c
     set mode = 'agent', assigned_user_id = null, human_reason = null, human_last_activity_at = null, human_since = null,
         state = c.state || jsonb_build_object('handback', jsonb_build_object('at', now(), 'by', 'auto', 'human_since', idle.human_since))
    from idle where c.id = idle.id;
  get diagnostics n_release = row_count;

  delete from clinic.conversation_locks where expires_at < now() - interval '1 minute';
  get diagnostics n_locks = row_count;
  update clinic.outbox set status = 'queued', not_before = now() where status = 'sending' and claimed_at < now() - interval '5 minutes';
  get diagnostics n_stuck = row_count;
  delete from clinic.inbound_buffer
   where (claimed_by_run_id is not null and received_at < now() - interval '1 hour')
      or (claimed_by_run_id is null and received_at < now() - interval '15 minutes');
  get diagnostics n_buf = row_count;

  -- holds nobody confirmed
  with gone as (
    update clinic.appointments set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', cancel_reason = 'hold expired'
     where status = 'held' and hold_expires_at < now() returning id)
  update clinic.booking_drafts b set hold_id = null, data = b.data - 'slot' from gone where b.hold_id = gone.id;
  get diagnostics n_hold = row_count;

  n_rem := clinic.reminders_due();
  n_delay := clinic.delay_followups_due();

  -- nobody came: a no-show, once the session (or the visit) is well over
  with ns as (
    update clinic.appointments a set status = 'no_show'
      from clinic.tenants t
     where t.id = a.tenant_id and a.status in ('booked', 'confirmed')
       and coalesce((clinic.merged_settings(t.settings) ->> 'auto_no_show')::boolean, true)
       and case when a.mode = 'queue' then a.ends_at else a.ends_at end
           < now() - make_interval(mins => coalesce((clinic.merged_settings(t.settings) ->> 'no_show_grace_minutes')::int, 60))
    returning a.patient_id)
  update clinic.patients p set no_show_count = p.no_show_count + 1 from ns where p.id = ns.patient_id;
  get diagnostics n_noshow = row_count;

  -- waitlist offers that went unanswered go back to waiting; old wishes expire
  update clinic.waitlist set status = 'waiting', offered_slot = null where status = 'offered' and offered_at < now() - interval '3 hours';
  update clinic.waitlist set status = 'expired' where status in ('waiting', 'offered') and to_date is not null and to_date < current_date;
  get diagnostics n_wait = row_count;

  return jsonb_build_object('takeovers_released', n_release, 'locks_cleared', n_locks, 'outbox_requeued', n_stuck,
                            'buffer_cleared', n_buf, 'holds_expired', n_hold, 'reminders_sent', n_rem,
                            'delay_followups', n_delay, 'no_shows', n_noshow, 'waitlist_expired', n_wait);
end $$;
