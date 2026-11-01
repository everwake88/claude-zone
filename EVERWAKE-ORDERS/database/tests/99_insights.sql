-- The insights behind the analytics, branches and menu pages: the new parts of the report,
-- every branch live in one call, each dish's sales, who may see what, and the indexes.

do $$
declare
  t   uuid := (select id from everwake.tenants where slug = 'nile_grill');
  r   jsonb;
  k   text;
  b   jsonb;
  n   int;
begin
  -- a fresh order that went all the way, timed, so speed and the funnel have something to measure
  insert into everwake.orders (tenant_id, order_no, wa_id, branch_id, status, source, total, delivery_method, payment_method,
                               placed_at, accepted_at, ready_at, out_for_delivery_at, completed_at)
  select t, 'INS-1', '201400999001', (select id from everwake.branches where tenant_id = t and code = 'zamalek'), 'delivered',
         'whatsapp_agent', 300, 'delivery', 'cash',
         now() - interval '60 minutes', now() - interval '57 minutes', now() - interval '40 minutes',
         now() - interval '35 minutes', now() - interval '10 minutes';

  r := everwake.analytics(t, now() - interval '1 day', now() + interval '1 day');
  foreach k in array array['by_weekday_hour', 'speed', 'speed_by_day', 'funnel', 'customers_by_day', 'top_customers',
                           'falling', 'by_payment', 'by_zone', 'cancel_reasons'] loop
    assert r ? k, 'the report has ' || k;
  end loop;
  -- what it gave before is all still there
  foreach k in array array['orders', 'revenue', 'by_day', 'by_hour', 'by_branch', 'top_items', 'by_source', 'by_method', 'agent', 'handoffs'] loop
    assert r ? k, 'the report still has ' || k;
  end loop;
  -- this order alone (a window around it): 3 minutes to accept, 17 to cook, 25 on the road
  b := everwake.analytics(t, now() - interval '61 minutes', now() - interval '59 minutes');
  assert (b ->> 'orders')::int = 1, b::text;
  assert (b -> 'speed' ->> 'accept_min')::numeric between 2.9 and 3.1
     and (b -> 'speed' ->> 'cook_min')::numeric between 16.9 and 17.1
     and (b -> 'speed' ->> 'deliver_min')::numeric between 24.9 and 25.1, 'the minutes: ' || (b -> 'speed')::text;
  assert (r -> 'funnel' ->> 'received')::int >= 1, r -> 'funnel';
  assert (r -> 'funnel' ->> 'wrote')::int >= (r -> 'funnel' ->> 'cart')::int
     and (r -> 'funnel' ->> 'cart')::int >= (r -> 'funnel' ->> 'ordered')::int
     and (r -> 'funnel' ->> 'ordered')::int >= (r -> 'funnel' ->> 'received')::int, 'the steps only narrow: ' || (r -> 'funnel')::text;
  assert (select sum((x ->> 'orders')::int) from jsonb_array_elements(r -> 'by_weekday_hour') x) = (r ->> 'orders')::int,
         'every order is in the week grid';
  assert (select sum((x ->> 'new')::int + (x ->> 'returning')::int) from jsonb_array_elements(r -> 'customers_by_day') x) = (r ->> 'orders')::int,
         'every order is new or returning';
  assert exists (select 1 from jsonb_array_elements(r -> 'by_payment') x where x ->> 'method' = 'cash');
  assert r -> 'by_branch' -> 0 ? 'branch_id' and r -> 'by_branch' -> 0 ? 'avg_order';
  assert r -> 'top_items' -> 0 ? 'prev_quantity', 'top dishes carry the period before';

  -- every branch in one call
  b := everwake.branch_board(t);
  select count(*) into n from everwake.branches where tenant_id = t;
  assert jsonb_array_length(b) = n, 'one row per branch';
  select x into r from jsonb_array_elements(b) x where x ->> 'id' = (select id::text from everwake.branches where tenant_id = t and code = 'zamalek');
  assert r ->> 'state' in ('open', 'closed', 'busy', 'not_accepting', 'unknown');
  assert (r -> 'today' ->> 'orders')::int >= 1 and (r -> 'today' ->> 'revenue') is not null, r::text;
  assert jsonb_array_length(r -> 'days14') = 14, 'two weeks, every day present';
  assert (r -> 'days14' ->> 13)::int >= 1, 'today is the last day';
  assert (r ->> 'cook_min')::numeric is not null;

  -- each dish's sales; a line that names its dish only by code (a QR order) still counts for it
  insert into everwake.order_items (tenant_id, order_id, line_no, item_id, item_code, name, quantity, unit_price, line_total)
  select t, id, 1, null, 'M001', 'كفتة مشوية', 2, 240, 480 from everwake.orders where tenant_id = t and order_no = 'INS-1';
  r := everwake.menu_insights(t, 30);
  assert (r -> 'items' -> (select id::text from everwake.menu_items where tenant_id = t and code = 'M001') ->> 'sold')::numeric >= 2,
         'sold by code: ' || (r -> 'items')::text;
  assert (r ->> 'days')::int = 30 and jsonb_typeof(r -> 'items') = 'object';
  select x.value into b from jsonb_each(r -> 'items') x limit 1;
  assert b is null or jsonb_array_length(b -> 'weeks') = 8, 'eight weeks per dish';
  r := everwake.menu_insights(t, 99999);
  assert (r ->> 'days')::int = 365, 'a year at most';

  -- the indexes the reports lean on
  assert exists (select 1 from pg_indexes where schemaname = 'everwake' and indexname = 'orders_placed_idx');
  assert exists (select 1 from pg_indexes where schemaname = 'everwake' and indexname = 'messages_inbound_idx');
end $$;

-- the cashier (staff): the branch board without the money, and no sales reports
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', false);
do $$
declare
  t uuid := (select id from everwake.tenants where slug = 'nile_grill');
  b jsonb;
begin
  b := everwake.branch_board(t);
  assert jsonb_array_length(b) >= 1;
  assert (select bool_and((x -> 'today' -> 'revenue') = 'null'::jsonb) from jsonb_array_elements(b) x), 'staff see no money: ' || b::text;
  assert (select bool_and((x -> 'today' ->> 'orders') is not null) from jsonb_array_elements(b) x), 'but do see the orders';
  begin
    perform everwake.menu_insights(t, 30);
    assert false, 'staff read the sales';
  exception when insufficient_privilege then null;
  end;
  begin
    perform everwake.analytics(t, now() - interval '1 day', now());
    assert false, 'staff read the report';
  exception when insufficient_privilege then null;
  end;
end $$;

-- a stranger: nothing at all
select set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}', false);
do $$
begin
  perform everwake.branch_board((select id from everwake.tenants where slug = 'nile_grill'));
  assert false, 'a stranger read the branch board';
exception when insufficient_privilege then null;
end $$;
reset role;
