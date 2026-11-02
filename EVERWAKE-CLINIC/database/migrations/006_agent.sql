-- =====================================================================
-- Everwake Clinic · 006 · alerts, and what the agent reads each turn
--
--   alerts         what the dashboard must show now: an emergency (red
--                  banner, chime, a WhatsApp to the doctor's own number),
--                  something urgent, an unconfirmed visit, a patient who
--                  did not answer a delay notice…
--   raise_alert()  one per thing (repeats within 30 minutes update it)
--   turn_context() everything the Brain and the Agent need for one turn:
--                  the contact and the patients they book for, upcoming
--                  and past visits, the booking in progress, what a
--                  reminder or a delay notice asked them, the catalogue
--                  snapshot, the team's answers, the last messages
--   save_document() a photo or file a patient sent, kept on their record
-- =====================================================================

create table clinic.alerts (
  id                   bigint generated always as identity primary key,
  tenant_id            uuid not null references clinic.tenants(id) on delete cascade,
  kind                 text not null check (kind in ('emergency', 'urgent', 'attention', 'at_risk', 'no_reply', 'cancelled',
                                                     'waitlist', 'payment', 'team_question', 'system')),
  severity             text not null default 'normal' check (severity in ('critical', 'high', 'normal', 'low')),
  title                text not null,
  body                 text,
  patient_id           bigint references clinic.patients(id) on delete set null,
  contact_id           bigint references clinic.contacts(id) on delete set null,
  wa_id                text,
  conversation_id      bigint references clinic.conversations(id) on delete set null,
  appointment_id       bigint references clinic.appointments(id) on delete set null,
  doctor_id            uuid references clinic.doctors(id) on delete set null,
  data                 jsonb not null default '{}'::jsonb,
  status               text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by      uuid,
  acknowledged_by_name text,
  acknowledged_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index alerts_open_idx on clinic.alerts (tenant_id, status, created_at desc);
create trigger alerts_touch before update on clinic.alerts for each row execute function clinic.touch_updated_at();

-- p = {tenant_id, kind, severity?, title?, body?, wa_id?, appointment_id?, patient_id?, doctor_id?, data?, notify_doctor?}
create or replace function clinic.raise_alert(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_kind   text := coalesce(nullif(p ->> 'kind', ''), 'attention');
  v_sev    text := coalesce(nullif(p ->> 'severity', ''),
                            case v_kind when 'emergency' then 'critical' when 'urgent' then 'high' else 'normal' end);
  v_wa     text := nullif(p ->> 'wa_id', '');
  v_appt   bigint := nullif(p ->> 'appointment_id', '')::bigint;
  conv     clinic.conversations%rowtype;
  co       clinic.contacts%rowtype;
  al       clinic.alerts%rowtype;
  st       jsonb;
  v_doc    uuid := nullif(p ->> 'doctor_id', '')::uuid;
  v_pat    bigint := nullif(p ->> 'patient_id', '')::bigint;
  v_title  text;
  v_phones text[];
  v_ph     text;
  v_sent   int := 0;
  v_url    text;
begin
  if v_tenant is null then return null; end if;
  if v_wa is not null then
    select * into conv from clinic.conversations where tenant_id = v_tenant and wa_id = v_wa;
    select * into co from clinic.contacts where id = conv.contact_id;
  end if;
  if v_appt is not null then
    select coalesce(v_doc, a.doctor_id), coalesce(v_pat, a.patient_id), coalesce(v_wa, a.wa_id) into v_doc, v_pat, v_wa
      from clinic.appointments a where a.id = v_appt;
  end if;
  -- which doctor: the one named, else the one their next visit (or the booking in progress) is with
  if v_doc is null and v_wa is not null then
    select a.doctor_id into v_doc from clinic.appointments a
     where a.tenant_id = v_tenant and a.wa_id = v_wa and a.status in ('held', 'booked', 'confirmed') order by a.starts_at limit 1;
    if v_doc is null then
      select nullif(data ->> 'doctor_id', '')::uuid into v_doc from clinic.booking_drafts where tenant_id = v_tenant and wa_id = v_wa;
    end if;
  end if;
  -- a red flag of one speciality (a dental swelling) goes to that speciality's doctor
  if nullif(p ->> 'specialty', '') is not null
     and (v_doc is null or (select specialty from clinic.doctors where id = v_doc) is distinct from p ->> 'specialty') then
    v_doc := coalesce(
      (select a.doctor_id from clinic.appointments a join clinic.doctors d on d.id = a.doctor_id
        where a.tenant_id = v_tenant and a.wa_id = v_wa and a.status in ('held', 'booked', 'confirmed') and d.specialty = p ->> 'specialty'
        order by a.starts_at limit 1),
      (select d.id from clinic.doctors d where d.tenant_id = v_tenant and d.is_active and d.specialty = p ->> 'specialty' order by d.sort limit 1),
      v_doc);
  end if;
  v_title := coalesce(nullif(p ->> 'title', ''), case v_kind
    when 'emergency' then 'حالة طارئة محتملة'
    when 'urgent' then 'حالة محتاجة اهتمام سريع'
    when 'at_risk' then 'ميعاد لسه متأكدش'
    when 'no_reply' then 'مريض مردش على تغيير الميعاد'
    else 'محتاج متابعة' end);

  select * into al from clinic.alerts a
   where a.tenant_id = v_tenant and a.kind = v_kind and a.status = 'open'
     and ((v_wa is not null and a.wa_id = v_wa) or (v_appt is not null and a.appointment_id = v_appt))
     and a.created_at > now() - interval '30 minutes'
   order by a.created_at desc limit 1;
  if al.id is not null then
    update clinic.alerts set body = coalesce(nullif(p ->> 'body', ''), body), data = data || coalesce(p -> 'data', '{}'::jsonb),
                             severity = case when v_sev = 'critical' or severity = 'critical' then 'critical' else v_sev end
     where id = al.id returning * into al;
    return jsonb_build_object('alert_id', al.id, 'repeat', true);
  end if;

  insert into clinic.alerts (tenant_id, kind, severity, title, body, patient_id, contact_id, wa_id, conversation_id,
                             appointment_id, doctor_id, data)
  values (v_tenant, v_kind, v_sev, v_title, nullif(p ->> 'body', ''), v_pat, co.id, v_wa, conv.id, v_appt, v_doc,
          coalesce(p -> 'data', '{}'::jsonb))
  returning * into al;

  if v_kind in ('emergency', 'urgent') and conv.id is not null then
    update clinic.conversations
       set urgency = case when v_kind = 'emergency' or urgency = 'emergency' then 'emergency' else 'urgent' end,
           needs_attention = true, attention_reason = coalesce(nullif(p ->> 'body', ''), v_title), attention_at = now()
     where id = conv.id;
  end if;

  -- an emergency reaches the doctor's own WhatsApp too
  select clinic.merged_settings(settings) into st from clinic.tenants where id = v_tenant;
  if v_kind = 'emergency' and coalesce((st -> 'emergency' ->> 'whatsapp_doctor')::boolean, true)
     and coalesce((p ->> 'notify_doctor')::boolean, true) then
    v_phones := case
      when v_doc is not null then array_remove(array[(select clinic.wa_phone(ops_whatsapp) from clinic.doctors where id = v_doc)], null)
      else '{}' end;
    if cardinality(v_phones) = 0 and coalesce(st ->> 'ops_whatsapp', '') <> '' then v_phones := array[clinic.wa_phone(st ->> 'ops_whatsapp')]; end if;
    if cardinality(v_phones) = 0 then
      select array_agg(x) into v_phones from (select clinic.wa_phone(ops_whatsapp) x from clinic.doctors
                                               where tenant_id = v_tenant and is_active and ops_whatsapp is not null order by sort limit 3) z;
    end if;
    v_url := nullif(rtrim(coalesce(st ->> 'public_url', ''), '/'), '');
    foreach v_ph in array coalesce(v_phones, '{}') loop
      if v_ph is not null and clinic.queue_ops_message(v_tenant, v_ph, 'staff_alert',
           format(E'🚨 حالة طارئة محتملة\n%s%s كتب: «%s»\nالمساعد نصحه يتصل بالإسعاف أو يروح أقرب طوارئ.%s',
                  coalesce(nullif(clinic.first_name(co.full_name, co.display_name), ''), 'مريض'),
                  coalesce(' (' || case when co.phone is not null then '0' || substr(co.phone, 3) end || ')', ''),
                  left(coalesce(p ->> 'body', ''), 300),
                  coalesce(E'\n' || v_url || '/inbox?c=' || conv.id, ''))) then
        v_sent := v_sent + 1;
      end if;
    end loop;
  end if;
  return jsonb_build_object('alert_id', al.id, 'repeat', false, 'doctor_notified', v_sent);
end $$;

create or replace function clinic.acknowledge_alert(p_alert bigint, p_resolve boolean default false)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare al clinic.alerts%rowtype;
begin
  select * into al from clinic.alerts where id = p_alert for update;
  if not found then raise exception 'no such alert'; end if;
  perform clinic.require_role(al.tenant_id, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  update clinic.alerts
     set status = case when p_resolve then 'resolved' else 'acknowledged' end,
         acknowledged_by = coalesce(acknowledged_by, clinic.current_user_id()),
         acknowledged_by_name = coalesce(acknowledged_by_name, clinic.my_name(al.tenant_id)),
         acknowledged_at = coalesce(acknowledged_at, now())
   where id = al.id returning * into al;
  if p_resolve and al.conversation_id is not null and al.kind in ('emergency', 'urgent') then
    update clinic.conversations set urgency = null, needs_attention = false where id = al.conversation_id;
  end if;
  return jsonb_build_object('ok', true, 'status', al.status);
end $$;

-- ---------------------------------------------------------------------
-- A patient's photo or file, kept (the engine read it already)
-- p = {tenant_id, wa_id, message_id?, kind?, title?, summary?, values?, url?, mime?}
-- ---------------------------------------------------------------------
create or replace function clinic.save_document(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  co       clinic.contacts%rowtype;
  v_pat    bigint;
  v_appt   bigint;
  v_id     bigint;
begin
  select c.* into co from clinic.contacts c where c.tenant_id = v_tenant and c.wa_id = v_wa;
  -- the patient: the one with the next visit, else their only (or own) record
  select a.patient_id, a.id into v_pat, v_appt from clinic.appointments a
   where a.tenant_id = v_tenant and (a.wa_id = v_wa or a.contact_id = co.id) and a.status in ('booked', 'confirmed', 'held')
   order by a.starts_at limit 1;
  if v_pat is null then
    select pc.patient_id into v_pat from clinic.patient_contacts pc where pc.contact_id = co.id
     order by (pc.relation = 'self') desc limit 1;
  end if;
  insert into clinic.documents (tenant_id, patient_id, contact_id, appointment_id, message_id, kind, title, url, mime,
                                source, ai_summary, ai_values)
  values (v_tenant, v_pat, co.id, v_appt, nullif(p ->> 'message_id', '')::bigint,
          case when p ->> 'kind' in ('lab', 'imaging', 'prescription', 'photo', 'report', 'referral', 'other') then p ->> 'kind' else 'photo' end,
          left(nullif(p ->> 'title', ''), 200), nullif(p ->> 'url', ''), nullif(p ->> 'mime', ''), 'whatsapp',
          left(nullif(p ->> 'summary', ''), 4000), case when jsonb_typeof(p -> 'values') = 'array' then p -> 'values' end)
  returning id into v_id;
  return jsonb_build_object('document_id', v_id, 'patient_id', v_pat, 'appointment_id', v_appt);
end $$;

-- ---------------------------------------------------------------------
-- Everything the Brain and the Agent need for one turn
-- ---------------------------------------------------------------------
create or replace function clinic.turn_context(p_tenant uuid, p_wa text)
returns jsonb language plpgsql as $$
declare
  t      clinic.tenants%rowtype;
  st     jsonb;
  conv   clinic.conversations%rowtype;
  co     clinic.contacts%rowtype;
  snap   clinic.catalog_snapshot%rowtype;
  dr     clinic.booking_drafts%rowtype;
  hold   clinic.appointments%rowtype;
  v_lang text;
begin
  perform clinic.ensure_snapshot(p_tenant);
  select * into t from clinic.tenants where id = p_tenant;
  st := clinic.merged_settings(t.settings);
  select * into conv from clinic.conversations where tenant_id = p_tenant and wa_id = p_wa;
  select * into co from clinic.contacts where id = conv.contact_id;
  select * into snap from clinic.catalog_snapshot where tenant_id = p_tenant;
  select * into dr from clinic.booking_drafts where tenant_id = p_tenant and wa_id = p_wa;
  if dr.hold_id is not null then select * into hold from clinic.appointments where id = dr.hold_id; end if;
  v_lang := clinic.contact_language(p_tenant, p_wa);

  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'status', t.status, 'timezone', t.timezone,
                                 'name_ar', t.name_ar, 'name_en', t.name_en, 'currency', t.currency,
                                 'currency_symbol', t.currency_symbol_ar, 'country', t.country, 'specialty', t.specialty),
    'profile', clinic.merged_profile(t.profile),
    'booking_rules', st -> 'booking',
    'emergency', st -> 'emergency',
    'allowed_links', st -> 'allowed_links',
    'public_url', st ->> 'public_url',
    'state', coalesce(conv.state, '{}'::jsonb),
    'conversation', jsonb_build_object('id', conv.id, 'mode', conv.mode, 'needs_attention', conv.needs_attention,
                                       'urgency', conv.urgency, 'created_at', conv.created_at),
    'contact', jsonb_build_object('id', co.id, 'wa_id', co.wa_id, 'phone', co.phone, 'phone_hidden', co.phone_hidden,
                                  'display_name', co.display_name, 'full_name', co.full_name, 'language', co.language,
                                  'first_seen_at', co.first_seen_at),
    'known_patients', clinic.contact_patients(co.id),
    'upcoming', coalesce((select jsonb_agg(clinic.appointment_view(a, v_lang) order by a.starts_at)
                            from clinic.appointments a
                           where a.tenant_id = p_tenant and (a.wa_id = p_wa or a.contact_id = co.id)
                             and a.status in ('booked', 'confirmed', 'arrived', 'in_visit') and a.ends_at > now() - interval '2 hours'), '[]'::jsonb),
    'past_visits', coalesce((select jsonb_agg(x order by x ->> 'starts_at' desc) from (
                               select clinic.appointment_view(a, v_lang) as x from clinic.appointments a
                                where a.tenant_id = p_tenant and (a.wa_id = p_wa or a.contact_id = co.id)
                                  and a.status in ('done', 'no_show', 'cancelled') and a.ref_no is not null
                                order by a.starts_at desc limit 4) q), '[]'::jsonb),
    'draft', case when dr.wa_id is not null then jsonb_build_object(
                'data', dr.data - 'last_offered', 'last_offered', dr.data -> 'last_offered',
                'held', case when hold.id is not null and hold.status = 'held' and hold.hold_expires_at > now()
                             then clinic.appointment_view(hold, v_lang) end,
                'summary_shown', dr.summary_at is not null and dr.summary_at >= dr.changed_at,
                'updated_at', dr.updated_at) end,
    'pending', jsonb_strip_nulls(jsonb_build_object(
                 'reminder', conv.state -> 'pending_reminder', 'delay', conv.state -> 'pending_delay',
                 'offer', conv.state -> 'pending_offer', 'plan', conv.state -> 'pending_plan',
                 'session_cancelled', conv.state -> 'pending_reschedule')),
    'delays_today', coalesce((select jsonb_agg(jsonb_build_object('doctor', clinic.doctor_label(dn.doctor_id, 'ar'), 'minutes', dn.minutes,
                                                                  'kind', dn.kind, 'reason', dn.reason, 'at', dn.sent_at))
                                from clinic.delay_notices dn
                               where dn.tenant_id = p_tenant and dn.session_date = clinic.local_today(p_tenant) and dn.status = 'sent'), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('plan_id', pl.id, 'status', pl.status, 'patient', p.full_name,
                                                           'doctor', clinic.doctor_label(pl.doctor_id, 'ar'), 'total', clinic.plan_total(pl.id),
                                                           'next', clinic.plan_next(pl.id)))
                         from clinic.treatment_plans pl join clinic.patients p on p.id = pl.patient_id
                         join clinic.patient_contacts pc on pc.patient_id = pl.patient_id
                        where pc.contact_id = co.id and pl.status in ('quoted', 'accepted', 'in_progress')), '[]'::jsonb),
    'documents_recent', coalesce((select jsonb_agg(jsonb_build_object('kind', d.kind, 'title', d.title, 'summary', left(d.ai_summary, 300),
                                                                      'at', d.created_at) order by d.created_at desc)
                                    from (select * from clinic.documents where contact_id = co.id and created_at > now() - interval '3 days'
                                          order by created_at desc limit 3) d), '[]'::jsonb),
    'team_questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question, 'asked_at', q.asked_at,
                                                                    'status', q.status, 'answer_kind', q.answer_kind, 'answer', q.answer,
                                                                    'answered_by', q.answered_by_name, 'told', q.told_at is not null)
                                                 order by q.asked_at)
                                  from (select * from clinic.team_questions where tenant_id = p_tenant and wa_id = p_wa
                                          and status <> 'dismissed' and asked_at > now() - interval '24 hours'
                                        order by asked_at desc limit 6) q), '[]'::jsonb),
    'recent_messages', coalesce((select jsonb_agg(jsonb_build_object('direction', m.direction, 'sender', m.sender, 'kind', m.kind,
                                                                     'text', coalesce(m.meta ->> 'understood', m.body), 'at', m.created_at,
                                                                     'purpose', m.meta ->> 'purpose', 'reply_to', m.meta ->> 'reply_to')
                                                  order by m.created_at)
                                   from (select * from clinic.messages where tenant_id = p_tenant and wa_id = p_wa and status not in ('failed', 'cancelled')
                                         order by created_at desc limit 20) m), '[]'::jsonb),
    'pause', (select jsonb_build_object('apologized_at', pc.apologized_at, 'resume_notified_at', pc.resume_notified_at)
                from clinic.pause_contacts pc where pc.tenant_id = p_tenant and pc.wa_id = p_wa
                 and pc.last_message_at > now() - interval '24 hours' order by pc.last_message_at desc limit 1),
    'catalog_digest', coalesce(snap.digest_text, ''),
    'catalog_lookup', coalesce(snap.lookup, '{}'::jsonb),
    'catalog_version', coalesce(snap.version_hash, 'none'),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name_ar, 'address', l.address_ar,
                                                               'directions', l.directions_ar, 'maps_url', l.maps_url, 'lat', l.lat, 'lng', l.lng)
                                            order by l.sort)
                             from clinic.locations l where l.tenant_id = p_tenant and l.is_active), '[]'::jsonb),
    'specialty_triage', coalesce((select jsonb_agg(x || jsonb_build_object('specialty', sp.code))
                                    from clinic.specialty_presets sp, jsonb_array_elements(sp.triage) x
                                   where sp.code in (select d.specialty from clinic.doctors d where d.tenant_id = p_tenant and d.is_active)), '[]'::jsonb),
    -- the clinic's hours, for placing a time said without ص/م
    'hours', coalesce((select jsonb_agg(distinct jsonb_build_array(to_char(sc.start_time, 'HH24:MI'), to_char(sc.end_time, 'HH24:MI')))
                         from clinic.schedules sc where sc.tenant_id = p_tenant and sc.is_active), '[]'::jsonb),
    'doctors', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'code', d.code, 'name', clinic.doctor_label(d.id, 'ar'),
                                                             'specialty', d.specialty, 'gender', d.gender) order by d.sort)
                           from clinic.doctors d where d.tenant_id = p_tenant and d.is_active), '[]'::jsonb),
    'specialty_keywords', coalesce((select jsonb_object_agg(sp.code, to_jsonb(sp.keywords)) from clinic.specialty_presets sp
                                     where sp.code in (select d.specialty from clinic.doctors d where d.tenant_id = p_tenant and d.is_active)), '{}'::jsonb));
end $$;

-- after the tools ran: what the reply is checked against
create or replace function clinic.read_back(p_tenant uuid, p_wa text)
returns jsonb language plpgsql as $$
declare
  dr   clinic.booking_drafts%rowtype;
  hold clinic.appointments%rowtype;
begin
  select * into dr from clinic.booking_drafts where tenant_id = p_tenant and wa_id = p_wa;
  if dr.hold_id is not null then select * into hold from clinic.appointments where id = dr.hold_id; end if;
  return jsonb_build_object(
    'state', coalesce((select state from clinic.conversations where tenant_id = p_tenant and wa_id = p_wa), '{}'::jsonb),
    'held', case when hold.id is not null and hold.status = 'held' then clinic.appointment_view(hold) end,
    'last_offered', dr.data -> 'last_offered',
    'last_booked', (select clinic.appointment_view(a) from clinic.appointments a
                     where a.tenant_id = p_tenant and a.wa_id = p_wa and a.ref_no is not null and a.created_at > now() - interval '1 day'
                     order by a.updated_at desc limit 1),
    'upcoming', coalesce((select jsonb_agg(clinic.appointment_view(a) order by a.starts_at) from clinic.appointments a
                           where a.tenant_id = p_tenant and a.wa_id = p_wa and a.status in ('booked', 'confirmed') and a.ends_at > now()), '[]'::jsonb));
end $$;
