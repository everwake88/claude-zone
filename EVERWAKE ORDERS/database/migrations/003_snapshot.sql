-- =====================================================================
-- Everwake Orders · 003 · the menu snapshot
--
-- The agent never reads the menu tables directly. Every turn it reads
-- one prepared snapshot per restaurant ('all') and one per branch:
--   digest_text — the MENU the model reads (codes, prices, choices)
--   lookup      — the same facts as JSON for the code that prices carts
--
-- Any dashboard edit bumps tenants.menu_rev (002). ensure_snapshot()
-- rebuilds when the stored snapshot is older than that revision, or
-- when an "out of stock until …" time has passed. So: save in the
-- dashboard → the very next customer message sees it.
-- =====================================================================

create or replace function everwake.snapshot_is_fresh(p_tenant uuid)
returns boolean language sql stable as $$
  select exists (
    select 1
      from everwake.menu_snapshot s
      join everwake.tenants t on t.id = s.tenant_id
     where s.tenant_id = p_tenant and s.scope = 'all'
       and s.source_rev >= t.menu_rev
       and (s.valid_until is null or s.valid_until > now()))
$$;

-- one dish's choices as the engine reads them
create or replace function everwake.item_choices_json(p_item uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'level', g.level, 'label_ar', g.label_ar, 'label_en', g.label_en,
           'required', g.required, 'min', g.min_select, 'max', g.max_select,
           'options', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'name', o.name_ar, 'name_en', o.name_en, 'aliases', to_jsonb(o.aliases),
                      'price', o.price_delta, 'extra_charge', o.extra_charge)
                    order by o.sort, o.name_ar)
               from everwake.menu_options o
              where o.group_id = g.id and o.is_available), '[]'::jsonb))
         order by g.level), '[]'::jsonb)
    from everwake.menu_option_groups g
   where g.item_id = p_item
$$;

-- one dish's choices as the model reads them (one line)
create or replace function everwake.item_choices_text(p_item uuid, p_sym text)
returns text language sql stable as $$
  select string_agg(
           g.label_ar
           || ' (' || case when g.required then 'مطلوب' else 'اختياري' end
           || case when coalesce(g.max_select, 99) > 1 and g.max_select is not null then '، لحد ' || g.max_select
                   when g.max_select is null and not g.required then '، أكتر من اختيار'
                   else '' end
           || '): '
           || coalesce((
                select string_agg(o.name_ar
                                  || case when o.price_delta > 0 then ' +' || everwake.fmt_money(o.price_delta) || p_sym
                                          when o.price_delta < 0 then ' ' || everwake.fmt_money(o.price_delta) || p_sym
                                          else '' end
                                  || case when o.extra_charge then ' (+رسوم تسوية يحددها الفرع)' else '' end,
                                  ' / ' order by o.sort, o.name_ar)
                  from everwake.menu_options o
                 where o.group_id = g.id and o.is_available), '—'),
           ' · ' order by g.level)
    from everwake.menu_option_groups g
   where g.item_id = p_item
$$;

create or replace function everwake.rebuild_snapshot(p_tenant uuid, p_force boolean default true)
returns void language plpgsql as $$
declare
  t           everwake.tenants%rowtype;
  v_rev       bigint;
  v_sym       text;
  v_branches  jsonb;
  v_zones     jsonb;
  v_all_items jsonb;
  v_offers    jsonb;
  v_knowledge jsonb;
  v_media     jsonb;
  v_all       jsonb;
  v_digest    text;
  v_valid     timestamptz;
  v_bvalid    timestamptz;
  b           record;
  v_items     jsonb;
  v_choices   jsonb;
  v_bdigest   text;
  v_blookup   jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('everwake.snapshot:' || p_tenant::text, 0));
  if not p_force and everwake.snapshot_is_fresh(p_tenant) then
    return;
  end if;
  select * into t from everwake.tenants where id = p_tenant;
  if not found then return; end if;
  v_rev := t.menu_rev;
  v_sym := case when t.default_language = 'en' and t.currency_symbol_ar = 'ج' then ' ' || t.currency
                else t.currency_symbol_ar end;

  -- the effective menu of every active branch -------------------------
  create temp table if not exists _ew_eff (
    branch_id uuid, branch_code text, item_id uuid, code text, cat_id uuid, cat_name text, cat_sort int,
    cat_from time, cat_to time, name_ar text, name_en text, aliases text[], description_ar text,
    unit text, price numeric, qty_step numeric, min_qty numeric, tags text[], is_signature boolean,
    is_featured boolean, orderable boolean, available boolean, sold_out_until timestamptz,
    item_sort int, has_photo boolean
  ) on commit drop;
  truncate _ew_eff;

  insert into _ew_eff
  select br.id, br.code, i.id, i.code, c.id, coalesce(c.name_ar, 'أصناف أخرى'), coalesce(c.sort, 9999),
         c.available_from, c.available_to, i.name_ar, i.name_en, i.aliases, i.description_ar,
         i.unit, coalesce(mib.price, i.price), i.qty_step, i.min_qty, i.tags, i.is_signature,
         i.is_featured, i.orderable,
         i.is_available and coalesce(mib.is_available, true),
         greatest(case when i.sold_out_until > now() then i.sold_out_until end,
                  case when mib.sold_out_until > now() then mib.sold_out_until end),
         i.sort,
         exists (select 1 from everwake.item_media m where m.item_id = i.id)
    from everwake.branches br
    join everwake.menu_items i on i.tenant_id = br.tenant_id and i.is_active
    left join everwake.menu_categories c on c.id = i.category_id
    left join everwake.menu_item_branches mib on mib.item_id = i.id and mib.branch_id = br.id
   where br.tenant_id = p_tenant and br.is_active
     and coalesce(c.is_active, true)
     and coalesce(mib.is_listed, true);

  select min(sold_out_until) into v_valid from _ew_eff where sold_out_until is not null;

  -- branches -------------------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', br.id, 'code', br.code, 'name_ar', br.name_ar, 'name_en', br.name_en, 'aliases', to_jsonb(br.aliases),
           'area_ar', br.area_ar, 'address_ar', br.address_ar, 'address_en', br.address_en,
           'lat', br.lat, 'lng', br.lng, 'maps_url', br.maps_url, 'phone', br.phone,
           'hours', br.hours, 'hours_text_ar', br.hours_text_ar,
           'accepting_orders', br.accepting_orders, 'busy_until', br.busy_until, 'busy_reason', br.busy_reason,
           'delivery_enabled', br.delivery_enabled, 'pickup_enabled', br.pickup_enabled,
           'delivery_fee', br.delivery_fee, 'min_order', br.min_order, 'max_delivery_km', br.max_delivery_km,
           'vat_percent', br.vat_percent, 'price_note_ar', br.price_note_ar,
           'prep_minutes', br.prep_minutes, 'delivery_eta_text', br.delivery_eta_text,
           'serves_hint_ar', br.serves_hint_ar, 'seasonal', br.seasonal,
           'zones', (select count(*) from everwake.delivery_zones z where z.branch_id = br.id and z.is_active))
         order by br.sort, br.name_ar), '[]'::jsonb)
    into v_branches
    from everwake.branches br
   where br.tenant_id = p_tenant and br.is_active;

  -- delivery zones (names and money only; the shapes stay in SQL) -----------
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', z.id, 'branch_id', z.branch_id, 'branch_code', br.code, 'name_ar', z.name_ar, 'name_en', z.name_en,
           'kind', z.kind, 'areas', to_jsonb(z.areas), 'delivery_fee', z.delivery_fee, 'min_order', z.min_order,
           'eta_min', z.eta_min, 'eta_max', z.eta_max, 'priority', z.priority)
         order by br.sort, z.priority, z.name_ar), '[]'::jsonb)
    into v_zones
    from everwake.delivery_zones z
    join everwake.branches br on br.id = z.branch_id and br.is_active
   where z.tenant_id = p_tenant and z.is_active;

  -- every dish across the restaurant: where it is sold and for how much ----
  select coalesce(jsonb_object_agg(x.code, x.entry), '{}'::jsonb)
    into v_all_items
    from (
      select e.code, jsonb_build_object(
               'id', min(e.item_id::text), 'name', min(e.name_ar), 'name_en', min(e.name_en),
               'aliases', to_jsonb(min(e.aliases)),
               'category', min(e.cat_name), 'unit', min(e.unit),
               'branches', jsonb_agg(distinct e.branch_code),
               'dine_in_only', bool_and(not e.orderable),
               'price_min', min(e.price), 'price_max', max(e.price),
               'signature', bool_or(e.is_signature or e.is_featured),
               'has_photo', bool_or(e.has_photo),
               'tags', to_jsonb(min(e.tags))) as entry
        from _ew_eff e
       group by e.code) x;

  -- offers that could apply now or later (time rules are checked per turn) --
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'title_ar', o.title_ar, 'title_en', o.title_en,
           'description_ar', o.description_ar, 'description_en', o.description_en,
           'kind', o.kind, 'scope', o.scope, 'value', o.value, 'max_discount', o.max_discount,
           'min_subtotal', o.min_subtotal,
           'item_codes', coalesce((select jsonb_agg(i.code) from everwake.menu_items i where i.id = any(o.item_ids)), '[]'::jsonb),
           'category_ids', to_jsonb(o.category_ids),
           'category_names', coalesce((select jsonb_agg(c.name_ar) from everwake.menu_categories c where c.id = any(o.category_ids)), '[]'::jsonb),
           'branch_ids', to_jsonb(o.branch_ids),
           'free_item_code', (select i.code from everwake.menu_items i where i.id = o.free_item_id),
           'free_item_name', (select i.name_ar from everwake.menu_items i where i.id = o.free_item_id),
           'free_item_qty', o.free_item_qty,
           'promo_code', o.promo_code, 'first_order_only', o.first_order_only,
           'stackable', o.stackable, 'priority', o.priority,
           'starts_at', o.starts_at, 'ends_at', o.ends_at, 'days_of_week', to_jsonb(o.days_of_week),
           'time_from', o.time_from, 'time_to', o.time_to)
         order by o.priority, o.created_at), '[]'::jsonb)
    into v_offers
    from everwake.offers o
   where o.tenant_id = p_tenant and o.is_active and (o.ends_at is null or o.ends_at > now());

  select coalesce(jsonb_agg(jsonb_build_object('topic', k.topic, 'content_ar', k.content_ar, 'content_en', k.content_en)
                            order by k.sort, k.topic), '[]'::jsonb)
    into v_knowledge
    from everwake.knowledge_entries k
   where k.tenant_id = p_tenant and k.is_active;

  select jsonb_build_object(
           'menu_pages', coalesce((select jsonb_object_agg(scope, n) from (
                             select coalesce(m.branch_id::text, 'all') as scope, count(*) as n
                               from everwake.menu_media m
                              where m.tenant_id = p_tenant and m.is_active
                              group by 1) s), '{}'::jsonb),
           'items_with_photos', coalesce((select jsonb_agg(distinct i.code)
                                           from everwake.menu_items i
                                           join everwake.item_media m on m.item_id = i.id
                                          where i.tenant_id = p_tenant and i.is_active), '[]'::jsonb))
    into v_media;

  v_all := jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'name_ar', t.name_ar, 'name_en', t.name_en,
                                 'status', t.status, 'timezone', t.timezone, 'currency', t.currency,
                                 'currency_symbol', v_sym, 'default_language', t.default_language,
                                 'order_no_prefix', t.order_no_prefix),
    'profile', everwake.merged_profile(t.profile),
    'settings', everwake.merged_settings(t.settings),
    'branches', v_branches,
    'zones', v_zones,
    'items', v_all_items,
    'offers', v_offers,
    'knowledge', v_knowledge,
    'media', v_media);

  -- the all-branches MENU: what exists and where, before a branch is known
  select coalesce(string_agg(cat_block, E'\n\n' order by cat_sort, cat_name), '(المنيو لسه فاضي)')
    into v_digest
    from (
      select e.cat_name, min(e.cat_sort) as cat_sort,
             '### ' || e.cat_name
             || case when min(e.cat_from) is not null and min(e.cat_to) is not null
                     then ' (متاح ' || to_char(min(e.cat_from), 'HH24:MI') || '–' || to_char(min(e.cat_to), 'HH24:MI') || ' بس)'
                     else '' end
             || E'\n'
             || string_agg(line, E'\n' order by item_sort, name_ar) as cat_block
        from (
          select e.cat_name, e.cat_sort, e.cat_from, e.cat_to, e.code, min(e.item_sort) as item_sort, min(e.name_ar) as name_ar,
                 '- ' || e.code || ' ' || min(e.name_ar)
                 || coalesce(' (' || nullif(min(e.name_en), '') || ')', '')
                 || ' — '
                 || case when min(e.price) is null then 'السعر يتأكد من الفرع'
                         when min(e.price) = max(e.price) then everwake.fmt_money(min(e.price)) || v_sym
                         else everwake.fmt_money(min(e.price)) || '–' || everwake.fmt_money(max(e.price)) || v_sym || ' حسب الفرع' end
                 || case when min(e.unit) = 'kg' then ' للكيلو' when min(e.unit) = 'person' then ' للفرد' else '' end
                 || case when bool_or(e.is_signature or e.is_featured) then ' ★' else '' end
                 || case when bool_and(not e.orderable) then ' · في المطعم بس (مش دليفري ولا تيك أواي)' else '' end
                 || case when (select count(*) from jsonb_array_elements(v_branches)) > count(distinct e.branch_id)
                         then ' · متاح في: ' || string_agg(distinct br.name_ar, '، ')
                         else '' end as line
            from _ew_eff e
            join everwake.branches br on br.id = e.branch_id
           group by e.cat_name, e.cat_sort, e.cat_from, e.cat_to, e.code) e
       group by e.cat_name) blocks;

  insert into everwake.menu_snapshot (tenant_id, scope, digest_text, lookup, version_hash, source_rev, built_at, valid_until)
  values (p_tenant, 'all', v_digest, v_all, md5(v_digest || v_all::text), v_rev, now(), v_valid)
  on conflict (tenant_id, scope) do update
    set digest_text = excluded.digest_text, lookup = excluded.lookup, version_hash = excluded.version_hash,
        source_rev = excluded.source_rev, built_at = excluded.built_at, valid_until = excluded.valid_until;

  -- one snapshot per branch ------------------------------------------------
  for b in select br.id, br.code, br.name_ar from everwake.branches br
            where br.tenant_id = p_tenant and br.is_active loop

    select coalesce(jsonb_object_agg(e.code, jsonb_build_object(
             'id', e.item_id, 'name', e.name_ar, 'name_en', e.name_en, 'aliases', to_jsonb(e.aliases),
             'category', e.cat_name, 'category_id', e.cat_id, 'desc', e.description_ar,
             'price', e.price, 'unit', e.unit, 'qty_step', e.qty_step, 'min_qty', e.min_qty,
             'tags', to_jsonb(e.tags), 'signature', e.is_signature, 'featured', e.is_featured,
             'orderable', e.orderable, 'available', e.available, 'sold_out_until', e.sold_out_until,
             'has_photo', e.has_photo,
             'window', case when e.cat_from is not null and e.cat_to is not null
                            then jsonb_build_object('from', to_char(e.cat_from, 'HH24:MI'), 'to', to_char(e.cat_to, 'HH24:MI'))
                       end)), '{}'::jsonb),
           coalesce(jsonb_object_agg(e.code, jsonb_build_object('levels', everwake.item_choices_json(e.item_id)))
                      filter (where exists (select 1 from everwake.menu_option_groups g where g.item_id = e.item_id)),
                    '{}'::jsonb)
      into v_items, v_choices
      from _ew_eff e
     where e.branch_id = b.id;

    select coalesce(string_agg(cat_block, E'\n\n' order by cat_sort, cat_name), '(المنيو لسه فاضي)')
      into v_bdigest
      from (
        select e.cat_name, min(e.cat_sort) as cat_sort,
               '### ' || e.cat_name
               || case when min(e.cat_from) is not null and min(e.cat_to) is not null
                       then ' (متاح ' || to_char(min(e.cat_from), 'HH24:MI') || '–' || to_char(min(e.cat_to), 'HH24:MI') || ' بس)'
                       else '' end
               || E'\n'
               || string_agg(
                    '- ' || e.code || ' ' || e.name_ar
                    || coalesce(' (' || nullif(e.name_en, '') || ')', '')
                    || ' — '
                    || case when e.price is null then 'السعر يتأكد من الفرع' else everwake.fmt_money(e.price) || v_sym end
                    || case when e.unit = 'kg' then ' للكيلو' when e.unit = 'person' then ' للفرد'
                            when e.unit = 'piece' then ' للقطعة' else '' end
                    || case when e.is_signature or e.is_featured then ' ★' else '' end
                    || case when not e.orderable then ' · في المطعم بس (مش دليفري ولا تيك أواي)' else '' end
                    || case when not e.available then ' · خلصان دلوقتي'
                            when e.sold_out_until is not null then ' · خلصان لحد ' || to_char(e.sold_out_until at time zone t.timezone, 'HH24:MI')
                            else '' end
                    || case when e.has_photo then ' 📷' else '' end
                    || coalesce(E'\n  ' || left(nullif(btrim(e.description_ar), ''), 140), '')
                    || coalesce(E'\n  اختيارات: ' || everwake.item_choices_text(e.item_id, v_sym), ''),
                    E'\n' order by e.item_sort, e.name_ar) as cat_block
          from _ew_eff e
         where e.branch_id = b.id
         group by e.cat_name) blocks;

    v_blookup := jsonb_build_object(
      'branch', jsonb_build_object('id', b.id, 'code', b.code, 'name_ar', b.name_ar),
      'items', v_items,
      'choices', v_choices);

    select min(sold_out_until) into v_bvalid from _ew_eff where branch_id = b.id and sold_out_until is not null;

    insert into everwake.menu_snapshot (tenant_id, scope, digest_text, lookup, version_hash, source_rev, built_at, valid_until)
    values (p_tenant, b.id::text, v_bdigest, v_blookup, md5(v_bdigest || v_blookup::text), v_rev, now(), v_bvalid)
    on conflict (tenant_id, scope) do update
      set digest_text = excluded.digest_text, lookup = excluded.lookup, version_hash = excluded.version_hash,
          source_rev = excluded.source_rev, built_at = excluded.built_at, valid_until = excluded.valid_until;
  end loop;

  -- branches that were closed or removed
  delete from everwake.menu_snapshot s
   where s.tenant_id = p_tenant and s.scope <> 'all'
     and not exists (select 1 from everwake.branches br
                      where br.tenant_id = p_tenant and br.is_active and br.id::text = s.scope);
  drop table if exists _ew_eff;
end $$;

-- called at the start of every turn: rebuild only when something changed
create or replace function everwake.ensure_snapshot(p_tenant uuid)
returns void language plpgsql as $$
begin
  if not everwake.snapshot_is_fresh(p_tenant) then
    perform everwake.rebuild_snapshot(p_tenant, false);
  end if;
end $$;
