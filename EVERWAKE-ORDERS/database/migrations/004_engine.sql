-- =====================================================================
-- Everwake Orders · 004 · what the n8n engine calls
--
-- The Seagull pipeline, unchanged in shape:
--   Normalize → intake() → debounce → claim_window() → [pin → save_pin()]
--   → turn_context() → Brain → Agent (tools: cart_context()/persist_cart()/
--   place_order(), save details) → persist_turn() → send → log_outbound()
--
-- Every function takes the restaurant (tenant) first. All JSON in, JSON
-- out, so each n8n Postgres node is one line: select everwake.x($1::jsonb).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Opening hours
-- hours = {"sun":[{"open":"12:00","close":"02:00"}], …, "default":[…]}
-- A day may also be a single {"open","close"} object, or [] (closed).
-- ---------------------------------------------------------------------
create or replace function everwake.day_windows(p_hours jsonb, p_day int)
returns jsonb language sql immutable as $$
  select case
    when p_hours is null then '[]'::jsonb
    when jsonb_typeof(coalesce(p_hours -> (array['sun','mon','tue','wed','thu','fri','sat'])[p_day + 1], p_hours -> 'default')) = 'object'
      then jsonb_build_array(coalesce(p_hours -> (array['sun','mon','tue','wed','thu','fri','sat'])[p_day + 1], p_hours -> 'default'))
    else coalesce(p_hours -> (array['sun','mon','tue','wed','thu','fri','sat'])[p_day + 1], p_hours -> 'default', '[]'::jsonb)
  end
$$;

-- null = no hours on file
create or replace function everwake.is_open_at(p_hours jsonb, p_local timestamp)
returns boolean language plpgsql immutable as $$
declare
  d int := extract(dow from p_local)::int;
  m int := extract(hour from p_local)::int * 60 + extract(minute from p_local)::int;
  w jsonb; o int; c int;
begin
  if p_hours is null or p_hours = '{}'::jsonb then return null; end if;
  for w in select * from jsonb_array_elements(everwake.day_windows(p_hours, d)) loop
    o := split_part(w ->> 'open', ':', 1)::int * 60 + split_part(w ->> 'open', ':', 2)::int;
    c := split_part(w ->> 'close', ':', 1)::int * 60 + split_part(w ->> 'close', ':', 2)::int;
    if c <= o then c := c + 1440; end if;
    if m >= o and m < c then return true; end if;
  end loop;
  -- a window that started yesterday and runs past midnight
  for w in select * from jsonb_array_elements(everwake.day_windows(p_hours, (d + 6) % 7)) loop
    o := split_part(w ->> 'open', ':', 1)::int * 60 + split_part(w ->> 'open', ':', 2)::int;
    c := split_part(w ->> 'close', ':', 1)::int * 60 + split_part(w ->> 'close', ':', 2)::int;
    if c <= o then c := c + 1440; end if;
    if m + 1440 >= o and m + 1440 < c then return true; end if;
  end loop;
  return false;
exception when others then
  return null;
end $$;

-- open | closed | busy | not_accepting | unknown
create or replace function everwake.branch_state(p_branch uuid)
returns text language sql stable as $$
  select case
    when not b.accepting_orders then 'not_accepting'
    when b.busy_until is not null and b.busy_until > now() then 'busy'
    else case everwake.is_open_at(b.hours, (now() at time zone t.timezone)::timestamp)
           when true then 'open' when false then 'closed' else 'unknown' end
  end
  from everwake.branches b join everwake.tenants t on t.id = b.tenant_id
  where b.id = p_branch
$$;

-- ---------------------------------------------------------------------
-- Delivery zones
-- ---------------------------------------------------------------------
create or replace function everwake.zones_at(p_tenant uuid, p_lat double precision, p_lng double precision)
returns table (zone_id uuid, zone_name text, branch_id uuid, branch_code text, branch_name text,
               delivery_fee numeric, min_order numeric, eta_min int, eta_max int, priority int,
               km numeric, branch_state text)
language sql stable as $$
  select z.id, z.name_ar, b.id, b.code, b.name_ar,
         coalesce(z.delivery_fee, b.delivery_fee), coalesce(z.min_order, b.min_order), z.eta_min, z.eta_max, z.priority,
         everwake.haversine_km(b.lat, b.lng, p_lat, p_lng),
         everwake.branch_state(b.id)
    from everwake.delivery_zones z
    join everwake.branches b on b.id = z.branch_id and b.is_active and b.delivery_enabled
   where z.tenant_id = p_tenant and z.is_active
     and case when z.kind = 'polygon' then everwake.point_in_polygon(p_lat, p_lng, z.polygon)
              else everwake.haversine_km(z.center_lat, z.center_lng, p_lat, p_lng) <= z.radius_km end
   order by case everwake.branch_state(b.id) when 'open' then 0 when 'unknown' then 1 when 'closed' then 2 else 3 end,
            z.priority, everwake.haversine_km(b.lat, b.lng, p_lat, p_lng) nulls last
$$;

-- a typed area ("المعادي", "Zamalek") → the zones that list it
create or replace function everwake.match_area(p_tenant uuid, p_text text)
returns jsonb language sql stable as $$
  with q as (select everwake.norm(p_text) as t),
  hits as (
    select distinct on (z.id) z.id, z.name_ar, z.priority, b.id as branch_id, b.code, b.name_ar as branch_name,
           coalesce(z.delivery_fee, b.delivery_fee) as fee, coalesce(z.min_order, b.min_order) as min_order,
           z.eta_min, z.eta_max, a as matched
      from everwake.delivery_zones z
      join everwake.branches b on b.id = z.branch_id and b.is_active and b.delivery_enabled
      cross join q
      cross join lateral unnest(z.areas || array[z.name_ar, coalesce(z.name_en, '')]) a
     where z.tenant_id = p_tenant and z.is_active
       and length(everwake.norm(a)) >= 3 and length(q.t) >= 3
       and (q.t = everwake.norm(a)
            or q.t like '%' || everwake.norm(a) || '%'
            or everwake.norm(a) like '%' || q.t || '%')
     order by z.id, length(a) desc)
  select jsonb_build_object(
           'text', p_text,
           'matches', coalesce(jsonb_agg(jsonb_build_object(
                         'zone_id', h.id, 'zone_name', h.name_ar, 'branch_id', h.branch_id, 'branch_code', h.code,
                         'branch_name', h.branch_name, 'delivery_fee', h.fee, 'min_order', h.min_order,
                         'eta_min', h.eta_min, 'eta_max', h.eta_max, 'matched', h.matched,
                         'branch_state', everwake.branch_state(h.branch_id))
                       order by h.priority), '[]'::jsonb),
           'branches', count(distinct h.branch_id))
    from hits h
$$;

-- ---------------------------------------------------------------------
-- The review fingerprint: what the customer saw in the order summary.
-- Any change to the cart, the details, the branch, the zone or a promo
-- code makes the summary outdated, and place_order refuses it.
-- ---------------------------------------------------------------------
create or replace function everwake.review_hash(p_tenant uuid, p_wa text)
returns text language sql stable as $$
  select md5(coalesce((select jsonb_build_object(
                         'items', o.cart -> 'items', 'subtotal', o.subtotal, 'discount', o.discount_total,
                         'vat', o.vat, 'fee', o.delivery_fee, 'total', o.total)::text
                         from everwake.orders o
                        where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'), 'no-cart')
             || coalesce((select jsonb_build_object(
                            'customer', c.state -> 'customer', 'branch', c.state -> 'branch' -> 'id',
                            'zone', c.state -> 'zone' -> 'id', 'codes', c.state -> 'ledger' -> 'promo_codes')::text
                            from everwake.conversations c
                           where c.tenant_id = p_tenant and c.wa_id = p_wa), 'no-state'))
$$;

-- ---------------------------------------------------------------------
-- Intake: one inbound WhatsApp message.
-- Finds the restaurant from the WhatsApp instance, the customer from any
-- of their identities, logs the message once, and decides the route:
--   agent      → buffered for the debounce window; the agent answers
--   human      → a person took over; the message waits in the dashboard
--   paused     → the agent is OFF; apologise once, remember them
--   not_live   → restaurant still onboarding and this is not a test number
--   duplicate / ignore
-- ---------------------------------------------------------------------
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
  v_link    jsonb;
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

  -- "tell me on WhatsApp when it's ready", from a QR order's waiting page (016): the message carries
  -- the order's code; this chat is linked to it and answered here, no agent needed
  if v_text ~* 'Q-[0-9a-f]{10}' then
    v_link := everwake.qr_link_whatsapp(t.id, cust.id, cust.wa_id, conv.id, v_text);
    if v_link is not null then return base || v_link; end if;
  end if;

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

-- ---------------------------------------------------------------------
-- A message the restaurant typed on the phone itself (fromMe). Called a
-- few seconds after it arrives, so the engine's own sends are already
-- logged and are not mistaken for a person.
-- ---------------------------------------------------------------------
create or replace function everwake.log_phone_reply(p jsonb)
returns jsonb language plpgsql as $$
declare
  ch     everwake.whatsapp_channels%rowtype;
  t      everwake.tenants%rowtype;
  s      jsonb;
  v_wa   text;
  v_cid  bigint;
  v_conv bigint;
  v_text text := coalesce(p ->> 'text', '');
  v_msg  bigint;
begin
  select * into ch from everwake.whatsapp_channels
   where provider = coalesce(nullif(p ->> 'provider', ''), 'evolution') and instance_name = p ->> 'instance' and is_active;
  if not found or coalesce(p ->> 'token', '') <> ch.webhook_token then
    return jsonb_build_object('logged', false, 'reason', 'unknown_channel');
  end if;
  select * into t from everwake.tenants where id = ch.tenant_id;
  s := everwake.merged_settings(t.settings);

  if nullif(p ->> 'external_id', '') is not null
     and exists (select 1 from everwake.messages where tenant_id = t.id and external_id = p ->> 'external_id') then
    return jsonb_build_object('logged', false, 'reason', 'already_logged');
  end if;

  select ci.customer_id into v_cid
    from everwake.customer_identities ci
   where ci.tenant_id = t.id
     and ((ci.kind = 'phone' and ci.value = nullif(everwake.digits(p ->> 'phone'), ''))
       or (ci.kind = 'lid' and ci.value = nullif(everwake.digits(p ->> 'lid'), '')))
   limit 1;
  if v_cid is null then
    select id into v_cid from everwake.customers where tenant_id = t.id and wa_id = p ->> 'wa_id';
  end if;
  if v_cid is null then
    return jsonb_build_object('logged', false, 'reason', 'unknown_customer');
  end if;
  select wa_id into v_wa from everwake.customers where id = v_cid;

  -- the engine's own reply that came back before its id was stored
  if exists (select 1 from everwake.messages
              where tenant_id = t.id and wa_id = v_wa and direction = 'outbound'
                and created_at > now() - interval '3 minutes'
                and btrim(coalesce(body, '')) = btrim(v_text) and v_text <> '') then
    return jsonb_build_object('logged', false, 'reason', 'engine_echo');
  end if;

  select id into v_conv from everwake.conversations where tenant_id = t.id and wa_id = v_wa;
  insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, kind, body, external_id, status, sent_at, meta)
  values (t.id, v_conv, v_wa, 'outbound', 'staff', coalesce(nullif(p ->> 'message_type', ''), 'text'), v_text,
          nullif(p ->> 'external_id', ''), 'sent', now(), jsonb_build_object('via', 'phone'))
  on conflict (tenant_id, external_id) where external_id is not null do nothing
  returning id into v_msg;
  if v_msg is null then
    return jsonb_build_object('logged', false, 'reason', 'already_logged');
  end if;

  update everwake.conversations
     set last_message_at = now(), last_outbound_at = now(), last_message_preview = left(v_text, 160),
         mode = case when coalesce((s ->> 'phone_reply_takes_over')::boolean, true) then 'human' else mode end,
         human_since = case when coalesce((s ->> 'phone_reply_takes_over')::boolean, true)
                            then coalesce(human_since, now()) else human_since end,
         human_last_activity_at = case when coalesce((s ->> 'phone_reply_takes_over')::boolean, true)
                                       then now() else human_last_activity_at end,
         human_reason = case when coalesce((s ->> 'phone_reply_takes_over')::boolean, true) and mode = 'agent'
                             then 'replied from the phone' else human_reason end
   where id = v_conv;
  return jsonb_build_object('logged', true, 'message_id', v_msg, 'wa_id', v_wa);
end $$;

-- ---------------------------------------------------------------------
-- Debounce window (Seagull): only the run holding the newest buffered
-- message answers. It takes a 120 s lock and drains every buffered
-- message into one turn. A takeover or the OFF switch during the wait
-- ends the run quietly — the messages are already in the inbox.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- A GPS pin: stored with its resolved address, matched to the delivery
-- zones, and — when nothing is chosen yet and the cart is empty — the
-- branch that delivers there is chosen. A chosen branch with items in
-- the cart is never switched silently: the agent decides and re-prices.
-- ---------------------------------------------------------------------
create or replace function everwake.save_pin(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant  uuid := (p ->> 'tenant_id')::uuid;
  v_wa      text := p ->> 'wa_id';
  v_lat     double precision := (p ->> 'lat')::double precision;
  v_lng     double precision := (p ->> 'lng')::double precision;
  v_geo     jsonb := coalesce(p -> 'geo', '{}'::jsonb);
  t         everwake.tenants%rowtype;
  s         jsonb;
  st        jsonb;
  v_zones   jsonb;
  v_best    jsonb;
  v_hasz    boolean;
  v_nearest jsonb;
  v_lines   int;
  v_auto    boolean := false;
  v_zone    jsonb;
  v_in      boolean;
  v_loc     jsonb;
  v_cust    jsonb;
begin
  select * into t from everwake.tenants where id = v_tenant;
  s := everwake.merged_settings(t.settings);
  select state into st from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa for update;
  st := coalesce(st, '{}'::jsonb);

  v_hasz := exists (select 1 from everwake.delivery_zones where tenant_id = v_tenant and is_active);
  select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) into v_zones from everwake.zones_at(v_tenant, v_lat, v_lng) z;

  select coalesce(jsonb_agg(x order by (x ->> 'km')::numeric), '[]'::jsonb) into v_nearest
    from (select jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name_ar,
                                    'km', everwake.haversine_km(b.lat, b.lng, v_lat, v_lng),
                                    'state', everwake.branch_state(b.id),
                                    'delivery_enabled', b.delivery_enabled,
                                    'max_km', coalesce(b.max_delivery_km, (s ->> 'max_delivery_km')::numeric)) as x
            from everwake.branches b
           where b.tenant_id = v_tenant and b.is_active and b.lat is not null and b.lng is not null
           order by everwake.haversine_km(b.lat, b.lng, v_lat, v_lng)
           limit 3) n;

  if v_hasz then
    v_best := v_zones -> 0;
    if v_best is not null then
      v_zone := jsonb_build_object('id', v_best ->> 'zone_id', 'name', v_best ->> 'zone_name',
                  'branch_id', v_best ->> 'branch_id', 'branch_code', v_best ->> 'branch_code',
                  'branch_name', v_best ->> 'branch_name', 'delivery_fee', v_best -> 'delivery_fee',
                  'min_order', v_best -> 'min_order', 'eta_min', v_best -> 'eta_min', 'eta_max', v_best -> 'eta_max',
                  'branch_state', v_best ->> 'branch_state', 'source', 'pin', 'at', now());
    end if;
  else
    -- no zones drawn yet: the nearest delivering branch within its range
    select jsonb_build_object('id', null, 'name', null, 'branch_id', x ->> 'id', 'branch_code', x ->> 'code',
                              'branch_name', x ->> 'name', 'delivery_fee', b.delivery_fee, 'min_order', b.min_order,
                              'branch_state', x ->> 'state', 'km', x -> 'km', 'source', 'radius', 'at', now())
      into v_zone
      from jsonb_array_elements(v_nearest) x
      join everwake.branches b on b.id = (x ->> 'id')::uuid
     where (x ->> 'delivery_enabled')::boolean and (x ->> 'km')::numeric <= (x ->> 'max_km')::numeric
     order by case x ->> 'state' when 'open' then 0 when 'unknown' then 1 when 'closed' then 2 else 3 end,
              (x ->> 'km')::numeric
     limit 1;
  end if;
  v_in := v_zone is not null;

  select coalesce(jsonb_array_length(o.cart -> 'items'), 0) into v_lines
    from everwake.orders o where o.tenant_id = v_tenant and o.wa_id = v_wa and o.status = 'draft';
  v_auto := v_in and (st -> 'branch' ->> 'id') is null and coalesce(v_lines, 0) = 0;

  v_loc := jsonb_build_object(
    'lat', v_lat, 'lng', v_lng, 'maps_url', p ->> 'maps_url', 'geo', v_geo, 'at', now(),
    'in_delivery_area', v_in, 'zones_drawn', v_hasz,
    'zone_candidates', (select coalesce(jsonb_agg(z), '[]'::jsonb) from (select z from jsonb_array_elements(v_zones) z limit 4) q),
    'nearest', v_nearest);

  -- the pin is where they are: it becomes the delivery address unless the
  -- customer typed one (a typed address always wins)
  v_cust := coalesce(st -> 'customer', '{}'::jsonb);
  if coalesce(v_cust ->> 'address_source', 'pin') = 'pin' then
    v_cust := (v_cust - 'address_street' - 'address_area' - 'address_city' - 'address_governorate' - 'address_confirmed')
              || jsonb_strip_nulls(jsonb_build_object(
                   'address_street',      nullif(v_geo ->> 'street', ''),
                   'address_area',        nullif(v_geo ->> 'district', ''),
                   'address_city',        nullif(v_geo ->> 'city', ''),
                   'address_governorate', nullif(v_geo ->> 'governorate', ''),
                   'address_source', case when coalesce(nullif(v_geo ->> 'street', ''), nullif(v_geo ->> 'district', ''),
                                                        nullif(v_geo ->> 'city', '')) is not null then 'pin' end));
  end if;

  st := st || jsonb_build_object('location', v_loc, 'customer', v_cust)
           || case when v_zone is not null then jsonb_build_object('zone', v_zone) else jsonb_build_object('zone', null) end
           || case when v_auto then jsonb_build_object('branch', jsonb_build_object(
                     'id', v_zone ->> 'branch_id', 'code', v_zone ->> 'branch_code', 'name_ar', v_zone ->> 'branch_name',
                     'source', 'zone', 'set_at', now())) else '{}'::jsonb end;

  update everwake.conversations set state = st where tenant_id = v_tenant and wa_id = v_wa;
  return jsonb_build_object('location', v_loc, 'zone', v_zone, 'branch', st -> 'branch',
                            'auto_branch_set', v_auto, 'in_delivery_area', v_in);
end $$;

-- ---------------------------------------------------------------------
-- Everything the Brain and the Agent need for one turn.
-- ---------------------------------------------------------------------
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
    -- what customers usually order with the dishes in this cart (016)
    'pairs', everwake.item_pairs(p_tenant, coalesce((select array_agg(i ->> 'code') from everwake.orders o,
                                                       jsonb_array_elements(coalesce(o.cart -> 'items', '[]'::jsonb)) i
                                                      where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'), '{}')),
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

-- after the Agent's tools ran: the state the reply is checked against
create or replace function everwake.read_back(p_tenant uuid, p_wa text)
returns jsonb language sql stable as $$
  with st as (select coalesce((select state from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa),
                              '{}'::jsonb) as state)
  select jsonb_build_object(
    'state', (select state from st),
    'active_order', coalesce((select to_jsonb(o) from everwake.orders o
                               where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'
                               order by o.updated_at desc limit 1), 'null'::jsonb),
    'branch_lookup', coalesce((select lookup from everwake.menu_snapshot
                                where tenant_id = p_tenant and scope = (select state -> 'branch' ->> 'id' from st)), '{}'::jsonb),
    'last_placed', coalesce((select jsonb_build_object('order_no', o.order_no, 'placed_at', o.placed_at, 'total', o.total)
                               from everwake.orders o
                              where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status <> 'draft'
                              order by o.placed_at desc nulls last limit 1), 'null'::jsonb))
$$;

-- ---------------------------------------------------------------------
-- The turn's own record: memory, handoff, telemetry, unlock, cleanup.
-- ---------------------------------------------------------------------
create or replace function everwake.persist_turn(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant  uuid := (p ->> 'tenant_id')::uuid;
  v_wa      text := p ->> 'wa_id';
  v_run     text := p ->> 'run_id';
  v_handoff boolean := coalesce((p -> 'handoff' ->> 'needed')::boolean, false);
  v_final   boolean := coalesce((p ->> 'final')::boolean, false);
  v_take    boolean;
  v_since   timestamptz;
  n_state int; n_unlock int; n_clean int;
begin
  -- the customer wrote again while this reply was being thought out: it is dropped, and this turn's
  -- messages go back to wait so the next turn answers them all together — the way a person who sees
  -- a new message arrive stops typing and reads it. Not when this turn did something final (placed an
  -- order, sent a booking, made a payment link): that reply always goes out.
  select l.locked_at into v_since from everwake.conversation_locks l
   where l.tenant_id = v_tenant and l.wa_id = v_wa and l.run_id = v_run;
  if not v_final and v_since is not null and exists (
       select 1 from everwake.inbound_buffer b
        where b.tenant_id = v_tenant and b.wa_id = v_wa and b.claimed_by_run_id is null and b.received_at > v_since) then
    update everwake.inbound_buffer set claimed_by_run_id = null
     where tenant_id = v_tenant and wa_id = v_wa and claimed_by_run_id = v_run;
    get diagnostics n_clean = row_count;
    delete from everwake.conversation_locks where tenant_id = v_tenant and wa_id = v_wa and run_id = v_run;
    get diagnostics n_unlock = row_count;
    insert into everwake.agent_events (tenant_id, wa_id, run_id, stage, input, output)
    values (v_tenant, v_wa, v_run, 'superseded', coalesce(p -> 'log_row' -> 'input', '{}'::jsonb),
            jsonb_build_object('dropped_reply', p -> 'log_row' -> 'output' -> 'messages'));
    return jsonb_build_object('superseded', true, 'state_written', 0, 'locks_released', n_unlock, 'buffer_rows_returned', n_clean);
  end if;

  select coalesce((everwake.merged_settings(settings) ->> 'auto_takeover_on_handoff')::boolean, false)
    into v_take from everwake.tenants where id = v_tenant;

  update everwake.conversations c
     set state = coalesce(c.state, '{}'::jsonb)
                 || coalesce(p -> 'state_patch', '{}'::jsonb)
                 || jsonb_build_object('ledger',
                      coalesce(c.state -> 'ledger', '{}'::jsonb)
                      || coalesce(p -> 'ledger_patch', '{}'::jsonb)
                      || case when coalesce((p ->> 'save_review')::boolean, false)
                              then jsonb_build_object('review_hash', everwake.review_hash(v_tenant, v_wa), 'review_at', now())
                              else '{}'::jsonb end),
         needs_attention  = c.needs_attention or v_handoff,
         attention_reason = case when v_handoff then nullif(p -> 'handoff' ->> 'reason', '') else c.attention_reason end,
         attention_at     = case when v_handoff then now() else c.attention_at end,
         mode             = case when v_handoff and v_take then 'human' else c.mode end,
         human_since      = case when v_handoff and v_take and c.mode = 'agent' then now() else c.human_since end,
         human_reason     = case when v_handoff and v_take and c.mode = 'agent' then 'agent asked for a person: ' || coalesce(p -> 'handoff' ->> 'reason', '') else c.human_reason end
   where c.tenant_id = v_tenant and c.wa_id = v_wa;
  get diagnostics n_state = row_count;

  -- the agent asked the team (014): the question waits in the inbox; the answers this reply passed on are done
  insert into everwake.team_questions (tenant_id, conversation_id, wa_id, question, run_id)
  select distinct v_tenant, c.id, v_wa, left(btrim(x), 500), v_run
    from everwake.conversations c,
         jsonb_array_elements_text(case jsonb_typeof(p -> 'ask_team') when 'array' then p -> 'ask_team'
                                        when 'string' then jsonb_build_array(p -> 'ask_team') else '[]'::jsonb end) x
   where c.tenant_id = v_tenant and c.wa_id = v_wa and btrim(x) <> ''
     and not exists (select 1 from everwake.team_questions q
                      where q.conversation_id = c.id and q.status = 'open' and q.question = left(btrim(x), 500));
  update everwake.team_questions q set told_at = now()
   where q.tenant_id = v_tenant and q.wa_id = v_wa and q.status = 'answered' and q.told_at is null
     and q.id in (select (x #>> '{}')::bigint from jsonb_array_elements(coalesce(p -> 'answers_told', '[]'::jsonb)) x);
  update everwake.conversations c
     set questions_open = (select count(*) from everwake.team_questions q where q.conversation_id = c.id and q.status = 'open')
   where c.tenant_id = v_tenant and c.wa_id = v_wa;

  if nullif(p ->> 'language', '') is not null then
    update everwake.customers set language = p ->> 'language'
     where tenant_id = v_tenant and wa_id = v_wa and language is distinct from p ->> 'language';
  end if;

  insert into everwake.agent_events
    (tenant_id, wa_id, run_id, stage, order_stage, cart_action, qa_passed, repair_used, llm_calls,
     duration_total_ms, duration_llm_ms, prompt_tokens, completion_tokens, cached_tokens, input, output)
  select v_tenant, v_wa, v_run, 'turn_complete', l ->> 'order_stage', l ->> 'cart_action',
         (l ->> 'qa_passed')::boolean, (l ->> 'repair_used')::boolean, (l ->> 'llm_calls')::int,
         (l ->> 'duration_total_ms')::int, (l ->> 'duration_llm_ms')::int, (l ->> 'prompt_tokens')::int,
         (l ->> 'completion_tokens')::int, coalesce((l ->> 'cached_tokens')::int, 0),
         coalesce(l -> 'input', '{}'::jsonb), coalesce(l -> 'output', '{}'::jsonb)
    from (select coalesce(p -> 'log_row', '{}'::jsonb) as l) x;

  delete from everwake.conversation_locks where tenant_id = v_tenant and wa_id = v_wa and run_id = v_run;
  get diagnostics n_unlock = row_count;
  delete from everwake.inbound_buffer where tenant_id = v_tenant and wa_id = v_wa and claimed_by_run_id = v_run;
  get diagnostics n_clean = row_count;

  -- a person may have taken over (or the agent been switched off) while
  -- the model was thinking: the reply is then not sent
  return jsonb_build_object('state_written', n_state, 'locks_released', n_unlock, 'buffer_rows_cleared', n_clean,
                            'mode', (select mode from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa),
                            'agent_enabled', (select agent_enabled from everwake.tenants where id = v_tenant));
end $$;

-- a turn that ends without replying (superseded, blocked, failed) must not hold the lock
create or replace function everwake.release_lock(p_tenant uuid, p_wa text, p_run text)
returns void language sql as $$
  delete from everwake.conversation_locks where tenant_id = p_tenant and wa_id = p_wa and run_id = p_run;
$$;

-- every message the engine sends to a customer
create or replace function everwake.log_outbound(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  v_conv   bigint;
  v_id     bigint;
  v_ok     boolean := coalesce((p ->> 'ok')::boolean, true);
begin
  select id into v_conv from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa;
  insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, kind, body, media_url, media_mime,
                                 external_id, status, error, run_id, meta, sent_at)
  values (v_tenant, v_conv, v_wa, 'outbound', coalesce(nullif(p ->> 'sender', ''), 'agent'),
          coalesce(nullif(p ->> 'kind', ''), 'text'), p ->> 'body', nullif(p ->> 'media_url', ''),
          nullif(p ->> 'media_mime', ''), nullif(p ->> 'external_id', ''),
          case when v_ok then 'sent' else 'failed' end, nullif(p ->> 'error', ''), p ->> 'run_id',
          coalesce(p -> 'meta', '{}'::jsonb), case when v_ok then now() end)
  on conflict (tenant_id, external_id) where external_id is not null do nothing
  returning id into v_id;
  if v_ok then
    update everwake.conversations
       set last_outbound_at = now(), last_message_at = now(),
           last_message_preview = left(coalesce(p ->> 'body', '[' || coalesce(p ->> 'kind', 'media') || ']'), 160)
     where id = v_conv;
  end if;
  return jsonb_build_object('message_id', v_id);
end $$;

-- ---------------------------------------------------------------------
-- manage_cart: load, persist, place
-- ---------------------------------------------------------------------
create or replace function everwake.cart_context(p_tenant uuid, p_wa text, p_branch text)
returns jsonb language plpgsql as $$
declare
  st     jsonb;
  v_req  record;
  v_q    text := everwake.norm(p_branch);
  v_cust bigint;
  v_ids  bigint[];
  v_phones text[];
begin
  perform everwake.ensure_snapshot(p_tenant);
  select null::uuid as id, null::text as code, null::int as rank into v_req;
  select c.state, c.customer_id into st, v_cust from everwake.conversations c where c.tenant_id = p_tenant and c.wa_id = p_wa;
  st := coalesce(st, '{}'::jsonb);
  v_ids := array_remove(array[v_cust, nullif(st -> 'contact' ->> 'linked_customer_id', '')::bigint], null);
  select array_agg(ci.value) into v_phones from everwake.customer_identities ci where ci.customer_id = any(v_ids) and ci.kind = 'phone';

  -- "same as last time": the branch of their latest order
  if p_branch = '__last_order__' then
    select o.branch_id as id, b.code, 1 as rank into v_req
      from everwake.orders o join everwake.branches b on b.id = o.branch_id and b.is_active
     where o.tenant_id = p_tenant and o.status <> 'draft'
       and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))
     order by o.placed_at desc nulls last limit 1;
  -- exact code / name / alias first; an area the branch usually serves last
  elsif nullif(btrim(coalesce(p_branch, '')), '') is not null then
    select b.id, b.code,
           case when b.code = lower(btrim(p_branch)) or b.id::text = btrim(p_branch) then 1
                when everwake.norm(b.name_ar) = v_q or everwake.norm(b.name_en) = v_q then 2
                when exists (select 1 from unnest(b.aliases) a where everwake.norm(a) = v_q) then 3
                when everwake.norm(b.name_ar) like '%' || v_q || '%' or everwake.norm(b.name_en) like '%' || v_q || '%' then 4
                else 5 end as rank
      into v_req
      from everwake.branches b
     where b.tenant_id = p_tenant and b.is_active
       and (   b.code = lower(btrim(p_branch)) or b.id::text = btrim(p_branch)
            or everwake.norm(b.name_ar) = v_q or everwake.norm(b.name_en) = v_q
            or exists (select 1 from unnest(b.aliases) a where everwake.norm(a) = v_q)
            or (length(v_q) >= 2 and (everwake.norm(b.name_ar) like '%' || v_q || '%' or everwake.norm(b.name_en) like '%' || v_q || '%'))
            or (length(v_q) >= 3 and everwake.norm(b.serves_hint_ar) like '%' || v_q || '%'))
     order by rank, b.accepting_orders desc, b.sort
     limit 1;
  end if;

  return jsonb_build_object(
    'state', st,
    'active_order', coalesce((select to_jsonb(o) from everwake.orders o
                               where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'
                               order by o.updated_at desc limit 1), 'null'::jsonb),
    'requested_branch_id', v_req.id,
    'requested_match_rank', v_req.rank,
    'menu_lookup', coalesce((select lookup from everwake.menu_snapshot
                              where tenant_id = p_tenant and scope = st -> 'branch' ->> 'id'), '{}'::jsonb),
    'requested_lookup', coalesce((select lookup from everwake.menu_snapshot
                                   where tenant_id = p_tenant and scope = v_req.id::text), '{}'::jsonb),
    'all_lookup', coalesce((select lookup from everwake.menu_snapshot where tenant_id = p_tenant and scope = 'all'), '{}'::jsonb),
    'branch_states', coalesce((select jsonb_object_agg(b.id, everwake.branch_state(b.id))
                                 from everwake.branches b where b.tenant_id = p_tenant and b.is_active), '{}'::jsonb),
    'orders_count', (select count(*) from everwake.orders o
                      where o.tenant_id = p_tenant and o.status not in ('draft', 'cancelled', 'rejected')
                        and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))),
    'last_order', (select jsonb_build_object('order_no', o.order_no, 'branch_id', o.branch_id, 'placed_at', o.placed_at,
                                             'items', o.cart -> 'items')
                     from everwake.orders o
                    where o.tenant_id = p_tenant and o.status <> 'draft'
                      and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))
                    order by o.placed_at desc nulls last limit 1),
    'current_review_hash', everwake.review_hash(p_tenant, p_wa));
end $$;

-- writes the draft order and merges the tool's keys into the state (one
-- level deep into ledger, so save_customer_details in the same turn
-- never erases it)
create or replace function everwake.persist_cart(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  v_conv   everwake.conversations%rowtype;
  v_order  bigint;
  tot      jsonb := coalesce(p -> 'totals', '{}'::jsonb);
begin
  select * into v_conv from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa;
  insert into everwake.orders as o
    (tenant_id, wa_id, customer_id, conversation_id, status, branch_id, zone_id, cart, currency, subtotal,
     discount_total, applied_offers, vat, delivery_fee, total)
  values (v_tenant, v_wa, v_conv.customer_id, v_conv.id, 'draft', nullif(p ->> 'branch_id', '')::uuid,
          nullif(p ->> 'zone_id', '')::uuid, coalesce(p -> 'cart', '{"items":[]}'::jsonb),
          coalesce(nullif(tot ->> 'currency', ''), 'EGP'),
          coalesce((tot ->> 'subtotal')::numeric, 0), coalesce((tot ->> 'discount_total')::numeric, 0),
          coalesce(tot -> 'applied_offers', '[]'::jsonb), (tot ->> 'vat')::numeric, (tot ->> 'delivery_fee')::numeric,
          coalesce((tot ->> 'total')::numeric, 0))
  on conflict (tenant_id, wa_id) where status = 'draft' do update
    set branch_id = excluded.branch_id, zone_id = excluded.zone_id, cart = excluded.cart, currency = excluded.currency,
        subtotal = excluded.subtotal, discount_total = excluded.discount_total, applied_offers = excluded.applied_offers,
        vat = excluded.vat, delivery_fee = excluded.delivery_fee, total = excluded.total,
        customer_id = coalesce(o.customer_id, excluded.customer_id), conversation_id = coalesce(o.conversation_id, excluded.conversation_id)
  returning id into v_order;

  update everwake.conversations c
     set state = coalesce(c.state, '{}'::jsonb)
                 || (coalesce(p -> 'state_patch', '{}'::jsonb) - 'ledger')
                 || jsonb_build_object('ledger', coalesce(c.state -> 'ledger', '{}'::jsonb) || coalesce(p -> 'ledger_patch', '{}'::jsonb))
   where c.tenant_id = v_tenant and c.wa_id = v_wa;

  return jsonb_build_object('order_id', v_order);
end $$;

-- the draft becomes a placed order with a number; the customer's record,
-- their address book and the order lines are written in the same step
create or replace function everwake.place_order(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  t        everwake.tenants%rowtype;
  o        everwake.orders%rowtype;
  v_seq    bigint;
  v_no     text;
  cs       jsonb := coalesce(p -> 'customer', '{}'::jsonb);
  addr     jsonb := p -> 'address';
  v_fp     text;
  v_phone  text;
  v_addr   bigint;
  tot      jsonb := coalesce(p -> 'totals', '{}'::jsonb);
begin
  select * into o from everwake.orders
   where tenant_id = v_tenant and wa_id = v_wa and status = 'draft' for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'NO_DRAFT');
  end if;

  update everwake.tenants set order_seq = order_seq + 1 where id = v_tenant returning * into t;
  v_seq := t.order_seq;
  v_no := t.order_no_prefix || '-' || v_seq;

  update everwake.orders
     set status = 'placed', placed_at = now(), order_no = v_no,
         branch_id = coalesce(nullif(p ->> 'branch_id', '')::uuid, branch_id),
         zone_id = coalesce(nullif(p ->> 'zone_id', '')::uuid, zone_id),
         customer = cs,
         delivery_method = nullif(cs ->> 'delivery_method', ''),
         payment_method = nullif(cs ->> 'payment_method', ''),
         address_text = nullif(p ->> 'address_text', ''),
         address = addr,
         location = p -> 'location',
         notes = nullif(p ->> 'notes', ''),
         eta_text = nullif(p ->> 'eta_text', ''),
         subtotal = coalesce((tot ->> 'subtotal')::numeric, subtotal),
         discount_total = coalesce((tot ->> 'discount_total')::numeric, discount_total),
         applied_offers = coalesce(tot -> 'applied_offers', applied_offers),
         vat = case when tot ? 'vat' then (tot ->> 'vat')::numeric else vat end,
         delivery_fee = case when tot ? 'delivery_fee' then (tot ->> 'delivery_fee')::numeric else delivery_fee end,
         total = coalesce((tot ->> 'total')::numeric, total),
         currency = t.currency
   where id = o.id
  returning * into o;

  insert into everwake.order_items (tenant_id, order_id, line_no, item_id, item_code, name, unit, quantity,
                                    unit_price, line_total, choices, notes, is_gift)
  select v_tenant, o.id, x.n::int, nullif(x.i ->> 'item_id', '')::uuid, x.i ->> 'code',
         coalesce(x.i ->> 'display_name', x.i ->> 'item_name', '?'), x.i ->> 'unit',
         coalesce((x.i ->> 'quantity')::numeric, 1), (x.i ->> 'unit_price')::numeric, (x.i ->> 'line_total')::numeric,
         coalesce(x.i -> 'choices', '[]'::jsonb), nullif(x.i ->> 'notes', ''), coalesce((x.i ->> 'gift')::boolean, false)
    from jsonb_array_elements(coalesce(o.cart -> 'items', '[]'::jsonb)) with ordinality as x(i, n);

  insert into everwake.order_events (tenant_id, order_id, status, by_role, note)
  values (v_tenant, o.id, 'placed', 'agent', null);

  -- the customer's record
  v_phone := nullif(everwake.digits(cs ->> 'phone'), '');
  update everwake.customers c
     set orders_count = c.orders_count + 1, total_spent = c.total_spent + coalesce(o.total, 0),
         last_order_id = o.id, last_order_at = now(),
         full_name = coalesce(nullif(cs ->> 'full_name', ''), c.full_name),
         alt_phone = coalesce(nullif(cs ->> 'alt_phone', ''), c.alt_phone),
         food_prefs = coalesce(nullif(cs ->> 'food_prefs', ''), c.food_prefs)
   where c.id = o.customer_id;
  if v_phone is not null and o.customer_id is not null then
    insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
    values (v_tenant, 'phone', v_phone, o.customer_id) on conflict do nothing;
  end if;

  -- the address book (delivery only)
  if o.delivery_method = 'delivery' and addr is not null and o.customer_id is not null then
    v_fp := md5(everwake.norm(concat_ws('|', addr ->> 'area', addr ->> 'street', addr ->> 'building',
                                         addr ->> 'floor', addr ->> 'apartment')));
    insert into everwake.customer_addresses as a
      (tenant_id, customer_id, fingerprint, governorate, city, area, street, building, floor, apartment, landmark,
       notes, lat, lng, maps_url, zone_id, branch_id, address_text)
    values (v_tenant, o.customer_id, v_fp, addr ->> 'governorate', addr ->> 'city', addr ->> 'area', addr ->> 'street',
            addr ->> 'building', addr ->> 'floor', addr ->> 'apartment', addr ->> 'landmark', addr ->> 'notes',
            (p -> 'location' ->> 'lat')::double precision, (p -> 'location' ->> 'lng')::double precision,
            p -> 'location' ->> 'maps_url', o.zone_id, o.branch_id, o.address_text)
    on conflict (customer_id, fingerprint) do update
      set use_count = a.use_count + 1, last_used_at = now(),
          lat = coalesce(excluded.lat, a.lat), lng = coalesce(excluded.lng, a.lng),
          maps_url = coalesce(excluded.maps_url, a.maps_url), zone_id = coalesce(excluded.zone_id, a.zone_id),
          landmark = coalesce(excluded.landmark, a.landmark), address_text = excluded.address_text
    returning id into v_addr;
  end if;

  -- nothing can be placed twice from one summary
  update everwake.conversations s
     set state = coalesce(s.state, '{}'::jsonb)
                 || jsonb_build_object('ledger',
                      coalesce(s.state -> 'ledger', '{}'::jsonb)
                      || jsonb_build_object('review_hash', null, 'pending_items', '[]'::jsonb, 'cart_log', '[]'::jsonb,
                                            'promo_codes', '[]'::jsonb,
                                            'last_order', jsonb_build_object('order_no', v_no, 'at', now(),
                                                                             'total', o.total, 'branch_id', o.branch_id)))
   where s.tenant_id = v_tenant and s.wa_id = v_wa;

  return jsonb_build_object('ok', true, 'order_no', v_no, 'order_id', o.id, 'total', o.total, 'address_id', v_addr);
end $$;

-- the new-order ticket for the branch's WhatsApp
create or replace function everwake.order_ticket(p_tenant uuid, p_order_no text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'order_no', o.order_no, 'placed_at', o.placed_at, 'branch_id', o.branch_id,
    'branch_name', b.name_ar, 'vat_percent', b.vat_percent, 'customer', o.customer,
    'delivery_method', o.delivery_method, 'payment_method', o.payment_method, 'address_text', o.address_text,
    'location', o.location, 'notes', o.notes, 'cart', o.cart, 'subtotal', o.subtotal, 'discount_total', o.discount_total,
    'applied_offers', o.applied_offers, 'vat', o.vat, 'delivery_fee', o.delivery_fee, 'total', o.total,
    'currency', o.currency, 'currency_symbol', t.currency_symbol_ar, 'wa_id', o.wa_id, 'zone_name', z.name_ar,
    'send_ticket', coalesce((everwake.merged_settings(t.settings) ->> 'send_order_ticket')::boolean, true),
    'ops_whatsapp', coalesce(nullif(b.ops_whatsapp, ''), nullif(everwake.merged_settings(t.settings) ->> 'ops_whatsapp', '')))
  from everwake.orders o
  join everwake.tenants t on t.id = o.tenant_id
  left join everwake.branches b on b.id = o.branch_id
  left join everwake.delivery_zones z on z.id = o.zone_id
  where o.tenant_id = p_tenant and o.order_no = p_order_no
$$;

-- ---------------------------------------------------------------------
-- save_customer_details helpers
-- ---------------------------------------------------------------------
create or replace function everwake.details_context(p_tenant uuid, p_wa text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'state', coalesce((select state from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa), '{}'::jsonb),
    'settings', everwake.merged_settings((select settings from everwake.tenants where id = p_tenant)),
    'saved_addresses', coalesce((
       select jsonb_agg(to_jsonb(a) order by a.last_used_at desc)
         from everwake.customer_addresses a
         join everwake.conversations c on c.customer_id = a.customer_id
        where c.tenant_id = p_tenant and c.wa_id = p_wa), '[]'::jsonb),
    'zones_drawn', exists (select 1 from everwake.delivery_zones where tenant_id = p_tenant and is_active),
    -- each branch takes its own payment methods (012)
    'payment_methods_by_branch', coalesce((
       select jsonb_object_agg(b ->> 'id', b -> 'payment_methods')
         from everwake.menu_snapshot s, jsonb_array_elements(s.lookup -> 'branches') b
        where s.tenant_id = p_tenant and s.scope = 'all'), '{}'::jsonb))
$$;

create or replace function everwake.persist_details(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  v_phone  text := nullif(everwake.digits(p ->> 'link_phone'), '');
  v_cust   bigint;
  v_other  bigint;
  v_area   jsonb;
  v_patch  jsonb := coalesce(p -> 'state_patch', '{}'::jsonb);
  v_zone   jsonb;
  st       jsonb;
begin
  select customer_id, state into v_cust, st from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa for update;

  -- a typed area: which delivery zone is that? (a pin, when shared, wins)
  if nullif(p ->> 'area_text', '') is not null
     and (coalesce((p ->> 'address_reset')::boolean, false) or coalesce(st -> 'zone' ->> 'source', '') <> 'pin') then
    v_area := everwake.match_area(v_tenant, p ->> 'area_text');
    if jsonb_array_length(v_area -> 'matches') > 0 and (v_area ->> 'branches')::int = 1 then
      v_zone := (v_area -> 'matches' -> 0);
      v_patch := v_patch || jsonb_build_object('zone', jsonb_build_object(
        'id', v_zone ->> 'zone_id', 'name', v_zone ->> 'zone_name', 'branch_id', v_zone ->> 'branch_id',
        'branch_code', v_zone ->> 'branch_code', 'branch_name', v_zone ->> 'branch_name',
        'delivery_fee', v_zone -> 'delivery_fee', 'min_order', v_zone -> 'min_order',
        'eta_min', v_zone -> 'eta_min', 'eta_max', v_zone -> 'eta_max', 'branch_state', v_zone ->> 'branch_state',
        'source', 'area_name', 'matched', v_zone ->> 'matched', 'at', now()));
    elsif coalesce((p ->> 'address_reset')::boolean, false) then
      v_patch := v_patch || jsonb_build_object('zone', null);
    end if;
  end if;

  -- a saved address chosen again: its zone comes with it
  if nullif(p ->> 'zone_id', '') is not null then
    select jsonb_build_object('id', z.id, 'name', z.name_ar, 'branch_id', b.id, 'branch_code', b.code, 'branch_name', b.name_ar,
                              'delivery_fee', coalesce(z.delivery_fee, b.delivery_fee), 'min_order', coalesce(z.min_order, b.min_order),
                              'eta_min', z.eta_min, 'eta_max', z.eta_max, 'branch_state', everwake.branch_state(b.id),
                              'source', 'saved_address', 'at', now())
      into v_zone
      from everwake.delivery_zones z join everwake.branches b on b.id = z.branch_id
     where z.id = (p ->> 'zone_id')::uuid and z.tenant_id = v_tenant and z.is_active and b.is_active;
    if v_zone is not null then
      v_patch := v_patch || jsonb_build_object('zone', v_zone);
    end if;
  end if;

  -- the zone of a delivery decides its branch: with none chosen yet, that is the branch now, so
  -- the next turn already shows its own menu and prices (a pickup chooses its branch itself)
  if v_zone is not null and nullif(st -> 'branch' ->> 'id', '') is null
     and coalesce(v_patch -> 'customer' ->> 'delivery_method', st -> 'customer' ->> 'delivery_method', '') <> 'pickup' then
    v_patch := v_patch || jsonb_build_object('branch', jsonb_build_object(
      'id', v_zone ->> 'branch_id', 'code', v_zone ->> 'branch_code', 'name_ar', v_zone ->> 'branch_name',
      'source', 'delivery_zone', 'set_at', now()));
  end if;

  -- a number typed for the order: remember it as theirs (so a customer
  -- hidden behind a WhatsApp private id is found by it next time)
  if v_phone is not null and v_cust is not null then
    select customer_id into v_other from everwake.customer_identities
     where tenant_id = v_tenant and kind = 'phone' and value = v_phone;
    if v_other is null then
      insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
      values (v_tenant, 'phone', v_phone, v_cust) on conflict do nothing;
    elsif v_other <> v_cust then
      v_patch := v_patch || jsonb_build_object('contact', coalesce(st -> 'contact', '{}'::jsonb)
                                                || jsonb_build_object('linked_customer_id', v_other));
    end if;
  end if;

  update everwake.conversations c
     set state = coalesce(c.state, '{}'::jsonb)
                 || (v_patch - 'ledger')
                 || jsonb_build_object('ledger', coalesce(c.state -> 'ledger', '{}'::jsonb) || coalesce(p -> 'ledger_patch', '{}'::jsonb))
   where c.tenant_id = v_tenant and c.wa_id = v_wa
  returning c.state into st;

  return jsonb_build_object('state', st, 'area_match', v_area);
end $$;

-- the pictures that go with a reply: the branch's menu pages (or the
-- restaurant's, when the branch has none) and the photos of dishes asked for
create or replace function everwake.reply_media(p jsonb)
returns jsonb language sql stable as $$
  with pages as (
    select m.kind, m.url, m.mime, m.file_name, m.caption, m.position
      from everwake.menu_media m
     where m.tenant_id = (p ->> 'tenant_id')::uuid and m.is_active
       and coalesce((p ->> 'send_menu')::boolean, false)
       and (m.branch_id::text = p ->> 'branch_id'
            or (m.branch_id is null and not exists (
                  select 1 from everwake.menu_media x
                   where x.tenant_id = m.tenant_id and x.is_active and x.branch_id::text = p ->> 'branch_id')))
     order by m.position
     limit 10
  ), photos as (
    select distinct on (i.code) i.code, i.name_ar, im.url, im.mime, coalesce(mib.price, i.price) as price, i.unit, x.ord
      from jsonb_array_elements_text(coalesce(p -> 'item_codes', '[]'::jsonb)) with ordinality x(code, ord)
      join everwake.menu_items i on i.tenant_id = (p ->> 'tenant_id')::uuid and i.code = upper(x.code) and i.is_active
      join everwake.item_media im on im.item_id = i.id
      left join everwake.menu_item_branches mib on mib.item_id = i.id and mib.branch_id::text = p ->> 'branch_id'
     order by i.code, im.is_primary desc, im.sort
  )
  select jsonb_build_object(
    'menu_pages', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'url', url, 'mime', mime,
                                                                'file_name', file_name, 'caption', caption) order by position) from pages), '[]'::jsonb),
    'item_photos', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name_ar, 'url', url, 'mime', mime,
                                                                 'price', price, 'unit', unit) order by ord) from (select * from photos limit 3) ph), '[]'::jsonb))
$$;
