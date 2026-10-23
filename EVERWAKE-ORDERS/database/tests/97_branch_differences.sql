-- Branches that differ: one branch's menu edited many dishes at a time (on/off,
-- prices by %, amount or reset, choice prices with them), categories only some
-- branches serve, a branch set up like another or back to the restaurant's menu,
-- a menu imported for one branch, the branches' choice prices kept when a dish's
-- choices are saved again, seating (dine-in) and each branch's payment methods.

reset role;
select set_config('request.jwt.claims', '', false);
insert into everwake.tenant_members (tenant_id, user_id, role, email, display_name)
select id, '11111111-1111-1111-1111-111111111111', 'owner', 'owner@nile.example', 'Owner' from everwake.tenants where slug = 'nile_grill'
on conflict do nothing;
insert into everwake.tenant_members (tenant_id, user_id, role, email, display_name)
select id, '33333333-3333-3333-3333-333333333333', 'staff', 'cashier@nile.example', 'Cashier' from everwake.tenants where slug = 'nile_grill'
on conflict do nothing;

create or replace function pg_temp.lk(p_tenant uuid, p_scope text) returns jsonb language plpgsql as $$
begin
  perform everwake.ensure_snapshot(p_tenant);
  return (select lookup from everwake.menu_snapshot where tenant_id = p_tenant and scope = p_scope);
end $$;
create or replace function pg_temp.digest(p_tenant uuid, p_scope text) returns text language plpgsql as $$
begin
  perform everwake.ensure_snapshot(p_tenant);
  return (select digest_text from everwake.menu_snapshot where tenant_id = p_tenant and scope = p_scope);
end $$;
create or replace function pg_temp.code(p_tenant uuid, p_name text) returns text language sql as $$
  select code from everwake.menu_items where tenant_id = p_tenant and name_ar = p_name
$$;
create or replace function pg_temp.item(p_tenant uuid, p_name text) returns uuid language sql as $$
  select id from everwake.menu_items where tenant_id = p_tenant and name_ar = p_name
$$;
create or replace function pg_temp.choice_price(p_lookup jsonb, p_code text, p_level int, p_name text) returns numeric language sql as $$
  select (o ->> 'price')::numeric
    from jsonb_array_elements(p_lookup -> 'choices' -> p_code -> 'levels') l, jsonb_array_elements(l -> 'options') o
   where (l ->> 'level')::int = p_level and o ->> 'name' = p_name
$$;

-- ---- one branch's menu, many dishes at a time -------------------------------------------------
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"owner@nile.example"}', false);
do $$
declare
  t     uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam   uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  maadi uuid := (select id from everwake.branches where tenant_id = t and code = 'maadi');
  r jsonb;
begin
  -- the sandwiches are not made in Maadi
  r := everwake.branch_menu_update(t, maadi, jsonb_build_object('items', jsonb_build_array(pg_temp.item(t, 'ساندوتش كفتة'), pg_temp.item(t, 'ساندوتش شاورما فراخ')),
                                                                'listed', false));
  assert (r ->> 'items')::int = 2, r::text;
  -- Zamalek is 10% dearer than the restaurant's prices, choices too, to the pound
  r := everwake.branch_menu_update(t, zam, jsonb_build_object('items', jsonb_build_array(pg_temp.item(t, 'كفتة مشوية'), pg_temp.item(t, 'فرخة مشوية')),
                                                              'price', jsonb_build_object('mode', 'percent', 'value', 10, 'from', 'restaurant', 'round', 1)));
  assert (r ->> 'items')::int = 2 and (r ->> 'choices')::int = 4, 'two dishes and the four choices with a price: ' || r::text;
  -- Maadi's fries 5 more; its pepsi out of stock
  r := everwake.branch_menu_update(t, maadi, jsonb_build_object('items', jsonb_build_array(pg_temp.item(t, 'بطاطس محمرة')),
                                                                'price', jsonb_build_object('mode', 'amount', 'value', 5)));
  r := everwake.branch_menu_update(t, maadi, jsonb_build_object('items', jsonb_build_array(pg_temp.item(t, 'بيبسي')), 'available', false));
  -- a % of a price the branch confirms moves nothing; bad input is refused
  begin
    r := everwake.branch_menu_update(t, maadi, '{"items": [], "price": {"mode": "percent"}}');
    assert false, 'a % without a value is refused';
  exception when raise_exception then null;
  end;
  begin
    r := everwake.branch_menu_update(t, maadi, '{"items": [], "price": {"mode": "double"}}');
    assert false, 'unknown price mode';
  exception when raise_exception then null;
  end;
  -- the drinks are served in Zamalek only
  update everwake.menu_categories set branch_ids = array[zam] where tenant_id = t and name_ar = 'مشروبات';
end $$;

-- the cashier keeps the stock switches, not the menu
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
declare t uuid := (select id from everwake.tenants where slug = 'nile_grill');
        maadi uuid := (select id from everwake.branches where tenant_id = t and code = 'maadi');
begin
  begin
    perform everwake.branch_menu_update(t, maadi, '{"items": [], "listed": false}');
    assert false, 'staff cannot change a branch''s menu';
  exception when others then
    assert sqlerrm not like 'assertion%', sqlerrm;
  end;
  begin
    perform everwake.copy_branch_menu(t, null, maadi);
    assert false, 'staff cannot reset a branch''s menu';
  exception when others then
    assert sqlerrm not like 'assertion%', sqlerrm;
  end;
end $$;

reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare
  t     uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam   uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  maadi uuid := (select id from everwake.branches where tenant_id = t and code = 'maadi');
  lz jsonb := pg_temp.lk(t, zam::text);
  lm jsonb := pg_temp.lk(t, maadi::text);
  la jsonb := pg_temp.lk(t, 'all');
  chicken text := pg_temp.code(t, 'فرخة مشوية');
begin
  assert (lz -> 'items' -> pg_temp.code(t, 'كفتة مشوية') ->> 'price')::numeric = 528, lz -> 'items' -> pg_temp.code(t, 'كفتة مشوية');
  assert (lz -> 'items' -> chicken ->> 'price')::numeric = 286;
  assert pg_temp.choice_price(lz, chicken, 1, 'فرخة كاملة') = 242, 'Zamalek''s whole chicken';
  assert pg_temp.choice_price(lz, chicken, 3, 'بطاطس') = 39 and pg_temp.choice_price(lz, chicken, 3, 'طحينة') = 28, 'rounded to the pound';
  assert pg_temp.choice_price(lm, chicken, 1, 'فرخة كاملة') = 220, 'Maadi keeps the restaurant''s choice prices';
  assert (lm -> 'items' -> chicken ->> 'price')::numeric = 270, 'Maadi''s own chicken price stays';
  assert pg_temp.digest(t, zam::text) like '%فرخة كاملة +242ج%', 'the model reads Zamalek''s choice price';
  assert not (lm -> 'items' ? pg_temp.code(t, 'ساندوتش كفتة')) and lz -> 'items' ? pg_temp.code(t, 'ساندوتش كفتة'), 'sandwiches: Zamalek only';
  assert (lm -> 'items' -> pg_temp.code(t, 'بطاطس محمرة') ->> 'price')::numeric = 40;
  assert not (lm -> 'items' ? pg_temp.code(t, 'بيبسي')), 'drinks are not served in Maadi';
  assert lz -> 'items' ? pg_temp.code(t, 'بيبسي') and (lz -> 'items' -> pg_temp.code(t, 'بيبسي') ->> 'available')::boolean;
  assert la -> 'items' -> pg_temp.code(t, 'ساندوتش كفتة') -> 'branches' = '["zamalek"]'::jsonb, la -> 'items' -> pg_temp.code(t, 'ساندوتش كفتة');
  assert pg_temp.digest(t, 'all') like '%ساندوتش كفتة%متاح في: الزمالك%';
  -- nothing changed for the restaurant
  assert (select price from everwake.menu_items where id = pg_temp.item(t, 'كفتة مشوية')) = 480;
  assert exists (select 1 from everwake.audit_log where tenant_id = t and entity = 'menu_option_branches'), 'choice prices are audited';
end $$;

-- ---- reset, copy, choices kept, import for one branch -----------------------------------------
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"owner@nile.example"}', false);
do $$
declare
  t     uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam   uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  maadi uuid := (select id from everwake.branches where tenant_id = t and code = 'maadi');
  chicken uuid := pg_temp.item(t, 'فرخة مشوية');
  r jsonb; g jsonb;
begin
  -- Zamalek's kofta back at the restaurant price; its chicken keeps +10%
  r := everwake.branch_menu_update(t, zam, jsonb_build_object('items', jsonb_build_array(pg_temp.item(t, 'كفتة مشوية')), 'price', '{"mode": "reset"}'::jsonb));
  assert not exists (select 1 from everwake.menu_item_branches where branch_id = zam and item_id = pg_temp.item(t, 'كفتة مشوية')),
         'a row that changes nothing is removed';

  -- saving the chicken's choices again (the marinade question renamed) keeps Zamalek's choice prices
  select jsonb_agg(jsonb_build_object('label_ar', case when grp.level = 2 then 'التتبيلة اللي تحبها' else grp.label_ar end,
                                      'required', grp.required, 'min', grp.min_select, 'max', grp.max_select,
                                      'options', (select jsonb_agg(jsonb_build_object('name_ar', o.name_ar, 'price_delta', o.price_delta) order by o.sort)
                                                    from everwake.menu_options o where o.group_id = grp.id)) order by grp.level)
    into g from everwake.menu_option_groups grp where grp.item_id = chicken;
  perform everwake.save_item_choices(chicken, g);
  assert (select count(*) from everwake.menu_option_branches where item_id = chicken and branch_id = zam and price_delta is not null) = 4,
         'Zamalek''s four choice prices survive saving the choices';

  -- Maadi set up like Zamalek: sandwiches and drinks come in, the chicken costs Zamalek's
  r := everwake.copy_branch_menu(t, zam, maadi);
  assert (r ->> 'categories')::int = 1, r::text;
  assert (select price from everwake.menu_item_branches where branch_id = maadi and item_id = chicken) = 286;
  assert (select count(*) from everwake.menu_option_branches where branch_id = maadi and item_id = chicken) = 4;
  assert (select maadi = any(branch_ids) from everwake.menu_categories where tenant_id = t and name_ar = 'مشروبات');
  assert not (select is_available from everwake.menu_item_branches where branch_id = maadi and item_id = pg_temp.item(t, 'بيبسي')),
         'Maadi''s stock switch is its own';

  -- and back to the restaurant's menu
  r := everwake.copy_branch_menu(t, null, maadi);
  assert not exists (select 1 from everwake.menu_item_branches where branch_id = maadi and (not is_listed or price is not null));
  assert not exists (select 1 from everwake.menu_option_branches where branch_id = maadi);
  begin
    perform everwake.copy_branch_menu(t, maadi, maadi);
    assert false, 'a branch cannot copy itself';
  exception when raise_exception then null;
  end;

  -- Maadi's own printed menu, imported for Maadi only
  r := everwake.publish_menu(t, '{"categories": [{"name_ar": "مشويات", "items": [
            {"name_ar": "فرخة مشوية", "price": 275, "options": [{"label_ar": "الحجم", "required": true,
               "choices": [{"name_ar": "نص فرخة", "price_delta": 0}, {"name_ar": "فرخة كاملة", "price_delta": 230}]}]},
            {"name_ar": "كفتة مشوية", "price": 480, "unit": "kg"},
            {"name_ar": "حمام محشي", "price": 180}]},
          {"name_ar": "حلويات", "items": [{"name_ar": "أم علي", "price": 60}]}]}', 'replace', null, maadi);
  assert (r ->> 'items_created')::int = 2 and (r ->> 'items_updated')::int = 2 and (r ->> 'items_archived')::int = 0, r::text;
  assert (r ->> 'items_unlisted')::int >= 8 and (r ->> 'choice_prices')::int = 2, r::text;
end $$;

reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare
  t     uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam   uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  maadi uuid := (select id from everwake.branches where tenant_id = t and code = 'maadi');
  lz jsonb := pg_temp.lk(t, zam::text);
  lm jsonb := pg_temp.lk(t, maadi::text);
  chicken text := pg_temp.code(t, 'فرخة مشوية');
begin
  assert (select array(select jsonb_object_keys(lm -> 'items') order by 1))
         = array(select code from everwake.menu_items where tenant_id = t and name_ar in ('فرخة مشوية', 'كفتة مشوية', 'حمام محشي', 'أم علي') order by 1),
         'Maadi''s menu is exactly its printed menu: ' || (lm -> 'items')::text;
  assert (lm -> 'items' -> chicken ->> 'price')::numeric = 275 and pg_temp.choice_price(lm, chicken, 1, 'فرخة كاملة') = 230;
  assert (lz -> 'items' -> chicken ->> 'price')::numeric = 286 and pg_temp.choice_price(lz, chicken, 1, 'فرخة كاملة') = 242, 'Zamalek untouched';
  assert not (lz -> 'items' ? pg_temp.code(t, 'حمام محشي')) and not (lz -> 'items' ? pg_temp.code(t, 'أم علي')), 'new dishes: Maadi only';
  assert (select branch_ids from everwake.menu_categories where tenant_id = t and name_ar = 'حلويات') = array[maadi], 'a new category: Maadi only';
  assert (select price from everwake.menu_items where tenant_id = t and name_ar = 'فرخة مشوية') = 260, 'the restaurant price stays';
  assert (select count(*) from everwake.menu_items where tenant_id = t and not is_active) = 0, 'nothing archived';
  -- Maadi's kofta came at the restaurant's price: no override
  assert (select price is null and is_listed from everwake.menu_item_branches where branch_id = maadi and item_id = pg_temp.item(t, 'كفتة مشوية'));
end $$;

-- ---- seating (dine-in) -------------------------------------------------------------------------
do $$
declare
  t     uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam   uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  maadi uuid := (select id from everwake.branches where tenant_id = t and code = 'maadi');
  shisha text := pg_temp.code(t, 'شيشة');
  la jsonb; r jsonb;
  wa text := '201444700001';
begin
  perform everwake.copy_branch_menu(t, null, maadi);
  update everwake.menu_categories set branch_ids = null where tenant_id = t;
  create temp table _rsv on commit drop as select id, reservations from everwake.branches where tenant_id = t;
  update everwake.branches set dine_in = true where id = zam;
  begin
    update everwake.branches set dine_in = false where id = maadi;     -- it takes bookings by phone
    assert false, 'a branch that takes bookings has seating';
  exception when check_violation then null;
  end;
  update everwake.branches set dine_in = false, reservations = 'off' where id = maadi;
  la := pg_temp.lk(t, 'all');
  assert la -> 'items' -> shisha -> 'branches' = '["zamalek"]'::jsonb, 'a dine-in only dish is not where there is no seating';
  assert pg_temp.lk(t, zam::text) -> 'items' ? shisha;
  assert (select (b ->> 'dine_in')::boolean = false from jsonb_array_elements(la -> 'branches') b where b ->> 'code' = 'maadi');
  -- no seating, no table bookings
  begin
    update everwake.branches set reservations = 'whatsapp' where id = maadi;
    assert false, 'bookings need seating';
  exception when check_violation then null;
  end;
  update everwake.branches set reservations = 'whatsapp' where id = zam;
  perform everwake.intake(jsonb_build_object('instance', 'nilegrill', 'token', 'demo-token', 'external_id', 'bd1', 'wa_id', wa, 'phone', wa,
                                             'push_name', 'Hoda', 'text', 'عايزة أحجز في المعادي'));
  r := everwake.reservation_tool(t, wa, 'update', '{"branch": "المعادي"}');
  assert exists (select 1 from jsonb_array_elements(r -> 'problems') p where p ->> 'problem' = 'NO_BOOKINGS_AT_THIS_BRANCH'
                  and (p ->> 'no_seating')::boolean), r::text;
  update everwake.branches set dine_in = null where tenant_id = t;
  update everwake.branches b set reservations = x.reservations from _rsv x where x.id = b.id;
end $$;

-- ---- each branch's payment methods ------------------------------------------------------------------
do $$
declare
  t     uuid := (select id from everwake.tenants where slug = 'nile_grill');
  zam   uuid := (select id from everwake.branches where tenant_id = t and code = 'zamalek');
  maadi uuid := (select id from everwake.branches where tenant_id = t and code = 'maadi');
  la jsonb; d jsonb;
begin
  update everwake.tenants set settings = settings || '{"payment_methods": ["cash", "card", "instapay"]}' where id = t;
  update everwake.payment_accounts set enabled = false where tenant_id = t;
  update everwake.branches set payment_methods = array['cash', 'online'] where id = maadi;
  assert everwake.payment_methods_at(t, zam) = '["cash", "card", "instapay"]'::jsonb, 'Zamalek: the restaurant''s';
  assert everwake.payment_methods_at(t, maadi) = '["cash"]'::jsonb, 'no Paymob, no online: ' || everwake.payment_methods_at(t, maadi)::text;
  update everwake.payment_accounts set enabled = true where tenant_id = t;
  assert everwake.payment_methods_at(t, maadi) = '["cash", "online"]'::jsonb;
  assert everwake.payment_methods_at(t) = '["cash", "card", "instapay", "online"]'::jsonb, 'no branch yet: what any branch takes';
  update everwake.branches set payment_methods = array['online'] where id = maadi;
  update everwake.payment_accounts set enabled = false where tenant_id = t;
  assert everwake.payment_methods_at(t, maadi) = '["cash", "card", "instapay"]'::jsonb, 'nothing left: the restaurant''s list';
  begin
    update everwake.branches set payment_methods = '{}' where id = maadi;
    assert false, 'an empty list is refused';
  exception when check_violation then null;
  end;
  begin
    update everwake.branches set payment_methods = array['bitcoin'] where id = maadi;
    assert false, 'an unknown method is refused';
  exception when check_violation then null;
  end;
  update everwake.branches set payment_methods = array['cash'] where id = maadi;
  la := pg_temp.lk(t, 'all');
  assert (select b -> 'payment_methods' = '["cash"]'::jsonb and (b ->> 'own_payment_methods')::boolean
            from jsonb_array_elements(la -> 'branches') b where b ->> 'code' = 'maadi'), la -> 'branches';
  d := everwake.details_context(t, '201444700001');
  assert d -> 'payment_methods_by_branch' ->> maadi::text = '["cash"]'
     and d -> 'payment_methods_by_branch' -> zam::text = '["cash", "card", "instapay"]'::jsonb, d -> 'payment_methods_by_branch';

  -- back as the other tests found it
  update everwake.branches set payment_methods = null where tenant_id = t;
  update everwake.payment_accounts set enabled = true where tenant_id = t;
end $$;
