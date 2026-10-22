-- Paying online with Paymob: the owner connects the account, a placed order
-- gets a link, Paymob reports the payment (declined, wrong amount, paid,
-- twice, refunded), unpaid links get a reminder and expire, and the team can
-- switch an order to cash.

-- the owner connects Paymob
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"owner@nile.example"}', false);
do $$
declare t uuid := (select id from everwake.tenants where slug = 'nile_grill'); v jsonb;
begin
  begin
    perform everwake.save_payment_account(t, '{"enabled": true}');
    assert false, 'cannot switch on without keys';
  exception when raise_exception then null;
  end;
  v := everwake.save_payment_account(t, jsonb_build_object(
         'public_key', 'egy_pk_test_abc', 'secret_key', 'egy_sk_test_secret1234', 'hmac_secret', 'HMACSECRET',
         'card_integration_id', '4097558', 'wallet_integration_id', '', 'link_minutes', 60, 'reminder_minutes', 15,
         'dashboard_url', 'https://dash.example/', 'enabled', true));
  assert (v ->> 'connected')::boolean and v ->> 'secret_hint' = '…1234' and not (v ->> 'is_live')::boolean, v::text;
  assert v ->> 'dashboard_url' = 'https://dash.example', 'no trailing slash';
  assert not v ? 'secret_key' and not v ? 'hmac_secret', 'secrets never come back';
  assert (v ->> 'has_secret_key')::boolean and (v ->> 'has_hmac_secret')::boolean;
  assert (select settings -> 'payment_methods' from everwake.tenants where id = t) ? 'online', 'customers are offered "online"';
  -- saving again with empty secrets keeps them
  v := everwake.save_payment_account(t, '{"secret_key": "", "hmac_secret": ""}');
  assert (v ->> 'has_secret_key')::boolean and (v ->> 'has_hmac_secret')::boolean;
  begin
    perform 1 from everwake.payment_accounts;
    assert false, 'the keys table is not readable from the dashboard';
  exception when insufficient_privilege then null;
  end;
end $$;

-- a cashier may not see or change the keys, nor make links by hand
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
declare t uuid := (select id from everwake.tenants where slug = 'nile_grill');
begin
  begin perform everwake.payment_account_view(t); assert false; exception when raise_exception or insufficient_privilege then null; end;
  begin perform everwake.payment_prepare(t, 'NG-1', null); assert false; exception when insufficient_privilege then null; end;
  begin perform everwake.payment_callback(t, '{}'); assert false; exception when insufficient_privilege then null; end;
end $$;

reset role;
select set_config('request.jwt.claims', '', false);

-- the secrets live in Vault: the account row holds only their ids
insert into vault.secrets (name, secret) values ('someone_elses_secret', 'not for us');
do $$
declare t uuid := (select id from everwake.tenants where slug = 'nile_grill'); a everwake.payment_accounts%rowtype;
begin
  select * into a from everwake.payment_accounts where tenant_id = t;
  assert to_jsonb(a)::text not like '%egy_sk_test_secret1234%' and to_jsonb(a)::text not like '%HMACSECRET%', 'no secret in the table';
  assert a.secret_key_id is not null and a.hmac_secret_id is not null and a.secret_hint = '1234';
  assert everwake.vault_get(a.secret_key_id) = 'egy_sk_test_secret1234' and everwake.payment_hmac_secret(t) = 'HMACSECRET',
         'the server gets them back';
  assert everwake.vault_get((select id from vault.secrets where id not in (a.secret_key_id, a.hmac_secret_id) limit 1)) is null,
         'nothing else in Vault can be read through it';
  -- a new secret replaces the old one in place
  perform everwake.save_payment_account(t, '{"secret_key": "egy_sk_test_secret5678"}');
  assert (select secret_key_id from everwake.payment_accounts where tenant_id = t) = a.secret_key_id;
  assert everwake.vault_get(a.secret_key_id) = 'egy_sk_test_secret5678';
  perform everwake.save_payment_account(t, '{"secret_key": "egy_sk_test_secret1234"}');
  -- live and test keys are never mixed
  begin
    perform everwake.save_payment_account(t, '{"public_key": "egy_pk_live_abc"}');
    assert false, 'a live public key with a test secret key';
  exception when raise_exception then null;
  end;
end $$;

-- a helper for these tests: a placed order the way the agent places it
create function pg_temp.place(p_wa text, p_method text, p_delivery text, p_fee numeric, p_ext text) returns text language plpgsql as $$
declare
  t   uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  item jsonb := jsonb_build_object('line_id', 'L1', 'code', 'M003', 'item_name', 'فرخة مشوية', 'display_name', 'فرخة مشوية',
                                   'unit', 'portion', 'quantity', 1, 'unit_price', 480, 'line_total', 480);
  r jsonb;
begin
  perform everwake.intake(jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token', 'external_id', p_ext, 'wa_id', p_wa,
                                             'phone', p_wa, 'push_name', 'Payer', 'text', 'عايز أطلب'));
  perform everwake.persist_cart(jsonb_build_object('tenant_id', t, 'wa_id', p_wa, 'branch_id', zam,
          'cart', jsonb_build_object('items', jsonb_build_array(item)), 'totals', jsonb_build_object('subtotal', 480, 'total', 547.2)));
  r := everwake.place_order(jsonb_build_object('tenant_id', t, 'wa_id', p_wa, 'branch_id', zam,
         'customer', jsonb_build_object('full_name', 'منى أحمد', 'phone', p_wa, 'delivery_method', p_delivery, 'payment_method', p_method),
         'totals', jsonb_build_object('subtotal', 480, 'vat', 67.2, 'delivery_fee', p_fee, 'total', 547.2 + coalesce(p_fee, 0))));
  return r ->> 'order_no';
end $$;

do $$
declare
  t     uuid := (select id from everwake.tenants where slug = 'nile_grill');
  wa    text := '201555100001';
  no    text := pg_temp.place('201555100001', 'online', 'pickup', null, 'pay1');
  prep  jsonb;
  prep2 jsonb;
  r     jsonb;
  v_ref text;
  ctx   jsonb;
  paid  jsonb := '{"success": true, "pending": false, "amount_cents": 54720, "currency": "EGP", "method": "card", "card_brand": "MasterCard", "card_last4": "2346"}';
begin
  -- after placing: it needs a link, asked for at the dashboard
  r := everwake.payment_after_place(t, no);
  assert (r ->> 'needed')::boolean and r ->> 'endpoint' = 'https://dash.example/api/pay/link', r::text;
  v_ref := pg_temp.place('201555100009', 'cash', 'pickup', null, 'pay9');
  assert not (everwake.payment_after_place(t, v_ref) ->> 'needed')::boolean, 'cash needs no link';

  -- what Paymob gets
  prep := everwake.payment_prepare(t, no);
  assert (prep ->> 'ok')::boolean and (prep ->> 'amount_cents')::bigint = 54720 and prep -> 'integration_ids' = '[4097558]', prep::text;
  assert prep -> 'billing' ->> 'first_name' = 'منى' and prep -> 'billing' ->> 'last_name' = 'أحمد'
     and prep -> 'billing' ->> 'phone_number' = '+201555100001', prep::text;
  assert (prep -> 'items' -> 0 ->> 'amount')::bigint = 54720, 'the one line adds up to the amount';
  assert prep ->> 'notification_url' = 'https://dash.example/api/pay/paymob/' || t;
  assert prep ->> 'short_url' = 'https://dash.example/p/' || (prep ->> 'ref');
  assert (prep ->> 'expiration')::int = 3600;

  -- a second link replaces the first
  perform everwake.payment_link_saved((prep ->> 'payment_id')::bigint, 'https://eg.checkout.paymob.com/?publicKey=x&clientSecret=old', 'pi_test_0', 777000, false);
  -- a new try that Paymob refuses keeps the old link alive
  prep2 := everwake.payment_prepare(t, no);
  perform everwake.payment_link_failed((prep2 ->> 'payment_id')::bigint, 'Paymob 401: Invalid secret key');
  assert (select status from everwake.payments where id = (prep ->> 'payment_id')::bigint) = 'pending', 'the old link still works';
  assert (select last_error from everwake.payment_accounts where tenant_id = t) like 'Paymob 401%';
  prep2 := everwake.payment_prepare(t, no);
  r := everwake.payment_link_saved((prep2 ->> 'payment_id')::bigint, 'https://eg.checkout.paymob.com/?publicKey=x&clientSecret=y', 'pi_test_1', 777001, false);
  assert (select status from everwake.payments where id = (prep ->> 'payment_id')::bigint) = 'replaced', 'a link that works replaces the old one';
  assert r ->> 'status' = 'LINK_READY' and r ->> 'link' = prep2 ->> 'short_url' and r ->> 'valid_until' like '%مساءً' or r ->> 'valid_until' like '%صباحاً', r::text;
  assert (select payment_status from everwake.orders where order_no = no) = 'pending';
  v_ref := prep2 ->> 'ref';

  -- the agent sees the link next turn
  ctx := everwake.turn_context(t, wa);
  assert ctx -> 'last_orders' -> 0 ->> 'payment_status' = 'pending', ctx -> 'last_orders' -> 0 ->> 'payment_status';
  assert ctx -> 'last_orders' -> 0 -> 'payment' ->> 'link' = prep2 ->> 'short_url';

  -- a declined card: still waiting, one attempt counted
  r := everwake.payment_callback(t, jsonb_build_object('merchant_order_id', v_ref, 'success', false, 'pending', false,
                                                       'amount_cents', 54720, 'error', 'Insufficient funds'));
  assert r ->> 'status' = 'declined';
  assert (select attempts from everwake.payments p where p.ref = v_ref) = 1 and (select status from everwake.payments p where p.ref = v_ref) = 'pending';

  -- a payment for a different amount is not taken as paid
  r := everwake.payment_callback(t, jsonb_build_object('merchant_order_id', v_ref) || paid || '{"amount_cents": 100}');
  assert r ->> 'status' = 'amount_mismatch' and (select payment_status from everwake.orders where order_no = no) = 'pending';

  -- paid
  r := everwake.payment_callback(t, jsonb_build_object('merchant_order_id', v_ref, 'transaction_id', 192036465) || paid);
  assert r ->> 'status' = 'paid', r::text;
  assert (select payment_status = 'paid' and paid_amount = 547.2 from everwake.orders where order_no = no);
  assert (select card_last4 = '2346' and method = 'card' from everwake.payments p where p.ref = v_ref);
  assert exists (select 1 from everwake.outbox where wa_id = wa and purpose = 'order_status' and body = 'تم استلام الدفع ✅ 547.2ج لطلبك ' || no || '. شكراً!'),
         'the customer hears it';
  assert exists (select 1 from everwake.outbox where purpose = 'order_ticket' and to_jid = '201000000051' and body = '💳 اتدفع أونلاين: ' || no || ' — 547.2ج'),
         'the branch hears it';
  -- Paymob sends the same news twice: nothing happens twice
  r := everwake.payment_callback(t, jsonb_build_object('merchant_order_id', v_ref) || paid);
  assert (r ->> 'duplicate')::boolean;
  assert (select count(*) from everwake.outbox where wa_id = wa and body like 'تم استلام الدفع%') = 1;
  assert (everwake.payment_public(v_ref) ->> 'order_paid')::boolean;
  assert (everwake.turn_context(t, wa) -> 'last_orders' -> 0 ->> 'payment_status') = 'paid';
  assert (everwake.payment_after_place(t, no) ->> 'needed') = 'false', 'a paid order needs no link';
  assert everwake.payment_prepare(t, no) ->> 'error' = 'ALREADY_PAID';

  -- found by Paymob's own order id too; refunded from Paymob's dashboard
  r := everwake.payment_callback(t, '{"provider_order_id": 777001, "success": true, "is_refunded": true, "amount_cents": 54720}');
  assert r ->> 'status' = 'refunded' and (select payment_status from everwake.orders where order_no = no) = 'refunded', r::text;

  -- an unknown reference is answered politely and ignored
  assert not (everwake.payment_callback(t, '{"merchant_order_id": "test-123", "success": true}') ->> 'matched')::boolean;
  assert (select last_callback_at is not null from everwake.payment_accounts where tenant_id = t), 'the settings page shows Paymob reached us';
end $$;

-- a total that may still change gets no link; the team is asked
do $$
declare
  t  uuid := (select id from everwake.tenants where slug = 'nile_grill');
  no text := pg_temp.place('201555100002', 'online', 'delivery', null, 'pay2');
  r  jsonb;
begin
  r := everwake.payment_prepare(t, no);
  assert r ->> 'error' = 'TOTAL_NOT_FINAL' and r ->> 'reason' like '%delivery fee%', r::text;
  assert (select needs_attention from everwake.conversations where wa_id = '201555100002');
  -- the team can still send a link for an amount they confirm
  r := everwake.payment_prepare(t, no, 567.2, '11111111-1111-1111-1111-111111111111');
  assert (r ->> 'ok')::boolean and (r ->> 'amount_cents')::bigint = 56720;
  r := everwake.payment_link_saved((r ->> 'payment_id')::bigint, 'https://eg.checkout.paymob.com/?x', 'pi_2', 777002, true);
  assert exists (select 1 from everwake.outbox where wa_id = '201555100002' and body like 'لينك الدفع لطلبك ' || no || ' — 567.2ج:%https://dash.example/p/%اللينك شغال لحد %'),
         'sent by the team: the customer gets the link on WhatsApp';
  assert (select created_by from everwake.payments where order_id = (select id from everwake.orders where order_no = no) and status = 'pending') = 'staff';
end $$;

-- nobody paid: one reminder, then the link expires and the branch is asked to call
do $$
declare
  t  uuid := (select id from everwake.tenants where slug = 'nile_grill');
  no text := pg_temp.place('201555100003', 'online', 'pickup', null, 'pay3');
  r  jsonb;
  pid bigint;
begin
  r := everwake.payment_prepare(t, no);
  pid := (r ->> 'payment_id')::bigint;
  perform everwake.payment_link_saved(pid, 'https://eg.checkout.paymob.com/?z', 'pi_3', 777003, false);
  update everwake.payments set created_at = now() - interval '20 minutes' where id = pid;
  perform everwake.payment_due();
  assert (select reminded_at is not null from everwake.payments where id = pid);
  assert exists (select 1 from everwake.outbox where wa_id = '201555100003' and body like 'لسه مستنيين الدفع لطلبك ' || no || ' (547.2ج)%/p/%كاش%');
  perform everwake.payment_due();
  assert (select count(*) from everwake.outbox where wa_id = '201555100003' and body like 'لسه مستنيين%') = 1, 'one reminder only';

  update everwake.payments set expires_at = now() - interval '1 minute' where id = pid;
  perform everwake.housekeeping();
  assert (select status from everwake.payments where id = pid) = 'expired';
  assert (select payment_status from everwake.orders where order_no = no) = 'expired';
  assert exists (select 1 from everwake.outbox where purpose = 'order_ticket' and body like '⚠️ الطلب ' || no || ': لينك الدفع خلص%');
  assert (select needs_attention and attention_reason like '%' || no from everwake.conversations where wa_id = '201555100003');
  assert (everwake.turn_context(t, '201555100003') -> 'last_orders' -> 0 -> 'payment' ->> 'link') is null, 'no dead link for the agent';
  assert everwake.payment_public(r ->> 'ref') ->> 'status' = 'expired';
end $$;

-- the cashier switches it to cash: the customer is told, the attention flag clears
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
declare oid bigint := (select id from everwake.orders where wa_id = '201555100003' and status <> 'draft'); r jsonb;
begin
  r := everwake.set_order_payment(oid, 'cash');
  assert (r ->> 'notified')::boolean;
  assert (select payment_method = 'cash' and payment_status = 'none' from everwake.orders where id = oid);
  assert (select count(*) from everwake.payments where order_id = oid) >= 1, 'the team sees the order''s payments';
end $$;
reset role;
select set_config('request.jwt.claims', '', false);
do $$
begin
  assert exists (select 1 from everwake.outbox where wa_id = '201555100003' and body like 'تمام، طلبك % هيتدفع كاش عند الاستلام.');
  assert not (select needs_attention from everwake.conversations where wa_id = '201555100003');
end $$;
