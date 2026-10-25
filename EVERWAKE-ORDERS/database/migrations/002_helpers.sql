-- =====================================================================
-- Everwake Orders · 002 · helpers
-- Text matching, geometry, defaults, templates, and the triggers that
-- make every dashboard edit reach the agent on its very next message.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Who is calling. Works on Supabase (PostgREST puts the JWT in
-- request.jwt.claims) and anywhere else that sets the same setting.
-- The n8n engine connects as a database role and has no user: null.
-- ---------------------------------------------------------------------
create or replace function everwake.current_user_id()
returns uuid language sql stable as $$
  select nullif(coalesce(
           nullif(current_setting('request.jwt.claim.sub', true), ''),
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Arabic-aware matching key: same rules as normalizeArabic() in the
-- engine, so SQL and JS agree on what "the same name" means.
-- ---------------------------------------------------------------------
create or replace function everwake.norm(t text)
returns text language sql immutable parallel safe as $$
  select btrim(regexp_replace(
           regexp_replace(
             translate(lower(coalesce(t, '')), 'أإآىةٱ٠١٢٣٤٥٦٧٨٩', 'ااايها0123456789'),
             '[ً-ٰٟـ]', '', 'g'),
           '[^a-z0-9ء-ي]+', ' ', 'g'))
$$;

create or replace function everwake.digits(t text)
returns text language sql immutable parallel safe as $$
  select regexp_replace(translate(coalesce(t, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '\D', '', 'g')
$$;

create or replace function everwake.fmt_money(n numeric)
returns text language sql immutable parallel safe as $$
  select case when n is null then null else trim_scale(round(n, 2))::text end
$$;

-- ---------------------------------------------------------------------
-- Geometry (plain SQL, no PostGIS needed)
-- ---------------------------------------------------------------------
create or replace function everwake.haversine_km(lat1 double precision, lng1 double precision,
                                                 lat2 double precision, lng2 double precision)
returns numeric language sql immutable parallel safe as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null else
    round((6371 * 2 * asin(least(1, sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))))::numeric, 2)
  end
$$;

-- polygon = [[lat,lng], …] (or [{"lat":…,"lng":…}, …]); ray casting
create or replace function everwake.point_in_polygon(p_lat double precision, p_lng double precision, p_poly jsonb)
returns boolean language plpgsql immutable parallel safe as $$
declare
  n int; i int; j int;
  yi double precision; xi double precision; yj double precision; xj double precision;
  inside boolean := false;
begin
  if p_lat is null or p_lng is null or p_poly is null or jsonb_typeof(p_poly) <> 'array' then
    return false;
  end if;
  n := jsonb_array_length(p_poly);
  if n < 3 then return false; end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    if jsonb_typeof(p_poly -> i) = 'object' then
      yi := (p_poly -> i ->> 'lat')::double precision; xi := (p_poly -> i ->> 'lng')::double precision;
    else
      yi := (p_poly -> i ->> 0)::double precision;     xi := (p_poly -> i ->> 1)::double precision;
    end if;
    if jsonb_typeof(p_poly -> j) = 'object' then
      yj := (p_poly -> j ->> 'lat')::double precision; xj := (p_poly -> j ->> 'lng')::double precision;
    else
      yj := (p_poly -> j ->> 0)::double precision;     xj := (p_poly -> j ->> 1)::double precision;
    end if;
    if ((yi > p_lat) <> (yj > p_lat))
       and (p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi) then
      inside := not inside;
    end if;
    j := i;
  end loop;
  return inside;
end $$;

-- ---------------------------------------------------------------------
-- Defaults. Stored settings are merged over these, so a new restaurant
-- works on day one and every value can be changed from the dashboard.
-- ---------------------------------------------------------------------
create or replace function everwake.default_settings()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'payment_methods', jsonb_build_array('cash'),
    'required_fields', jsonb_build_object(
      'delivery', jsonb_build_array('phone_confirmed', 'full_name', 'delivery_method', 'address_area', 'address_street',
                                    'address_building', 'address_floor', 'address_apartment', 'payment_method'),
      'pickup',   jsonb_build_array('phone_confirmed', 'full_name', 'delivery_method'),
      'unknown',  jsonb_build_array('phone_confirmed', 'full_name', 'delivery_method')),
    'max_delivery_km', 15,
    'require_zone_for_delivery', true,
    'accept_orders_when_closed', false,
    'human_auto_release_minutes', 30,
    'phone_reply_takes_over', true,
    'auto_takeover_on_handoff', false,
    'send_order_ticket', true,
    'ops_whatsapp', '',
    'test_numbers', jsonb_build_array(),
    'aggregator_commission_percent', 25,
    'allowed_links', jsonb_build_array(),
    'templates', jsonb_build_object(
      'pause_apology_ar', 'أهلاً {name} 🙏 معلش جداً، خط الطلبات على الواتساب واقف مؤقتاً بسبب ضغط الطلبات. أول ما نرجع هنبعتلك رسالة هنا على طول علشان تطلب براحتك. متشكرين لصبرك.',
      'pause_apology_en', 'Hi {name}, we are really sorry 🙏 Our WhatsApp ordering line is paused for a little while because we are very busy. We will message you right here as soon as we are back so you can order. Thank you for your patience.',
      'resume_notice_ar', 'أهلاً {name} 👋 رجعنا نستقبل الطلبات على الواتساب! متشكرين جداً إنك استنيتنا، ابعتلنا طلبك وإحنا معاك.',
      'resume_notice_en', 'Hi {name} 👋 We are back and taking orders on WhatsApp again! Thank you so much for waiting, just send us what you would like.',
      'status_accepted_ar', 'تمام 👨‍🍳 طلبك رقم {order_no} اتأكد من فرع {branch} وبيتجهز دلوقتي.{eta}',
      'status_accepted_en', 'Great 👨‍🍳 Your order {order_no} is confirmed by our {branch} branch and is being prepared now.{eta}',
      'status_ready_ar', 'طلبك رقم {order_no} جاهز للاستلام من فرع {branch} ✅',
      'status_ready_en', 'Your order {order_no} is ready for pickup at our {branch} branch ✅',
      'status_out_for_delivery_ar', 'طلبك رقم {order_no} خرج مع مندوب التوصيل وفي الطريق ليك 🛵',
      'status_out_for_delivery_en', 'Your order {order_no} is out for delivery and on its way to you 🛵',
      'status_delivered_ar', 'بالهنا والشفا! لو احتجت أي حاجة إحنا هنا.',
      'status_delivered_en', 'Enjoy your meal! If you need anything, we are right here.',
      'status_rejected_ar', 'معلش جداً، مقدرناش ننفذ طلبك رقم {order_no}.{reason} لو تحب نساعدك في طلب تاني إحنا موجودين.',
      'status_rejected_en', 'We are really sorry, we could not fulfil your order {order_no}.{reason} If you would like help with another order, we are here.',
      'status_cancelled_ar', 'طلبك رقم {order_no} اتلغى.{reason} لو حابب تطلب تاني إحنا موجودين.',
      'status_cancelled_en', 'Your order {order_no} has been cancelled.{reason} If you would like to order again, we are here.'))
$$;

create or replace function everwake.default_profile()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'agent_name', jsonb_build_object('ar', 'ياسمين', 'en', 'Yasmin'),
    'about_ar', '', 'about_en', '', 'cuisine', '', 'tone', '',
    'brand_facts', jsonb_build_array(),
    'contacts', jsonb_build_object('hotline', '', 'complaints', '', 'whatsapp', '', 'email', ''),
    'website', '', 'instagram', '', 'facebook', '', 'tiktok', '', 'google_maps_url', '')
$$;

create or replace function everwake.merged_settings(p_settings jsonb)
returns jsonb language sql immutable as $$
  select everwake.default_settings()
         || coalesce(p_settings, '{}'::jsonb)
         || jsonb_build_object(
              'templates', (everwake.default_settings() -> 'templates') || coalesce(p_settings -> 'templates', '{}'::jsonb),
              'required_fields', (everwake.default_settings() -> 'required_fields') || coalesce(p_settings -> 'required_fields', '{}'::jsonb))
$$;

create or replace function everwake.merged_profile(p_profile jsonb)
returns jsonb language sql immutable as $$
  select everwake.default_profile()
         || coalesce(p_profile, '{}'::jsonb)
         || jsonb_build_object(
              'agent_name', (everwake.default_profile() -> 'agent_name') || coalesce(p_profile -> 'agent_name', '{}'::jsonb),
              'contacts', (everwake.default_profile() -> 'contacts') || coalesce(p_profile -> 'contacts', '{}'::jsonb))
$$;

-- {name} style placeholders; an empty value leaves no stray space behind
create or replace function everwake.render_template(tpl text, vars jsonb)
returns text language plpgsql immutable as $$
declare
  k text; v text; out text := coalesce(tpl, '');
begin
  for k, v in select key, value from jsonb_each_text(coalesce(vars, '{}'::jsonb)) loop
    out := replace(out, '{' || k || '}', coalesce(v, ''));
  end loop;
  out := regexp_replace(out, '\{[a-z_]+\}', '', 'g');
  out := regexp_replace(out, '[ \t]+([،,.!؟?])', '\1', 'g');
  out := regexp_replace(out, '[ \t]{2,}', ' ', 'g');
  return btrim(out);
end $$;

-- the customer's first name for a template: their given name, never a long WhatsApp nickname
create or replace function everwake.first_name(full_name text, display_name text)
returns text language sql immutable as $$
  select coalesce(
    nullif(split_part(btrim(coalesce(full_name, '')), ' ', 1), ''),
    case when length(btrim(coalesce(display_name, ''))) between 2 and 20
              and btrim(display_name) ~ '^[ء-يA-Za-z ]+$'
         then split_part(btrim(display_name), ' ', 1) end,
    '')
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
create or replace function everwake.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Anything the agent reads changed → the restaurant's menu revision goes
-- up once per transaction; the next turn rebuilds the snapshot.
create or replace function everwake.bump_menu_rev()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  t uuid := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
begin
  update everwake.tenants
     set menu_rev = menu_rev + 1, menu_rev_txid = txid_current()
   where id = t and menu_rev_txid is distinct from txid_current();
  return null;
end $$;

create or replace function everwake.tenants_before_update()
returns trigger language plpgsql as $$
begin
  if (new.profile, new.settings, new.name_ar, new.name_en, new.timezone, new.currency, new.currency_symbol_ar,
      new.default_language, new.order_no_prefix, new.status)
     is distinct from
     (old.profile, old.settings, old.name_ar, old.name_en, old.timezone, old.currency, old.currency_symbol_ar,
      old.default_language, old.order_no_prefix, old.status)
     and new.menu_rev = old.menu_rev then
    new.menu_rev := old.menu_rev + 1;
    new.menu_rev_txid := txid_current();
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function everwake.assign_item_code()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
declare s int;
begin
  if new.code is null or btrim(new.code) = '' then
    loop
      update everwake.tenants set item_seq = item_seq + 1 where id = new.tenant_id returning item_seq into s;
      new.code := 'M' || lpad(s::text, 3, '0');
      exit when not exists (select 1 from everwake.menu_items where tenant_id = new.tenant_id and code = new.code);
    end loop;
  end if;
  new.code := upper(btrim(new.code));
  return new;
end $$;

-- who changed what, from the dashboard (the engine has no user and is not audited here)
create or replace function everwake.audit_change()
returns trigger language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  uid uuid := everwake.current_user_id();
  diff jsonb;
  rid text;
  tid uuid;
begin
  if uid is null then return null; end if;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_array(to_jsonb(old) -> n.key, n.value))
      into diff
      from jsonb_each(to_jsonb(new)) n
     where n.key not in ('updated_at', 'menu_rev', 'menu_rev_txid', 'item_seq', 'order_seq',
                         'api_key', 'cloud_access_token', 'webhook_token')
       and (to_jsonb(old) -> n.key) is distinct from n.value;
    if diff is null then return null; end if;
  elsif tg_op = 'INSERT' then
    diff := to_jsonb(new) - 'api_key' - 'cloud_access_token' - 'webhook_token';
  else
    diff := to_jsonb(old) - 'api_key' - 'cloud_access_token' - 'webhook_token';
  end if;
  rid := coalesce(to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'id',
                  to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'item_id');
  tid := case when tg_table_name = 'tenants' then (to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'id')::uuid
              else (to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'tenant_id')::uuid end;
  insert into everwake.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
  values (tid, uid, lower(tg_op), tg_table_name, rid, diff);
  return null;
end $$;

-- wire them up -----------------------------------------------------------
create trigger tenants_before_update before update on everwake.tenants
  for each row execute function everwake.tenants_before_update();

create trigger menu_items_assign_code before insert on everwake.menu_items
  for each row execute function everwake.assign_item_code();

do $$
declare t text;
begin
  -- updated_at
  foreach t in array array['branches', 'delivery_zones', 'whatsapp_channels', 'menu_categories', 'menu_items',
                           'menu_option_groups', 'menu_options', 'menu_item_branches', 'menu_imports', 'offers',
                           'knowledge_entries', 'customers', 'conversations', 'orders'] loop
    execute format('create trigger %I before update on everwake.%I for each row execute function everwake.touch_updated_at()',
                   t || '_touch', t);
  end loop;
  -- what the agent reads
  foreach t in array array['branches', 'delivery_zones', 'menu_categories', 'menu_items', 'menu_option_groups',
                           'menu_options', 'menu_item_branches', 'item_media', 'menu_media', 'offers',
                           'knowledge_entries'] loop
    execute format('create trigger %I after insert or update or delete on everwake.%I for each row execute function everwake.bump_menu_rev()',
                   t || '_menu_rev', t);
  end loop;
  -- the audit trail of dashboard edits
  foreach t in array array['tenants', 'branches', 'delivery_zones', 'menu_categories', 'menu_items', 'menu_options',
                           'menu_item_branches', 'offers', 'knowledge_entries', 'whatsapp_channels', 'tenant_members'] loop
    execute format('create trigger %I after insert or update or delete on everwake.%I for each row execute function everwake.audit_change()',
                   t || '_audit', t);
  end loop;
end $$;
