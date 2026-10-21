-- =====================================================================
-- Everwake Orders · 008 · drivers
--
-- The restaurant's own drivers (طيارين). Added from the dashboard with a
-- name and a WhatsApp number; they sign in from a link sent to that number
-- (no password) and see only the orders given to them. Their phone sends
-- its location while they deliver, so the customer hears "on the way"
-- with the driver's name and number, then "about 5 minutes away", and the
-- agent can say where the order is.
--
-- Drivers never use Supabase auth: the dashboard's server calls the
-- driver_* functions with the service role and the driver's session token.
-- =====================================================================

create table everwake.drivers (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references everwake.tenants(id) on delete cascade,
  name                  text not null,
  phone                 text not null,                -- international digits: 2010…
  branch_ids            uuid[] not null default '{}', -- empty = every branch
  is_active             boolean not null default true,
  login_code_hash       text,                         -- one-time sign-in link, hashed
  login_code_expires_at timestamptz,
  login_code_sent_at    timestamptz,
  last_lat              double precision,
  last_lng              double precision,
  last_accuracy_m       real,
  last_loc_at           timestamptz,
  last_seen_at          timestamptz,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, phone)
);
create index drivers_phone_idx on everwake.drivers (phone) where is_active;

-- a signed-in phone; the token itself is only in the driver's cookie
create table everwake.driver_sessions (
  token_hash   text primary key,
  driver_id    uuid not null references everwake.drivers(id) on delete cascade,
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index driver_sessions_driver_idx on everwake.driver_sessions (driver_id);

alter table everwake.orders
  add column driver_id          uuid references everwake.drivers(id) on delete set null,
  add column driver_assigned_at timestamptz,
  add column delivery_km_left   numeric(6, 2),       -- road estimate from the driver's last position
  add column delivery_eta_min   int,
  add column delivery_track_at  timestamptz,
  add column near_notified_at   timestamptz;         -- "about 5 minutes away" was sent
create index orders_driver_idx on everwake.orders (driver_id, status) where driver_id is not null;

alter table everwake.messages drop constraint messages_sender_check;
alter table everwake.messages add constraint messages_sender_check
  check (sender in ('customer', 'agent', 'staff', 'system', 'driver'));
alter table everwake.outbox drop constraint outbox_purpose_check;
alter table everwake.outbox add constraint outbox_purpose_check
  check (purpose in ('staff_reply', 'order_status', 'pause_notice', 'resume_notice', 'order_ticket', 'broadcast', 'test',
                     'driver', 'driver_chat'));
alter table everwake.order_events drop constraint order_events_by_role_check;
alter table everwake.order_events add constraint order_events_by_role_check
  check (by_role in ('agent', 'staff', 'system', 'driver'));

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- a phone as WhatsApp wants it: Egyptian 01xxxxxxxxx → 201xxxxxxxxx
create or replace function everwake.wa_phone(p text, p_country text default 'EG')
returns text language plpgsql immutable as $$
declare d text := everwake.digits(p);
begin
  if d like '00%' then d := substr(d, 3); end if;
  if coalesce(p_country, 'EG') = 'EG' then
    if d ~ '^01[0125][0-9]{8}$' then d := '2' || d;
    elsif d ~ '^1[0125][0-9]{8}$' then d := '20' || d;
    end if;
  end if;
  return case when length(d) between 8 and 15 then d end;
end $$;

create or replace function everwake.token_hash(p text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

-- 256 random bits, as 64 hex characters
create or replace function everwake.random_token()
returns text language sql volatile as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

-- road distance and minutes from a straight line: streets add about a
-- third, a delivery bike in town averages ~22 km/h (settings can say otherwise)
create or replace function everwake.delivery_estimate(p_tenant uuid, lat1 double precision, lng1 double precision,
                                                      lat2 double precision, lng2 double precision)
returns jsonb language sql stable as $$
  select case when everwake.haversine_km(lat1, lng1, lat2, lng2) is null then null else
    jsonb_build_object(
      'km', round(everwake.haversine_km(lat1, lng1, lat2, lng2) * 1.35, 1),
      'min', greatest(1, ceil(everwake.haversine_km(lat1, lng1, lat2, lng2) * 1.35 * 60
                               / coalesce((select nullif(everwake.merged_settings(t.settings) ->> 'driver_speed_kmh', '')::numeric
                                             from everwake.tenants t where t.id = p_tenant), 22))::int))
  end
$$;

-- a message to a driver's own WhatsApp (not a customer conversation)
create or replace function everwake.queue_driver_message(p_driver uuid, p_body text)
returns bigint language plpgsql as $$
declare d everwake.drivers%rowtype; v_ch uuid; v_out bigint;
begin
  select * into d from everwake.drivers where id = p_driver;
  select ch.id into v_ch from everwake.whatsapp_channels ch
   where ch.tenant_id = d.tenant_id and ch.is_active order by ch.created_at limit 1;
  insert into everwake.outbox (tenant_id, channel_id, to_jid, purpose, body, created_by)
  values (d.tenant_id, v_ch, d.phone, 'driver', p_body, everwake.current_user_id())
  returning id into v_out;
  return v_out;
end $$;

-- the customer's number for the driver: the one they gave, else their WhatsApp number when it is a number
create or replace function everwake.order_customer_phone(o everwake.orders)
returns text language sql stable as $$
  select coalesce(nullif(everwake.digits(o.customer ->> 'phone'), ''),
                  (select case when not c.phone_hidden then nullif(everwake.digits(c.phone), '') end
                     from everwake.customers c where c.id = o.customer_id),
                  case when o.wa_id ~ '^[0-9]{8,15}$' then o.wa_id end)
$$;

-- "the driver Ahmed — 0100… · about 20 minutes" for the customer's messages
create or replace function everwake.driver_line(o everwake.orders, p_lang text)
returns text language plpgsql stable as $$
declare d everwake.drivers%rowtype; e jsonb; v_local text;
begin
  if o.driver_id is null then return null; end if;
  select * into d from everwake.drivers where id = o.driver_id;
  if not found then return null; end if;
  v_local := case when d.phone like '20%' then '0' || substr(d.phone, 3) else '+' || d.phone end;
  if d.last_loc_at > now() - interval '3 minutes' then
    e := everwake.delivery_estimate(o.tenant_id, d.last_lat, d.last_lng,
                                    (o.location ->> 'lat')::double precision, (o.location ->> 'lng')::double precision);
  end if;
  if p_lang = 'en' then
    return 'Your driver: ' || d.name || ' — ' || v_local
           || case when e is not null then ' · about ' || (e ->> 'min') || ' min away' else '' end;
  end if;
  return 'الطيار: ' || d.name || ' — ' || v_local
         || case when e is not null then ' · هيوصلك خلال حوالي ' || (e ->> 'min') || ' دقيقة' else '' end;
end $$;

-- ---------------------------------------------------------------------
-- The dashboard: add, change and assign drivers (any team member)
-- ---------------------------------------------------------------------
create or replace function everwake.save_driver(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_id    uuid := nullif(p ->> 'id', '')::uuid;
  v_phone text;
  v_name  text := nullif(btrim(coalesce(p ->> 'name', '')), '');
  v_br    uuid[];
  d       everwake.drivers%rowtype;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager', 'staff']);
  v_phone := everwake.wa_phone(p ->> 'phone', (select country from everwake.tenants where id = p_tenant));
  if v_id is null and (v_name is null or v_phone is null) then
    raise exception 'A driver needs a name and a WhatsApp number';
  end if;
  if p ? 'phone' and v_phone is null then raise exception 'That WhatsApp number does not look right'; end if;
  if p ? 'branch_ids' then
    select coalesce(array_agg(b.id), '{}') into v_br
      from everwake.branches b
     where b.tenant_id = p_tenant and b.id::text in (select jsonb_array_elements_text(p -> 'branch_ids'));
  end if;
  if v_id is null then
    insert into everwake.drivers (tenant_id, name, phone, branch_ids, created_by)
    values (p_tenant, v_name, v_phone, coalesce(v_br, '{}'), everwake.current_user_id())
    returning * into d;
  else
    update everwake.drivers
       set name = coalesce(v_name, name),
           phone = coalesce(v_phone, phone),
           branch_ids = coalesce(v_br, branch_ids),
           is_active = coalesce((p ->> 'is_active')::boolean, is_active),
           updated_at = now()
     where id = v_id and tenant_id = p_tenant
    returning * into d;
    if not found then raise exception 'Driver not found'; end if;
    -- switched off: signed out everywhere, and off their orders
    if not d.is_active then
      delete from everwake.driver_sessions where driver_id = d.id;
      update everwake.orders set driver_id = null, driver_assigned_at = null
       where driver_id = d.id and status in ('placed', 'accepted', 'preparing', 'ready');
    end if;
  end if;
  return jsonb_build_object('id', d.id, 'phone', d.phone);
exception when unique_violation then
  raise exception 'A driver with this number already exists';
end $$;

-- a sign-in link for the driver, sent to their WhatsApp; returned too, to copy
create or replace function everwake.invite_driver(p_driver uuid, p_base text)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare d everwake.drivers%rowtype; v_code text := everwake.random_token(); v_link text; v_t text;
begin
  select * into d from everwake.drivers where id = p_driver;
  if not found then raise exception 'Driver not found'; end if;
  perform everwake.require_role(d.tenant_id, array['owner', 'manager', 'staff']);
  if not d.is_active then raise exception 'This driver is switched off'; end if;
  update everwake.drivers
     set login_code_hash = everwake.token_hash(v_code), login_code_expires_at = now() + interval '7 days',
         login_code_sent_at = now()
   where id = d.id;
  v_link := rtrim(p_base, '/') || '/d/' || d.id || '.' || v_code;
  select name_ar into v_t from everwake.tenants where id = d.tenant_id;
  perform everwake.queue_driver_message(d.id,
    'أهلاً ' || d.name || ' 👋' || E'\n' || 'ده رابط دخولك كطيار في ' || coalesce(v_t, '') || ':' || E'\n' || v_link
    || E'\n\n' || 'افتحه من موبايلك، وهتلاقي فيه الطلبات اللي معاك والعناوين والخرايط.');
  return jsonb_build_object('link', v_link, 'phone', d.phone);
end $$;

-- give an order to a driver (or take it back with null); the driver hears on WhatsApp
create or replace function everwake.assign_driver(p_order bigint, p_driver uuid, p_base text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare o everwake.orders%rowtype; d everwake.drivers%rowtype;
begin
  select * into o from everwake.orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  if o.status not in ('placed', 'accepted', 'preparing', 'ready', 'out_for_delivery') then
    raise exception 'this order is % and cannot change', o.status;
  end if;
  if p_driver is not null then
    select * into d from everwake.drivers where id = p_driver and tenant_id = o.tenant_id;
    if not found or not d.is_active then raise exception 'Driver not found'; end if;
    if cardinality(d.branch_ids) > 0 and o.branch_id is not null and not (o.branch_id = any(d.branch_ids)) then
      raise exception 'This driver does not deliver for this branch';
    end if;
  end if;
  update everwake.orders
     set driver_id = p_driver, driver_assigned_at = case when p_driver is null then null else now() end,
         near_notified_at = null, delivery_km_left = null, delivery_eta_min = null, delivery_track_at = null
   where id = o.id;
  if p_driver is not null and p_base is not null then
    perform everwake.queue_driver_message(d.id,
      '🛵 طلب جديد معاك: ' || coalesce(o.order_no, '') || E'\n' || coalesce(o.address_text, '')
      || E'\n' || 'افتح طلباتك: ' || rtrim(p_base, '/') || '/driver');
  end if;
  insert into everwake.order_events (tenant_id, order_id, status, note, by_user, by_role)
  values (o.tenant_id, o.id, o.status,
          case when p_driver is null then 'driver removed' else 'driver: ' || d.name end,
          everwake.current_user_id(), case when everwake.current_user_id() is null then 'system' else 'staff' end);
  return jsonb_build_object('order_id', o.id, 'driver_id', p_driver);
end $$;

-- per driver, between two times: deliveries, cash collected, minutes on the road
create or replace function everwake.driver_report(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager', 'staff']);
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.name) from (
    select d.id as driver_id, d.name, d.is_active,
           count(o.id) as delivered,
           coalesce(sum(o.total) filter (where coalesce(o.payment_method, 'cash') ilike '%cash%'
                                            or o.payment_method ilike '%كاش%'), 0) as cash,
           coalesce(sum(o.total), 0) as total,
           round(avg(extract(epoch from (o.completed_at - o.out_for_delivery_at)) / 60)
                 filter (where o.out_for_delivery_at is not null))::int as avg_minutes
      from everwake.drivers d
      left join everwake.orders o on o.driver_id = d.id and o.status = 'delivered'
                                 and o.completed_at >= p_from and o.completed_at < p_to
     where d.tenant_id = p_tenant
     group by d.id, d.name, d.is_active) r), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- The driver's phone (service role only, with the session token)
-- ---------------------------------------------------------------------

-- "send me my link": every restaurant this number drives for sends one
-- (at most one a minute each); the answer never says whether it exists
create or replace function everwake.driver_request_login(p_phone text, p_base text)
returns int language plpgsql as $$
declare d record; v_code text; n int := 0;
begin
  for d in select dr.*, t.name_ar as t_name from everwake.drivers dr join everwake.tenants t on t.id = dr.tenant_id
            where dr.is_active and dr.phone = everwake.wa_phone(p_phone, t.country)
              and (dr.login_code_sent_at is null or dr.login_code_sent_at < now() - interval '1 minute') loop
    v_code := everwake.random_token();
    update everwake.drivers
       set login_code_hash = everwake.token_hash(v_code), login_code_expires_at = now() + interval '1 day',
           login_code_sent_at = now()
     where id = d.id;
    perform everwake.queue_driver_message(d.id,
      'رابط دخولك كطيار في ' || d.t_name || ':' || E'\n' || rtrim(p_base, '/') || '/d/' || d.id || '.' || v_code);
    n := n + 1;
  end loop;
  return n;
end $$;

-- the link opened: a session for this phone (the link works once)
create or replace function everwake.driver_redeem(p_driver uuid, p_code text, p_user_agent text default null)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype; v_token text := everwake.random_token();
begin
  select * into d from everwake.drivers where id = p_driver for update;
  if not found or not d.is_active or d.login_code_hash is null or d.login_code_expires_at < now()
     or d.login_code_hash <> everwake.token_hash(p_code) then
    return jsonb_build_object('ok', false);
  end if;
  update everwake.drivers set login_code_hash = null, login_code_expires_at = null, last_seen_at = now() where id = d.id;
  insert into everwake.driver_sessions (token_hash, driver_id, tenant_id, user_agent)
  values (everwake.token_hash(v_token), d.id, d.tenant_id, left(p_user_agent, 300));
  return jsonb_build_object('ok', true, 'token', v_token);
end $$;

create or replace function everwake.driver_from_token(p_token text)
returns everwake.drivers language plpgsql as $$
declare d everwake.drivers%rowtype; s everwake.driver_sessions%rowtype;
begin
  select * into s from everwake.driver_sessions where token_hash = everwake.token_hash(p_token);
  if found then select * into d from everwake.drivers where id = s.driver_id and is_active; end if;
  if s.token_hash is null or d.id is null then
    raise exception 'signed out' using errcode = '28000';
  end if;
  if s.last_seen_at < now() - interval '1 minute' then
    update everwake.driver_sessions set last_seen_at = now() where token_hash = s.token_hash;
    update everwake.drivers set last_seen_at = now() where id = d.id;
  end if;
  return d;
end $$;

-- everything the driver's screen shows
create or replace function everwake.driver_home(p_token text)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype := everwake.driver_from_token(p_token); t everwake.tenants%rowtype;
begin
  select * into t from everwake.tenants where id = d.tenant_id;
  return jsonb_build_object(
    'driver', jsonb_build_object('id', d.id, 'name', d.name, 'phone', d.phone),
    'restaurant', jsonb_build_object('name_ar', t.name_ar, 'name_en', t.name_en, 'currency', t.currency_symbol_ar,
                                     'logo_url', t.profile -> 'brand' ->> 'logo_url', 'color', t.profile -> 'brand' ->> 'color'),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'order_no', o.order_no, 'status', o.status, 'placed_at', o.placed_at,
        'customer_name', coalesce(nullif(o.customer ->> 'full_name', ''), c.full_name, c.display_name),
        'customer_phone', everwake.order_customer_phone(o),
        'address_text', o.address_text, 'address', o.address, 'location', o.location, 'notes', o.notes,
        'total', o.total, 'delivery_fee', o.delivery_fee, 'payment_method', o.payment_method,
        'km_left', o.delivery_km_left, 'eta_min', o.delivery_eta_min,
        'branch', jsonb_build_object('name', b.name_ar, 'address', b.address_ar, 'phone', b.phone,
                                     'lat', b.lat, 'lng', b.lng, 'maps_url', b.maps_url),
        'items', coalesce((select jsonb_agg(jsonb_build_object('name', oi.name, 'quantity', oi.quantity, 'unit', oi.unit,
                                                               'choices', oi.choices, 'notes', oi.notes) order by oi.line_no)
                             from everwake.order_items oi where oi.order_id = o.id), '[]'::jsonb))
        order by (o.status = 'out_for_delivery') desc, o.driver_assigned_at)
      from everwake.orders o
      left join everwake.customers c on c.id = o.customer_id
      left join everwake.branches b on b.id = o.branch_id
     where o.driver_id = d.id and o.status in ('placed', 'accepted', 'preparing', 'ready', 'out_for_delivery')), '[]'::jsonb),
    'today', (select jsonb_build_object('delivered', count(*),
                                        'cash', coalesce(sum(o.total) filter (where coalesce(o.payment_method, 'cash') ilike '%cash%'
                                                                                 or o.payment_method ilike '%كاش%'), 0))
                from everwake.orders o
               where o.driver_id = d.id and o.status = 'delivered'
                 and o.completed_at >= date_trunc('day', now() at time zone t.timezone) at time zone t.timezone));
end $$;

-- picked up and leaving (the customer hears it, with the driver's name and number), or delivered
create or replace function everwake.driver_action(p_token text, p_order bigint, p_action text)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype := everwake.driver_from_token(p_token); o everwake.orders%rowtype; r jsonb;
begin
  select * into o from everwake.orders where id = p_order and driver_id = d.id;
  if not found then raise exception 'This order is not yours'; end if;
  if p_action = 'pick_up' then
    if o.status not in ('accepted', 'preparing', 'ready') then raise exception 'the order is %', o.status; end if;
    r := everwake.set_order_status(o.id, 'out_for_delivery');
  elsif p_action = 'delivered' then
    if o.status <> 'out_for_delivery' then raise exception 'the order is %', o.status; end if;
    r := everwake.set_order_status(o.id, 'delivered');
  else
    raise exception 'unknown action %', p_action;
  end if;
  update everwake.order_events set by_role = 'driver', note = coalesce(note, 'driver: ' || d.name)
   where id = (select max(id) from everwake.order_events where order_id = o.id);
  return r;
end $$;

-- the phone's position: the order's distance, and "about 5 minutes away" once
create or replace function everwake.driver_ping(p_token text, p_lat double precision, p_lng double precision,
                                                p_accuracy real default null)
returns jsonb language plpgsql as $$
declare
  d  everwake.drivers%rowtype := everwake.driver_from_token(p_token);
  o  everwake.orders%rowtype;
  e  jsonb;
  n  int := 0;
  v_near int;
  v_lang text;
  res jsonb := '[]'::jsonb;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then raise exception 'bad position'; end if;
  update everwake.drivers set last_lat = p_lat, last_lng = p_lng, last_accuracy_m = p_accuracy, last_loc_at = now()
   where id = d.id;
  v_near := coalesce((select nullif(everwake.merged_settings(t.settings) ->> 'driver_near_minutes', '')::int
                        from everwake.tenants t where t.id = d.tenant_id), 5);
  for o in select * from everwake.orders where driver_id = d.id and status = 'out_for_delivery' for update loop
    e := everwake.delivery_estimate(o.tenant_id, p_lat, p_lng,
                                    (o.location ->> 'lat')::double precision, (o.location ->> 'lng')::double precision);
    continue when e is null;
    update everwake.orders
       set delivery_km_left = (e ->> 'km')::numeric, delivery_eta_min = (e ->> 'min')::int, delivery_track_at = now()
     where id = o.id;
    -- close: tell the customer once (not when they were this close at pick-up: that message said it)
    if o.near_notified_at is null and (e ->> 'min')::int <= v_near then
      update everwake.orders set near_notified_at = now() where id = o.id;
      if o.out_for_delivery_at < now() - interval '2 minutes' then
        v_lang := everwake.customer_language(o.tenant_id, o.wa_id);
        perform everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status',
          case when v_lang = 'en' then '🛵 ' || d.name || ' is almost there — about ' || (e ->> 'min') || ' min away.'
               else '🛵 الطيار ' || d.name || ' قرّب يوصلك — حوالي ' || (e ->> 'min') || ' دقايق.' end);
        n := n + 1;
      end if;
    end if;
    res := res || jsonb_build_object('order_id', o.id, 'km', e -> 'km', 'min', e -> 'min');
  end loop;
  return jsonb_build_object('orders', res, 'notified', n);
end $$;

-- the chat with the customer, from the restaurant's WhatsApp number
create or replace function everwake.driver_chat(p_token text, p_order bigint)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype := everwake.driver_from_token(p_token); o everwake.orders%rowtype;
begin
  select * into o from everwake.orders where id = p_order and driver_id = d.id;
  if not found then raise exception 'This order is not yours'; end if;
  return coalesce((select jsonb_agg(x order by x ->> 'at') from (
    select jsonb_build_object('id', m.id, 'from', case when m.direction = 'inbound' then 'customer' else m.sender end,
                              'kind', m.kind, 'text', m.body, 'at', m.created_at, 'status', m.status) as x
      from everwake.messages m
     where m.tenant_id = o.tenant_id and m.wa_id = o.wa_id
       and m.created_at >= least(coalesce(o.driver_assigned_at, o.placed_at), now() - interval '30 minutes')
     order by m.created_at desc limit 60) q), '[]'::jsonb);
end $$;

create or replace function everwake.driver_send(p_token text, p_order bigint, p_text text)
returns jsonb language plpgsql as $$
declare d everwake.drivers%rowtype := everwake.driver_from_token(p_token); o everwake.orders%rowtype;
begin
  select * into o from everwake.orders where id = p_order and driver_id = d.id;
  if not found then raise exception 'This order is not yours'; end if;
  if nullif(btrim(coalesce(p_text, '')), '') is null then raise exception 'empty message'; end if;
  return everwake.queue_customer_message(o.tenant_id, o.wa_id, 'driver_chat',
    '🛵 ' || d.name || ': ' || left(btrim(p_text), 1000), p_sender => 'driver');
end $$;

-- ---------------------------------------------------------------------
-- Who can see and call what
-- ---------------------------------------------------------------------
alter table everwake.drivers enable row level security;
alter table everwake.driver_sessions enable row level security;
create policy member_read on everwake.drivers for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));

grant all on everwake.drivers, everwake.driver_sessions to service_role;
grant select (id, tenant_id, name, phone, branch_ids, is_active, login_code_sent_at, last_lat, last_lng,
              last_accuracy_m, last_loc_at, last_seen_at, created_at, updated_at)
  on everwake.drivers to authenticated;

revoke execute on all functions in schema everwake from public, anon;
-- the driver's phone reaches these only through the dashboard's server
revoke execute on function
  everwake.queue_driver_message(uuid, text), everwake.driver_request_login(text, text),
  everwake.driver_redeem(uuid, text, text), everwake.driver_from_token(text), everwake.driver_home(text),
  everwake.driver_action(text, bigint, text), everwake.driver_ping(text, double precision, double precision, real),
  everwake.driver_chat(text, bigint), everwake.driver_send(text, bigint, text)
  from authenticated;
grant execute on all functions in schema everwake to service_role;
grant execute on function
  everwake.save_driver(uuid, jsonb), everwake.invite_driver(uuid, text), everwake.assign_driver(bigint, uuid, text),
  everwake.driver_report(uuid, timestamptz, timestamptz), everwake.wa_phone(text, text)
  to authenticated;
