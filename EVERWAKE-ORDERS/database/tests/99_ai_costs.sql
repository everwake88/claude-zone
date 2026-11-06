-- What the AI costs (developers only) and what restaurants owe Everwake.

-- a developer account, and Nile Grill's owner (from 50_dashboard_security)
insert into everwake.platform_admins (user_id, email) values ('55555555-5555-5555-5555-555555555555', 'dev@everwake.example')
on conflict do nothing;

do $$
declare
  t   uuid := (select id from everwake.tenants where slug = 'nile_grill');
  br  uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  cid bigint; oid bigint; mid bigint; v jsonb; r jsonb;
begin
  -- a customer's chat: two turns before the order, one after
  insert into everwake.messages (tenant_id, wa_id, direction, sender, kind, body, run_id)
  values (t, '201400777001', 'inbound', 'customer', 'text', 'عايز فرخة', 'run-a') returning id into mid;
  insert into everwake.ai_usage (tenant_id, run_id, message_id, step, kind, model, input_tokens, cached_tokens, output_tokens, reasoning_tokens, created_at)
  values (t, 'run-a', mid, 'brain', 'text', 'gpt-6-luna', 7000, 5000, 1200, 1000, now() - interval '50 minutes'),
         (t, 'run-a', mid, 'agent', 'text', 'gpt-6-luna-2026-10-01', 8000, 6000, 400, 200, now() - interval '50 minutes');
  -- the price: (2000 × 0.10 + 5000 × 0.01 + 1200 × 0.50) / 1M = 0.00085; the dated model name matches by prefix
  assert (select cost_usd from everwake.ai_usage where run_id = 'run-a' and step = 'brain') = 0.00085,
         (select cost_usd from everwake.ai_usage where run_id = 'run-a' and step = 'brain')::text;
  assert (select priced from everwake.ai_usage where run_id = 'run-a' and step = 'agent');
  assert (select wa_id from everwake.ai_usage where run_id = 'run-a' and step = 'brain') = '201400777001', 'the customer comes from the message';

  insert into everwake.ai_usage (tenant_id, run_id, wa_id, step, kind, model, input_tokens, output_tokens, created_at)
  values (t, 'run-b', '201400777001', 'agent', 'text', 'gpt-6-luna', 9000, 300, now() - interval '40 minutes'),
         (t, 'run-c', '201400777001', 'agent', 'text', 'gpt-6-luna', 9000, 300, now() - interval '5 minutes'),
         (t, 'run-v', '201400777001', 'transcribe', 'voice', 'gpt-transcribe', 0, 0, now() - interval '45 minutes'),
         (t, 'run-x', '201400777999', 'agent', 'test', 'some-model-without-a-price', 100, 10, now() - interval '1 minute');
  update everwake.ai_usage set audio_seconds = 30 where run_id = 'run-v';
  assert (select cost_usd from everwake.ai_usage where run_id = 'run-v') = 0.00225, 'half a minute of voice at 0.0045 a minute';
  assert (select priced from everwake.ai_usage where run_id = 'run-x') = false, 'a model with no price is marked, not guessed';

  -- the order those turns led to, placed between them
  insert into everwake.orders (tenant_id, order_no, wa_id, branch_id, status, source, subtotal, discount_total, vat, delivery_fee, total,
                               delivery_method, customer, address_text, placed_at)
  values (t, 'AI-1', '201400777001', br, 'delivered', 'whatsapp_agent', 500, 50, 63, 20, 533, 'delivery',
          '{"full_name":"سلمى","phone":"01000000001"}', 'المعادي، شارع 9', now() - interval '30 minutes') returning id into oid;

  select jsonb_agg(x) into v from everwake.ai_turns(now() - interval '2 hours', now(), t) x;
  assert (select count(*) from jsonb_array_elements(v) e where (e ->> 'order_id')::bigint = oid and e ->> 'part' = 'to_order') = 3, 'two messages and a voice note led to it: ' || v::text;
  assert (select count(*) from jsonb_array_elements(v) e where (e ->> 'order_id')::bigint = oid and e ->> 'part' = 'after_order') = 1;
  assert (select e ->> 'part' from jsonb_array_elements(v) e where e ->> 'run_id' = 'run-x') = 'no_order', 'a test chat belongs to no order';
  assert (select (e ->> 'calls')::int from jsonb_array_elements(v) e where e ->> 'run_id' = 'run-a') = 2, 'a turn gathers its calls';

  -- the bill (a day of its own, away from the other tests' orders): 2% of the food after discounts
  -- by default (450 → 9); QR orders on their full total
  insert into everwake.orders (tenant_id, order_no, wa_id, branch_id, status, source, subtotal, discount_total, vat, delivery_fee, total,
                               delivery_method, customer, address_text, placed_at)
  values (t, 'B-1', '201400777001', br, 'delivered', 'whatsapp_agent', 500, 50, 63, 20, 533, 'delivery',
          '{"full_name":"سلمى","phone":"01000000001"}', 'المعادي، شارع 9', '2020-01-15 10:00+00'),
         (t, 'QR-T1', 'qr:1', br, 'picked_up', 'qr', 300, 0, 42, 0, 342, 'dine_in', null, null, '2020-01-15 11:00+00'),
         (t, 'TEAM-1', '201400777002', br, 'delivered', 'dashboard', 1000, 0, 140, 0, 1140, 'pickup', null, null, '2020-01-15 12:00+00'),
         (t, 'GONE-1', '201400777003', br, 'cancelled', 'whatsapp_agent', 1000, 0, 140, 0, 1140, 'pickup', null, null, '2020-01-15 13:00+00');
  r := everwake.bill_statement(t, '2020-01-15', '2020-01-16');
  assert (r -> 'totals' ->> 'orders')::int = 2, 'the team''s and the cancelled orders are not billed: ' || (r -> 'totals')::text;
  assert (select (e ->> 'fee')::numeric from jsonb_array_elements(r -> 'rows') e where e ->> 'order_no' = 'B-1') = 9.00;
  assert (select (e ->> 'fee')::numeric from jsonb_array_elements(r -> 'rows') e where e ->> 'order_no' = 'QR-T1') = 6.84, 'QR: 2% of 342';
  assert (select (e ->> 'net')::numeric from jsonb_array_elements(r -> 'rows') e where e ->> 'order_no' = 'B-1') = 524.00;
  assert (select e ->> 'name' from jsonb_array_elements(r -> 'rows') e where e ->> 'order_no' = 'B-1') = 'سلمى';
  assert (select e ->> 'address' from jsonb_array_elements(r -> 'rows') e where e ->> 'order_no' = 'B-1') = 'المعادي، شارع 9';
  -- with the delivery fee and VAT ticked: 450 + 20 + 63 = 533 → 10.66; QR stays on its total
  perform everwake.save_bill_rule(t, '{"fee_percent": 2, "include_delivery_fee": true, "include_vat": true}');
  r := everwake.bill_statement(t, '2020-01-15', '2020-01-16');
  assert (select (e ->> 'fee')::numeric from jsonb_array_elements(r -> 'rows') e where e ->> 'order_no' = 'B-1') = 10.66, r::text;
  assert (select (e ->> 'fee')::numeric from jsonb_array_elements(r -> 'rows') e where e ->> 'order_no' = 'QR-T1') = 6.84;
  assert (r -> 'totals' ->> 'fee')::numeric = 17.50;
  perform everwake.save_bill_rule(t, '{"fee_percent": 2}');

  -- the engine records its own calls, exactly as OpenAI reported them
  assert everwake.record_ai_usage(t, mid, 'run-e', 'voice', '[
    {"step":"brain","model":"gpt-6-luna","effort":"low","endpoint":"responses","input":10240,"cached":8960,"written":1024,"output":2311,"thinking":1987,"status":200,"ms":5120},
    {"step":"agent","model":"gpt-6-luna","effort":"sideways","endpoint":"responses","input":12001,"cached":11904,"output":180,"thinking":64,"status":200,"ms":2210},
    {"step":"transcribe","model":"gpt-transcribe","endpoint":"audio/transcriptions","seconds":12.5,"status":200},
    {"step":"nonsense","model":"gpt-6-luna","input":"12","output":3},
    "not a call"]') = 4;
  -- brain: (256 uncached × 0.10 + 8960 cached × 0.01 + 1024 written × 0.125 + 2311 × 0.50) / 1M = 0.0013987
  assert (select cost_usd from everwake.ai_usage where run_id = 'run-e' and step = 'brain') = 0.0013987,
         (select cost_usd from everwake.ai_usage where run_id = 'run-e' and step = 'brain')::text;
  -- agent: (97 × 0.10 + 11904 × 0.01 + 180 × 0.50) / 1M = 0.00021874
  assert (select cost_usd from everwake.ai_usage where run_id = 'run-e' and step = 'agent') = 0.00021874;
  assert (select cost_usd from everwake.ai_usage where run_id = 'run-e' and step = 'transcribe') = 0.0009375, '12.5 s of voice at 0.0045 a minute';
  assert (select cache_write_tokens from everwake.ai_usage where run_id = 'run-e' and step = 'brain') = 1024;
  assert (select price_cache_write_per_m from everwake.ai_usage where run_id = 'run-e' and step = 'brain') = 0.125;
  -- a voice note with tokens reported too is still priced by the minute; a model without a write price bills writes as input
  assert everwake.record_ai_usage(t, null, 'run-w', 'voice', '[{"step":"transcribe","model":"gpt-transcribe","input":400,"output":60,"seconds":20},
                                                              {"step":"vision","model":"gpt-5-mini","input":2000,"cached":0,"written":1000,"output":100}]') = 2;
  assert (select cost_usd from everwake.ai_usage where run_id = 'run-w' and step = 'transcribe') = 0.0015, '20 s at 0.0045 a minute';
  -- (1000 × 0.25 + 1000 written × 0.25 + 100 × 2.00) / 1M = 0.0007
  assert (select cost_usd from everwake.ai_usage where run_id = 'run-w' and step = 'vision') = 0.0007;
  assert (select audio_per_minute from everwake.ai_prices where model = 'gpt-transcribe') = 0.0045;
  assert (select input_per_m from everwake.ai_prices where model = 'gpt-4o-transcribe') = 2.50;
  assert (select kind from everwake.ai_usage where run_id = 'run-e' and step = 'agent') = 'voice';
  assert (select reasoning_tokens from everwake.ai_usage where run_id = 'run-e' and step = 'brain') = 1987;
  assert (select effort from everwake.ai_usage where run_id = 'run-e' and step = 'brain') = 'low', 'the effort it ran at';
  assert (select effort from everwake.ai_usage where run_id = 'run-e' and step = 'agent') is null, 'an unknown effort is not stored';
  -- the settings: both steps at low, a 5 s wait, a restaurant's own wait within 2–10 s
  v := everwake.ai_settings(t);
  assert v ->> 'brain_effort' = 'low' and v ->> 'agent_effort' = 'low' and (v ->> 'wait_seconds')::int = 5, v::text;
  insert into everwake.ai_config (scope, wait_seconds) values (t::text, 8) on conflict (scope) do update set wait_seconds = 8;
  assert (everwake.ai_settings(t) ->> 'wait_seconds')::int = 8;
  begin
    update everwake.ai_config set wait_seconds = 30 where scope = t::text;
    assert false, 'a wait of 30 s was taken';
  exception when check_violation then null;
  end;
  delete from everwake.ai_config where scope = t::text;
  assert (select price_out_per_m from everwake.ai_usage where run_id = 'run-e' and step = 'brain') = 0.50, 'the price is kept with the call';
  assert (select step from everwake.ai_usage where run_id = 'run-e' and input_tokens = 12) = 'other';
  -- a later price change leaves the recorded costs as they were
  update everwake.ai_prices set output_per_m = 0.60 where model = 'gpt-6-luna';
  assert (select cost_usd from everwake.ai_usage where run_id = 'run-e' and step = 'brain') = 0.0013987;
  update everwake.ai_prices set output_per_m = 0.50 where model = 'gpt-6-luna';
  assert everwake.record_ai_usage(t, null, 'run-f', 'text', '{}') = 0, 'not a list: nothing written';
end $$;

-- the developer: sees the costs
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', false);
do $$
declare v jsonb; n int;
begin
  assert everwake.is_platform_admin();
  v := everwake.dev_costs(now() - interval '2 hours', now());
  assert (v -> 'totals' ->> 'calls')::int >= 6, v -> 'totals';
  assert (v ->> 'orders')::int >= 1 and jsonb_array_length(v -> 'by_tenant') >= 1;
  assert (v -> 'totals' ->> 'cache_hit_calls')::int >= 2;
  v := everwake.dev_messages(now() - interval '2 hours', now());
  assert jsonb_array_length(v) >= 4 and (v -> 0) ? 'steps', v::text;
  select count(*) into n from everwake.ai_usage;
  assert n >= 6, 'the developer reads the usage table';
  assert jsonb_array_length(everwake.dev_tenants()) >= 1;
  assert exists (select 1 from jsonb_array_elements(everwake.dev_costs(now() - interval '2 hours', now()) -> 'by_effort') e
                  where e ->> 'step' = 'brain' and e ->> 'effort' = 'low'), 'the cost split by effort';
end $$;

-- the restaurant's owner: the bill yes, the costs never
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);
do $$
declare t uuid := (select id from everwake.tenants where slug = 'nile_grill'); n int; r jsonb;
begin
  select count(*) into n from everwake.ai_usage;
  assert n = 0, 'an owner reads no AI costs';
  select count(*) into n from everwake.ai_config;
  assert n = 0, 'nor the AI settings';
  begin
    perform everwake.dev_costs(now() - interval '1 day', now());
    assert false, 'an owner read the developer''s costs';
  exception when insufficient_privilege then null;
  end;
  begin
    perform everwake.save_bill_rule(t, '{"fee_percent": 0}');
    assert false, 'an owner changed Everwake''s percent';
  exception when insufficient_privilege then null;
  end;
  begin
    perform everwake.record_ai_usage(t, null, 'run-z', 'text', '[{"step":"agent","model":"gpt-6-luna","input":1,"output":1}]');
    assert false, 'an owner wrote AI usage';
  exception when insufficient_privilege then null;
  end;
  begin
    perform everwake.ai_settings(t);
    assert false, 'an owner read the AI settings';
  exception when insufficient_privilege then null;
  end;
  r := everwake.bill_statement(t, '2020-01-15', '2020-01-16');
  assert (r -> 'rule' ->> 'fee_percent')::numeric = 2 and (r -> 'totals' ->> 'orders')::int = 2;
  select count(*) into n from everwake.tenant_billing where tenant_id = t;
  assert n = 1, 'the owner reads their own rule';
end $$;

-- the cashier (staff): no bills
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', false);
do $$
begin
  perform everwake.bill_statement((select id from everwake.tenants where slug = 'nile_grill'), now() - interval '1 hour', now());
  assert false, 'staff read the bill';
exception when insufficient_privilege then null;
end $$;
reset role;
