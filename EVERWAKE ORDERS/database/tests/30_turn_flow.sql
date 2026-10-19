-- The debounce window, a GPS pin, the turn context and persisting a turn
do $$
declare
  t    uuid := (select id from everwake.tenants where slug = 'nile_grill');
  base jsonb := jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token');
  r1 jsonb; r2 jsonb; c jsonb; ctx jsonb; p jsonb;
  wa   text := '201300300300';
begin
  -- two quick messages: only the newest run answers, with both texts
  r1 := everwake.intake(base || jsonb_build_object('external_id', 't1', 'wa_id', wa, 'phone', wa, 'text', 'السلام عليكم'));
  r2 := everwake.intake(base || jsonb_build_object('external_id', 't2', 'wa_id', wa, 'phone', wa, 'text', 'عايز فرخة'));
  c := everwake.claim_window(t, wa, 'run1', (r1 ->> 'buffer_id')::bigint);
  assert not (c ->> 'is_newest')::boolean, 'the older run steps aside: ' || c::text;
  c := everwake.claim_window(t, wa, 'run2', (r2 ->> 'buffer_id')::bigint);
  assert (c ->> 'lock_acquired')::boolean and (c ->> 'buffered_count')::int = 2, c::text;
  assert c ->> 'combined_text' = E'السلام عليكم\nعايز فرخة', c::text;

  -- a message arriving while the turn runs waits for the lock
  r1 := everwake.intake(base || jsonb_build_object('external_id', 't3', 'wa_id', wa, 'phone', wa, 'text', 'كاملة'));
  c := everwake.claim_window(t, wa, 'run3', (r1 ->> 'buffer_id')::bigint);
  assert (c ->> 'is_newest')::boolean and not (c ->> 'lock_acquired')::boolean, 'locked: ' || c::text;

  -- the turn context: two branches, nothing chosen yet, a first-time customer
  ctx := everwake.turn_context(t, wa);
  assert ctx -> 'state' -> 'branch' is null, 'two branches: the agent has to find out which';
  assert jsonb_array_length(ctx -> 'all_lookup' -> 'branches') = 2;
  assert jsonb_array_length(ctx -> 'all_lookup' -> 'offers') = 3;
  assert ctx -> 'all_lookup' -> 'tenant' ->> 'currency_symbol' = 'ج';
  assert ctx ->> 'menu_digest' like '%M011 شيشة%', 'no branch → the all-branches menu';
  assert jsonb_array_length(ctx -> 'last_orders') = 0;
  assert (ctx -> 'customer' ->> 'orders_count')::int = 0;
  assert jsonb_array_length(ctx -> 'recent_messages') = 3;

  -- a GPS pin in Zamalek: the zone, the delivery fee, and the branch chosen
  p := everwake.save_pin(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'lat', 30.0610, 'lng', 31.2200,
         'maps_url', 'https://www.google.com/maps?q=30.0610,31.2200',
         'geo', jsonb_build_object('street', 'شارع حسن صبري', 'district', 'الزمالك', 'city', 'القاهرة', 'governorate', 'القاهرة')));
  assert (p ->> 'in_delivery_area')::boolean and (p ->> 'auto_branch_set')::boolean, p::text;
  assert p -> 'zone' ->> 'name' = 'الزمالك' and (p -> 'zone' ->> 'delivery_fee')::numeric = 20, p::text;
  ctx := everwake.turn_context(t, wa);
  assert ctx -> 'state' -> 'branch' ->> 'code' = 'zamalek';
  assert ctx -> 'state' -> 'customer' ->> 'address_street' = 'شارع حسن صبري';
  assert ctx -> 'state' -> 'customer' ->> 'address_source' = 'pin';
  assert ctx ->> 'menu_digest' like '%M002 ريش ضاني%' and ctx ->> 'menu_digest' like '%اختيارات%', 'the branch menu with choices';
  assert ctx -> 'branch_lookup' -> 'items' -> 'M003' ->> 'price' = '260.00';

  -- a second pin outside every zone: no zone, the branch stays (never switched silently)
  p := everwake.save_pin(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'lat', 31.2001, 'lng', 29.9187, 'geo', '{}'::jsonb));
  assert not (p ->> 'in_delivery_area')::boolean and p -> 'zone' = 'null'::jsonb, p::text;
  ctx := everwake.turn_context(t, wa);
  assert ctx -> 'state' -> 'branch' ->> 'code' = 'zamalek';
  assert ctx -> 'state' -> 'location' -> 'nearest' -> 0 ->> 'code' is not null;

  -- the turn is persisted: memory, telemetry, the lock is released
  c := everwake.persist_turn(jsonb_build_object('tenant_id', t, 'wa_id', wa, 'run_id', 'run2',
         'state_patch', jsonb_build_object('last_turn_at', now(), 'memory_notes', jsonb_build_array('family of four')),
         'ledger_patch', jsonb_build_object('last_reply_at', now()),
         'log_row', jsonb_build_object('order_stage', 'discovery', 'qa_passed', true, 'llm_calls', 2, 'duration_total_ms', 4200),
         'handoff', jsonb_build_object('needed', true, 'reason', 'wants to book a birthday'),
         'language', 'ar'));
  assert (c ->> 'locks_released')::int = 1 and (c ->> 'buffer_rows_cleared')::int = 2, c::text;
  assert c ->> 'mode' = 'agent' and (c ->> 'agent_enabled')::boolean;
  assert (select needs_attention from everwake.conversations where tenant_id = t and wa_id = wa), 'a handoff flags the inbox';
  assert exists (select 1 from everwake.agent_events where tenant_id = t and run_id = 'run2');

  -- now the waiting run gets the lock
  c := everwake.claim_window(t, wa, 'run3', (r1 ->> 'buffer_id')::bigint);
  assert (c ->> 'lock_acquired')::boolean and c ->> 'combined_text' = 'كاملة', c::text;
  perform everwake.release_lock(t, wa, 'run3');

  -- a takeover during the debounce wait ends the run quietly
  r1 := everwake.intake(base || jsonb_build_object('external_id', 't4', 'wa_id', wa, 'phone', wa, 'text', 'hello'));
  perform everwake.take_over((select id from everwake.conversations where tenant_id = t and wa_id = wa));
  c := everwake.claim_window(t, wa, 'run4', (r1 ->> 'buffer_id')::bigint);
  assert c ->> 'blocked_reason' = 'human', c::text;
  perform everwake.hand_back((select id from everwake.conversations where tenant_id = t and wa_id = wa));

  -- a single-branch restaurant never asks which branch
  update everwake.branches set is_active = false where tenant_id = t and code = 'maadi';
  r1 := everwake.intake(base || jsonb_build_object('external_id', 't5', 'wa_id', '201300300301', 'phone', '201300300301', 'text', 'hi'));
  ctx := everwake.turn_context(t, '201300300301');
  assert ctx -> 'state' -> 'branch' ->> 'source' = 'only_branch', ctx -> 'state' ->> 'branch';
  update everwake.branches set is_active = true where tenant_id = t and code = 'maadi';
end $$;
