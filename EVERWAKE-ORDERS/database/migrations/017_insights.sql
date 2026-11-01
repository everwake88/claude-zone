-- =====================================================================
-- Everwake Orders · 017 · Insights
-- What the analytics, branches and menu pages show beyond the totals:
-- the busiest times, how fast the kitchen is, the path from a chat to an
-- order, the regulars, the dishes selling more or less; each branch live
-- today; each dish's sales. And the indexes these numbers need as the
-- history grows. Safe to run again.
-- =====================================================================

-- the reports read orders, messages, customers and chats by restaurant and time
create index if not exists orders_placed_idx on everwake.orders (tenant_id, placed_at) where status <> 'draft';
create index if not exists orders_branch_placed_idx on everwake.orders (branch_id, placed_at) where status <> 'draft';
create index if not exists messages_inbound_idx on everwake.messages (tenant_id, created_at) where direction = 'inbound';
create index if not exists customers_first_seen_idx on everwake.customers (tenant_id, first_seen_at);
create index if not exists conversations_attention_idx on everwake.conversations (tenant_id, attention_at) where attention_at is not null;

-- ---------------------------------------------------------------------
-- The report for a period. Everything it gave before is still here.
-- Minutes are medians (one forgotten order does not move them); a step
-- that took more than six hours is left out as a mistake, not a speed.
-- ---------------------------------------------------------------------
create or replace function everwake.analytics(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  t      everwake.tenants%rowtype;
  s      jsonb;
  v      jsonb;
  v_comm numeric;
  v_prev timestamptz := p_from - (p_to - p_from);   -- the period before, as long as this one
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
  ),
  -- each order, and whether its customer had ordered before it
  seen as (
    select g.*, exists (select 1 from everwake.orders x where x.customer_id = g.customer_id and x.status <> 'draft'
                          and x.placed_at < g.placed_at and x.status not in ('rejected', 'cancelled')) as came_back
      from good g
  ),
  -- how long each step took, in minutes
  times as (
    select (placed_at at time zone t.timezone)::date as d,
           case when accepted_at >= placed_at and accepted_at - placed_at < interval '6 hours'
                then extract(epoch from accepted_at - placed_at) / 60 end as accept_m,
           case when ready_at >= coalesce(accepted_at, placed_at) and ready_at - coalesce(accepted_at, placed_at) < interval '6 hours'
                then extract(epoch from ready_at - coalesce(accepted_at, placed_at)) / 60 end as cook_m,
           case when delivery_method = 'delivery' and completed_at >= out_for_delivery_at and completed_at - out_for_delivery_at < interval '6 hours'
                then extract(epoch from completed_at - out_for_delivery_at) / 60 end as deliver_m
      from good
  ),
  cur_items as (
    select oi.name, sum(oi.quantity) as q, sum(oi.line_total) as r
      from everwake.order_items oi join good g on g.id = oi.order_id
     where not oi.is_gift group by oi.name
  ),
  prev_items as (
    select oi.name, sum(oi.quantity) as q
      from everwake.order_items oi
      join everwake.orders g on g.id = oi.order_id
     where g.tenant_id = p_tenant and g.placed_at >= v_prev and g.placed_at < p_from
       and g.status not in ('draft', 'rejected', 'cancelled') and not oi.is_gift
     group by oi.name
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
    'returning_orders', (select count(*) from seen where came_back),
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
    'by_payment', coalesce((select jsonb_agg(jsonb_build_object('method', k, 'orders', n, 'revenue', r) order by n desc)
                              from (select coalesce(nullif(payment_method, ''), 'unknown') as k, count(*) as n, sum(total) as r
                                      from good group by 1) x), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'orders', n) order by h)
                           from (select extract(hour from placed_at at time zone t.timezone)::int as h, count(*) as n
                                   from good group by 1) x), '[]'::jsonb),
    -- the week drawn by day and hour (0 = Sunday), for the busiest times
    'by_weekday_hour', coalesce((select jsonb_agg(jsonb_build_object('dow', dw, 'hour', h, 'orders', n) order by dw, h)
                                   from (select extract(dow from placed_at at time zone t.timezone)::int as dw,
                                                extract(hour from placed_at at time zone t.timezone)::int as h, count(*) as n
                                           from good group by 1, 2) x), '[]'::jsonb),
    'by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch_id', x.branch_id, 'branch', coalesce(b.name_ar, '—'), 'branch_en', b.name_en,
                                                               'orders', x.n, 'revenue', x.r, 'avg_order', round(x.r / nullif(x.n, 0), 2)) order by x.r desc)
                             from (select branch_id, count(*) as n, sum(total) as r from good group by 1) x
                             left join everwake.branches b on b.id = x.branch_id), '[]'::jsonb),
    'by_zone', coalesce((select jsonb_agg(jsonb_build_object('zone', z.name_ar, 'zone_en', z.name_en, 'orders', x.n, 'revenue', x.r) order by x.n desc)
                           from (select zone_id, count(*) as n, sum(total) as r from good
                                  where delivery_method = 'delivery' and zone_id is not null
                                  group by 1 order by count(*) desc limit 8) x
                           join everwake.delivery_zones z on z.id = x.zone_id), '[]'::jsonb),
    'top_items', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'quantity', c.q, 'revenue', c.r, 'prev_quantity', coalesce(p.q, 0))
                                            order by c.r desc nulls last)
                             from (select * from cur_items order by r desc nulls last limit 10) c
                             left join prev_items p on p.name = c.name), '[]'::jsonb),
    -- dishes that sold clearly less than in the period before
    'falling', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', q, 'prev_quantity', pq) order by pq - q desc)
                           from (select p.name, coalesce(c.q, 0) as q, p.q as pq
                                   from prev_items p left join cur_items c on c.name = p.name
                                  where p.q >= 2 and coalesce(c.q, 0) < p.q
                                  order by p.q - coalesce(c.q, 0) desc limit 5) x), '[]'::jsonb),
    'speed', (select jsonb_build_object(
                'accept_min', round((percentile_cont(0.5) within group (order by accept_m))::numeric, 1),
                'cook_min', round((percentile_cont(0.5) within group (order by cook_m))::numeric, 1),
                'deliver_min', round((percentile_cont(0.5) within group (order by deliver_m))::numeric, 1),
                'timed', count(cook_m))
                from times),
    'speed_by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'cook_min', m) order by d)
                                from (select d, round((percentile_cont(0.5) within group (order by cook_m))::numeric, 1) as m
                                        from times where cook_m is not null group by d) x), '[]'::jsonb),
    -- people, from writing to receiving (QR orders never came from a chat): the steps only narrow
    'funnel', (select jsonb_build_object('wrote', greatest(w, c), 'cart', c, 'ordered', od, 'received', rc)
                 from (select (select n from conv) as w,
                              greatest((select count(distinct wa_id) from everwake.orders
                                         where tenant_id = p_tenant and created_at >= p_from and created_at < p_to
                                           and source is distinct from 'qr'),
                                       (select count(distinct wa_id) from good where source is distinct from 'qr')) as c,
                              (select count(distinct wa_id) from good where source is distinct from 'qr') as od,
                              (select count(distinct wa_id) from good where source is distinct from 'qr'
                                 and status in ('delivered', 'picked_up')) as rc) f),
    'customers_by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'new', nw, 'returning', rt) order by d)
                                    from (select (placed_at at time zone t.timezone)::date as d,
                                                 count(*) filter (where not came_back) as nw, count(*) filter (where came_back) as rt
                                            from seen group by 1) x), '[]'::jsonb),
    'top_customers', coalesce((select jsonb_agg(jsonb_build_object('customer_id', c.id,
                                       'name', coalesce(nullif(btrim(c.full_name), ''), nullif(btrim(c.display_name), '')),
                                       'phone', case when c.phone_hidden then null else c.phone end,
                                       'orders', x.n, 'spent', x.r) order by x.r desc)
                                 from (select customer_id, count(*) as n, sum(total) as r from good
                                        where customer_id is not null group by 1 order by sum(total) desc limit 5) x
                                 join everwake.customers c on c.id = x.customer_id), '[]'::jsonb),
    'cancel_reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', k, 'orders', n) order by n desc)
                                  from (select coalesce(nullif(btrim(reject_reason), ''), '') as k, count(*) as n
                                          from o where status in ('rejected', 'cancelled')
                                         group by 1 order by count(*) desc limit 5) x), '[]'::jsonb),
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

-- ---------------------------------------------------------------------
-- Every branch right now, in one call: open or not, today's orders, what
-- is in the kitchen, how fast it cooks, and its last two weeks. For the
-- whole team; the money only for owners and managers.
-- ---------------------------------------------------------------------
create or replace function everwake.branch_board(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  t       everwake.tenants%rowtype;
  v_money boolean;
  v_day   date;
  v_today timestamptz;
  v       jsonb;
begin
  v_money := everwake.require_role(p_tenant, array['owner', 'manager', 'staff']) in ('owner', 'manager', 'system');
  select * into t from everwake.tenants where id = p_tenant;
  v_day := (now() at time zone t.timezone)::date;
  v_today := v_day::timestamp at time zone t.timezone;

  select coalesce(jsonb_agg(x.row order by x.sort, x.name), '[]'::jsonb) into v
    from (
      select b.sort, b.name_ar as name, jsonb_build_object(
        'id', b.id,
        'state', everwake.branch_state(b.id),
        'busy_until', b.busy_until,
        'today', (select jsonb_build_object('orders', count(*),
                                            'revenue', case when v_money then coalesce(sum(total), 0) end,
                                            'avg', case when v_money then round(avg(total), 2) end)
                    from everwake.orders o
                   where o.branch_id = b.id and o.placed_at >= v_today and o.status not in ('draft', 'rejected', 'cancelled')),
        'live', (select jsonb_build_object('waiting', count(*) filter (where status = 'placed'),
                                           'cooking', count(*) filter (where status in ('accepted', 'preparing')),
                                           'ready', count(*) filter (where status = 'ready'),
                                           'out', count(*) filter (where status = 'out_for_delivery'))
                   from everwake.orders o
                  where o.branch_id = b.id and o.placed_at >= now() - interval '1 day'
                    and o.status in ('placed', 'accepted', 'preparing', 'ready', 'out_for_delivery')),
        'cook_min', (select round((percentile_cont(0.5) within group (order by extract(epoch from o.ready_at - coalesce(o.accepted_at, o.placed_at)) / 60))::numeric, 1)
                       from everwake.orders o
                      where o.branch_id = b.id and o.placed_at >= now() - interval '7 days' and o.ready_at is not null
                        and o.ready_at >= coalesce(o.accepted_at, o.placed_at)
                        and o.ready_at - coalesce(o.accepted_at, o.placed_at) < interval '6 hours'),
        'last_order_at', (select max(o.placed_at) from everwake.orders o where o.branch_id = b.id and o.status <> 'draft'),
        'days14', (select jsonb_agg(coalesce(n.c, 0) order by g.d)
                     from generate_series(v_day - 13, v_day, interval '1 day') g(d)
                     left join (select (o.placed_at at time zone t.timezone)::date as d, count(*) as c
                                  from everwake.orders o
                                 where o.branch_id = b.id and o.placed_at >= v_today - interval '13 days'
                                   and o.status not in ('draft', 'rejected', 'cancelled')
                                 group by 1) n on n.d = g.d::date)
      ) as row
      from everwake.branches b
     where b.tenant_id = p_tenant
    ) x;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Each dish's sales: the last p_days and the p_days before, its last eight
-- weeks (oldest first), and when it was last ordered (within that time).
-- Keyed by the dish's id. Owners and managers.
-- ---------------------------------------------------------------------
create or replace function everwake.menu_insights(p_tenant uuid, p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from timestamptz;
  v_prev timestamptz;
  v      jsonb;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  v_from := now() - make_interval(days => v_days);
  v_prev := now() - make_interval(days => v_days * 2);

  -- a line names its dish by id, or (QR orders, older lines) only by its code, unique in the restaurant
  with lines as (
    select coalesce(oi.item_id, mi.id) as item_id, oi.quantity, oi.line_total, o.id as order_id, o.placed_at
      from everwake.order_items oi
      join everwake.orders o on o.id = oi.order_id
      left join everwake.menu_items mi on oi.item_id is null and mi.tenant_id = p_tenant and mi.code = oi.item_code
     where oi.tenant_id = p_tenant and o.tenant_id = p_tenant and coalesce(oi.item_id, mi.id) is not null and not oi.is_gift
       and o.status not in ('draft', 'rejected', 'cancelled')
       and o.placed_at >= least(v_prev, now() - interval '56 days')
  ), weekly as (
    select item_id, floor(extract(epoch from now() - placed_at) / 604800)::int as w, sum(quantity) as q
      from lines where placed_at >= now() - interval '56 days' group by 1, 2
  ), per as (
    select item_id,
           coalesce(sum(quantity) filter (where placed_at >= v_from), 0) as sold,
           coalesce(sum(quantity) filter (where placed_at >= v_prev and placed_at < v_from), 0) as prev_sold,
           coalesce(sum(line_total) filter (where placed_at >= v_from), 0) as revenue,
           count(distinct order_id) filter (where placed_at >= v_from) as orders,
           max(placed_at) as last_at
      from lines group by item_id
  )
  select coalesce(jsonb_object_agg(p.item_id, jsonb_build_object(
           'sold', p.sold, 'prev_sold', p.prev_sold, 'revenue', p.revenue, 'orders', p.orders, 'last_at', p.last_at,
           'weeks', (select jsonb_agg(coalesce(w.q, 0) order by g.i desc)
                       from generate_series(0, 7) g(i) left join weekly w on w.item_id = p.item_id and w.w = g.i))), '{}'::jsonb)
    into v
    from per p;
  return jsonb_build_object('days', v_days, 'items', v);
end $$;

revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;
grant execute on function everwake.analytics(uuid, timestamptz, timestamptz), everwake.branch_board(uuid),
  everwake.menu_insights(uuid, int) to authenticated;
