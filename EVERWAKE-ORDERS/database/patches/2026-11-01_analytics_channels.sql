-- =====================================================================
-- Patch 2026-11-01 · the overview's charts: orders by channel (WhatsApp,
-- QR code, the team) and by service (delivery, pickup, dine-in); "chats
-- that ordered" no longer counts QR orders, which never came from a chat
-- Run once in the Supabase SQL editor (running it again is harmless).
-- New installs have it.
-- =====================================================================
create or replace function everwake.analytics(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  t    everwake.tenants%rowtype;
  s    jsonb;
  v    jsonb;
  v_comm numeric;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  select * into t from everwake.tenants where id = p_tenant;
  s := everwake.merged_settings(t.settings);
  v_comm := coalesce((s ->> 'aggregator_commission_percent')::numeric, 25);

  with o as (
    select * from everwake.orders
     where tenant_id = p_tenant and placed_at >= p_from and placed_at < p_to and status <> 'draft'
  ), good as (select * from o where status not in ('rejected', 'cancelled')),
  conv as (
    select count(distinct m.wa_id) as n
      from everwake.messages m
     where m.tenant_id = p_tenant and m.direction = 'inbound' and m.created_at >= p_from and m.created_at < p_to
  )
  select jsonb_build_object(
    'currency', t.currency,
    'currency_symbol', t.currency_symbol_ar,
    'orders', (select count(*) from good),
    'revenue', (select coalesce(sum(total), 0) from good),
    'average_order', (select coalesce(round(avg(total), 2), 0) from good),
    'cancelled', (select count(*) from o where status in ('rejected', 'cancelled')),
    'discounts', (select coalesce(sum(discount_total), 0) from good),
    'delivery_share', (select coalesce(round(100.0 * count(*) filter (where delivery_method = 'delivery') / nullif(count(*), 0), 1), 0) from good),
    'conversations', (select n from conv),
    -- of the people who wrote, how many ordered (an order from a QR code never came from a chat)
    'conversion_percent', (select case when (select n from conv) = 0 then 0
                                       else round(100.0 * count(distinct wa_id) filter (where source is distinct from 'qr') / (select n from conv), 1) end from good),
    'new_customers', (select count(*) from everwake.customers where tenant_id = p_tenant and first_seen_at >= p_from and first_seen_at < p_to),
    'returning_orders', (select count(*) from good g
                          where exists (select 1 from everwake.orders x where x.customer_id = g.customer_id and x.status <> 'draft'
                                          and x.placed_at < g.placed_at and x.status not in ('rejected', 'cancelled'))),
    'commission_percent', v_comm,
    'commission_saved', (select coalesce(round(sum(total) * v_comm / 100, 2), 0) from good),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'orders', n, 'revenue', r) order by d)
                          from (select (placed_at at time zone t.timezone)::date as d, count(*) as n, sum(total) as r
                                  from good group by 1) x), '[]'::jsonb),
    -- where the orders came from (the WhatsApp agent, a QR code in the branch, the team) and how they were served
    'by_source', coalesce((select jsonb_agg(jsonb_build_object('source', k, 'orders', n, 'revenue', r) order by n desc)
                             from (select case when source = 'qr' then 'qr' when source like 'whatsapp%' then 'whatsapp' else 'team' end as k,
                                          count(*) as n, sum(total) as r
                                     from good group by 1) x), '[]'::jsonb),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', k, 'orders', n) order by n desc)
                             from (select coalesce(delivery_method, 'pickup') as k, count(*) as n from good group by 1) x), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'orders', n) order by h)
                           from (select extract(hour from placed_at at time zone t.timezone)::int as h, count(*) as n
                                   from good group by 1) x), '[]'::jsonb),
    'by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch', coalesce(b.name_ar, '—'), 'orders', x.n, 'revenue', x.r) order by x.r desc)
                             from (select branch_id, count(*) as n, sum(total) as r from good group by 1) x
                             left join everwake.branches b on b.id = x.branch_id), '[]'::jsonb),
    'top_items', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', q, 'revenue', r) order by r desc nulls last)
                             from (select oi.name, sum(oi.quantity) as q, sum(oi.line_total) as r
                                     from everwake.order_items oi join good g on g.id = oi.order_id
                                    where not oi.is_gift
                                    group by oi.name order by sum(oi.line_total) desc nulls last limit 10) x), '[]'::jsonb),
    'agent', (select jsonb_build_object(
                'turns', count(*),
                'avg_reply_seconds', coalesce(round(avg(duration_total_ms) / 1000.0, 1), 0),
                'repairs', count(*) filter (where repair_used),
                'tokens', coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0))
                from everwake.agent_events where tenant_id = p_tenant and created_at >= p_from and created_at < p_to),
    'handoffs', (select count(*) from everwake.conversations
                  where tenant_id = p_tenant and attention_at >= p_from and attention_at < p_to))
  into v;
  return v;
end $$;
