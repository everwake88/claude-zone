-- A draft cart, the review fingerprint, placing, the board, and memory of the last order
do $$
declare
  t    uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam  uuid := (select id from everwake.branches where code = 'zamalek');
  base jsonb := jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token');
  wa   text := '201400400400';
  h1 text; h2 text;
  r jsonb; ctx jsonb; o record; n int;
  cart jsonb := jsonb_build_object('items', jsonb_build_array(
    jsonb_build_object('line_id', 'L1', 'item_id', (select id from everwake.menu_items where tenant_id = t and code = 'M003'),
                       'code', 'M003', 'item_name', 'فرخة مشوية', 'display_name', 'فرخة مشوية', 'unit', 'portion',
                       'quantity', 1, 'unit_price', 480, 'line_total', 480,
                       'choices', jsonb_build_array(jsonb_build_object('level', 1, 'selected', jsonb_build_array(jsonb_build_object('name', 'فرخة كاملة'))))),
    jsonb_build_object('line_id', 'L2', 'code', 'M007', 'item_name', 'بطاطس محمرة', 'unit', 'portion', 'quantity', 1,
                       'unit_price', 0, 'line_total', 0, 'gift', true)));
begin
  r := everwake.intake(base || jsonb_build_object('external_id', 'o1', 'wa_id', wa, 'phone', wa, 'push_name', 'Sara', 'text', 'فرخة كاملة'));

  r := everwake.persist_cart(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'branch_id', zam, 'cart', cart,
         'totals', jsonb_build_object('subtotal', 480, 'discount_total', 0, 'vat', 67.2, 'delivery_fee', 20, 'total', 567.2, 'currency', 'EGP'),
         'state_patch', jsonb_build_object('branch', jsonb_build_object('id', zam, 'code', 'zamalek', 'name_ar', 'الزمالك')),
         'ledger_patch', jsonb_build_object('line_seq', 2)));
  assert (r ->> 'order_id') is not null;
  h1 := everwake.review_hash(t, wa);

  -- details change → the summary is outdated
  update everwake.conversations set state = state || jsonb_build_object('customer', jsonb_build_object(
      'full_name', 'سارة أحمد', 'phone_confirmed', 'yes', 'phone', wa, 'delivery_method', 'delivery', 'payment_method', 'cash',
      'address_area', 'الزمالك', 'address_street', 'حسن صبري', 'address_building', '8', 'address_floor', '3', 'address_apartment', '6'))
   where tenant_id = t and wa_id = wa;
  h2 := everwake.review_hash(t, wa);
  assert h1 <> h2, 'details are part of the fingerprint';
  assert everwake.review_hash(t, wa) = h2, 'stable when nothing changes';

  r := everwake.place_order(jsonb_build_object('tenant_id', t, 'wa_id', wa,
         'customer', jsonb_build_object('full_name', 'سارة أحمد', 'phone', wa, 'delivery_method', 'delivery', 'payment_method', 'cash'),
         'address', jsonb_build_object('area', 'الزمالك', 'street', 'حسن صبري', 'building', '8', 'floor', '3', 'apartment', '6'),
         'address_text', 'الشارع: حسن صبري، المنطقة: الزمالك، عمارة 8، الدور 3، شقة 6',
         'location', jsonb_build_object('lat', 30.061, 'lng', 31.22, 'maps_url', 'https://maps.google.com/?q=30.061,31.22'),
         'totals', jsonb_build_object('subtotal', 480, 'discount_total', 0, 'vat', 67.2, 'delivery_fee', 20, 'total', 567.2)));
  assert (r ->> 'ok')::boolean and r ->> 'order_no' = 'NG-1001', r::text;
  select * into o from everwake.orders where tenant_id = t and order_no = 'NG-1001';
  assert o.status = 'placed' and o.total = 567.2 and o.delivery_method = 'delivery';
  select count(*) into n from everwake.order_items where order_id = o.id;
  assert n = 2;
  assert exists (select 1 from everwake.order_items where order_id = o.id and is_gift and item_code = 'M007');
  assert (select orders_count from everwake.customers where id = o.customer_id) = 1;
  assert (select full_name from everwake.customers where id = o.customer_id) = 'سارة أحمد';
  assert (select count(*) from everwake.customer_addresses where customer_id = o.customer_id) = 1;
  assert (select state -> 'ledger' ->> 'review_hash' from everwake.conversations where tenant_id = t and wa_id = wa) is null;
  -- nothing left to place twice
  r := everwake.place_order(jsonb_build_object('tenant_id', t, 'wa_id', wa));
  assert not (r ->> 'ok')::boolean and r ->> 'reason' = 'NO_DRAFT';

  -- the ticket for the branch
  r := everwake.order_ticket(t, 'NG-1001');
  assert r ->> 'ops_whatsapp' = '201000000051', 'the branch number wins over the restaurant one: ' || (r ->> 'ops_whatsapp');

  -- the board: accept → the customer hears it
  r := everwake.set_order_status(o.id, 'accepted', null, true, '45 دقيقة');
  assert (r ->> 'notified')::boolean, r::text;
  assert exists (select 1 from everwake.outbox where tenant_id = t and wa_id = wa and purpose = 'order_status'
                  and body like 'تمام 👨‍🍳 طلبك رقم NG-1001 اتأكد من فرع الزمالك%الوقت المتوقع حوالي 45 دقيقة.');
  r := everwake.set_order_status(o.id, 'out_for_delivery');
  begin
    perform everwake.set_order_status(o.id, 'accepted');
    assert false, 'an order cannot go backwards';
  exception when raise_exception then null;
  end;
  r := everwake.set_order_status(o.id, 'delivered');
  select * into o from everwake.orders where id = o.id;
  assert o.status = 'delivered' and o.completed_at is not null and o.accepted_at is not null;
  assert (select count(*) from everwake.order_events where order_id = o.id) = 4;

  -- next time, the agent remembers the last order and the address
  ctx := everwake.turn_context(t, wa);
  assert ctx -> 'last_orders' -> 0 ->> 'order_no' = 'NG-1001', ctx ->> 'last_orders';
  assert ctx -> 'last_orders' -> 0 -> 'items' -> 0 ->> 'name' = 'فرخة مشوية';
  assert (ctx -> 'customer' ->> 'orders_count')::int = 1;
  assert ctx -> 'saved_addresses' -> 0 ->> 'building' = '8';

  -- a hidden-number customer who types this phone is linked to the same history
  r := everwake.intake(base || jsonb_build_object('external_id', 'o2', 'wa_id', '555000111222333', 'lid', '555000111222333',
                                                  'reply_to', '555000111222333@lid', 'text', 'تاني'));
  r := everwake.persist_details(jsonb_build_object('tenant_id', t, 'wa_id', '555000111222333', 'link_phone', wa,
                                                   'state_patch', jsonb_build_object('customer', jsonb_build_object('phone', wa))));
  ctx := everwake.turn_context(t, '555000111222333');
  assert ctx -> 'last_orders' -> 0 ->> 'order_no' = 'NG-1001', 'found by the number they typed: ' || (ctx ->> 'last_orders');

  -- a typed area picks the zone
  r := everwake.persist_details(jsonb_build_object('tenant_id', t, 'wa_id', '555000111222333', 'area_text', 'المعادي'));
  assert r -> 'state' -> 'zone' ->> 'branch_code' = 'maadi' and r -> 'state' -> 'zone' ->> 'source' = 'area_name', r::text;

  -- a rejected order is not counted as spent
  r := everwake.persist_cart(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'branch_id', zam, 'cart', cart,
         'totals', jsonb_build_object('subtotal', 480, 'total', 500)));
  r := everwake.place_order(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'customer', jsonb_build_object('delivery_method', 'pickup'),
                                               'totals', jsonb_build_object('subtotal', 480, 'total', 500)));
  perform everwake.set_order_status((r ->> 'order_id')::bigint, 'rejected', 'الفرع خلصت منه الفراخ');
  assert (select orders_count from everwake.customers where tenant_id = t and wa_id = wa) = 1;
  assert exists (select 1 from everwake.outbox where tenant_id = t and wa_id = wa and body like '%مقدرناش ننفذ طلبك رقم NG-1002. الفرع خلصت منه الفراخ.%');
end $$;
