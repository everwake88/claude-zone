-- =====================================================================
-- Everwake Clinic · 008 · the dashboard
--
-- Signing a clinic up and its speciality presets, the team, the day
-- (today_board), the calendar, the front desk's bookings and status
-- changes, patients and their records, the dental chart and treatment
-- plans, the catalogue import, and the "running late" / "cancel the
-- session" / "time off" buttons. Every function checks the caller's
-- role first; medical records also need the member to be clinical.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Signing a clinic up. The caller becomes its owner (and, when they say
-- so, its first doctor).
-- ---------------------------------------------------------------------
create or replace function clinic.apply_preset(p_tenant uuid, p_specialty text, p_doctor uuid default null)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  sp    clinic.specialty_presets%rowtype;
  x     jsonb;
  n     int := 0;
  v_sort int;
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor']);
  select * into sp from clinic.specialty_presets where code = p_specialty;
  if not found then return jsonb_build_object('ok', false, 'error', 'UNKNOWN_SPECIALTY'); end if;
  select coalesce(max(sort), 0) into v_sort from clinic.services where tenant_id = p_tenant;
  for x in select * from jsonb_array_elements(sp.starter_services) loop
    if exists (select 1 from clinic.services s where s.tenant_id = p_tenant and s.is_active
                and clinic.norm(s.name_ar) = clinic.norm(x ->> 'name_ar')
                and (s.specialty is null or s.specialty = p_specialty)) then
      continue;
    end if;
    v_sort := v_sort + 10;
    insert into clinic.services (tenant_id, category, specialty, name_ar, name_en, aliases, description_ar, duration_min,
                                 price_kind, price, price_max, price_unit, sessions, session_gap_days, prep_ar, aftercare_ar,
                                 resource_kind, needs_consult_first, bookable, min_age, max_age, doctor_ids, sort)
    values (p_tenant, coalesce(x ->> 'category', 'procedure'), p_specialty, x ->> 'name_ar', x ->> 'name_en',
            coalesce((select array_agg(a) from jsonb_array_elements_text(x -> 'aliases') a), '{}'),
            x ->> 'description_ar', coalesce((x ->> 'duration')::int, 20),
            coalesce(x ->> 'price_kind', 'fixed'), (x ->> 'price')::numeric, (x ->> 'price_max')::numeric,
            coalesce(x ->> 'unit', 'visit'), coalesce((x ->> 'sessions')::int, 1), (x ->> 'session_gap_days')::int,
            x ->> 'prep_ar', x ->> 'aftercare_ar', x ->> 'resource_kind', coalesce((x ->> 'needs_consult_first')::boolean, false),
            coalesce((x ->> 'bookable')::boolean, true), (x ->> 'min_age')::numeric, (x ->> 'max_age')::numeric,
            case when p_doctor is not null then array[p_doctor] else '{}' end, v_sort);
    n := n + 1;
  end loop;
  if sp.form_template <> '{}'::jsonb and not exists (select 1 from clinic.form_templates where tenant_id = p_tenant and specialty = p_specialty) then
    insert into clinic.form_templates (tenant_id, specialty, name, schema)
    values (p_tenant, p_specialty, sp.name_en, sp.form_template);
  end if;
  return jsonb_build_object('ok', true, 'services_added', n);
end $$;

create or replace function clinic.create_tenant(p_name_ar text, p_name_en text, p_slug text default null,
                                                p_specialty text default 'general', p_doctor_name text default null,
                                                p_doctor_gender text default null)
returns uuid language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  v_uid   uuid := clinic.current_user_id();
  v_slug  text;
  v_base  text;
  v_i     int := 1;
  v_id    uuid;
  v_doc   uuid;
  v_email text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
begin
  if coalesce(btrim(p_name_ar), '') = '' and coalesce(btrim(p_name_en), '') = '' then
    raise exception 'the clinic needs a name';
  end if;
  v_base := coalesce(nullif(clinic.slugify(p_slug), ''), nullif(clinic.slugify(p_name_en), ''), 'clinic_' || substr(md5(random()::text), 1, 6));
  if length(v_base) < 2 or v_base !~ '^[a-z]' then v_base := 'c_' || v_base; end if;
  v_slug := v_base;
  while exists (select 1 from clinic.tenants where slug = v_slug) loop
    v_i := v_i + 1; v_slug := left(v_base, 36) || '_' || v_i;
  end loop;
  insert into clinic.tenants (slug, name_ar, name_en, specialty, ref_prefix)
  values (v_slug, coalesce(nullif(btrim(p_name_ar), ''), btrim(p_name_en)), coalesce(nullif(btrim(p_name_en), ''), btrim(p_name_ar)),
          coalesce(nullif(p_specialty, ''), 'general'),
          coalesce(nullif(upper(left(regexp_replace(v_slug, '[^a-z]', '', 'g'), 3)), ''), 'CL'))
  returning id into v_id;
  if nullif(btrim(coalesce(p_doctor_name, '')), '') is not null then
    insert into clinic.doctors (tenant_id, user_id, name_ar, specialty, gender)
    values (v_id, v_uid, btrim(p_doctor_name), coalesce(nullif(p_specialty, ''), 'general'),
            case when p_doctor_gender in ('male', 'female') then p_doctor_gender end)
    returning id into v_doc;
  end if;
  if v_uid is not null then
    insert into clinic.tenant_members (tenant_id, user_id, role, clinical, doctor_id, email, display_name)
    values (v_id, v_uid, 'owner', true, v_doc, v_email, coalesce(nullif(btrim(p_doctor_name), ''), split_part(coalesce(v_email, ''), '@', 1)));
  end if;
  perform clinic.apply_preset(v_id, coalesce(nullif(p_specialty, ''), 'general'), v_doc);
  perform clinic.rebuild_snapshot(v_id);
  return v_id;
end $$;

create or replace function clinic.my_tenants()
returns jsonb language sql stable security definer set search_path = clinic, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'slug', t.slug, 'name_ar', t.name_ar, 'name_en', t.name_en, 'status', t.status,
           'agent_enabled', t.agent_enabled, 'currency', t.currency, 'currency_symbol', t.currency_symbol_ar,
           'timezone', t.timezone, 'default_language', t.default_language, 'specialty', t.specialty,
           'role', clinic.member_role(t.id), 'clinical', clinic.can_see_clinical(t.id),
           'doctor_id', (select m.doctor_id from clinic.tenant_members m where m.tenant_id = t.id and m.user_id = clinic.current_user_id()))
         order by t.name_en), '[]'::jsonb)
    from clinic.tenants t
   where clinic.member_role(t.id) is not null
$$;

create or replace function clinic.onboarding_checklist(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare
  t   clinic.tenants%rowtype;
  pr  jsonb;
  n_doc int; n_sched int; n_loc int; n_svc int; n_priced int; n_ch int; n_ch_ok int; n_test int; n_know int;
  items jsonb;
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  select * into t from clinic.tenants where id = p_tenant;
  pr := clinic.merged_profile(t.profile);
  select count(*) into n_doc from clinic.doctors where tenant_id = p_tenant and is_active;
  select count(distinct doctor_id) into n_sched from clinic.schedules where tenant_id = p_tenant and is_active;
  select count(*) into n_loc from clinic.locations where tenant_id = p_tenant and is_active and coalesce(address_ar, '') <> '';
  select count(*), count(*) filter (where price is not null or price_kind in ('after_exam', 'free'))
    into n_svc, n_priced from clinic.services where tenant_id = p_tenant and is_active and agent_visible;
  select count(*), count(*) filter (where status = 'connected') into n_ch, n_ch_ok from clinic.whatsapp_channels where tenant_id = p_tenant and is_active;
  select count(*) into n_test from clinic.appointments where tenant_id = p_tenant and source = 'whatsapp' and ref_no is not null;
  select count(*) into n_know from clinic.knowledge_entries where tenant_id = p_tenant and is_active;
  items := jsonb_build_array(
    jsonb_build_object('key', 'profile', 'label', 'Clinic profile and the assistant''s name', 'required', true,
                       'done', coalesce(pr ->> 'about_ar', '') <> '' or coalesce(pr ->> 'about_en', '') <> '', 'href', 'settings/agent'),
    jsonb_build_object('key', 'locations', 'label', 'Clinic address', 'required', true, 'done', n_loc > 0, 'href', 'settings/locations'),
    jsonb_build_object('key', 'doctors', 'label', 'Doctors and their schedules', 'required', true,
                       'done', n_doc > 0 and n_sched = n_doc, 'detail', n_sched || ' of ' || n_doc || ' doctors have a schedule', 'href', 'settings/schedules'),
    jsonb_build_object('key', 'services', 'label', 'Services and prices', 'required', true,
                       'done', n_svc > 0 and n_priced = n_svc, 'detail', n_priced || ' of ' || n_svc || ' services have a price', 'href', 'services'),
    jsonb_build_object('key', 'knowledge', 'label', 'Answers to common questions', 'required', false, 'done', n_know > 0, 'href', 'knowledge'),
    jsonb_build_object('key', 'whatsapp', 'label', 'WhatsApp number connected', 'required', true, 'done', n_ch_ok > 0, 'href', 'settings/whatsapp'),
    jsonb_build_object('key', 'test', 'label', 'A test booking from a test number', 'required', false, 'done', n_test > 0, 'href', 'settings/whatsapp'));
  return jsonb_build_object('status', t.status, 'live_at', t.live_at, 'items', items,
    'ready', not exists (select 1 from jsonb_array_elements(items) i where (i ->> 'required')::boolean and not (i ->> 'done')::boolean));
end $$;

create or replace function clinic.go_live(p_tenant uuid, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare c jsonb;
begin
  perform clinic.require_role(p_tenant, array['owner']);
  c := clinic.onboarding_checklist(p_tenant);
  if not (c ->> 'ready')::boolean and not p_force then return jsonb_build_object('live', false, 'checklist', c); end if;
  update clinic.tenants set status = 'live', live_at = coalesce(live_at, now()) where id = p_tenant;
  return jsonb_build_object('live', true);
end $$;

-- ---------------------------------------------------------------------
-- The team
-- ---------------------------------------------------------------------
create or replace function clinic.invite_member(p_tenant uuid, p_email text, p_role text default 'receptionist',
                                                p_clinical boolean default null, p_doctor uuid default null)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare v_id uuid;
begin
  perform clinic.require_role(p_tenant, array['owner']);
  if p_role not in ('owner', 'manager', 'doctor', 'nurse', 'receptionist') then raise exception 'unknown role'; end if;
  insert into clinic.tenant_invites (tenant_id, email, role, clinical, doctor_id, invited_by)
  values (p_tenant, lower(btrim(p_email)), p_role, p_clinical, p_doctor, clinic.current_user_id())
  on conflict (tenant_id, email) do update
    set role = excluded.role, clinical = excluded.clinical, doctor_id = excluded.doctor_id, accepted_at = null, accepted_by = null
  returning id into v_id;
  return jsonb_build_object('invite_id', v_id);
end $$;

create or replace function clinic.accept_invites()
returns int language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  v_uid   uuid := clinic.current_user_id();
  v_email text := lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
  r       record;
  n       int := 0;
begin
  if v_uid is null or v_email is null then return 0; end if;
  for r in select * from clinic.tenant_invites where email = v_email and accepted_at is null loop
    insert into clinic.tenant_members (tenant_id, user_id, role, clinical, doctor_id, email, display_name)
    values (r.tenant_id, v_uid, r.role, coalesce(r.clinical, r.role in ('owner', 'doctor', 'nurse')), r.doctor_id, v_email,
            coalesce((select name_ar from clinic.doctors where id = r.doctor_id), split_part(v_email, '@', 1)))
    on conflict (tenant_id, user_id) do update set role = excluded.role, clinical = excluded.clinical, doctor_id = excluded.doctor_id;
    if r.doctor_id is not null then update clinic.doctors set user_id = v_uid where id = r.doctor_id and user_id is null; end if;
    update clinic.tenant_invites set accepted_at = now(), accepted_by = v_uid where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function clinic.update_member(p_tenant uuid, p_user uuid, p jsonb)
returns void language plpgsql security definer set search_path = clinic, pg_temp as $$
declare v_role text := nullif(p ->> 'role', '');
begin
  perform clinic.require_role(p_tenant, array['owner']);
  if v_role is not null and v_role not in ('owner', 'manager', 'doctor', 'nurse', 'receptionist') then raise exception 'unknown role'; end if;
  if v_role is not null and v_role <> 'owner'
     and (select role from clinic.tenant_members where tenant_id = p_tenant and user_id = p_user) = 'owner'
     and (select count(*) from clinic.tenant_members where tenant_id = p_tenant and role = 'owner') = 1 then
    raise exception 'a clinic always keeps at least one owner';
  end if;
  update clinic.tenant_members
     set role = coalesce(v_role, role),
         clinical = coalesce((p ->> 'clinical')::boolean, clinical),
         doctor_id = case when p ? 'doctor_id' then nullif(p ->> 'doctor_id', '')::uuid else doctor_id end,
         phone = case when p ? 'phone' then clinic.wa_phone(p ->> 'phone') else phone end,
         display_name = coalesce(nullif(btrim(p ->> 'display_name'), ''), display_name)
   where tenant_id = p_tenant and user_id = p_user;
end $$;

-- a member's own WhatsApp number (for staff commands) — they may set their own
create or replace function clinic.set_my_phone(p_tenant uuid, p_phone text)
returns text language plpgsql security definer set search_path = clinic, pg_temp as $$
declare v text := clinic.wa_phone(p_phone);
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  update clinic.tenant_members set phone = v where tenant_id = p_tenant and user_id = clinic.current_user_id();
  return v;
end $$;

create or replace function clinic.remove_member(p_tenant uuid, p_user uuid)
returns void language plpgsql security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner']);
  if (select role from clinic.tenant_members where tenant_id = p_tenant and user_id = p_user) = 'owner'
     and (select count(*) from clinic.tenant_members where tenant_id = p_tenant and role = 'owner') = 1 then
    raise exception 'a clinic always keeps at least one owner';
  end if;
  delete from clinic.tenant_members where tenant_id = p_tenant and user_id = p_user;
end $$;

-- ---------------------------------------------------------------------
-- The day
-- ---------------------------------------------------------------------
create or replace function clinic.appt_card(a clinic.appointments, p_clinical boolean)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', a.id, 'ref_no', a.ref_no, 'status', a.status, 'mode', a.mode, 'source', a.source,
    'doctor_id', a.doctor_id, 'location_id', a.location_id, 'resource_id', a.resource_id,
    'resource', (select name_ar from clinic.resources where id = a.resource_id),
    'service_id', a.service_id, 'service', s.name_ar, 'service_en', s.name_en, 'category', s.category,
    'patient_id', a.patient_id, 'patient', p.full_name, 'file_no', p.file_no, 'sex', p.sex,
    'age', clinic.age_text(p.birth_date, 'ar'), 'age_en', clinic.age_text(p.birth_date, 'en'),
    'phone', coalesce(p.phone, (select c.phone from clinic.contacts c where c.id = a.contact_id)),
    'whatsapp', a.wa_id is not null, 'wa_id', a.wa_id,
    'conversation_id', (select id from clinic.conversations c where c.tenant_id = a.tenant_id and c.wa_id = a.wa_id),
    'starts_at', a.starts_at, 'ends_at', a.ends_at, 'est_at', a.est_at, 'queue_no', a.queue_no, 'session_date', a.session_date,
    'original_starts_at', a.original_starts_at, 'delay_minutes', a.delay_minutes,
    'reason', a.reason, 'urgency', a.urgency, 'is_new', a.is_new_patient, 'is_follow_up', a.is_follow_up,
    'price_text', a.price_text, 'price', a.price, 'payment_status', a.payment_status,
    'confirmed_at', a.confirmed_at, 'arrived_at', a.arrived_at, 'visit_started_at', a.visit_started_at,
    'visit_ended_at', a.visit_ended_at, 'staff_notes', a.staff_notes, 'plan_item_id', a.plan_item_id,
    'allergies', case when p_clinical then (select jsonb_agg(al.substance) from clinic.allergies al
                                             where al.patient_id = a.patient_id and al.status = 'active') end,
    'visits_count', p.visits_count, 'last_visit_at', p.last_visit_at, 'no_show_count', p.no_show_count,
    'delay_reply', (select i.status from clinic.delay_notice_items i where i.appointment_id = a.id order by i.id desc limit 1))
  from (select 1) one
  left join clinic.services s on s.id = a.service_id
  left join clinic.patients p on p.id = a.patient_id
$$;

create or replace function clinic.today_board(p_tenant uuid, p_date date default null, p_doctor uuid default null)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare
  v_date date;
  tz     text := clinic.tenant_tz(p_tenant);
  v_cl   boolean;
  v_next clinic.appointments%rowtype;
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  v_date := coalesce(p_date, clinic.local_today(p_tenant));
  v_cl := clinic.can_see_clinical(p_tenant);
  select * into v_next from clinic.appointments a
   where a.tenant_id = p_tenant and a.session_date = v_date and (p_doctor is null or a.doctor_id = p_doctor)
     and a.status in ('in_visit', 'arrived', 'confirmed', 'booked')
   order by (a.status = 'in_visit') desc, (a.status = 'arrived') desc, coalesce(a.est_at, a.starts_at) limit 1;

  return jsonb_build_object(
    'date', v_date, 'now', now(), 'timezone', tz, 'clinical', v_cl,
    'sessions', coalesce((select jsonb_agg(jsonb_build_object(
        'doctor_id', s.doctor_id, 'doctor', clinic.doctor_label(s.doctor_id, 'ar'), 'doctor_en', clinic.doctor_label(s.doctor_id, 'en'),
        'color', d.color, 'specialty', d.specialty, 'location_id', s.location_id,
        'location', clinic.location_label(s.location_id, 'ar'), 'location_en', clinic.location_label(s.location_id, 'en'),
        'starts_at', s.starts_at, 'ends_at', s.ends_at, 'mode', s.mode, 'capacity', s.capacity,
        'delay_minutes', (select coalesce(sum(dn.minutes), 0) from clinic.delay_notices dn where dn.doctor_id = s.doctor_id
                           and dn.session_date = v_date and dn.kind = 'delay' and dn.status = 'sent'
                           and (dn.location_id is null or dn.location_id = s.location_id)),
        'appointments', coalesce((select jsonb_agg(clinic.appt_card(a, v_cl) order by coalesce(a.queue_no, 0), a.starts_at)
                                    from clinic.appointments a
                                   where a.doctor_id = s.doctor_id and a.location_id = s.location_id and a.session_date = v_date
                                     and a.status <> 'held' and a.ref_no is not null
                                     and tstzrange(s.starts_at - interval '1 hour', s.ends_at + interval '4 hours') @> a.starts_at), '[]'::jsonb))
        order by s.starts_at)
      from clinic.doctor_sessions(p_tenant, v_date, v_date, p_doctor) s join clinic.doctors d on d.id = s.doctor_id), '[]'::jsonb),
    'outside', coalesce((select jsonb_agg(clinic.appt_card(a, v_cl) order by a.starts_at) from clinic.appointments a
                          where a.tenant_id = p_tenant and a.session_date = v_date and a.ref_no is not null and a.status <> 'held'
                            and (p_doctor is null or a.doctor_id = p_doctor)
                            and not exists (select 1 from clinic.doctor_sessions(p_tenant, v_date, v_date, a.doctor_id, a.location_id) s
                                             where tstzrange(s.starts_at - interval '1 hour', s.ends_at + interval '4 hours') @> a.starts_at)), '[]'::jsonb),
    'waiting_room', coalesce((select jsonb_agg(clinic.appt_card(a, v_cl) || jsonb_build_object(
                                 'waiting_minutes', floor(extract(epoch from now() - a.arrived_at) / 60)) order by a.arrived_at)
                                from clinic.appointments a
                               where a.tenant_id = p_tenant and a.session_date = v_date and a.status = 'arrived'
                                 and (p_doctor is null or a.doctor_id = p_doctor)), '[]'::jsonb),
    'next', case when v_next.id is not null then clinic.appt_card(v_next, v_cl) || jsonb_build_object(
               'conditions', case when v_cl then (select jsonb_agg(c.name) from clinic.conditions c where c.patient_id = v_next.patient_id and c.status <> 'resolved') end,
               'medications', case when v_cl then (select jsonb_agg(m.name || coalesce(' ' || m.dose, '')) from clinic.medications m where m.patient_id = v_next.patient_id and m.status = 'active') end,
               'last_visit', (select jsonb_build_object('date', x.session_date, 'service', s.name_ar, 'doctor', clinic.doctor_label(x.doctor_id, 'ar'))
                                from clinic.appointments x left join clinic.services s on s.id = x.service_id
                               where x.patient_id = v_next.patient_id and x.status = 'done' order by x.starts_at desc limit 1),
               'documents', (select count(*) from clinic.documents dd where dd.patient_id = v_next.patient_id and dd.created_at > now() - interval '30 days'),
               'pre_visit', v_next.pre_visit) end,
    'counts', (select jsonb_build_object(
                 'total', count(*) filter (where a.status not in ('cancelled', 'held')),
                 'booked', count(*) filter (where a.status = 'booked'),
                 'confirmed', count(*) filter (where a.status = 'confirmed'),
                 'arrived', count(*) filter (where a.status = 'arrived'),
                 'in_visit', count(*) filter (where a.status = 'in_visit'),
                 'done', count(*) filter (where a.status = 'done'),
                 'no_show', count(*) filter (where a.status = 'no_show'),
                 'cancelled', count(*) filter (where a.status = 'cancelled' and a.ref_no is not null),
                 'new_patients', count(*) filter (where a.is_new_patient and a.status not in ('cancelled', 'held')),
                 'by_agent', count(*) filter (where a.source = 'whatsapp' and a.status not in ('cancelled', 'held')),
                 'expected', coalesce(sum(a.price) filter (where a.status not in ('cancelled', 'held', 'no_show')), 0),
                 'collected', coalesce(sum(a.price) filter (where a.status = 'done'), 0))
                 from clinic.appointments a where a.tenant_id = p_tenant and a.session_date = v_date and (p_doctor is null or a.doctor_id = p_doctor)),
    'tomorrow_unconfirmed', (select count(*) from clinic.appointments a where a.tenant_id = p_tenant and a.session_date = v_date + 1
                               and a.status = 'booked' and (p_doctor is null or a.doctor_id = p_doctor)),
    'agent_today', coalesce((select jsonb_agg(clinic.appt_card(a, v_cl) || jsonb_build_object('created_at', a.created_at) order by a.created_at desc)
                               from (select * from clinic.appointments x where x.tenant_id = p_tenant and x.source = 'whatsapp' and x.ref_no is not null
                                       and x.created_at >= (v_date::timestamp at time zone tz) and x.created_at < ((v_date + 1)::timestamp at time zone tz)
                                     order by x.created_at desc limit 8) a), '[]'::jsonb),
    'delays', coalesce((select jsonb_agg(jsonb_build_object('id', dn.id, 'kind', dn.kind, 'doctor', clinic.doctor_label(dn.doctor_id, 'ar'),
                                 'doctor_id', dn.doctor_id, 'minutes', dn.minutes, 'reason', dn.reason, 'via', dn.via, 'by', dn.created_by_name, 'at', dn.sent_at,
                                 'tally', (select jsonb_object_agg(z.status, z.n) from (select i.status, count(*) n from clinic.delay_notice_items i
                                                                                          where i.notice_id = dn.id group by i.status) z))
                                 order by dn.sent_at desc)
                          from clinic.delay_notices dn where dn.tenant_id = p_tenant and dn.session_date = v_date
                           and (p_doctor is null or dn.doctor_id = p_doctor)), '[]'::jsonb),
    'alerts', coalesce((select jsonb_agg(to_jsonb(al) order by (al.severity = 'critical') desc, al.created_at desc)
                          from (select * from clinic.alerts x where x.tenant_id = p_tenant and x.status = 'open' order by x.created_at desc limit 12) al), '[]'::jsonb));
end $$;

create or replace function clinic.calendar_range(p_tenant uuid, p_from date, p_to date, p_doctor uuid default null)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare v_cl boolean;
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  if p_to < p_from or p_to - p_from > 62 then raise exception 'pick up to two months'; end if;
  v_cl := clinic.can_see_clinical(p_tenant);
  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'timezone', clinic.tenant_tz(p_tenant),
    'appointments', coalesce((select jsonb_agg(clinic.appt_card(a, v_cl) order by a.starts_at) from clinic.appointments a
                               where a.tenant_id = p_tenant and a.session_date between p_from and p_to and a.ref_no is not null
                                 and (p_doctor is null or a.doctor_id = p_doctor)), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('doctor_id', s.doctor_id, 'location_id', s.location_id, 'date', s.session_date,
                                                               'starts_at', s.starts_at, 'ends_at', s.ends_at, 'mode', s.mode,
                                                               'slot_minutes', s.slot_minutes, 'capacity', s.capacity, 'online', s.online)
                                           order by s.starts_at)
                           from clinic.doctor_sessions(p_tenant, p_from, p_to, p_doctor) s), '[]'::jsonb),
    'exceptions', coalesce((select jsonb_agg(to_jsonb(e) order by e.on_date) from clinic.schedule_exceptions e
                             where e.tenant_id = p_tenant and e.on_date between p_from and p_to
                               and (p_doctor is null or e.doctor_id = p_doctor)), '[]'::jsonb),
    'resources', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name_ar, 'kind', r.kind, 'location_id', r.location_id) order by r.sort)
                            from clinic.resources r where r.tenant_id = p_tenant and r.is_active), '[]'::jsonb));
end $$;

-- the sidebar's numbers
create or replace function clinic.dashboard_counts(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  return jsonb_build_object(
    'alerts', (select count(*) from clinic.alerts where tenant_id = p_tenant and status = 'open'),
    'emergencies', (select count(*) from clinic.alerts where tenant_id = p_tenant and status = 'open' and kind = 'emergency'),
    'inbox', (select count(*) from clinic.conversations where tenant_id = p_tenant and (needs_attention or questions_open > 0 or (mode = 'human' and unread_count > 0))),
    'waiting_room', (select count(*) from clinic.appointments where tenant_id = p_tenant and session_date = clinic.local_today(p_tenant) and status = 'arrived'),
    'waitlist', (select count(*) from clinic.waitlist where tenant_id = p_tenant and status in ('waiting', 'offered')));
end $$;

-- ---------------------------------------------------------------------
-- The front desk
-- ---------------------------------------------------------------------
-- p = {doctor_id, location_id?, service_id?, kind, starts_at | date, patient_id | patient{full_name, phone, age, sex},
--      reason?, source? ('phone' · 'walk_in' · 'dashboard'), notify?, force?, notes?, plan_item_id?}
create or replace function clinic.staff_book(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  co     clinic.contacts%rowtype;
  v_pat  bigint := nullif(p ->> 'patient_id', '')::bigint;
  v_res  jsonb;
  a      clinic.appointments%rowtype;
  st     jsonb;
  v_lang text;
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  if v_pat is not null then
    select c.* into co from clinic.patient_contacts pc join clinic.contacts c on c.id = pc.contact_id
     where pc.patient_id = v_pat order by (pc.relation = 'self') desc limit 1;
    if co.id is null then
      co := clinic.ensure_contact(p_tenant, (select phone from clinic.patients where id = v_pat), (select full_name from clinic.patients where id = v_pat));
      if co.id is not null then
        insert into clinic.patient_contacts (patient_id, contact_id, tenant_id, relation) values (v_pat, co.id, p_tenant, 'self') on conflict do nothing;
      end if;
    end if;
  elsif jsonb_typeof(p -> 'patient') = 'object' then
    co := clinic.ensure_contact(p_tenant, p -> 'patient' ->> 'phone', p -> 'patient' ->> 'full_name');
    v_pat := clinic.resolve_patient(p_tenant, co.id, (p -> 'patient') || jsonb_build_object('created_via', 'dashboard',
               'relation', coalesce(nullif(p -> 'patient' ->> 'relation', ''), 'self')));
    if v_pat is not null and co.id is null then
      update clinic.patients set phone = clinic.wa_phone(p -> 'patient' ->> 'phone') where id = v_pat and phone is null;
    end if;
  end if;
  if v_pat is null then return jsonb_build_object('ok', false, 'error', 'PATIENT_NEEDED'); end if;
  v_res := clinic.book_appointment(p_tenant, p || jsonb_build_object(
             'patient_id', v_pat, 'contact_id', co.id, 'wa_id', co.wa_id, 'staff', true,
             'source', coalesce(nullif(p ->> 'source', ''), 'dashboard'), 'status', 'booked'));
  if (v_res ->> 'ok')::boolean and coalesce((p ->> 'notify')::boolean, true) and co.wa_id is not null then
    select * into a from clinic.appointments where id = (v_res -> 'appointment' ->> 'id')::bigint;
    select clinic.merged_settings(settings) into st from clinic.tenants where id = p_tenant;
    v_lang := clinic.contact_language(p_tenant, co.wa_id);
    perform clinic.queue_message(p_tenant, co.wa_id, 'booking_confirmed',
      clinic.render_template(st -> 'templates' ->> ('booking_confirmed_' || v_lang), clinic.message_vars(a, v_lang)),
      p_sender => 'staff', p_user => clinic.current_user_id(), p_template => 'booking_confirmed',
      p_meta => jsonb_build_object('appointment_id', a.id));
    v_res := v_res || jsonb_build_object('notified', true);
  end if;
  return v_res;
end $$;

create or replace function clinic.move_appointment(p_appt bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from clinic.appointments where id = p_appt;
  perform clinic.require_role(v_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  return clinic.reschedule_appointment(p_appt, p || jsonb_build_object('staff', true, 'by_role', 'staff'));
end $$;

-- confirmed (by phone) · arrived · in_visit · done · no_show · cancelled · booked (undo)
create or replace function clinic.set_appointment_status(p_appt bigint, p_status text, p_note text default null, p_notify boolean default false)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  a clinic.appointments%rowtype;
begin
  select * into a from clinic.appointments where id = p_appt for update;
  if not found then raise exception 'appointment not found'; end if;
  perform clinic.require_role(a.tenant_id, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  if p_status = 'cancelled' then
    return clinic.cancel_appointment(a.id, 'clinic', p_note, p_notify);
  end if;
  if p_status not in ('booked', 'confirmed', 'arrived', 'in_visit', 'done', 'no_show') then raise exception 'unknown status'; end if;
  if a.status in ('cancelled') then raise exception 'this appointment was cancelled'; end if;
  update clinic.appointments
     set status = p_status,
         confirmed_at = case when p_status = 'confirmed' then coalesce(confirmed_at, now()) else confirmed_at end,
         arrived_at = case when p_status = 'arrived' then coalesce(arrived_at, now()) when p_status = 'booked' then null else arrived_at end,
         visit_started_at = case when p_status = 'in_visit' then coalesce(visit_started_at, now())
                                 when p_status in ('booked', 'arrived') then null else visit_started_at end,
         visit_ended_at = case when p_status = 'done' then coalesce(visit_ended_at, now()) else visit_ended_at end,
         staff_notes = coalesce(nullif(btrim(coalesce(p_note, '')), ''), staff_notes)
   where id = a.id returning * into a;
  if p_status in ('arrived', 'in_visit', 'done') then
    update clinic.appointment_reminders set status = 'cancelled' where appointment_id = a.id and status = 'scheduled';
    update clinic.delay_notice_items set status = 'accepted', replied_at = coalesce(replied_at, now()) where appointment_id = a.id and status = 'sent';
  end if;
  if p_status = 'done' then perform clinic.appointment_done(a.id); end if;
  if p_status = 'no_show' and a.patient_id is not null then
    update clinic.patients set no_show_count = no_show_count + 1 where id = a.patient_id;
  end if;
  perform clinic.log_appt(a.id, p_status, jsonb_build_object('note', p_note));
  return jsonb_build_object('ok', true, 'appointment', clinic.appt_card(a, clinic.can_see_clinical(a.tenant_id)));
end $$;

create or replace function clinic.dashboard_delay(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  return clinic.announce_delay(p_tenant, p || jsonb_build_object('via', coalesce(nullif(p ->> 'via', ''), 'dashboard')));
end $$;

create or replace function clinic.dashboard_cancel_session(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor']);
  return clinic.cancel_session(p_tenant, p || jsonb_build_object('via', coalesce(nullif(p ->> 'via', ''), 'dashboard')));
end $$;

create or replace function clinic.dashboard_block_time(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor']);
  return clinic.block_time(p_tenant, p);
end $$;

create or replace function clinic.dashboard_slots(p_tenant uuid, p jsonb)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  return clinic.available_slots(p_tenant, p || jsonb_build_object('staff', coalesce((p ->> 'staff')::boolean, true)));
end $$;

create or replace function clinic.add_waitlist(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  v_id bigint;
  co   clinic.contacts%rowtype;
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  select c.* into co from clinic.patient_contacts pc join clinic.contacts c on c.id = pc.contact_id
   where pc.patient_id = (p ->> 'patient_id')::bigint order by (pc.relation = 'self') desc limit 1;
  insert into clinic.waitlist (tenant_id, patient_id, contact_id, wa_id, doctor_id, location_id, service_id, from_date, to_date, band, notes, created_by)
  values (p_tenant, (p ->> 'patient_id')::bigint, co.id, co.wa_id, nullif(p ->> 'doctor_id', '')::uuid, nullif(p ->> 'location_id', '')::uuid,
          nullif(p ->> 'service_id', '')::uuid, coalesce(nullif(p ->> 'from_date', '')::date, current_date), nullif(p ->> 'to_date', '')::date,
          case when p ->> 'band' in ('morning', 'afternoon', 'evening') then p ->> 'band' else 'any' end, nullif(p ->> 'notes', ''), clinic.current_user_id())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ---------------------------------------------------------------------
-- Patients and records
-- ---------------------------------------------------------------------
create or replace function clinic.patient_search(p_tenant uuid, p_q text, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare v_q text := clinic.norm(p_q); v_d text := clinic.digits(p_q);
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object('id', p.id, 'file_no', p.file_no, 'full_name', p.full_name, 'sex', p.sex,
                              'age', clinic.age_text(p.birth_date, 'ar'), 'phone', p.phone, 'last_visit_at', p.last_visit_at,
                              'visits_count', p.visits_count, 'tags', p.tags,
                              'next', (select jsonb_build_object('id', a.id, 'starts_at', coalesce(a.est_at, a.starts_at), 'doctor', clinic.doctor_label(a.doctor_id, 'ar'))
                                         from clinic.appointments a where a.patient_id = p.id and a.status in ('booked', 'confirmed') and a.ends_at > now()
                                        order by a.starts_at limit 1)) as x
      from clinic.patients p
     where p.tenant_id = p_tenant and p.is_active
       and (v_q = '' or clinic.norm(p.full_name) like '%' || v_q || '%' or p.file_no = btrim(coalesce(p_q, ''))
            or (length(v_d) >= 4 and (p.phone like '%' || v_d || '%'
                                      or exists (select 1 from clinic.patient_contacts pc join clinic.contacts c on c.id = pc.contact_id
                                                  where pc.patient_id = p.id and c.phone like '%' || v_d || '%'))))
     order by (clinic.norm(p.full_name) like v_q || '%') desc, p.last_visit_at desc nulls last, p.id desc
     limit least(coalesce(p_limit, 20), 100)) q), '[]'::jsonb);
end $$;

create or replace function clinic.patient_profile(p_patient bigint)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  p    clinic.patients%rowtype;
  v_cl boolean;
begin
  select * into p from clinic.patients where id = p_patient;
  if not found then raise exception 'patient not found'; end if;
  perform clinic.require_role(p.tenant_id, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  v_cl := clinic.can_see_clinical(p.tenant_id);
  insert into clinic.record_access_log (tenant_id, user_id, patient_id, action, detail)
  values (p.tenant_id, clinic.current_user_id(), p.id, 'view', case when v_cl then 'record' else 'contact details' end);
  return jsonb_build_object(
    'patient', to_jsonb(p) || jsonb_build_object('age', clinic.age_text(p.birth_date, 'ar'), 'age_en', clinic.age_text(p.birth_date, 'en'),
                                                 'age_years', clinic.age_years(p.birth_date)),
    'clinical', v_cl,
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('contact_id', c.id, 'relation', pc.relation, 'name', coalesce(c.full_name, c.display_name),
                                                              'phone', c.phone, 'wa_id', c.wa_id,
                                                              'conversation_id', (select id from clinic.conversations x where x.tenant_id = c.tenant_id and x.wa_id = c.wa_id)))
                            from clinic.patient_contacts pc join clinic.contacts c on c.id = pc.contact_id where pc.patient_id = p.id), '[]'::jsonb),
    'family', coalesce((select jsonb_agg(distinct jsonb_build_object('id', o.id, 'full_name', o.full_name, 'relation', pc2.relation))
                          from clinic.patient_contacts pc join clinic.patient_contacts pc2 on pc2.contact_id = pc.contact_id and pc2.patient_id <> p.id
                          join clinic.patients o on o.id = pc2.patient_id where pc.patient_id = p.id), '[]'::jsonb),
    'appointments', coalesce((select jsonb_agg(clinic.appt_card(a, v_cl) order by a.starts_at desc) from clinic.appointments a
                               where a.patient_id = p.id and a.ref_no is not null), '[]'::jsonb),
    'conditions', case when v_cl then coalesce((select jsonb_agg(to_jsonb(x) order by x.status, x.created_at desc) from clinic.conditions x where x.patient_id = p.id), '[]'::jsonb) end,
    'allergies', case when v_cl then coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from clinic.allergies x where x.patient_id = p.id), '[]'::jsonb) end,
    'medications', case when v_cl then coalesce((select jsonb_agg(to_jsonb(x) order by x.status, x.created_at desc) from clinic.medications x where x.patient_id = p.id), '[]'::jsonb) end,
    'history', case when v_cl then coalesce((select jsonb_agg(to_jsonb(x) order by x.kind, x.created_at desc) from clinic.patient_history x where x.patient_id = p.id), '[]'::jsonb) end,
    'vitals', case when v_cl then coalesce((select jsonb_agg(to_jsonb(x) order by x.taken_at desc) from (select * from clinic.vitals where patient_id = p.id order by taken_at desc limit 30) x), '[]'::jsonb) end,
    'encounters', case when v_cl then coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object('doctor', clinic.doctor_label(x.doctor_id, 'ar')) order by x.started_at desc)
                                                  from clinic.encounters x where x.patient_id = p.id), '[]'::jsonb) end,
    'documents', case when v_cl then coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from clinic.documents x where x.patient_id = p.id), '[]'::jsonb) end,
    'dental_chart', case when v_cl then coalesce((select jsonb_agg(to_jsonb(x) order by x.tooth) from clinic.dental_chart x where x.patient_id = p.id), '[]'::jsonb) end,
    'plans', case when v_cl then coalesce((select jsonb_agg(to_jsonb(pl) || jsonb_build_object(
                     'doctor', clinic.doctor_label(pl.doctor_id, 'ar'), 'total', clinic.plan_total(pl.id),
                     'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.seq, i.id) from clinic.treatment_plan_items i where i.plan_id = pl.id), '[]'::jsonb))
                     order by pl.created_at desc) from clinic.treatment_plans pl where pl.patient_id = p.id), '[]'::jsonb) end,
    'templates', case when v_cl then coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'specialty', f.specialty, 'schema', f.schema))
                                                 from clinic.form_templates f where f.tenant_id = p.tenant_id), '[]'::jsonb) end);
end $$;

create or replace function clinic.save_patient(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  v_id   bigint := nullif(p ->> 'id', '')::bigint;
  v_birth date; v_est boolean;
  co     clinic.contacts%rowtype;
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  if nullif(p ->> 'birth_date', '') is not null then v_birth := (p ->> 'birth_date')::date; v_est := false;
  elsif nullif(p ->> 'age', '') is not null then select b.birth_date, b.estimated into v_birth, v_est from clinic.parse_birth(p ->> 'age') b;
  end if;
  if v_id is null then
    if coalesce(btrim(p ->> 'full_name'), '') = '' then raise exception 'the patient needs a name'; end if;
    insert into clinic.patients (tenant_id, full_name, sex, birth_date, birth_date_estimated, phone, national_id, blood_group,
                                 marital_status, occupation, address, insurance, tags, notes)
    values (p_tenant, btrim(p ->> 'full_name'), nullif(p ->> 'sex', ''), v_birth, coalesce(v_est, false),
            clinic.wa_phone(p ->> 'phone'), nullif(p ->> 'national_id', ''), nullif(p ->> 'blood_group', ''),
            nullif(p ->> 'marital_status', ''), nullif(p ->> 'occupation', ''), nullif(p ->> 'address', ''), nullif(p ->> 'insurance', ''),
            coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'tags') x), '{}'), nullif(p ->> 'notes', ''))
    returning id into v_id;
  else
    update clinic.patients
       set full_name = coalesce(nullif(btrim(p ->> 'full_name'), ''), full_name),
           sex = case when p ? 'sex' then nullif(p ->> 'sex', '') else sex end,
           birth_date = case when v_birth is not null then v_birth else birth_date end,
           birth_date_estimated = case when v_birth is not null then coalesce(v_est, false) else birth_date_estimated end,
           phone = case when p ? 'phone' then clinic.wa_phone(p ->> 'phone') else phone end,
           national_id = case when p ? 'national_id' then nullif(p ->> 'national_id', '') else national_id end,
           blood_group = case when p ? 'blood_group' then nullif(p ->> 'blood_group', '') else blood_group end,
           marital_status = case when p ? 'marital_status' then nullif(p ->> 'marital_status', '') else marital_status end,
           occupation = case when p ? 'occupation' then nullif(p ->> 'occupation', '') else occupation end,
           address = case when p ? 'address' then nullif(p ->> 'address', '') else address end,
           insurance = case when p ? 'insurance' then nullif(p ->> 'insurance', '') else insurance end,
           tags = case when p ? 'tags' then coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'tags') x), '{}') else tags end,
           notes = case when p ? 'notes' then nullif(p ->> 'notes', '') else notes end
     where id = v_id and tenant_id = p_tenant;
    if not found then raise exception 'patient not found'; end if;
  end if;
  if nullif(p ->> 'phone', '') is not null then
    co := clinic.ensure_contact(p_tenant, p ->> 'phone', p ->> 'full_name');
    if co.id is not null then
      insert into clinic.patient_contacts (patient_id, contact_id, tenant_id, relation)
      values (v_id, co.id, p_tenant, coalesce(nullif(p ->> 'relation', ''), 'self')) on conflict do nothing;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- conditions · allergies · medications · patient_history · vitals: add, change or remove one row
create or replace function clinic.save_record(p_patient bigint, p_table text, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  v_tenant uuid;
  v_row    jsonb;
  v_id     bigint := nullif(p ->> 'id', '')::bigint;
  cols     text;
  ex       text;
begin
  if p_table not in ('conditions', 'allergies', 'medications', 'patient_history', 'vitals') then raise exception 'not a record table'; end if;
  select tenant_id into v_tenant from clinic.patients where id = p_patient;
  if v_tenant is null then raise exception 'patient not found'; end if;
  perform clinic.require_role(v_tenant, array['owner', 'manager', 'doctor', 'nurse']);
  perform clinic.require_clinical(v_tenant);
  if coalesce((p ->> 'delete')::boolean, false) then
    execute format('delete from clinic.%I where id = $1 and patient_id = $2', p_table) using v_id, p_patient;
    return jsonb_build_object('ok', true, 'deleted', v_id);
  end if;
  v_row := (p - 'id' - 'tenant_id' - 'patient_id' - 'created_at' - 'created_by' - 'delete')
           || jsonb_build_object('tenant_id', v_tenant, 'patient_id', p_patient);
  if v_id is null then v_row := v_row || jsonb_build_object('created_by', clinic.current_user_id()); end if;
  select string_agg(format('%I', a.attname), ', ' order by a.attnum),
         string_agg(format('excluded.%I', a.attname), ', ' order by a.attnum)
    into cols, ex
    from pg_attribute a
   where a.attrelid = ('clinic.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped
     and a.attidentity = '' and a.attname not in ('id', 'created_at', 'updated_at') and v_row ? a.attname;
  if v_id is null then
    execute format('insert into clinic.%I (%s) select %s from jsonb_populate_record(null::clinic.%I, $1) returning id', p_table, cols, cols, p_table)
      into v_id using v_row;
  else
    execute format('update clinic.%I t set (%s) = (select %s from jsonb_populate_record(null::clinic.%I, $1)) where t.id = $2 and t.patient_id = $3',
                   p_table, cols, cols, p_table) using v_row, v_id, p_patient;
  end if;
  insert into clinic.record_access_log (tenant_id, user_id, patient_id, action, detail) values (v_tenant, clinic.current_user_id(), p_patient, 'edit', p_table);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- a visit's record (draft until signed)
create or replace function clinic.save_encounter(p_patient bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  v_tenant uuid;
  v_id     bigint := nullif(p ->> 'id', '')::bigint;
  e        clinic.encounters%rowtype;
begin
  select tenant_id into v_tenant from clinic.patients where id = p_patient;
  perform clinic.require_role(v_tenant, array['owner', 'manager', 'doctor', 'nurse']);
  perform clinic.require_clinical(v_tenant);
  if v_id is null then
    insert into clinic.encounters (tenant_id, patient_id, appointment_id, doctor_id, template_id, chief_complaint, data, sources,
                                   assessment, plan, diagnoses, follow_up_date, created_by)
    values (v_tenant, p_patient, nullif(p ->> 'appointment_id', '')::bigint,
            coalesce(nullif(p ->> 'doctor_id', '')::uuid, (select doctor_id from clinic.tenant_members where tenant_id = v_tenant and user_id = clinic.current_user_id())),
            nullif(p ->> 'template_id', '')::uuid, nullif(p ->> 'chief_complaint', ''), coalesce(p -> 'data', '{}'::jsonb),
            coalesce(p -> 'sources', '{}'::jsonb), nullif(p ->> 'assessment', ''), nullif(p ->> 'plan', ''),
            coalesce(p -> 'diagnoses', '[]'::jsonb), nullif(p ->> 'follow_up_date', '')::date, clinic.current_user_id())
    returning * into e;
  else
    select * into e from clinic.encounters where id = v_id and patient_id = p_patient for update;
    if e.status = 'signed' then raise exception 'a signed visit cannot be changed'; end if;
    update clinic.encounters
       set chief_complaint = case when p ? 'chief_complaint' then nullif(p ->> 'chief_complaint', '') else chief_complaint end,
           data = case when p ? 'data' then p -> 'data' else data end,
           sources = case when p ? 'sources' then p -> 'sources' else sources end,
           assessment = case when p ? 'assessment' then nullif(p ->> 'assessment', '') else assessment end,
           plan = case when p ? 'plan' then nullif(p ->> 'plan', '') else plan end,
           diagnoses = case when p ? 'diagnoses' then p -> 'diagnoses' else diagnoses end,
           follow_up_date = case when p ? 'follow_up_date' then nullif(p ->> 'follow_up_date', '')::date else follow_up_date end,
           template_id = coalesce(nullif(p ->> 'template_id', '')::uuid, template_id)
     where id = e.id returning * into e;
  end if;
  if coalesce((p ->> 'sign')::boolean, false) then
    update clinic.encounters set status = 'signed', signed_at = now(), signed_by = clinic.current_user_id(), ended_at = coalesce(ended_at, now())
     where id = e.id returning * into e;
  end if;
  return jsonb_build_object('ok', true, 'encounter', to_jsonb(e));
end $$;

create or replace function clinic.set_teeth(p_patient bigint, p_teeth jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  v_tenant uuid;
  x jsonb;
  n int := 0;
begin
  select tenant_id into v_tenant from clinic.patients where id = p_patient;
  perform clinic.require_role(v_tenant, array['owner', 'manager', 'doctor', 'nurse']);
  perform clinic.require_clinical(v_tenant);
  for x in select * from jsonb_array_elements(case jsonb_typeof(p_teeth) when 'array' then p_teeth else jsonb_build_array(p_teeth) end) loop
    if coalesce((x ->> 'clear')::boolean, false) then
      delete from clinic.dental_chart where patient_id = p_patient and tooth = (x ->> 'tooth')::smallint;
    else
      insert into clinic.dental_chart (tenant_id, patient_id, tooth, condition, surfaces, planned, notes, updated_by)
      values (v_tenant, p_patient, (x ->> 'tooth')::smallint, coalesce(nullif(x ->> 'condition', ''), 'healthy'),
              coalesce((select array_agg(s) from jsonb_array_elements_text(x -> 'surfaces') s), '{}'),
              nullif(x ->> 'planned', ''), nullif(x ->> 'notes', ''), clinic.current_user_id())
      on conflict (patient_id, tooth) do update
        set condition = excluded.condition, surfaces = excluded.surfaces, planned = excluded.planned, notes = excluded.notes,
            updated_by = excluded.updated_by, updated_at = now();
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'teeth', n);
end $$;

-- a treatment plan and its items, saved as a whole
create or replace function clinic.save_plan(p_patient bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  v_tenant uuid;
  v_id     bigint := nullif(p ->> 'id', '')::bigint;
  x        jsonb;
  n        int := 0;
  v_svc    uuid;
begin
  select tenant_id into v_tenant from clinic.patients where id = p_patient;
  perform clinic.require_role(v_tenant, array['owner', 'manager', 'doctor', 'nurse']);
  perform clinic.require_clinical(v_tenant);
  if v_id is null then
    insert into clinic.treatment_plans (tenant_id, patient_id, doctor_id, title, discount, notes, created_by)
    values (v_tenant, p_patient,
            coalesce(nullif(p ->> 'doctor_id', '')::uuid, (select doctor_id from clinic.tenant_members where tenant_id = v_tenant and user_id = clinic.current_user_id()),
                     (select id from clinic.doctors where tenant_id = v_tenant and is_active order by sort limit 1)),
            coalesce(nullif(p ->> 'title', ''), 'خطة العلاج'), coalesce((p ->> 'discount')::numeric, 0), nullif(p ->> 'notes', ''),
            clinic.current_user_id())
    returning id into v_id;
  else
    update clinic.treatment_plans
       set title = coalesce(nullif(p ->> 'title', ''), title), discount = coalesce((p ->> 'discount')::numeric, discount),
           notes = case when p ? 'notes' then nullif(p ->> 'notes', '') else notes end,
           doctor_id = coalesce(nullif(p ->> 'doctor_id', '')::uuid, doctor_id),
           status = case when p ->> 'status' in ('draft', 'quoted', 'accepted', 'in_progress', 'done', 'cancelled') then p ->> 'status' else status end
     where id = v_id and patient_id = p_patient;
  end if;
  if jsonb_typeof(p -> 'items') = 'array' then
    delete from clinic.treatment_plan_items i where i.plan_id = v_id and i.status = 'planned'
       and not exists (select 1 from jsonb_array_elements(p -> 'items') y where (y ->> 'id')::bigint = i.id);
    for x in select * from jsonb_array_elements(p -> 'items') loop
      n := n + 1;
      v_svc := nullif(x ->> 'service_id', '')::uuid;
      if nullif(x ->> 'id', '') is null then
        insert into clinic.treatment_plan_items (tenant_id, plan_id, seq, tooth, service_id, label, price, sessions, session_gap_days, notes)
        values (v_tenant, v_id, n, nullif(x ->> 'tooth', '')::smallint, v_svc,
                coalesce(nullif(x ->> 'label', ''), (select name_ar from clinic.services where id = v_svc), 'علاج'),
                coalesce((x ->> 'price')::numeric, (select price from clinic.services where id = v_svc)),
                coalesce((x ->> 'sessions')::int, (select sessions from clinic.services where id = v_svc), 1),
                coalesce((x ->> 'session_gap_days')::int, (select session_gap_days from clinic.services where id = v_svc)),
                nullif(x ->> 'notes', ''));
      else
        update clinic.treatment_plan_items
           set seq = n, tooth = nullif(x ->> 'tooth', '')::smallint, service_id = v_svc,
               label = coalesce(nullif(x ->> 'label', ''), label), price = (x ->> 'price')::numeric,
               sessions = coalesce((x ->> 'sessions')::int, sessions), session_gap_days = (x ->> 'session_gap_days')::int,
               notes = nullif(x ->> 'notes', ''),
               status = case when x ->> 'status' in ('planned', 'booked', 'in_progress', 'done', 'cancelled') then x ->> 'status' else status end
         where id = (x ->> 'id')::bigint and plan_id = v_id;
      end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'total', clinic.plan_total(v_id), 'text', clinic.plan_text(v_id));
end $$;

-- ---------------------------------------------------------------------
-- Publishing a reviewed price-list import — through catalog_change, so it can be undone
-- p_items = [{name_ar, name_en?, category?, price?, price_max?, price_kind?, unit?, duration?, sessions?,
--             session_gap_days?, description_ar?, aliases?}]
-- ---------------------------------------------------------------------
create or replace function clinic.publish_catalog_import(p_import uuid, p_items jsonb, p_mode text default 'merge')
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  im      clinic.catalog_imports%rowtype;
  x       jsonb;
  v_sid   uuid;
  v_changes jsonb := '[]'::jsonb;
  v_seen  uuid[] := '{}';
  v_doc   text;
  r       jsonb;
begin
  select * into im from clinic.catalog_imports where id = p_import for update;
  if not found then raise exception 'import not found'; end if;
  perform clinic.require_role(im.tenant_id, array['owner', 'manager', 'doctor']);
  v_doc := (select code from clinic.doctors where id = im.doctor_id);
  for x in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_sid := clinic.match_service(im.tenant_id, coalesce(x ->> 'name_ar', x ->> 'name_en'), im.doctor_id);
    if v_sid is not null and clinic.norm((select name_ar from clinic.services where id = v_sid)) <> clinic.norm(coalesce(x ->> 'name_ar', x ->> 'name_en')) then
      v_sid := null;   -- only an exact name match updates; everything else is new
    end if;
    if v_sid is not null then
      v_seen := v_seen || v_sid;
      v_changes := v_changes || jsonb_build_object('op', 'update_service', 'service', (select code from clinic.services where id = v_sid),
        'fields', jsonb_strip_nulls(jsonb_build_object('price', (x ->> 'price')::numeric, 'price_max', (x ->> 'price_max')::numeric,
                    'price_kind', nullif(x ->> 'price_kind', ''), 'price_unit', nullif(x ->> 'unit', ''),
                    'duration_min', (x ->> 'duration')::int, 'sessions', (x ->> 'sessions')::int,
                    'description_ar', nullif(x ->> 'description_ar', ''), 'name_en', nullif(x ->> 'name_en', ''), 'is_active', true)));
    else
      v_changes := v_changes || (x || jsonb_build_object('op', 'add_service', 'doctor', v_doc));
    end if;
  end loop;
  if p_mode = 'replace' then
    for v_sid in select s.id from clinic.services s
                  where s.tenant_id = im.tenant_id and s.is_active and not (s.id = any(v_seen))
                    and (im.doctor_id is null or im.doctor_id = any(s.doctor_ids)) loop
      v_changes := v_changes || jsonb_build_object('op', 'remove_service', 'service', (select code from clinic.services where id = v_sid));
    end loop;
  end if;
  r := clinic.catalog_change(im.tenant_id, v_changes, true, 'import');
  update clinic.catalog_imports set status = 'published', published_by = clinic.current_user_id(), published_at = now() where id = im.id;
  update clinic.services set source_import_id = im.id
   where id in (select (e ->> 'id')::uuid from clinic.catalog_changes c, jsonb_array_elements(c.entries) e
                 where c.id = (r ->> 'change_id')::bigint and e ->> 'op' = 'add_service');
  return r;
end $$;

-- what the agent reads, for the "how the assistant sees it" preview in Services & prices
create or replace function clinic.agent_digest(p_tenant uuid)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  perform clinic.ensure_snapshot(p_tenant);
  return (select jsonb_build_object('digest', digest_text, 'built_at', built_at, 'rev', source_rev, 'lookup', lookup)
            from clinic.catalog_snapshot where tenant_id = p_tenant);
end $$;
