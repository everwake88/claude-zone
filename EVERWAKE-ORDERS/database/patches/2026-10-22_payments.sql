-- Everwake Orders · patch 2026-10-22 · paying online (Paymob)
-- Each restaurant's own Paymob account, a payment link for orders paid online,
-- Paymob's payment notices, one reminder and the expiry of unpaid links, and
-- the team's "switch to cash" / "mark as paid" — the same as 011_payments.sql —
-- plus the agent's turn context with each order's payment, and the every-minute
-- housekeeping that sends the reminders. Already in the migrations for new
-- installs. Run once in Supabase → SQL Editor, after 2026-10-22_reservations.sql.

-- =====================================================================
-- Everwake Orders · 011 · paying online (Paymob)
--
-- A restaurant connects its own Paymob account (the money goes straight
-- to its bank; Everwake never holds it). Customers who choose "online"
-- get a payment link right after the agent places their order — a short
-- link on the dashboard's address that opens Paymob's checkout (card,
-- mobile wallet, whatever the restaurant switched on). Paymob tells the
-- dashboard when they pay; the order shows Paid, the customer and the
-- branch are told on WhatsApp, and the agent knows. Unpaid links get one
-- reminder and then expire, and the branch is asked to call the customer.
--
-- Payment links are made by the dashboard (it holds the Paymob calls and
-- checks Paymob's signature); this file keeps the rules and the records.
-- =====================================================================

alter table everwake.orders
  add column payment_status text not null default 'none'
             check (payment_status in ('none', 'pending', 'paid', 'expired', 'refunded')),
  add column paid_at        timestamptz,
  add column paid_amount    numeric(12, 2);

-- one Paymob account per restaurant; the keys never leave the database
-- except to the dashboard's server (service role)
create table everwake.payment_accounts (
  tenant_id             uuid primary key references everwake.tenants(id) on delete cascade,
  provider              text not null default 'paymob' check (provider in ('paymob')),
  enabled               boolean not null default false,
  public_key            text,
  secret_key            text,
  hmac_secret           text,
  card_integration_id   bigint,
  wallet_integration_id bigint,
  other_integration_ids bigint[] not null default '{}',
  link_minutes          int not null default 60 check (link_minutes between 10 and 1440),
  reminder_minutes      int not null default 15 check (reminder_minutes between 0 and 1440),   -- 0 = no reminder
  billing_email         text,             -- Paymob asks for an e-mail; customers on WhatsApp rarely give one
  dashboard_url         text,             -- where links are made and Paymob reports payments (set by the settings page)
  is_live               boolean generated always as (position('_live_' in coalesce(secret_key, '')) > 0) stored,
  last_callback_at      timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table everwake.payments (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references everwake.tenants(id) on delete cascade,
  order_id          bigint not null references everwake.orders(id) on delete cascade,
  provider          text not null default 'paymob',
  ref               text not null unique,       -- in the short link, and Paymob's special_reference
  amount            numeric(12, 2) not null,
  currency          text not null default 'EGP',
  status            text not null default 'creating'
                    check (status in ('creating', 'pending', 'paid', 'expired', 'replaced', 'cancelled', 'refunded')),
  link_url          text,                       -- Paymob's checkout page
  intention_id      text,
  provider_order_id bigint,
  transaction_id    bigint,
  method            text,                       -- card, wallet…
  card_brand        text,
  card_last4        text,
  attempts          int not null default 0,
  last_error        text,
  expires_at        timestamptz not null,
  reminded_at       timestamptz,
  paid_at           timestamptz,
  created_by        text not null default 'agent' check (created_by in ('agent', 'staff')),
  created_by_user   uuid,
  is_live           boolean not null default false,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index payments_order_idx on everwake.payments (order_id, created_at desc);
create index payments_open_idx on everwake.payments (status, expires_at) where status in ('creating', 'pending');
create index payments_provider_idx on everwake.payments (tenant_id, provider_order_id);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- 590 → "590ج", 12.5 → "12.5ج"
create or replace function everwake.money_text(n numeric, sym text)
returns text language sql immutable as $$
  select trim_scale(round(coalesce(n, 0), 2))::text || coalesce(sym, '')
$$;

-- "9:30 مساءً" / "9:30 PM" in the restaurant's clock
create or replace function everwake.local_clock(p timestamptz, p_tz text, p_lang text default 'ar')
returns text language sql stable as $$
  select case when p_lang = 'en' then to_char(p at time zone p_tz, 'FMHH12:MI AM')
              else to_char(p at time zone p_tz, 'FMHH12:MI')
                   || case when (p at time zone p_tz)::time < '12:00' then ' صباحاً' else ' مساءً' end end
$$;

-- a message to the branch's operations WhatsApp (or the restaurant's)
create or replace function everwake.queue_ops_ticket(p_tenant uuid, p_branch uuid, p_body text)
returns boolean language plpgsql as $$
declare v_to text; v_ch uuid;
begin
  select everwake.wa_phone(coalesce(nullif(b.ops_whatsapp, ''), nullif(everwake.merged_settings(t.settings) ->> 'ops_whatsapp', '')), t.country)
    into v_to
    from everwake.tenants t left join everwake.branches b on b.id = p_branch
   where t.id = p_tenant;
  if v_to is null then return false; end if;
  select ch.id into v_ch from everwake.whatsapp_channels ch where ch.tenant_id = p_tenant and ch.is_active order by ch.created_at limit 1;
  insert into everwake.outbox (tenant_id, channel_id, to_jid, purpose, body) values (p_tenant, v_ch, v_to, 'order_ticket', p_body);
  return true;
end $$;

-- the restaurant's wording if it has one, else ours
create or replace function everwake.payment_message(p_tenant uuid, p_wa text, p_key text, p_vars jsonb)
returns text language plpgsql stable as $$
declare
  v_lang text := everwake.customer_language(p_tenant, p_wa);
  v_tpl  text := nullif(btrim(coalesce(everwake.merged_settings((select settings from everwake.tenants where id = p_tenant))
                                         -> 'templates' ->> (p_key || '_' || v_lang), '')), '');
begin
  if v_tpl is null then
    v_tpl := case p_key || '_' || v_lang
      when 'payment_link_ar' then 'لينك الدفع لطلبك {order_no} — {amount}:' || E'\n' || '{link}' || E'\n' || 'اللينك شغال لحد {until}.'
      when 'payment_link_en' then 'Here is the payment link for order {order_no} — {amount}:' || E'\n' || '{link}' || E'\n' || 'It works until {until}.'
      when 'payment_paid_ar' then 'تم استلام الدفع ✅ {amount} لطلبك {order_no}. شكراً!'
      when 'payment_paid_en' then 'Payment received ✅ {amount} for your order {order_no}. Thank you!'
      when 'payment_reminder_ar' then 'لسه مستنيين الدفع لطلبك {order_no} ({amount}) 🙏' || E'\n' || '{link}' || E'\n' || 'لو حابب تدفع كاش عند الاستلام قولّنا.'
      when 'payment_reminder_en' then 'We are still waiting for the payment for order {order_no} ({amount}) 🙏' || E'\n' || '{link}' || E'\n' || 'Prefer cash on delivery? Just tell us.'
      when 'payment_cash_ar' then 'تمام، طلبك {order_no} هيتدفع كاش عند الاستلام.'
      when 'payment_cash_en' then 'All set — order {order_no} will be paid in cash on delivery.'
      else '' end;
  end if;
  return everwake.render_template(v_tpl, p_vars);
end $$;

-- the short link customers get: on the dashboard's address, so it is short, says
-- "already paid" or "expired" instead of an error, and leads back to WhatsApp
create or replace function everwake.payment_short_url(p_tenant uuid, p_ref text)
returns text language sql stable as $$
  select a.dashboard_url || '/p/' || p_ref from everwake.payment_accounts a where a.tenant_id = p_tenant
$$;

-- ---------------------------------------------------------------------
-- The restaurant's settings (owners and managers)
-- ---------------------------------------------------------------------
create or replace function everwake.payment_account_view(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare a everwake.payment_accounts%rowtype;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  select * into a from everwake.payment_accounts where tenant_id = p_tenant;
  if not found then return jsonb_build_object('connected', false); end if;
  return jsonb_build_object(
    'connected', a.enabled, 'provider', a.provider, 'public_key', a.public_key,
    'has_secret_key', a.secret_key is not null, 'secret_hint', case when a.secret_key is not null then '…' || right(a.secret_key, 4) end,
    'has_hmac_secret', a.hmac_secret is not null,
    'card_integration_id', a.card_integration_id, 'wallet_integration_id', a.wallet_integration_id,
    'other_integration_ids', to_jsonb(a.other_integration_ids), 'link_minutes', a.link_minutes,
    'reminder_minutes', a.reminder_minutes, 'billing_email', a.billing_email, 'dashboard_url', a.dashboard_url,
    'is_live', a.is_live, 'last_callback_at', a.last_callback_at, 'last_error', a.last_error, 'updated_at', a.updated_at);
end $$;

create or replace function everwake.save_payment_account(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  a      everwake.payment_accounts%rowtype;
  t      everwake.tenants%rowtype;
  v_txt  text;
  v_pm   jsonb;
  v_ids  bigint[];
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  insert into everwake.payment_accounts (tenant_id) values (p_tenant) on conflict do nothing;
  select * into a from everwake.payment_accounts where tenant_id = p_tenant for update;

  if p ? 'public_key' then a.public_key := nullif(btrim(p ->> 'public_key'), ''); end if;
  -- secrets are only replaced, never shown back; an empty field keeps the saved one
  if nullif(btrim(coalesce(p ->> 'secret_key', '')), '') is not null then a.secret_key := btrim(p ->> 'secret_key'); end if;
  if nullif(btrim(coalesce(p ->> 'hmac_secret', '')), '') is not null then a.hmac_secret := btrim(p ->> 'hmac_secret'); end if;
  if p ? 'card_integration_id' then a.card_integration_id := nullif(everwake.digits(p ->> 'card_integration_id'), '')::bigint; end if;
  if p ? 'wallet_integration_id' then a.wallet_integration_id := nullif(everwake.digits(p ->> 'wallet_integration_id'), '')::bigint; end if;
  if p ? 'other_integration_ids' then
    select coalesce(array_agg(x::bigint), '{}') into a.other_integration_ids
      from (select nullif(everwake.digits(v), '') as x from jsonb_array_elements_text(coalesce(p -> 'other_integration_ids', '[]'::jsonb)) v) q
     where x is not null;
  end if;
  if p ? 'link_minutes' then a.link_minutes := greatest(10, least(1440, coalesce((p ->> 'link_minutes')::int, 60))); end if;
  if p ? 'reminder_minutes' then a.reminder_minutes := greatest(0, least(1440, coalesce((p ->> 'reminder_minutes')::int, 15))); end if;
  if p ? 'billing_email' then a.billing_email := nullif(btrim(p ->> 'billing_email'), ''); end if;
  if nullif(btrim(coalesce(p ->> 'dashboard_url', '')), '') is not null then
    a.dashboard_url := regexp_replace(btrim(p ->> 'dashboard_url'), '/+$', '');
  end if;
  if p ? 'enabled' then a.enabled := coalesce((p ->> 'enabled')::boolean, false); end if;

  v_ids := array_remove(array[a.card_integration_id, a.wallet_integration_id], null) || a.other_integration_ids;
  if a.enabled then
    v_txt := case
      when a.public_key is null then 'the public key'
      when a.secret_key is null then 'the secret key'
      when a.hmac_secret is null then 'the HMAC secret'
      when cardinality(v_ids) = 0 then 'at least one integration ID'
      when a.dashboard_url is null then 'the dashboard address' end;
    if v_txt is not null then raise exception 'Paymob needs % before it can be switched on', v_txt; end if;
    if (a.public_key like '%\_test\_%') <> (a.secret_key like '%\_test\_%') then
      raise exception 'The public key and the secret key must both be test keys or both be live keys';
    end if;
  end if;

  update everwake.payment_accounts
     set public_key = a.public_key, secret_key = a.secret_key, hmac_secret = a.hmac_secret,
         card_integration_id = a.card_integration_id, wallet_integration_id = a.wallet_integration_id,
         other_integration_ids = a.other_integration_ids, link_minutes = a.link_minutes,
         reminder_minutes = a.reminder_minutes, billing_email = a.billing_email, dashboard_url = a.dashboard_url,
         enabled = a.enabled, last_error = case when a.enabled then null else last_error end, updated_at = now()
   where tenant_id = p_tenant;

  -- "online" is offered to customers exactly while Paymob is switched on
  select * into t from everwake.tenants where id = p_tenant for update;
  v_pm := coalesce(t.settings -> 'payment_methods', everwake.merged_settings(t.settings) -> 'payment_methods', '["cash"]'::jsonb);
  v_pm := coalesce((select jsonb_agg(x) from jsonb_array_elements_text(v_pm) x where x <> 'online'), '[]'::jsonb);
  if a.enabled then v_pm := v_pm || '["online"]'::jsonb; end if;
  update everwake.tenants set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('payment_methods', v_pm) where id = p_tenant;

  return everwake.payment_account_view(p_tenant);
end $$;

-- who may make a link for this order (any team member who sees its branch),
-- or test the account (owners and managers)
create or replace function everwake.payment_authorize(p_order bigint default null, p_tenant uuid default null)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare o everwake.orders%rowtype;
begin
  if p_order is null then
    perform everwake.require_role(p_tenant, array['owner', 'manager']);
    return jsonb_build_object('tenant_id', p_tenant);
  end if;
  select * into o from everwake.orders where id = p_order;
  if not found then raise exception 'Order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  return jsonb_build_object('tenant_id', o.tenant_id, 'order_no', o.order_no);
end $$;

-- ---------------------------------------------------------------------
-- Making a link (the dashboard's server calls these, with the service role)
-- ---------------------------------------------------------------------

-- right after the agent places an order: does it need a link, and where to ask for one?
create or replace function everwake.payment_after_place(p_tenant uuid, p_order_no text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'needed', coalesce(o.payment_method = 'online' and o.payment_status <> 'paid' and a.enabled and a.dashboard_url is not null, false),
    'endpoint', a.dashboard_url || '/api/pay/link',
    'tenant_id', p_tenant, 'order_no', p_order_no)
  from everwake.orders o
  left join everwake.payment_accounts a on a.tenant_id = o.tenant_id
  where o.tenant_id = p_tenant and o.order_no = p_order_no
$$;

-- everything Paymob needs for one link, and a payment row waiting for it.
-- p_order_no null = a test link from the settings page (no order, no row).
create or replace function everwake.payment_prepare(p_tenant uuid, p_order_no text, p_amount numeric default null,
                                                     p_by uuid default null)
returns jsonb language plpgsql as $$
declare
  a       everwake.payment_accounts%rowtype;
  t       everwake.tenants%rowtype;
  o       everwake.orders%rowtype;
  c       jsonb;
  v_ids   bigint[];
  v_amt   numeric;
  v_ref   text;
  v_id    bigint;
  v_name  text;
  v_phone text;
  v_why   text;
  v_cents bigint;
begin
  select * into a from everwake.payment_accounts where tenant_id = p_tenant;
  v_ids := array_remove(array[a.card_integration_id, a.wallet_integration_id], null) || coalesce(a.other_integration_ids, '{}');
  if a.tenant_id is null or not a.enabled or a.secret_key is null or a.public_key is null or cardinality(v_ids) = 0 then
    return jsonb_build_object('ok', false, 'error', 'NOT_CONNECTED', 'fact', 'paying online is not set up for this restaurant');
  end if;
  select * into t from everwake.tenants where id = p_tenant;

  if p_order_no is null then
    v_ref := 'test-' || substr(everwake.random_token(), 1, 10);
    v_cents := round(coalesce(p_amount, 10) * 100)::bigint;
    return jsonb_build_object('ok', true, 'test', true, 'ref', v_ref, 'amount', coalesce(p_amount, 10), 'amount_cents', v_cents,
      'currency', t.currency, 'secret_key', a.secret_key, 'public_key', a.public_key, 'integration_ids', to_jsonb(v_ids),
      'expiration', 900,
      'billing', jsonb_build_object('first_name', 'Everwake', 'last_name', 'Test', 'phone_number', '+201000000000',
                                    'email', coalesce(a.billing_email, 'customer@everwake.tech'), 'street', 'NA', 'building', 'NA',
                                    'floor', 'NA', 'apartment', 'NA', 'city', 'NA', 'state', 'NA', 'country', 'EG'),
      'items', jsonb_build_array(jsonb_build_object('name', 'Test payment', 'amount', v_cents, 'quantity', 1)),
      'notification_url', a.dashboard_url || '/api/pay/paymob/' || p_tenant,
      'redirection_url', null, 'short_url', null);
  end if;

  select * into o from everwake.orders where tenant_id = p_tenant and order_no = p_order_no for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND'); end if;
  if o.status in ('draft', 'rejected', 'cancelled') then
    return jsonb_build_object('ok', false, 'error', 'ORDER_CLOSED', 'fact', 'the order is ' || o.status);
  end if;
  if o.payment_status = 'paid' then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_PAID', 'fact', 'this order is already paid');
  end if;

  if p_amount is null then
    -- a link is only for a total that will not change
    v_why := case
      when o.delivery_method = 'delivery' and o.delivery_fee is null then 'the delivery fee is still to be confirmed by the branch'
      when o.vat is null and (select b.vat_percent from everwake.branches b where b.id = o.branch_id) is null
        then 'the branch still adds its fees to this total'
      when exists (select 1 from jsonb_array_elements(coalesce(o.cart -> 'items', '[]'::jsonb)) i
                    where i ->> 'price_known' = 'false' or i ->> 'extra_charge' = 'true')
        then 'a price in the order is still to be confirmed by the branch' end;
    if v_why is not null then
      update everwake.conversations
         set needs_attention = true, attention_at = now(),
             attention_reason = 'لينك الدفع للطلب ' || o.order_no || ' بعد ما الفرع يأكد الإجمالي'
       where tenant_id = p_tenant and wa_id = o.wa_id;
      return jsonb_build_object('ok', false, 'error', 'TOTAL_NOT_FINAL', 'reason', v_why,
        'fact', 'no payment link yet: ' || v_why || '. The team confirms the total and sends the link.');
    end if;
  end if;
  v_amt := round(coalesce(p_amount, o.total), 2);
  if v_amt < 1 then return jsonb_build_object('ok', false, 'error', 'AMOUNT_TOO_SMALL'); end if;
  v_cents := round(v_amt * 100)::bigint;

  v_ref := substr(everwake.random_token(), 1, 12);
  insert into everwake.payments (tenant_id, order_id, ref, amount, currency, expires_at, created_by, created_by_user, is_live)
  values (p_tenant, o.id, v_ref, v_amt, o.currency, now() + make_interval(mins => a.link_minutes),
          case when p_by is null then 'agent' else 'staff' end, p_by, a.is_live)
  returning id into v_id;

  c := coalesce(o.customer, '{}'::jsonb);
  v_name := coalesce(nullif(btrim(c ->> 'full_name'), ''), 'Customer');
  v_phone := coalesce(nullif(everwake.digits(c ->> 'phone'), ''), nullif(everwake.digits(o.wa_id), ''), '201000000000');
  return jsonb_build_object('ok', true, 'payment_id', v_id, 'ref', v_ref, 'order_no', o.order_no, 'amount', v_amt,
    'amount_cents', v_cents, 'currency', o.currency, 'currency_symbol', t.currency_symbol_ar,
    'secret_key', a.secret_key, 'public_key', a.public_key, 'integration_ids', to_jsonb(v_ids),
    'expiration', a.link_minutes * 60,
    'billing', jsonb_build_object(
      'first_name', left(split_part(v_name, ' ', 1), 50),
      'last_name', left(coalesce(nullif(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), ''), 'NA'), 50),
      'phone_number', '+' || v_phone, 'email', coalesce(a.billing_email, 'customer@everwake.tech'),
      'street', coalesce(nullif(o.address ->> 'street', ''), 'NA'), 'building', coalesce(nullif(o.address ->> 'building', ''), 'NA'),
      'floor', coalesce(nullif(o.address ->> 'floor', ''), 'NA'), 'apartment', coalesce(nullif(o.address ->> 'apartment', ''), 'NA'),
      'city', coalesce(nullif(o.address ->> 'city', ''), 'NA'), 'state', 'NA', 'country', 'EG'),
    'items', jsonb_build_array(jsonb_build_object('name', 'طلب ' || o.order_no, 'amount', v_cents, 'quantity', 1,
                                                  'description', coalesce(t.name_ar, t.name_en))),
    'notification_url', a.dashboard_url || '/api/pay/paymob/' || p_tenant,
    'redirection_url', a.dashboard_url || '/p/' || v_ref || '/done',
    'short_url', a.dashboard_url || '/p/' || v_ref);
end $$;

-- Paymob made the checkout: the link is live (and, from the dashboard, sent)
create or replace function everwake.payment_link_saved(p_payment bigint, p_link text, p_intention text,
                                                        p_provider_order bigint, p_send boolean default false)
returns jsonb language plpgsql as $$
declare
  p      everwake.payments%rowtype;
  o      everwake.orders%rowtype;
  t      everwake.tenants%rowtype;
  v_url  text;
  v_body text;
begin
  update everwake.payments
     set status = 'pending', link_url = p_link, intention_id = p_intention, provider_order_id = p_provider_order, updated_at = now()
   where id = p_payment and status = 'creating'
  returning * into p;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_WAITING_FOR_A_LINK'); end if;
  -- one open link per order: the new one replaces the old (only now that it exists — a failed try keeps the old one)
  update everwake.payments set status = 'replaced', updated_at = now()
   where order_id = p.order_id and id <> p.id and status in ('creating', 'pending');
  update everwake.orders set payment_status = 'pending', updated_at = now()
   where id = p.order_id and payment_status <> 'paid' returning * into o;
  if not found then select * into o from everwake.orders where id = p.order_id; end if;
  select * into t from everwake.tenants where id = p.tenant_id;
  v_url := everwake.payment_short_url(p.tenant_id, p.ref);

  if p_send then
    v_body := everwake.payment_message(p.tenant_id, o.wa_id, 'payment_link', jsonb_build_object(
      'order_no', o.order_no, 'amount', everwake.money_text(p.amount, t.currency_symbol_ar), 'link', v_url,
      'until', everwake.local_clock(p.expires_at, t.timezone, everwake.customer_language(p.tenant_id, o.wa_id))));
    perform everwake.queue_customer_message(p.tenant_id, o.wa_id, 'order_status', v_body, p_user => p.created_by_user);
  end if;
  insert into everwake.order_events (tenant_id, order_id, status, by_role, by_user, note, notified)
  values (p.tenant_id, o.id, 'payment_link', case when p.created_by = 'agent' then 'agent' else 'staff' end, p.created_by_user,
          everwake.money_text(p.amount, t.currency_symbol_ar), p_send or p.created_by = 'agent');

  return jsonb_build_object('ok', true, 'status', 'LINK_READY', 'link', v_url, 'amount', p.amount,
    'valid_until', everwake.local_clock(p.expires_at, t.timezone, everwake.customer_language(p.tenant_id, o.wa_id)),
    'expires_at', p.expires_at, 'sent', p_send);
end $$;

-- Paymob refused: nothing is live; the restaurant sees why
create or replace function everwake.payment_link_failed(p_payment bigint, p_error text)
returns jsonb language plpgsql as $$
declare p everwake.payments%rowtype;
begin
  update everwake.payments set status = 'cancelled', last_error = left(p_error, 500), updated_at = now()
   where id = p_payment and status = 'creating' returning * into p;
  if not found then return jsonb_build_object('ok', false); end if;
  update everwake.payment_accounts set last_error = left(p_error, 500), updated_at = now() where tenant_id = p.tenant_id;
  update everwake.conversations c
     set needs_attention = true, attention_at = now(),
         attention_reason = 'لينك الدفع مطلعش للطلب ' || o.order_no || ' — ابعتوه من صفحة الطلبات أو حوّلوه كاش'
    from everwake.orders o
   where o.id = p.order_id and c.tenant_id = o.tenant_id and c.wa_id = o.wa_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Paymob reports a payment (the dashboard checked its signature first)
-- p: transaction_id, provider_order_id, merchant_order_id (= our ref),
--    success, pending, amount_cents, currency, is_refunded, is_voided,
--    method, card_brand, card_last4, error
-- ---------------------------------------------------------------------
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

create or replace function everwake.payment_hmac_secret(p_tenant uuid)
returns text language sql stable as $$
  select hmac_secret from everwake.payment_accounts where tenant_id = p_tenant
$$;

-- the short link's page: where to send the customer, or what to tell them
create or replace function everwake.payment_public(p_ref text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'tenant_id', p.tenant_id, 'ref', p.ref, 'status', p.status, 'link_url', p.link_url,
    'expired', p.expires_at < now(), 'amount', p.amount, 'amount_text', everwake.money_text(p.amount, t.currency_symbol_ar),
    'order_no', o.order_no, 'order_paid', o.payment_status = 'paid',
    'restaurant', coalesce(t.name_ar, t.name_en), 'restaurant_en', t.name_en,
    'logo_url', t.profile -> 'brand' ->> 'logo_url', 'color', t.profile -> 'brand' ->> 'color',
    'whatsapp', (select ch.phone_number from everwake.whatsapp_channels ch where ch.tenant_id = p.tenant_id and ch.is_active
                  order by ch.created_at limit 1),
    'language', everwake.customer_language(p.tenant_id, o.wa_id))
  from everwake.payments p
  join everwake.orders o on o.id = p.order_id
  join everwake.tenants t on t.id = p.tenant_id
  where p.ref = p_ref
$$;

-- ---------------------------------------------------------------------
-- Every minute (from the housekeeping): one reminder, then the link expires
-- and the branch is asked to call the customer
-- ---------------------------------------------------------------------
create or replace function everwake.payment_due()
returns int language plpgsql as $$
declare
  r      record;
  n      int := 0;
  v_body text;
begin
  for r in
    select p.*, o.wa_id, o.order_no, o.branch_id, t.currency_symbol_ar as sym, t.timezone
      from everwake.payments p
      join everwake.payment_accounts a on a.tenant_id = p.tenant_id
      join everwake.orders o on o.id = p.order_id
      join everwake.tenants t on t.id = p.tenant_id
     where p.status = 'pending' and p.reminded_at is null and a.reminder_minutes > 0
       and p.created_at < now() - make_interval(mins => a.reminder_minutes) and p.expires_at > now() + interval '2 minutes'
       and o.payment_status = 'pending' and o.status not in ('rejected', 'cancelled')
     for update of p skip locked
  loop
    update everwake.payments set reminded_at = now() where id = r.id;
    v_body := everwake.payment_message(r.tenant_id, r.wa_id, 'payment_reminder', jsonb_build_object(
      'order_no', r.order_no, 'amount', everwake.money_text(r.amount, r.sym), 'link', everwake.payment_short_url(r.tenant_id, r.ref),
      'until', everwake.local_clock(r.expires_at, r.timezone, everwake.customer_language(r.tenant_id, r.wa_id))));
    perform everwake.queue_customer_message(r.tenant_id, r.wa_id, 'order_status', v_body);
    n := n + 1;
  end loop;

  for r in
    select p.*, o.wa_id, o.order_no, o.branch_id, o.status as order_status, o.payment_status as order_payment
      from everwake.payments p join everwake.orders o on o.id = p.order_id
     where p.status in ('creating', 'pending') and p.expires_at < now()
     for update of p skip locked
  loop
    update everwake.payments set status = 'expired', updated_at = now() where id = r.id;
    if r.order_payment = 'pending' and r.order_status not in ('rejected', 'cancelled') then
      update everwake.orders set payment_status = 'expired', updated_at = now() where id = r.order_id;
      insert into everwake.order_events (tenant_id, order_id, status, by_role) values (r.tenant_id, r.order_id, 'payment_expired', 'system');
      perform everwake.queue_ops_ticket(r.tenant_id, r.branch_id,
        '⚠️ الطلب ' || r.order_no || ': لينك الدفع خلص ومتدفعش — كلّموا العميل، ابعتوا لينك جديد أو حوّلوه كاش من صفحة الطلبات.');
      update everwake.conversations
         set needs_attention = true, attention_at = now(), attention_reason = 'الدفع أونلاين مكملش للطلب ' || r.order_no
       where tenant_id = r.tenant_id and wa_id = r.wa_id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- The team: pay in cash instead, or mark it paid another way
-- ---------------------------------------------------------------------
create or replace function everwake.set_order_payment(p_order bigint, p_action text, p_notify boolean default true)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  o everwake.orders%rowtype;
  t everwake.tenants%rowtype;
  v_sent boolean := false;
begin
  select * into o from everwake.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  select * into t from everwake.tenants where id = o.tenant_id;

  if p_action = 'cash' then
    if o.payment_status = 'paid' then raise exception 'This order is already paid online'; end if;
    update everwake.payments set status = 'cancelled', updated_at = now() where order_id = o.id and status in ('creating', 'pending');
    update everwake.orders set payment_method = 'cash', payment_status = 'none', updated_at = now() where id = o.id;
    if coalesce(p_notify, true) then
      perform everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status',
        everwake.payment_message(o.tenant_id, o.wa_id, 'payment_cash', jsonb_build_object('order_no', o.order_no)),
        p_user => everwake.current_user_id());
      v_sent := true;
    end if;
    insert into everwake.order_events (tenant_id, order_id, status, by_role, by_user, notified)
    values (o.tenant_id, o.id, 'payment_cash', 'staff', everwake.current_user_id(), v_sent);
  elsif p_action = 'mark_paid' then
    update everwake.payments set status = 'cancelled', updated_at = now() where order_id = o.id and status in ('creating', 'pending');
    update everwake.orders set payment_status = 'paid', paid_at = now(), paid_amount = o.total, updated_at = now() where id = o.id;
    insert into everwake.order_events (tenant_id, order_id, status, by_role, by_user, note)
    values (o.tenant_id, o.id, 'payment_paid', 'staff', everwake.current_user_id(), 'marked paid by the team');
  else
    raise exception 'action is cash or mark_paid';
  end if;
  update everwake.conversations
     set needs_attention = false, attention_reason = null
   where tenant_id = o.tenant_id and wa_id = o.wa_id and attention_reason like '%' || o.order_no || '%';
  return jsonb_build_object('id', o.id, 'action', p_action, 'notified', v_sent);
end $$;

-- ---------------------------------------------------------------------
-- Who can see and call what
-- ---------------------------------------------------------------------
alter table everwake.payment_accounts enable row level security;     -- no policies: only through the functions above
alter table everwake.payments enable row level security;
create policy member_read on everwake.payments for select to authenticated
  using (exists (select 1 from everwake.orders o where o.id = order_id));
grant select (id, tenant_id, order_id, provider, ref, amount, currency, status, link_url, method, card_brand, card_last4,
              attempts, last_error, expires_at, reminded_at, paid_at, created_by, created_by_user, is_live, created_at, updated_at)
  on everwake.payments to authenticated;
grant all on everwake.payment_accounts, everwake.payments to service_role;

revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;
grant execute on function everwake.payment_account_view(uuid), everwake.save_payment_account(uuid, jsonb),
  everwake.payment_authorize(bigint, uuid), everwake.set_order_payment(bigint, text, boolean),
  everwake.money_text(numeric, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 004 · the agent sees whether each recent order is paid, and its live link
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
                                           'text', m.body, 'at', m.created_at, 'staff_name', m.staff_name,
                                           'status', m.status)
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

-- ---------------------------------------------------------------------
-- 005 · every minute: payment reminders and expired links
-- ---------------------------------------------------------------------
create or replace function everwake.housekeeping()
returns jsonb language plpgsql as $$
declare
  n_release int; n_locks int; n_stuck int; n_buf int; n_snap int := 0; n_busy int; n_rep int; n_pay int;
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

  return jsonb_build_object('takeovers_released', n_release, 'locks_cleared', n_locks, 'outbox_requeued', n_stuck,
                            'buffer_cleared', n_buf, 'busy_cleared', n_busy, 'snapshots_rebuilt', n_snap,
                            'reports_queued', n_rep, 'payments_due', n_pay);
end $$;
