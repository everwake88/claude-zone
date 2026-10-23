-- An old engine that kept the menu in each branch's copy (the real Seagull shape):
-- the "all" copy only names each dish with a price range; descriptions, weights and
-- choices live per branch, and the choices differ (sizes at some branches only).
-- One dish per code, the price most branches charge, each branch its own price, one
-- tree of choices with what a branch lacks switched off there, the old order prefix.

drop schema if exists legacy_v2 cascade;
create schema legacy_v2;
create table legacy_v2.branches (id text primary key, sort int, name_ar text, name_en text, lat double precision, lng double precision,
  hours jsonb, accepting_orders boolean, seasonal boolean, vat_percent numeric);
insert into legacy_v2.branches values
  ('elmax', 1, 'المكس', 'El Max', 31.14, 29.83, '{"default": {"open": "12:00", "close": "01:00"}}', true, false, null),
  ('dokki', 2, 'الدقي', 'Dokki', 30.04, 31.22, '{"default": {"open": "09:00", "close": "02:00"}}', true, false, 14),
  ('marina', 3, 'مارينا', 'Marina', 30.82, 29.03, '{"default": {"open": "13:00", "close": "01:00"}}', false, true, 14);
create table legacy_v2.menu_snapshot (id text primary key, lookup jsonb);
insert into legacy_v2.menu_snapshot values
  ('all', $j${"settings": {"agent_name": {"ar": "ياسمين", "en": "Yasmin"}, "order_no_prefix": "SG",
                           "brand": {"website": "https://seagull.example", "instagram": "@seagull", "tagline_ar": "من البحر لطبقك"},
                           "required_fields": {"delivery": ["phone_confirmed", "full_name", "delivery_method", "address_area"],
                                               "pickup": ["phone_confirmed", "full_name", "delivery_method"]}},
              "items": {"M001": {"name": "شوربة سي فود", "category": "الشوربة", "unit": "portion", "price_min": 270, "price_max": 310},
                        "M008": {"name": "سردين", "category": "أسماك", "unit": "kg", "price_min": 190, "price_max": 190}}}$j$),
  ('elmax', $j${"items": {"M001": {"name": "شوربة سي فود", "desc": "جمبري وسبيط", "category": "الشوربة", "category_en": "Soups",
                                   "unit": "portion", "price_egp": 270, "sort": 1, "tags": ["soup"]},
                          "M008": {"name": "سردين", "category": "أسماك", "unit": "portion", "price_egp": 190, "min_qty": 1, "qty_step": 1, "sort": 2}},
                "choices": {}}$j$),
  ('dokki', $j${"items": {"M001": {"name": "شوربة سي فود", "desc": "جمبري وسبيط (صغير أو كبير)", "category": "الشوربة", "unit": "portion",
                                   "price_egp": 270, "sort": 1},
                          "M008": {"name": "سردين", "category": "أسماك", "unit": "kg", "price_egp": 190, "min_qty": 0.5, "qty_step": 0.25, "sort": 2}},
                "choices": {"M001": {"levels": [{"level": 1, "label_ar": "الحجم", "required": true, "min": 1, "max": 1,
                                                 "options": [{"name": "صغير", "price_egp": 0}, {"name": "كبير", "price_egp": 80}]}]}}}$j$),
  ('marina', $j${"items": {"M001": {"name": "شوربة سي فود", "category": "الشوربة", "unit": "portion", "price_egp": 310, "sort": 1},
                           "M008": {"name": "سردين", "category": "أسماك", "unit": "kg", "price_egp": 190, "min_qty": 0.5, "qty_step": 0.25, "sort": 2}},
                 "choices": {"M001": {"levels": [{"level": 1, "label_ar": "الحجم", "required": true, "min": 1, "max": 1,
                                                  "options": [{"name": "صغير", "price_egp": 0}, {"name": "كبير", "price_egp": 100}]}]}}}$j$);

reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare
  t uuid := everwake.create_tenant('سي جل', 'Seagull', 'seagull_v2', 'EG', 'Africa/Cairo', 'EGP', 'ar');
  r jsonb; lk jsonb;
  b_elmax uuid; b_dokki uuid; b_marina uuid;
begin
  r := everwake.import_legacy_schema(t, 'legacy_v2');
  assert (r ->> 'dishes')::int = 2 and (r ->> 'dishes_with_choices')::int = 1, r::text;
  assert r ->> 'order_no_next' = 'SG-1001', 'the old prefix, not the one made from the name: ' || r::text;
  assert (r -> 'check_next')::text like '%M008 سردين at المكس (portion there)%', r::text;
  select id into b_elmax from everwake.branches where tenant_id = t and code = 'elmax';
  select id into b_dokki from everwake.branches where tenant_id = t and code = 'dokki';
  select id into b_marina from everwake.branches where tenant_id = t and code = 'marina';

  -- the dish: details from a branch's copy, the price most branches charge
  assert (select price = 270 and description_ar = 'جمبري وسبيط' and tags = '{soup}' from everwake.menu_items where tenant_id = t and code = 'M001');
  assert (select unit = 'kg' and qty_step = 0.25 and min_qty = 0.5 from everwake.menu_items where tenant_id = t and code = 'M008'),
         'described by a branch selling it by the kilo';
  assert (select name_en = 'Soups' from everwake.menu_categories where tenant_id = t and name_ar = 'الشوربة');
  assert (select mb.price from everwake.menu_item_branches mb join everwake.menu_items i on i.id = mb.item_id
           where mb.branch_id = b_marina and i.code = 'M001') = 310;
  assert (select seasonal and not accepting_orders from everwake.branches where id = b_marina);

  -- the agent's facts from the old brand block, and what it asks before an order
  assert (select profile ->> 'website' = 'https://seagull.example' and profile ->> 'about_ar' = 'من البحر لطبقك'
            from everwake.tenants where id = t);
  assert (select settings -> 'required_fields' -> 'delivery' ? 'address_area' from everwake.tenants where id = t);

  -- the choices: sizes at Dokki and Marina (Marina's own price), none asked at El Max
  perform everwake.rebuild_snapshot(t);
  lk := (select lookup from everwake.menu_snapshot where tenant_id = t and scope = b_dokki::text);
  assert lk -> 'choices' -> 'M001' -> 'levels' -> 0 -> 'options' @> '[{"name": "كبير", "price": 80}]', lk -> 'choices';
  lk := (select lookup from everwake.menu_snapshot where tenant_id = t and scope = b_marina::text);
  assert lk -> 'choices' -> 'M001' -> 'levels' -> 0 -> 'options' @> '[{"name": "كبير", "price": 100}]', lk -> 'choices';
  lk := (select lookup from everwake.menu_snapshot where tenant_id = t and scope = b_elmax::text);
  assert lk -> 'items' ? 'M001' and not (lk -> 'choices' ? 'M001'), 'El Max sells the soup with no size: ' || (lk -> 'choices')::text;
  assert (select digest_text not like '%الحجم%' from everwake.menu_snapshot where tenant_id = t and scope = b_elmax::text);

  -- running it again changes nothing
  r := everwake.import_legacy_schema(t, 'legacy_v2');
  assert r ->> 'run' = 'refresh' and (select count(*) from everwake.menu_items where tenant_id = t) = 2, r::text;
  assert (select count(*) from everwake.menu_option_branches where tenant_id = t) = 3, 'El Max: both sizes off; Marina: its large';
end $$;
drop schema legacy_v2 cascade;
