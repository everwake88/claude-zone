-- =====================================================================
-- Patch 2026-10-27 · photos and voice notes the agent understands
-- For a database set up before migration 015. Run once in the Supabase
-- SQL editor, after 2026-10-27_reply_context.sql. New installs have it.
-- =====================================================================

alter table everwake.inbound_buffer add column if not exists media_pending boolean not null default false;

create or replace function everwake.media_understood(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_text   text := nullif(btrim(p ->> 'text'), '');
  v_marker text := coalesce(p ->> 'marker', '');
  n int;
begin
  update everwake.inbound_buffer b
     set message_text = case when v_text is null then b.message_text
                             when v_marker <> '' and position(v_marker in coalesce(b.message_text, '')) > 0
                             then replace(b.message_text, v_marker, v_text)
                             else concat_ws(' ', nullif(b.message_text, ''), v_text) end,
         media_pending = false
   where b.id = (p ->> 'buffer_id')::bigint;
  get diagnostics n = row_count;
  if v_text is not null and nullif(p ->> 'message_id', '') is not null then
    update everwake.messages
       set meta = meta || jsonb_build_object('understood', v_text, 'understood_by', p ->> 'model')
     where id = (p ->> 'message_id')::bigint;
  end if;
  return jsonb_build_object('buffer_rows', n);
end $$;

revoke execute on function everwake.media_understood(jsonb) from public, anon, authenticated;

-- intake marks a photo or voice note; claim_window waits for it; the chat history reads it (004)
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
  v_q       everwake.messages%rowtype;
  v_quote   text;
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

  -- the team answered a question the agent asked (014): no customer message, the agent passes the answer on
  if p ->> 'kind' = 'team_answer' then
    select * into conv from everwake.conversations where tenant_id = t.id and wa_id = v_wa;
    if not found or not exists (select 1 from everwake.team_questions q
                                 where q.tenant_id = t.id and q.wa_id = v_wa and q.status = 'answered' and q.told_at is null) then
      return base || jsonb_build_object('route', 'ignore', 'reason', 'no_new_answer');
    end if;
    select * into cust from everwake.customers where id = conv.customer_id;
    base := base || jsonb_build_object(
      'customer_id', cust.id, 'conversation_id', conv.id, 'wa_id', cust.wa_id, 'reply_to', cust.reply_to,
      'phone_hidden', cust.phone_hidden, 'team_answer', true);
    if cust.is_blocked or conv.mode = 'human' or not t.agent_enabled then
      return base || jsonb_build_object('route', 'ignore', 'reason', 'agent_not_answering');
    end if;
    insert into everwake.inbound_buffer (tenant_id, wa_id, message_text) values (t.id, cust.wa_id, '')
    returning id into v_buf;
    return base || jsonb_build_object('route', 'agent', 'buffer_id', v_buf);
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

  -- a swipe-reply: what they replied to, in words the agent reads like any other marker
  if jsonb_typeof(p -> 'quoted') = 'object' then
    select * into v_q from everwake.messages m
     where m.tenant_id = t.id and m.external_id = nullif(p -> 'quoted' ->> 'id', '') limit 1;
    v_quote := case
      when v_q.id is null then
        case when coalesce(p -> 'quoted' ->> 'text', '') <> '' then 'replying to: "' || left(p -> 'quoted' ->> 'text', 300) || '"'
             when coalesce(p -> 'quoted' ->> 'kind', '') <> '' then 'replying to a ' || (p -> 'quoted' ->> 'kind') end
      when v_q.direction = 'inbound' then 'replying to their own earlier message: "' || left(coalesce(v_q.body, '[' || v_q.kind || ']'), 300) || '"'
      when v_q.body like '[photo: %]' then 'replying to the photo of ' || substring(v_q.body from '^\[photo: (.*)\]$')
      when v_q.body like '[menu %]' then 'replying to the ' || btrim(v_q.body, '[]')
      when v_q.kind <> 'text' then 'replying to ' || case v_q.sender when 'agent' then 'your ' else 'a ' end || v_q.kind
      else 'replying to ' || case v_q.sender when 'agent' then 'your message' when 'staff' then 'the team''s message'
                                           when 'driver' then 'the driver''s message' else 'the automatic message' end
           || ': "' || left(coalesce(v_q.body, ''), 300) || '"' end;
  end if;

  -- the message, exactly once (Evolution can deliver twice) ---------------
  insert into everwake.messages (tenant_id, wa_id, direction, sender, kind, body, external_id, raw_payload, meta)
  values (t.id, cust.wa_id, 'inbound', 'customer', coalesce(nullif(p ->> 'message_type', ''), 'text'), v_text,
          nullif(p ->> 'external_id', ''), p -> 'raw',
          jsonb_strip_nulls(jsonb_build_object('location', p -> 'location', 'push_name', p ->> 'push_name',
                                               'channel_id', ch.id, 'reply_to', v_quote)))
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

  insert into everwake.inbound_buffer (tenant_id, wa_id, message_text, has_location, location, media_pending)
  values (t.id, cust.wa_id, case when v_quote is not null then '[' || v_quote || '] ' || v_text else v_text end,
          coalesce((p ->> 'has_location')::boolean, false), p -> 'location',
          -- a photo or a voice note (015): the agent waits until it is understood
          coalesce(jsonb_typeof(p -> 'media') = 'object', false) and not coalesce((p ->> 'test_run')::boolean, false))
  returning id into v_buf;

  return base || jsonb_build_object('route', 'agent', 'buffer_id', v_buf);
end $$;

create or replace function everwake.claim_window(p_tenant uuid, p_wa text, p_run text, p_buffer bigint)
returns jsonb language plpgsql as $$
declare
  v_mode    text;
  v_enabled boolean;
  v_newest  bigint;
  v_lock    text;
  r         record;
begin
  select c.mode into v_mode from everwake.conversations c where c.tenant_id = p_tenant and c.wa_id = p_wa;
  select t.agent_enabled into v_enabled from everwake.tenants t where t.id = p_tenant;
  if v_mode = 'human' or not v_enabled then
    delete from everwake.inbound_buffer where tenant_id = p_tenant and wa_id = p_wa and claimed_by_run_id is null;
    return jsonb_build_object('is_newest', false, 'lock_acquired', false,
                              'blocked_reason', case when v_mode = 'human' then 'human' else 'paused' end);
  end if;

  select b.id into v_newest
    from everwake.inbound_buffer b
   where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
   order by b.received_at desc, b.id desc
   limit 1;
  if v_newest is distinct from p_buffer then
    return jsonb_build_object('is_newest', false, 'lock_acquired', false);
  end if;
  -- a photo or voice note in this window is still being understood (015): wait for it (a minute at most)
  if exists (select 1 from everwake.inbound_buffer b
              where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
                and b.media_pending and b.received_at > now() - interval '60 seconds') then
    return jsonb_build_object('is_newest', true, 'lock_acquired', false, 'waiting_for_media', true);
  end if;

  insert into everwake.conversation_locks as l (tenant_id, wa_id, run_id, locked_at, expires_at)
  values (p_tenant, p_wa, p_run, now(), now() + interval '300 seconds')
  on conflict (tenant_id, wa_id) do update
    set run_id = excluded.run_id, locked_at = now(), expires_at = excluded.expires_at
    where l.expires_at < now()
  returning run_id into v_lock;
  if v_lock is null then
    return jsonb_build_object('is_newest', true, 'lock_acquired', false);
  end if;

  with drained as (
    update everwake.inbound_buffer b
       set claimed_by_run_id = p_run
     where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
    returning b.message_text, b.has_location, b.location, b.received_at
  )
  select coalesce(string_agg(nullif(d.message_text, ''), E'\n' order by d.received_at), '') as combined_text,
         coalesce(bool_or(d.has_location), false) as has_location,
         (array_remove(array_agg(d.location order by d.received_at desc), null))[1] as location,
         count(*) as buffered_count
    into r
    from drained d;

  return jsonb_build_object('is_newest', true, 'lock_acquired', true,
                            'combined_text', r.combined_text, 'has_location', r.has_location,
                            'location', r.location, 'buffered_count', r.buffered_count);
end $$;

create or replace function everwake.turn_context(p_tenant uuid, p_wa text)
returns jsonb language plpgsql as $$
declare
  t       everwake.tenants%rowtype;
  conv    everwake.conversations%rowtype;
  cust    everwake.customers%rowtype;
  v_bid   text;
  v_ids   bigint[];
  v_phones text[];
  v_all   everwake.menu_snapshot%rowtype;
  v_br    everwake.menu_snapshot%rowtype;
begin
  perform everwake.ensure_snapshot(p_tenant);
  select * into t from everwake.tenants where id = p_tenant;
  select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
  select * into cust from everwake.customers where id = conv.customer_id;

  -- a restaurant with one branch never has to ask which one
  if (conv.state -> 'branch' ->> 'id') is null
     and (select count(*) from everwake.branches b where b.tenant_id = p_tenant and b.is_active) = 1 then
    update everwake.conversations c
       set state = c.state || jsonb_build_object('branch', (
                     select jsonb_build_object('id', b.id, 'code', b.code, 'name_ar', b.name_ar,
                                               'source', 'only_branch', 'set_at', now())
                       from everwake.branches b where b.tenant_id = p_tenant and b.is_active))
     where c.id = conv.id
    returning * into conv;
  end if;
  v_bid := conv.state -> 'branch' ->> 'id';

  -- previous orders: by this customer, or by the number they gave us
  v_ids := array_remove(array[cust.id, nullif(conv.state -> 'contact' ->> 'linked_customer_id', '')::bigint], null);
  select array_agg(ci.value) into v_phones
    from everwake.customer_identities ci where ci.customer_id = any(v_ids) and ci.kind = 'phone';

  select * into v_all from everwake.menu_snapshot where tenant_id = p_tenant and scope = 'all';
  select * into v_br from everwake.menu_snapshot where tenant_id = p_tenant and scope = v_bid;

  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'status', t.status, 'agent_enabled', t.agent_enabled),
    'state', coalesce(conv.state, '{}'::jsonb),
    'conversation', jsonb_build_object('id', conv.id, 'mode', conv.mode, 'needs_attention', conv.needs_attention,
                                       'created_at', conv.created_at),
    'customer', jsonb_build_object(
       'id', cust.id, 'wa_id', cust.wa_id, 'phone', cust.phone, 'phone_hidden', cust.phone_hidden,
       'display_name', cust.display_name, 'full_name', cust.full_name, 'alt_phone', cust.alt_phone,
       'food_prefs', cust.food_prefs, 'language', cust.language, 'tags', to_jsonb(cust.tags),
       'orders_count', (select count(*) from everwake.orders o
                         where o.tenant_id = p_tenant and o.status not in ('draft', 'cancelled', 'rejected')
                           and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))),
       'first_seen_at', cust.first_seen_at),
    'active_order', coalesce((select to_jsonb(o) from everwake.orders o
                               where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'
                               order by o.updated_at desc limit 1), 'null'::jsonb),
    'last_orders', coalesce((
       select jsonb_agg(x order by (x ->> 'placed_at') desc) from (
         select jsonb_build_object(
                  'order_no', o.order_no, 'status', o.status, 'placed_at', o.placed_at,
                  'branch_id', o.branch_id, 'branch_name', b.name_ar, 'total', o.total,
                  'delivery_method', o.delivery_method, 'payment_method', o.payment_method,
                  -- paying online (011): paid or not, and the live link to send again
                  'payment_status', o.payment_status, 'paid_amount', o.paid_amount,
                  'payment', (select jsonb_build_object('status', p.status, 'amount', p.amount, 'expires_at', p.expires_at,
                                       'link', case when p.status = 'pending' and p.expires_at > now()
                                                    then everwake.payment_short_url(p.tenant_id, p.ref) end,
                                       'declined_attempts', p.attempts, 'last_error', p.last_error)
                                from everwake.payments p where p.order_id = o.id order by p.id desc limit 1),
                  'address_text', o.address_text, 'eta_text', o.eta_text,
                  'last_update_at', greatest(o.accepted_at, o.ready_at, o.out_for_delivery_at, o.completed_at, o.cancelled_at),
                  -- the restaurant's driver on it, and how far they were at their last position
                  'driver', (select jsonb_build_object('name', d.name, 'phone', d.phone) from everwake.drivers d where d.id = o.driver_id),
                  'tracking', case when o.delivery_track_at > now() - interval '10 minutes' then
                                jsonb_build_object('km_left', o.delivery_km_left, 'eta_min', o.delivery_eta_min,
                                                   'minutes_ago', floor(extract(epoch from now() - o.delivery_track_at) / 60)) end,
                  'items', coalesce((select jsonb_agg(jsonb_build_object(
                                       'code', oi.item_code, 'name', oi.name, 'quantity', oi.quantity, 'unit', oi.unit,
                                       'choices', oi.choices, 'notes', oi.notes, 'line_total', oi.line_total,
                                       'gift', oi.is_gift) order by oi.line_no)
                                       from everwake.order_items oi where oi.order_id = o.id), '[]'::jsonb)) as x
           from everwake.orders o
           left join everwake.branches b on b.id = o.branch_id
          where o.tenant_id = p_tenant and o.status <> 'draft'
            and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))
          order by o.placed_at desc nulls last
          limit 3) q), '[]'::jsonb),
    'saved_addresses', coalesce((
       select jsonb_agg(jsonb_build_object('id', a.id, 'text', a.address_text, 'area', a.area, 'street', a.street,
                                           'building', a.building, 'floor', a.floor, 'apartment', a.apartment,
                                           'landmark', a.landmark, 'zone_id', a.zone_id, 'branch_id', a.branch_id,
                                           'has_pin', a.lat is not null, 'last_used_at', a.last_used_at)
                        order by a.last_used_at desc)
         from (select * from everwake.customer_addresses
                where customer_id = any(v_ids) order by last_used_at desc limit 3) a), '[]'::jsonb),
    'recent_messages', coalesce((
       select jsonb_agg(jsonb_build_object('direction', m.direction, 'sender', m.sender, 'kind', m.kind,
                                           'text', coalesce(m.meta ->> 'understood', m.body), 'at', m.created_at, 'staff_name', m.staff_name,
                                           'status', m.status, 'reply_to', m.meta ->> 'reply_to')
                        order by m.created_at)
         from (select mm.*, tm.display_name as staff_name
                 from everwake.messages mm
                 left join everwake.tenant_members tm on tm.tenant_id = mm.tenant_id and tm.user_id = mm.staff_user_id
                where mm.tenant_id = p_tenant and mm.wa_id = p_wa and mm.status <> 'failed'
                order by mm.created_at desc limit 20) m), '[]'::jsonb),
    'pause', (select jsonb_build_object('apologized_at', pc.apologized_at, 'resume_notified_at', pc.resume_notified_at,
                                        'paused_at', ap.started_at, 'resumed_at', ap.ended_at)
                from everwake.pause_contacts pc join everwake.agent_pauses ap on ap.id = pc.pause_id
               where pc.tenant_id = p_tenant and pc.wa_id = p_wa and pc.last_message_at > now() - interval '24 hours'
               order by pc.last_message_at desc limit 1),
    -- table bookings (010): the rules, the one in progress, and what is coming up
    'reservation_setup', everwake.reservation_setup(p_tenant),
    -- what the agent asked the team in the last day, and their answers (014)
    'team_questions', coalesce((
       select jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question, 'asked_at', q.asked_at, 'status', q.status,
                                           'answer_kind', q.answer_kind, 'answer', q.answer, 'answered_at', q.answered_at,
                                           'answered_by', q.answered_by_name, 'told', q.told_at is not null)
                        order by q.asked_at)
         from (select * from everwake.team_questions
                where tenant_id = p_tenant and wa_id = p_wa and status <> 'dismissed' and asked_at > now() - interval '24 hours'
                order by asked_at desc limit 6) q), '[]'::jsonb),
    'reservation', (select everwake.reservation_view(x) from everwake.reservations x
                     where x.tenant_id = p_tenant and x.wa_id = p_wa and x.status = 'draft'),
    'reservations_upcoming', coalesce((select jsonb_agg(everwake.reservation_view(x) order by x.reserved_for)
                                         from everwake.reservations x
                                        where x.tenant_id = p_tenant and x.wa_id = p_wa and x.status in ('requested', 'confirmed')
                                          and x.reserved_for > now() - interval '3 hours'), '[]'::jsonb),
    'all_lookup', coalesce(v_all.lookup, '{}'::jsonb),
    'all_digest', coalesce(v_all.digest_text, ''),
    'branch_lookup', coalesce(v_br.lookup, '{}'::jsonb),
    'menu_digest', coalesce(v_br.digest_text, v_all.digest_text, ''),
    'menu_version', coalesce(v_br.version_hash, v_all.version_hash, 'none'),
    'current_review_hash', everwake.review_hash(p_tenant, p_wa));
end $$;
