-- Ordering in the branch from a QR code: menu → cart → paid (cash at the counter, or card) → kitchen → ready
do $$
declare
  t    uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam  uuid := (select id from everwake.branches where code = 'zamalek' and tenant_id = (select id from everwake.tenants where slug = 'nile_grill'));
  q    text;
  qt   text;
  r    jsonb; m jsonb; ctx jsonb;
  c    everwake.qr_checkouts%rowtype;
  o    everwake.orders%rowtype;
  v_kofta text;
  ep   uuid;
  k    text;
  pay  bigint;
  base jsonb := jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token');
  cart jsonb;
begin
  -- the branch is open whatever the time of the test
  update everwake.branches set hours = '{}'::jsonb, busy_until = null, accepting_orders = true where id = zam;
  insert into everwake.qr_codes (tenant_id, branch_id) values (t, zam) returning code into q;
  insert into everwake.qr_codes (tenant_id, branch_id, table_label) values (t, zam, '7') returning code into qt;
  select code into v_kofta from everwake.menu_items where tenant_id = t and name_ar = 'كفتة مشوية';

  -- the menu it opens: the branch's dishes and prices, the ways to pay
  m := everwake.qr_menu(q);
  assert (m ->> 'ok')::boolean and m -> 'branch' ->> 'code' = 'zamalek', m::text;
  assert jsonb_array_length(m -> 'categories') > 0;
  assert exists (select 1 from jsonb_array_elements(m -> 'categories') cat, jsonb_array_elements(cat -> 'items') i
                  where i ->> 'code' = v_kofta and (i ->> 'price')::numeric > 0), 'kofta on the menu with a price';
  assert (m -> 'pay' ->> 'cash')::boolean and (m -> 'pay' ->> 'card')::boolean
           = exists (select 1 from everwake.payment_accounts a where a.tenant_id = t and a.enabled), 'card only with Paymob: ' || (m -> 'pay')::text;
  assert (select scans from everwake.qr_codes where code = q) = 1;
  assert (everwake.qr_menu('nope') ->> 'error') = 'NOT_FOUND';

  ctx := everwake.qr_pricing_context(q, '01011112222');
  assert ctx -> 'items' -> v_kofta ->> 'price' is not null and (ctx ->> 'orders_count')::int = 0, ctx::text;

  -- cash: a ticket at the counter, nothing for the kitchen until the cashier takes the money
  cart := jsonb_build_object('items', jsonb_build_array(jsonb_build_object('code', v_kofta, 'item_name', 'كفتة مشوية',
            'display_name', 'كفتة مشوية', 'unit', 'kg', 'quantity', 0.5, 'unit_price', 480, 'line_total', 240)));
  r := everwake.qr_checkout_create(jsonb_build_object('code', q, 'cart', cart, 'payment_method', 'cash',
         'totals', jsonb_build_object('subtotal', 240, 'vat', 33.6, 'total', 273.6),
         'customer', jsonb_build_object('full_name', 'منى', 'phone', '01011112222')));
  assert (r ->> 'ok')::boolean and (r ->> 'ticket')::int = 1, r::text;
  select * into c from everwake.qr_checkouts where token = r ->> 'token';
  assert c.status = 'awaiting_payment' and c.customer_id is not null and c.customer ->> 'phone' = '01011112222';
  assert not exists (select 1 from everwake.orders where checkout_id = c.id), 'nothing in the kitchen yet';
  assert (everwake.qr_status(c.token) ->> 'status') = 'awaiting_payment';

  r := everwake.qr_cashier_paid(c.id);
  assert (r ->> 'ok')::boolean, r::text;
  select * into o from everwake.orders where id = (r ->> 'order_id')::bigint;
  assert o.status = 'placed' and o.source = 'qr' and o.payment_status = 'paid' and o.payment_method = 'cash'
     and o.delivery_method = 'pickup' and o.ready_by > now() and o.total = 273.6, row_to_json(o)::text;
  assert (select count(*) from everwake.order_items where order_id = o.id) = 1;
  assert (everwake.qr_cashier_paid(c.id) ->> 'already')::boolean, 'tapping twice makes one order';
  r := everwake.qr_status(c.token);
  assert r -> 'order' ->> 'order_no' = o.order_no and r ->> 'status' = 'paid', r::text;

  -- the kitchen: a note, then ready — no WhatsApp for this customer, the waiting page shows both
  r := everwake.order_note_to_customer(o.id, 'الطحينة خلصت، هنحطلك بابا غنوج بدالها');
  assert not (r ->> 'whatsapp')::boolean, r::text;
  r := everwake.set_order_status(o.id, 'ready', null, true, null);
  assert not (r ->> 'notified')::boolean, 'nothing to send it on: ' || r::text;
  r := everwake.qr_status(c.token);
  assert r -> 'order' ->> 'status' = 'ready' and jsonb_array_length(r -> 'notes') = 1, r::text;

  -- "tell me on WhatsApp": a table order, linked before it's even paid
  r := everwake.qr_checkout_create(jsonb_build_object('code', qt, 'cart', cart, 'payment_method', 'cash',
         'totals', jsonb_build_object('subtotal', 240, 'total', 240)));
  select * into c from everwake.qr_checkouts where token = r ->> 'token';
  assert c.table_label = '7' and c.ticket = 2;
  r := everwake.intake(base || jsonb_build_object('external_id', 'qrlink1', 'wa_id', '201033334444', 'phone', '201033334444',
         'text', 'نبهني لما يجهز (Q-' || substr(c.token, 1, 10) || ')'));
  assert r ->> 'route' = 'qr_linked', r::text;
  assert (select wa_id from everwake.qr_checkouts where id = c.id) = '201033334444';
  r := everwake.qr_cashier_paid(c.id);
  select * into o from everwake.orders where id = (r ->> 'order_id')::bigint;
  assert o.wa_id = '201033334444' and o.delivery_method = 'dine_in' and o.address_text = 'ترابيزة 7';
  assert exists (select 1 from everwake.outbox where wa_id = '201033334444' and body like '%' || o.order_no || '%اتأكد%'), 'the wait, on WhatsApp';
  r := everwake.set_order_status(o.id, 'ready', null, true, null);
  assert (r ->> 'notified')::boolean, 'ready, on WhatsApp: ' || r::text;

  -- card: the money arriving (Paymob's notice) makes the order
  r := everwake.qr_checkout_create(jsonb_build_object('code', q, 'cart', cart, 'payment_method', 'card',
         'totals', jsonb_build_object('subtotal', 240, 'total', 240)));
  select * into c from everwake.qr_checkouts where token = r ->> 'token';
  insert into everwake.payments (tenant_id, checkout_id, ref, amount, currency, expires_at, status)
  values (t, c.id, 'qrref' || c.id, 240, 'EGP', now() + interval '20 minutes', 'pending') returning id into pay;
  r := everwake.payment_callback(t, jsonb_build_object('merchant_order_id', 'qrref' || c.id, 'success', true, 'amount_cents', 24000,
                                                        'transaction_id', '991', 'method', 'card'));
  assert r ->> 'status' = 'paid' and r ->> 'order_no' is not null, r::text;
  assert (select payment_method from everwake.orders where checkout_id = c.id) = 'online';
  assert (select status from everwake.qr_checkouts where id = c.id) = 'paid';

  -- an unpaid cart expires; the cashier can't take money for it after
  r := everwake.qr_checkout_create(jsonb_build_object('code', q, 'cart', cart, 'payment_method', 'cash',
         'totals', jsonb_build_object('subtotal', 240, 'total', 240)));
  update everwake.qr_checkouts set expires_at = now() - interval '1 minute' where token = r ->> 'token';
  perform everwake.housekeeping();
  assert (select status from everwake.qr_checkouts where token = r ->> 'token') = 'expired';
  assert (everwake.qr_cashier_paid((select id from everwake.qr_checkouts where token = r ->> 'token')) ->> 'ok')::boolean is false;

  -- a closed branch takes no QR orders
  update everwake.branches set accepting_orders = false where id = zam;
  r := everwake.qr_checkout_create(jsonb_build_object('code', q, 'cart', cart, 'payment_method', 'cash',
         'totals', jsonb_build_object('subtotal', 240, 'total', 240)));
  assert r ->> 'error' = 'BRANCH_CLOSED', r::text;
  update everwake.branches set accepting_orders = true where id = zam;

  -- what is ordered together
  assert everwake.item_pairs(t) is not null;

  -- loyalty travels with the offer to the agent's cart
  insert into everwake.offers (tenant_id, title_ar, kind, scope, value, every_nth_order)
  values (t, 'كل عاشر طلب خصم 50ج', 'amount_off', 'order', 50, 10);
  perform everwake.rebuild_snapshot(t, true);
  assert exists (select 1 from jsonb_array_elements((select lookup -> 'offers' from everwake.menu_snapshot where tenant_id = t and scope = 'all')) x
                  where (x ->> 'every_nth_order')::int = 10);

  -- the restaurant's own system: signed webhooks for orders and stock, an API key to call in
  insert into everwake.integration_endpoints (tenant_id, url) values (t, 'https://pos.example/hook') returning id into ep;
  r := everwake.qr_checkout_create(jsonb_build_object('code', q, 'cart', cart, 'payment_method', 'cash',
         'totals', jsonb_build_object('subtotal', 240, 'total', 240)));
  perform everwake.qr_cashier_paid((select id from everwake.qr_checkouts where token = r ->> 'token'));
  set constraints all immediate;
  assert exists (select 1 from everwake.integration_events where endpoint_id = ep and event = 'order.created'
                  and jsonb_array_length(payload -> 'items') = 1), 'the new order, with its lines';
  perform everwake.set_item_availability((select id from everwake.menu_items where tenant_id = t and code = v_kofta), false, zam, null);
  assert exists (select 1 from everwake.integration_events where endpoint_id = ep and event = 'item.availability'
                  and payload ->> 'code' = v_kofta and payload ->> 'branch' = 'zamalek' and not (payload ->> 'available')::boolean);
  r := everwake.integration_claim(10);
  assert jsonb_array_length(r) >= 2 and r -> 0 ->> 'url' = 'https://pos.example/hook' and r -> 0 ->> 'secret' is not null, r::text;
  perform everwake.integration_result(jsonb_build_object('id', r -> 0 ->> 'id', 'ok', true));
  perform everwake.integration_result(jsonb_build_object('id', r -> 1 ->> 'id', 'ok', false, 'status_code', 500));
  assert (select status from everwake.integration_events where id = (r -> 0 ->> 'id')::bigint) = 'sent';
  assert (select status from everwake.integration_events where id = (r -> 1 ->> 'id')::bigint) = 'queued';
  r := everwake.integration_test(ep);
  assert (select event from everwake.integration_events where id = (r ->> 'id')::bigint) = 'test', r::text;

  k := everwake.api_key_create(t, 'POS') ->> 'key';
  assert everwake.api_key_tenant(k) = t and everwake.api_key_tenant('ew_wrong') is null;
  r := everwake.api_set_stock(t, jsonb_build_object('item_code', v_kofta, 'branch_code', 'zamalek', 'available', true));
  assert (r ->> 'ok')::boolean, r::text;
  r := everwake.api_set_order_status(t, o.order_no, 'picked_up');
  assert r ->> 'status' = 'picked_up', r::text;
  -- a POS that cannot take webhooks asks for what changed, and for the menu's codes
  r := everwake.api_orders(t, now() - interval '1 hour');
  assert exists (select 1 from jsonb_array_elements(r -> 'orders') x where x ->> 'order_no' = o.order_no and x ->> 'status' = 'picked_up'), r::text;
  assert r ->> 'until' is not null;
  r := everwake.api_menu(t, 'zamalek');
  assert (r ->> 'ok')::boolean and exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'code' = v_kofta), r::text;
  assert everwake.api_menu(t, 'nowhere') ->> 'error' = 'BRANCH_NOT_FOUND';
end $$;

-- the cashier taps Paid on the kitchen screen, signed in as staff: the order is
-- made at commit, and queued for the restaurant's own system with it
do $$
declare
  t uuid := (select id from everwake.tenants where slug = 'nile_grill');
  kofta text := (select code from everwake.menu_items where tenant_id = (select id from everwake.tenants where slug = 'nile_grill') and name_ar = 'كفتة مشوية');
  r jsonb;
begin
  r := everwake.qr_checkout_create(jsonb_build_object(
         'code', (select code from everwake.qr_codes where tenant_id = t and table_label is null and is_active limit 1),
         'cart', jsonb_build_object('items', jsonb_build_array(jsonb_build_object('code', kofta, 'item_name', 'كفتة مشوية',
                   'display_name', 'كفتة مشوية', 'unit', 'kg', 'quantity', 0.5, 'unit_price', 480, 'line_total', 240))),
         'payment_method', 'cash', 'totals', jsonb_build_object('subtotal', 240, 'total', 240)));
  assert (r ->> 'ok')::boolean, r::text;
  perform set_config('test.checkout', (select id from everwake.qr_checkouts where token = r ->> 'token')::text, false);
end $$;
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
select everwake.qr_cashier_paid(current_setting('test.checkout')::bigint);
reset role;
select set_config('request.jwt.claims', '', false);
do $$
begin
  assert exists (select 1 from everwake.integration_events ev
                   join everwake.qr_checkouts c on c.id = current_setting('test.checkout')::bigint
                   join everwake.orders o on o.id = c.order_id
                  where ev.event = 'order.created' and ev.payload ->> 'order_no' = o.order_no), 'queued by a staff member''s tap';
end $$;
