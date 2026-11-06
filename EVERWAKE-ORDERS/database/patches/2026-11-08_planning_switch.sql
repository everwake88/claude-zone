-- =====================================================================
-- Everwake Orders · patch 2026-11-08 · the planning step can be switched off
-- use_brain (null = on): the planning step before the reply, per restaurant
-- or for every restaurant, on the developer page. Off = one AI call per
-- message: the reply step reads everything and decides for itself.
-- Run after 2026-11-07_exact_pricing.sql. Safe to run again.
-- =====================================================================

alter table everwake.ai_config add column if not exists use_brain boolean;

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
    'vision_model', coalesce(t.vision_model, g.vision_model),
    'use_brain', coalesce(t.use_brain, g.use_brain, true))
    from (select 1) x
    left join everwake.ai_config g on g.scope = 'global'
    left join everwake.ai_config t on t.scope = p_tenant::text
$$;


revoke execute on function everwake.ai_settings(uuid) from public, anon, authenticated;
