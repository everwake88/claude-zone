-- =====================================================================
-- Everwake Orders · 018 · What the AI costs, and what restaurants owe
-- - ai_prices: each model's price per million tokens (the developer edits it)
-- - ai_config: the AI settings, for everyone and per restaurant (model,
--   how hard each step thinks, details asked by code, ❤️ for messages that
--   need no reply) — read by the AI meter and by the engine
-- - ai_usage: one row per call to the AI (planning, reply, voice note,
--   photo), with its tokens, cached tokens, thinking and cost. Only
--   Everwake's developers (platform admins) can read it.
-- - tenant_billing + bill_statement: Everwake's percent per restaurant and
--   the statement of every order that came through Everwake.
-- Safe to run again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Prices ($ per 1M tokens; a transcription billed by the minute has its own price)
-- ---------------------------------------------------------------------
create table if not exists everwake.ai_prices (
  model            text primary key,            -- matched as a prefix: gpt-5-mini covers gpt-5-mini-2025-08-07
  input_per_m      numeric(12, 4) not null default 0,
  cached_per_m     numeric(12, 4) not null default 0,
  output_per_m     numeric(12, 4) not null default 0,
  audio_per_minute numeric(12, 4),
  updated_at       timestamptz not null default now()
);
insert into everwake.ai_prices (model, input_per_m, cached_per_m, output_per_m, audio_per_minute) values
  ('gpt-6-luna', 0.10, 0.01, 0.50, null),
  ('gpt-5.6-luna', 0.20, 0.02, 1.20, null),
  ('gpt-5-mini', 0.25, 0.025, 2.00, null),
  ('gpt-transcribe', 2.50, 0, 10.00, 0.006)
on conflict (model) do nothing;

-- ---------------------------------------------------------------------
-- AI settings: scope 'global', or a restaurant's id for its own
-- ---------------------------------------------------------------------
create table if not exists everwake.ai_config (
  scope           text primary key,             -- 'global' or a tenant uuid
  brain_model     text,                         -- null = what the workflow was built with
  brain_effort    text check (brain_effort in ('minimal', 'low', 'medium', 'high')),
  agent_model     text,
  agent_effort    text check (agent_effort in ('minimal', 'low', 'medium', 'high')),
  details_by_code boolean,                      -- the customer's details asked and read by code, the AI only when unsure
  react_no_reply  boolean,                      -- ❤️ on "👍", stickers, "شكرا" when nothing is pending
  usd_egp         numeric(10, 4),               -- for showing costs in EGP (global only)
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
insert into everwake.ai_config (scope, brain_effort, agent_effort, details_by_code, react_no_reply, usd_egp)
values ('global', 'medium', 'low', true, true, 50)
on conflict (scope) do nothing;

-- one restaurant's settings: its own over the global ones
create or replace function everwake.ai_settings(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = everwake, pg_temp as $$
  select jsonb_build_object(
    'brain_model', coalesce(t.brain_model, g.brain_model), 'brain_effort', coalesce(t.brain_effort, g.brain_effort, 'medium'),
    'agent_model', coalesce(t.agent_model, g.agent_model), 'agent_effort', coalesce(t.agent_effort, g.agent_effort, 'low'),
    'details_by_code', coalesce(t.details_by_code, g.details_by_code, false),
    'react_no_reply', coalesce(t.react_no_reply, g.react_no_reply, false),
    'usd_egp', coalesce(g.usd_egp, 50))
    from (select 1) x
    left join everwake.ai_config g on g.scope = 'global'
    left join everwake.ai_config t on t.scope = p_tenant::text
$$;

-- ---------------------------------------------------------------------
-- Usage: every call to the AI
-- ---------------------------------------------------------------------
create table if not exists everwake.ai_usage (
  id               bigint generated always as identity primary key,
  tenant_id        uuid references everwake.tenants(id) on delete cascade,
  run_id           text,                        -- the turn (one customer message, or a burst of them)
  message_id       bigint,                      -- the customer's message that started it
  wa_id            text,                        -- the customer (filled from the message)
  step             text not null,               -- brain | agent | transcribe | vision | other
  kind             text not null default 'text' check (kind in ('text', 'voice', 'image', 'test')),
  model            text,
  endpoint         text,
  input_tokens     int not null default 0,      -- all of them, cached included
  cached_tokens    int not null default 0,
  output_tokens    int not null default 0,      -- the thinking included
  reasoning_tokens int not null default 0,
  audio_seconds    numeric(10, 2),
  cost_usd         numeric(14, 8),
  priced           boolean not null default false,
  http_status      int,
  duration_ms      int,
  created_at       timestamptz not null default now()
);
create index if not exists ai_usage_tenant_time_idx on everwake.ai_usage (tenant_id, created_at);
create index if not exists ai_usage_run_idx on everwake.ai_usage (run_id);
create index if not exists ai_usage_customer_idx on everwake.ai_usage (tenant_id, wa_id, created_at);

-- the price of a call, from the longest model prefix that has one
create or replace function everwake.ai_usage_price() returns trigger
language plpgsql security definer set search_path = everwake, pg_temp as $$
declare p everwake.ai_prices%rowtype;
begin
  if new.wa_id is null and new.message_id is not null then
    select m.wa_id into new.wa_id from everwake.messages m where m.id = new.message_id;
  end if;
  select * into p from everwake.ai_prices
   where new.model is not null and lower(new.model) like lower(model) || '%'
   order by length(model) desc limit 1;
  if found then
    new.cost_usd := case
      when new.audio_seconds is not null and p.audio_per_minute is not null and new.input_tokens = 0
        then new.audio_seconds / 60.0 * p.audio_per_minute
      else (greatest(new.input_tokens - new.cached_tokens, 0) * p.input_per_m
            + new.cached_tokens * p.cached_per_m + new.output_tokens * p.output_per_m) / 1000000.0 end;
    new.priced := true;
  end if;
  return new;
end $$;
drop trigger if exists ai_usage_price on everwake.ai_usage;
create trigger ai_usage_price before insert or update of model, input_tokens, cached_tokens, output_tokens, audio_seconds
  on everwake.ai_usage for each row execute function everwake.ai_usage_price();

alter table everwake.ai_usage enable row level security;
alter table everwake.ai_prices enable row level security;
alter table everwake.ai_config enable row level security;
drop policy if exists admin_read on everwake.ai_usage;
create policy admin_read on everwake.ai_usage for select to authenticated using ((select everwake.is_platform_admin()));
drop policy if exists admin_all on everwake.ai_prices;
create policy admin_all on everwake.ai_prices for all to authenticated
  using ((select everwake.is_platform_admin())) with check ((select everwake.is_platform_admin()));
drop policy if exists admin_all on everwake.ai_config;
create policy admin_all on everwake.ai_config for all to authenticated
  using ((select everwake.is_platform_admin())) with check ((select everwake.is_platform_admin()));
grant select on everwake.ai_usage to authenticated;
grant select, insert, update, delete on everwake.ai_prices, everwake.ai_config to authenticated;
grant all on everwake.ai_usage, everwake.ai_prices, everwake.ai_config to service_role;

create or replace function everwake.require_platform_admin()
returns void language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  if everwake.current_user_id() is not null and not everwake.is_platform_admin() then
    raise exception 'for Everwake''s developers only' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Which order a turn belongs to: the customer's next order placed within
-- 12 hours (the chat that led to it), else their last order placed within
-- the 24 hours before (asking where it is); else none (a chat that never ordered)
-- ---------------------------------------------------------------------
create or replace function everwake.ai_turns(p_from timestamptz, p_to timestamptz, p_tenant uuid default null)
returns table (run_id text, tenant_id uuid, wa_id text, kind text, at timestamptz, calls int,
               input_tokens bigint, cached_tokens bigint, output_tokens bigint, reasoning_tokens bigint,
               cost_usd numeric, steps jsonb, order_id bigint, part text)
language sql stable security definer set search_path = everwake, pg_temp as $$
  with u as (
    select coalesce(u.run_id, 'call-' || u.id) as rid, u.*
      from everwake.ai_usage u
     where u.created_at >= p_from and u.created_at < p_to and (p_tenant is null or u.tenant_id = p_tenant)
  ), t as (
    select rid, min(tenant_id::text)::uuid as tenant_id, max(wa_id) as wa_id,
           case when bool_or(kind = 'test') then 'test' when bool_or(kind = 'voice') then 'voice'
                when bool_or(kind = 'image') then 'image' else 'text' end as kind,
           min(created_at) as at, count(*)::int as calls,
           sum(input_tokens) as input_tokens, sum(cached_tokens) as cached_tokens,
           sum(output_tokens) as output_tokens, sum(reasoning_tokens) as reasoning_tokens,
           sum(coalesce(cost_usd, 0)) as cost_usd,
           jsonb_agg(jsonb_build_object('step', step, 'model', model, 'in', input_tokens, 'cached', cached_tokens,
                     'out', output_tokens, 'thinking', reasoning_tokens, 'cost', cost_usd, 'priced', priced,
                     'seconds', audio_seconds, 'ms', duration_ms, 'status', http_status) order by created_at) as steps
      from u group by rid
  )
  select t.rid, t.tenant_id, t.wa_id, t.kind, t.at, t.calls, t.input_tokens, t.cached_tokens, t.output_tokens,
         t.reasoning_tokens, t.cost_usd, t.steps,
         coalesce(nx.id, pv.id),
         case when nx.id is not null then 'to_order' when pv.id is not null then 'after_order' else 'no_order' end
    from t
    left join lateral (select o.id from everwake.orders o
                        where o.tenant_id = t.tenant_id and o.wa_id = t.wa_id and t.kind <> 'test'
                          and o.status <> 'draft' and o.placed_at >= t.at and o.placed_at < t.at + interval '12 hours'
                        order by o.placed_at limit 1) nx on true
    left join lateral (select o.id from everwake.orders o
                        where nx.id is null and o.tenant_id = t.tenant_id and o.wa_id = t.wa_id and t.kind <> 'test'
                          and o.status <> 'draft' and o.placed_at < t.at and o.placed_at > t.at - interval '24 hours'
                        order by o.placed_at desc limit 1) pv on true
$$;

-- the developer's overview: totals, per restaurant, per step and kind, per day, and per order
create or replace function everwake.dev_costs(p_from timestamptz, p_to timestamptz, p_tenant uuid default null)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare v jsonb; fx numeric;
begin
  perform everwake.require_platform_admin();
  fx := coalesce((everwake.ai_settings(null) ->> 'usd_egp')::numeric, 50);
  with turns as (select * from everwake.ai_turns(p_from - interval '24 hours', p_to + interval '12 hours', p_tenant)
                  where at >= p_from and at < p_to),
  calls as (select * from everwake.ai_usage u where u.created_at >= p_from and u.created_at < p_to and (p_tenant is null or u.tenant_id = p_tenant)),
  per_order as (
    select t.order_id, t.tenant_id, count(*) as messages, sum(t.cost_usd) as cost_usd,
           sum(t.cost_usd) filter (where t.part = 'to_order') as to_order_usd,
           sum(t.cost_usd) filter (where t.part = 'after_order') as after_usd,
           sum(t.cached_tokens) as cached, sum(t.input_tokens) as input
      from turns t where t.order_id is not null group by 1, 2
  )
  select jsonb_build_object(
    'usd_egp', fx,
    'totals', (select jsonb_build_object('calls', count(*), 'cost_usd', coalesce(sum(cost_usd), 0),
                       'input', coalesce(sum(input_tokens), 0), 'cached', coalesce(sum(cached_tokens), 0),
                       'output', coalesce(sum(output_tokens), 0), 'thinking', coalesce(sum(reasoning_tokens), 0),
                       'unpriced', count(*) filter (where not priced),
                       'cache_hit_calls', count(*) filter (where cached_tokens > 0))
                 from calls),
    'messages', (select count(*) from turns),
    'orders', (select count(*) from per_order),
    'per_order', (select jsonb_build_object('avg_usd', avg(cost_usd), 'min_usd', min(cost_usd), 'max_usd', max(cost_usd),
                                            'avg_messages', avg(messages)) from per_order),
    'no_order_usd', (select coalesce(sum(cost_usd), 0) from turns where part = 'no_order' and kind <> 'test'),
    'test_usd', (select coalesce(sum(cost_usd), 0) from turns where kind = 'test'),
    'by_step', coalesce((select jsonb_agg(jsonb_build_object('step', step, 'calls', n, 'cost_usd', c, 'input', i, 'cached', ca, 'output', o, 'thinking', r) order by c desc)
                           from (select step, count(*) n, sum(coalesce(cost_usd, 0)) c, sum(input_tokens) i, sum(cached_tokens) ca,
                                        sum(output_tokens) o, sum(reasoning_tokens) r from calls group by 1) x), '[]'::jsonb),
    'by_kind', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'messages', n, 'cost_usd', c) order by c desc)
                           from (select kind, count(*) n, sum(cost_usd) c from turns group by 1) x), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'cost_usd', c, 'messages', n) order by d)
                          from (select (at at time zone 'Africa/Cairo')::date d, sum(cost_usd) c, count(*) n from turns group by 1) x), '[]'::jsonb),
    'by_tenant', coalesce((select jsonb_agg(jsonb_build_object(
                             'tenant_id', tn.id, 'name', coalesce(tn.name_en, tn.name_ar), 'slug', tn.slug,
                             'messages', coalesce(m.n, 0), 'cost_usd', coalesce(m.c, 0), 'orders', coalesce(po.n, 0),
                             'avg_order_usd', po.a, 'min_order_usd', po.mi, 'max_order_usd', po.ma,
                             'cache_share', case when coalesce(m.i, 0) > 0 then round(m.ca::numeric / m.i, 3) end) order by coalesce(m.c, 0) desc)
                            from everwake.tenants tn
                            left join (select tenant_id, count(*) n, sum(cost_usd) c, sum(input_tokens) i, sum(cached_tokens) ca
                                         from turns group by 1) m on m.tenant_id = tn.id
                            left join (select tenant_id, count(*) n, avg(cost_usd) a, min(cost_usd) mi, max(cost_usd) ma
                                         from per_order group by 1) po on po.tenant_id = tn.id
                           where (p_tenant is null or tn.id = p_tenant) and (m.n is not null or po.n is not null)), '[]'::jsonb),
    'orders_list', coalesce((select jsonb_agg(jsonb_build_object(
                               'order_id', o.id, 'order_no', o.order_no, 'tenant', coalesce(tn.name_en, tn.name_ar), 'slug', tn.slug,
                               'placed_at', o.placed_at, 'total', o.total, 'messages', po.messages, 'cost_usd', po.cost_usd,
                               'to_order_usd', po.to_order_usd, 'after_usd', po.after_usd,
                               'cache_share', case when po.input > 0 then round(po.cached::numeric / po.input, 3) end,
                               'conversation_id', o.conversation_id) order by o.placed_at desc)
                              from (select * from per_order order by order_id desc limit 300) po
                              join everwake.orders o on o.id = po.order_id
                              join everwake.tenants tn on tn.id = o.tenant_id), '[]'::jsonb))
  into v;
  return v;
end $$;

-- the per-message log: each turn with its calls
create or replace function everwake.dev_messages(p_from timestamptz, p_to timestamptz, p_tenant uuid default null, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
            'run_id', t.run_id, 'at', t.at, 'tenant', coalesce(tn.name_en, tn.name_ar), 'slug', tn.slug,
            'customer', coalesce(c.full_name, c.display_name), 'kind', t.kind, 'calls', t.calls,
            'input', t.input_tokens, 'cached', t.cached_tokens, 'output', t.output_tokens, 'thinking', t.reasoning_tokens,
            'cost_usd', t.cost_usd, 'part', t.part, 'order_no', o.order_no, 'steps', t.steps,
            'message', (select left(m.body, 160) from everwake.messages m where m.tenant_id = t.tenant_id and m.run_id = t.run_id
                         and m.direction = 'inbound' order by m.id limit 1)) order by t.at desc)
     from (select * from everwake.ai_turns(p_from, p_to + interval '12 hours', p_tenant) where at < p_to
            order by at desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) t
     left join everwake.tenants tn on tn.id = t.tenant_id
     left join everwake.customers c on c.tenant_id = t.tenant_id and c.wa_id = t.wa_id
     left join everwake.orders o on o.id = t.order_id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- Everwake's percent per restaurant, and the statement
-- ---------------------------------------------------------------------
create table if not exists everwake.tenant_billing (
  tenant_id            uuid primary key references everwake.tenants(id) on delete cascade,
  fee_percent          numeric(6, 3) not null default 2 check (fee_percent >= 0 and fee_percent <= 100),
  include_delivery_fee boolean not null default false,   -- WhatsApp orders: the delivery fee counts
  include_vat          boolean not null default false,   -- WhatsApp orders: VAT counts (for restaurants that charge it)
  starts_on            date,                             -- orders before it are not billed
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);
alter table everwake.tenant_billing enable row level security;
drop policy if exists member_read on everwake.tenant_billing;
create policy member_read on everwake.tenant_billing for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]) or (select everwake.is_platform_admin()));
drop policy if exists admin_write on everwake.tenant_billing;
create policy admin_write on everwake.tenant_billing for all to authenticated
  using ((select everwake.is_platform_admin())) with check ((select everwake.is_platform_admin()));
grant select, insert, update, delete on everwake.tenant_billing to authenticated;
grant all on everwake.tenant_billing to service_role;

create or replace function everwake.bill_rule(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = everwake, pg_temp as $$
  select jsonb_build_object('fee_percent', coalesce(b.fee_percent, 2), 'include_delivery_fee', coalesce(b.include_delivery_fee, false),
                            'include_vat', coalesce(b.include_vat, false), 'starts_on', b.starts_on)
    from (select 1) x left join everwake.tenant_billing b on b.tenant_id = p_tenant
$$;

-- every order that came through Everwake in the period: WhatsApp (on the food after discounts,
-- plus the delivery fee and VAT when ticked) and QR (on the total the customer saw); not the
-- orders the team typed in, not the cancelled or rejected ones
create or replace function everwake.bill_statement(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare r jsonb; v jsonb;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  r := everwake.bill_rule(p_tenant);
  with o as (
    select o.*, (o.source = 'qr') as is_qr,
           case when o.source = 'qr' then o.total
                else greatest(o.subtotal - coalesce(o.discount_total, 0), 0)
                     + case when (r ->> 'include_delivery_fee')::boolean then coalesce(o.delivery_fee, 0) else 0 end
                     + case when (r ->> 'include_vat')::boolean then coalesce(o.vat, 0) else 0 end end as base
      from everwake.orders o
     where o.tenant_id = p_tenant and o.placed_at >= p_from and o.placed_at < p_to
       and o.status not in ('draft', 'rejected', 'cancelled')
       and (o.source = 'qr' or o.source like 'whatsapp%')
       and (r ->> 'starts_on' is null or o.placed_at >= (r ->> 'starts_on')::date)
  ), rows as (
    select o.id, o.order_no, o.placed_at, o.is_qr, o.total, o.base,
           round(o.base * (r ->> 'fee_percent')::numeric / 100, 2) as fee,
           coalesce(nullif(o.customer ->> 'full_name', ''), c.full_name, c.display_name) as name,
           coalesce(nullif(o.customer ->> 'phone', ''), case when c.phone_hidden then null else c.phone end) as phone,
           case when o.delivery_method = 'delivery' then coalesce(o.address_text,
                  nullif(concat_ws('، ', o.address ->> 'area', o.address ->> 'street',
                           nullif('عمارة ' || (o.address ->> 'building'), 'عمارة '), nullif('الدور ' || (o.address ->> 'floor'), 'الدور '),
                           nullif('شقة ' || (o.address ->> 'apartment'), 'شقة ')), ''))
                when o.delivery_method = 'dine_in' then 'في الفرع' else 'استلام من الفرع' end as address,
           (select string_agg(oi.name || ' ×' || trim(to_char(oi.quantity, 'FM999999990.###')) || case when oi.is_gift then ' (هدية)' else '' end, '، ' order by oi.line_no)
              from everwake.order_items oi where oi.order_id = o.id) as items,
           b.name_ar as branch
      from o
      left join everwake.customers c on c.id = o.customer_id
      left join everwake.branches b on b.id = o.branch_id
  )
  select jsonb_build_object(
    'rule', r,
    'totals', (select jsonb_build_object('orders', count(*), 'sales', coalesce(sum(total), 0), 'base', coalesce(sum(base), 0),
                                         'fee', coalesce(sum(fee), 0), 'net', coalesce(sum(total - fee), 0),
                                         'whatsapp_orders', count(*) filter (where not is_qr), 'qr_orders', count(*) filter (where is_qr))
                 from rows),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'order_no', order_no, 'placed_at', placed_at, 'channel', case when is_qr then 'qr' else 'whatsapp' end,
               'name', name, 'phone', phone, 'address', address, 'items', items, 'branch', branch,
               'total', total, 'base', base, 'fee', fee, 'net', total - fee) order by placed_at) from rows), '[]'::jsonb))
  into v;
  return v;
end $$;

-- the developer sets a restaurant's percent and what it applies to
create or replace function everwake.save_bill_rule(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_platform_admin();
  insert into everwake.tenant_billing (tenant_id, fee_percent, include_delivery_fee, include_vat, starts_on, updated_at, updated_by)
  values (p_tenant, coalesce((p ->> 'fee_percent')::numeric, 2), coalesce((p ->> 'include_delivery_fee')::boolean, false),
          coalesce((p ->> 'include_vat')::boolean, false), nullif(p ->> 'starts_on', '')::date, now(), everwake.current_user_id())
  on conflict (tenant_id) do update
    set fee_percent = excluded.fee_percent, include_delivery_fee = excluded.include_delivery_fee,
        include_vat = excluded.include_vat, starts_on = excluded.starts_on, updated_at = now(), updated_by = excluded.updated_by;
  return everwake.bill_rule(p_tenant);
end $$;

-- the developer's list of every restaurant with its billing rule and AI settings
create or replace function everwake.dev_tenants()
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'slug', t.slug, 'name', coalesce(t.name_en, t.name_ar), 'name_ar', t.name_ar, 'status', t.status,
      'bill', everwake.bill_rule(t.id), 'ai', everwake.ai_settings(t.id),
      'ai_own', (select to_jsonb(c) - 'scope' - 'updated_at' - 'updated_by' - 'usd_egp' from everwake.ai_config c where c.scope = t.id::text))
      order by coalesce(t.name_en, t.name_ar)) from everwake.tenants t), '[]'::jsonb);
end $$;

revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;
grant execute on function everwake.is_platform_admin(), everwake.require_platform_admin(), everwake.ai_settings(uuid),
  everwake.dev_costs(timestamptz, timestamptz, uuid), everwake.dev_messages(timestamptz, timestamptz, uuid, int),
  everwake.bill_rule(uuid), everwake.bill_statement(uuid, timestamptz, timestamptz), everwake.save_bill_rule(uuid, jsonb),
  everwake.dev_tenants()
  to authenticated;
revoke execute on function everwake.ai_turns(timestamptz, timestamptz, uuid) from authenticated;
