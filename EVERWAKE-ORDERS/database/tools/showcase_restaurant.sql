-- =====================================================================
-- Everwake Orders · a showcase restaurant for sales demos
--
-- "بيت المشويات" (Grill House) — a made-up restaurant with three Cairo
-- branches, a full menu, and 30 days of history so every dashboard page
-- has something to show: WhatsApp chats in the agent's own voice, about a
-- thousand orders (some live on the board right now), returning
-- customers, payments, drivers, table bookings, missed sales (carts left,
-- out of the delivery area, written while closed), a complaint and a
-- question waiting for the team.
--
-- Nothing here is a real person or a real restaurant, and nothing can be
-- sent: its WhatsApp number points nowhere. It never touches another
-- restaurant. Run it again at any time to start the history over (it
-- ends "now"). To remove it: delete from everwake.tenants where slug = 'grill_house';
--
-- Run in the Supabase SQL editor. Put YOUR dashboard login below so the
-- restaurant shows up in your restaurant switcher.
-- =====================================================================

create or replace function pg_temp.pick(a text[]) returns text language sql volatile as $$
  select a[1 + floor(random() * array_length(a, 1))::int]
$$;
create or replace function pg_temp.m(n numeric) returns text language sql immutable as $$
  select case when n = trunc(n) then trunc(n)::text else rtrim(rtrim(round(n, 2)::text, '0'), '.') end
$$;
create or replace function pg_temp.qty(q numeric, unit text, name text) returns text language sql immutable as $$
  select case when unit = 'kg' then
           case q when 0.25 then 'ربع ' || name when 0.5 then 'نص كيلو ' || name when 1 then 'كيلو ' || name
                  when 1.5 then 'كيلو ونص ' || name when 2 then '2 كيلو ' || name else pg_temp.m(q) || ' كيلو ' || name end
         else case when q = 1 then name else pg_temp.m(q) || ' ' || name end end
$$;
create or replace function pg_temp.local(p text) returns text language sql immutable as $$
  select '0' || substr(p, 3)
$$;
-- a woman writes as a woman, and the agent talks to her as one
create or replace function pg_temp.fem(lines jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(case when l ->> 0 = 'customer'
      then jsonb_set(l, '{1}', to_jsonb(regexp_replace(regexp_replace(regexp_replace(l ->> 1,
             '(^|\s)عايز(\s|$)', '\1عايزة\2', 'g'), '(^|\s)عاوز(\s|$)', '\1عاوزة\2', 'g'), '(^|\s)هستلم', '\1هستلم', 'g')))
      when l ->> 0 = 'agent'
      then jsonb_set(l, '{1}', to_jsonb(
             regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
             regexp_replace(l ->> 1,
             'بيك(\s|$|،)', 'بيكي\1', 'g'), 'ليك(\s|$|،|!)', 'ليكي\1', 'g'), 'تحب(\s)', 'تحبي\1', 'g'), 'تحبه', 'تحبيه', 'g'),
             'تطلب(\s|؟)', 'تطلبي\1', 'g'), 'تزود(\s)', 'تزودي\1', 'g'), 'هتدفع(\s)', 'هتدفعي\1', 'g'),
             'هتعدي تستلم', 'هتعدّي تستلمي', 'g'), 'ابعتلي', 'ابعتيلي', 'g'), 'محتاج(\s)', 'محتاجة\1', 'g')))
      else l end order by i), '[]'::jsonb)
    from jsonb_array_elements(lines) with ordinality e(l, i)
$$;
-- one chat line; an agent line also leaves the turn's telemetry, like the real engine
create or replace function pg_temp.say(t uuid, conv bigint, wa text, who text, body text, at timestamptz, kind text default 'text')
returns timestamptz language plpgsql as $$
begin
  if at > now() then at := now() - interval '20 seconds'; end if;
  insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, kind, body, status, created_at, sent_at)
  values (t, conv, wa, case when who = 'customer' then 'inbound' else 'outbound' end, who, kind, body,
          case when who = 'customer' then 'received' else 'read' end, at, case when who = 'customer' then null else at end);
  if who = 'agent' then
    insert into everwake.agent_events (tenant_id, wa_id, run_id, stage, order_stage, cart_action, qa_passed, repair_used, llm_calls,
                                       duration_total_ms, duration_llm_ms, prompt_tokens, completion_tokens, cached_tokens,
                                       input, output, created_at)
    values (t, wa, 'run_demo_' || md5(random()::text), 'turn_complete', 'discovery', 'none', true, random() < 0.03,
            2 + floor(random() * 3)::int, 4200 + floor(random() * 7800)::int, 3600 + floor(random() * 6500)::int,
            9000 + floor(random() * 6000)::int, 250 + floor(random() * 700)::int, 6500 + floor(random() * 2000)::int,
            '{}'::jsonb, jsonb_build_object('messages', jsonb_build_array(body)), at);
  end if;
  return at;
end $$;
-- a whole exchange, a natural pause between lines; returns when the last line was sent
create or replace function pg_temp.chat(t uuid, conv bigint, wa text, lines jsonb, start_at timestamptz)
returns timestamptz language plpgsql as $$
declare l jsonb; at timestamptz := start_at;
begin
  for l in select * from jsonb_array_elements(lines) loop
    at := pg_temp.say(t, conv, wa, l ->> 0, l ->> 1, at, coalesce(l ->> 2, 'text'));
    at := at + case when l ->> 0 = 'customer' then make_interval(secs => 7 + floor(random() * 9)::int)
                    else make_interval(secs => 25 + floor(random() * 70)::int) end;
  end loop;
  return at;
end $$;

do $$
declare
  v_owner_email text := '';                 -- ← your dashboard login email
  tz      text := 'Africa/Cairo';
  t       uuid;
  b_nasr  uuid; b_tag uuid; b_zayed uuid;
  z       record;
  br      uuid[]; br_code text[]; br_name text[];
  zones   jsonb := '[]'::jsonb;
  c_grill uuid; c_chick uuid; c_sand uuid; c_tagen uuid; c_side uuid; c_sweet uuid; c_drink uuid;
  i_chicken uuid; g uuid;
  it      record;
  items   jsonb := '[]'::jsonb;              -- [{id, code, name, price, unit, kind}]
  mains   jsonb; sides jsonb; drinks jsonb; sweets jsonb;
  drivers uuid[]; drv_branch uuid[];
  -- people
  m_first text[] := array['أحمد','محمد','محمود','عمر','يوسف','كريم','مصطفى','خالد','إسلام','حسام','طارق','شريف','عمرو','مازن','زياد','آدم','هشام','وليد','رامي','سيف','أنس','باسم','مروان','حازم','ياسر'];
  f_first text[] := array['منة','سارة','نور','مريم','ياسمين','هبة','رنا','دينا','شيماء','آية','فرح','ملك','هالة','نادين','سلمى','رضوى','أسماء','جنى','ليلى','إيمان'];
  last_n  text[] := array['حسن','عبد الله','السيد','إبراهيم','مصطفى','فؤاد','عادل','سمير','الشريف','منصور','رشاد','نبيل','جمال','فتحي','زكي','حمدي','صبري','عزت','شوقي','لطفي'];
  streets text[] := array['شارع مكرم عبيد','شارع عباس العقاد','شارع الطيران','شارع مصطفى النحاس','شارع التسعين الشمالي','شارع التسعين الجنوبي','شارع الجامعة الأمريكية','شارع محور سعد الشاذلي','شارع جمال عبد الناصر','شارع البستان','شارع ابن سينا','شارع النصر','شارع الثورة','شارع يوسف عباس','شارع حسن المأمون'];
  greet   text[] := array['السلام عليكم','مساء الخير','أهلاً','هاي','مساء النور، عايز أطلب','السلام عليكم ممكن أطلب؟','ازيكم','عايز أطلب أوردر لو سمحت','Hi'];
  agree   text[] := array['تمام','اه تمام','مظبوط','أكد','تمام أكد','ايوه كده تمام','تمام كده 👍','ماشي'];
  sources text[] := array['انستجرام','فيسبوك','جوجل ماب','الكارت اللي في الكيس','تيك توك','المحل'];
  far     text[] := array['المعادي','حلوان','6 أكتوبر','شبرا','الهرم','العبور','الرحاب','مدينتي'];
  -- the history
  n_cust  int := 520;
  cu      jsonb := '[]'::jsonb;              -- [{id, wa, conv, first, name, female, branch, zone, area, street, b, f, apt, fee, eta}]
  c       jsonb;
  d       int; k int; n int; h int; seq int := 1000; rseq int := 1000;
  day0    timestamptz;
  at      timestamptz; placed timestamptz; done_at timestamptz;
  hours   int[] := array[12,13,14,14,15,15,16,17,18,19,19,20,20,20,21,21,21,22,22,22,23,23,0,1];
  o_id    bigint; o_no text;
  cart    jsonb; lines jsonb; line jsonb; li int;
  sub numeric; disc numeric; vat numeric; fee numeric; tot numeric;
  o_mode text; pay text; st text; drv uuid; reason text;
  pick jsonb; q numeric; nm text; price numeric; choices jsonb;
  items_txt text; rcpt text; addr text; first_name text; is_new boolean; flavor int; full_chat boolean;
  msgs jsonb; conv bigint; wa text; cust_id bigint;
  live int := 0;
begin
  perform setseed(0.42);
  delete from everwake.tenants where slug = 'grill_house';

  t := everwake.create_tenant('بيت المشويات', 'Grill House', 'grill_house', 'EG', tz, 'EGP', 'ar');
  update everwake.tenants set
    status = 'live', live_at = now() - interval '31 days', order_no_prefix = 'GH', agent_enabled = true,
    profile = jsonb_build_object(
      'agent_name', jsonb_build_object('ar', 'ليلى', 'en', 'Laila'),
      'about_ar', 'بيت المشويات: مشويات مصرية على الفحم من 2009 — كفتة وريش وطرب وفراخ، وطواجن بيتي.',
      'about_en', 'Grill House: Egyptian charcoal grills since 2009 — kofta, lamb chops, chicken, and home-style tagines.',
      'cuisine', 'Egyptian grill', 'tone', 'Warm Egyptian host, proud of the charcoal grill.',
      'brand_facts', jsonb_build_array('كل المشويات على الفحم', 'اللحمة بلدي طازة كل يوم', 'بنعمل طلبات عزومات وحفلات بحجز قبلها بيوم'),
      'contacts', jsonb_build_object('hotline', '16XXX'), 'instagram', 'instagram.com/grillhouse.eg'),
    settings = jsonb_build_object('payment_methods', jsonb_build_array('cash', 'card', 'online', 'instapay'),
                                  'aggregator_commission_percent', 25, 'human_auto_release_minutes', 30,
                                  'daily_report', jsonb_build_object('enabled', false))
   where id = t;

  if v_owner_email <> '' and to_regclass('auth.users') is not null then
    execute 'insert into everwake.tenant_members (tenant_id, user_id, role, email, display_name)
             select $1, u.id, ''owner'', u.email, split_part(u.email, ''@'', 1) from auth.users u where lower(u.email) = lower($2)
             on conflict do nothing' using t, v_owner_email;
  end if;

  -- ---- branches and delivery zones -----------------------------------------------
  insert into everwake.branches (tenant_id, code, name_ar, name_en, aliases, area_ar, address_ar, lat, lng, phone, hours, hours_text_ar,
                                 delivery_fee, min_order, max_delivery_km, vat_percent, price_note_ar, delivery_eta_text, serves_hint_ar,
                                 sort, dine_in, reservations, prep_minutes)
  values (t, 'nasr', 'مدينة نصر', 'Nasr City', array['نصر','مدينه نصر'], 'مدينة نصر', '45 شارع مكرم عبيد، مدينة نصر', 30.0566, 31.3401, '0222700000',
          '{"default":[{"open":"12:00","close":"02:00"}]}', 'كل يوم من 12 الضهر لـ 2 بالليل', 30, 200, 7, 14,
          'الأسعار من غير ضريبة 14%', '45–60 دقيقة', 'مدينة نصر، مصر الجديدة، الحي العاشر', 10, true, 'whatsapp', 25)
  returning id into b_nasr;
  insert into everwake.branches (tenant_id, code, name_ar, name_en, aliases, area_ar, address_ar, lat, lng, phone, hours, hours_text_ar,
                                 delivery_fee, min_order, max_delivery_km, vat_percent, price_note_ar, delivery_eta_text, serves_hint_ar,
                                 sort, dine_in, reservations, prep_minutes)
  values (t, 'tagamoa', 'التجمع الخامس', 'New Cairo', array['التجمع','التجمع الخامس','new cairo'], 'التجمع الخامس', 'شارع التسعين الشمالي، التجمع الخامس', 30.0284, 31.4706, '0226100000',
          '{"default":[{"open":"12:00","close":"02:00"}]}', 'كل يوم من 12 الضهر لـ 2 بالليل', 35, 250, 8, 14,
          'الأسعار من غير ضريبة 14%', '40–55 دقيقة', 'التجمع الخامس، الرحاب، القرنفل', 20, true, 'whatsapp', 25)
  returning id into b_tag;
  insert into everwake.branches (tenant_id, code, name_ar, name_en, aliases, area_ar, address_ar, lat, lng, phone, hours, hours_text_ar,
                                 delivery_fee, min_order, max_delivery_km, vat_percent, price_note_ar, delivery_eta_text, serves_hint_ar,
                                 sort, dine_in, reservations, prep_minutes)
  values (t, 'zayed', 'الشيخ زايد', 'Sheikh Zayed', array['زايد','الشيخ زايد'], 'الشيخ زايد', 'مول أركان، الشيخ زايد', 30.0190, 30.9900, '0238500000',
          '{"default":[{"open":"13:00","close":"01:00"}]}', 'كل يوم من 1 الضهر لـ 1 بالليل', 30, 200, 7, 14,
          'الأسعار من غير ضريبة 14%', '45–60 دقيقة', 'الشيخ زايد، بيفرلي هيلز', 30, false, 'off', 30)
  returning id into b_zayed;
  br := array[b_nasr, b_tag, b_zayed]; br_code := array['nasr', 'tagamoa', 'zayed']; br_name := array['مدينة نصر', 'التجمع الخامس', 'الشيخ زايد'];

  insert into everwake.delivery_zones (tenant_id, branch_id, name_ar, name_en, kind, center_lat, center_lng, radius_km, areas, delivery_fee, min_order, eta_min, eta_max, priority) values
    (t, b_nasr, 'مدينة نصر', 'Nasr City', 'radius', 30.0566, 31.3401, 4, array['مدينة نصر','الحي السابع','الحي العاشر','عباس العقاد','مكرم عبيد'], 25, 200, 35, 50, 10),
    (t, b_nasr, 'مصر الجديدة', 'Heliopolis', 'radius', 30.0911, 31.3236, 3, array['مصر الجديدة','الكوربة','روكسي','الميرغني'], 35, 200, 45, 60, 20),
    (t, b_tag, 'التجمع الخامس', 'Fifth Settlement', 'radius', 30.0284, 31.4706, 5, array['التجمع','التجمع الخامس','التسعين','الياسمين','النرجس'], 30, 250, 35, 50, 10),
    (t, b_tag, 'الرحاب', 'Rehab', 'radius', 30.0590, 31.4920, 2.5, array['الرحاب','الرحاب سيتي'], 40, 250, 45, 60, 20),
    (t, b_zayed, 'الشيخ زايد', 'Sheikh Zayed', 'radius', 30.0190, 30.9900, 5, array['زايد','الشيخ زايد','الحي العاشر زايد'], 30, 200, 35, 50, 10),
    (t, b_zayed, 'بيفرلي هيلز', 'Beverly Hills', 'radius', 30.0430, 30.9550, 2, array['بيفرلي هيلز'], 40, 200, 45, 60, 20);
  for z in select id, branch_id, name_ar, delivery_fee, eta_min, eta_max, center_lat, center_lng from everwake.delivery_zones where tenant_id = t order by priority, name_ar loop
    zones := zones || jsonb_build_array(jsonb_build_object('id', z.id, 'branch', z.branch_id, 'name', z.name_ar, 'fee', z.delivery_fee,
                                                           'eta', z.eta_min || '–' || z.eta_max, 'lat', z.center_lat, 'lng', z.center_lng));
  end loop;

  -- ---- the menu -----------------------------------------------------------------------
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'المشويات', 'Grills', 10) returning id into c_grill;
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'الفراخ', 'Chicken', 20) returning id into c_chick;
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'الساندوتشات', 'Sandwiches', 30) returning id into c_sand;
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'الطواجن', 'Tagines', 40) returning id into c_tagen;
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'الأطباق الجانبية', 'Sides', 50) returning id into c_side;
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'الحلويات', 'Desserts', 60) returning id into c_sweet;
  insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort) values (t, 'المشروبات', 'Drinks', 70) returning id into c_drink;

  insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, description_ar, unit, price, qty_step, min_qty, is_signature, is_featured, tags, sort)
  select t, cat, n_ar, n_en, descr, unt, prc, case when unt = 'kg' then 0.25 end, case when unt = 'kg' then 0.25 end, sig, feat, array[knd], srt
    from (values
      (c_grill, 'مشكل مشويات', 'Mixed Grill', 'كفتة وطرب وشيش طاووق وريش على الفحم', 'kg', 690, true, true, 'main', 10),
      (c_grill, 'كفتة مشوية', 'Grilled Kofta', 'كفتة بلدي بالبصل والبقدونس', 'kg', 540, true, false, 'main', 20),
      (c_grill, 'ريش ضاني', 'Lamb Chops', 'ريش ضاني صغير متبل على الفحم', 'kg', 1180, false, true, 'main', 30),
      (c_grill, 'طرب', 'Tarb', 'كفتة ملفوفة في الدهن على الفحم', 'kg', 590, false, false, 'main', 40),
      (c_grill, 'شيش طاووق', 'Shish Tawook', 'صدور فراخ متبلة بالزبادي والليمون', 'kg', 490, false, false, 'main', 50),
      (c_chick, 'فرخة مشوية', 'Grilled Chicken', 'فرخة على الفحم بالتتبيلة اللي تختارها', 'portion', 290, true, false, 'main', 10),
      (c_chick, 'فراخ بانيه', 'Chicken Pane', 'صدور فراخ بانيه مقرمشة مع بطاطس', 'portion', 230, false, false, 'main', 20),
      (c_sand, 'ساندوتش كفتة', 'Kofta Sandwich', 'كفتة مشوية بالطحينة في عيش بلدي', 'portion', 115, false, false, 'main', 10),
      (c_sand, 'ساندوتش شيش طاووق', 'Tawook Sandwich', 'شيش طاووق بالثومية والمخلل', 'portion', 105, false, false, 'main', 20),
      (c_sand, 'حواوشي', 'Hawawshi', 'حواوشي إسكندراني في الفرن', 'portion', 95, false, false, 'main', 30),
      (c_tagen, 'طاجن بامية باللحمة', 'Okra Tagine with Beef', 'بامية بلدي ولحمة في الفخار', 'portion', 240, false, false, 'main', 10),
      (c_tagen, 'طاجن لسان عصفور', 'Orzo Tagine', 'لسان عصفور باللحمة المفرومة', 'portion', 120, false, false, 'side', 20),
      (c_tagen, 'ملوخية', 'Molokhia', 'ملوخية خضرا بالتقلية', 'portion', 70, false, false, 'side', 30),
      (c_side, 'أرز بالشعرية', 'Vermicelli Rice', null, 'portion', 50, false, false, 'side', 10),
      (c_side, 'بطاطس محمرة', 'French Fries', null, 'portion', 50, false, false, 'side', 20),
      (c_side, 'سلطة طحينة', 'Tahini', null, 'portion', 35, false, false, 'side', 30),
      (c_side, 'بابا غنوج', 'Baba Ghanoush', null, 'portion', 40, false, false, 'side', 40),
      (c_side, 'سلطة خضرا', 'Green Salad', null, 'portion', 35, false, false, 'side', 50),
      (c_sweet, 'أم علي', 'Om Ali', 'أم علي بالمكسرات والقشطة', 'portion', 90, false, false, 'sweet', 10),
      (c_sweet, 'رز بلبن', 'Rice Pudding', null, 'portion', 55, false, false, 'sweet', 20),
      (c_drink, 'بيبسي', 'Pepsi', null, 'portion', 25, false, false, 'drink', 10),
      (c_drink, 'عصير مانجو', 'Mango Juice', 'مانجو فريش', 'portion', 60, false, false, 'drink', 20),
      (c_drink, 'ليمون نعناع', 'Lemon Mint', null, 'portion', 55, false, false, 'drink', 30),
      (c_drink, 'مياه معدنية', 'Water', null, 'portion', 15, false, false, 'drink', 40)
    ) v(cat, n_ar, n_en, descr, unt, prc, sig, feat, knd, srt);

  select id into i_chicken from everwake.menu_items where tenant_id = t and name_ar = 'فرخة مشوية';
  insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
  values (t, i_chicken, 1, 'الحجم', 'Size', true, 1, 1) returning id into g;
  insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, price_delta, sort) values
    (t, g, 'نص فرخة', 'Half', 0, 10), (t, g, 'فرخة كاملة', 'Whole', 240, 20);
  insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
  values (t, i_chicken, 2, 'التتبيلة', 'Marinade', true, 1, 1) returning id into g;
  insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, price_delta, sort) values
    (t, g, 'عادي', 'Classic', 0, 10), (t, g, 'حار', 'Spicy', 0, 20), (t, g, 'ليمون وثوم', 'Lemon & Garlic', 0, 30);

  for it in select mi.id, mi.code, mi.name_ar, mi.price, mi.unit, mi.tags[1] as kind from everwake.menu_items mi where mi.tenant_id = t order by mi.code loop
    items := items || jsonb_build_array(jsonb_build_object('id', it.id, 'code', it.code, 'name', it.name_ar, 'price', it.price, 'unit', it.unit, 'kind', it.kind));
  end loop;
  select jsonb_agg(x) into mains from jsonb_array_elements(items) x where x ->> 'kind' = 'main';
  select jsonb_agg(x) into sides from jsonb_array_elements(items) x where x ->> 'kind' = 'side';
  select jsonb_agg(x) into drinks from jsonb_array_elements(items) x where x ->> 'kind' = 'drink';
  select jsonb_agg(x) into sweets from jsonb_array_elements(items) x where x ->> 'kind' = 'sweet';

  insert into everwake.offers (tenant_id, title_ar, title_en, description_ar, kind, scope, value, min_subtotal, priority)
  values (t, 'خصم 10% على الطلبات فوق 1000ج', '10% off orders over 1000', 'خصم 10% على أي طلب واتساب فوق 1000ج', 'percent_off', 'order', 10, 1000, 10);
  insert into everwake.knowledge_entries (tenant_id, topic, content_ar, sort) values
    (t, 'العزومات', 'طلبات العزومات فوق 15 فرد تتحجز قبلها بيوم.', 10),
    (t, 'الركن', 'فرع التجمع فيه جراج تحت المول، ومدينة نصر فيه ركنة قدامه.', 20);
  -- a number that points nowhere: nothing from this restaurant can ever be sent
  insert into everwake.whatsapp_channels (tenant_id, provider, label, phone_number, instance_name, base_url, api_key, webhook_token, status, connected_at, last_inbound_at)
  values (t, 'evolution', 'الخط الرئيسي', '201000000000', 'grill-house-demo', 'https://evolution.invalid', 'demo',
          replace(gen_random_uuid()::text, '-', ''), 'connected', now() - interval '31 days', now());

  insert into everwake.drivers (tenant_id, name, phone, branch_ids, last_seen_at) values
    (t, 'محمود السيد', '201000000101', array[b_nasr], now() - interval '3 minutes'),
    (t, 'إسلام فتحي', '201000000102', array[b_nasr], now() - interval '20 minutes'),
    (t, 'كريم عادل', '201000000103', array[b_tag], now() - interval '1 minute'),
    (t, 'أحمد جمال', '201000000104', array[b_tag], now() - interval '9 minutes'),
    (t, 'مصطفى رشاد', '201000000105', array[b_zayed], now() - interval '5 minutes');
  select array_agg(id order by phone), array_agg(branch_ids[1] order by phone) into drivers, drv_branch from everwake.drivers where tenant_id = t;

  -- ---- the customers -----------------------------------------------------------------------
  for k in 1..n_cust loop
    declare fem boolean := random() < 0.35; fn text; ln text; zi int; zz jsonb; ph text;
    begin
      fn := case when fem then pg_temp.pick(f_first) else pg_temp.pick(m_first) end;
      ln := pg_temp.pick(last_n);
      zi := case when random() < 0.42 then floor(random() * 2)::int when random() < 0.75 then 2 + floor(random() * 2)::int else 4 + floor(random() * 2)::int end;
      zz := zones -> zi;
      ph := '20' || pg_temp.pick(array['10','11','12','15']) || lpad((10000000 + floor(random() * 89999999))::bigint::text, 8, '0');
      insert into everwake.customers (tenant_id, wa_id, reply_to, phone, display_name, full_name, language, first_seen_at)
      values (t, ph, ph, ph, case when random() < 0.7 then fn || ' ' || ln else fn end, fn || ' ' || ln, 'ar', now())
      on conflict do nothing returning id into cust_id;
      continue when cust_id is null;
      insert into everwake.customer_identities (tenant_id, kind, value, customer_id) values (t, 'phone', ph, cust_id) on conflict do nothing;
      insert into everwake.conversations (tenant_id, customer_id, wa_id, state)
      values (t, cust_id, ph, '{}'::jsonb) returning id into conv;
      cu := cu || jsonb_build_array(jsonb_build_object(
        'id', cust_id, 'wa', ph, 'conv', conv, 'first', fn, 'name', fn || ' ' || ln, 'female', fem,
        'branch', zz ->> 'branch', 'zone', zz ->> 'id', 'area', zz ->> 'name', 'fee', (zz ->> 'fee')::numeric, 'eta', zz ->> 'eta',
        'lat', (zz ->> 'lat')::float + (random() - 0.5) / 60, 'lng', (zz ->> 'lng')::float + (random() - 0.5) / 60,
        'street', pg_temp.pick(streets), 'b', (1 + floor(random() * 90))::int, 'f', (1 + floor(random() * 9))::int,
        'apt', (1 + floor(random() * 20))::int, 'villa', random() < 0.12, 'orders', 0, 'pickup', random() < 0.18,
        'source', case when random() < 0.45 then pg_temp.pick(sources) end));
    end;
  end loop;
  n_cust := jsonb_array_length(cu);

  -- ---- 30 days of orders --------------------------------------------------------------------
  for d in reverse 29..0 loop
    day0 := (date_trunc('day', now() at time zone tz) - make_interval(days => d)) at time zone tz;
    n := 22 + floor(random() * 12)::int + (29 - d) / 3
         + case when extract(dow from day0 at time zone tz) in (4, 5) then 12 else 0 end;
    for k in 1..n loop
      h := hours[1 + floor(random() * array_length(hours, 1))::int];
      placed := day0 + make_interval(hours => case when h < 12 then h + 24 else h end, mins => floor(random() * 60)::int);
      -- today, a few live ones are always on the board
      if d = 0 and live < 7 and random() < 0.35 then
        placed := now() - make_interval(mins => 3 + live * 7 + floor(random() * 5)::int); live := live + 1;
      end if;
      continue when placed > now() - interval '2 minutes';

      c := cu -> floor(n_cust * power(random(), 1.35))::int;     -- regulars order more often
      is_new := (c ->> 'orders')::int = 0;
      first_name := c ->> 'first';
      o_mode := case when (c ->> 'pickup')::boolean and random() < 0.8 then 'pickup' else 'delivery' end;
      pay := case when o_mode = 'pickup' then (array['cash','cash','card'])[1 + floor(random() * 3)::int]
                  else (array['cash','cash','cash','cash','card','card','online','online','instapay'])[1 + floor(random() * 9)::int] end;

      -- the dishes
      lines := '[]'::jsonb; li := 0; sub := 0; items_txt := '';
      for h in 1..(case when random() < 0.66 then 1 when random() < 0.85 then 2 else 3 end) loop
        pick := mains -> floor(random() * jsonb_array_length(mains))::int;
        continue when lines @> jsonb_build_array(jsonb_build_object('code', pick ->> 'code'));
        q := case when pick ->> 'unit' = 'kg' then (array[0.5, 0.5, 0.5, 1, 1, 1.5])[1 + floor(random() * 6)::int]
                  else (array[1, 1, 1, 1, 2, 2])[1 + floor(random() * 6)::int] end;
        nm := pick ->> 'name'; price := (pick ->> 'price')::numeric; choices := '[]'::jsonb;
        if nm = 'فرخة مشوية' then
          declare whole boolean := random() < 0.6; mar text := pg_temp.pick(array['عادي','حار','ليمون وثوم']);
          begin
            choices := jsonb_build_array(jsonb_build_object('level', 1, 'label_ar', 'الحجم', 'selected', jsonb_build_array(jsonb_build_object('name', case when whole then 'فرخة كاملة' else 'نص فرخة' end, 'adds', case when whole then 240 else 0 end))),
                                         jsonb_build_object('level', 2, 'label_ar', 'التتبيلة', 'selected', jsonb_build_array(jsonb_build_object('name', mar))));
            price := price + case when whole then 240 else 0 end;
            nm := nm || ' (' || case when whole then 'كاملة' else 'نص' end || '، ' || mar || ')';
          end;
        end if;
        li := li + 1;
        lines := lines || jsonb_build_array(jsonb_build_object('line_id', 'L' || li, 'code', pick ->> 'code', 'item_id', pick ->> 'id',
                   'item_name', pick ->> 'name', 'display_name', nm, 'unit', pick ->> 'unit', 'quantity', q, 'unit_price', price,
                   'line_total', round(price * q, 2), 'notes', null, 'choices', choices));
        sub := sub + round(price * q, 2);
      end loop;
      if random() < 0.65 then
        pick := sides -> floor(random() * jsonb_array_length(sides))::int; q := case when random() < 0.7 then 1 else 2 end;
        li := li + 1; lines := lines || jsonb_build_array(jsonb_build_object('line_id', 'L' || li, 'code', pick ->> 'code', 'item_id', pick ->> 'id',
                   'item_name', pick ->> 'name', 'display_name', pick ->> 'name', 'unit', 'portion', 'quantity', q, 'unit_price', (pick ->> 'price')::numeric,
                   'line_total', (pick ->> 'price')::numeric * q, 'notes', null, 'choices', '[]'::jsonb));
        sub := sub + (pick ->> 'price')::numeric * q;
      end if;
      if random() < 0.4 then
        pick := drinks -> floor(random() * jsonb_array_length(drinks))::int; q := 1 + floor(random() * 3);
        li := li + 1; lines := lines || jsonb_build_array(jsonb_build_object('line_id', 'L' || li, 'code', pick ->> 'code', 'item_id', pick ->> 'id',
                   'item_name', pick ->> 'name', 'display_name', pick ->> 'name', 'unit', 'portion', 'quantity', q, 'unit_price', (pick ->> 'price')::numeric,
                   'line_total', (pick ->> 'price')::numeric * q, 'notes', null, 'choices', '[]'::jsonb));
        sub := sub + (pick ->> 'price')::numeric * q;
      end if;
      if random() < 0.15 then
        pick := sweets -> floor(random() * jsonb_array_length(sweets))::int; q := 1 + floor(random() * 2);
        li := li + 1; lines := lines || jsonb_build_array(jsonb_build_object('line_id', 'L' || li, 'code', pick ->> 'code', 'item_id', pick ->> 'id',
                   'item_name', pick ->> 'name', 'display_name', pick ->> 'name', 'unit', 'portion', 'quantity', q, 'unit_price', (pick ->> 'price')::numeric,
                   'line_total', (pick ->> 'price')::numeric * q, 'notes', null, 'choices', '[]'::jsonb));
        sub := sub + (pick ->> 'price')::numeric * q;
      end if;
      select string_agg(pg_temp.qty((x ->> 'quantity')::numeric, x ->> 'unit', x ->> 'display_name'), ' و') into items_txt from jsonb_array_elements(lines) x;
      select string_agg(pg_temp.qty((x ->> 'quantity')::numeric, x ->> 'unit', x ->> 'display_name') || ' — ' || pg_temp.m((x ->> 'line_total')::numeric) || 'ج', E'\n') into rcpt from jsonb_array_elements(lines) x;

      disc := case when sub >= 1000 then round(sub * 0.10, 2) else 0 end;
      vat := round((sub - disc) * 0.14, 2);
      fee := case when o_mode = 'delivery' then (c ->> 'fee')::numeric else 0 end;
      tot := sub - disc + vat + fee;
      addr := case when o_mode = 'pickup' then 'استلام من فرع ' || br_name[array_position(br, (c ->> 'branch')::uuid)]
                   when (c ->> 'villa')::boolean then c ->> 'area' || '، ' || (c ->> 'street') || '، فيلا ' || (c ->> 'b')
                   else c ->> 'area' || '، ' || (c ->> 'street') || '، عمارة ' || (c ->> 'b') || '، الدور ' || (c ->> 'f') || '، شقة ' || (c ->> 'apt') end;
      seq := seq + 1; o_no := 'GH-' || seq;

      -- what happened to it
      st := case when placed > now() - interval '50 minutes' then
                   case when placed > now() - interval '6 minutes' then 'placed' when placed > now() - interval '15 minutes' then 'accepted'
                        when placed > now() - interval '30 minutes' then 'preparing'
                        when o_mode = 'pickup' then 'ready' else 'out_for_delivery' end
                 when random() < 0.025 then 'cancelled' when random() < 0.018 then 'rejected'
                 when o_mode = 'pickup' then 'picked_up' else 'delivered' end;
      reason := case st when 'rejected' then pg_temp.pick(array['الفرع زحمة جداً دلوقتي','الريش خلصت النهارده','العنوان برا منطقة الفرع'])
                        when 'cancelled' then pg_temp.pick(array['العميل لغى الطلب','العميل طلب يأجله لبكرة']) end;
      drv := case when o_mode = 'delivery' and st in ('out_for_delivery', 'delivered')
                  then drivers[(select i from generate_subscripts(drv_branch, 1) i where drv_branch[i] = (c ->> 'branch')::uuid order by random() limit 1)] end;

      conv := (c ->> 'conv')::bigint; wa := c ->> 'wa';
      full_chat := d <= 6 or random() < 0.12;
      flavor := case when not is_new and random() < 0.45 then 2 when o_mode = 'pickup' then 3 when is_new and random() < 0.3 then 4 else 1 end;

      msgs := '[]'::jsonb;
      if not full_chat then
        msgs := jsonb_build_array(
          jsonb_build_array('customer', case when is_new then pg_temp.pick(greet) || '، ' else '' end || 'عايز ' || items_txt || case when o_mode = 'pickup' then ' استلام' else '' end),
          jsonb_build_array('agent', 'تمام يا ' || first_name || '، ده ملخص طلبك 👇' || E'\n\n' || rcpt
            || case when disc > 0 then E'\nخصم 10% — -' || pg_temp.m(disc) || 'ج' else '' end
            || E'\nضريبة القيمة المضافة 14% — ' || pg_temp.m(vat) || 'ج'
            || case when fee > 0 then E'\nالتوصيل — ' || pg_temp.m(fee) || 'ج' else '' end
            || E'\n*الإجمالي — ' || pg_temp.m(tot) || 'ج*' || E'\n\n' || addr || E'\nرقم التواصل: ' || pg_temp.local(wa) || E'\n\nكده كله مظبوط؟'),
          jsonb_build_array('customer', pg_temp.pick(agree)));
      elsif flavor = 2 then
        msgs := jsonb_build_array(
          jsonb_build_array('customer', pg_temp.pick(array['عايز نفس الأوردر اللي فات','ممكن نفس طلب المرة اللي فاتت؟','عاوز أطلب تاني زي آخر مرة'])),
          jsonb_build_array('agent', 'أهلاً يا ' || first_name || '، نورتنا تاني 😊 أجهزلك ' || items_txt || ' زي آخر مرة؟' || case when o_mode = 'delivery' then ' وعلى نفس العنوان في ' || (c ->> 'area') || '؟' else '' end),
          jsonb_build_array('customer', pg_temp.pick(array['ايوه بالظبط','اه نفس العنوان','ايوه بس بسرعة لو سمحت 😅','تمام'])));
      elsif flavor = 3 then
        msgs := jsonb_build_array(
          jsonb_build_array('customer', pg_temp.pick(greet)),
          jsonb_build_array('agent', 'أهلاً بيك 😊 أنا ليلى من بيت المشويات، تحب تطلب دليفري ولا هتعدي تستلم من الفرع؟'),
          jsonb_build_array('customer', 'هستلم من فرع ' || br_name[array_position(br, (c ->> 'branch')::uuid)]),
          jsonb_build_array('agent', 'تمام، فرع ' || br_name[array_position(br, (c ->> 'branch')::uuid)] || ' مستنيك 👌 تحب تطلب إيه؟'),
          jsonb_build_array('customer', 'عايز ' || items_txt),
          jsonb_build_array('agent', pg_temp.pick(array['تمام، ضيفتهملك 👌','اختيار حلو 😋 ضيفتهم','حلو جداً، ضيفتلك كله 👌','تمام كده 👌']) || ' '
                                     || pg_temp.pick(array['تحب تزود حاجة تانية ولا كده تمام؟','محتاج حاجة تانية معاهم؟','أي حاجة تانية؟'])),
          jsonb_build_array('customer', 'كده تمام'),
          jsonb_build_array('agent', 'حلو، اسم حضرتك إيه؟ وهنكلمك على نفس الرقم ده؟'),
          jsonb_build_array('customer', first_name || '، ايوه نفس الرقم'));
      else
        msgs := jsonb_build_array(
          jsonb_build_array('customer', case when c ->> 'source' is not null and is_new then 'أهلاً، عرفتكم من ' || (c ->> 'source') || ' وعايز أطلب' else pg_temp.pick(greet) end),
          jsonb_build_array('agent', case when is_new then 'أهلاً بيك 😊 أنا ليلى من بيت المشويات. تحب تطلب دليفري ولا هتستلم من الفرع؟'
                                          else 'أهلاً يا ' || first_name || ' 😊 نورتنا، دليفري زي كل مرة؟' end),
          jsonb_build_array('customer', 'دليفري، أنا في ' || (c ->> 'area')),
          jsonb_build_array('agent', 'تمام، بنوصلك ' || (c ->> 'area') || ' والتوصيل ' || pg_temp.m(fee) || 'ج 🛵 ' || case when flavor = 4 then 'إنتوا كام فرد؟ وبتحبوا إيه أكتر، لحمة ولا فراخ؟' else 'تحب تطلب حاجة معينة ولا أرشحلك؟' end));
        if flavor = 4 then
          msgs := msgs || jsonb_build_array(
            jsonb_build_array('customer', pg_temp.pick(array['إحنا 4، وبنحب المشويات','3 أفراد، أي حاجة حلوة','إحنا 5 وفي عيال']) ),
            jsonb_build_array('agent', 'يبقى أرشحلكم 👇' || E'\n' || rcpt || E'\n' || 'ده هيكفيكم براحة وهتاكلوا مشويات على الفحم زي ما بتحبوا. نمشي على كده؟'),
            jsonb_build_array('customer', pg_temp.pick(array['تمام نمشي على كده','حلو جداً، تمام','ماشي'])));
        else
          msgs := msgs || jsonb_build_array(
            jsonb_build_array('customer', 'عايز ' || items_txt),
            jsonb_build_array('agent', pg_temp.pick(array['تمام، ضيفتهملك 👌','اختيار حلو 😋 ضيفتهم','حلو جداً، ضيفتلك كله 👌','تمام كده 👌']) || ' '
                                     || pg_temp.pick(array['تحب تزود حاجة تانية ولا كده تمام؟','محتاج حاجة تانية معاهم؟','أي حاجة تانية؟'])),
            jsonb_build_array('customer', pg_temp.pick(array['كده تمام','لا كده تمام','خلاص كده'])));
        end if;
        if is_new then
          msgs := msgs || jsonb_build_array(
            jsonb_build_array('agent', 'حلو، ابعتلي العنوان: الشارع ورقم العمارة والدور والشقة'),
            jsonb_build_array('customer', (c ->> 'street') || case when (c ->> 'villa')::boolean then '، فيلا ' || (c ->> 'b') else '، عمارة ' || (c ->> 'b') || ' الدور ' || (c ->> 'f') || ' شقة ' || (c ->> 'apt') end),
            jsonb_build_array('agent', 'تمام، اسم حضرتك إيه؟ وهنكلمك على نفس الرقم ده؟'),
            jsonb_build_array('customer', first_name || '، ايوه نفس الرقم'),
            jsonb_build_array('agent', 'هتدفع كاش ولا كارت ولا أونلاين؟'),
            jsonb_build_array('customer', case pay when 'cash' then 'كاش' when 'card' then 'فيزا عند الاستلام' when 'online' then 'أونلاين' else 'انستاباي' end));
        end if;
      end if;
      if full_chat then
        msgs := msgs || jsonb_build_array(
          jsonb_build_array('agent', 'تمام يا ' || first_name || '، ده ملخص طلبك 👇' || E'\n\n' || rcpt
            || case when disc > 0 then E'\nخصم 10% — -' || pg_temp.m(disc) || 'ج' else '' end
            || E'\nضريبة القيمة المضافة 14% — ' || pg_temp.m(vat) || 'ج'
            || case when fee > 0 then E'\nالتوصيل — ' || pg_temp.m(fee) || 'ج' else '' end
            || E'\n*الإجمالي — ' || pg_temp.m(tot) || 'ج*' || E'\n\n' || case when o_mode = 'pickup' then addr else 'العنوان: ' || addr end
            || E'\nرقم التواصل: ' || pg_temp.local(wa)
            || E'\nالدفع: ' || case pay when 'cash' then 'كاش' when 'card' then 'كارت عند الاستلام' when 'online' then 'أونلاين — لينك الدفع بيوصلك بعد التأكيد' else 'انستاباي' end
            || E'\n\nكده كله مظبوط؟'),
          jsonb_build_array('customer', pg_temp.pick(agree)));
      end if;
      msgs := msgs || jsonb_build_array(jsonb_build_array('agent',
        'اتأكد طلبك رقم *' || o_no || '* 🎉 ' || case when o_mode = 'pickup' then 'هيكون جاهز في الفرع خلال حوالي 25 دقيقة.'
                                                       else 'هيوصلك خلال ' || (c ->> 'eta') || ' دقيقة تقريباً.' end
        || case when pay = 'online' then ' ولينك الدفع وصلك في الرسالة اللي جاية.' else ' بالهنا والشفا مقدماً!' end));

      if (c ->> 'female')::boolean then msgs := pg_temp.fem(msgs); end if;
      at := pg_temp.chat(t, conv, wa, msgs, placed - make_interval(secs => jsonb_array_length(msgs) * 40));
      placed := least(at - interval '30 seconds', now() - interval '1 minute');

      insert into everwake.orders (tenant_id, order_no, customer_id, conversation_id, wa_id, branch_id, zone_id, status, cart,
                                   subtotal, discount_total, applied_offers, vat, delivery_fee, total, delivery_method, payment_method,
                                   customer, address_text, address, location, eta_text, reject_reason, placed_at, accepted_at, ready_at,
                                   out_for_delivery_at, completed_at, cancelled_at, created_at, updated_at, driver_id, driver_assigned_at,
                                   payment_status, paid_at, paid_amount)
      values (t, o_no, (c ->> 'id')::bigint, conv, wa, (c ->> 'branch')::uuid, case when o_mode = 'delivery' then (c ->> 'zone')::uuid end,
              st, jsonb_build_object('items', lines), sub, disc,
              case when disc > 0 then jsonb_build_array(jsonb_build_object('title', 'خصم 10% على الطلبات فوق 1000ج', 'amount', disc)) else '[]'::jsonb end,
              vat, fee, tot, o_mode, pay,
              jsonb_build_object('full_name', c ->> 'name', 'phone', pg_temp.local(wa), 'phone_confirmed', 'yes', 'delivery_method', o_mode, 'payment_method', pay),
              addr, case when o_mode = 'delivery' then jsonb_build_object('area', c ->> 'area', 'street', c ->> 'street', 'building', c ->> 'b',
                                                                       'floor', case when (c ->> 'villa')::boolean then null else c ->> 'f' end,
                                                                       'apartment', case when (c ->> 'villa')::boolean then null else c ->> 'apt' end) end,
              case when o_mode = 'delivery' and random() < 0.5 then jsonb_build_object('lat', (c ->> 'lat')::float, 'lng', (c ->> 'lng')::float,
                     'maps_url', 'https://www.google.com/maps?q=' || round((c ->> 'lat')::numeric, 5) || ',' || round((c ->> 'lng')::numeric, 5)) end,
              case when o_mode = 'pickup' then 'جاهز خلال 25 دقيقة' else (c ->> 'eta') || ' دقيقة' end, reason,
              placed,
              case when st not in ('placed', 'rejected') then placed + make_interval(mins => 1 + floor(random() * 4)::int) end,
              case when st in ('ready', 'picked_up', 'delivered', 'out_for_delivery') then placed + make_interval(mins => 18 + floor(random() * 12)::int) end,
              case when st in ('out_for_delivery', 'delivered') then placed + make_interval(mins => 30 + floor(random() * 10)::int) end,
              case when st in ('delivered', 'picked_up') then placed + make_interval(mins => 45 + floor(random() * 25)::int) end,
              case when st in ('cancelled', 'rejected') then placed + make_interval(mins => 3 + floor(random() * 10)::int) end,
              placed - interval '6 minutes', placed + interval '50 minutes', drv,
              case when drv is not null then placed + make_interval(mins => 28 + floor(random() * 5)::int) end,
              case when pay = 'online' and st not in ('cancelled', 'rejected') then case when st = 'placed' then 'pending' else 'paid' end else 'none' end,
              case when pay = 'online' and st not in ('cancelled', 'rejected', 'placed') then placed + make_interval(mins => 1 + floor(random() * 3)::int) end,
              case when pay = 'online' and st not in ('cancelled', 'rejected', 'placed') then tot end)
      returning id into o_id;
      update everwake.orders set updated_at = least(coalesce(completed_at, cancelled_at, out_for_delivery_at, ready_at, accepted_at, placed_at), now()) where id = o_id;

      insert into everwake.order_items (tenant_id, order_id, line_no, item_id, item_code, name, unit, quantity, unit_price, line_total, choices)
      select t, o_id, ord::int, (x ->> 'item_id')::uuid, x ->> 'code', x ->> 'display_name', x ->> 'unit', (x ->> 'quantity')::numeric,
             (x ->> 'unit_price')::numeric, (x ->> 'line_total')::numeric, x -> 'choices'
        from jsonb_array_elements(lines) with ordinality as e(x, ord);

      insert into everwake.order_events (tenant_id, order_id, status, by_role, notified, note, created_at)
      select t, o_id, s, r, nt, nn, ts from (values
        ('placed', 'agent', false, null::text, placed),
        ('accepted', 'staff', true, null, (select accepted_at from everwake.orders where id = o_id)),
        ('ready', 'staff', true, null, (select case when delivery_method = 'pickup' then ready_at end from everwake.orders where id = o_id)),
        ('out_for_delivery', 'staff', true, null, (select out_for_delivery_at from everwake.orders where id = o_id)),
        (st, 'staff', true, reason, (select coalesce(completed_at, cancelled_at) from everwake.orders where id = o_id))) e(s, r, nt, nn, ts)
       where ts is not null and ts <= now();

      if pay = 'online' and st not in ('cancelled', 'rejected') then
        insert into everwake.payments (tenant_id, order_id, ref, amount, status, method, card_brand, card_last4, expires_at, paid_at, created_at, is_live)
        values (t, o_id, 'gh' || o_id || substr(md5(random()::text), 1, 6), tot, case when st = 'placed' then 'pending' else 'paid' end,
                'card', pg_temp.pick(array['Visa','Mastercard','Meeza']), lpad(floor(random() * 9999)::int::text, 4, '0'),
                placed + interval '1 hour', case when st <> 'placed' then placed + interval '2 minutes' end, placed, true);
        if st <> 'placed' then
          at := pg_temp.say(t, conv, wa, 'customer', 'دفعت ✅', placed + interval '2 minutes');
          at := pg_temp.say(t, conv, wa, 'system', 'وصلنا الدفع لطلبك رقم ' || o_no || ' ✅ شكراً ليك!', placed + interval '2 minutes 20 seconds');
        end if;
      end if;
      -- the automatic status messages, for the chats people will open
      if full_chat then
        if st in ('accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'picked_up') then
          at := pg_temp.say(t, conv, wa, 'system', 'تمام 👨‍🍳 طلبك رقم ' || o_no || ' اتأكد من فرع ' || br_name[array_position(br, (c ->> 'branch')::uuid)] || ' وبيتجهز دلوقتي.', placed + interval '3 minutes');
        end if;
        if st in ('out_for_delivery', 'delivered') then
          at := pg_temp.say(t, conv, wa, 'system', 'طلبك رقم ' || o_no || ' خرج مع مندوب التوصيل وفي الطريق ليك 🛵', placed + interval '33 minutes');
        end if;
        if st = 'ready' or st = 'picked_up' then
          at := pg_temp.say(t, conv, wa, 'system', 'طلبك رقم ' || o_no || ' جاهز للاستلام من فرع ' || br_name[array_position(br, (c ->> 'branch')::uuid)] || ' ✅', placed + interval '24 minutes');
        end if;
        if st = 'delivered' and random() < 0.3 then
          at := pg_temp.say(t, conv, wa, 'customer', pg_temp.pick(array['وصل، تسلم إيديكم 🙏','الأكل تحفة بجد','شكراً، وصل سخن 👌','تسلموا ❤️']), placed + interval '58 minutes');
          at := pg_temp.say(t, conv, wa, 'agent', pg_temp.pick(array['بالهنا والشفا يا ' || first_name || ' 😊 مستنيينك تاني!','يارب دايماً 🙏 بالهنا والشفا!','ده يسعدنا جداً 😊 مستنيينك المرة الجاية']), placed + interval '59 minutes');
        end if;
        if st = 'rejected' then
          at := pg_temp.say(t, conv, wa, 'system', 'معلش جداً، مقدرناش ننفذ طلبك رقم ' || o_no || '. ' || reason || '. لو تحب نساعدك في طلب تاني إحنا موجودين.', placed + interval '5 minutes');
        end if;
      end if;

      -- the conversation remembers them
      update everwake.conversations set
        state = jsonb_build_object(
          'customer', jsonb_strip_nulls(jsonb_build_object('full_name', c ->> 'name', 'phone', pg_temp.local(wa), 'phone_confirmed', 'yes', 'delivery_method', o_mode,
                        'payment_method', pay, 'address_area', case when o_mode = 'delivery' then c ->> 'area' end,
                        'address_street', case when o_mode = 'delivery' then c ->> 'street' end,
                        'address_building', case when o_mode = 'delivery' then (c ->> 'b') end)),
          'branch', jsonb_build_object('id', c ->> 'branch', 'code', br_code[array_position(br, (c ->> 'branch')::uuid)],
                                       'name_ar', br_name[array_position(br, (c ->> 'branch')::uuid)], 'source', 'agent'),
          'zone', case when o_mode = 'delivery' then jsonb_build_object('name', c ->> 'area', 'delivery_fee', fee) end,
          'last_turn_at', at, 'phase', 'placed', 'last_language', 'ar')
       where id = conv;
      cu := jsonb_set(cu, array[(select ord - 1 from jsonb_array_elements(cu) with ordinality e(x, ord) where x ->> 'id' = c ->> 'id')::text, 'orders'],
                      to_jsonb((c ->> 'orders')::int + 1));
    end loop;
  end loop;
  update everwake.tenants set order_seq = seq where id = t;

  -- ---- chats that did not order (the missed sales) -------------------------------------
  for d in reverse 20..0 loop
    day0 := (date_trunc('day', now() at time zone tz) - make_interval(days => d)) at time zone tz;
    -- outside the delivery area: they sent a pin
    for k in 1..(1 + floor(random() * 2)::int) loop
      at := day0 + make_interval(hours => 13 + floor(random() * 10)::int, mins => floor(random() * 60)::int);
      continue when at > now();
      c := cu -> floor(random() * n_cust)::int;
      declare place text := pg_temp.pick(far); conv2 bigint; wa2 text := '20' || pg_temp.pick(array['10','11','12']) || lpad((10000000 + floor(random() * 89999999))::bigint::text, 8, '0');
              cid bigint;
      begin
        insert into everwake.customers (tenant_id, wa_id, reply_to, phone, display_name, first_seen_at) values (t, wa2, wa2, wa2, pg_temp.pick(m_first || f_first), at)
        on conflict do nothing returning id into cid;
        continue when cid is null;
        insert into everwake.conversations (tenant_id, customer_id, wa_id, state) values (t, cid, wa2,
          jsonb_build_object('location', jsonb_build_object('in_delivery_area', false, 'at', at, 'lat', 29.96 + random() / 10, 'lng', 31.25 + random() / 10,
                                                            'geo', jsonb_build_object('district', place, 'city', 'القاهرة'))))
        returning id into conv2;
        perform pg_temp.chat(t, conv2, wa2, jsonb_build_array(
          jsonb_build_array('customer', 'بتوصلوا ' || place || '؟'),
          jsonb_build_array('agent', 'أهلاً بيك 😊 أنا ليلى من بيت المشويات. ابعتلي اللوكيشن وأنا أشوفلك على طول'),
          jsonb_build_array('customer', '[shared a location pin]', 'location'),
          jsonb_build_array('agent', 'للأسف ' || place || ' لسه برا مناطق التوصيل عندنا 🙏 لو قريب منك تقدر تستلم من فرع مدينة نصر أو التجمع، والطلب بيبقى جاهز في حوالي 25 دقيقة'),
          jsonb_build_array('customer', pg_temp.pick(array['خسارة، ماشي شكراً','طيب لما تفتحوا عندنا قولولي','تمام شكراً']))), at);
      end;
    end loop;
    -- a question, an answer, no order (yet)
    for k in 1..(1 + floor(random() * 3)::int) loop
      at := day0 + make_interval(hours => 12 + floor(random() * 12)::int, mins => floor(random() * 60)::int);
      continue when at > now();
      declare qa int := floor(random() * 5)::int; conv2 bigint; cid bigint; nm2 text := pg_temp.pick(m_first || f_first);
              wa2 text := '20' || pg_temp.pick(array['10','11','12','15']) || lpad((10000000 + floor(random() * 89999999))::bigint::text, 8, '0');
      begin
        insert into everwake.customers (tenant_id, wa_id, reply_to, phone, display_name, first_seen_at) values (t, wa2, wa2, wa2, nm2, at)
        on conflict do nothing returning id into cid;
        continue when cid is null;
        insert into everwake.conversations (tenant_id, customer_id, wa_id, state) values (t, cid, wa2, '{}'::jsonb) returning id into conv2;
        perform pg_temp.chat(t, conv2, wa2, case qa
          when 0 then jsonb_build_array(jsonb_build_array('customer', 'بتقفلوا الساعة كام؟'),
                        jsonb_build_array('agent', 'أهلاً بيك 😊 أنا ليلى من بيت المشويات. فروع مدينة نصر والتجمع مفتوحة لحد 2 بالليل، وزايد لحد 1. تحب أجهزلك حاجة؟'),
                        jsonb_build_array('customer', 'لا لسه، شكراً'))
          when 1 then jsonb_build_array(jsonb_build_array('customer', 'عندكم حاجة دايت؟'),
                        jsonb_build_array('agent', 'أكيد 😊 *شيش طاووق — 490ج للكيلو* صدور فراخ مشوية على الفحم من غير دهون، ومعاه *سلطة خضرا — 35ج*. تحب أجهزهولك؟'),
                        jsonb_build_array('customer', 'هفكر وأرجعلك'))
          when 2 then jsonb_build_array(jsonb_build_array('customer', 'الأسعار شاملة الضريبة؟'),
                        jsonb_build_array('agent', 'الأسعار من غير ضريبة 14%، وبتظهرلك كاملة في الملخص قبل ما تأكد أي طلب 🙏'),
                        jsonb_build_array('customer', 'تمام شكراً'))
          when 3 then jsonb_build_array(jsonb_build_array('customer', 'المشكل فيه إيه بالظبط؟'),
                        jsonb_build_array('agent', '*مشكل مشويات — 690ج للكيلو* فيه كفتة وطرب وشيش طاووق وريش، كله على الفحم 🔥 الكيلو بيكفي 2–3 أفراد. تحب أضيفلك منه؟'),
                        jsonb_build_array('customer', 'تمام، هطلب بالليل إن شاء الله'))
          else jsonb_build_array(jsonb_build_array('customer', 'عندكم فرع في المعادي؟'),
                        jsonb_build_array('agent', 'لسه مفيش فرع في المعادي 🙏 أقربلك فرع مدينة نصر، وتقدر تستلم منه في حوالي 25 دقيقة. تحب تطلب استلام؟'),
                        jsonb_build_array('customer', 'لا بعيد عليا شوية، شكراً')) end, at);
      end;
    end loop;
    -- wrote while every branch was closed
    if random() < 0.7 then
      at := day0 + make_interval(hours => 4 + floor(random() * 7)::int, mins => floor(random() * 60)::int);
      if at <= now() then
        c := cu -> floor(random() * n_cust)::int;
        perform pg_temp.chat(t, (c ->> 'conv')::bigint, c ->> 'wa', jsonb_build_array(
          jsonb_build_array('customer', pg_temp.pick(array['انتو فاتحين؟','ممكن أطلب دلوقتي؟','صباح الخير، عايز فطار'])),
          jsonb_build_array('agent', 'صباح الفل 😊 الفروع بتفتح الساعة 12 الضهر (وزايد من 1). ابعتلي ساعتها وأنا أجهزلك طلبك على طول 🙏')), at);
      end if;
    end if;
    -- a cart left before the end
    if d <= 14 then
      at := day0 + make_interval(hours => 14 + floor(random() * 9)::int, mins => floor(random() * 60)::int);
      if at <= now() - interval '2 hours' then
        c := cu -> floor(random() * n_cust)::int;
        pick := mains -> floor(random() * jsonb_array_length(mains))::int;
        q := case when pick ->> 'unit' = 'kg' then 1 else 2 end;
        at := pg_temp.chat(t, (c ->> 'conv')::bigint, c ->> 'wa', jsonb_build_array(
          jsonb_build_array('customer', 'بكام ال' || (pick ->> 'name') || '؟'),
          jsonb_build_array('agent', '*' || (pick ->> 'name') || ' — ' || pg_temp.m((pick ->> 'price')::numeric) || 'ج' || case when pick ->> 'unit' = 'kg' then ' للكيلو' else '' end || '* 😋 تحبه دليفري ولا استلام؟'),
          jsonb_build_array('customer', 'دليفري، ' || pg_temp.qty(q, pick ->> 'unit', pick ->> 'name')),
          jsonb_build_array('agent', 'ضيفتلك ' || pg_temp.qty(q, pick ->> 'unit', pick ->> 'name') || ' 👌 تحب معاه أرز بالشعرية — 50ج؟'),
          jsonb_build_array('customer', 'هشوف وأرجعلك')), at);
        insert into everwake.orders (tenant_id, customer_id, conversation_id, wa_id, branch_id, status, cart, subtotal, total, created_at, updated_at)
        values (t, (c ->> 'id')::bigint, (c ->> 'conv')::bigint, c ->> 'wa', (c ->> 'branch')::uuid, 'draft',
                jsonb_build_object('items', jsonb_build_array(jsonb_build_object('line_id', 'L1', 'code', pick ->> 'code', 'item_name', pick ->> 'name',
                  'display_name', pick ->> 'name', 'unit', pick ->> 'unit', 'quantity', q, 'unit_price', (pick ->> 'price')::numeric,
                  'line_total', (pick ->> 'price')::numeric * q, 'choices', '[]'::jsonb))),
                (pick ->> 'price')::numeric * q, (pick ->> 'price')::numeric * q, at - interval '3 minutes', at)
        on conflict do nothing;
      end if;
    end if;
  end loop;

  -- ---- table bookings -------------------------------------------------------------------------
  for k in 1..18 loop
    declare day_off int := -10 + floor(random() * 17)::int; tm time := (array['19:00','19:30','20:00','20:30','21:00','21:30','22:00'])[1 + floor(random() * 7)::int]::time;
            bb uuid := (array[b_nasr, b_tag])[1 + floor(random() * 2)::int]; rs text; at_r timestamptz; dt date;
    begin
      c := cu -> floor(random() * n_cust)::int;
      dt := (now() at time zone tz)::date + day_off;
      at_r := (dt + tm) at time zone tz;
      rs := case when at_r < now() then pg_temp.pick(array['seated','seated','seated','no_show','cancelled']) else pg_temp.pick(array['requested','confirmed','confirmed']) end;
      rseq := rseq + 1;
      insert into everwake.reservations (tenant_id, ref_no, wa_id, conversation_id, customer_id, branch_id, status, reserve_date, reserve_time, reserved_for,
                                         guests, occasion, full_name, phone, requests, requested_at, decided_at, created_at, updated_at, changed_at)
      values (t, 'GH-R' || rseq, c ->> 'wa', (c ->> 'conv')::bigint, (c ->> 'id')::bigint, bb, rs, dt, tm, at_r,
              (array[2,2,3,4,4,5,6,8,10,12])[1 + floor(random() * 10)::int],
              (array[null,null,'عيد ميلاد','عشا عائلي','خطوبة','اجتماع شغل'])[1 + floor(random() * 6)::int],
              c ->> 'name', pg_temp.local(c ->> 'wa'), (array[null,null,'ترابيزة جنب الشباك','كرسي أطفال','تورتة من عندنا'])[1 + floor(random() * 5)::int],
              least(at_r - interval '2 days', now() - interval '1 hour'), case when rs <> 'requested' then least(at_r - interval '1 day', now() - interval '30 minutes') end,
              least(at_r - interval '2 days', now() - interval '1 hour'), now() - interval '20 minutes', least(at_r - interval '2 days', now() - interval '1 hour'));
    end;
  end loop;
  update everwake.tenants set reservation_seq = rseq where id = t;

  -- ---- right now: a complaint for a person, and a question for the team --------------------
  c := cu -> 3;
  at := pg_temp.chat(t, (c ->> 'conv')::bigint, c ->> 'wa', jsonb_build_array(
    jsonb_build_array('customer', 'الأوردر وصل بارد المرة دي 😕 والبطاطس مش مقرمشة خالص'),
    jsonb_build_array('agent', 'حقك علينا جداً يا ' || (c ->> 'first') || ' 🙏 ده مش المستوى اللي نحبه ليك. بلغت مدير الفرع دلوقتي وهيكلمك بنفسه خلال دقايق')), now() - interval '9 minutes');
  update everwake.conversations set needs_attention = true, attention_at = now() - interval '8 minutes',
         attention_reason = 'شكوى: الأوردر وصل بارد والبطاطس مش مقرمشة — العميل محتاج مكالمة من مدير الفرع', unread_count = 1
   where id = (c ->> 'conv')::bigint;
  update everwake.conversations set attention_at = now() - make_interval(days => 2 + floor(random() * 12)::int)
   where id in (select (x ->> 'conv')::bigint from jsonb_array_elements(cu) x order by random() limit 4);

  c := cu -> 8;
  at := pg_temp.chat(t, (c ->> 'conv')::bigint, c ->> 'wa', jsonb_build_array(
    jsonb_build_array('customer', 'عندي عزومة بكرة 20 فرد، ينفع تعملولي صينية مشكل كبيرة الساعة 4؟'),
    jsonb_build_array('agent', 'يا سلام، عزومة حلوة 😍 هتأكد من الفرع إنهم يقدروا يجهزوها لبكرة الساعة 4 وأرجعلك على طول. على ما يردوا، تحبوا لحمة بس ولا معاها فراخ؟')), now() - interval '4 minutes');
  update everwake.conversations set unread_count = 1 where id = (c ->> 'conv')::bigint;
  if to_regclass('everwake.team_questions') is not null then
    execute 'insert into everwake.team_questions (tenant_id, conversation_id, wa_id, question, asked_at) values ($1, $2, $3, $4, $5)'
      using t, (c ->> 'conv')::bigint, c ->> 'wa', 'عميل عايز صينية مشكل مشويات لـ20 فرد بكرة الساعة 4 العصر (دليفري التجمع). فرع التجمع يقدر يجهزها؟', now() - interval '3 minutes';
    execute 'update everwake.conversations set questions_open = 1 where id = $1' using (c ->> 'conv')::bigint;
  end if;

  -- ---- the totals every page reads -------------------------------------------------------------
  update everwake.customers c2 set
    orders_count = (select count(*) from everwake.orders o where o.customer_id = c2.id and o.status not in ('draft', 'cancelled', 'rejected')),
    total_spent = coalesce((select sum(total) from everwake.orders o where o.customer_id = c2.id and o.status not in ('draft', 'cancelled', 'rejected')), 0),
    last_order_id = (select o.id from everwake.orders o where o.customer_id = c2.id and o.status <> 'draft' order by o.placed_at desc limit 1),
    last_order_at = (select max(placed_at) from everwake.orders o where o.customer_id = c2.id and o.status <> 'draft'),
    first_seen_at = coalesce((select min(created_at) from everwake.messages m where m.tenant_id = t and m.wa_id = c2.wa_id), c2.first_seen_at),
    created_at = coalesce((select min(created_at) from everwake.messages m where m.tenant_id = t and m.wa_id = c2.wa_id), c2.created_at),
    last_seen_at = coalesce((select max(created_at) from everwake.messages m where m.tenant_id = t and m.wa_id = c2.wa_id and m.direction = 'inbound'), c2.last_seen_at)
   where c2.tenant_id = t;
  insert into everwake.customer_addresses (tenant_id, customer_id, fingerprint, area, street, building, floor, apartment, zone_id, branch_id, address_text, use_count, last_used_at)
  select t, o.customer_id, md5(o.address_text), o.address ->> 'area', o.address ->> 'street', o.address ->> 'building', o.address ->> 'floor',
         o.address ->> 'apartment', o.zone_id, o.branch_id, o.address_text, count(*), max(o.placed_at)
    from everwake.orders o where o.tenant_id = t and o.delivery_method = 'delivery' and o.status <> 'draft' and o.customer_id is not null
   group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
  on conflict do nothing;
  update everwake.conversations cv set
    last_message_at = m.last_at, last_inbound_at = m.last_in, last_outbound_at = m.last_out, created_at = m.first_at,
    last_message_preview = left((select body from everwake.messages x where x.conversation_id = cv.id order by created_at desc, id desc limit 1), 160)
  from (select conversation_id, max(created_at) as last_at, min(created_at) as first_at,
               max(created_at) filter (where direction = 'inbound') as last_in, max(created_at) filter (where direction = 'outbound') as last_out
          from everwake.messages where tenant_id = t group by 1) m
  where cv.id = m.conversation_id;
  delete from everwake.conversations where tenant_id = t and last_message_at is null;
  delete from everwake.customers c3 where c3.tenant_id = t and not exists (select 1 from everwake.messages m where m.tenant_id = t and m.wa_id = c3.wa_id);

  perform everwake.rebuild_snapshot(t);
  raise notice 'Grill House is ready: % orders, % chats', (select count(*) from everwake.orders where tenant_id = t and status <> 'draft'),
                                                     (select count(*) from everwake.conversations where tenant_id = t);
end $$;

select count(*) filter (where status <> 'draft') as orders,
       count(*) filter (where status in ('placed', 'accepted', 'preparing', 'ready', 'out_for_delivery')) as live_on_the_board,
       round(sum(total) filter (where status not in ('draft', 'cancelled', 'rejected'))) as revenue_30_days,
       (select count(*) from everwake.conversations c where c.tenant_id = o.tenant_id) as chats,
       (select count(*) from everwake.tenant_members m where m.tenant_id = o.tenant_id) as dashboard_members
  from everwake.orders o where o.tenant_id = (select id from everwake.tenants where slug = 'grill_house')
 group by o.tenant_id;
