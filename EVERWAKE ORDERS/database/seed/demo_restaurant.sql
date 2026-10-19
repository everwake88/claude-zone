-- =====================================================================
-- Everwake Orders · demo restaurant "Nile Grill" (مشويات النيل)
-- Two Cairo branches, delivery zones, a menu with choices, offers, a
-- WhatsApp number. Used by the tests and handy for a sales demo.
-- Safe to run twice: it removes the previous demo first.
-- =====================================================================
delete from everwake.tenants where slug = 'nile_grill';

do $$
declare
  t      uuid;
  zam    uuid;
  maadi  uuid;
  c_grill uuid; c_sand uuid; c_side uuid; c_drink uuid;
  i_kofta uuid; i_chops uuid; i_chicken uuid; i_ksand uuid; i_shawarma uuid; i_rice uuid; i_fries uuid;
  i_tahina uuid; i_pepsi uuid; i_mango uuid; i_shisha uuid;
  g uuid;
begin
  t := everwake.create_tenant('مشويات النيل', 'Nile Grill', 'nile_grill', 'EG', 'Africa/Cairo', 'EGP', 'ar');

  update everwake.tenants set
    status = 'live', live_at = now(), order_no_prefix = 'NG',
    profile = jsonb_build_object(
      'agent_name', jsonb_build_object('ar', 'نور', 'en', 'Nour'),
      'about_ar', 'مشويات النيل: مطعم مشويات مصري من 1998 — كفتة وريش وفراخ على الفحم، وساندوتشات للي مستعجل.',
      'about_en', 'Nile Grill: an Egyptian charcoal grill since 1998 — kofta, lamb chops and chicken, plus quick sandwiches.',
      'cuisine', 'Egyptian grill',
      'tone', 'Warm Egyptian host, short and quick, proud of the charcoal grill.',
      'brand_facts', jsonb_build_array('كل المشويات على الفحم', 'الكفتة والريش بتتوزن بالكيلو', 'بنعمل طلبات حفلات وعزومات بحجز قبلها بيوم'),
      'contacts', jsonb_build_object('hotline', '19999', 'complaints', '01000000099'),
      'website', 'nilegrill.example', 'instagram', 'instagram.com/nilegrill'),
    settings = jsonb_build_object(
      'payment_methods', jsonb_build_array('cash', 'card', 'instapay'),
      'test_numbers', jsonb_build_array('201000000001'),
      'ops_whatsapp', '201000000050',
      'human_auto_release_minutes', 30)
  where id = t;

  insert into everwake.branches (tenant_id, code, name_ar, name_en, aliases, area_ar, address_ar, lat, lng, phone, hours,
                                 hours_text_ar, delivery_fee, min_order, max_delivery_km, vat_percent, price_note_ar,
                                 delivery_eta_text, serves_hint_ar, sort, ops_whatsapp)
  values (t, 'zamalek', 'الزمالك', 'Zamalek', array['zamalek', 'الزمالك فرع'], 'الزمالك', '12 شارع 26 يوليو، الزمالك',
          30.0626, 31.2197, '0227350000',
          '{"default":[{"open":"12:00","close":"02:00"}]}', 'كل يوم من 12 الضهر لـ 2 بالليل',
          30, 150, 6, 14, 'الأسعار من غير ضريبة 14%', '45–60 دقيقة', 'الزمالك، الدقي، المهندسين، جاردن سيتي', 10,
          '201000000051')
  returning id into zam;

  insert into everwake.branches (tenant_id, code, name_ar, name_en, aliases, area_ar, address_ar, lat, lng, phone, hours,
                                 hours_text_ar, delivery_fee, min_order, max_delivery_km, vat_percent, price_note_ar,
                                 delivery_eta_text, serves_hint_ar, sort)
  values (t, 'maadi', 'المعادي', 'Maadi', array['maadi'], 'المعادي', 'شارع 9، المعادي', 29.9602, 31.2569, '0225250000',
          '{"default":[{"open":"13:00","close":"01:00"}],"fri":[{"open":"14:00","close":"01:00"}]}',
          'كل يوم من 1 الضهر لـ 1 بالليل (الجمعة من 2)',
          25, 150, 6, 14, 'الأسعار من غير ضريبة 14%', '40–55 دقيقة', 'المعادي، دجلة، زهراء المعادي', 20)
  returning id into maadi;

  -- zones: a drawn polygon, a radius, and named areas for typed addresses
  insert into everwake.delivery_zones (tenant_id, branch_id, name_ar, name_en, kind, polygon, areas, delivery_fee, min_order, eta_min, eta_max, priority)
  values (t, zam, 'الزمالك', 'Zamalek', 'polygon',
          '[[30.0750,31.2140],[30.0750,31.2290],[30.0480,31.2290],[30.0480,31.2140]]',
          array['الزمالك', 'zamalek'], 20, 150, 30, 45, 10);
  insert into everwake.delivery_zones (tenant_id, branch_id, name_ar, name_en, kind, center_lat, center_lng, radius_km, areas, delivery_fee, min_order, eta_min, eta_max, priority)
  values (t, zam, 'الدقي والمهندسين', 'Dokki & Mohandessin', 'radius', 30.0450, 31.2050, 2.5,
          array['الدقي', 'المهندسين', 'dokki', 'mohandessin'], 35, 200, 40, 60, 20);
  insert into everwake.delivery_zones (tenant_id, branch_id, name_ar, name_en, kind, polygon, areas, delivery_fee, min_order, eta_min, eta_max, priority)
  values (t, maadi, 'المعادي', 'Maadi', 'polygon',
          '[[29.9800,31.2400],[29.9800,31.2800],[29.9450,31.2800],[29.9450,31.2400]]',
          array['المعادي', 'دجلة', 'سرايات المعادي', 'maadi', 'degla'], 25, 150, 30, 50, 10);

  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'مشويات', 'Grills', 10) returning id into c_grill;
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'ساندوتشات', 'Sandwiches', 20) returning id into c_sand;
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'أطباق جانبية', 'Sides', 30) returning id into c_side;
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'مشروبات', 'Drinks', 40) returning id into c_drink;

  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, description_ar, unit, price, qty_step, min_qty, tags, is_signature, sort)
  values (t, c_grill, 'كفتة مشوية', 'Grilled Kofta', array['كفته', 'kofta'], 'كفتة بلدي على الفحم بالبصل والبقدونس', 'kg', 480, 0.25, 0.25, array['grill', 'beef'], true, 10)
  returning id into i_kofta;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, description_ar, unit, price, qty_step, min_qty, tags, sort)
  values (t, c_grill, 'ريش ضاني', 'Lamb Chops', array['ريش', 'lamb chops'], 'ريش ضاني متبلة على الفحم', 'kg', 950, 0.25, 0.5, array['grill', 'lamb'], 20)
  returning id into i_chops;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, description_ar, unit, price, tags, is_featured, sort)
  values (t, c_grill, 'فرخة مشوية', 'Grilled Chicken', array['فراخ مشوية', 'chicken'], 'فرخة على الفحم بالتتبيلة اللي تختارها', 'portion', 260, array['grill', 'chicken'], true, 30)
  returning id into i_chicken;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, unit, price, tags, sort)
  values (t, c_sand, 'ساندوتش كفتة', 'Kofta Sandwich', array['ساندوتش الكفتة'], 'portion', 95, array['sandwich', 'beef'], 10)
  returning id into i_ksand;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, unit, price, tags, sort)
  values (t, c_sand, 'ساندوتش شاورما فراخ', 'Chicken Shawarma Sandwich', array['شاورما', 'shawarma'], 'portion', 85, array['sandwich', 'chicken'], 20)
  returning id into i_shawarma;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, unit, price, tags, sort)
  values (t, c_side, 'أرز بالشعرية', 'Vermicelli Rice', 'portion', 40, array['side'], 10) returning id into i_rice;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, unit, price, tags, sort)
  values (t, c_side, 'بطاطس محمرة', 'French Fries', array['بطاطس', 'fries'], 'portion', 35, array['side'], 20) returning id into i_fries;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, unit, price, tags, sort)
  values (t, c_side, 'سلطة طحينة', 'Tahini Salad', array['طحينة'], 'portion', 25, array['side', 'salad'], 30) returning id into i_tahina;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, unit, price, tags, sort)
  values (t, c_drink, 'بيبسي', 'Pepsi', array['pepsi', 'كانز'], 'portion', 20, array['drink'], 10) returning id into i_pepsi;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, unit, price, tags, sort)
  values (t, c_drink, 'عصير مانجو', 'Mango Juice', 'portion', 45, array['drink', 'juice'], 20) returning id into i_mango;
  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, unit, price, tags, orderable, sort)
  values (t, c_drink, 'شيشة', 'Shisha', 'portion', 80, array['dine_in'], false, 90) returning id into i_shisha;

  -- the chicken: size (required) → marinade (required) → sides (optional, up to 3)
  insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
  values (t, i_chicken, 1, 'الحجم', 'Size', true, 1, 1) returning id into g;
  insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, aliases, price_delta, sort) values
    (t, g, 'نص فرخة', 'Half', array['نص', 'نصف فرخة', 'half'], 0, 10),
    (t, g, 'فرخة كاملة', 'Whole', array['كاملة', 'whole'], 220, 20);
  insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
  values (t, i_chicken, 2, 'التتبيلة', 'Marinade', true, 1, 1) returning id into g;
  insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, aliases, price_delta, sort) values
    (t, g, 'عادي', 'Classic', array['عادية', 'classic'], 0, 10),
    (t, g, 'حار', 'Spicy', array['سبايسي', 'spicy'], 0, 20),
    (t, g, 'ليمون وثوم', 'Lemon & Garlic', array['ليمون', 'lemon'], 0, 30);
  insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
  values (t, i_chicken, 3, 'إضافات', 'Extras', false, 0, 3) returning id into g;
  insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, price_delta, sort) values
    (t, g, 'أرز', 'Rice', 40, 10), (t, g, 'بطاطس', 'Fries', 35, 20), (t, g, 'طحينة', 'Tahini', 25, 30);

  insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
  values (t, i_ksand, 1, 'العيش', 'Bread', false, 0, 1) returning id into g;
  insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, price_delta, sort) values
    (t, g, 'بلدي', 'Baladi', 0, 10), (t, g, 'فينو', 'Fino', 5, 20);

  -- Maadi: its own chicken price, and no lamb chops
  insert into everwake.menu_item_branches (tenant_id, item_id, branch_id, price) values (t, i_chicken, maadi, 270);
  insert into everwake.menu_item_branches (tenant_id, item_id, branch_id, is_listed) values (t, i_chops, maadi, false);

  insert into everwake.item_media (tenant_id, item_id, url) values
    (t, i_kofta, 'https://picsum.photos/seed/kofta/800/600'),
    (t, i_chicken, 'https://picsum.photos/seed/chicken/800/600');
  insert into everwake.menu_media (tenant_id, branch_id, kind, url, position, caption) values
    (t, null, 'image', 'https://picsum.photos/seed/menu1/1200/1600', 1, 'المنيو ١'),
    (t, null, 'image', 'https://picsum.photos/seed/menu2/1200/1600', 2, 'المنيو ٢');

  insert into everwake.offers (tenant_id, title_ar, title_en, description_ar, kind, scope, value, min_subtotal, priority)
  values (t, 'خصم 10% على الطلبات فوق 600ج', '10% off orders over 600', 'خصم 10% على أي طلب واتساب فوق 600ج', 'percent_off', 'order', 10, 600, 10);
  insert into everwake.offers (tenant_id, title_ar, title_en, description_ar, kind, scope, value, min_subtotal, promo_code, stackable, priority)
  values (t, 'كود NILE20', 'Code NILE20', 'خصم 20ج بكود NILE20 على أي طلب فوق 200ج', 'amount_off', 'order', 20, 200, 'NILE20', true, 20);
  insert into everwake.offers (tenant_id, title_ar, title_en, description_ar, kind, scope, item_ids, free_item_id, free_item_qty, stackable, priority)
  values (t, 'بطاطس هدية مع الفرخة', 'Free fries with chicken', 'بطاطس هدية مع أي فرخة مشوية', 'free_item', 'items', array[i_chicken], i_fries, 1, true, 30);

  insert into everwake.knowledge_entries (tenant_id, topic, content_ar, sort) values
    (t, 'الركن', 'فرع الزمالك فيه ركنة قدامه بعد الساعة 6، والمعادي فيه جراج جنب الفرع.', 10),
    (t, 'العزومات', 'طلبات العزومات فوق 10 أفراد تتحجز قبلها بيوم على الخط الساخن 19999.', 20);

  insert into everwake.whatsapp_channels (tenant_id, provider, label, phone_number, instance_name, base_url, api_key, webhook_token, status)
  values (t, 'evolution', 'Main line', '201000000099', 'nilegrill', 'https://evo.example.com/', 'demo-key', 'demo-token', 'connected');

  perform everwake.rebuild_snapshot(t);
end $$;
