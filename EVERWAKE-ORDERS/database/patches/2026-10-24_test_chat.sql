-- Everwake Orders · patch 2026-10-24 · the test chat
-- For the n8n "Everwake — Test Runner" workflow: chat with the agent from a
-- pretend number (200000000001…99); nothing is sent on WhatsApp, and it works
-- while the restaurant is still onboarding.
-- Already in the migrations for new installs. Run once in Supabase → SQL Editor.

create or replace function everwake.is_test_number(p_wa text)
returns boolean language sql immutable as $$
  select coalesce(p_wa ~ '^20000000000[0-9]$|^2000000000[1-9][0-9]$', false)
$$;

create or replace function everwake.test_chat_prepare(p_restaurant text, p_wa text, p_reset boolean default false,
                                                      p_later_hours numeric default 0)
returns jsonb language plpgsql as $$
declare
  t      everwake.tenants%rowtype;
  ch     everwake.whatsapp_channels%rowtype;
  v_cust bigint[];
  v_back interval := make_interval(secs => greatest(coalesce(p_later_hours, 0), 0) * 3600);
  n      int;
begin
  if not everwake.is_test_number(p_wa) then
    raise exception 'The test chat only uses the pretend numbers 200000000001 to 200000000099, not %', p_wa;
  end if;

  select count(*) into n from everwake.tenants
   where slug = lower(btrim(p_restaurant)) or slug ilike btrim(p_restaurant) || '%'
      or name_en ilike btrim(p_restaurant) || '%' or name_ar = btrim(p_restaurant);
  if n <> 1 then
    raise exception '% restaurants match "%" — use the restaurant''s exact slug', n, p_restaurant;
  end if;
  select * into t from everwake.tenants
   where slug = lower(btrim(p_restaurant)) or slug ilike btrim(p_restaurant) || '%'
      or name_en ilike btrim(p_restaurant) || '%' or name_ar = btrim(p_restaurant);

  select * into ch from everwake.whatsapp_channels
   where tenant_id = t.id and provider = 'evolution' and is_active and instance_name is not null
   order by created_at limit 1;
  if ch.id is null then
    raise exception '% has no WhatsApp number connected yet (Settings → WhatsApp)', t.name_ar;
  end if;

  select coalesce(array_agg(id), '{}') into v_cust from everwake.customers where tenant_id = t.id and wa_id = p_wa;

  if p_reset then
    delete from everwake.orders             where tenant_id = t.id and (wa_id = p_wa or customer_id = any (v_cust));
    delete from everwake.reservations       where tenant_id = t.id and (wa_id = p_wa or customer_id = any (v_cust));
    delete from everwake.outbox             where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.messages           where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.conversations      where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.inbound_buffer     where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.conversation_locks where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.pause_contacts     where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.agent_events       where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.customers          where id = any (v_cust);
  elsif v_back > interval '0' then
    update everwake.messages set created_at = created_at - v_back, sent_at = sent_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update everwake.conversations
       set last_message_at = last_message_at - v_back, last_inbound_at = last_inbound_at - v_back,
           last_outbound_at = last_outbound_at - v_back, updated_at = updated_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update everwake.customers set last_seen_at = last_seen_at - v_back, last_order_at = last_order_at - v_back
     where id = any (v_cust);
    update everwake.orders set created_at = created_at - v_back, placed_at = placed_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update everwake.agent_events set created_at = created_at - v_back where tenant_id = t.id and wa_id = p_wa;
  end if;

  return jsonb_build_object(
    'tenant_id', t.id, 'restaurant', t.name_ar, 'slug', t.slug, 'status', t.status,
    'instance', ch.instance_name, 'token', ch.webhook_token, 'wa_id', p_wa,
    'reset', coalesce(p_reset, false), 'later_hours', greatest(coalesce(p_later_hours, 0), 0),
    'since', now());
end $$;

create or replace function everwake.test_chat_result(p_tenant uuid, p_wa text, p_since timestamptz)
returns jsonb language plpgsql stable as $$
declare
  conv everwake.conversations%rowtype;
  ev   everwake.agent_events%rowtype;
begin
  if not everwake.is_test_number(p_wa) then
    raise exception 'not a test chat: %', p_wa;
  end if;
  select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
  select * into ev from everwake.agent_events
   where tenant_id = p_tenant and wa_id = p_wa and created_at >= p_since and stage = 'turn_complete'
   order by id desc limit 1;

  return jsonb_build_object(
    'customer', (select string_agg(body, E'\n' order by id) from everwake.messages
                  where tenant_id = p_tenant and wa_id = p_wa and direction = 'inbound' and created_at >= p_since),
    'replies', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'text', body, 'sender', sender) order by id)
                           from everwake.messages
                          where tenant_id = p_tenant and wa_id = p_wa and direction = 'outbound' and created_at >= p_since), '[]'),
    'turn', case when ev.id is null then null else jsonb_build_object(
              'stage', ev.order_stage, 'seconds', round(ev.duration_total_ms / 1000.0, 1),
              'tokens', coalesce(ev.prompt_tokens, 0) + coalesce(ev.completion_tokens, 0),
              'plan', ev.output -> 'brain', 'tools', ev.output -> 'tools_used', 'tool_problems', ev.output -> 'tool_problems',
              'caught', ev.output -> 'violations', 'rewritten', ev.repair_used,
              'order_placed', ev.output ->> 'order_placed_no', 'handoff', ev.output -> 'handoff') end,
    'mode', conv.mode,
    'details', conv.state -> 'customer',
    'branch', (select name_ar from everwake.branches b where b.id::text = conv.state -> 'branch' ->> 'id'),
    'cart', (select jsonb_agg(concat_ws(' ', i ->> 'quantity', coalesce(i ->> 'display_name', i ->> 'item_name'),
                                        nullif(i ->> 'line_total', '') || 'ج'))
               from everwake.orders o, jsonb_array_elements(coalesce(o.cart -> 'items', '[]')) i
              where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'),
    'orders', (select jsonb_agg(order_no || ' ' || status || ' ' || total || 'ج' order by id)
                 from everwake.orders where tenant_id = p_tenant and wa_id = p_wa and status <> 'draft'));
end $$;

revoke execute on function everwake.is_test_number(text),
  everwake.test_chat_prepare(text, text, boolean, numeric),
  everwake.test_chat_result(uuid, text, timestamptz) from public, anon, authenticated;

-- intake: the Test Runner's pretend number reaches the agent while onboarding
create or replace function everwake.intake(p jsonb)
returns jsonb language plpgsql as $$
declare
  ch        everwake.whatsapp_channels%rowtype;
  t         everwake.tenants%rowtype;
  s         jsonb;
  cust      everwake.customers%rowtype;
  conv      everwake.conversations%rowtype;
  v_phone   text := nullif(everwake.digits(p ->> 'phone'), '');
  v_lid     text := nullif(everwake.digits(p ->> 'lid'), '');
  v_wa      text := nullif(btrim(p ->> 'wa_id'), '');
  v_reply   text := nullif(btrim(p ->> 'reply_to'), '');
  v_text    text := coalesce(p ->> 'text', '');
  v_cid     bigint;
  v_msg     bigint;
  v_buf     bigint;
  v_lang    text;
  v_release int;
  v_pc      everwake.pause_contacts%rowtype;
  v_pause   bigint;
  v_send    boolean := false;
  v_apology text;
  base      jsonb;
begin
  select * into ch from everwake.whatsapp_channels
   where provider = coalesce(nullif(p ->> 'provider', ''), 'evolution')
     and instance_name = p ->> 'instance' and is_active;
  if not found then
    return jsonb_build_object('route', 'ignore', 'reason', 'unknown_channel');
  end if;
  if coalesce(p ->> 'token', '') <> ch.webhook_token then
    return jsonb_build_object('route', 'ignore', 'reason', 'bad_token');
  end if;
  select * into t from everwake.tenants where id = ch.tenant_id;
  if t.status in ('suspended', 'cancelled') then
    return jsonb_build_object('route', 'ignore', 'reason', 'tenant_' || t.status);
  end if;
  update everwake.whatsapp_channels
     set last_inbound_at = now(), status = 'connected', connected_at = coalesce(connected_at, now())
   where id = ch.id;
  s := everwake.merged_settings(t.settings);

  base := jsonb_build_object(
    'tenant_id', t.id, 'tenant_slug', t.slug, 'tenant_status', t.status,
    'channel', jsonb_build_object('id', ch.id, 'provider', ch.provider, 'base_url', rtrim(ch.base_url, '/'),
                                  'instance', ch.instance_name, 'api_key', ch.api_key));

  if coalesce((p ->> 'from_me')::boolean, false) then
    return base || jsonb_build_object('route', 'from_me');
  end if;
  if v_wa is null then
    return base || jsonb_build_object('route', 'ignore', 'reason', 'no_sender');
  end if;

  -- the customer, by any identity -----------------------------------------
  select ci.customer_id into v_cid
    from everwake.customer_identities ci
   where ci.tenant_id = t.id
     and ((ci.kind = 'phone' and ci.value = v_phone) or (ci.kind = 'lid' and ci.value = v_lid))
   order by (ci.kind = 'phone') desc
   limit 1;
  if v_cid is null then
    select id into v_cid from everwake.customers where tenant_id = t.id and wa_id = v_wa;
  end if;
  if v_cid is null then
    insert into everwake.customers (tenant_id, wa_id, reply_to, phone, lid, phone_hidden, display_name)
    values (t.id, v_wa, coalesce(v_reply, v_wa), v_phone, v_lid, v_phone is null,
            nullif(btrim(p ->> 'push_name'), ''))
    on conflict (tenant_id, wa_id) do update set last_seen_at = now()
    returning id into v_cid;
  end if;
  update everwake.customers c
     set phone        = coalesce(c.phone, v_phone),
         lid          = coalesce(c.lid, v_lid),
         phone_hidden = coalesce(c.phone, v_phone) is null,
         -- a real number is the safest place to reply to
         reply_to     = case when v_phone is not null then v_phone else coalesce(v_reply, c.reply_to) end,
         display_name = coalesce(nullif(btrim(p ->> 'push_name'), ''), c.display_name),
         last_seen_at = now()
   where c.id = v_cid
  returning * into cust;
  if v_phone is not null then
    insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
    values (t.id, 'phone', v_phone, v_cid) on conflict do nothing;
  end if;
  if v_lid is not null then
    insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
    values (t.id, 'lid', v_lid, v_cid) on conflict do nothing;
  end if;

  -- the message, exactly once (Evolution can deliver twice) ---------------
  insert into everwake.messages (tenant_id, wa_id, direction, sender, kind, body, external_id, raw_payload, meta)
  values (t.id, cust.wa_id, 'inbound', 'customer', coalesce(nullif(p ->> 'message_type', ''), 'text'), v_text,
          nullif(p ->> 'external_id', ''), p -> 'raw',
          jsonb_strip_nulls(jsonb_build_object('location', p -> 'location', 'push_name', p ->> 'push_name',
                                               'channel_id', ch.id)))
  on conflict (tenant_id, external_id) where external_id is not null do nothing
  returning id into v_msg;
  if v_msg is null then
    return base || jsonb_build_object('route', 'duplicate', 'wa_id', cust.wa_id);
  end if;

  insert into everwake.conversations as c
    (tenant_id, customer_id, wa_id, state, last_message_at, last_inbound_at, unread_count, last_message_preview)
  values (t.id, v_cid, cust.wa_id,
          jsonb_build_object('contact', jsonb_build_object('reply_to', cust.reply_to, 'phone_hidden', cust.phone_hidden,
                                                           'channel_id', ch.id)),
          now(), now(), 1, left(v_text, 160))
  on conflict (tenant_id, wa_id) do update
    set state = c.state || jsonb_build_object('contact', coalesce(c.state -> 'contact', '{}'::jsonb) || (excluded.state -> 'contact')),
        customer_id = coalesce(c.customer_id, excluded.customer_id),
        last_message_at = now(), last_inbound_at = now(),
        unread_count = c.unread_count + 1,
        last_message_preview = excluded.last_message_preview
  returning * into conv;
  update everwake.messages set conversation_id = conv.id where id = v_msg;

  base := base || jsonb_build_object(
    'customer_id', cust.id, 'conversation_id', conv.id, 'message_id', v_msg,
    'wa_id', cust.wa_id, 'reply_to', cust.reply_to, 'phone_hidden', cust.phone_hidden);

  if cust.is_blocked then
    return base || jsonb_build_object('route', 'ignore', 'reason', 'blocked');
  end if;

  -- a person took over: the agent stays quiet unless the person went idle -
  if conv.mode = 'human' then
    v_release := coalesce((s ->> 'human_auto_release_minutes')::int, 0);
    if v_release > 0 and coalesce(conv.human_last_activity_at, conv.human_since, now())
                         < now() - make_interval(mins => v_release) then
      update everwake.conversations
         set mode = 'agent', assigned_user_id = null, human_since = null, human_reason = null,
             state = state || jsonb_build_object('handback', jsonb_build_object(
                       'at', now(), 'by', 'auto', 'human_since', conv.human_since))
       where id = conv.id;
    else
      return base || jsonb_build_object('route', 'human');
    end if;
  end if;

  -- the agent is OFF ---------------------------------------------------------
  if not t.agent_enabled then
    v_pause := t.current_pause_id;
    if v_pause is null then
      insert into everwake.agent_pauses (tenant_id, reason) values (t.id, 'switched off') returning id into v_pause;
      update everwake.tenants set current_pause_id = v_pause where id = t.id;
    end if;
    insert into everwake.pause_contacts as pc (pause_id, tenant_id, wa_id, reply_to, channel_id, customer_id)
    values (v_pause, t.id, cust.wa_id, cust.reply_to, ch.id, cust.id)
    on conflict (pause_id, wa_id) do update
      set last_message_at = now(), messages_count = pc.messages_count + 1, reply_to = excluded.reply_to,
          channel_id = excluded.channel_id
    returning * into v_pc;
    if v_pc.apologized_at is null then
      update everwake.pause_contacts set apologized_at = now()
       where pause_id = v_pc.pause_id and wa_id = v_pc.wa_id;
      update everwake.agent_pauses set contacts_count = contacts_count + 1 where id = v_pause;
      v_lang := case when v_text ~ '[ء-ي]' then 'ar'
                     when v_text ~ '[A-Za-z]' then 'en'
                     else coalesce(cust.language, t.default_language) end;
      v_apology := everwake.render_template(
                     s -> 'templates' ->> ('pause_apology_' || v_lang),
                     jsonb_build_object('name', everwake.first_name(cust.full_name, cust.display_name),
                                        'restaurant', case when v_lang = 'en' then coalesce(nullif(t.name_en, ''), t.name_ar) else t.name_ar end));
      v_send := true;
    end if;
    return base || jsonb_build_object('route', 'paused', 'send_apology', v_send, 'apology_text', v_apology,
                                      'pause_id', v_pause);
  end if;

  -- still onboarding: only the restaurant's test numbers (and the Test
  -- Runner's pretend number, 013) reach the agent ----
  if t.status = 'onboarding'
     and not (coalesce((p ->> 'test_run')::boolean, false) and everwake.is_test_number(cust.wa_id))
     and not (coalesce(s -> 'test_numbers', '[]'::jsonb) ? cust.wa_id
              or (cust.phone is not null and coalesce(s -> 'test_numbers', '[]'::jsonb) ? cust.phone)) then
    return base || jsonb_build_object('route', 'not_live');
  end if;

  insert into everwake.inbound_buffer (tenant_id, wa_id, message_text, has_location, location)
  values (t.id, cust.wa_id, v_text, coalesce((p ->> 'has_location')::boolean, false), p -> 'location')
  returning id into v_buf;

  return base || jsonb_build_object('route', 'agent', 'buffer_id', v_buf);
end $$;
