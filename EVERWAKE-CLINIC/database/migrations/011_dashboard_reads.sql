-- =====================================================================
-- Everwake Clinic · 011 · what the dashboard reads in one call
--
-- Small read functions the dashboard's pages use, so a page asks once and
-- gets names along with the ids (the patient behind an alert, the doctor of
-- a waitlist entry). Each checks the caller's role first.
-- =====================================================================

-- alerts with who they are about: the emergency banner, Today, the Alerts page
create or replace function clinic.alert_list(p_tenant uuid, p_status text default 'open', p_kind text default null, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  return coalesce((select jsonb_agg(x order by (x ->> 'severity' = 'critical') desc, (x ->> 'created_at') desc) from (
    select to_jsonb(al) || jsonb_build_object(
             'who', coalesce(p.full_name, co.full_name, co.display_name),
             'phone', coalesce(co.phone, p.phone),
             'doctor', clinic.doctor_label(al.doctor_id, 'ar'),
             'appointment', (select clinic.appt_when(a) from clinic.appointments a where a.id = al.appointment_id)) as x
      from clinic.alerts al
      left join clinic.patients p on p.id = al.patient_id
      left join clinic.contacts co on co.id = al.contact_id
     where al.tenant_id = p_tenant
       and (p_status is null or p_status = 'all' or al.status = p_status)
       and (p_kind is null or al.kind = p_kind)
     order by al.created_at desc
     limit least(coalesce(p_limit, 50), 200)) q), '[]'::jsonb);
end $$;

grant execute on function clinic.alert_list(uuid, text, text, int) to authenticated;

-- the inbox: chats with who they are, the ones that need someone first
-- p_filter: 'attention' (an emergency, a question for the team, a taken-over chat with unread) · 'human' · 'all'
create or replace function clinic.inbox_list(p_tenant uuid, p_filter text default 'all', p_q text default null, p_limit int default 80)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare v_q text := clinic.norm(p_q); v_d text := clinic.digits(p_q);
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
             'id', c.id, 'wa_id', c.wa_id, 'mode', c.mode, 'needs_attention', c.needs_attention, 'attention_reason', c.attention_reason,
             'urgency', c.urgency, 'questions_open', c.questions_open, 'unread_count', c.unread_count, 'last_message_at', c.last_message_at,
             'last_message_preview', c.last_message_preview, 'human_since', c.human_since,
             'name', coalesce(co.full_name, co.display_name), 'phone', co.phone,
             'patients', (select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'relation', pc.relation) order by pc.relation = 'self' desc)
                            from clinic.patient_contacts pc join clinic.patients p on p.id = pc.patient_id where pc.contact_id = co.id),
             'next', (select jsonb_build_object('id', a.id, 'starts_at', coalesce(a.est_at, a.starts_at))
                        from clinic.appointments a where a.tenant_id = c.tenant_id and a.wa_id = c.wa_id and a.status in ('booked', 'confirmed')
                         and a.ends_at > now() order by a.starts_at limit 1)) as x
      from clinic.conversations c left join clinic.contacts co on co.id = c.contact_id
     where c.tenant_id = p_tenant and c.kind = 'patient'
       and (coalesce(p_filter, 'all') = 'all'
            or (p_filter = 'attention' and (c.needs_attention or c.questions_open > 0 or c.urgency is not null or (c.mode = 'human' and c.unread_count > 0)))
            or (p_filter = 'human' and c.mode = 'human'))
       and (v_q = '' or clinic.norm(coalesce(co.full_name, co.display_name, '')) like '%' || v_q || '%'
            or (length(v_d) >= 4 and c.wa_id like '%' || v_d || '%'))
     order by (c.urgency = 'emergency') desc nulls last, (c.questions_open > 0 or c.needs_attention) desc, c.last_message_at desc nulls last
     limit least(coalesce(p_limit, 80), 200)) q), '[]'::jsonb);
end $$;

-- one chat: the messages, the questions the assistant asked the team, and who it is
create or replace function clinic.inbox_thread(p_conversation bigint, p_limit int default 120)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare c clinic.conversations%rowtype;
begin
  select * into c from clinic.conversations where id = p_conversation;
  if not found then raise exception 'conversation not found'; end if;
  perform clinic.require_role(c.tenant_id, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  update clinic.conversations set unread_count = 0 where id = c.id and unread_count > 0;
  return jsonb_build_object(
    'conversation', (select to_jsonb(c) - 'state' || jsonb_build_object('name', coalesce(co.full_name, co.display_name), 'phone', co.phone,
                                                                        'language', co.language, 'contact_id', co.id)
                       from (select 1) one left join clinic.contacts co on co.id = c.contact_id),
    'messages', coalesce((select jsonb_agg(to_jsonb(m) - 'raw_payload' order by m.created_at, m.id) from (
                  select * from clinic.messages where conversation_id = c.id order by created_at desc, id desc limit least(coalesce(p_limit, 120), 400)) m), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(to_jsonb(q) order by q.asked_at) from clinic.team_questions q
                            where q.conversation_id = c.id and (q.status = 'open' or q.answered_at > now() - interval '2 days')), '[]'::jsonb),
    'patients', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'relation', pc.relation, 'file_no', p.file_no,
                                                              'age', clinic.age_text(p.birth_date, 'ar'), 'age_en', clinic.age_text(p.birth_date, 'en')))
                            from clinic.patient_contacts pc join clinic.patients p on p.id = pc.patient_id where pc.contact_id = c.contact_id), '[]'::jsonb),
    'appointments', coalesce((select jsonb_agg(clinic.appt_card(a, clinic.can_see_clinical(c.tenant_id)) order by a.starts_at)
                               from clinic.appointments a where a.tenant_id = c.tenant_id and a.wa_id = c.wa_id
                                and a.status in ('booked', 'confirmed', 'arrived', 'in_visit') and a.ends_at > now() - interval '2 hours'), '[]'::jsonb));
end $$;

grant execute on function clinic.inbox_list(uuid, text, text, int), clinic.inbox_thread(bigint, int) to authenticated;

-- the waitlist: who is waiting for an earlier time, with whom and when
create or replace function clinic.waitlist_list(p_tenant uuid, p_status text default 'open')
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
begin
  perform clinic.require_role(p_tenant, array['owner', 'manager', 'doctor', 'nurse', 'receptionist']);
  return coalesce((select jsonb_agg(to_jsonb(w) || jsonb_build_object(
             'patient', p.full_name, 'phone', coalesce(p.phone, w.wa_id), 'doctor', clinic.doctor_label(w.doctor_id, 'ar'),
             'doctor_en', clinic.doctor_label(w.doctor_id, 'en'), 'location', clinic.location_label(w.location_id, 'ar'),
             'service', s.name_ar, 'service_en', s.name_en,
             'holds', (select jsonb_build_object('id', a.id, 'starts_at', coalesce(a.est_at, a.starts_at)) from clinic.appointments a where a.id = w.appointment_id))
           order by (w.status = 'offered') desc, w.created_at)
    from clinic.waitlist w left join clinic.patients p on p.id = w.patient_id left join clinic.services s on s.id = w.service_id
   where w.tenant_id = p_tenant and (p_status = 'all' or (p_status = 'open' and w.status in ('waiting', 'offered')) or w.status = p_status)), '[]'::jsonb);
end $$;

grant execute on function clinic.waitlist_list(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- The patient's own page, from the link in every reminder (/a/<token>):
-- see the appointment, confirm it, pick another time, or cancel. No sign-in:
-- the token is the key. Called by the dashboard's server with the service
-- role only (never granted to anon).
-- ---------------------------------------------------------------------
create or replace function clinic.manage_view(p_token text, p_lang text default 'ar')
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare
  a  clinic.appointments%rowtype;
  t  clinic.tenants%rowtype;
  l  clinic.locations%rowtype;
  st jsonb;
  v_lang text := case when p_lang = 'en' then 'en' else 'ar' end;
begin
  select * into a from clinic.appointments where manage_token = p_token and ref_no is not null;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  select * into t from clinic.tenants where id = a.tenant_id;
  select * into l from clinic.locations where id = a.location_id;
  st := clinic.merged_settings(t.settings);
  return jsonb_build_object('ok', true,
    'appointment', clinic.appointment_view(a, v_lang),
    'clinic', jsonb_build_object('name', case when v_lang = 'en' then t.name_en else t.name_ar end, 'brand', clinic.merged_profile(t.profile) -> 'brand',
                                 'phone', clinic.merged_profile(t.profile) -> 'contacts' ->> 'phone', 'timezone', t.timezone),
    'place', jsonb_build_object('name', case when v_lang = 'en' then coalesce(l.name_en, l.name_ar) else l.name_ar end,
                                'address', case when v_lang = 'en' then coalesce(l.address_en, l.address_ar) else l.address_ar end,
                                'directions', l.directions_ar, 'maps_url', coalesce(l.maps_url, case when l.lat is not null then format('https://maps.google.com/?q=%s,%s', l.lat, l.lng) end),
                                'phone', l.phone),
    'first_name', clinic.first_name((select full_name from clinic.patients where id = a.patient_id), null),
    'can_change', a.status in ('booked', 'confirmed') and coalesce(a.est_at, a.starts_at) > now()
                  and (coalesce((st -> 'booking' ->> 'cancel_hours')::int, 0) = 0
                       or coalesce(a.est_at, a.starts_at) > now() + make_interval(hours => (st -> 'booking' ->> 'cancel_hours')::int)),
    'cancel_hours', coalesce((st -> 'booking' ->> 'cancel_hours')::int, 0));
end $$;

create or replace function clinic.manage_slots(p_token text, p_from date default null)
returns jsonb language plpgsql stable security definer set search_path = clinic, pg_temp as $$
declare a clinic.appointments%rowtype;
begin
  select * into a from clinic.appointments where manage_token = p_token and ref_no is not null and status in ('booked', 'confirmed');
  if not found then return jsonb_build_object('slots', '[]'::jsonb); end if;
  return clinic.available_slots(a.tenant_id, jsonb_build_object('doctor_id', a.doctor_id, 'service_id', a.service_id, 'patient_id', a.patient_id,
           'from', p_from, 'limit', 120, 'ignore_appointment', a.id));
end $$;

-- p_action: confirm · cancel {reason} · move {starts_at | date, kind, location_id}
create or replace function clinic.manage_action(p_token text, p_action text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = clinic, pg_temp as $$
declare
  a clinic.appointments%rowtype;
  v jsonb;
  r jsonb;
begin
  select * into a from clinic.appointments where manage_token = p_token and ref_no is not null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  v := clinic.manage_view(p_token);
  if not (v ->> 'can_change')::boolean then return jsonb_build_object('ok', false, 'error', 'TOO_LATE_TO_CHANGE'); end if;
  if p_action = 'confirm' then
    update clinic.appointments set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()) where id = a.id;
    update clinic.delay_notice_items set status = 'accepted', replied_at = coalesce(replied_at, now()) where appointment_id = a.id and status = 'sent';
    perform clinic.log_appt(a.id, 'confirmed', jsonb_build_object('via', 'link'), 'patient');
    return jsonb_build_object('ok', true, 'status', 'CONFIRMED');
  elsif p_action = 'cancel' then
    r := clinic.cancel_appointment(a.id, 'patient', coalesce(nullif(p ->> 'reason', ''), 'from the link'), false);
    if (r ->> 'ok')::boolean then
      perform clinic.raise_alert(jsonb_build_object('tenant_id', a.tenant_id, 'kind', 'cancelled', 'severity', 'low', 'appointment_id', a.id,
        'title', 'مريض لغى من الرابط', 'body', clinic.appt_when(a), 'notify_doctor', false));
    end if;
    return r;
  elsif p_action = 'move' then
    r := clinic.reschedule_appointment(a.id, jsonb_build_object('starts_at', p ->> 'starts_at', 'date', p ->> 'date', 'kind', p ->> 'kind',
           'location_id', p ->> 'location_id', 'staff', false, 'notify', false, 'by_role', 'patient'));
    return r;
  end if;
  return jsonb_build_object('ok', false, 'error', 'UNKNOWN_ACTION');
end $$;

revoke all on function clinic.manage_view(text, text), clinic.manage_slots(text, date), clinic.manage_action(text, text, jsonb) from public;
grant execute on function clinic.manage_view(text, text), clinic.manage_slots(text, date), clinic.manage_action(text, text, jsonb) to service_role;
