-- The restaurant's drivers: added by the team, signed in from a WhatsApp link,
-- given an order, picking it up (the customer hears who and how far), close
-- by ("about 5 minutes"), chatting with the customer, delivered, the cash report.

-- the cashier (staff) adds a driver and sends the sign-in link
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
declare
  t   uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  other uuid := (select id from everwake.branches where tenant_id = t and code <> 'zamalek' order by code limit 1);
  r jsonb;
begin
  r := everwake.save_driver(t, jsonb_build_object('name', 'أحمد', 'phone', '0101 234 5678'));
  assert r ->> 'phone' = '201012345678', 'Egyptian numbers become international: ' || (r ->> 'phone');
  begin
    perform everwake.save_driver(t, jsonb_build_object('name', 'أحمد تاني', 'phone', '+20 10 1234 5678'));
    assert false, 'the same number twice';
  exception when raise_exception then null;
  end;
  begin
    perform everwake.save_driver(t, jsonb_build_object('name', 'x', 'phone', '123'));
    assert false, 'a number that cannot be WhatsApp';
  exception when raise_exception then null;
  end;
  -- one who only drives for another branch
  perform everwake.save_driver(t, jsonb_build_object('name', 'كريم', 'phone', '01111111111', 'branch_ids', jsonb_build_array(other)));

  r := everwake.invite_driver((select id from everwake.drivers where phone = '201012345678'), 'https://orders.example/');
  assert r ->> 'link' ~ '^https://orders\.example/d/[0-9a-f-]{36}\.[0-9a-f]{64}$', r ->> 'link';
  assert exists (select 1 from everwake.outbox where purpose = 'driver' and to_jid = '201012345678'
                  and body like '%' || (r ->> 'link') || '%');
  -- the team sees drivers, but never the sign-in secret
  assert (select count(*) from everwake.drivers where tenant_id = t) = 2;
  begin
    perform login_code_hash from everwake.drivers;
    assert false, 'login_code_hash readable';
  exception when insufficient_privilege then null;
  end;
  -- and cannot act as a driver's phone
  begin
    perform everwake.driver_home('x');
    assert false, 'dashboard users cannot call driver functions';
  exception when insufficient_privilege then null;
  end;
end $$;

-- a delivery order for the Zamalek branch
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare
  t   uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  wa  text := '201555000111';
  r jsonb;
begin
  r := everwake.intake(jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token', 'external_id', 'drv1', 'wa_id', wa,
                                          'phone', wa, 'push_name', 'Mona', 'text', 'عايزة فرخة'));
  r := everwake.persist_cart(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'branch_id', zam,
         'cart', jsonb_build_object('items', jsonb_build_array(jsonb_build_object('line_id', 'L1', 'code', 'M003',
                   'item_name', 'فرخة مشوية', 'unit', 'portion', 'quantity', 1, 'unit_price', 480, 'line_total', 480))),
         'totals', jsonb_build_object('subtotal', 480, 'delivery_fee', 20, 'total', 500)));
  r := everwake.place_order(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'branch_id', zam,
         'customer', jsonb_build_object('full_name', 'منى', 'phone', '01555000111', 'delivery_method', 'delivery', 'payment_method', 'cash'),
         'address_text', 'حسن صبري، الزمالك، عمارة 8',
         'location', jsonb_build_object('lat', 30.0610, 'lng', 31.2200),
         'totals', jsonb_build_object('subtotal', 480, 'delivery_fee', 20, 'total', 500)));
  assert (r ->> 'ok')::boolean, r::text;
  perform everwake.set_order_status((select id from everwake.orders where tenant_id = t and wa_id = wa and status = 'placed'), 'accepted');
end $$;

-- the cashier gives it to Ahmed (not to Karim, who drives for another branch)
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
declare
  t  uuid := (select id from everwake.tenants where slug = 'nile_grill');
  oid bigint := (select id from everwake.orders where tenant_id = t and wa_id = '201555000111' and status = 'accepted');
begin
  begin
    perform everwake.assign_driver(oid, (select id from everwake.drivers where phone = '201111111111'));
    assert false, 'a driver of another branch';
  exception when raise_exception then null;
  end;
  perform everwake.assign_driver(oid, (select id from everwake.drivers where phone = '201012345678'), 'https://orders.example');
  assert (select driver_id from everwake.orders where id = oid) is not null;
  assert exists (select 1 from everwake.outbox where purpose = 'driver' and to_jid = '201012345678'
                  and body like '🛵 طلب جديد معاك%https://orders.example/driver');
end $$;

-- Ahmed's phone: sign in, see the order, pick it up, come close, chat, deliver
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare
  t   uuid := (select id from everwake.tenants where slug = 'nile_grill');
  d   uuid := (select id from everwake.drivers where phone = '201012345678');
  oid bigint := (select id from everwake.orders where tenant_id = t and wa_id = '201555000111' and status = 'accepted');
  code text; tok text; tok2 text; r jsonb; ctx jsonb; msg text; n int;
begin
  code := substring((select body from everwake.outbox where purpose = 'driver' and to_jid = '201012345678' and body like '%/d/%'
                      order by id desc limit 1) from '/d/[0-9a-f-]{36}\.([0-9a-f]{64})');
  r := everwake.driver_redeem(d, code, 'test phone');
  assert (r ->> 'ok')::boolean, 'the link signs in';
  tok := r ->> 'token';
  assert not (everwake.driver_redeem(d, code) ->> 'ok')::boolean, 'a link works once';
  assert not (everwake.driver_redeem(d, repeat('0', 64)) ->> 'ok')::boolean;

  -- "send me my link" by number: at most once a minute
  update everwake.drivers set login_code_sent_at = now() - interval '5 minutes' where id = d;
  assert everwake.driver_request_login('01012345678', 'https://orders.example') = 1;
  assert everwake.driver_request_login('01012345678', 'https://orders.example') = 0, 'once a minute';
  assert everwake.driver_request_login('01099999999', 'https://orders.example') = 0, 'unknown numbers get nothing';

  r := everwake.driver_home(tok);
  assert r -> 'driver' ->> 'name' = 'أحمد';
  assert jsonb_array_length(r -> 'orders') = 1, r::text;
  assert r -> 'orders' -> 0 ->> 'customer_phone' = '01555000111', r -> 'orders' -> 0 ->> 'customer_phone';
  assert r -> 'orders' -> 0 -> 'branch' ->> 'name' = 'الزمالك';
  assert r -> 'orders' -> 0 -> 'items' -> 0 ->> 'name' = 'فرخة مشوية';

  -- far away (about 5 km): no "almost there"
  r := everwake.driver_ping(tok, 30.0900, 31.2600, 12);
  assert (r ->> 'notified')::int = 0;

  -- picks it up: the customer hears who is bringing it, their number and how long
  r := everwake.driver_action(tok, oid, 'pick_up');
  assert (select status from everwake.orders where id = oid) = 'out_for_delivery';
  select o.body into msg from everwake.outbox o where o.wa_id = '201555000111' and o.purpose = 'order_status' order by o.id desc limit 1;
  assert msg like 'طلبك رقم % خرج مع الطيار وفي الطريق ليك 🛵%الطيار: أحمد — 01012345678 · هيوصلك خلال حوالي % دقيقة', msg;
  assert (select by_role from everwake.order_events where order_id = oid order by id desc limit 1) = 'driver';

  -- the ride: tracked, and the customer hears once when it is ~5 minutes away
  update everwake.orders set out_for_delivery_at = now() - interval '10 minutes' where id = oid;
  r := everwake.driver_ping(tok, 30.0700, 31.2350, 10);
  assert (r ->> 'notified')::int = 0 and (r -> 'orders' -> 0 ->> 'min')::int > 5, r::text;
  assert (select delivery_km_left from everwake.orders where id = oid) > 1;
  r := everwake.driver_ping(tok, 30.0625, 31.2215, 10);
  assert (r ->> 'notified')::int = 1, r::text;
  assert exists (select 1 from everwake.outbox where wa_id = '201555000111' and body like '🛵 الطيار أحمد قرّب يوصلك%');
  r := everwake.driver_ping(tok, 30.0615, 31.2205, 10);
  assert (r ->> 'notified')::int = 0, 'only once';

  -- the agent knows who has it and how far
  ctx := everwake.turn_context(t, '201555000111');
  assert ctx -> 'last_orders' -> 0 -> 'driver' ->> 'name' = 'أحمد', ctx ->> 'last_orders';
  assert (ctx -> 'last_orders' -> 0 -> 'tracking' ->> 'eta_min')::int <= 5;

  -- the driver writes to the customer from the restaurant's number, and sees the replies
  r := everwake.driver_send(tok, oid, 'أنا تحت البيت');
  assert exists (select 1 from everwake.outbox where wa_id = '201555000111' and purpose = 'driver_chat' and body = '🛵 أحمد: أنا تحت البيت');
  assert exists (select 1 from everwake.messages where wa_id = '201555000111' and sender = 'driver');
  r := everwake.driver_chat(tok, oid);
  assert exists (select 1 from jsonb_array_elements(r) x where x ->> 'from' = 'driver'), r::text;
  assert exists (select 1 from jsonb_array_elements(r) x where x ->> 'from' = 'customer');

  -- another driver cannot touch it
  update everwake.drivers set login_code_hash = everwake.token_hash('k'), login_code_expires_at = now() + interval '1 hour'
   where phone = '201111111111';
  tok2 := everwake.driver_redeem((select id from everwake.drivers where phone = '201111111111'), 'k') ->> 'token';
  begin
    perform everwake.driver_action(tok2, oid, 'delivered');
    assert false, 'not their order';
  exception when raise_exception then null;
  end;
  assert jsonb_array_length(everwake.driver_home(tok2) -> 'orders') = 0;

  r := everwake.driver_action(tok, oid, 'delivered');
  assert (select status from everwake.orders where id = oid) = 'delivered';
  r := everwake.driver_home(tok);
  assert jsonb_array_length(r -> 'orders') = 0 and (r -> 'today' ->> 'delivered')::int = 1 and (r -> 'today' ->> 'cash')::numeric = 500, r::text;
end $$;

-- the cash report, and switching a driver off signs them out
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
declare
  t uuid := (select id from everwake.tenants where slug = 'nile_grill');
  r jsonb;
begin
  r := everwake.driver_report(t, now() - interval '1 day', now() + interval '1 minute');
  assert exists (select 1 from jsonb_array_elements(r) x where x ->> 'name' = 'أحمد' and (x ->> 'delivered')::int = 1
                  and (x ->> 'cash')::numeric = 500), r::text;
  perform everwake.save_driver(t, jsonb_build_object('id', (select id from everwake.drivers where phone = '201012345678'), 'is_active', false));
end $$;

reset role;
select set_config('request.jwt.claims', '', false);
do $$
begin
  assert not exists (select 1 from everwake.driver_sessions s join everwake.drivers d on d.id = s.driver_id
                      where d.phone = '201012345678'), 'switched off: signed out';
  assert everwake.driver_request_login('01012345678', 'https://orders.example') = 0;
end $$;
