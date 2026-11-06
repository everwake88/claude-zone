-- =====================================================================
-- Everwake Orders · patch 2026-11-07 · exact OpenAI pricing
-- Checked against developers.openai.com/api/docs/pricing on 2026-11-06:
-- - cache writes (GPT-5.6 and later) are billed at their own price (GPT-6
--   Luna $0.125 per 1M for the 30-minute cache): a new price column, the
--   written tokens on each call, and the cost formula counts them
-- - gpt-transcribe is billed by the minute only ($0.0045); priced by the
--   minute whenever the voice note's length is known
-- - gpt-4o-transcribe and gpt-4o-mini-transcribe prices added
-- - vision_model: the model that reads customers' photos, set on the
--   developer page (gpt-5-mini shuts down on Dec 11, 2026)
-- Prices you edited on the developer page are left as they are.
-- Run after 2026-11-06_cheaper_turns.sql. Safe to run again.
-- =====================================================================

alter table everwake.ai_prices add column if not exists cache_write_per_m numeric(12, 4);
-- OpenAI's prices (developers.openai.com/api/docs/pricing, checked 2026-11-06); the developer page edits them
insert into everwake.ai_prices (model, input_per_m, cached_per_m, output_per_m, audio_per_minute, cache_write_per_m) values
  ('gpt-6-luna', 0.10, 0.01, 0.50, null, 0.125),
  ('gpt-5.6-luna', 0.20, 0.02, 1.20, null, 0.25),
  ('gpt-5-mini', 0.25, 0.025, 2.00, null, null),
  ('gpt-transcribe', 0, 0, 0, 0.0045, null),              -- billed by the minute only
  ('gpt-4o-transcribe', 2.50, 0, 10.00, 0.006, null),
  ('gpt-4o-mini-transcribe', 1.25, 0, 5.00, 0.003, null)
on conflict (model) do nothing;
-- 2026-11-07: rows seeded earlier with older numbers, changed only where they still have them
update everwake.ai_prices set input_per_m = 0, cached_per_m = 0, output_per_m = 0, audio_per_minute = 0.0045, updated_at = now()
 where model = 'gpt-transcribe' and input_per_m = 2.50 and output_per_m = 10.00 and audio_per_minute = 0.006;
update everwake.ai_prices set cache_write_per_m = 0.125, updated_at = now() where model = 'gpt-6-luna' and cache_write_per_m is null;
update everwake.ai_prices set cache_write_per_m = 0.25, updated_at = now() where model = 'gpt-5.6-luna' and cache_write_per_m is null;


alter table everwake.ai_config add column if not exists vision_model text;

-- one restaurant's settings: its own over the global ones
create or replace function everwake.ai_settings(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = everwake, pg_temp as $$
  select jsonb_build_object(
    'brain_model', coalesce(t.brain_model, g.brain_model), 'brain_effort', coalesce(t.brain_effort, g.brain_effort, 'low'),
    'agent_model', coalesce(t.agent_model, g.agent_model), 'agent_effort', coalesce(t.agent_effort, g.agent_effort, 'low'),
    'details_by_code', coalesce(t.details_by_code, g.details_by_code, false),
    'react_no_reply', coalesce(t.react_no_reply, g.react_no_reply, false),
    'usd_egp', coalesce(g.usd_egp, 50),
    'wait_seconds', least(10, greatest(2, coalesce(t.wait_seconds, g.wait_seconds, 5))),
    'vision_model', coalesce(t.vision_model, g.vision_model))
    from (select 1) x
    left join everwake.ai_config g on g.scope = 'global'
    left join everwake.ai_config t on t.scope = p_tenant::text
$$;


alter table everwake.ai_usage add column if not exists cache_write_tokens int not null default 0,
  add column if not exists price_cache_write_per_m numeric(12, 4);

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
    -- each input token is billed once: uncached, read from the cache, or written to it.
    -- A model priced by the minute (transcription) is priced by the minute whenever the length is known.
    new.cost_usd := case
      when new.audio_seconds is not null and p.audio_per_minute is not null
        then new.audio_seconds / 60.0 * p.audio_per_minute
      else (greatest(new.input_tokens - new.cached_tokens - new.cache_write_tokens, 0) * p.input_per_m
            + new.cached_tokens * p.cached_per_m
            + new.cache_write_tokens * coalesce(p.cache_write_per_m, p.input_per_m)
            + new.output_tokens * p.output_per_m) / 1000000.0 end;
    new.priced := true;
    new.price_in_per_m := p.input_per_m; new.price_cached_per_m := p.cached_per_m;
    new.price_out_per_m := p.output_per_m; new.price_audio_per_minute := p.audio_per_minute;
    new.price_cache_write_per_m := p.cache_write_per_m;
  end if;
  return new;
end $$;
drop trigger if exists ai_usage_price on everwake.ai_usage;
create trigger ai_usage_price before insert or update of model, input_tokens, cached_tokens, cache_write_tokens, output_tokens, audio_seconds
  on everwake.ai_usage for each row execute function everwake.ai_usage_price();

-- the engine's own record of its calls to OpenAI: n8n calls OpenAI itself and
-- hands each call's usage here, exactly as OpenAI reported it. Only the engine
-- (the database owner) may call it; no dashboard role can.
create or replace function everwake.record_ai_usage(p_tenant uuid, p_message_id bigint, p_run_id text, p_kind text, p_calls jsonb)
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
declare n int;
begin
  if p_tenant is null or jsonb_typeof(p_calls) is distinct from 'array' then return 0; end if;
  insert into everwake.ai_usage (tenant_id, run_id, message_id, step, kind, model, effort, endpoint, input_tokens, cached_tokens, cache_write_tokens,
                                 output_tokens, reasoning_tokens, audio_seconds, http_status, duration_ms)
  select p_tenant, left(p_run_id, 120), p_message_id,
         case when c->>'step' in ('brain', 'agent', 'transcribe', 'vision') then c->>'step' else 'other' end,
         case when p_kind in ('text', 'voice', 'image', 'test') then p_kind else 'text' end,
         left(c->>'model', 80),
         case when c->>'effort' in ('minimal', 'low', 'medium', 'high') then c->>'effort' end,
         left(c->>'endpoint', 40),
         greatest(coalesce((c->>'input')::numeric, 0), 0)::int, greatest(coalesce((c->>'cached')::numeric, 0), 0)::int,
         greatest(coalesce((c->>'written')::numeric, 0), 0)::int,
         greatest(coalesce((c->>'output')::numeric, 0), 0)::int, greatest(coalesce((c->>'thinking')::numeric, 0), 0)::int,
         nullif(c->>'seconds', '')::numeric, nullif(c->>'status', '')::numeric::int, nullif(c->>'ms', '')::numeric::int
    from jsonb_array_elements(p_calls) c
   where jsonb_typeof(c) = 'object' and (c ? 'input' or c ? 'output' or c ? 'seconds' or c ? 'status');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function everwake.record_ai_usage(uuid, bigint, text, text, jsonb) from public, anon, authenticated;


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
           jsonb_agg(jsonb_build_object('step', step, 'model', model, 'in', input_tokens, 'cached', cached_tokens, 'written', cache_write_tokens,
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
                       'written', coalesce(sum(cache_write_tokens), 0),
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
    'by_effort', coalesce((select jsonb_agg(jsonb_build_object('step', step, 'effort', effort, 'calls', n, 'cost_usd', c,
                                                              'avg_usd', c / nullif(n, 0), 'thinking', r) order by step, effort)
                             from (select step, coalesce(effort, '—') effort, count(*) n, sum(coalesce(cost_usd, 0)) c, sum(reasoning_tokens) r
                                     from calls where step in ('brain', 'agent') group by 1, 2) x), '[]'::jsonb),
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

revoke execute on function everwake.ai_settings(uuid) from public, anon, authenticated;
revoke execute on function everwake.ai_turns(timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function everwake.dev_costs(timestamptz, timestamptz, uuid) to authenticated;
grant execute on function everwake.record_ai_usage(uuid, bigint, text, text, jsonb) to service_role;
