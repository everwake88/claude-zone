-- Growth and reports: the commission saved, which link brought which customers,
-- the sales being missed, and the daily report on the owner's WhatsApp.

-- some activity: a customer from the bag-card link who orders, one outside the zones,
-- an abandoned cart, a cancelled order
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare
  t   uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  base jsonb := jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token');
  item jsonb := jsonb_build_object('line_id', 'L1', 'code', 'M003', 'item_name', 'فرخة مشوية', 'unit', 'portion',
                                   'quantity', 1, 'unit_price', 480, 'line_total', 480);
  r jsonb;
begin
  -- 1. from the card in the Talabat bag, orders
  r := everwake.intake(base || jsonb_build_object('external_id', 'g1', 'wa_id', '201777000001', 'phone', '201777000001', 'push_name', 'Hany',
                                                  'text', 'أهلاً 👋 عايز أطلب من فرع الزمالك — عرفتكم من الكارت اللي في الكيس'));
  r := everwake.persist_cart(jsonb_build_object('tenant_id', t, 'wa_id', '201777000001', 'branch_id', zam,
         'cart', jsonb_build_object('items', jsonb_build_array(item)), 'totals', jsonb_build_object('subtotal', 480, 'total', 500)));
  r := everwake.place_order(jsonb_build_object('tenant_id', t, 'wa_id', '201777000001', 'branch_id', zam,
         'customer', jsonb_build_object('full_name', 'هاني', 'delivery_method', 'pickup', 'payment_method', 'cash'),
         'totals', jsonb_build_object('subtotal', 480, 'total', 500)));
  assert (r ->> 'ok')::boolean, r::text;

  -- 2. a pin far outside every zone, no order
  r := everwake.intake(base || jsonb_build_object('external_id', 'g2', 'wa_id', '201777000002', 'phone', '201777000002', 'push_name', 'Rana',
                                                  'text', 'عايزة أطلب — عرفتكم من انستجرام'));
  r := everwake.save_pin(jsonb_build_object('tenant_id', t, 'wa_id', '201777000002', 'lat', 30.1300, 'lng', 31.6200,
                                            'geo', jsonb_build_object('district', 'العبور', 'city', 'القليوبية')));
  assert not (r ->> 'in_delivery_area')::boolean, r::text;

  -- 3. a cart left two hours ago
  r := everwake.intake(base || jsonb_build_object('external_id', 'g3', 'wa_id', '201777000003', 'phone', '201777000003', 'push_name', 'Tarek', 'text', 'فرخة'));
  r := everwake.persist_cart(jsonb_build_object('tenant_id', t, 'wa_id', '201777000003', 'branch_id', zam,
         'cart', jsonb_build_object('items', jsonb_build_array(item || jsonb_build_object('display_name', 'فرخة مشوية'))),
         'totals', jsonb_build_object('subtotal', 480, 'total', 547.2)));
  -- (the row's own trigger would stamp now(): step around it)
  set local session_replication_role = replica;
  update everwake.orders set updated_at = now() - interval '2 hours' where tenant_id = t and wa_id = '201777000003' and status = 'draft';
  set local session_replication_role = origin;

  -- 4. an order the branch rejected
  r := everwake.intake(base || jsonb_build_object('external_id', 'g4', 'wa_id', '201777000004', 'phone', '201777000004', 'push_name', 'Aya', 'text', 'فرخة'));
  r := everwake.persist_cart(jsonb_build_object('tenant_id', t, 'wa_id', '201777000004', 'branch_id', zam,
         'cart', jsonb_build_object('items', jsonb_build_array(item)), 'totals', jsonb_build_object('subtotal', 480, 'total', 500)));
  r := everwake.place_order(jsonb_build_object('tenant_id', t, 'wa_id', '201777000004', 'branch_id', zam,
         'customer', jsonb_build_object('full_name', 'آية', 'delivery_method', 'pickup', 'payment_method', 'cash'),
         'totals', jsonb_build_object('subtotal', 480, 'total', 500)));
  perform everwake.set_order_status((r ->> 'order_id')::bigint, 'rejected', 'الفرع زحمة');
end $$;

-- the owner's view
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"owner@nile.example"}', false);
do $$
declare
  t uuid := (select id from everwake.tenants where slug = 'nile_grill');
  r jsonb; l jsonb; txt text;
begin
  r := everwake.savings(t);
  assert (r ->> 'commission_percent')::numeric = 25;
  assert (r ->> 'orders_month')::int >= 1 and (r ->> 'month')::numeric >= 125, r::text;
  assert (r ->> 'all_time')::numeric >= (r ->> 'month')::numeric;

  r := everwake.growth_sources(t, now() - interval '1 day', now() + interval '1 minute',
                               array['الكارت اللي في الكيس', 'انستجرام', 'المحل']);
  assert exists (select 1 from jsonb_array_elements(r) x where x ->> 'source' = 'الكارت اللي في الكيس'
                  and (x ->> 'chats')::int = 1 and (x ->> 'orders')::int = 1 and (x ->> 'revenue')::numeric = 500
                  and (x ->> 'commission_saved')::numeric = 125), r::text;
  assert exists (select 1 from jsonb_array_elements(r) x where x ->> 'source' = 'انستجرام' and (x ->> 'chats')::int = 1 and (x ->> 'orders')::int = 0);
  assert exists (select 1 from jsonb_array_elements(r) x where x ->> 'source' = 'المحل' and (x ->> 'chats')::int = 0);

  l := everwake.lost_sales(t, now() - interval '1 day', now() + interval '1 minute');
  assert (l -> 'abandoned' ->> 'count')::int >= 1 and (l -> 'abandoned' ->> 'value')::numeric >= 547.2, l ->> 'abandoned';
  assert exists (select 1 from jsonb_array_elements(l -> 'abandoned' -> 'carts') c where c ->> 'wa_id' = '201777000003'
                  and c ->> 'items' like 'فرخة مشوية ×1%' and c ->> 'conversation_id' is not null);
  assert exists (select 1 from jsonb_array_elements(l -> 'abandoned' -> 'top_items') c where c ->> 'name' = 'فرخة مشوية');
  assert (l -> 'out_of_area' ->> 'count')::int >= 1, l ->> 'out_of_area';
  assert exists (select 1 from jsonb_array_elements(l -> 'out_of_area' -> 'areas') a where a ->> 'area' = 'العبور');
  assert exists (select 1 from jsonb_array_elements(l -> 'out_of_area' -> 'points') p where (p ->> 'lat')::numeric = 30.13);
  assert (l -> 'refused' ->> 'count')::int >= 1 and exists (select 1 from jsonb_array_elements(l -> 'refused' -> 'reasons') x where x ->> 'reason' = 'الفرع زحمة');
  assert (l ->> 'no_order_chats')::int >= 2, l ->> 'no_order_chats';

  txt := everwake.report_preview(t);
  assert txt like '📊 تقرير مشويات النيل%', txt;
  assert txt like '%🧾 الطلبات: %' and txt like '%💸 وفّرت عمولة: %' and txt like '%🔥 الأكتر طلباً: 1. فرخة مشوية%', txt;
  assert txt like '%• برّه مناطق التوصيل: %' and txt like '%العبور%', txt;
  assert txt like '%🛵 الطيارين: أحمد 1 طلب (كاش 500 ج)%', txt;

  -- no numbers yet: nothing goes out
  assert everwake.send_report_now(t) = 0;
end $$;

-- staff see neither the money nor the report
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
declare t uuid := (select id from everwake.tenants where slug = 'nile_grill');
begin
  begin perform everwake.savings(t); assert false, 'staff cannot see savings';
  exception when insufficient_privilege then null; end;
  begin perform everwake.lost_sales(t, now() - interval '1 day', now()); assert false, 'staff cannot see lost sales';
  exception when insufficient_privilege then null; end;
  begin perform everwake.report_text(t, now() - interval '1 day', now()); assert false, 'report_text is internal';
  exception when insufficient_privilege then null; end;
end $$;

-- the daily report: once a day, at the restaurant's hour, to its numbers
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare t uuid := (select id from everwake.tenants where slug = 'nile_grill'); n int; r jsonb;
begin
  update everwake.tenants set settings = settings || jsonb_build_object('daily_report', jsonb_build_object(
           'enabled', true, 'numbers', jsonb_build_array('0100 111 2222', '01001112222', 'x'),
           'time', to_char((now() at time zone timezone) + interval '1 hour', 'HH24:MI')))
   where id = t;
  -- the hour has not come yet (unless that is past midnight: then it is tomorrow's)
  if ((now() at time zone 'Africa/Cairo') + interval '1 hour')::date = (now() at time zone 'Africa/Cairo')::date then
    assert everwake.send_due_reports() = 0, 'not before its hour';
  end if;
  update everwake.tenants set settings = jsonb_set(settings, '{daily_report,time}', to_jsonb('00:00'::text)) where id = t;
  r := everwake.housekeeping();
  assert (r ->> 'reports_queued')::int = 1, r::text;
  select count(*) into n from everwake.outbox where purpose = 'report' and tenant_id = t;
  assert n = 1, 'one message per distinct valid number: ' || n;
  assert exists (select 1 from everwake.outbox where purpose = 'report' and to_jid = '201001112222' and body like '📊 تقرير%');
  assert everwake.send_due_reports() = 0, 'once a day';
end $$;
