-- Everwake Orders · patch 2026-10-24 · "online" only when a payment link can be made
-- The agent offered "أونلاين" while no payment link could be made (the Paymob
-- account was on but did not know the dashboard's address). Now "online" is
-- offered only when both are set. Run once in Supabase → SQL Editor.

create or replace function everwake.payment_methods_at(p_tenant uuid, p_branch uuid default null)
returns jsonb language sql stable as $$
  with t as (
    select array(select jsonb_array_elements_text(coalesce(everwake.merged_settings(x.settings) -> 'payment_methods',
                                                           '["cash"]'::jsonb))) as pm,
           exists (select 1 from everwake.payment_accounts a
                    where a.tenant_id = p_tenant and a.enabled and nullif(btrim(a.dashboard_url), '') is not null) as online
      from everwake.tenants x where x.id = p_tenant
  ), lists as (
    select coalesce(nullif(array(select m from unnest(b.payment_methods) m where m <> 'online' or (select online from t)), '{}'),
                    (select pm from t)) as pm
      from everwake.branches b
     where b.tenant_id = p_tenant and b.is_active and (p_branch is null or b.id = p_branch)
  )
  select to_jsonb(array(
           select k.m from unnest(array['cash', 'card', 'wallet', 'instapay', 'online']) with ordinality k(m, n)
            where k.m = any (coalesce((select array_agg(x) from lists, unnest(lists.pm) x), (select pm from t)))
              and (k.m <> 'online' or (select online from t))
            order by k.n))
$$;

-- every restaurant's agent reads the payment methods from its snapshot
select everwake.rebuild_snapshot(id) from everwake.tenants;
