-- =====================================================================
-- Everwake Orders · 016 · ordering in the branch from a QR code, the
-- kitchen, loyalty, and other systems
--
-- A QR code on the counter or on a table opens the branch's menu on the
-- customer's phone (no app, no AI). They build a cart and pay by card
-- (Paymob) or cash at the counter. Nothing reaches the kitchen unpaid:
--   · qr_checkouts       the cart, priced on the server, waiting for its
--                        money — a card payment (payment_callback, 011)
--                        or the cashier's "paid" tap (qr_cashier_paid)
--   · qr_checkout_paid   turns a paid checkout into a real order: the
--                        board rings, the kitchen sees it, a time to wait
--   · qr_status          the customer's waiting page: the countdown, the
--                        kitchen's notes, "ready" (it sounds and vibrates)
--   · a WhatsApp alert   the waiting page offers a message with the
--                        order's code; intake (004) links that chat to
--                        the order, so "ready" also arrives on WhatsApp
-- The kitchen:
--   · order_note_to_customer   a note about an order, to its customer
--   · ready / sold out by voice: the dashboard hears it, shows what it
--     understood, and runs these same functions once confirmed
-- Also:
--   · loyalty: an offer for every Nth order (offers.every_nth_order),
--     in WhatsApp and QR orders alike
--   · item_pairs: what customers order together, for suggestions
--   · integrations: signed webhooks to the restaurant's own system
--     (POS / ERP / CRM — Odoo, Foodics…) for orders and stock, and API
--     keys for that system to switch dishes off or move an order on
-- =====================================================================

-- ---------------------------------------------------------------------
-- QR codes: one per branch counter, or one per table
-- ---------------------------------------------------------------------
create table if not exists everwake.qr_codes (
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
create index if not exists qr_codes_tenant_idx on everwake.qr_codes (tenant_id, branch_id);

-- a cart from a QR code, priced by the server, waiting for its money
create table if not exists everwake.qr_checkouts (
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
create index if not exists qr_checkouts_waiting_idx on everwake.qr_checkouts (tenant_id, branch_id, status) where status = 'awaiting_payment';

alter table everwake.orders
  add column if not exists qr_token     text unique,     -- the customer's waiting page
  add column if not exists table_label  text,            -- served at this table
  add column if not exists ready_by     timestamptz,     -- the time it was promised for
  add column if not exists checkout_id  bigint references everwake.qr_checkouts(id) on delete set null;

-- a card payment for a QR checkout has no order yet: the order is made when the money arrives
alter table everwake.payments alter column order_id drop not null;
alter table everwake.payments add column if not exists checkout_id bigint references everwake.qr_checkouts(id) on delete cascade;

-- loyalty: an offer for every Nth order (the 10th, the 20th…)
alter table everwake.offers add column if not exists every_nth_order int check (every_nth_order is null or every_nth_order >= 2);

-- ---------------------------------------------------------------------
-- Integrations: the restaurant's own system hears about orders and stock
-- (signed webhooks) and can switch dishes off / move orders on (API keys)
-- ---------------------------------------------------------------------
create table if not exists everwake.integration_endpoints (
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
create table if not exists everwake.integration_events (
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
create index if not exists integration_events_due_idx on everwake.integration_events (status, next_try_at) where status in ('queued', 'sending');

create table if not exists everwake.api_keys (
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

-- orders: queued after the statement, so the order's lines are already there.
-- Both run as the owner: a deferred trigger fires at commit, as whoever is
-- signed in (a cashier), who may not queue deliveries or read the secrets.
create or replace function everwake.orders_to_integrations()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
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
drop trigger if exists orders_integrations on everwake.orders;
create constraint trigger orders_integrations after insert or update on everwake.orders
  deferrable initially deferred for each row execute function everwake.orders_to_integrations();

create or replace function everwake.stock_to_integrations()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
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
drop trigger if exists menu_items_integrations on everwake.menu_items;
create trigger menu_items_integrations after update on everwake.menu_items
  for each row execute function everwake.stock_to_integrations();
drop trigger if exists menu_item_branches_integrations on everwake.menu_item_branches;
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

-- "Send a test" in the settings: one delivery to that address, whatever events it takes
create or replace function everwake.integration_test(p_endpoint uuid)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare e everwake.integration_endpoints%rowtype; v bigint;
begin
  select * into e from everwake.integration_endpoints where id = p_endpoint;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  perform everwake.require_role(e.tenant_id, array['owner', 'manager']);
  insert into everwake.integration_events (tenant_id, endpoint_id, event, payload)
  values (e.tenant_id, e.id, 'test', jsonb_build_object('message', 'Everwake can reach your system.'))
  returning id into v;
  return jsonb_build_object('ok', true, 'id', v);
end $$;

-- for a system that cannot receive webhooks (a POS behind the shop's router):
-- it asks every minute for what changed since its last ask
create or replace function everwake.api_orders(p_tenant uuid, p_since timestamptz, p_limit int default 100)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'orders', coalesce(jsonb_agg(everwake.order_payload(o) || jsonb_build_object('updated_at', o.updated_at) order by o.updated_at), '[]'::jsonb),
    'until', max(o.updated_at))
    from (select * from everwake.orders
           where tenant_id = p_tenant and status <> 'draft' and order_no is not null
             and updated_at > coalesce(p_since, now() - interval '1 day')
           order by updated_at limit least(greatest(coalesce(p_limit, 100), 1), 500)) o
$$;

-- the menu as the agent sells it in a branch: codes to map to the POS's own
create or replace function everwake.api_menu(p_tenant uuid, p_branch_code text default null)
returns jsonb language plpgsql as $$
declare v_scope text := 'all'; lk jsonb;
begin
  if nullif(p_branch_code, '') is not null then
    select id::text into v_scope from everwake.branches where tenant_id = p_tenant and code = p_branch_code and is_active;
    if v_scope is null then return jsonb_build_object('ok', false, 'error', 'BRANCH_NOT_FOUND'); end if;
  end if;
  perform everwake.ensure_snapshot(p_tenant);
  select lookup into lk from everwake.menu_snapshot where tenant_id = p_tenant and scope = v_scope;
  return jsonb_build_object('ok', true, 'branch', nullif(p_branch_code, ''), 'items', coalesce((
    select jsonb_agg(jsonb_build_object('code', e.key, 'name', e.value ->> 'name', 'name_en', e.value ->> 'name_en',
                                        'category', e.value ->> 'category', 'price', (e.value ->> 'price')::numeric,
                                        'unit', e.value ->> 'unit',
                                        'available', coalesce((e.value ->> 'available')::boolean, true) and (e.value ->> 'sold_out_until') is null,
                                        'sold_out_until', e.value ->> 'sold_out_until') order by e.key)
      from jsonb_each(coalesce(lk -> 'items', '{}'::jsonb)) e), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Who may see what
-- ---------------------------------------------------------------------
alter table everwake.qr_codes enable row level security;
alter table everwake.qr_checkouts enable row level security;
alter table everwake.integration_endpoints enable row level security;
alter table everwake.integration_events enable row level security;
alter table everwake.api_keys enable row level security;
drop policy if exists member_read on everwake.qr_codes;
create policy member_read on everwake.qr_codes for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));
drop policy if exists editor_write on everwake.qr_codes;
create policy editor_write on everwake.qr_codes for all to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
drop policy if exists member_read on everwake.qr_checkouts;
create policy member_read on everwake.qr_checkouts for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));
drop policy if exists editor_read on everwake.integration_endpoints;
create policy editor_read on everwake.integration_endpoints for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
drop policy if exists editor_write on everwake.integration_endpoints;
create policy editor_write on everwake.integration_endpoints for all to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
drop policy if exists editor_read on everwake.integration_events;
create policy editor_read on everwake.integration_events for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
drop policy if exists editor_read on everwake.api_keys;
create policy editor_read on everwake.api_keys for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
drop policy if exists editor_revoke on everwake.api_keys;
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
  everwake.order_note_to_customer(bigint, text), everwake.api_key_create(uuid, text), everwake.item_pairs(uuid, text[]),
  everwake.integration_test(uuid)
  to authenticated;
