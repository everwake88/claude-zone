-- Everwake Orders · patch 2026-10-22 · Paymob secrets into Supabase Vault
-- The secret key and the HMAC secret move out of payment_accounts into
-- Supabase Vault (encrypted), and the plain columns are deleted. Keys already
-- saved are moved, nothing to re-type. Run once in Supabase → SQL Editor,
-- after 2026-10-22_payments.sql. (011_payments.sql already does this for new installs.)

-- Supabase Vault (on by default in Supabase; local tests load a stand-in)
do $$
begin
  if to_regnamespace('vault') is null and exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    create extension supabase_vault;
  end if;
end $$;
do $$
begin
  if to_regnamespace('vault') is null then
    raise exception 'Turn on Vault first: Supabase → Database → Extensions → supabase_vault';
  end if;
end $$;

alter table everwake.payment_accounts
  add column secret_key_id  uuid,
  add column hmac_secret_id uuid,
  add column secret_hint    text,
  add column live_keys      boolean not null default false;

create or replace function everwake.vault_put(p_id uuid, p_value text, p_name text)
returns uuid language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_id uuid;
begin
  if to_regnamespace('vault') is null then
    raise exception 'Supabase Vault is off: Supabase → Database → Extensions → turn on supabase_vault';
  end if;
  v_id := coalesce(p_id, (select s.id from vault.secrets s where s.name = p_name));
  if v_id is not null and exists (select 1 from vault.secrets s where s.id = v_id) then
    perform vault.update_secret(v_id, p_value);
    return v_id;
  end if;
  return vault.create_secret(p_value, p_name, 'Everwake Orders — a restaurant''s payment secret');
end $$;

create or replace function everwake.vault_get(p_id uuid)
returns text language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  if p_id is null or to_regnamespace('vault') is null then return null; end if;
  -- only the secrets of a restaurant's payment account, nothing else kept in Vault
  if not exists (select 1 from everwake.payment_accounts a where p_id in (a.secret_key_id, a.hmac_secret_id)) then return null; end if;
  return (select s.decrypted_secret from vault.decrypted_secrets s where s.id = p_id);
end $$;

create or replace function everwake.payment_account_forget()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
begin
  if to_regnamespace('vault') is not null then
    delete from vault.secrets where id in (old.secret_key_id, old.hmac_secret_id);
  end if;
  return old;
end $$;
create trigger payment_accounts_forget after delete on everwake.payment_accounts
  for each row execute function everwake.payment_account_forget();

-- the keys already saved move into Vault
update everwake.payment_accounts
   set secret_key_id = everwake.vault_put(null, secret_key, 'everwake_paymob_secret_key_' || tenant_id),
       secret_hint = right(secret_key, 4), live_keys = position('_live_' in secret_key) > 0
 where secret_key is not null;
update everwake.payment_accounts
   set hmac_secret_id = everwake.vault_put(null, hmac_secret, 'everwake_paymob_hmac_' || tenant_id)
 where hmac_secret is not null;

-- and the plain columns are gone
alter table everwake.payment_accounts drop column is_live, drop column secret_key, drop column hmac_secret;
alter table everwake.payment_accounts rename column live_keys to is_live;

create or replace function everwake.payment_account_view(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare a everwake.payment_accounts%rowtype;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  select * into a from everwake.payment_accounts where tenant_id = p_tenant;
  if not found then return jsonb_build_object('connected', false); end if;
  return jsonb_build_object(
    'connected', a.enabled, 'provider', a.provider, 'public_key', a.public_key,
    'has_secret_key', a.secret_key_id is not null, 'secret_hint', case when a.secret_key_id is not null then '…' || a.secret_hint end,
    'has_hmac_secret', a.hmac_secret_id is not null,
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
  -- secrets go straight into Vault and are never shown back; an empty field keeps the saved one
  if nullif(btrim(coalesce(p ->> 'secret_key', '')), '') is not null then
    v_txt := btrim(p ->> 'secret_key');
    a.secret_key_id := everwake.vault_put(a.secret_key_id, v_txt, 'everwake_paymob_secret_key_' || p_tenant);
    a.secret_hint := right(v_txt, 4);
    a.is_live := position('_live_' in v_txt) > 0;
  end if;
  if nullif(btrim(coalesce(p ->> 'hmac_secret', '')), '') is not null then
    a.hmac_secret_id := everwake.vault_put(a.hmac_secret_id, btrim(p ->> 'hmac_secret'), 'everwake_paymob_hmac_' || p_tenant);
  end if;
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
      when a.secret_key_id is null then 'the secret key'
      when a.hmac_secret_id is null then 'the HMAC secret'
      when cardinality(v_ids) = 0 then 'at least one integration ID'
      when a.dashboard_url is null then 'the dashboard address' end;
    if v_txt is not null then raise exception 'Paymob needs % before it can be switched on', v_txt; end if;
    if (a.public_key like '%\_live\_%') <> a.is_live then
      raise exception 'The public key and the secret key must both be test keys or both be live keys';
    end if;
  end if;

  update everwake.payment_accounts
     set public_key = a.public_key, secret_key_id = a.secret_key_id, hmac_secret_id = a.hmac_secret_id,
         secret_hint = a.secret_hint, is_live = a.is_live,
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
  if a.tenant_id is null or not a.enabled or a.secret_key_id is null or a.public_key is null or cardinality(v_ids) = 0 then
    return jsonb_build_object('ok', false, 'error', 'NOT_CONNECTED', 'fact', 'paying online is not set up for this restaurant');
  end if;
  select * into t from everwake.tenants where id = p_tenant;

  if p_order_no is null then
    v_ref := 'test-' || substr(everwake.random_token(), 1, 10);
    v_cents := round(coalesce(p_amount, 10) * 100)::bigint;
    return jsonb_build_object('ok', true, 'test', true, 'ref', v_ref, 'amount', coalesce(p_amount, 10), 'amount_cents', v_cents,
      'currency', t.currency, 'secret_key', everwake.vault_get(a.secret_key_id), 'public_key', a.public_key, 'integration_ids', to_jsonb(v_ids),
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
    'secret_key', everwake.vault_get(a.secret_key_id), 'public_key', a.public_key, 'integration_ids', to_jsonb(v_ids),
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

create or replace function everwake.payment_hmac_secret(p_tenant uuid)
returns text language sql stable as $$
  select everwake.vault_get(hmac_secret_id) from everwake.payment_accounts where tenant_id = p_tenant
$$;

revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;
