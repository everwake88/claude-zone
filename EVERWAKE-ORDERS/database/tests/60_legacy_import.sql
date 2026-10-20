-- An old one-schema-per-brand client (Seagull style) moved onto the platform
\ir fixtures/legacy_seagull.sql

do $$
declare
  t     uuid;
  r     jsonb;
  ctx   jsonb;
  omar  bigint;
  mona  bigint;
  elmax uuid;
  gleem uuid;
begin
  insert into everwake.tenants (slug, name_ar, name_en) values ('seagull_move', 'سيجال', 'Seagull') returning id into t;
  r := everwake.import_legacy_schema(t, 'legacy_sg');

  assert r ->> 'run' = 'first', r::text;
  assert (r ->> 'branches')::int = 2, r::text;
  assert (r ->> 'delivery_circles_created')::int = 2, r::text;
  assert (r ->> 'dishes')::int = 3, r::text;
  assert (r ->> 'orders_imported')::int = 4, 'every finished order; the draft stays behind: ' || r::text;
  assert (r ->> 'messages')::int = 3, 'the last 90 days only: ' || r::text;
  assert (r ->> 'menu_pages')::int = 2, 'a page without a web address is skipped: ' || r::text;
  assert r ->> 'order_no_next' = 'SG-1044', 'numbering carries on: ' || r::text;
  assert (r -> 'check_next')::text like '%opening hours%', 'Gleem has no hours: ' || r::text;

  -- branches and their delivery circles
  select id into elmax from everwake.branches where tenant_id = t and code = 'el_max';
  select id into gleem from everwake.branches where tenant_id = t and code = 'gleem';
  assert elmax is not null and gleem is not null;
  assert (select hours -> 'default' -> 0 ->> 'open' from everwake.branches where id = elmax) = '12:00';
  assert (select delivery_fee = 30 and min_order = 200 and vat_percent = 14 and ops_whatsapp = '201555000222'
            from everwake.branches where id = elmax);
  assert (select radius_km from everwake.delivery_zones where branch_id = elmax) = 6, 'the branch''s own limit';
  assert (select radius_km from everwake.delivery_zones where branch_id = gleem) = 8, 'the old platform-wide limit';

  -- the menu: same codes, choice levels, each branch's differences
  assert (select unit = 'kg' and qty_step = 0.25 and is_signature and tags = '{fish}' and aliases = '{بورى}'
            from everwake.menu_items where tenant_id = t and code = 'M001');
  assert (select count(*) from everwake.menu_option_groups g join everwake.menu_items i on i.id = g.item_id
           where i.tenant_id = t and i.code = 'M001') = 2;
  assert (select g.required and g.min_select = 1 and g.max_select = 1
            from everwake.menu_option_groups g join everwake.menu_items i on i.id = g.item_id
           where i.tenant_id = t and i.code = 'M001' and g.level = 1);
  assert (select extra_charge from everwake.menu_options where tenant_id = t and name_ar = 'طاجن');
  assert (select price_delta = 20 and aliases = '{سنجارى}' from everwake.menu_options where tenant_id = t and name_ar = 'سنجاري');
  assert not (select is_available from everwake.menu_items where tenant_id = t and code = 'M026');
  assert (select mb.price from everwake.menu_item_branches mb join everwake.menu_items i on i.id = mb.item_id
           where i.tenant_id = t and i.code = 'M001' and mb.branch_id = gleem) = 450, 'Gleem''s own price';
  assert not (select mb.is_listed from everwake.menu_item_branches mb join everwake.menu_items i on i.id = mb.item_id
               where i.tenant_id = t and i.code = 'M026' and mb.branch_id = gleem), 'Gleem does not sell it';
  assert not exists (select 1 from everwake.menu_item_branches mb join everwake.menu_items i on i.id = mb.item_id
                      where i.tenant_id = t and i.code = 'M002'), 'no row where nothing differs';
  assert not exists (select 1 from everwake.menu_item_branches mb join everwake.menu_items i on i.id = mb.item_id
                      where i.tenant_id = t and i.code = 'M026' and mb.branch_id = elmax),
         'sold out everywhere is the dish''s own switch, not a branch mark';
  assert (r ->> 'branch_menu_differences')::int = 2, r::text;
  assert (select item_seq from everwake.tenants where id = t) >= 26, 'the next new dish is M027';
  assert (select count(*) from everwake.menu_media where tenant_id = t and branch_id = elmax) = 1;
  -- the agent reads it on its next message
  assert (select lookup -> 'items' ? 'M001' from everwake.menu_snapshot where tenant_id = t and scope = 'all');
  assert (select lookup -> 'items' -> 'M001' ->> 'price' from everwake.menu_snapshot
           where tenant_id = t and scope = gleem::text)::numeric = 450;

  -- what the agent knows and how the restaurant works
  assert (select profile -> 'agent_name' ->> 'ar' from everwake.tenants where id = t) = 'سلمى';
  assert (select profile -> 'brand_facts' from everwake.tenants where id = t) = '["سمك طازة كل يوم", "من سنة ١٩٩٠"]'::jsonb;
  assert (select profile -> 'contacts' ->> 'hotline' = '19999' and profile -> 'contacts' ->> 'complaints' = '201555000333'
            from everwake.tenants where id = t);
  assert (select settings -> 'payment_methods' from everwake.tenants where id = t) = '["cash", "instapay"]'::jsonb;
  assert (select settings ->> 'ops_whatsapp' from everwake.tenants where id = t) = '201555000111';
  assert (select order_no_prefix from everwake.tenants where id = t) = 'SG';

  -- customers: by number, and by private id
  select id into omar from everwake.customers where tenant_id = t and wa_id = '201011111111';
  select id into mona from everwake.customers where tenant_id = t and wa_id = '123456789012345';
  assert (select not phone_hidden and phone = '201011111111' and full_name = 'عمر حسن' and display_name = 'Omar'
            from everwake.customers where id = omar);
  assert (select phone_hidden and lid = '123456789012345' and reply_to = '123456789012345@lid'
            from everwake.customers where id = mona), 'the old messages showed a private id';
  assert (select customer_id from everwake.customer_identities
           where tenant_id = t and kind = 'phone' and value = '01022222222') = mona, 'the number she typed is hers';
  assert (select orders_count = 2 and total_spent = 1005 from everwake.customers where id = omar), 'a cancelled order does not count';

  -- orders: finished, itemised, nothing ringing on the board
  assert (select status from everwake.orders where tenant_id = t and order_no = 'SG-1040') = 'picked_up';
  assert (select status from everwake.orders where tenant_id = t and order_no = 'SG-1041') = 'delivered';
  assert (select status from everwake.orders where tenant_id = t and order_no = 'SG-1042') = 'delivered';
  assert (select status from everwake.orders where tenant_id = t and order_no = 'SG-1043') = 'cancelled';
  assert (select payment_method from everwake.orders where tenant_id = t and order_no = 'SG-1042') = 'instapay';
  assert not exists (select 1 from everwake.orders where tenant_id = t
                      and status in ('draft', 'placed', 'accepted', 'preparing', 'ready', 'out_for_delivery'));
  assert (select oi.item_id is not null and oi.quantity = 1.5 and oi.line_total = 675 and oi.notes = 'من غير شطة'
            from everwake.order_items oi join everwake.orders o on o.id = oi.order_id
           where o.tenant_id = t and o.order_no = 'SG-1041' and oi.item_code = 'M001');

  -- the agent remembers them
  ctx := everwake.turn_context(t, '201011111111');
  assert ctx -> 'last_orders' -> 0 ->> 'order_no' = 'SG-1041', ctx -> 'last_orders';
  assert (ctx -> 'customer' ->> 'orders_count')::int = 2;
  assert ctx -> 'saved_addresses' -> 0 ->> 'zone_id' = (select id::text from everwake.delivery_zones where branch_id = elmax),
         'the old pin falls in El Max''s circle';
  assert jsonb_array_length(ctx -> 'recent_messages') = 2;
  ctx := everwake.cart_context(t, '201011111111', '__last_order__');
  assert ctx ->> 'requested_branch_id' = elmax::text;
  assert ctx -> 'last_order' -> 'items' -> 0 ->> 'code' = 'M001';
  assert ctx -> 'last_order' -> 'items' -> 0 -> 'choices' -> 1 -> 'selected' -> 0 ->> 'name' = 'رز';
  ctx := everwake.turn_context(t, '123456789012345');
  assert ctx -> 'last_orders' -> 0 ->> 'order_no' = 'SG-1042';
  assert ctx -> 'saved_addresses' -> 0 ->> 'street' = 'أبو قير';
  assert (select last_message_preview from everwake.conversations where tenant_id = t and wa_id = '201011111111') = 'أهلاً يا عمر';

  -- what the restaurant sets itself survives a second run
  update everwake.tenants set settings = settings || '{"payment_methods": ["cash", "card"]}',
                              profile = profile || '{"agent_name": {"ar": "نور", "en": "Nour"}}'
   where id = t;
  r := everwake.import_legacy_schema(t, 'legacy_sg');
  assert r ->> 'run' = 'refresh';
  assert (r ->> 'orders_imported')::int = 0 and (r ->> 'orders_skipped')::int = 4, r::text;
  assert (r ->> 'messages')::int = 0 and (r ->> 'delivery_circles_created')::int = 0 and (r ->> 'menu_pages')::int = 0, r::text;
  assert (select count(*) from everwake.menu_items where tenant_id = t) = 3;
  assert (select count(*) from everwake.customers where tenant_id = t) = 2;
  assert (select count(*) from everwake.messages where tenant_id = t) = 3;
  assert (select count(*) from everwake.customer_addresses where tenant_id = t) = 2;
  assert (select use_count from everwake.customer_addresses where customer_id = omar) = 1;
  assert (select count(*) from everwake.menu_option_groups where tenant_id = t) = 2;
  assert (select settings -> 'payment_methods' from everwake.tenants where id = t) = '["cash", "card"]'::jsonb;
  assert (select profile -> 'agent_name' ->> 'ar' from everwake.tenants where id = t) = 'نور';
end $$;

-- a restaurant that already has a menu is not overwritten, and nothing is written
do $$
declare
  t uuid := (select id from everwake.tenants where slug = 'nile_grill');
  n int := (select count(*) from everwake.branches where tenant_id = t);
begin
  begin
    perform everwake.import_legacy_schema(t, 'legacy_sg');
    assert false, 'a restaurant with a menu is protected';
  exception when raise_exception then
    assert sqlerrm like '%already has a menu%', sqlerrm;
  end;
  assert (select count(*) from everwake.branches where tenant_id = t) = n;

  begin
    perform everwake.import_legacy_schema(t, 'no_such_schema');
    assert false, 'a missing schema is reported';
  exception when raise_exception then
    assert sqlerrm like '%not in this database%', sqlerrm;
  end;
end $$;

-- only the database owner can run it
do $$
begin
  assert not has_function_privilege('authenticated', 'everwake.import_legacy_schema(uuid, text, jsonb)', 'execute');
  assert not has_function_privilege('anon', 'everwake.import_legacy_schema(uuid, text, jsonb)', 'execute');
end $$;

drop schema legacy_sg cascade;
