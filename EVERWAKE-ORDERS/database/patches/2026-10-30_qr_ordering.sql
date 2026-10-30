-- =====================================================================
-- Patch 2026-10-30 · ordering in the branch from a QR code, the kitchen
-- screen, loyalty and integrations
-- For a database set up before migration 016. Run once in the Supabase
-- SQL editor, after 2026-10-27_photos_and_voice_notes.sql. New installs have it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- QR codes: one per branch counter, or one per table
-- ---------------------------------------------------------------------
create table everwake.qr_codes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references everwake.tenants(id) on delete cascade,
  branch_id   uuid not null references everwake.branches(id) on delete cascade,
  code        text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
  table_label text,                       -- null = the counter (take away); "7" = table 7 (served there)
  is_active   boolean not null default true,
  scans       int not null default 0,
  created_at  timestamptz not null default now(),
  unique (branch_id, table_label)
);
create index qr_codes_tenant_idx on everwake.qr_codes (tenant_id, branch_id);

-- a cart from a QR code, priced by the server, waiting for its money
create table everwake.qr_checkouts (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references everwake.tenants(id) on delete cascade,
  branch_id       uuid not null references everwake.branches(id) on delete cascade,
  qr_code_id      uuid references everwake.qr_codes(id) on delete set null,
  token           text not null unique default everwake.random_token(),   -- the waiting page's address
  ticket          int not null,           -- the number shown at the counter, per branch per day
  table_label     text,
  cart            jsonb not null,
  subtotal        numeric(12, 2) not null,
  discount_total  numeric(12, 2) not null default 0,
  applied_offers  jsonb not null default '[]'::jsonb,
  vat             numeric(12, 2),
  total           numeric(12, 2) not null,
  currency        text not null default 'EGP',
  payment_method  text not null check (payment_method in ('card', 'cash')),
  status          text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'paid', 'cancelled', 'expired')),
  customer        jsonb not null default '{}'::jsonb,   -- {full_name, phone}
  customer_id     bigint references everwake.customers(id) on delete set null,
  wa_id           text,                   -- their WhatsApp, once they asked for the "ready" message there
  notes           text,
  order_id        bigint references everwake.orders(id) on delete set null,
  cancel_reason   text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  paid_at         timestamptz
);
create index qr_checkouts_waiting_idx on everwake.qr_checkouts (tenant_id, branch_id, status) where status = 'awaiting_payment';

alter table everwake.orders
  add column qr_token     text unique,     -- the customer's waiting page
  add column table_label  text,            -- served at this table
  add column ready_by     timestamptz,     -- the time it was promised for
  add column checkout_id  bigint references everwake.qr_checkouts(id) on delete set null;

-- a card payment for a QR checkout has no order yet: the order is made when the money arrives
alter table everwake.payments alter column order_id drop not null;
alter table everwake.payments add column checkout_id bigint references everwake.qr_checkouts(id) on delete cascade;

-- loyalty: an offer for every Nth order (the 10th, the 20th…)
alter table everwake.offers add column every_nth_order int check (every_nth_order is null or every_nth_order >= 2);

-- ---------------------------------------------------------------------
-- Integrations: the restaurant's own system hears about orders and stock
-- (signed webhooks) and can switch dishes off / move orders on (API keys)
-- ---------------------------------------------------------------------
create table everwake.integration_endpoints (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references everwake.tenants(id) on delete cascade,
  label       text,
  url         text not null check (url ~ '^https?://'),
  secret      text not null default everwake.random_token(),   -- signs every delivery (HMAC-SHA256)
  events      text[] not null default array['order.created', 'order.updated', 'item.availability'],
  is_active   boolean not null default true,
  last_ok_at  timestamptz,
  last_error  text,
  created_at  timestamptz not null default now()
);
create table everwake.integration_events (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  endpoint_id  uuid not null references everwake.integration_endpoints(id) on delete cascade,
  event        text not null,
  payload      jsonb not null,
  status       text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts     int not null default 0,
  next_try_at  timestamptz not null default now(),
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index integration_events_due_idx on everwake.integration_events (status, next_try_at) where status in ('queued', 'sending');

create table everwake.api_keys (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  label        text,
  key_hash     text not null unique,
  key_hint     text not null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- ---------------------------------------------------------------------
-- What customers order together (the last 90 days): suggestions
-- ---------------------------------------------------------------------
create or replace function everwake.item_pairs(p_tenant uuid, p_codes text[] default null)
returns jsonb language sql stable as $$
  with lines as (
    select oi.order_id, oi.item_code as code
      from everwake.order_items oi
      join everwake.orders o on o.id = oi.order_id
     where o.tenant_id = p_tenant and o.status not in ('draft', 'rejected', 'cancelled')
       and o.placed_at > now() - interval '90 days' and not oi.is_gift and oi.item_code is not null
     group by 1, 2),
  pairs as (
    select a.code, b.code as with_code, count(*) as n
      from lines a join lines b on a.order_id = b.order_id and a.code <> b.code
     where p_codes is null or a.code = any (p_codes)
     group by 1, 2 having count(*) >= 2),
  ranked as (
    select code, with_code, n, row_number() over (partition by code order by n desc, with_code) as r from pairs)
  select coalesce(jsonb_object_agg(code, codes), '{}'::jsonb)
    from (select code, jsonb_agg(with_code order by r) as codes from ranked where r <= 3 group by code) x
$$;

-- ---------------------------------------------------------------------
-- The menu a QR code opens (public: the code is the key)
-- ---------------------------------------------------------------------
create or replace function everwake.qr_menu(p_code text)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  q  everwake.qr_codes%rowtype;
  t  everwake.tenants%rowtype;
  b  everwake.branches%rowtype;
  s  jsonb;
  lk jsonb;
  qs jsonb;
  acct boolean;
begin
  select * into q from everwake.qr_codes where code = p_code and is_active;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  select * into t from everwake.tenants where id = q.tenant_id;
  select * into b from everwake.branches where id = q.branch_id;
  if t.status in ('suspended', 'cancelled') or not b.is_active then return jsonb_build_object('ok', false, 'error', 'CLOSED'); end if;
  update everwake.qr_codes set scans = scans + 1 where id = q.id;
  perform everwake.ensure_snapshot(t.id);
  select lookup into lk from everwake.menu_snapshot where tenant_id = t.id and scope = b.id::text;
  s := everwake.merged_settings(t.settings);
  qs := coalesce(s -> 'qr_ordering', '{}'::jsonb);
  select coalesce(a.enabled and a.public_key is not null and a.secret_key_id is not null, false) into acct
    from everwake.payment_accounts a where a.tenant_id = t.id;

  return jsonb_build_object(
    'ok', true,
    'restaurant', jsonb_build_object('name_ar', t.name_ar, 'name_en', t.name_en, 'currency', t.currency,
                                     'currency_symbol', t.currency_symbol_ar, 'language', t.default_language,
                                     'logo_url', t.profile -> 'brand' ->> 'logo_url', 'color', t.profile -> 'brand' ->> 'color'),
    'branch', jsonb_build_object('id', b.id, 'code', b.code, 'name_ar', b.name_ar, 'name_en', b.name_en,
                                 'state', everwake.branch_state(b.id), 'busy_reason', b.busy_reason,
                                 'hours_text_ar', b.hours_text_ar, 'prep_minutes', coalesce(b.prep_minutes, 15),
                                 'vat_percent', b.vat_percent, 'price_note_ar', b.price_note_ar),
    'table', q.table_label,
    'pay', jsonb_build_object('card', coalesce(acct, false) and coalesce((qs ->> 'card')::boolean, true),
                              'cash', coalesce((qs ->> 'cash')::boolean, true)),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name_ar', c.name_ar, 'name_en', c.name_en, 'items', c.items)
                       order by c.sort, c.name_ar)
        from (select cat.id, cat.name_ar, cat.name_en, cat.sort,
                     jsonb_agg(jsonb_build_object(
                       'code', e.key, 'name', e.value ->> 'name', 'name_en', e.value ->> 'name_en', 'desc', e.value ->> 'desc',
                       'price', (e.value ->> 'price')::numeric, 'unit', e.value ->> 'unit',
                       'qty_step', (e.value ->> 'qty_step')::numeric, 'min_qty', (e.value ->> 'min_qty')::numeric,
                       'signature', coalesce((e.value ->> 'signature')::boolean, false) or coalesce((e.value ->> 'featured')::boolean, false),
                       'available', coalesce((e.value ->> 'available')::boolean, true) and (e.value ->> 'sold_out_until') is null,
                       'photo', (select m.url from everwake.item_media m where m.item_id = (e.value ->> 'id')::uuid
                                  order by m.is_primary desc, m.sort limit 1),
                       'levels', coalesce(lk -> 'choices' -> e.key -> 'levels', '[]'::jsonb))
                       order by mi.sort, e.value ->> 'name') as items
                from jsonb_each(coalesce(lk -> 'items', '{}'::jsonb)) e
                join everwake.menu_items mi on mi.id = (e.value ->> 'id')::uuid
                left join everwake.menu_categories cat on cat.id = (e.value ->> 'category_id')::uuid
               where coalesce((e.value ->> 'orderable')::boolean, true) or q.table_label is not null
               group by cat.id, cat.name_ar, cat.name_en, cat.sort) c), '[]'::jsonb),
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object('title_ar', o.title_ar, 'title_en', o.title_en, 'description_ar', o.description_ar,
                                          'every_nth_order', o.every_nth_order, 'kind', o.kind) order by o.priority)
        from everwake.offers o
       where o.tenant_id = t.id and o.is_active and o.promo_code is null
         and (o.ends_at is null or o.ends_at > now()) and (o.starts_at is null or o.starts_at <= now())
         and (cardinality(o.branch_ids) = 0 or b.id = any (o.branch_ids))), '[]'::jsonb),
    'pairs', everwake.item_pairs(t.id));
end $$;

-- what the server needs to price a QR cart (the dashboard prices it, the same way the agent's cart does)
create or replace function everwake.qr_pricing_context(p_code text, p_phone text default null)
returns jsonb language plpgsql as $$
declare
  q everwake.qr_codes%rowtype;
  t everwake.tenants%rowtype;
  b everwake.branches%rowtype;
  v_phone text;
  v_cust bigint;
begin
  select * into q from everwake.qr_codes where code = p_code and is_active;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  select * into t from everwake.tenants where id = q.tenant_id;
  select * into b from everwake.branches where id = q.branch_id;
  perform everwake.ensure_snapshot(t.id);
  v_phone := everwake.wa_phone(p_phone, t.country);
  if v_phone is not null then
    select ci.customer_id into v_cust from everwake.customer_identities ci
     where ci.tenant_id = t.id and ci.kind = 'phone' and ci.value = v_phone limit 1;
  end if;
  return jsonb_build_object(
    'ok', true, 'tenant_id', t.id, 'branch_id', b.id, 'branch_state', everwake.branch_state(b.id), 'timezone', t.timezone,
    'vat_percent', b.vat_percent, 'currency', t.currency,
    'items', (select lookup -> 'items' from everwake.menu_snapshot where tenant_id = t.id and scope = b.id::text),
    'choices', (select lookup -> 'choices' from everwake.menu_snapshot where tenant_id = t.id and scope = b.id::text),
    'offers', (select lookup -> 'offers' from everwake.menu_snapshot where tenant_id = t.id and scope = 'all'),
    'orders_count', coalesce((select count(*) from everwake.orders o
                               where o.tenant_id = t.id and o.customer_id = v_cust
                                 and o.status not in ('draft', 'rejected', 'cancelled')), 0),
    'table', q.table_label);
end $$;

-- ---------------------------------------------------------------------
-- A priced cart waits for its money (called by the dashboard, which priced it)
-- p: code, cart {items}, totals {subtotal, discount_total, applied_offers, vat, total},
--    payment_method card|cash, customer {full_name, phone}, notes
-- ---------------------------------------------------------------------
create or replace function everwake.qr_checkout_create(p jsonb)
returns jsonb language plpgsql as $$
declare
  q       everwake.qr_codes%rowtype;
  t       everwake.tenants%rowtype;
  b       everwake.branches%rowtype;
  v_state text;
  v_phone text;
  v_name  text := nullif(btrim(p -> 'customer' ->> 'full_name'), '');
  v_cust  bigint;
  v_ticket int;
  c       everwake.qr_checkouts%rowtype;
  tot     jsonb := coalesce(p -> 'totals', '{}'::jsonb);
begin
  select * into q from everwake.qr_codes where code = p ->> 'code' and is_active;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  select * into t from everwake.tenants where id = q.tenant_id;
  select * into b from everwake.branches where id = q.branch_id;
  v_state := everwake.branch_state(b.id);
  if v_state in ('closed', 'not_accepting', 'paused') then
    return jsonb_build_object('ok', false, 'error', 'BRANCH_CLOSED', 'hours', b.hours_text_ar);
  end if;
  if v_state = 'busy' then return jsonb_build_object('ok', false, 'error', 'BRANCH_BUSY', 'reason', b.busy_reason); end if;
  if jsonb_array_length(coalesce(p -> 'cart' -> 'items', '[]'::jsonb)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'EMPTY');
  end if;
  if p ->> 'payment_method' not in ('card', 'cash') then return jsonb_build_object('ok', false, 'error', 'PAYMENT'); end if;

  -- the customer, by the number they gave (the same person as their WhatsApp chats)
  v_phone := everwake.wa_phone(p -> 'customer' ->> 'phone', t.country);
  if v_phone is not null then
    select ci.customer_id into v_cust from everwake.customer_identities ci
     where ci.tenant_id = t.id and ci.kind = 'phone' and ci.value = v_phone limit 1;
    if v_cust is null then
      insert into everwake.customers as cu (tenant_id, wa_id, reply_to, phone, full_name, display_name, language)
      values (t.id, v_phone, v_phone, v_phone, v_name, v_name, t.default_language)
      on conflict (tenant_id, wa_id) do update set full_name = coalesce(cu.full_name, excluded.full_name)
      returning id into v_cust;
      insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
      values (t.id, 'phone', v_phone, v_cust) on conflict do nothing;
    end if;
  end if;

  -- the ticket at the counter: 1, 2, 3… each day, per branch
  select coalesce(max(x.ticket), 0) + 1 into v_ticket
    from everwake.qr_checkouts x
   where x.branch_id = b.id and (x.created_at at time zone t.timezone)::date = (now() at time zone t.timezone)::date;

  insert into everwake.qr_checkouts (tenant_id, branch_id, qr_code_id, ticket, table_label, cart, subtotal, discount_total,
                                     applied_offers, vat, total, currency, payment_method, customer, customer_id, notes, expires_at)
  values (t.id, b.id, q.id, v_ticket, q.table_label, p -> 'cart', (tot ->> 'subtotal')::numeric,
          coalesce((tot ->> 'discount_total')::numeric, 0), coalesce(tot -> 'applied_offers', '[]'::jsonb),
          (tot ->> 'vat')::numeric, (tot ->> 'total')::numeric, t.currency, p ->> 'payment_method',
          jsonb_strip_nulls(jsonb_build_object('full_name', v_name, 'phone', case when v_phone is not null then '0' || substr(v_phone, 3) end)),
          v_cust, nullif(btrim(p ->> 'notes'), ''),
          now() + case when p ->> 'payment_method' = 'cash' then interval '30 minutes' else interval '20 minutes' end)
  returning * into c;
  return jsonb_build_object('ok', true, 'token', c.token, 'ticket', c.ticket, 'total', c.total, 'payment_method', c.payment_method);
end $$;

-- ---------------------------------------------------------------------
-- The money arrived: the checkout becomes an order for the kitchen
-- ---------------------------------------------------------------------
create or replace function everwake.qr_checkout_paid(p_checkout bigint, p_method text, p_user uuid default null)
returns jsonb language plpgsql as $$
declare
  c       everwake.qr_checkouts%rowtype;
  t       everwake.tenants%rowtype;
  b       everwake.branches%rowtype;
  o       everwake.orders%rowtype;
  v_seq   bigint;
  v_no    text;
  v_wa    text;
  v_conv  bigint;
  v_load  int;
  v_min   int;
  v_lang  text;
begin
  select * into c from everwake.qr_checkouts where id = p_checkout for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if c.order_id is not null then
    select * into o from everwake.orders where id = c.order_id;
    return jsonb_build_object('ok', true, 'order_id', o.id, 'order_no', o.order_no, 'already', true);
  end if;
  -- cash is taken only while the cart still waits; a card payment counts even after it expired (the money arrived)
  if c.status = 'cancelled' or (p_method = 'cash' and c.status <> 'awaiting_payment') then
    return jsonb_build_object('ok', false, 'error', 'NOT_WAITING', 'status', c.status);
  end if;
  select * into t from everwake.tenants where id = c.tenant_id;
  select * into b from everwake.branches where id = c.branch_id;

  update everwake.tenants set order_seq = order_seq + 1 where id = t.id returning order_seq into v_seq;
  v_no := t.order_no_prefix || '-' || v_seq;
  v_wa := coalesce(c.wa_id, 'qr-' || substr(c.token, 1, 16));
  select id into v_conv from everwake.conversations where tenant_id = t.id and wa_id = v_wa;

  -- the wait: the branch's own time, plus the orders ahead of it
  select count(*) into v_load from everwake.orders x
   where x.branch_id = b.id and x.status in ('placed', 'accepted', 'preparing') and x.placed_at > now() - interval '3 hours';
  v_min := coalesce(b.prep_minutes, 15) + least(v_load, 20) * 2;
  v_lang := coalesce(t.default_language, 'ar');

  insert into everwake.orders (tenant_id, order_no, customer_id, conversation_id, wa_id, branch_id, status, source, cart,
                               currency, subtotal, discount_total, applied_offers, vat, delivery_fee, total, delivery_method,
                               payment_method, payment_status, paid_at, paid_amount, customer, address_text, notes, eta_text,
                               placed_at, ready_by, qr_token, table_label, checkout_id)
  values (t.id, v_no, c.customer_id, v_conv, v_wa, b.id, 'placed', 'qr', c.cart, c.currency, c.subtotal, c.discount_total,
          c.applied_offers, c.vat, 0, c.total, case when c.table_label is null then 'pickup' else 'dine_in' end,
          case when p_method = 'card' then 'online' else 'cash' end, 'paid', now(), c.total, c.customer,
          case when c.table_label is not null then 'ترابيزة ' || c.table_label else 'استلام من الفرع' end,
          c.notes, v_min || ' دقيقة', now(), now() + make_interval(mins => v_min), c.token, c.table_label, c.id)
  returning * into o;

  insert into everwake.order_items (tenant_id, order_id, line_no, item_id, item_code, name, unit, quantity,
                                    unit_price, line_total, choices, notes, is_gift)
  select t.id, o.id, x.n::int, nullif(x.i ->> 'item_id', '')::uuid, x.i ->> 'code',
         coalesce(x.i ->> 'display_name', x.i ->> 'item_name', '?'), x.i ->> 'unit',
         coalesce((x.i ->> 'quantity')::numeric, 1), (x.i ->> 'unit_price')::numeric, (x.i ->> 'line_total')::numeric,
         coalesce(x.i -> 'choices', '[]'::jsonb), nullif(x.i ->> 'notes', ''), coalesce((x.i ->> 'gift')::boolean, false)
    from jsonb_array_elements(coalesce(c.cart -> 'items', '[]'::jsonb)) with ordinality as x(i, n);

  insert into everwake.order_events (tenant_id, order_id, status, by_role, by_user, note)
  values (t.id, o.id, 'placed', 'system', null, 'QR' || coalesce(' · ' || nullif(c.table_label, '') , '')),
         (t.id, o.id, 'payment_paid', case when p_user is null then 'system' else 'staff' end, p_user,
          everwake.money_text(c.total, t.currency_symbol_ar) || case when p_method = 'cash' then ' · كاش' else ' · أونلاين' end);

  if c.customer_id is not null then
    update everwake.customers
       set orders_count = orders_count + 1, total_spent = total_spent + coalesce(o.total, 0), last_order_id = o.id, last_order_at = now(),
           full_name = coalesce(full_name, nullif(c.customer ->> 'full_name', ''))
     where id = c.customer_id;
  end if;
  update everwake.qr_checkouts set status = 'paid', paid_at = now(), order_id = o.id where id = c.id;

  -- they asked for WhatsApp before paying: the order number and the wait, there too
  if v_conv is not null then
    perform everwake.queue_customer_message(t.id, v_wa, 'order_status',
      case when v_lang = 'en' then 'Your order ' || v_no || ' is in 👨‍🍳 Ready in about ' || v_min || ' minutes — we will message you here.'
           else 'طلبك رقم ' || v_no || ' اتأكد 👨‍🍳 هيكون جاهز خلال حوالي ' || v_min || ' دقيقة، وهنبعتلك هنا أول ما يجهز.' end);
  end if;
  return jsonb_build_object('ok', true, 'order_id', o.id, 'order_no', v_no, 'ready_by', o.ready_by, 'minutes', v_min);
end $$;

-- the cashier took the cash: now the kitchen sees it
create or replace function everwake.qr_cashier_paid(p_checkout bigint)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare c everwake.qr_checkouts%rowtype;
begin
  select * into c from everwake.qr_checkouts where id = p_checkout;
  if not found then raise exception 'not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(c.tenant_id, c.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  if c.status = 'awaiting_payment' and c.expires_at < now() then
    update everwake.qr_checkouts set status = 'expired' where id = c.id;
    return jsonb_build_object('ok', false, 'error', 'EXPIRED');
  end if;
  return everwake.qr_checkout_paid(c.id, 'cash', everwake.current_user_id());
end $$;

create or replace function everwake.qr_checkout_cancel(p_checkout bigint, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare c everwake.qr_checkouts%rowtype;
begin
  select * into c from everwake.qr_checkouts where id = p_checkout;
  if not found then raise exception 'not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.qr_checkouts set status = 'cancelled', cancel_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = c.id and status = 'awaiting_payment';
  return jsonb_build_object('ok', found);
end $$;

-- ---------------------------------------------------------------------
-- The customer's waiting page (public: the token is the key)
-- ---------------------------------------------------------------------
create or replace function everwake.qr_status(p_token text)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  c  everwake.qr_checkouts%rowtype;
  o  everwake.orders%rowtype;
  t  everwake.tenants%rowtype;
  b  everwake.branches%rowtype;
  wa text;
begin
  select * into c from everwake.qr_checkouts where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  select * into t from everwake.tenants where id = c.tenant_id;
  select * into b from everwake.branches where id = c.branch_id;
  if c.order_id is not null then select * into o from everwake.orders where id = c.order_id; end if;
  select ch.phone_number into wa from everwake.whatsapp_channels ch where ch.tenant_id = t.id and ch.is_active order by ch.created_at limit 1;
  return jsonb_build_object(
    'ok', true,
    'restaurant', jsonb_build_object('name_ar', t.name_ar, 'name_en', t.name_en, 'currency_symbol', t.currency_symbol_ar,
                                     'logo_url', t.profile -> 'brand' ->> 'logo_url', 'color', t.profile -> 'brand' ->> 'color',
                                     'language', t.default_language),
    'branch', jsonb_build_object('name_ar', b.name_ar, 'name_en', b.name_en),
    'ticket', c.ticket, 'table', c.table_label, 'payment_method', c.payment_method,
    'status', case when c.status = 'awaiting_payment' and c.expires_at < now() then 'expired' else c.status end,
    'expires_at', c.expires_at, 'total', c.total, 'cancel_reason', c.cancel_reason,
    'items', (select jsonb_agg(jsonb_build_object('name', coalesce(i ->> 'display_name', i ->> 'item_name'), 'quantity', i -> 'quantity',
                                                  'unit', i ->> 'unit', 'line_total', i -> 'line_total', 'gift', coalesce((i ->> 'gift')::boolean, false)))
                from jsonb_array_elements(c.cart -> 'items') i),
    'pay_url', (select p.link_url from everwake.payments p
                 where p.checkout_id = c.id and p.status = 'pending' and p.expires_at > now() order by p.id desc limit 1),
    'order', case when o.id is null then null else jsonb_build_object(
               'order_no', o.order_no, 'status', o.status, 'placed_at', o.placed_at, 'ready_by', o.ready_by,
               'ready_at', o.ready_at, 'eta_text', o.eta_text) end,
    'notes', coalesce((select jsonb_agg(jsonb_build_object('text', e.note, 'at', e.created_at) order by e.id)
                         from everwake.order_events e where e.order_id = o.id and e.status = 'note'), '[]'::jsonb),
    'whatsapp', jsonb_build_object('number', wa, 'linked', c.wa_id is not null,
                                   'code', 'Q-' || substr(c.token, 1, 10)),
    'loyalty', (select jsonb_build_object('every', ofr.every_nth_order, 'title_ar', ofr.title_ar,
                                          'orders', (select count(*) from everwake.orders x
                                                      where x.tenant_id = t.id and x.customer_id = c.customer_id
                                                        and x.status not in ('draft', 'rejected', 'cancelled')))
                  from everwake.offers ofr
                 where c.customer_id is not null and ofr.tenant_id = t.id and ofr.is_active and ofr.every_nth_order is not null
                 order by ofr.priority limit 1));
end $$;

-- ---------------------------------------------------------------------
-- Card payments for a QR checkout (the dashboard makes the Paymob link)
-- ---------------------------------------------------------------------
create or replace function everwake.qr_payment_prepare(p_token text)
returns jsonb language plpgsql as $$
declare
  a       everwake.payment_accounts%rowtype;
  c       everwake.qr_checkouts%rowtype;
  t       everwake.tenants%rowtype;
  v_ids   bigint[];
  v_ref   text;
  v_id    bigint;
  v_cents bigint;
  v_name  text;
  v_phone text;
begin
  select * into c from everwake.qr_checkouts where token = p_token for update;
  if not found or c.payment_method <> 'card' then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if c.status <> 'awaiting_payment' or c.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'NOT_WAITING'); end if;
  select * into a from everwake.payment_accounts where tenant_id = c.tenant_id;
  v_ids := array_remove(array[a.card_integration_id, a.wallet_integration_id], null) || coalesce(a.other_integration_ids, '{}');
  if a.tenant_id is null or not a.enabled or a.secret_key_id is null or a.public_key is null or cardinality(v_ids) = 0 then
    return jsonb_build_object('ok', false, 'error', 'NOT_CONNECTED');
  end if;
  select * into t from everwake.tenants where id = c.tenant_id;
  v_cents := round(c.total * 100)::bigint;
  v_ref := substr(everwake.random_token(), 1, 12);
  insert into everwake.payments (tenant_id, order_id, checkout_id, ref, amount, currency, expires_at, created_by, is_live)
  values (c.tenant_id, null, c.id, v_ref, c.total, c.currency, c.expires_at, 'agent', a.is_live)
  returning id into v_id;
  v_name := coalesce(nullif(btrim(c.customer ->> 'full_name'), ''), 'Customer');
  v_phone := coalesce(everwake.wa_phone(c.customer ->> 'phone', t.country), '201000000000');
  return jsonb_build_object('ok', true, 'payment_id', v_id, 'ref', v_ref, 'order_no', 'Q' || c.ticket, 'amount', c.total,
    'amount_cents', v_cents, 'currency', c.currency,
    'secret_key', everwake.vault_get(a.secret_key_id), 'public_key', a.public_key, 'integration_ids', to_jsonb(v_ids),
    'expiration', greatest(60, extract(epoch from c.expires_at - now())::int),
    'billing', jsonb_build_object('first_name', left(split_part(v_name, ' ', 1), 50),
      'last_name', left(coalesce(nullif(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), ''), 'NA'), 50),
      'phone_number', '+' || v_phone, 'email', coalesce(a.billing_email, 'customer@everwake.tech'),
      'street', 'NA', 'building', 'NA', 'floor', 'NA', 'apartment', 'NA', 'city', 'NA', 'state', 'NA', 'country', 'EG'),
    'items', jsonb_build_array(jsonb_build_object('name', coalesce(t.name_ar, t.name_en) || ' · ' || c.ticket, 'amount', v_cents, 'quantity', 1)),
    'notification_url', a.dashboard_url || '/api/pay/paymob/' || c.tenant_id,
    'redirection_url', a.dashboard_url || '/q/t/' || c.token,
    'short_url', null);
end $$;

create or replace function everwake.qr_payment_saved(p_payment bigint, p_link text, p_intention text, p_provider_order bigint)
returns jsonb language plpgsql as $$
begin
  update everwake.payments
     set status = 'pending', link_url = p_link, intention_id = p_intention, provider_order_id = p_provider_order, updated_at = now()
   where id = p_payment and status = 'creating' and checkout_id is not null;
  update everwake.payments set status = 'replaced', updated_at = now()
   where checkout_id = (select checkout_id from everwake.payments where id = p_payment) and id <> p_payment and status in ('creating', 'pending');
  return jsonb_build_object('ok', true, 'link', p_link);
end $$;

-- "tell me on WhatsApp when it's ready": the waiting page's message carries the order's
-- code (Q-…); intake (004) calls this, links the chat to the order and answers it
create or replace function everwake.qr_link_whatsapp(p_tenant uuid, p_customer bigint, p_wa text, p_conversation bigint, p_text text)
returns jsonb language plpgsql as $$
declare
  c everwake.qr_checkouts%rowtype;
  o everwake.orders%rowtype;
begin
  select * into c from everwake.qr_checkouts
   where tenant_id = p_tenant and token like lower(substring(p_text from '[Qq]-([0-9a-fA-F]{10})')) || '%'
     and created_at > now() - interval '1 day'
   order by id desc limit 1;
  if not found then return null; end if;
  update everwake.qr_checkouts set wa_id = p_wa, customer_id = coalesce(customer_id, p_customer) where id = c.id;
  if c.order_id is not null then
    update everwake.orders set wa_id = p_wa, customer_id = coalesce(customer_id, p_customer), conversation_id = p_conversation
     where id = c.order_id returning * into o;
  end if;
  perform everwake.queue_customer_message(p_tenant, p_wa, 'order_status',
    case when o.status = 'ready' then 'طلبك رقم ' || o.order_no || ' جاهز ✅ اتفضل استلمه'
         when o.id is not null then 'تمام 🔔 هبعتلك هنا أول ما طلبك رقم ' || o.order_no || ' يجهز.'
         else 'تمام 🔔 أول ما طلبك يتأكد هبعتلك هنا لما يجهز.' end);
  return jsonb_build_object('route', 'qr_linked', 'order_no', o.order_no);
end $$;

-- ---------------------------------------------------------------------
-- The kitchen's note about an order, to its customer (waiting page, and WhatsApp when linked)
-- ---------------------------------------------------------------------
create or replace function everwake.order_note_to_customer(p_order bigint, p_text text)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  o everwake.orders%rowtype;
  v_msg jsonb;
  v_sent boolean := false;
begin
  select * into o from everwake.orders where id = p_order;
  if not found then raise exception 'order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_text, '')), '') is null then raise exception 'write the note'; end if;
  if exists (select 1 from everwake.conversations where tenant_id = o.tenant_id and wa_id = o.wa_id) then
    v_msg := everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status',
               'بخصوص طلبك رقم ' || o.order_no || ': ' || btrim(p_text), p_user => everwake.current_user_id());
    v_sent := v_msg is not null and not coalesce((v_msg ->> 'skipped')::boolean, false);
  end if;
  insert into everwake.order_events (tenant_id, order_id, status, note, by_user, by_role, notified)
  values (o.tenant_id, o.id, 'note', left(btrim(p_text), 500), everwake.current_user_id(),
          case when everwake.current_user_id() is null then 'system' else 'staff' end, v_sent);
  return jsonb_build_object('ok', true, 'whatsapp', v_sent, 'order_no', o.order_no);
end $$;

-- ---------------------------------------------------------------------
-- Integrations: every order and stock change, queued for the restaurant's system
-- ---------------------------------------------------------------------
create or replace function everwake.order_payload(o everwake.orders)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'order_no', o.order_no, 'status', o.status, 'source', o.source, 'placed_at', o.placed_at,
    'branch', (select jsonb_build_object('code', b.code, 'name_ar', b.name_ar, 'name_en', b.name_en) from everwake.branches b where b.id = o.branch_id),
    'customer', o.customer, 'delivery_method', o.delivery_method, 'table', o.table_label, 'address', o.address_text,
    'payment_method', o.payment_method, 'payment_status', o.payment_status,
    'currency', o.currency, 'subtotal', o.subtotal, 'discount_total', o.discount_total, 'vat', o.vat,
    'delivery_fee', o.delivery_fee, 'total', o.total, 'notes', o.notes, 'ready_by', o.ready_by,
    'items', coalesce((select jsonb_agg(jsonb_build_object('code', i.item_code, 'name', i.name, 'quantity', i.quantity, 'unit', i.unit,
                                                           'unit_price', i.unit_price, 'line_total', i.line_total, 'choices', i.choices,
                                                           'notes', i.notes, 'gift', i.is_gift) order by i.line_no)
                         from everwake.order_items i where i.order_id = o.id), '[]'::jsonb))
$$;

create or replace function everwake.integration_queue(p_tenant uuid, p_event text, p_payload jsonb)
returns int language plpgsql as $$
declare n int;
begin
  insert into everwake.integration_events (tenant_id, endpoint_id, event, payload)
  select p_tenant, e.id, p_event, p_payload
    from everwake.integration_endpoints e
   where e.tenant_id = p_tenant and e.is_active and p_event = any (e.events);
  get diagnostics n = row_count;
  return n;
end $$;

-- orders: queued after the statement, so the order's lines are already there
create or replace function everwake.orders_to_integrations()
returns trigger language plpgsql as $$
begin
  if new.status = 'draft' or new.order_no is null then return null; end if;
  if not exists (select 1 from everwake.integration_endpoints e where e.tenant_id = new.tenant_id and e.is_active) then return null; end if;
  if tg_op = 'INSERT' or old.status = 'draft' then
    perform everwake.integration_queue(new.tenant_id, 'order.created', everwake.order_payload(new));
  elsif old.status is distinct from new.status or old.payment_status is distinct from new.payment_status then
    perform everwake.integration_queue(new.tenant_id, 'order.updated',
      everwake.order_payload(new) || jsonb_build_object('previous_status', old.status));
  end if;
  return null;
end $$;
create constraint trigger orders_integrations after insert or update on everwake.orders
  deferrable initially deferred for each row execute function everwake.orders_to_integrations();

create or replace function everwake.stock_to_integrations()
returns trigger language plpgsql as $$
declare v_code text; v_name text; v_branch text;
begin
  if not exists (select 1 from everwake.integration_endpoints e where e.tenant_id = new.tenant_id and e.is_active) then return null; end if;
  if tg_table_name = 'menu_items' then
    if old.is_available is not distinct from new.is_available and old.sold_out_until is not distinct from new.sold_out_until then return null; end if;
    perform everwake.integration_queue(new.tenant_id, 'item.availability', jsonb_build_object(
      'code', new.code, 'name', new.name_ar, 'branch', null, 'available', new.is_available and new.sold_out_until is null,
      'until', new.sold_out_until));
  else
    if tg_op = 'UPDATE' and old.is_available is not distinct from new.is_available
       and old.sold_out_until is not distinct from new.sold_out_until then return null; end if;
    select i.code, i.name_ar into v_code, v_name from everwake.menu_items i where i.id = new.item_id;
    select b.code into v_branch from everwake.branches b where b.id = new.branch_id;
    perform everwake.integration_queue(new.tenant_id, 'item.availability', jsonb_build_object(
      'code', v_code, 'name', v_name, 'branch', v_branch, 'available', new.is_available and new.sold_out_until is null,
      'until', new.sold_out_until));
  end if;
  return null;
end $$;
create trigger menu_items_integrations after update on everwake.menu_items
  for each row execute function everwake.stock_to_integrations();
create trigger menu_item_branches_integrations after insert or update on everwake.menu_item_branches
  for each row execute function everwake.stock_to_integrations();

-- n8n sends them (Outbox + Housekeeping): the next due deliveries, with the body to sign
create or replace function everwake.integration_claim(p_limit int default 25)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  with due as (
    select ev.id from everwake.integration_events ev
     where (ev.status = 'queued' and ev.next_try_at <= now())
        or (ev.status = 'sending' and ev.next_try_at < now() - interval '5 minutes')
     order by ev.id limit p_limit for update skip locked),
  claimed as (
    update everwake.integration_events ev set status = 'sending', attempts = ev.attempts + 1, next_try_at = now()
      from due where ev.id = due.id returning ev.*)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'url', e.url, 'secret', e.secret, 'event', c.event,
           'body', jsonb_build_object('id', c.id, 'event', c.event, 'created_at', c.created_at,
                                      'restaurant', (select t.slug from everwake.tenants t where t.id = c.tenant_id),
                                      'data', c.payload)::text) order by c.id), '[]'::jsonb)
    into v
    from claimed c join everwake.integration_endpoints e on e.id = c.endpoint_id;
  return v;
end $$;

create or replace function everwake.integration_result(p jsonb)
returns jsonb language plpgsql as $$
declare ev everwake.integration_events%rowtype; v_ok boolean := coalesce((p ->> 'ok')::boolean, false);
begin
  select * into ev from everwake.integration_events where id = (p ->> 'id')::bigint for update;
  if not found then return jsonb_build_object('ok', false); end if;
  if v_ok then
    update everwake.integration_events set status = 'sent', sent_at = now(), last_error = null where id = ev.id;
    update everwake.integration_endpoints set last_ok_at = now(), last_error = null where id = ev.endpoint_id;
  else
    -- 1, 2, 4, 8, 16, 32 minutes, then it is left as failed (the restaurant sees why)
    update everwake.integration_events
       set status = case when ev.attempts >= 7 then 'failed' else 'queued' end,
           next_try_at = now() + make_interval(mins => power(2, least(ev.attempts, 6))::int),
           last_error = left(coalesce(p ->> 'error', 'HTTP ' || coalesce(p ->> 'status_code', '?')), 300)
     where id = ev.id;
    update everwake.integration_endpoints
       set last_error = left(coalesce(p ->> 'error', 'HTTP ' || coalesce(p ->> 'status_code', '?')), 300)
     where id = ev.endpoint_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- the restaurant's system calls in with an API key (the dashboard checks it, then these run)
create or replace function everwake.api_key_create(p_tenant uuid, p_label text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_key text := 'ew_' || everwake.random_token();
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  insert into everwake.api_keys (tenant_id, label, key_hash, key_hint, created_by)
  values (p_tenant, nullif(btrim(coalesce(p_label, '')), ''), everwake.token_hash(v_key), right(v_key, 4), everwake.current_user_id());
  return jsonb_build_object('key', v_key);   -- shown once, never stored
end $$;

create or replace function everwake.api_key_tenant(p_key text)
returns uuid language plpgsql as $$
declare v uuid;
begin
  update everwake.api_keys set last_used_at = now()
   where key_hash = everwake.token_hash(p_key) and revoked_at is null
  returning tenant_id into v;
  return v;
end $$;

create or replace function everwake.api_set_stock(p_tenant uuid, p jsonb)
returns jsonb language plpgsql as $$
declare v_item uuid; v_branch uuid; v_until timestamptz := nullif(p ->> 'until', '')::timestamptz;
begin
  select id into v_item from everwake.menu_items where tenant_id = p_tenant and code = upper(p ->> 'item_code') and is_active;
  if v_item is null then return jsonb_build_object('ok', false, 'error', 'ITEM_NOT_FOUND'); end if;
  if nullif(p ->> 'branch_code', '') is not null then
    select id into v_branch from everwake.branches where tenant_id = p_tenant and code = p ->> 'branch_code';
    if v_branch is null then return jsonb_build_object('ok', false, 'error', 'BRANCH_NOT_FOUND'); end if;
  end if;
  perform everwake.set_item_availability(v_item, coalesce((p ->> 'available')::boolean, true), v_branch, v_until);
  return jsonb_build_object('ok', true);
end $$;

create or replace function everwake.api_set_order_status(p_tenant uuid, p_order_no text, p_status text, p_note text default null)
returns jsonb language plpgsql as $$
declare v_id bigint;
begin
  select id into v_id from everwake.orders where tenant_id = p_tenant and order_no = p_order_no;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND'); end if;
  return everwake.set_order_status(v_id, p_status, p_note, true, null);
end $$;

-- ---------------------------------------------------------------------
-- Who may see what
-- ---------------------------------------------------------------------
alter table everwake.qr_codes enable row level security;
alter table everwake.qr_checkouts enable row level security;
alter table everwake.integration_endpoints enable row level security;
alter table everwake.integration_events enable row level security;
alter table everwake.api_keys enable row level security;
create policy member_read on everwake.qr_codes for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));
create policy editor_write on everwake.qr_codes for all to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
create policy member_read on everwake.qr_checkouts for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));
create policy editor_read on everwake.integration_endpoints for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
create policy editor_write on everwake.integration_endpoints for all to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
create policy editor_read on everwake.integration_events for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
create policy editor_read on everwake.api_keys for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
create policy editor_revoke on everwake.api_keys for update to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));

grant select on everwake.qr_checkouts to authenticated;
grant select, insert, update, delete on everwake.qr_codes, everwake.integration_endpoints to authenticated;
grant select on everwake.integration_events to authenticated;
grant select (id, tenant_id, label, key_hint, created_by, created_at, last_used_at, revoked_at) on everwake.api_keys to authenticated;
grant update (revoked_at, label) on everwake.api_keys to authenticated;
grant all on everwake.qr_codes, everwake.qr_checkouts, everwake.integration_endpoints, everwake.integration_events,
  everwake.api_keys to service_role;

revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;
grant execute on function everwake.qr_cashier_paid(bigint), everwake.qr_checkout_cancel(bigint, text),
  everwake.order_note_to_customer(bigint, text), everwake.api_key_create(uuid, text), everwake.item_pairs(uuid, text[])
  to authenticated;

-- the functions 016 changes elsewhere: QR orders without WhatsApp are not messaged (005),
-- a card payment for a QR cart makes its order (011), loyalty in the snapshot (003),
-- intake links "tell me on WhatsApp" and the turn sees what is ordered together (004),
-- housekeeping expires unpaid QR carts (005)

create or replace function everwake.queue_customer_message(
  p_tenant uuid, p_wa text, p_purpose text, p_body text,
  p_kind text default 'text', p_media_url text default null, p_media_mime text default null,
  p_file_name text default null, p_sender text default 'system', p_user uuid default null,
  p_not_before timestamptz default now())
returns jsonb language plpgsql as $$
declare
  conv  everwake.conversations%rowtype;
  cust  everwake.customers%rowtype;
  v_ch  uuid;
  v_to  text;
  v_msg bigint;
  v_out bigint;
begin
  select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
  if not found then
    -- an order from a QR code whose customer never asked for WhatsApp (016): nothing to send
    if p_wa like 'qr-%' then return jsonb_build_object('skipped', true); end if;
    raise exception 'no conversation with % for this restaurant', p_wa;
  end if;
  select * into cust from everwake.customers where id = conv.customer_id;
  select ch.id into v_ch
    from everwake.whatsapp_channels ch
   where ch.tenant_id = p_tenant and ch.is_active
   order by (ch.id::text = conv.state -> 'contact' ->> 'channel_id') desc, ch.created_at
   limit 1;
  v_to := coalesce(nullif(conv.state -> 'contact' ->> 'reply_to', ''), cust.reply_to, p_wa);

  insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, staff_user_id, kind, body,
                                 media_url, media_mime, status, meta)
  values (p_tenant, conv.id, p_wa, 'outbound', p_sender, p_user, p_kind, p_body, p_media_url, p_media_mime, 'queued',
          jsonb_build_object('purpose', p_purpose))
  returning id into v_msg;

  insert into everwake.outbox (tenant_id, channel_id, to_jid, wa_id, message_id, purpose, kind, body, media_url,
                               media_mime, file_name, not_before, created_by)
  values (p_tenant, v_ch, v_to, p_wa, v_msg, p_purpose, p_kind, p_body, p_media_url, p_media_mime, p_file_name,
          p_not_before, p_user)
  returning id into v_out;

  update everwake.conversations
     set last_message_at = now(),
         last_message_preview = left(coalesce(p_body, '[' || p_kind || ']'), 160)
   where id = conv.id;
  return jsonb_build_object('outbox_id', v_out, 'message_id', v_msg);
end $$;

create or replace function everwake.set_order_status(p_order bigint, p_status text, p_note text default null,
                                                      p_notify boolean default true, p_eta text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  o       everwake.orders%rowtype;
  t       everwake.tenants%rowtype;
  s       jsonb;
  v_rank  jsonb := '{"placed":1,"accepted":2,"preparing":3,"ready":4,"out_for_delivery":5,"delivered":6,"picked_up":6}';
  v_lang  text;
  v_tpl   text;
  v_body  text;
  v_sent  boolean := false;
  v_bname text;
  v_line  text;
  v_q     jsonb;
begin
  select * into o from everwake.orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  if p_status not in ('accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'picked_up', 'rejected', 'cancelled') then
    raise exception 'unknown status %', p_status;
  end if;
  if o.status in ('draft', 'delivered', 'picked_up', 'rejected', 'cancelled') then
    raise exception 'this order is % and cannot change', o.status;
  end if;
  if p_status not in ('rejected', 'cancelled') and (v_rank ->> p_status)::int <= (v_rank ->> o.status)::int then
    raise exception 'the order is already %', o.status;
  end if;

  update everwake.orders
     set status = p_status,
         accepted_at = case when p_status in ('accepted', 'preparing') then coalesce(accepted_at, now()) else accepted_at end,
         ready_at = case when p_status = 'ready' then now() else ready_at end,
         out_for_delivery_at = case when p_status = 'out_for_delivery' then now() else out_for_delivery_at end,
         completed_at = case when p_status in ('delivered', 'picked_up') then now() else completed_at end,
         cancelled_at = case when p_status in ('rejected', 'cancelled') then now() else cancelled_at end,
         reject_reason = case when p_status in ('rejected', 'cancelled') then nullif(btrim(coalesce(p_note, '')), '') else reject_reason end,
         eta_text = coalesce(nullif(btrim(coalesce(p_eta, '')), ''), eta_text)
   where id = o.id
  returning * into o;

  -- a rejected / cancelled order is not money the customer spent
  if p_status in ('rejected', 'cancelled') and o.customer_id is not null then
    update everwake.customers
       set orders_count = greatest(0, orders_count - 1), total_spent = greatest(0, total_spent - coalesce(o.total, 0))
     where id = o.customer_id;
  end if;

  select * into t from everwake.tenants where id = o.tenant_id;
  s := everwake.merged_settings(t.settings);
  if coalesce(p_notify, true) then
    v_lang := everwake.customer_language(o.tenant_id, o.wa_id);
    v_tpl := s -> 'templates' ->> ('status_' || p_status || '_' || v_lang);
    -- on its way with one of the restaurant's drivers: their name, number and how far
    if p_status = 'out_for_delivery' then v_line := everwake.driver_line(o, v_lang); end if;
    if nullif(btrim(coalesce(v_tpl, '')), '') is not null or v_line is not null then
      select case when v_lang = 'en' then coalesce(nullif(name_en, ''), name_ar) else name_ar end
        into v_bname from everwake.branches where id = o.branch_id;
      v_body := everwake.render_template(v_tpl, jsonb_build_object(
        'order_no', o.order_no,
        'branch', coalesce(v_bname, ''),
        'eta', case when o.eta_text is null then ''
                    when v_lang = 'en' then ' Expected in about ' || o.eta_text || '.'
                    else ' الوقت المتوقع حوالي ' || o.eta_text || '.' end,
        'reason', case when nullif(btrim(coalesce(p_note, '')), '') is null then ''
                       when v_lang = 'en' then ' ' || btrim(p_note) || '.'
                       else ' ' || btrim(p_note) || '.' end,
        'name', ''));
      v_body := concat_ws(E'\n', nullif(btrim(coalesce(v_body, '')), ''), v_line);
      v_q := everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status', v_body,
                                             p_user => everwake.current_user_id());
      v_sent := not coalesce((v_q ->> 'skipped')::boolean, false);
    end if;
  end if;

  insert into everwake.order_events (tenant_id, order_id, status, note, by_user, by_role, notified)
  values (o.tenant_id, o.id, p_status, nullif(btrim(coalesce(p_note, '')), ''), everwake.current_user_id(),
          case when everwake.current_user_id() is null then 'system' else 'staff' end, v_sent);
  return jsonb_build_object('order_id', o.id, 'status', o.status, 'notified', v_sent);
end $$;

create or replace function everwake.housekeeping()
returns jsonb language plpgsql as $$
declare
  n_release int; n_locks int; n_stuck int; n_buf int; n_snap int := 0; n_busy int; n_rep int; n_pay int; n_qr int;
  r record;
begin
  -- a takeover nobody touched for a while goes back to the agent
  with idle as (
    select c.id, c.human_since
      from everwake.conversations c
      join everwake.tenants t on t.id = c.tenant_id
     where c.mode = 'human'
       and coalesce((everwake.merged_settings(t.settings) ->> 'human_auto_release_minutes')::int, 0) > 0
       and coalesce(c.human_last_activity_at, c.human_since, c.updated_at)
           < now() - make_interval(mins => (everwake.merged_settings(t.settings) ->> 'human_auto_release_minutes')::int)
  )
  update everwake.conversations c
     set mode = 'agent', assigned_user_id = null, human_reason = null, human_last_activity_at = null, human_since = null,
         state = c.state || jsonb_build_object('handback', jsonb_build_object('at', now(), 'by', 'auto', 'human_since', idle.human_since))
    from idle where c.id = idle.id;
  get diagnostics n_release = row_count;

  delete from everwake.conversation_locks where expires_at < now() - interval '1 minute';
  get diagnostics n_locks = row_count;

  update everwake.outbox set status = 'queued', not_before = now()
   where status = 'sending' and claimed_at < now() - interval '5 minutes';
  get diagnostics n_stuck = row_count;

  delete from everwake.inbound_buffer
   where (claimed_by_run_id is not null and received_at < now() - interval '1 hour')
      or (claimed_by_run_id is null and received_at < now() - interval '15 minutes');
  get diagnostics n_buf = row_count;

  update everwake.branches set busy_until = null, busy_reason = null where busy_until < now();
  get diagnostics n_busy = row_count;

  for r in select s.tenant_id from everwake.menu_snapshot s
            where s.scope = 'all' and s.valid_until is not null and s.valid_until <= now() loop
    perform everwake.rebuild_snapshot(r.tenant_id, false);
    n_snap := n_snap + 1;
  end loop;

  -- each restaurant's daily report on the owner's WhatsApp, at its hour (009)
  n_rep := everwake.send_due_reports();

  -- online payments: one reminder, then the link expires and the branch is told (011)
  n_pay := everwake.payment_due();

  -- QR carts nobody paid for in time (016): gone from the cashier's list, their links closed
  with gone as (
    update everwake.qr_checkouts set status = 'expired'
     where status = 'awaiting_payment' and expires_at < now() returning id)
  update everwake.payments p set status = 'expired', updated_at = now()
    from gone where p.checkout_id = gone.id and p.status in ('creating', 'pending');
  get diagnostics n_qr = row_count;

  return jsonb_build_object('takeovers_released', n_release, 'locks_cleared', n_locks, 'outbox_requeued', n_stuck,
                            'buffer_cleared', n_buf, 'busy_cleared', n_busy, 'snapshots_rebuilt', n_snap,
                            'reports_queued', n_rep, 'payments_due', n_pay, 'qr_payments_expired', n_qr);
end $$;

create or replace function everwake.payment_callback(p_tenant uuid, p jsonb)
returns jsonb language plpgsql as $$
declare
  pay     everwake.payments%rowtype;
  o       everwake.orders%rowtype;
  t       everwake.tenants%rowtype;
  v_amt   text;
  v_body  text;
  v_twice boolean;
  v_ok    boolean := coalesce((p ->> 'success')::boolean, false);
  v_pend  boolean := coalesce((p ->> 'pending')::boolean, false);
  v_back  boolean := coalesce((p ->> 'is_refunded')::boolean, false) or coalesce((p ->> 'is_voided')::boolean, false);
begin
  update everwake.payment_accounts set last_callback_at = now() where tenant_id = p_tenant;
  select * into pay from everwake.payments
   where tenant_id = p_tenant
     and (ref = nullif(p ->> 'merchant_order_id', '')
          or (nullif(p ->> 'merchant_order_id', '') is null and provider_order_id = nullif(p ->> 'provider_order_id', '')::bigint))
   order by id desc limit 1 for update;
  if not found then return jsonb_build_object('ok', true, 'matched', false); end if;

  -- a QR checkout (016): no order yet — the money arriving makes it
  if pay.order_id is null and pay.checkout_id is not null then
    if v_back then
      update everwake.payments set status = 'refunded', raw = p, updated_at = now() where id = pay.id and status = 'paid';
      update everwake.orders set payment_status = 'refunded', updated_at = now()
       where checkout_id = pay.checkout_id and payment_status = 'paid';
      return jsonb_build_object('ok', true, 'matched', true, 'status', 'refunded');
    end if;
    if v_pend then return jsonb_build_object('ok', true, 'matched', true, 'status', 'pending'); end if;
    if not v_ok then
      update everwake.payments set attempts = attempts + 1, last_error = left(coalesce(nullif(p ->> 'error', ''), 'declined'), 300),
                                   raw = p, updated_at = now() where id = pay.id;
      return jsonb_build_object('ok', true, 'matched', true, 'status', 'declined');
    end if;
    if (p ->> 'amount_cents')::bigint is distinct from round(pay.amount * 100)::bigint then
      update everwake.payments set last_error = 'AMOUNT_MISMATCH ' || (p ->> 'amount_cents'), raw = p, updated_at = now() where id = pay.id;
      return jsonb_build_object('ok', true, 'matched', true, 'status', 'amount_mismatch');
    end if;
    update everwake.payments
       set status = 'paid', paid_at = coalesce(paid_at, now()), transaction_id = nullif(p ->> 'transaction_id', '')::bigint,
           method = nullif(p ->> 'method', ''), card_brand = nullif(p ->> 'card_brand', ''), card_last4 = nullif(p ->> 'card_last4', ''),
           last_error = null, raw = p, updated_at = now()
     where id = pay.id;
    return jsonb_build_object('ok', true, 'matched', true, 'status', 'paid')
           || everwake.qr_checkout_paid(pay.checkout_id, 'card', null);
  end if;

  select * into o from everwake.orders where id = pay.order_id for update;
  select * into t from everwake.tenants where id = pay.tenant_id;
  v_amt := everwake.money_text(pay.amount, t.currency_symbol_ar);

  -- money given back from Paymob's dashboard
  if v_back then
    if pay.status = 'paid' then
      update everwake.payments set status = 'refunded', raw = p, updated_at = now() where id = pay.id;
      update everwake.orders set payment_status = 'refunded', updated_at = now() where id = o.id;
      insert into everwake.order_events (tenant_id, order_id, status, by_role, note)
      values (o.tenant_id, o.id, 'payment_refunded', 'system', v_amt);
      perform everwake.queue_ops_ticket(o.tenant_id, o.branch_id, '↩️ اترد مبلغ ' || v_amt || ' للطلب ' || o.order_no);
      return jsonb_build_object('ok', true, 'matched', true, 'status', 'refunded', 'queued', true);
    end if;
    return jsonb_build_object('ok', true, 'matched', true, 'status', pay.status);
  end if;

  if v_pend then
    update everwake.payments set raw = p, updated_at = now() where id = pay.id;
    return jsonb_build_object('ok', true, 'matched', true, 'status', 'pending');
  end if;

  if not v_ok then
    -- a declined card: they can try again on the same link until it expires
    update everwake.payments set attempts = attempts + 1, last_error = left(coalesce(nullif(p ->> 'error', ''), 'declined'), 300),
                                 raw = p, updated_at = now()
     where id = pay.id;
    return jsonb_build_object('ok', true, 'matched', true, 'status', 'declined');
  end if;

  if pay.status = 'paid' then return jsonb_build_object('ok', true, 'matched', true, 'status', 'paid', 'duplicate', true); end if;
  if (p ->> 'amount_cents')::bigint is distinct from round(pay.amount * 100)::bigint then
    update everwake.payments set last_error = 'AMOUNT_MISMATCH ' || (p ->> 'amount_cents'), raw = p, updated_at = now() where id = pay.id;
    perform everwake.queue_ops_ticket(o.tenant_id, o.branch_id,
      '⚠️ دفع أونلاين بمبلغ مختلف للطلب ' || o.order_no || ' — راجعوا لوحة Paymob');
    return jsonb_build_object('ok', true, 'matched', true, 'status', 'amount_mismatch', 'queued', true);
  end if;

  -- paid (a late payment on an expired or replaced link still counts: the money arrived)
  v_twice := o.payment_status = 'paid';
  update everwake.payments
     set status = 'paid', paid_at = now(), transaction_id = nullif(p ->> 'transaction_id', '')::bigint,
         method = nullif(p ->> 'method', ''), card_brand = nullif(p ->> 'card_brand', ''), card_last4 = nullif(p ->> 'card_last4', ''),
         last_error = null, raw = p, updated_at = now()
   where id = pay.id;
  update everwake.orders
     set payment_status = 'paid', paid_at = coalesce(paid_at, now()), paid_amount = coalesce(paid_amount, 0) + pay.amount, updated_at = now()
   where id = o.id;
  insert into everwake.order_events (tenant_id, order_id, status, by_role, note, notified)
  values (o.tenant_id, o.id, 'payment_paid', 'system',
          v_amt || coalesce(' · ' || nullif(concat_ws(' ', p ->> 'card_brand', nullif(p ->> 'card_last4', '')), ''), ''), true);
  if o.status not in ('rejected', 'cancelled') then
    v_body := everwake.payment_message(o.tenant_id, o.wa_id, 'payment_paid',
                                       jsonb_build_object('order_no', o.order_no, 'amount', v_amt));
    perform everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status', v_body);
  end if;
  perform everwake.queue_ops_ticket(o.tenant_id, o.branch_id,
    case when v_twice then '⚠️ الطلب ' || o.order_no || ' اتدفع أونلاين مرتين (' || v_amt || ' زيادة) — رجّعوا الفرق من لوحة Paymob'
         when o.status in ('rejected', 'cancelled') then '⚠️ الطلب ' || o.order_no || ' (' || o.status || ') اتدفع أونلاين ' || v_amt || ' — رجّعوا المبلغ من لوحة Paymob'
         else '💳 اتدفع أونلاين: ' || o.order_no || ' — ' || v_amt end);
  update everwake.conversations
     set needs_attention = false, attention_reason = null
   where tenant_id = o.tenant_id and wa_id = o.wa_id and attention_reason like '%' || o.order_no || '%';
  return jsonb_build_object('ok', true, 'matched', true, 'status', 'paid', 'order_no', o.order_no, 'queued', true);
end $$;

create or replace function everwake.rebuild_snapshot(p_tenant uuid, p_force boolean default true)
returns void language plpgsql as $$
declare
  t           everwake.tenants%rowtype;
  v_rev       bigint;
  v_sym       text;
  v_branches  jsonb;
  v_zones     jsonb;
  v_all_items jsonb;
  v_offers    jsonb;
  v_knowledge jsonb;
  v_media     jsonb;
  v_all       jsonb;
  v_digest    text;
  v_valid     timestamptz;
  v_bvalid    timestamptz;
  b           record;
  v_items     jsonb;
  v_choices   jsonb;
  v_bdigest   text;
  v_blookup   jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('everwake.snapshot:' || p_tenant::text, 0));
  if not p_force and everwake.snapshot_is_fresh(p_tenant) then
    return;
  end if;
  select * into t from everwake.tenants where id = p_tenant;
  if not found then return; end if;
  v_rev := t.menu_rev;
  v_sym := case when t.default_language = 'en' and t.currency_symbol_ar = 'ج' then ' ' || t.currency
                else t.currency_symbol_ar end;

  -- the effective menu of every active branch -------------------------
  create temp table if not exists _ew_eff (
    branch_id uuid, branch_code text, item_id uuid, code text, cat_id uuid, cat_name text, cat_sort int,
    cat_from time, cat_to time, name_ar text, name_en text, aliases text[], description_ar text,
    unit text, price numeric, qty_step numeric, min_qty numeric, tags text[], is_signature boolean,
    is_featured boolean, orderable boolean, available boolean, sold_out_until timestamptz,
    item_sort int, has_photo boolean
  ) on commit drop;
  truncate _ew_eff;

  insert into _ew_eff
  select br.id, br.code, i.id, i.code, c.id, coalesce(c.name_ar, 'أصناف أخرى'), coalesce(c.sort, 9999),
         c.available_from, c.available_to, i.name_ar, i.name_en, i.aliases, i.description_ar,
         i.unit, coalesce(mib.price, i.price), i.qty_step, i.min_qty, i.tags, i.is_signature,
         i.is_featured, i.orderable,
         i.is_available and coalesce(mib.is_available, true),
         greatest(case when i.sold_out_until > now() then i.sold_out_until end,
                  case when mib.sold_out_until > now() then mib.sold_out_until end),
         i.sort,
         exists (select 1 from everwake.item_media m where m.item_id = i.id)
    from everwake.branches br
    join everwake.menu_items i on i.tenant_id = br.tenant_id and i.is_active
    left join everwake.menu_categories c on c.id = i.category_id
    left join everwake.menu_item_branches mib on mib.item_id = i.id and mib.branch_id = br.id
   where br.tenant_id = p_tenant and br.is_active
     and coalesce(c.is_active, true)
     and (c.branch_ids is null or br.id = any(c.branch_ids))      -- a category only some branches serve
     and coalesce(mib.is_listed, true)
     and (i.orderable or br.dine_in is not false);               -- dine-in only: not where there is no seating

  select min(sold_out_until) into v_valid from _ew_eff where sold_out_until is not null;

  -- branches -------------------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', br.id, 'code', br.code, 'name_ar', br.name_ar, 'name_en', br.name_en, 'aliases', to_jsonb(br.aliases),
           'area_ar', br.area_ar, 'address_ar', br.address_ar, 'address_en', br.address_en,
           'lat', br.lat, 'lng', br.lng, 'maps_url', br.maps_url, 'phone', br.phone,
           'hours', br.hours, 'hours_text_ar', br.hours_text_ar,
           'accepting_orders', br.accepting_orders, 'busy_until', br.busy_until, 'busy_reason', br.busy_reason,
           'delivery_enabled', br.delivery_enabled, 'pickup_enabled', br.pickup_enabled,
           'delivery_fee', br.delivery_fee, 'min_order', br.min_order, 'max_delivery_km', br.max_delivery_km,
           'vat_percent', br.vat_percent, 'price_note_ar', br.price_note_ar,
           'prep_minutes', br.prep_minutes, 'delivery_eta_text', br.delivery_eta_text,
           'serves_hint_ar', br.serves_hint_ar, 'seasonal', br.seasonal,
           'dine_in', br.dine_in,
           'payment_methods', everwake.payment_methods_at(p_tenant, br.id),
           'own_payment_methods', br.payment_methods is not null,
           'zones', (select count(*) from everwake.delivery_zones z where z.branch_id = br.id and z.is_active))
         order by br.sort, br.name_ar), '[]'::jsonb)
    into v_branches
    from everwake.branches br
   where br.tenant_id = p_tenant and br.is_active;

  -- delivery zones (names and money only; the shapes stay in SQL) -----------
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', z.id, 'branch_id', z.branch_id, 'branch_code', br.code, 'name_ar', z.name_ar, 'name_en', z.name_en,
           'kind', z.kind, 'areas', to_jsonb(z.areas), 'delivery_fee', z.delivery_fee, 'min_order', z.min_order,
           'eta_min', z.eta_min, 'eta_max', z.eta_max, 'priority', z.priority)
         order by br.sort, z.priority, z.name_ar), '[]'::jsonb)
    into v_zones
    from everwake.delivery_zones z
    join everwake.branches br on br.id = z.branch_id and br.is_active
   where z.tenant_id = p_tenant and z.is_active;

  -- every dish across the restaurant: where it is sold and for how much ----
  select coalesce(jsonb_object_agg(x.code, x.entry), '{}'::jsonb)
    into v_all_items
    from (
      select e.code, jsonb_build_object(
               'id', min(e.item_id::text), 'name', min(e.name_ar), 'name_en', min(e.name_en),
               'aliases', to_jsonb(min(e.aliases)),
               'category', min(e.cat_name), 'unit', min(e.unit),
               'branches', jsonb_agg(distinct e.branch_code),
               'dine_in_only', bool_and(not e.orderable),
               'price_min', min(e.price), 'price_max', max(e.price),
               'signature', bool_or(e.is_signature or e.is_featured),
               'has_photo', bool_or(e.has_photo),
               'tags', to_jsonb(min(e.tags))) as entry
        from _ew_eff e
       group by e.code) x;

  -- offers that could apply now or later (time rules are checked per turn) --
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'title_ar', o.title_ar, 'title_en', o.title_en,
           'description_ar', o.description_ar, 'description_en', o.description_en,
           'kind', o.kind, 'scope', o.scope, 'value', o.value, 'max_discount', o.max_discount,
           'min_subtotal', o.min_subtotal,
           'item_codes', coalesce((select jsonb_agg(i.code) from everwake.menu_items i where i.id = any(o.item_ids)), '[]'::jsonb),
           'category_ids', to_jsonb(o.category_ids),
           'category_names', coalesce((select jsonb_agg(c.name_ar) from everwake.menu_categories c where c.id = any(o.category_ids)), '[]'::jsonb),
           'branch_ids', to_jsonb(o.branch_ids),
           'free_item_code', (select i.code from everwake.menu_items i where i.id = o.free_item_id),
           'free_item_name', (select i.name_ar from everwake.menu_items i where i.id = o.free_item_id),
           'free_item_qty', o.free_item_qty,
           'promo_code', o.promo_code, 'first_order_only', o.first_order_only, 'every_nth_order', o.every_nth_order,
           'stackable', o.stackable, 'priority', o.priority,
           'starts_at', o.starts_at, 'ends_at', o.ends_at, 'days_of_week', to_jsonb(o.days_of_week),
           'time_from', o.time_from, 'time_to', o.time_to)
         order by o.priority, o.created_at), '[]'::jsonb)
    into v_offers
    from everwake.offers o
   where o.tenant_id = p_tenant and o.is_active and (o.ends_at is null or o.ends_at > now());

  select coalesce(jsonb_agg(jsonb_build_object('topic', k.topic, 'content_ar', k.content_ar, 'content_en', k.content_en)
                            order by k.sort, k.topic), '[]'::jsonb)
    into v_knowledge
    from everwake.knowledge_entries k
   where k.tenant_id = p_tenant and k.is_active;

  select jsonb_build_object(
           'menu_pages', coalesce((select jsonb_object_agg(scope, n) from (
                             select coalesce(m.branch_id::text, 'all') as scope, count(*) as n
                               from everwake.menu_media m
                              where m.tenant_id = p_tenant and m.is_active
                              group by 1) s), '{}'::jsonb),
           'items_with_photos', coalesce((select jsonb_agg(distinct i.code)
                                           from everwake.menu_items i
                                           join everwake.item_media m on m.item_id = i.id
                                          where i.tenant_id = p_tenant and i.is_active), '[]'::jsonb))
    into v_media;

  v_all := jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name_ar', t.name_ar, 'name_en', t.name_en,
                                 'status', t.status, 'timezone', t.timezone, 'currency', t.currency,
                                 'currency_symbol', v_sym, 'default_language', t.default_language,
                                 'order_no_prefix', t.order_no_prefix),
    'profile', everwake.merged_profile(t.profile),
    'settings', everwake.merged_settings(t.settings),
    'branches', v_branches,
    'zones', v_zones,
    'items', v_all_items,
    'offers', v_offers,
    'knowledge', v_knowledge,
    'media', v_media);

  -- the all-branches MENU: what exists and where, before a branch is known
  select coalesce(string_agg(cat_block, E'\n\n' order by cat_sort, cat_name), '(المنيو لسه فاضي)')
    into v_digest
    from (
      select e.cat_name, min(e.cat_sort) as cat_sort,
             '### ' || e.cat_name
             || case when min(e.cat_from) is not null and min(e.cat_to) is not null
                     then ' (متاح ' || to_char(min(e.cat_from), 'HH24:MI') || '–' || to_char(min(e.cat_to), 'HH24:MI') || ' بس)'
                     else '' end
             || E'\n'
             || string_agg(line, E'\n' order by item_sort, name_ar) as cat_block
        from (
          select e.cat_name, e.cat_sort, e.cat_from, e.cat_to, e.code, min(e.item_sort) as item_sort, min(e.name_ar) as name_ar,
                 '- ' || e.code || ' ' || min(e.name_ar)
                 || coalesce(' (' || nullif(min(e.name_en), '') || ')', '')
                 || ' — '
                 || case when min(e.price) is null then 'السعر يتأكد من الفرع'
                         when min(e.price) = max(e.price) then everwake.fmt_money(min(e.price)) || v_sym
                         else everwake.fmt_money(min(e.price)) || '–' || everwake.fmt_money(max(e.price)) || v_sym || ' حسب الفرع' end
                 || case when min(e.unit) = 'kg' then ' للكيلو' when min(e.unit) = 'person' then ' للفرد' else '' end
                 || case when bool_or(e.is_signature or e.is_featured) then ' ★' else '' end
                 || case when bool_and(not e.orderable) then ' · في المطعم بس (مش دليفري ولا تيك أواي)' else '' end
                 || case when (select count(*) from jsonb_array_elements(v_branches)) > count(distinct e.branch_id)
                         then ' · متاح في: ' || string_agg(distinct br.name_ar, '، ')
                         else '' end as line
            from _ew_eff e
            join everwake.branches br on br.id = e.branch_id
           group by e.cat_name, e.cat_sort, e.cat_from, e.cat_to, e.code) e
       group by e.cat_name) blocks;

  insert into everwake.menu_snapshot (tenant_id, scope, digest_text, lookup, version_hash, source_rev, built_at, valid_until)
  values (p_tenant, 'all', v_digest, v_all, md5(v_digest || v_all::text), v_rev, now(), v_valid)
  on conflict (tenant_id, scope) do update
    set digest_text = excluded.digest_text, lookup = excluded.lookup, version_hash = excluded.version_hash,
        source_rev = excluded.source_rev, built_at = excluded.built_at, valid_until = excluded.valid_until;

  -- one snapshot per branch ------------------------------------------------
  for b in select br.id, br.code, br.name_ar from everwake.branches br
            where br.tenant_id = p_tenant and br.is_active loop

    select coalesce(jsonb_object_agg(e.code, jsonb_build_object(
             'id', e.item_id, 'name', e.name_ar, 'name_en', e.name_en, 'aliases', to_jsonb(e.aliases),
             'category', e.cat_name, 'category_id', e.cat_id, 'desc', e.description_ar,
             'price', e.price, 'unit', e.unit, 'qty_step', e.qty_step, 'min_qty', e.min_qty,
             'tags', to_jsonb(e.tags), 'signature', e.is_signature, 'featured', e.is_featured,
             'orderable', e.orderable, 'available', e.available, 'sold_out_until', e.sold_out_until,
             'has_photo', e.has_photo,
             'window', case when e.cat_from is not null and e.cat_to is not null
                            then jsonb_build_object('from', to_char(e.cat_from, 'HH24:MI'), 'to', to_char(e.cat_to, 'HH24:MI'))
                       end)), '{}'::jsonb),
           coalesce(jsonb_object_agg(e.code, jsonb_build_object('levels', everwake.item_choices_json(e.item_id, b.id)))
                      filter (where exists (select 1 from everwake.menu_option_groups g where g.item_id = e.item_id)
                                and everwake.item_choices_json(e.item_id, b.id) <> '[]'::jsonb),
                    '{}'::jsonb)
      into v_items, v_choices
      from _ew_eff e
     where e.branch_id = b.id;

    select coalesce(string_agg(cat_block, E'\n\n' order by cat_sort, cat_name), '(المنيو لسه فاضي)')
      into v_bdigest
      from (
        select e.cat_name, min(e.cat_sort) as cat_sort,
               '### ' || e.cat_name
               || case when min(e.cat_from) is not null and min(e.cat_to) is not null
                       then ' (متاح ' || to_char(min(e.cat_from), 'HH24:MI') || '–' || to_char(min(e.cat_to), 'HH24:MI') || ' بس)'
                       else '' end
               || E'\n'
               || string_agg(
                    '- ' || e.code || ' ' || e.name_ar
                    || coalesce(' (' || nullif(e.name_en, '') || ')', '')
                    || ' — '
                    || case when e.price is null then 'السعر يتأكد من الفرع' else everwake.fmt_money(e.price) || v_sym end
                    || case when e.unit = 'kg' then ' للكيلو' when e.unit = 'person' then ' للفرد'
                            when e.unit = 'piece' then ' للقطعة' else '' end
                    || case when e.is_signature or e.is_featured then ' ★' else '' end
                    || case when not e.orderable then ' · في المطعم بس (مش دليفري ولا تيك أواي)' else '' end
                    || case when not e.available then ' · خلصان دلوقتي'
                            when e.sold_out_until is not null then ' · خلصان لحد ' || to_char(e.sold_out_until at time zone t.timezone, 'HH24:MI')
                            else '' end
                    || case when e.has_photo then ' 📷' else '' end
                    || coalesce(E'\n  ' || left(nullif(btrim(e.description_ar), ''), 140), '')
                    || coalesce(E'\n  اختيارات: ' || everwake.item_choices_text(e.item_id, v_sym, b.id), ''),
                    E'\n' order by e.item_sort, e.name_ar) as cat_block
          from _ew_eff e
         where e.branch_id = b.id
         group by e.cat_name) blocks;

    v_blookup := jsonb_build_object(
      'branch', jsonb_build_object('id', b.id, 'code', b.code, 'name_ar', b.name_ar),
      'items', v_items,
      'choices', v_choices);

    select min(sold_out_until) into v_bvalid from _ew_eff where branch_id = b.id and sold_out_until is not null;

    insert into everwake.menu_snapshot (tenant_id, scope, digest_text, lookup, version_hash, source_rev, built_at, valid_until)
    values (p_tenant, b.id::text, v_bdigest, v_blookup, md5(v_bdigest || v_blookup::text), v_rev, now(), v_bvalid)
    on conflict (tenant_id, scope) do update
      set digest_text = excluded.digest_text, lookup = excluded.lookup, version_hash = excluded.version_hash,
          source_rev = excluded.source_rev, built_at = excluded.built_at, valid_until = excluded.valid_until;
  end loop;

  -- branches that were closed or removed
  delete from everwake.menu_snapshot s
   where s.tenant_id = p_tenant and s.scope <> 'all'
     and not exists (select 1 from everwake.branches br
                      where br.tenant_id = p_tenant and br.is_active and br.id::text = s.scope);
  drop table if exists _ew_eff;
end $$;

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

-- the cashier's list updates live (Supabase)
do $$
begin
  execute 'alter publication supabase_realtime add table everwake.qr_checkouts';
exception when others then null;
end $$;

-- rebuild every restaurant's menu snapshot so offers carry the loyalty rule
do $$
declare r record;
begin
  for r in select id from everwake.tenants loop perform everwake.rebuild_snapshot(r.id, true); end loop;
end $$;
