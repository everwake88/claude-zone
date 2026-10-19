-- Signing a restaurant up, isolation between restaurants, roles, menu publishing, stock switches
-- (runs as the Supabase `authenticated` role with a fake JWT, exactly like the dashboard)

-- the Nile Grill owner, and a stranger who signs up their own restaurant
insert into everwake.tenant_members (tenant_id, user_id, role, email, display_name)
select id, '11111111-1111-1111-1111-111111111111', 'owner', 'owner@nile.example', 'Owner' from everwake.tenants where slug = 'nile_grill';
insert into everwake.tenant_members (tenant_id, user_id, role, email, display_name)
select id, '33333333-3333-3333-3333-333333333333', 'staff', 'cashier@nile.example', 'Cashier' from everwake.tenants where slug = 'nile_grill';

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"new@bazooka.example","role":"authenticated"}', false);

do $$
declare
  t uuid; t2 uuid; n int; r jsonb;
begin
  t := everwake.create_tenant('بازوكا', 'Bazooka', null, 'EG', 'Africa/Cairo', 'EGP', 'ar');
  assert (select slug from everwake.tenants where id = t) = 'bazooka';
  assert everwake.member_role(t) = 'owner';
  -- a second "Bazooka" gets its own slug
  t2 := everwake.create_tenant('بازوكا', 'Bazooka');
  assert (select slug from everwake.tenants where id = t2) = 'bazooka_2';

  -- the stranger sees only their own restaurants
  select count(*) into n from everwake.tenants;
  assert n = 2, 'sees exactly their two restaurants, got ' || n;
  select count(*) into n from everwake.orders;
  assert n = 0, 'cannot see Nile Grill orders';
  select count(*) into n from everwake.menu_items;
  assert n = 0, 'cannot see Nile Grill menu';
  r := everwake.my_tenants();
  assert jsonb_array_length(r) = 2;

  -- and cannot touch Nile Grill
  begin
    perform everwake.set_agent_enabled((select id from everwake.tenants where slug = 'nile_grill'), false);
    -- the tenant is invisible, so the id lookup above returns null → role check fails
    assert false, 'switched another restaurant off';
  exception when insufficient_privilege or others then null;
  end;
  update everwake.menu_items set price = 1 where code = 'M001';
  get diagnostics n = row_count;
  assert n = 0, 'cannot edit another restaurant''s menu';

  -- publishing a menu the AI read
  r := everwake.publish_menu(t, '{"categories":[{"name_ar":"ساندوتشات","name_en":"Sandwiches","items":[
        {"name_ar":"بازوكا كلاسيك","name_en":"Bazooka Classic","price":120,"description_ar":"فراخ كرسبي",
         "options":[{"label_ar":"الحجم","required":true,"choices":[{"name_ar":"سينجل"},{"name_ar":"دبل","price_delta":45}]}]},
        {"name_ar":"زنجر","price":110}]},
      {"name_ar":"مشروبات","items":[{"name_ar":"كوكاكولا","price":25}]}]}'::jsonb, 'merge');
  assert (r ->> 'items_created')::int = 3 and (r ->> 'categories_created')::int = 2, r::text;
  assert (select code from everwake.menu_items where tenant_id = t and name_ar = 'بازوكا كلاسيك') = 'M001', 'codes per restaurant';
  -- publishing again updates instead of duplicating; replace archives what is gone
  r := everwake.publish_menu(t, '{"categories":[{"name_ar":"ساندوتشات","items":[{"name_ar":"بازوكا كلاسيك","price":130},{"name_ar":"زنجر","price":110}]}]}'::jsonb, 'replace');
  assert (r ->> 'items_updated')::int = 2 and (r ->> 'items_archived')::int = 1, r::text;
  assert (select price from everwake.menu_items where tenant_id = t and name_ar = 'بازوكا كلاسيك') = 130;
  assert (select count(*) from everwake.menu_option_groups g join everwake.menu_items i on i.id = g.item_id where i.tenant_id = t) = 1,
         'choices kept when the import has none';

  r := everwake.onboarding_checklist(t);
  assert not (r ->> 'ready')::boolean, 'no branch, no WhatsApp: not ready';
  r := everwake.go_live(t);
  assert not (r ->> 'live')::boolean;
end $$;

-- the restaurant's own schema of views exists (checked as the database owner)
reset role;
do $$
begin
  assert exists (select 1 from information_schema.views where table_schema = 'r_bazooka' and table_name = 'orders');
  assert exists (select 1 from information_schema.views where table_schema = 'r_bazooka' and table_name = 'conversation_state');
  assert (select count(*) from r_bazooka.menu_items) = 3;
  assert (select count(*) from r_nile_grill.menu_items) = 11;
  assert not exists (select 1 from information_schema.columns where table_schema = 'r_nile_grill'
                      and table_name = 'whatsapp_channels' and column_name = 'api_key'), 'no secrets in the views';
end $$;

-- the agent's menu follows a stock switch on the next turn
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
declare
  t uuid := (select id from everwake.tenants where slug = 'nile_grill');
  item uuid := (select id from everwake.menu_items where tenant_id = t and code = 'M001');
  zam uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  r jsonb; n int;
begin
  assert everwake.member_role(t) = 'staff';
  -- staff may switch stock and the agent, and move orders …
  r := everwake.set_item_availability(item, false, zam, now() + interval '3 hours');
  -- … but not change prices
  update everwake.menu_items set price = 1 where id = item;
  get diagnostics n = row_count;
  assert n = 0, 'staff cannot change prices';
  begin
    perform everwake.publish_menu(t, '{"categories":[]}'::jsonb);
    assert false, 'staff cannot publish a menu';
  exception when insufficient_privilege then null;
  end;
  -- the engine never runs as a dashboard user
  begin
    perform everwake.intake('{}'::jsonb);
    assert false, 'dashboard users cannot call the engine';
  exception when insufficient_privilege then null;
  end;
  -- secrets are not readable
  begin
    perform api_key from everwake.whatsapp_channels;
    assert false, 'api_key readable';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare
  t uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam text := (select id::text from everwake.branches where tenant_id = t and code = 'zamalek');
  ctx jsonb;
begin
  ctx := everwake.turn_context(t, '201400400400');
  assert ctx -> 'branch_lookup' -> 'branch' ->> 'code' = 'zamalek';
  assert ctx ->> 'menu_digest' like '%M001 كفتة مشوية (Grilled Kofta) — 480ج للكيلو ★ · خلصان لحد%', 'sold out shows: ' || left(ctx ->> 'menu_digest', 200);
  assert (ctx -> 'branch_lookup' -> 'items' -> 'M001' ->> 'sold_out_until') is not null;
  assert (select valid_until from everwake.menu_snapshot where tenant_id = t and scope = zam) is not null, 'rebuilds when it expires';
  assert exists (select 1 from everwake.audit_log where tenant_id = t and entity = 'menu_item_branches'
                  and user_id = '33333333-3333-3333-3333-333333333333'), 'the change is in the audit log';

  -- reports
  ctx := everwake.analytics(t, now() - interval '1 day', now() + interval '1 day');
  assert (ctx ->> 'orders')::int = 1 and (ctx ->> 'revenue')::numeric = 567.2, ctx::text;
  assert (ctx ->> 'commission_saved')::numeric = 141.8, 'commission at 25%: ' || (ctx ->> 'commission_saved');
  assert ctx -> 'top_items' -> 0 ->> 'name' = 'فرخة مشوية';

  -- housekeeping runs clean
  ctx := everwake.housekeeping();
  assert ctx ? 'takeovers_released';
end $$;
