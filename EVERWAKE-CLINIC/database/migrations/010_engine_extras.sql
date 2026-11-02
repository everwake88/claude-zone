-- =====================================================================
-- Everwake Clinic · 010 · what the engine's other paths read
--
--   staff_context()      the doctor's (or the front desk's) own WhatsApp:
--                        who they are, today's sessions and visits, what
--                        is waiting for their yes, the catalogue
--   test_chat_prepare()  the Test Runner: a pretend patient chats with a
--   test_chat_result()   clinic's agent; nothing goes out on WhatsApp
-- =====================================================================

create or replace function clinic.staff_context(p_tenant uuid, p_wa text, p_staff jsonb)
returns jsonb language plpgsql as $$
declare
  t    clinic.tenants%rowtype;
  conv clinic.conversations%rowtype;
  v_doc uuid := nullif(p_staff ->> 'doctor_id', '')::uuid;
begin
  perform clinic.ensure_snapshot(p_tenant);
  select * into t from clinic.tenants where id = p_tenant;
  select * into conv from clinic.conversations where tenant_id = p_tenant and wa_id = p_wa;
  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'name_ar', t.name_ar, 'name_en', t.name_en, 'timezone', t.timezone,
                                 'currency_symbol', t.currency_symbol_ar),
    'staff', p_staff,
    'doctor', case when v_doc is not null then jsonb_build_object('id', v_doc, 'name', clinic.doctor_label(v_doc, 'ar'),
                                                                  'specialty', (select specialty from clinic.doctors where id = v_doc)) end,
    'state', coalesce(conv.state, '{}'::jsonb),
    'pending', conv.state -> 'staff_pending',
    'today', clinic.staff_tool(p_tenant, p_wa, p_staff, 'today', '{}'),
    'tomorrow', clinic.staff_tool(p_tenant, p_wa, p_staff, 'today',
                                  jsonb_build_object('date', clinic.local_today(p_tenant) + 1)::text),
    'delays_today', coalesce((select jsonb_agg(jsonb_build_object('doctor', clinic.doctor_label(dn.doctor_id, 'ar'), 'minutes', dn.minutes,
                                                                  'kind', dn.kind, 'counts', dn.counts, 'at', dn.sent_at,
                                                                  'tally', (select jsonb_object_agg(z.status, z.n) from (
                                                                              select i.status, count(*) n from clinic.delay_notice_items i
                                                                               where i.notice_id = dn.id group by i.status) z)))
                                from clinic.delay_notices dn where dn.tenant_id = p_tenant and dn.session_date = clinic.local_today(p_tenant)),
                              '[]'::jsonb),
    'doctors', coalesce((select jsonb_agg(jsonb_build_object('code', d.code, 'name', clinic.doctor_label(d.id, 'ar'), 'specialty', d.specialty) order by d.sort)
                           from clinic.doctors d where d.tenant_id = p_tenant and d.is_active), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(l.name_ar order by l.sort) from clinic.locations l where l.tenant_id = p_tenant and l.is_active), '[]'::jsonb),
    'open_alerts', (select count(*) from clinic.alerts where tenant_id = p_tenant and status = 'open'),
    'last_change', (select jsonb_build_object('id', c.id, 'summary', c.summary_ar, 'status', c.status, 'at', coalesce(c.applied_at, c.created_at))
                      from clinic.catalog_changes c where c.tenant_id = p_tenant and c.source = 'whatsapp' order by c.id desc limit 1),
    'catalog_digest', (select digest_text from clinic.catalog_snapshot where tenant_id = p_tenant),
    'recent_messages', coalesce((select jsonb_agg(jsonb_build_object('direction', m.direction, 'text', coalesce(m.meta ->> 'understood', m.body), 'at', m.created_at)
                                                  order by m.created_at)
                                   from (select * from clinic.messages where tenant_id = p_tenant and wa_id = p_wa and status not in ('failed', 'cancelled')
                                         order by created_at desc limit 12) m), '[]'::jsonb));
end $$;

create or replace function clinic.test_chat_prepare(p_clinic text, p_wa text, p_reset boolean default false,
                                                    p_later_hours numeric default 0)
returns jsonb language plpgsql as $$
declare
  t      clinic.tenants%rowtype;
  ch     clinic.whatsapp_channels%rowtype;
  v_co   bigint[];
  v_pat  bigint[];
  v_back interval := make_interval(secs => greatest(coalesce(p_later_hours, 0), 0) * 3600);
  n      int;
begin
  if not clinic.is_test_number(p_wa) then
    raise exception 'The test chat only uses the pretend numbers 200000000001 to 200000000099, not %', p_wa;
  end if;
  select count(*) into n from clinic.tenants
   where slug = lower(btrim(p_clinic)) or slug ilike btrim(p_clinic) || '%' or name_en ilike btrim(p_clinic) || '%' or name_ar = btrim(p_clinic);
  if n <> 1 then raise exception '% clinics match "%" — use the clinic''s exact slug', n, p_clinic; end if;
  select * into t from clinic.tenants
   where slug = lower(btrim(p_clinic)) or slug ilike btrim(p_clinic) || '%' or name_en ilike btrim(p_clinic) || '%' or name_ar = btrim(p_clinic);
  select * into ch from clinic.whatsapp_channels
   where tenant_id = t.id and provider = 'evolution' and is_active and instance_name is not null order by created_at limit 1;
  if ch.id is null then raise exception '% has no WhatsApp number connected yet (Settings → WhatsApp)', t.name_ar; end if;
  select coalesce(array_agg(id), '{}') into v_co from clinic.contacts where tenant_id = t.id and wa_id = p_wa;
  select coalesce(array_agg(patient_id), '{}') into v_pat from clinic.patient_contacts where contact_id = any (v_co);

  if p_reset then
    delete from clinic.appointments       where tenant_id = t.id and (wa_id = p_wa or contact_id = any (v_co));
    delete from clinic.booking_drafts     where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.waitlist           where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.alerts             where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.outbox             where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.messages           where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.conversations      where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.inbound_buffer     where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.conversation_locks where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.pause_contacts     where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.agent_events       where tenant_id = t.id and wa_id = p_wa;
    delete from clinic.patients           where id = any (v_pat)
       and not exists (select 1 from clinic.patient_contacts pc where pc.patient_id = clinic.patients.id and not (pc.contact_id = any (v_co)));
    delete from clinic.contacts           where id = any (v_co);
  elsif v_back > interval '0' then
    update clinic.messages set created_at = created_at - v_back, sent_at = sent_at - v_back where tenant_id = t.id and wa_id = p_wa;
    update clinic.conversations
       set last_message_at = last_message_at - v_back, last_inbound_at = last_inbound_at - v_back,
           last_outbound_at = last_outbound_at - v_back, updated_at = updated_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update clinic.booking_drafts set updated_at = updated_at - v_back where tenant_id = t.id and wa_id = p_wa;
    update clinic.agent_events set created_at = created_at - v_back where tenant_id = t.id and wa_id = p_wa;
  end if;
  return jsonb_build_object('tenant_id', t.id, 'clinic', t.name_ar, 'slug', t.slug, 'status', t.status,
                            'instance', ch.instance_name, 'token', ch.webhook_token, 'wa_id', p_wa,
                            'reset', coalesce(p_reset, false), 'later_hours', greatest(coalesce(p_later_hours, 0), 0), 'since', now(),
                            'last_message_at', (select max(created_at) from clinic.messages where tenant_id = t.id and wa_id = p_wa and direction = 'inbound'));
end $$;

create or replace function clinic.test_chat_result(p_tenant uuid, p_wa text, p_since timestamptz)
returns jsonb language plpgsql stable as $$
declare
  conv clinic.conversations%rowtype;
  ev   clinic.agent_events%rowtype;
begin
  if not clinic.is_test_number(p_wa) then raise exception 'not a test chat: %', p_wa; end if;
  select * into conv from clinic.conversations where tenant_id = p_tenant and wa_id = p_wa;
  select * into ev from clinic.agent_events
   where tenant_id = p_tenant and wa_id = p_wa and created_at >= p_since and stage in ('turn_complete', 'staff_turn')
   order by id desc limit 1;
  return jsonb_build_object(
    'patient', (select string_agg(body, E'\n' order by id) from clinic.messages
                 where tenant_id = p_tenant and wa_id = p_wa and direction = 'inbound' and created_at >= p_since),
    'replies', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'text', body, 'sender', sender) order by id)
                           from clinic.messages where tenant_id = p_tenant and wa_id = p_wa and direction = 'outbound' and created_at >= p_since), '[]'),
    'turn', case when ev.id is null then null else jsonb_build_object(
              'stage', ev.booking_stage, 'seconds', round(ev.duration_total_ms / 1000.0, 1),
              'tokens', coalesce(ev.prompt_tokens, 0) + coalesce(ev.completion_tokens, 0),
              'plan', ev.output -> 'brain', 'tools', ev.output -> 'tools_used', 'calls', ev.output -> 'tool_calls',
              'caught', ev.output -> 'violations', 'rewritten', ev.repair_used, 'agent_error', ev.output ->> 'agent_error',
              'booked', ev.output ->> 'booked_ref', 'urgency', ev.output -> 'urgency', 'handoff', ev.output -> 'handoff',
              'ask_team', ev.output -> 'ask_team') end,
    'mode', conv.mode, 'urgency', conv.urgency,
    'draft', (select data - 'last_offered' from clinic.booking_drafts where tenant_id = p_tenant and wa_id = p_wa),
    'appointments', (select jsonb_agg(concat_ws(' ', a.ref_no, a.status, clinic.appt_when(a), clinic.doctor_label(a.doctor_id, 'ar')) order by a.id)
                       from clinic.appointments a where a.tenant_id = p_tenant and a.wa_id = p_wa and a.ref_no is not null));
end $$;

revoke execute on function clinic.staff_context(uuid, text, jsonb), clinic.is_test_number(text),
  clinic.test_chat_prepare(text, text, boolean, numeric), clinic.test_chat_result(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on all functions in schema clinic to service_role;
