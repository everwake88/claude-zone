-- =====================================================================
-- Everwake Orders · patch 2026-11-06 · cheaper turns
-- - both AI steps think at low by default (the global setting moves from
--   medium to low only if it is still medium; a value set on the developer
--   page stays)
-- - wait_seconds: how long the agent waits for more messages before it
--   replies (5 s by default, 2–10 s per restaurant)
-- - each AI call records the effort it ran at; the developer page splits
--   the cost by it
-- Run after 2026-11-05_direct_ai_usage.sql. Safe to run again.
-- =====================================================================

alter table everwake.ai_config add column if not exists wait_seconds int check (wait_seconds between 2 and 10);
-- 2026-11-06: both steps think at low, and the reply waits 5 s for more messages (a value set on the developer page stays)
update everwake.ai_config set brain_effort = 'low' where scope = 'global' and brain_effort = 'medium';
update everwake.ai_config set wait_seconds = 5 where scope = 'global' and wait_seconds is null;


-- one restaurant's settings: its own over the global ones
create or replace function everwake.ai_settings(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = everwake, pg_temp as $$
  select jsonb_build_object(
    'brain_model', coalesce(t.brain_model, g.brain_model), 'brain_effort', coalesce(t.brain_effort, g.brain_effort, 'low'),
    'agent_model', coalesce(t.agent_model, g.agent_model), 'agent_effort', coalesce(t.agent_effort, g.agent_effort, 'low'),
    'details_by_code', coalesce(t.details_by_code, g.details_by_code, false),
    'react_no_reply', coalesce(t.react_no_reply, g.react_no_reply, false),
    'usd_egp', coalesce(g.usd_egp, 50),
    'wait_seconds', least(10, greatest(2, coalesce(t.wait_seconds, g.wait_seconds, 5))))
    from (select 1) x
    left join everwake.ai_config g on g.scope = 'global'
    left join everwake.ai_config t on t.scope = p_tenant::text
$$;


alter table everwake.ai_usage add column if not exists effort text;

-- the engine's own record of its calls to OpenAI: n8n calls OpenAI itself and
-- hands each call's usage here, exactly as OpenAI reported it. Only the engine
-- (the database owner) may call it; no dashboard role can.
create or replace function everwake.record_ai_usage(p_tenant uuid, p_message_id bigint, p_run_id text, p_kind text, p_calls jsonb)
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
declare n int;
begin
  if p_tenant is null or jsonb_typeof(p_calls) is distinct from 'array' then return 0; end if;
  insert into everwake.ai_usage (tenant_id, run_id, message_id, step, kind, model, effort, endpoint, input_tokens, cached_tokens,
                                 output_tokens, reasoning_tokens, audio_seconds, http_status, duration_ms)
  select p_tenant, left(p_run_id, 120), p_message_id,
         case when c->>'step' in ('brain', 'agent', 'transcribe', 'vision') then c->>'step' else 'other' end,
         case when p_kind in ('text', 'voice', 'image', 'test') then p_kind else 'text' end,
         left(c->>'model', 80),
         case when c->>'effort' in ('minimal', 'low', 'medium', 'high') then c->>'effort' end,
         left(c->>'endpoint', 40),
         greatest(coalesce((c->>'input')::numeric, 0), 0)::int, greatest(coalesce((c->>'cached')::numeric, 0), 0)::int,
         greatest(coalesce((c->>'output')::numeric, 0), 0)::int, greatest(coalesce((c->>'thinking')::numeric, 0), 0)::int,
         nullif(c->>'seconds', '')::numeric, nullif(c->>'status', '')::numeric::int, nullif(c->>'ms', '')::numeric::int
    from jsonb_array_elements(p_calls) c
   where jsonb_typeof(c) = 'object' and (c ? 'input' or c ? 'output' or c ? 'seconds' or c ? 'status');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function everwake.record_ai_usage(uuid, bigint, text, text, jsonb) from public, anon, authenticated;


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
grant execute on function everwake.dev_costs(timestamptz, timestamptz, uuid) to authenticated;
grant execute on function everwake.record_ai_usage(uuid, bigint, text, text, jsonb) to service_role;
