-- =====================================================================
-- Everwake Orders · moving a one-schema-per-brand client onto the platform
--
-- Seagull, Bazooka and 5 Roosters each run on a schema of their own
-- (seagull.branches, seagull.menu_snapshot, seagull.customers,
-- seagull.orders, seagull.messages, seagull.menu_media, seagull.settings).
-- import_legacy_schema() copies one of them into a restaurant here:
--
--   · branches, keyed by the old ids, with a delivery circle each from
--     max_delivery_km, so delivery works as before until zones are drawn
--   · the menu from the old snapshot: the same dish codes (M001…), every
--     choice level, and each branch's own prices and listings
--   · the menu pages, the agent's name, contacts, facts, payment methods
--   · customers (by number or by WhatsApp private id), their past orders
--     (so "same as last time" works from the first message), their saved
--     addresses, and the recent message history for the inbox
--
-- Every old table is read as jsonb, so a column the old schema does not
-- have is simply empty, not an error. Old orders come in as finished
-- (delivered / picked up / cancelled): nothing rings on the order board.
-- Safe to run again: imported rows are matched, not duplicated; branches
-- and dishes are refreshed from the old schema, settings the restaurant
-- already filled in are kept. Run it before going live.
--
-- As the database owner (not from the dashboard):
--   pg_dump "$OLD_DB" -n seagull --no-owner | psql "$NEW_DB"
--   psql "$NEW_DB" -f database/tools/import_legacy.sql
--   psql "$NEW_DB" -c "select jsonb_pretty(everwake.import_legacy_schema('<tenant id>', 'seagull'))"
--
-- Options (jsonb, all optional):
--   {"menu": true, "zones": true, "orders": true, "messages_days": 90,
--    "force_menu": false}
--   force_menu: merge the old menu into a restaurant that already has
--   one (dishes are matched by code)
-- =====================================================================

-- ---------------------------------------------------------------------
-- reading an old schema without knowing its exact columns
-- ---------------------------------------------------------------------
create or replace function everwake.legacy_rows(p_schema text, p_table text)
returns setof jsonb language plpgsql stable as $$
begin
  if to_regclass(format('%I.%I', p_schema, p_table)) is null then return; end if;
  return query execute format('select to_jsonb(t) from %I.%I t', p_schema, p_table);
end $$;

-- the first of the keys holding a non-empty plain value
create or replace function everwake.legacy_pick(j jsonb, k text[])
returns text language sql immutable as $$
  select s.v
    from unnest(k) with ordinality as u(key, n)
    cross join lateral (select case when jsonb_typeof(j -> u.key) in ('string', 'number', 'boolean')
                                    then nullif(btrim(j ->> u.key), '') end as v) s
   where s.v is not null
   order by u.n
   limit 1
$$;

create or replace function everwake.legacy_num(p text)
returns numeric language sql immutable as $$
  select case when btrim(p) ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(p)::numeric end
$$;

create or replace function everwake.legacy_bool(p text, p_default boolean)
returns boolean language sql immutable as $$
  select case when lower(btrim(p)) in ('true', 't', '1', 'yes', 'y') then true
              when lower(btrim(p)) in ('false', 'f', '0', 'no', 'n') then false
              else p_default end
$$;

create or replace function everwake.legacy_ts(p text)
returns timestamptz language plpgsql stable as $$
begin
  return nullif(btrim(p), '')::timestamptz;
exception when others then
  return null;
end $$;

-- a jsonb array of strings, or a text with one value per line → text[]
create or replace function everwake.legacy_list(p jsonb)
returns text[] language sql immutable as $$
  select coalesce(array_agg(v order by src, n) filter (where v <> ''), '{}')
    from (select 1 as src, a.n, btrim(a.x) as v
            from jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end)
                 with ordinality as a(x, n)
          union all
          select 2, b.n, btrim(b.x)
            from regexp_split_to_table(case when jsonb_typeof(p) = 'string' then p #>> '{}' else '' end, E'\n')
                 with ordinality as b(x, n)) s
$$;

-- old payment wording → the platform's methods (cash, card, wallet, instapay)
create or replace function everwake.legacy_payment(p text)
returns text language sql immutable as $$
  select case
           when everwake.norm(p) ~ '(cash|كاش|نقد|كاش عند الاستلام)' and everwake.norm(p) !~ '(vodafone|فودافون|wallet|محفظه)' then 'cash'
           when everwake.norm(p) ~ '(instapay|انستا ?باي|insta pay)' then 'instapay'
           when everwake.norm(p) ~ '(wallet|محفظه|vodafone|فودافون|orange|اورنج|etisalat|اتصالات|we pay)' then 'wallet'
           when everwake.norm(p) ~ '(card|visa|كارت|فيزا|ماستر|master|pos)' then 'card'
           else nullif(lower(btrim(p)), '') end
$$;

-- is this old customer key a WhatsApp private id? Decided from the jids
-- the old messages carried (_lg_jid), else from its length.
create or replace function everwake.legacy_is_lid(p_wa text)
returns boolean language plpgsql stable as $$
begin
  if exists (select 1 from _lg_jid where value = p_wa and kind = 'phone') then return false; end if;
  if exists (select 1 from _lg_jid where value = p_wa and kind = 'lid') then return true; end if;
  return length(p_wa) >= 14;
end $$;

-- the platform's customer for an old customer key, created when missing
create or replace function everwake.legacy_customer(p_tenant uuid, p_wa text, p_name text, p_full_name text,
                                                    p_seen timestamptz)
returns bigint language plpgsql as $$
declare
  v_id   bigint;
  v_lid  boolean;
  v_kind text;
begin
  if coalesce(p_wa, '') = '' then return null; end if;
  select id into v_id from _lg_cust where wa = p_wa;
  if v_id is not null then return v_id; end if;

  v_lid := everwake.legacy_is_lid(p_wa);
  v_kind := case when v_lid then 'lid' else 'phone' end;
  select customer_id into v_id from everwake.customer_identities
   where tenant_id = p_tenant and kind = v_kind and value = p_wa;
  if v_id is null then
    select id into v_id from everwake.customers where tenant_id = p_tenant and wa_id = p_wa;
  end if;
  if v_id is null then
    insert into everwake.customers (tenant_id, wa_id, reply_to, phone, lid, phone_hidden, display_name, full_name,
                                    first_seen_at, last_seen_at)
    values (p_tenant, p_wa, case when v_lid then p_wa || '@lid' else p_wa end,
            case when not v_lid then p_wa end, case when v_lid then p_wa end, v_lid,
            nullif(btrim(p_name), ''), nullif(btrim(p_full_name), ''),
            coalesce(p_seen, now()), coalesce(p_seen, now()))
    returning id into v_id;
  else
    update everwake.customers c
       set display_name  = coalesce(c.display_name, nullif(btrim(p_name), '')),
           full_name     = coalesce(c.full_name, nullif(btrim(p_full_name), '')),
           first_seen_at = least(c.first_seen_at, coalesce(p_seen, c.first_seen_at))
     where c.id = v_id;
  end if;
  insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
  values (p_tenant, v_kind, p_wa, v_id) on conflict do nothing;
  insert into _lg_cust (wa, id) values (p_wa, v_id) on conflict do nothing;
  return v_id;
end $$;

-- an old cart line → the platform's line (what reorder_last and the
-- order board read). Old dish codes are mapped through _lg_item.
create or replace function everwake.legacy_cart(p_cart jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_items jsonb := '[]'::jsonb;
  i       jsonb;
  n       int := 0;
  v_old   text;
  m       record;
  v_qty   numeric;
  v_unit  numeric;
  v_line  numeric;
begin
  for i in select x from jsonb_array_elements(case when jsonb_typeof(p_cart -> 'items') = 'array' then p_cart -> 'items'
                                                   when jsonb_typeof(p_cart) = 'array' then p_cart
                                                   else '[]'::jsonb end) x loop
    continue when jsonb_typeof(i) <> 'object';
    n := n + 1;
    v_old := upper(coalesce(everwake.legacy_pick(i, array['menu_id', 'code', 'item_code']), ''));
    select * into m from _lg_item where old_code = v_old;
    v_qty := coalesce(everwake.legacy_num(i ->> 'quantity'), 1);
    v_unit := everwake.legacy_num(everwake.legacy_pick(i, array['unit_price_egp', 'unit_price', 'price_egp', 'price']));
    v_line := coalesce(everwake.legacy_num(everwake.legacy_pick(i, array['line_total_egp', 'line_total', 'total_egp'])),
                       round(v_unit * v_qty, 2));
    v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'line_id', coalesce(everwake.legacy_pick(i, array['line_id']), 'L' || n),
      'item_id', m.id,
      'code', coalesce(m.code, nullif(v_old, '')),
      'item_name', coalesce(everwake.legacy_pick(i, array['item_name', 'display_name', 'name']), '?'),
      'display_name', coalesce(everwake.legacy_pick(i, array['display_name', 'item_name', 'name']), '?'),
      'name_en', everwake.legacy_pick(i, array['name_en']),
      'category', everwake.legacy_pick(i, array['category']),
      'unit', coalesce(everwake.legacy_pick(i, array['unit']), 'portion'),
      'quantity', v_qty,
      'base_price', everwake.legacy_num(everwake.legacy_pick(i, array['base_price_egp', 'base_price'])),
      'price_known', everwake.legacy_bool(i ->> 'price_known', true),
      'choices', (select coalesce(jsonb_agg(jsonb_build_object(
                           'level', c -> 'level', 'label_ar', c -> 'label_ar',
                           'selected', (select coalesce(jsonb_agg(case when jsonb_typeof(s) = 'object'
                                                                       then jsonb_strip_nulls(jsonb_build_object(
                                                                              'name', s ->> 'name',
                                                                              'adds', coalesce(everwake.legacy_num(everwake.legacy_pick(s, array['adds', 'adds_egp', 'price_egp'])), 0),
                                                                              'extra_charge', case when everwake.legacy_bool(s ->> 'extra_charge', false) then true end))
                                                                       else jsonb_build_object('name', s #>> '{}', 'adds', 0) end), '[]'::jsonb)
                                          from jsonb_array_elements(case when jsonb_typeof(c -> 'selected') = 'array' then c -> 'selected' else '[]'::jsonb end) s),
                           'adds', coalesce(everwake.legacy_num(everwake.legacy_pick(c, array['adds', 'adds_egp'])), 0))), '[]'::jsonb)
                    from jsonb_array_elements(case when jsonb_typeof(i -> 'choices') = 'array' then i -> 'choices' else '[]'::jsonb end) c
                   where jsonb_typeof(c) = 'object'),
      'choices_total', everwake.legacy_num(everwake.legacy_pick(i, array['choices_total_egp', 'choices_total'])),
      'unit_price', v_unit,
      'line_total', v_line,
      'extra_charge', case when everwake.legacy_bool(i ->> 'extra_charge', false) then true end,
      'gift', case when everwake.legacy_bool(coalesce(i ->> 'gift', i ->> 'is_gift'), false) then true end,
      'notes', everwake.legacy_pick(i, array['notes']))));
  end loop;
  return jsonb_build_object('items', v_items);
end $$;

-- ---------------------------------------------------------------------
-- the import
-- ---------------------------------------------------------------------
create or replace function everwake.import_legacy_schema(p_tenant uuid, p_schema text, p_options jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  t         everwake.tenants%rowtype;
  o_menu    boolean := coalesce((p_options ->> 'menu')::boolean, true);
  o_zones   boolean := coalesce((p_options ->> 'zones')::boolean, true);
  o_orders  boolean := coalesce((p_options ->> 'orders')::boolean, true);
  o_days    int     := coalesce((p_options ->> 'messages_days')::int, 90);
  o_force   boolean := coalesce((p_options ->> 'force_menu')::boolean, false);
  v_rerun   boolean;
  v_snaps   jsonb;      -- {scope: lookup} from the old menu_snapshot
  v_all     jsonb;
  v_cfg     jsonb;      -- old settings table + the snapshot's settings
  v_items   jsonb;
  v_choices jsonb;
  v_prof    jsonb;
  v_set     jsonb;
  v_warn    text[] := '{}';
  j         jsonb;
  grp       jsonb;
  opt       jsonb;
  e         record;
  n         int;
  v_code    text;
  v_lid     text;
  v_bid     uuid;
  v_hours   jsonb;
  v_open    text;
  v_close   text;
  v_km      numeric;
  v_cat     uuid;
  v_cat_name text;
  v_csort   int;
  v_iid     uuid;
  v_icode   text;
  v_unit    text;
  v_price   numeric;
  v_group   uuid;
  v_level   int;
  v_used    int[];
  v_osort   int;
  v_url     text;
  v_mime    text;
  v_prefix  text;
  v_wa      text;
  v_cid     bigint;
  v_no      text;
  v_oid     bigint;
  v_status  text;
  v_method  text;
  v_placed  timestamptz;
  v_cart    jsonb;
  v_cust    jsonb;
  v_addr    jsonb;
  v_loc     jsonb;
  v_lat     double precision;
  v_lng     double precision;
  v_zone    uuid;
  v_match   jsonb;
  v_phone   text;
  v_sub     numeric;
  v_fee     numeric;
  v_total   numeric;
  n_branches int := 0; n_zones int := 0; n_cats int := 0; n_items int := 0; n_choice_items int := 0;
  n_overrides int := 0; n_photos int := 0; n_pages int := 0; n_page_rows int := 0; n_customers int := 0;
  n_orders int := 0; n_skipped int := 0; n_addresses int := 0; n_messages int := 0; n_no_hours int := 0;
  v_report  jsonb;
begin
  select * into t from everwake.tenants where id = p_tenant for update;
  if not found then raise exception 'no restaurant with id %', p_tenant; end if;
  if p_schema in ('everwake', 'public', 'pg_catalog', 'information_schema', 'auth', 'storage', 'realtime')
     or p_schema = 'r_' || t.slug then
    raise exception 'schema % is not an old restaurant schema', p_schema;
  end if;
  if not exists (select 1 from pg_namespace where nspname = p_schema) then
    raise exception 'schema % is not in this database: copy it first (pg_dump -n % --no-owner | psql)', p_schema, p_schema;
  end if;
  v_rerun := exists (select 1 from everwake.audit_log
                      where tenant_id = p_tenant and action = 'legacy_import' and entity = p_schema);

  -- scratch tables, gone at the end of the transaction
  if to_regclass('pg_temp._lg_branch') is not null then drop table _lg_branch, _lg_item, _lg_cust, _lg_jid; end if;
  create temp table _lg_branch (legacy_id text primary key, id uuid not null, code text, name_ar text,
                                lat double precision, lng double precision, max_km numeric) on commit drop;
  create temp table _lg_item (old_code text primary key, old_key text, code text, id uuid, base_price numeric,
                              base_available boolean) on commit drop;
  create temp table _lg_cust (wa text primary key, id bigint not null) on commit drop;
  create temp table _lg_jid (value text, kind text, primary key (value, kind)) on commit drop;

  select coalesce(jsonb_object_agg(r ->> 'id', r -> 'lookup'), '{}'::jsonb) into v_snaps
    from everwake.legacy_rows(p_schema, 'menu_snapshot') r
   where r ? 'id' and jsonb_typeof(r -> 'lookup') = 'object';
  v_all := coalesce(v_snaps -> 'all', '{}'::jsonb);
  select coalesce(jsonb_object_agg(r ->> 'key', r -> 'value'), '{}'::jsonb) into v_cfg
    from everwake.legacy_rows(p_schema, 'settings') r
   where nullif(r ->> 'key', '') is not null;
  v_cfg := case when jsonb_typeof(v_all -> 'settings') = 'object' then v_all -> 'settings' else '{}'::jsonb end || v_cfg;

  v_items := case when jsonb_typeof(v_all -> 'items') = 'object' then v_all -> 'items' else '{}'::jsonb end;
  v_choices := case when jsonb_typeof(v_all -> 'choices') = 'object' then v_all -> 'choices' else '{}'::jsonb end;
  -- a dish only some branch snapshots carry
  for e in select s.key as scope, x.key, x.value
             from jsonb_each(v_snaps) s, jsonb_each(case when jsonb_typeof(s.value -> 'items') = 'object'
                                                         then s.value -> 'items' else '{}'::jsonb end) x
            where s.key <> 'all' order by s.key loop
    if not v_items ? e.key then
      v_items := v_items || jsonb_build_object(e.key, e.value);
      if v_snaps -> e.scope -> 'choices' ? e.key and not v_choices ? e.key then
        v_choices := v_choices || jsonb_build_object(e.key, v_snaps -> e.scope -> 'choices' -> e.key);
      end if;
    end if;
  end loop;

  -- checked before anything is written
  if o_menu and v_items <> '{}'::jsonb and not v_rerun and not o_force
     and exists (select 1 from everwake.menu_items where tenant_id = p_tenant and is_active) then
    raise exception 'this restaurant already has a menu. Pass {"menu": false} to keep it, or {"force_menu": true} to merge the old one into it (dishes matched by code)';
  end if;

  -- ===================================================================
  -- 1. Branches
  -- ===================================================================
  n := 0;
  for j in
    select coalesce(lb.b, '{}'::jsonb) || r        -- the table wins over the snapshot's copy
      from everwake.legacy_rows(p_schema, 'branches') r
      left join lateral (
        select x as b
          from jsonb_array_elements(case when jsonb_typeof(v_all -> 'branches') = 'array' then v_all -> 'branches'
                                         else '[]'::jsonb end) x
         where jsonb_typeof(x) = 'object' and (x ->> 'id' = r ->> 'id' or x ->> 'code' = r ->> 'id')
         limit 1) lb on true
     order by everwake.legacy_num(r ->> 'sort') nulls last, r ->> 'id'
  loop
    n := n + 1;
    v_lid := coalesce(everwake.legacy_pick(j, array['id', 'code']), 'branch_' || n);
    v_code := left(btrim(regexp_replace(lower(coalesce(everwake.legacy_pick(j, array['code', 'id']), '')),
                                        '[^a-z0-9_]+', '_', 'g'), '_'), 30);
    if v_code ~ '^[0-9a-f]{8}_' or v_code ~ '^[0-9]+$' then      -- a uuid or a number: a name reads better
      v_code := nullif(left(everwake.slugify(everwake.legacy_pick(j, array['name_en'])), 30), '');
    end if;
    if coalesce(v_code, '') !~ '^[a-z0-9_]{2,30}$' or exists (select 1 from _lg_branch where code = v_code) then
      v_code := 'branch_' || n;
    end if;

    v_hours := case when jsonb_typeof(j -> 'hours') = 'object' then j -> 'hours'
                    when jsonb_typeof(j -> 'opening_hours') = 'object' then j -> 'opening_hours'
                    else '{}'::jsonb end;
    if v_hours = '{}'::jsonb then
      v_open := substring(everwake.legacy_pick(j, array['opens_at', 'open_time', 'opens', 'open_at']) from '^\d{1,2}:\d{2}');
      v_close := substring(everwake.legacy_pick(j, array['closes_at', 'close_time', 'closes', 'close_at']) from '^\d{1,2}:\d{2}');
      if v_open is not null and v_close is not null then
        v_hours := jsonb_build_object('default', jsonb_build_array(jsonb_build_object('open', v_open, 'close', v_close)));
      end if;
    end if;

    insert into everwake.branches as b
      (tenant_id, code, name_ar, name_en, aliases, area_ar, address_ar, address_en, lat, lng, maps_url, phone,
       ops_whatsapp, hours, hours_text_ar, accepting_orders, delivery_enabled, pickup_enabled, delivery_fee,
       min_order, max_delivery_km, vat_percent, price_note_ar, prep_minutes, delivery_eta_text, serves_hint_ar,
       is_active, sort)
    values (p_tenant, v_code,
            coalesce(everwake.legacy_pick(j, array['name_ar', 'name', 'name_en']), v_code),
            everwake.legacy_pick(j, array['name_en']),
            everwake.legacy_list(j -> 'aliases'),
            everwake.legacy_pick(j, array['area_ar', 'area', 'district']),
            everwake.legacy_pick(j, array['address_ar', 'address']),
            everwake.legacy_pick(j, array['address_en']),
            everwake.legacy_num(j ->> 'lat')::double precision,
            everwake.legacy_num(j ->> 'lng')::double precision,
            everwake.legacy_pick(j, array['maps_url', 'google_maps_url', 'map_url', 'location_url']),
            everwake.legacy_pick(j, array['phone', 'hotline', 'phone_number']),
            nullif(everwake.digits(everwake.legacy_pick(j, array['ops_whatsapp', 'orders_whatsapp'])), ''),
            v_hours,
            everwake.legacy_pick(j, array['hours_text_ar', 'hours_text', 'working_hours', 'opening_hours']),
            everwake.legacy_bool(j ->> 'accepting_orders', true),
            everwake.legacy_bool(j ->> 'delivery_enabled', true),
            everwake.legacy_bool(j ->> 'pickup_enabled', true),
            everwake.legacy_num(everwake.legacy_pick(j, array['delivery_fee_egp', 'delivery_fee'])),
            everwake.legacy_num(everwake.legacy_pick(j, array['min_order_egp', 'min_order'])),
            everwake.legacy_num(j ->> 'max_delivery_km'),
            everwake.legacy_num(j ->> 'vat_percent'),
            everwake.legacy_pick(j, array['price_note_ar', 'price_note']),
            everwake.legacy_num(everwake.legacy_pick(j, array['prep_minutes', 'prep_time_minutes']))::int,
            everwake.legacy_pick(j, array['delivery_eta_text', 'eta_text', 'delivery_time']),
            everwake.legacy_pick(j, array['serves_hint_ar', 'serves_areas', 'serves']),
            everwake.legacy_bool(coalesce(j ->> 'is_active', j ->> 'active'), true),
            n * 10)
    on conflict (tenant_id, code) do update set
      name_ar = excluded.name_ar,
      name_en = coalesce(excluded.name_en, b.name_en),
      aliases = case when cardinality(excluded.aliases) > 0 then excluded.aliases else b.aliases end,
      area_ar = coalesce(excluded.area_ar, b.area_ar),
      address_ar = coalesce(excluded.address_ar, b.address_ar),
      address_en = coalesce(excluded.address_en, b.address_en),
      lat = coalesce(excluded.lat, b.lat),
      lng = coalesce(excluded.lng, b.lng),
      maps_url = coalesce(excluded.maps_url, b.maps_url),
      phone = coalesce(excluded.phone, b.phone),
      ops_whatsapp = coalesce(excluded.ops_whatsapp, b.ops_whatsapp),
      hours = case when excluded.hours = '{}'::jsonb then b.hours else excluded.hours end,
      hours_text_ar = coalesce(excluded.hours_text_ar, b.hours_text_ar),
      accepting_orders = excluded.accepting_orders,
      delivery_fee = coalesce(excluded.delivery_fee, b.delivery_fee),
      min_order = coalesce(excluded.min_order, b.min_order),
      max_delivery_km = coalesce(excluded.max_delivery_km, b.max_delivery_km),
      vat_percent = coalesce(excluded.vat_percent, b.vat_percent),
      price_note_ar = coalesce(excluded.price_note_ar, b.price_note_ar),
      prep_minutes = coalesce(excluded.prep_minutes, b.prep_minutes),
      delivery_eta_text = coalesce(excluded.delivery_eta_text, b.delivery_eta_text),
      serves_hint_ar = coalesce(excluded.serves_hint_ar, b.serves_hint_ar)
    returning b.id, b.hours into v_bid, v_hours;

    insert into _lg_branch (legacy_id, id, code, name_ar, lat, lng, max_km)
    select v_lid, b.id, b.code, b.name_ar, b.lat, b.lng, b.max_delivery_km from everwake.branches b where b.id = v_bid
    on conflict (legacy_id) do nothing;
    n_branches := n_branches + 1;
    if v_hours = '{}'::jsonb then n_no_hours := n_no_hours + 1; end if;
  end loop;

  if n_branches = 0 then
    v_warn := array_append(v_warn, 'no branches in the old schema: add them in Branches');
  end if;
  if n_no_hours > 0 then
    v_warn := array_append(v_warn, format('%s branch(es) have no opening hours in a form the platform reads: set them in Branches '
                               '(until then the agent cannot tell open from closed)', n_no_hours));
  end if;
  if exists (select 1 from _lg_branch where lat is null or lng is null) then
    v_warn := array_append(v_warn, ('no location for: ' || (select string_agg(name_ar, '، ') from _lg_branch where lat is null or lng is null)
                         || ' (add the Google Maps link in Branches, or a pin cannot reach that branch)'));
  end if;

  -- ===================================================================
  -- 2. Delivery circles (the old max_delivery_km), until zones are drawn
  -- ===================================================================
  if o_zones then
    for e in select * from _lg_branch where lat is not null and lng is not null loop
      continue when exists (select 1 from everwake.delivery_zones z where z.branch_id = e.id);
      v_km := coalesce(e.max_km, everwake.legacy_num(v_cfg ->> 'max_delivery_km'), 15);
      continue when v_km <= 0;
      insert into everwake.delivery_zones (tenant_id, branch_id, name_ar, name_en, kind, center_lat, center_lng,
                                           radius_km, priority)
      values (p_tenant, e.id, format('حتى %s كم من %s', everwake.fmt_money(v_km), e.name_ar),
              format('Within %s km', everwake.fmt_money(v_km)), 'radius', e.lat, e.lng, v_km, 500);
      n_zones := n_zones + 1;
    end loop;
  end if;

  -- ===================================================================
  -- 3. What the agent knows, how the restaurant works
  --    (fills only what the restaurant has not set itself)
  -- ===================================================================
  v_prof := jsonb_strip_nulls(jsonb_build_object(
    'agent_name', case when jsonb_typeof(v_cfg -> 'agent_name') = 'object' then v_cfg -> 'agent_name'
                       when everwake.legacy_pick(v_cfg, array['agent_name', 'agent_name_ar']) is not null
                         then jsonb_build_object('ar', everwake.legacy_pick(v_cfg, array['agent_name', 'agent_name_ar']))
                              || coalesce(jsonb_build_object('en', everwake.legacy_pick(v_cfg, array['agent_name_en'])), '{}'::jsonb)
                  end,
    'about_ar', everwake.legacy_pick(v_cfg, array['about_ar', 'brand_about_ar', 'about', 'brand_description']),
    'about_en', everwake.legacy_pick(v_cfg, array['about_en', 'brand_about_en']),
    'cuisine', everwake.legacy_pick(v_cfg, array['cuisine']),
    'tone', everwake.legacy_pick(v_cfg, array['tone', 'brand_tone']),
    'brand_facts', case when cardinality(everwake.legacy_list(coalesce(v_cfg -> 'brand_facts_ar', v_cfg -> 'brand_facts'))) > 0
                        then to_jsonb(everwake.legacy_list(coalesce(v_cfg -> 'brand_facts_ar', v_cfg -> 'brand_facts'))) end,
    'contacts', case when jsonb_typeof(v_cfg -> 'contacts') = 'object' then (
                  select jsonb_object_agg(k, v) from (
                    select distinct on (k) k, v from (
                      select case when key ~* 'hot|call|phone' then 'hotline'
                                  when key ~* 'complain|شكاو' then 'complaints'
                                  when key ~* 'whats' then 'whatsapp'
                                  when key ~* 'mail' then 'email'
                                  else key end as k,
                             value #>> '{}' as v
                        from jsonb_each(v_cfg -> 'contacts')
                       where jsonb_typeof(value) in ('string', 'number') and btrim(value #>> '{}') <> '') c
                    order by k) d) end,
    'website', everwake.legacy_pick(v_cfg, array['website', 'website_url']),
    'instagram', everwake.legacy_pick(v_cfg, array['instagram', 'instagram_url']),
    'facebook', everwake.legacy_pick(v_cfg, array['facebook', 'facebook_url']),
    'tiktok', everwake.legacy_pick(v_cfg, array['tiktok', 'tiktok_url']),
    'google_maps_url', everwake.legacy_pick(v_cfg, array['google_maps_url'])));

  v_set := jsonb_strip_nulls(jsonb_build_object(
    'payment_methods', (select case when count(*) > 0 then jsonb_agg(distinct m) end
                          from unnest(everwake.legacy_list(coalesce(v_cfg -> 'payment_methods_confirmed', v_cfg -> 'payment_methods'))) p,
                               lateral everwake.legacy_payment(p) m
                         where m is not null),
    'ops_whatsapp', nullif(everwake.digits(everwake.legacy_pick(v_cfg, array['ops_whatsapp'])), ''),
    'max_delivery_km', everwake.legacy_num(everwake.legacy_pick(v_cfg, array['max_delivery_km'])),
    'allowed_links', case when cardinality(everwake.legacy_list(v_cfg -> 'allowed_links')) > 0
                          then to_jsonb(everwake.legacy_list(v_cfg -> 'allowed_links')) end));

  -- "not set" = missing, empty, or still the platform's default
  update everwake.tenants x set
    profile = x.profile || coalesce((
      select jsonb_object_agg(k, v) from jsonb_each(v_prof) as p(k, v)
       where coalesce(x.profile -> k, 'null'::jsonb) in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)
          or x.profile -> k = everwake.default_profile() -> k
          or (k = 'contacts' and not exists (select 1 from jsonb_each_text(x.profile -> 'contacts') c where c.value <> ''))),
      '{}'::jsonb),
    settings = x.settings || coalesce((
      select jsonb_object_agg(k, v) from jsonb_each(v_set) as s(k, v)
       where coalesce(x.settings -> k, 'null'::jsonb) in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)
          or x.settings -> k = everwake.default_settings() -> k),
      '{}'::jsonb)
  where x.id = p_tenant;

  if v_prof ? 'agent_name' and not v_prof -> 'agent_name' ? 'en' then
    v_warn := array_append(v_warn, 'the agent''s English name was not in the old settings: set it in Settings → Agent');
  end if;

  -- order numbers carry on: the old prefix (SG-1043 → the next is SG-1044)
  v_prefix := upper(everwake.legacy_pick(v_cfg, array['order_no_prefix', 'order_prefix']));
  if coalesce(v_prefix, '') !~ '^[A-Z0-9]{1,6}$' then
    select upper(substring(r ->> 'order_no' from '^([A-Za-z0-9]{1,6})-[0-9]+$')) into v_prefix
      from everwake.legacy_rows(p_schema, 'orders') r
     where r ->> 'order_no' ~ '^[A-Za-z0-9]{1,6}-[0-9]+$'
     group by 1 order by count(*) desc limit 1;
  end if;
  if v_prefix ~ '^[A-Z0-9]{1,6}$' and t.order_no_prefix = 'EW' then
    update everwake.tenants set order_no_prefix = v_prefix where id = p_tenant;
  end if;

  -- ===================================================================
  -- 4. The menu
  -- ===================================================================
  if o_menu then
    if v_items = '{}'::jsonb then
      v_warn := array_append(v_warn, 'no menu in the old menu_snapshot: import the menu with the AI (Menu → Import)');
    else
      -- categories, in the order their first dish appears
      v_csort := 0;
      for v_cat_name in
        select c from (select btrim(x.value ->> 'category') as c, min(x.key) as first_code
                         from jsonb_each(v_items) x
                        where jsonb_typeof(x.value -> 'category') = 'string' and btrim(x.value ->> 'category') <> ''
                        group by 1) s
         order by first_code
      loop
        v_csort := v_csort + 10;
        v_cat := null;
        select id into v_cat from everwake.menu_categories
         where tenant_id = p_tenant and everwake.norm(name_ar) = everwake.norm(v_cat_name) limit 1;
        if v_cat is null then
          insert into everwake.menu_categories (tenant_id, name_ar, sort) values (p_tenant, v_cat_name, v_csort);
          n_cats := n_cats + 1;
        else
          update everwake.menu_categories set is_active = true where id = v_cat;
        end if;
      end loop;

      n := 0;
      for e in select x.key, x.value as it from jsonb_each(v_items) x where jsonb_typeof(x.value) = 'object' order by x.key loop
        n := n + 1;
        v_code := upper(btrim(e.key));
        v_unit := case when e.it ->> 'unit' in ('portion', 'piece', 'kg', 'person') then e.it ->> 'unit' else 'portion' end;
        v_price := everwake.legacy_num(everwake.legacy_pick(e.it, array['price_egp', 'price']));
        v_iid := null;
        if v_code ~ '^M[0-9]{3,5}$' then
          select id into v_iid from everwake.menu_items where tenant_id = p_tenant and code = v_code;
        else
          v_code := null;            -- a code the platform does not use: a new one is given, matched by name next time
          select id into v_iid from everwake.menu_items
           where tenant_id = p_tenant
             and everwake.norm(name_ar) = everwake.norm(everwake.legacy_pick(e.it, array['name', 'name_ar', 'name_en']))
           limit 1;
        end if;
        v_cat := (select id from everwake.menu_categories
                   where tenant_id = p_tenant and everwake.norm(name_ar) = everwake.norm(e.it ->> 'category') limit 1);

        if v_iid is null then
          insert into everwake.menu_items
            (tenant_id, code, category_id, name_ar, name_en, aliases, description_ar, description_en, unit, price,
             qty_step, min_qty, tags, is_signature, is_featured, orderable, is_available, is_active, sort)
          values (p_tenant, v_code, v_cat,
                  coalesce(everwake.legacy_pick(e.it, array['name', 'name_ar', 'name_en']), e.key),
                  everwake.legacy_pick(e.it, array['name_en']),
                  everwake.legacy_list(e.it -> 'aliases'),
                  everwake.legacy_pick(e.it, array['desc', 'description_ar', 'description']),
                  everwake.legacy_pick(e.it, array['desc_en', 'description_en']),
                  v_unit, v_price,
                  coalesce(everwake.legacy_num(e.it ->> 'qty_step'), case when v_unit = 'kg' then 0.25 end),
                  coalesce(everwake.legacy_num(e.it ->> 'min_qty'), case when v_unit = 'kg' then 0.5 end),
                  (select coalesce(array_agg(distinct lower(x)), '{}') from unnest(everwake.legacy_list(e.it -> 'tags')) x),
                  everwake.legacy_bool(coalesce(e.it ->> 'signature', e.it ->> 'is_signature'), false),
                  everwake.legacy_bool(coalesce(e.it ->> 'featured', e.it ->> 'is_featured'), false),
                  everwake.legacy_bool(e.it ->> 'orderable', true),
                  everwake.legacy_bool(coalesce(e.it ->> 'available', e.it ->> 'is_available'), true),
                  true, n * 10)
          returning id, code into v_iid, v_icode;
        else
          update everwake.menu_items m set
            category_id = coalesce(v_cat, m.category_id),
            name_ar = coalesce(everwake.legacy_pick(e.it, array['name', 'name_ar', 'name_en']), m.name_ar),
            name_en = coalesce(everwake.legacy_pick(e.it, array['name_en']), m.name_en),
            aliases = case when cardinality(everwake.legacy_list(e.it -> 'aliases')) > 0
                           then everwake.legacy_list(e.it -> 'aliases') else m.aliases end,
            description_ar = coalesce(everwake.legacy_pick(e.it, array['desc', 'description_ar', 'description']), m.description_ar),
            unit = v_unit, price = v_price,
            qty_step = coalesce(everwake.legacy_num(e.it ->> 'qty_step'), m.qty_step),
            min_qty = coalesce(everwake.legacy_num(e.it ->> 'min_qty'), m.min_qty),
            is_signature = everwake.legacy_bool(coalesce(e.it ->> 'signature', e.it ->> 'is_signature'), m.is_signature),
            orderable = everwake.legacy_bool(e.it ->> 'orderable', m.orderable),
            is_available = everwake.legacy_bool(coalesce(e.it ->> 'available', e.it ->> 'is_available'), m.is_available),
            is_active = true
          where m.id = v_iid
          returning m.code into v_icode;
        end if;
        n_items := n_items + 1;
        insert into _lg_item (old_code, old_key, code, id, base_price, base_available)
        values (upper(btrim(e.key)), e.key, v_icode, v_iid, v_price,
                everwake.legacy_bool(coalesce(e.it ->> 'available', e.it ->> 'is_available'), true))
        on conflict (old_code) do nothing;

        -- choice levels, replaced as a whole; the old level numbers are kept
        -- so old orders' choices still line up on "same as last time"
        grp := v_choices -> e.key -> 'levels';
        if jsonb_typeof(grp) = 'array' and jsonb_array_length(grp) > 0 then
          delete from everwake.menu_option_groups where item_id = v_iid;
          v_used := '{}';
          for j in select x from jsonb_array_elements(grp) with ordinality as a(x, k)
                    order by everwake.legacy_num(x ->> 'level') nulls last, k loop
            continue when jsonb_typeof(j -> 'options') <> 'array' or jsonb_array_length(j -> 'options') = 0;
            v_level := everwake.legacy_num(j ->> 'level')::int;
            if v_level is null or v_level not between 1 and 20 or v_level = any(v_used) then
              v_level := (select min(s) from generate_series(1, 20) s where not s = any(v_used));
            end if;
            exit when v_level is null;
            v_used := v_used || v_level;
            -- the same reading as the old engine: required only with a minimum of one or more
            insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
            values (p_tenant, v_iid, v_level,
                    coalesce(everwake.legacy_pick(j, array['label_ar', 'label', 'name_ar', 'name']), 'اختيار'),
                    everwake.legacy_pick(j, array['label_en', 'name_en']),
                    everwake.legacy_bool(j ->> 'required', false)
                      and coalesce(everwake.legacy_num(everwake.legacy_pick(j, array['min', 'min_select'])), 0) >= 1,
                    greatest(0, coalesce(everwake.legacy_num(everwake.legacy_pick(j, array['min', 'min_select'])), 0))::int,
                    everwake.legacy_num(everwake.legacy_pick(j, array['max', 'max_select']))::int)
            returning id into v_group;
            v_osort := 0;
            for opt in select case when jsonb_typeof(x) = 'string' then jsonb_build_object('name', x #>> '{}') else x end
                         from jsonb_array_elements(j -> 'options') x loop
              v_osort := v_osort + 10;
              continue when everwake.legacy_pick(opt, array['name', 'name_ar', 'name_en']) is null;
              insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, aliases, price_delta, extra_charge,
                                                 is_available, sort)
              values (p_tenant, v_group, everwake.legacy_pick(opt, array['name', 'name_ar', 'name_en']),
                      everwake.legacy_pick(opt, array['name_en']),
                      everwake.legacy_list(opt -> 'aliases'),
                      coalesce(everwake.legacy_num(everwake.legacy_pick(opt, array['price_egp', 'price', 'adds_egp', 'price_delta'])), 0),
                      everwake.legacy_bool(opt ->> 'extra_charge', false),
                      everwake.legacy_bool(coalesce(opt ->> 'available', opt ->> 'is_available'), true),
                      v_osort);
            end loop;
          end loop;
          n_choice_items := n_choice_items + 1;
        end if;

        -- a dish photo, if the old menu had one
        v_url := everwake.legacy_pick(e.it, array['photo_url', 'image_url', 'photo', 'image']);
        if v_url ~* '^https?://' and not exists (select 1 from everwake.item_media where item_id = v_iid and url = v_url) then
          insert into everwake.item_media (tenant_id, item_id, url, mime, is_primary)
          values (p_tenant, v_iid, v_url, case when v_url ~* '\.png(\?|$)' then 'image/png'
                                               when v_url ~* '\.webp(\?|$)' then 'image/webp' else 'image/jpeg' end,
                  not exists (select 1 from everwake.item_media where item_id = v_iid));
          n_photos := n_photos + 1;
        end if;
      end loop;

      -- each branch's own menu: what it does not list, its own prices, its sold-out dishes
      for e in select b.id as branch_id, v_snaps -> b.legacy_id -> 'items' as items
                 from _lg_branch b
                where jsonb_typeof(v_snaps -> b.legacy_id -> 'items') = 'object' loop
        delete from everwake.menu_item_branches mb
         where mb.branch_id = e.branch_id and mb.item_id in (select id from _lg_item);
        insert into everwake.menu_item_branches (tenant_id, item_id, branch_id, is_listed, price, is_available)
        select p_tenant, m.id, e.branch_id, x.listed, x.price, x.available
          from _lg_item m
          cross join lateral (
            select e.items ? m.old_key as listed,
                   case when e.items ? m.old_key
                        then nullif(everwake.legacy_num(everwake.legacy_pick(e.items -> m.old_key, array['price_egp', 'price'])),
                                    m.base_price) end as price,
                   -- sold out at this branch only (sold out everywhere is the dish's own switch)
                   not m.base_available
                     or everwake.legacy_bool(coalesce(e.items -> m.old_key ->> 'available', e.items -> m.old_key ->> 'is_available'), true)
                     as available) x
         where not (x.listed and x.price is null and x.available);
        get diagnostics n = row_count;
        n_overrides := n_overrides + n;
      end loop;

      update everwake.tenants set item_seq = greatest(item_seq, coalesce((
          select max(substr(code, 2)::int) from everwake.menu_items where tenant_id = p_tenant), 0))
       where id = p_tenant;
    end if;

    -- the menu pages the agent sends when asked for the menu
    for j in select r from everwake.legacy_rows(p_schema, 'menu_media') r loop
      n_page_rows := n_page_rows + 1;
      v_url := everwake.legacy_pick(j, array['url', 'public_url', 'media_url', 'file_url', 'link']);
      continue when coalesce(v_url, '') !~* '^https?://';
      continue when exists (select 1 from everwake.menu_media where tenant_id = p_tenant and url = v_url);
      v_mime := coalesce(everwake.legacy_pick(j, array['mime', 'mimetype', 'mime_type', 'content_type']),
                         case when v_url ~* '\.pdf(\?|$)' then 'application/pdf'
                              when v_url ~* '\.png(\?|$)' then 'image/png'
                              when v_url ~* '\.webp(\?|$)' then 'image/webp' else 'image/jpeg' end);
      insert into everwake.menu_media (tenant_id, branch_id, kind, url, mime, file_name, caption, position, is_active)
      values (p_tenant, (select id from _lg_branch where legacy_id = j ->> 'branch_id'),   -- unknown or none = every branch
              case when v_mime ~* 'pdf' then 'pdf' else 'image' end, v_url, v_mime,
              everwake.legacy_pick(j, array['file_name', 'filename', 'name']),
              everwake.legacy_pick(j, array['caption', 'title']),
              coalesce(everwake.legacy_num(everwake.legacy_pick(j, array['position', 'page', 'page_no', 'sort']))::int, 1),
              everwake.legacy_bool(coalesce(j ->> 'is_active', j ->> 'active'), true));
      n_pages := n_pages + 1;
    end loop;
    if n_page_rows > 0 and n_pages = 0 and not exists (select 1 from everwake.menu_media where tenant_id = p_tenant) then
      v_warn := array_append(v_warn, 'the old menu pages have no public web address: upload them in Menu → Menu pictures');
    elsif n_pages > 0 then
      v_warn := array_append(v_warn, 'menu pages still point at the old storage: re-upload them in Menu → Menu pictures before that storage goes');
    end if;
  end if;

  -- ===================================================================
  -- 5. Customers, by number or by WhatsApp private id
  -- ===================================================================
  insert into _lg_jid (value, kind)
  select distinct m[1], case when m[2] = 'lid' then 'lid' else 'phone' end
    from everwake.legacy_rows(p_schema, 'messages') r,
         regexp_matches(coalesce(r -> 'raw_payload', 'null'::jsonb)::text, '([0-9]{6,})@(lid|s\.whatsapp\.net)', 'g') m
  on conflict do nothing;
  insert into _lg_jid (value, kind)
  select everwake.digits(r ->> 'reply_to'), 'lid' from everwake.legacy_rows(p_schema, 'customers') r
   where r ->> 'reply_to' like '%@lid'
  on conflict do nothing;

  for j in select r from everwake.legacy_rows(p_schema, 'customers') r loop
    v_wa := everwake.digits(everwake.legacy_pick(j, array['whatsapp_number', 'wa_id', 'phone']));
    continue when coalesce(v_wa, '') = '' or exists (select 1 from _lg_cust where wa = v_wa);
    perform everwake.legacy_customer(p_tenant, v_wa,
                                     everwake.legacy_pick(j, array['display_name', 'push_name', 'name']),
                                     everwake.legacy_pick(j, array['full_name']),
                                     everwake.legacy_ts(everwake.legacy_pick(j, array['created_at', 'first_seen_at'])));
  end loop;

  -- ===================================================================
  -- 6. Past orders (finished), and the address book they build
  -- ===================================================================
  if o_orders then
    for j in select r from everwake.legacy_rows(p_schema, 'orders') r
              where lower(coalesce(r ->> 'status', 'placed')) <> 'draft'
              order by everwake.legacy_ts(coalesce(r ->> 'placed_at', r ->> 'created_at')) nulls first loop
      v_no := coalesce(everwake.legacy_pick(j, array['order_no', 'order_number']), 'OLD-' || coalesce(j ->> 'id', left(md5(j::text), 8)));
      v_wa := everwake.digits(everwake.legacy_pick(j, array['whatsapp_number', 'wa_id', 'phone']));
      if coalesce(v_wa, '') = '' or exists (select 1 from everwake.orders where tenant_id = p_tenant and order_no = v_no) then
        n_skipped := n_skipped + 1;
        continue;
      end if;
      v_cust := case when jsonb_typeof(j -> 'customer') = 'object' then j -> 'customer' else '{}'::jsonb end;
      v_cid := everwake.legacy_customer(p_tenant, v_wa, null, everwake.legacy_pick(v_cust, array['full_name', 'name']),
                                        everwake.legacy_ts(coalesce(j ->> 'placed_at', j ->> 'created_at')));
      v_method := lower(coalesce(everwake.legacy_pick(j, array['delivery_method']),
                                 everwake.legacy_pick(v_cust, array['delivery_method']), ''));
      v_method := case when v_method ~ '(pick|take|استلام|تيك)' then 'pickup'
                       when v_method ~ '(deliver|توصيل|دليفري)' then 'delivery'
                       else nullif(v_method, '') end;
      v_status := case when lower(j ->> 'status') in ('cancelled', 'canceled') then 'cancelled'
                       when lower(j ->> 'status') = 'rejected' then 'rejected'
                       when v_method = 'pickup' then 'picked_up'
                       else 'delivered' end;
      v_placed := coalesce(everwake.legacy_ts(j ->> 'placed_at'), everwake.legacy_ts(j ->> 'created_at'), now());
      v_cart := everwake.legacy_cart(j -> 'cart');
      v_sub := coalesce(everwake.legacy_num(everwake.legacy_pick(j, array['subtotal_egp', 'subtotal'])),
                        (select sum(coalesce((x ->> 'line_total')::numeric, 0)) from jsonb_array_elements(v_cart -> 'items') x), 0);
      v_fee := everwake.legacy_num(everwake.legacy_pick(j, array['delivery_fee_egp', 'delivery_fee']));
      v_total := coalesce(everwake.legacy_num(everwake.legacy_pick(j, array['final_total_egp', 'total_egp', 'total'])),
                          v_sub + coalesce(v_fee, 0));
      v_loc := case when jsonb_typeof(j -> 'location') = 'object' then j -> 'location' end;
      v_addr := jsonb_strip_nulls(jsonb_build_object(
        'governorate', everwake.legacy_pick(v_cust, array['address_governorate', 'governorate']),
        'city',        everwake.legacy_pick(v_cust, array['address_city', 'city']),
        'area',        everwake.legacy_pick(v_cust, array['address_area', 'area']),
        'street',      everwake.legacy_pick(v_cust, array['address_street', 'street']),
        'building',    everwake.legacy_pick(v_cust, array['address_building', 'building']),
        'floor',       everwake.legacy_pick(v_cust, array['address_floor', 'floor']),
        'apartment',   everwake.legacy_pick(v_cust, array['address_apartment', 'apartment']),
        'landmark',    everwake.legacy_pick(v_cust, array['address_landmark', 'landmark']),
        'notes',       everwake.legacy_pick(v_cust, array['address_notes'])));
      if v_addr = '{}'::jsonb then v_addr := null; end if;

      insert into everwake.orders
        (tenant_id, order_no, customer_id, wa_id, branch_id, status, source, cart, currency, subtotal, discount_total, vat,
         delivery_fee, total, delivery_method, payment_method, customer, address_text, address, location, notes,
         placed_at, completed_at, cancelled_at, created_at, updated_at)
      values (p_tenant, v_no, v_cid, (select wa_id from everwake.customers where id = v_cid),
              (select id from _lg_branch where legacy_id = j ->> 'branch_id'),
              v_status, 'legacy_import', v_cart, t.currency, v_sub,
              coalesce(everwake.legacy_num(everwake.legacy_pick(j, array['discount_egp', 'discount_total_egp', 'discount_total'])), 0),
              everwake.legacy_num(everwake.legacy_pick(j, array['vat_egp', 'vat'])),
              v_fee, v_total, v_method,
              everwake.legacy_payment(coalesce(everwake.legacy_pick(j, array['payment_method']),
                                               everwake.legacy_pick(v_cust, array['payment_method']))),
              v_cust, everwake.legacy_pick(j, array['address_text']), v_addr, v_loc,
              everwake.legacy_pick(j, array['notes']),
              v_placed,
              case when v_status in ('delivered', 'picked_up') then v_placed end,
              case when v_status in ('cancelled', 'rejected') then v_placed end,
              v_placed, v_placed)
      returning id into v_oid;

      insert into everwake.order_items (tenant_id, order_id, line_no, item_id, item_code, name, unit, quantity,
                                        unit_price, line_total, choices, notes, is_gift)
      select p_tenant, v_oid, x.n::int, nullif(x.i ->> 'item_id', '')::uuid, x.i ->> 'code',
             coalesce(x.i ->> 'display_name', x.i ->> 'item_name', '?'), x.i ->> 'unit',
             coalesce((x.i ->> 'quantity')::numeric, 1), (x.i ->> 'unit_price')::numeric, (x.i ->> 'line_total')::numeric,
             coalesce(x.i -> 'choices', '[]'::jsonb), nullif(x.i ->> 'notes', ''), coalesce((x.i ->> 'gift')::boolean, false)
        from jsonb_array_elements(v_cart -> 'items') with ordinality as x(i, n);

      insert into everwake.order_events (tenant_id, order_id, status, note, by_role, created_at)
      values (p_tenant, v_oid, 'placed', 'imported from ' || p_schema, 'system', v_placed),
             (p_tenant, v_oid, v_status, 'imported from ' || p_schema, 'system', v_placed);
      n_orders := n_orders + 1;

      -- the number they typed for the order is theirs too (a private-id customer is found by it)
      v_phone := nullif(everwake.digits(everwake.legacy_pick(v_cust, array['phone'])), '');
      if v_phone is not null and length(v_phone) between 8 and 15
         and not exists (select 1 from everwake.customer_identities
                          where tenant_id = p_tenant and kind = 'phone' and value = v_phone) then
        insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
        values (p_tenant, 'phone', v_phone, v_cid);
      end if;

      -- the address book (delivered orders), with the zone it falls in today
      if v_status = 'delivered' and v_method = 'delivery' and v_addr is not null then
        v_lat := everwake.legacy_num(v_loc ->> 'lat')::double precision;
        v_lng := everwake.legacy_num(v_loc ->> 'lng')::double precision;
        v_zone := null;
        if v_lat is not null and v_lng is not null then
          select z.zone_id into v_zone from everwake.zones_at(p_tenant, v_lat, v_lng) z limit 1;
        elsif v_addr ? 'area' then
          v_match := everwake.match_area(p_tenant, v_addr ->> 'area');
          if jsonb_array_length(coalesce(v_match -> 'matches', '[]'::jsonb)) > 0 and (v_match ->> 'branches')::int = 1 then
            v_zone := (v_match -> 'matches' -> 0 ->> 'zone_id')::uuid;
          end if;
        end if;
        insert into everwake.customer_addresses as a
          (tenant_id, customer_id, fingerprint, governorate, city, area, street, building, floor, apartment, landmark,
           notes, lat, lng, maps_url, zone_id, branch_id, address_text, last_used_at, created_at)
        values (p_tenant, v_cid,
                md5(everwake.norm(concat_ws('|', v_addr ->> 'area', v_addr ->> 'street', v_addr ->> 'building',
                                             v_addr ->> 'floor', v_addr ->> 'apartment'))),
                v_addr ->> 'governorate', v_addr ->> 'city', v_addr ->> 'area', v_addr ->> 'street', v_addr ->> 'building',
                v_addr ->> 'floor', v_addr ->> 'apartment', v_addr ->> 'landmark', v_addr ->> 'notes',
                v_lat, v_lng, v_loc ->> 'maps_url', v_zone,
                (select id from _lg_branch where legacy_id = j ->> 'branch_id'),
                everwake.legacy_pick(j, array['address_text']), v_placed, v_placed)
        on conflict (customer_id, fingerprint) do update
          set use_count = a.use_count + 1,
              last_used_at = greatest(a.last_used_at, excluded.last_used_at),
              lat = coalesce(excluded.lat, a.lat), lng = coalesce(excluded.lng, a.lng),
              maps_url = coalesce(excluded.maps_url, a.maps_url), zone_id = coalesce(excluded.zone_id, a.zone_id),
              landmark = coalesce(excluded.landmark, a.landmark),
              address_text = case when excluded.last_used_at >= a.last_used_at
                                  then coalesce(excluded.address_text, a.address_text) else a.address_text end;
        n_addresses := n_addresses + 1;
      end if;
    end loop;

    -- the next order number comes after the old ones
    update everwake.tenants x set order_seq = greatest(x.order_seq, coalesce((
        select max(substring(o.order_no from '-([0-9]+)$')::bigint) from everwake.orders o
         where o.tenant_id = p_tenant and o.order_no ~ ('^' || x.order_no_prefix || '-[0-9]{1,15}$')), 0))
     where x.id = p_tenant;
  end if;

  -- what the platform knows about each customer, from their orders here
  update everwake.customers c set
    orders_count  = s.n,
    total_spent   = s.spent,
    last_order_id = s.last_id,
    last_order_at = s.last_at,
    full_name     = coalesce(c.full_name, s.full_name)
  from (select o.customer_id,
               count(*) filter (where o.status not in ('cancelled', 'rejected')) as n,
               coalesce(sum(o.total) filter (where o.status not in ('cancelled', 'rejected')), 0) as spent,
               (array_agg(o.id order by o.placed_at desc nulls last))[1] as last_id,
               max(o.placed_at) as last_at,
               (array_agg(o.customer ->> 'full_name' order by o.placed_at desc nulls last)
                  filter (where nullif(o.customer ->> 'full_name', '') is not null))[1] as full_name
          from everwake.orders o
         where o.tenant_id = p_tenant and o.status <> 'draft' and o.customer_id in (select id from _lg_cust)
         group by o.customer_id) s
  where c.id = s.customer_id;

  -- ===================================================================
  -- 7. Recent messages, so the inbox and the agent see the history
  -- ===================================================================
  if o_days > 0 then
    for v_wa in
      select distinct everwake.digits(everwake.legacy_pick(r, array['whatsapp_number', 'wa_id']))
        from everwake.legacy_rows(p_schema, 'messages') r
       where everwake.legacy_ts(r ->> 'created_at') > now() - make_interval(days => o_days)
    loop
      perform everwake.legacy_customer(p_tenant, v_wa, null, null, null);
    end loop;

    insert into everwake.conversations (tenant_id, customer_id, wa_id)
    select p_tenant, c.id, c.wa_id from everwake.customers c where c.id in (select id from _lg_cust)
    on conflict (tenant_id, wa_id) do nothing;

    insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, kind, body, media_url,
                                   external_id, status, meta, created_at, sent_at)
    select p_tenant, cv.id, cv.wa_id, m.direction,
           case when m.direction = 'inbound' then 'customer'
                when m.sender in ('agent', 'staff', 'system') then m.sender else 'agent' end,
           coalesce(m.kind, 'text'), m.body, m.media_url, m.ext,
           case when m.direction = 'inbound' then 'received' else 'sent' end,
           jsonb_build_object('imported_from', p_schema), m.at,
           case when m.direction = 'outbound' then m.at end
      from (select lower(r ->> 'direction') as direction,
                   everwake.digits(everwake.legacy_pick(r, array['whatsapp_number', 'wa_id'])) as wa,
                   everwake.legacy_pick(r, array['message_text', 'body', 'text', 'content']) as body,
                   everwake.legacy_pick(r, array['media_url']) as media_url,
                   lower(everwake.legacy_pick(r, array['kind', 'message_type'])) as kind,
                   lower(everwake.legacy_pick(r, array['sender', 'role'])) as sender,
                   everwake.legacy_pick(r, array['evolution_message_id', 'external_id', 'message_id']) as ext,
                   everwake.legacy_ts(r ->> 'created_at') as at
              from everwake.legacy_rows(p_schema, 'messages') r) m
      join _lg_cust lc on lc.wa = m.wa
      join everwake.customers c on c.id = lc.id
      join everwake.conversations cv on cv.tenant_id = p_tenant and cv.wa_id = c.wa_id
     where m.direction in ('inbound', 'outbound')
       and m.at > now() - make_interval(days => o_days)
       and (m.body is not null or m.media_url is not null)
       and (m.ext is not null
            or not exists (select 1 from everwake.messages x
                            where x.tenant_id = p_tenant and x.wa_id = cv.wa_id and x.created_at = m.at
                              and x.direction = m.direction))
    on conflict do nothing;
    get diagnostics n_messages = row_count;

    update everwake.conversations cv set
      last_message_at      = s.last_at,
      last_inbound_at      = coalesce(s.last_in, cv.last_inbound_at),
      last_outbound_at     = coalesce(s.last_out, cv.last_outbound_at),
      last_message_preview = left(s.preview, 140)
    from (select conversation_id, max(created_at) as last_at,
                 max(created_at) filter (where direction = 'inbound') as last_in,
                 max(created_at) filter (where direction = 'outbound') as last_out,
                 (array_agg(body order by created_at desc) filter (where body is not null))[1] as preview
            from everwake.messages
           where tenant_id = p_tenant
             and conversation_id in (select x.id from everwake.conversations x
                                      join everwake.customers c on c.wa_id = x.wa_id and c.tenant_id = x.tenant_id
                                     where x.tenant_id = p_tenant and c.id in (select id from _lg_cust))
           group by conversation_id) s
    where cv.id = s.conversation_id and (cv.last_message_at is null or cv.last_message_at <= s.last_at);
  end if;

  select count(*) into n_customers from _lg_cust;

  -- the agent reads the new menu on its very next message
  perform everwake.rebuild_snapshot(p_tenant, true);

  v_report := jsonb_build_object(
    'schema', p_schema, 'run', case when v_rerun then 'refresh' else 'first' end,
    'branches', n_branches, 'delivery_circles_created', n_zones,
    'categories_created', n_cats, 'dishes', n_items, 'dishes_with_choices', n_choice_items,
    'branch_menu_differences', n_overrides, 'dish_photos', n_photos, 'menu_pages', n_pages,
    'customers', n_customers, 'orders_imported', n_orders, 'orders_skipped', n_skipped,
    'addresses', n_addresses, 'messages', n_messages,
    'order_no_next', (select order_no_prefix || '-' || (order_seq + 1) from everwake.tenants where id = p_tenant),
    'check_next', to_jsonb(v_warn || array[
      'delivery circles are the old distance limits: draw real zones in Delivery zones when you can',
      'review the menu, the agent''s name and the payment methods, then place test orders before going live']));
  insert into everwake.audit_log (tenant_id, action, entity, detail) values (p_tenant, 'legacy_import', p_schema, v_report);
  return v_report;
end $$;

-- the database owner runs this; nobody else can
revoke execute on function everwake.import_legacy_schema(uuid, text, jsonb), everwake.legacy_rows(text, text),
                           everwake.legacy_customer(uuid, text, text, text, timestamptz), everwake.legacy_cart(jsonb),
                           everwake.legacy_is_lid(text)
  from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function everwake.import_legacy_schema(uuid, text, jsonb), everwake.legacy_rows(text, text)
      from anon, authenticated;
  end if;
end $$;
