-- =====================================================================
-- Everwake Orders · 006 · dashboard
--
-- Signing a restaurant up, its go-live checklist, publishing a menu the
-- AI read from a PDF / photo / link, the reports, the WhatsApp number
-- and the team. Every function checks the caller's role first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A restaurant's own schema: r_<slug>, with a read-only view per table
-- holding only its rows. Open it in any database client and it looks
-- like the old one-schema-per-brand setup (r_bazooka.orders, …) — while
-- the engine keeps one set of tables and one migration path.
-- ---------------------------------------------------------------------
create or replace function everwake.provision_tenant_views(p_tenant uuid)
returns text language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_slug   text;
  v_schema text;
  v        text;
  tables   text[] := array['branches', 'delivery_zones', 'menu_categories', 'menu_items', 'menu_option_groups',
                           'menu_options', 'menu_item_branches', 'item_media', 'menu_media', 'menu_imports', 'offers',
                           'knowledge_entries', 'customers', 'customer_identities', 'customer_addresses', 'conversations',
                           'messages', 'outbox', 'inbound_buffer', 'conversation_locks', 'orders', 'order_items',
                           'order_events', 'agent_pauses', 'pause_contacts', 'agent_events', 'menu_snapshot', 'audit_log'];
begin
  select slug into v_slug from everwake.tenants where id = p_tenant;
  if v_slug is null then raise exception 'restaurant not found'; end if;
  v_schema := 'r_' || v_slug;
  execute format('create schema if not exists %I', v_schema);
  execute format('revoke all on schema %I from public', v_schema);
  foreach v in array tables loop
    execute format('create or replace view %I.%I with (security_barrier = true) as select * from everwake.%I where tenant_id = %L',
                   v_schema, v, v, p_tenant);
  end loop;
  -- the familiar names
  execute format('create or replace view %I.conversation_state with (security_barrier = true) as
                    select wa_id as whatsapp_number, state, mode, updated_at from everwake.conversations where tenant_id = %L',
                 v_schema, p_tenant);
  execute format('create or replace view %I.settings with (security_barrier = true) as
                    select s.key, s.value from everwake.tenants t, jsonb_each(everwake.merged_settings(t.settings)) s where t.id = %L',
                 v_schema, p_tenant);
  execute format('create or replace view %I.whatsapp_channels with (security_barrier = true) as
                    select id, provider, label, phone_number, instance_name, base_url, default_branch_id, status, is_active,
                           last_inbound_at, connected_at, created_at from everwake.whatsapp_channels where tenant_id = %L',
                 v_schema, p_tenant);
  return v_schema;
end $$;

-- after a migration adds columns, the views are re-created to show them
create or replace function everwake.refresh_tenant_views()
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select id, slug from everwake.tenants loop
    execute format('drop schema if exists %I cascade', 'r_' || r.slug);
    perform everwake.provision_tenant_views(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function everwake.slugify(p text)
returns text language sql immutable as $$
  select left(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '_', 'g'),
                                            '^_+|_+$', '', 'g'), '^([0-9])', 'r\1'), 40)
$$;

create or replace function everwake.currency_symbol(p_currency text)
returns text language sql immutable as $$
  select case upper(p_currency)
    when 'EGP' then 'ج' when 'SAR' then 'ر.س' when 'AED' then 'د.إ' when 'QAR' then 'ر.ق'
    when 'KWD' then 'د.ك' when 'BHD' then 'د.ب' when 'OMR' then 'ر.ع' when 'JOD' then 'د.أ'
    when 'USD' then '$' when 'EUR' then '€' else upper(p_currency) end
$$;

-- ---------------------------------------------------------------------
-- Sign a restaurant up. The caller becomes its owner.
-- ---------------------------------------------------------------------
create or replace function everwake.create_tenant(p_name_ar text, p_name_en text, p_slug text default null,
                                                  p_country text default 'EG', p_timezone text default 'Africa/Cairo',
                                                  p_currency text default 'EGP', p_language text default 'ar')
returns uuid language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_uid   uuid := everwake.current_user_id();
  v_slug  text;
  v_base  text;
  v_i     int := 1;
  v_id    uuid;
  v_email text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
begin
  if coalesce(btrim(p_name_ar), '') = '' and coalesce(btrim(p_name_en), '') = '' then
    raise exception 'the restaurant needs a name';
  end if;
  v_base := coalesce(nullif(everwake.slugify(p_slug), ''), nullif(everwake.slugify(p_name_en), ''),
                     'restaurant_' || substr(md5(random()::text), 1, 6));
  if length(v_base) < 2 or v_base !~ '^[a-z]' then v_base := 'r_' || v_base; end if;
  v_slug := v_base;
  while exists (select 1 from everwake.tenants where slug = v_slug) loop
    v_i := v_i + 1;
    v_slug := left(v_base, 36) || '_' || v_i;
  end loop;

  insert into everwake.tenants (slug, name_ar, name_en, country, timezone, currency, currency_symbol_ar,
                                default_language, order_no_prefix, profile)
  values (v_slug, coalesce(nullif(btrim(p_name_ar), ''), btrim(p_name_en)), coalesce(nullif(btrim(p_name_en), ''), btrim(p_name_ar)),
          upper(coalesce(p_country, 'EG')), coalesce(p_timezone, 'Africa/Cairo'), upper(coalesce(p_currency, 'EGP')),
          everwake.currency_symbol(coalesce(p_currency, 'EGP')), case when p_language = 'en' then 'en' else 'ar' end,
          coalesce(nullif(upper(left(regexp_replace(v_slug, '[^a-z]', '', 'g'), 3)), ''), 'EW'),
          jsonb_build_object('brand_facts', jsonb_build_array()))
  returning id into v_id;

  if v_uid is not null then
    insert into everwake.tenant_members (tenant_id, user_id, role, email, display_name)
    values (v_id, v_uid, 'owner', v_email, split_part(coalesce(v_email, ''), '@', 1));
  end if;
  perform everwake.provision_tenant_views(v_id);
  perform everwake.rebuild_snapshot(v_id);
  return v_id;
end $$;

create or replace function everwake.my_tenants()
returns jsonb language sql stable security definer set search_path = everwake, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'slug', t.slug, 'name_ar', t.name_ar, 'name_en', t.name_en, 'status', t.status,
           'agent_enabled', t.agent_enabled, 'currency', t.currency, 'currency_symbol', t.currency_symbol_ar,
           'timezone', t.timezone, 'default_language', t.default_language,
           'role', everwake.member_role(t.id)) order by t.name_en), '[]'::jsonb)
    from everwake.tenants t
   where everwake.member_role(t.id) is not null
$$;

-- ---------------------------------------------------------------------
-- What still stands between the restaurant and going live
-- ---------------------------------------------------------------------
create or replace function everwake.onboarding_checklist(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  t   everwake.tenants%rowtype;
  s   jsonb;
  pr  jsonb;
  n_br int; n_br_ok int; n_br_deliv int; n_br_zoned int; n_items int; n_priced int; n_photos int;
  n_pages int; n_ch int; n_ch_ok int; n_test int; n_cat int; n_know int;
  items jsonb := '[]'::jsonb;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager', 'staff']);
  select * into t from everwake.tenants where id = p_tenant;
  s := everwake.merged_settings(t.settings);
  pr := everwake.merged_profile(t.profile);

  select count(*), count(*) filter (where coalesce(address_ar, '') <> '' and hours <> '{}'::jsonb),
         count(*) filter (where delivery_enabled),
         count(*) filter (where delivery_enabled and (exists (select 1 from everwake.delivery_zones z where z.branch_id = b.id and z.is_active)
                                                     or (lat is not null and lng is not null)))
    into n_br, n_br_ok, n_br_deliv, n_br_zoned
    from everwake.branches b where b.tenant_id = p_tenant and b.is_active;
  select count(*), count(*) filter (where price is not null) into n_items, n_priced
    from everwake.menu_items where tenant_id = p_tenant and is_active;
  select count(*) into n_cat from everwake.menu_categories where tenant_id = p_tenant and is_active;
  select count(distinct i.id) into n_photos from everwake.menu_items i join everwake.item_media m on m.item_id = i.id
   where i.tenant_id = p_tenant and i.is_active;
  select count(*) into n_pages from everwake.menu_media where tenant_id = p_tenant and is_active;
  select count(*), count(*) filter (where status = 'connected') into n_ch, n_ch_ok
    from everwake.whatsapp_channels where tenant_id = p_tenant and is_active;
  select count(*) into n_test from everwake.orders where tenant_id = p_tenant and status <> 'draft';
  select count(*) into n_know from everwake.knowledge_entries where tenant_id = p_tenant and is_active;

  items := jsonb_build_array(
    jsonb_build_object('key', 'profile', 'label', 'Restaurant profile and the agent''s name', 'required', true,
                       'done', coalesce(pr ->> 'about_ar', '') <> '' or coalesce(pr ->> 'about_en', '') <> '',
                       'detail', 'Tell the agent what the restaurant is, its tone and its key facts.', 'href', 'settings/agent'),
    jsonb_build_object('key', 'branches', 'label', 'Branches with address and opening hours', 'required', true,
                       'done', n_br > 0 and n_br_ok = n_br,
                       'detail', n_br_ok || ' of ' || n_br || ' branches complete', 'href', 'branches'),
    jsonb_build_object('key', 'zones', 'label', 'Delivery zones', 'required', n_br_deliv > 0,
                       'done', n_br > 0 and (n_br_deliv = 0 or n_br_zoned = n_br_deliv),
                       'detail', n_br_zoned || ' of ' || n_br_deliv || ' delivering branches have a zone or a map pin', 'href', 'zones'),
    jsonb_build_object('key', 'menu', 'label', 'Menu with prices', 'required', true,
                       'done', n_cat > 0 and n_priced >= 3,
                       'detail', n_priced || ' of ' || n_items || ' dishes have a price', 'href', 'menu'),
    jsonb_build_object('key', 'photos', 'label', 'Dish photos', 'required', false,
                       'done', n_items > 0 and n_photos * 2 >= n_items,
                       'detail', n_photos || ' of ' || n_items || ' dishes have a photo', 'href', 'menu'),
    jsonb_build_object('key', 'menu_pages', 'label', 'Full menu pictures or PDF', 'required', false,
                       'done', n_pages > 0, 'detail', n_pages || ' pages', 'href', 'menu/pages'),
    jsonb_build_object('key', 'payment', 'label', 'Payment methods', 'required', true,
                       'done', jsonb_array_length(coalesce(s -> 'payment_methods', '[]'::jsonb)) > 0,
                       'detail', coalesce((select string_agg(x, ', ') from jsonb_array_elements_text(s -> 'payment_methods') x), ''),
                       'href', 'settings/ordering'),
    jsonb_build_object('key', 'knowledge', 'label', 'Answers to common questions', 'required', false,
                       'done', n_know > 0, 'detail', n_know || ' answers', 'href', 'settings/knowledge'),
    jsonb_build_object('key', 'whatsapp', 'label', 'WhatsApp number connected', 'required', true,
                       'done', n_ch_ok > 0, 'detail', n_ch_ok || ' of ' || n_ch || ' numbers connected', 'href', 'settings/whatsapp'),
    jsonb_build_object('key', 'test_order', 'label', 'A test order placed from a test number', 'required', false,
                       'done', n_test > 0, 'detail', n_test || ' orders so far', 'href', 'settings/ordering'));

  return jsonb_build_object(
    'status', t.status, 'live_at', t.live_at, 'items', items,
    'ready', not exists (select 1 from jsonb_array_elements(items) i
                          where (i ->> 'required')::boolean and not (i ->> 'done')::boolean));
end $$;

create or replace function everwake.go_live(p_tenant uuid, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare c jsonb;
begin
  perform everwake.require_role(p_tenant, array['owner']);
  c := everwake.onboarding_checklist(p_tenant);
  if not (c ->> 'ready')::boolean and not (p_force and everwake.is_platform_admin()) then
    return jsonb_build_object('live', false, 'checklist', c);
  end if;
  update everwake.tenants set status = 'live', live_at = coalesce(live_at, now()) where id = p_tenant;
  return jsonb_build_object('live', true);
end $$;

-- ---------------------------------------------------------------------
-- Publish a reviewed menu import
-- p_menu = {"categories":[{"name_ar","name_en","items":[{"name_ar","name_en","description_ar",
--           "price","unit","tags":[],"aliases":[],"is_signature","options":[{"label_ar","label_en",
--           "required","min","max","choices":[{"name_ar","name_en","price_delta"}]}]}]}]}
-- merge   = add new dishes, update the ones that match by name
-- replace = the same, and archive dishes that are not in the import
--
-- p_branch: the menu of ONE branch (012). The restaurant's dishes stay as
-- they are; for that branch only:
--   · a dish already on the menu (same name) is put on its menu, at the
--     imported price when it differs from the restaurant's, and its
--     choices (same names) at the imported choice prices
--   · a new dish (or category) is created on that branch's menu only
--   · replace = dishes not in the import come off that branch's menu
--     (nothing is archived)
-- ---------------------------------------------------------------------
create or replace function everwake.publish_menu(p_tenant uuid, p_menu jsonb, p_mode text default 'merge',
                                                 p_import uuid default null, p_branch uuid default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  cat      jsonb;
  it       jsonb;
  grp      jsonb;
  ch       jsonb;
  v_cat    uuid;
  v_item   uuid;
  v_group  uuid;
  v_csort  int := 0;
  v_isort  int;
  v_level  int;
  v_osort  int;
  v_seen   uuid[] := '{}';
  n_cat_new int := 0; n_new int := 0; n_upd int := 0; n_arch int := 0; n_unlisted int := 0; n_choice int := 0;
  v_unit   text;
  v_kept   jsonb;
  v_was    everwake.menu_items%rowtype;
  v_price  numeric;
  v_cbr    uuid[];
  v_cact   boolean;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  if p_mode not in ('merge', 'replace') then raise exception 'mode must be merge or replace'; end if;
  if p_branch is not null and not exists (select 1 from everwake.branches where id = p_branch and tenant_id = p_tenant) then
    raise exception 'branch not found';
  end if;

  for cat in select * from jsonb_array_elements(coalesce(p_menu -> 'categories', '[]'::jsonb)) loop
    v_csort := v_csort + 10;
    continue when coalesce(btrim(cat ->> 'name_ar'), btrim(cat ->> 'name_en'), '') = '';
    v_cat := null;
    select id, branch_ids, is_active into v_cat, v_cbr, v_cact from everwake.menu_categories
     where tenant_id = p_tenant
       and (everwake.norm(name_ar) = everwake.norm(coalesce(cat ->> 'name_ar', cat ->> 'name_en'))
            or (nullif(cat ->> 'name_en', '') is not null and everwake.norm(name_en) = everwake.norm(cat ->> 'name_en')))
     limit 1;
    if v_cat is null then
      insert into everwake.menu_categories (tenant_id, name_ar, name_en, sort, branch_ids)
      values (p_tenant, coalesce(nullif(btrim(cat ->> 'name_ar'), ''), btrim(cat ->> 'name_en')), nullif(btrim(cat ->> 'name_en'), ''), v_csort,
              case when p_branch is not null then array[p_branch] end)
      returning id into v_cat;
      n_cat_new := n_cat_new + 1;
    elsif p_branch is null then
      update everwake.menu_categories set is_active = true, sort = v_csort,
             name_en = coalesce(nullif(btrim(cat ->> 'name_en'), ''), name_en)
       where id = v_cat;
    else
      -- the branch serves this category; a hidden one comes back for this branch only
      update everwake.menu_categories
         set is_active = true,
             branch_ids = case when not v_cact then array[p_branch]
                               when branch_ids is null or p_branch = any(branch_ids) then branch_ids
                               else branch_ids || p_branch end,
             name_en = coalesce(name_en, nullif(btrim(cat ->> 'name_en'), ''))
       where id = v_cat;
    end if;

    v_isort := 0;
    for it in select * from jsonb_array_elements(coalesce(cat -> 'items', '[]'::jsonb)) loop
      v_isort := v_isort + 10;
      continue when coalesce(btrim(it ->> 'name_ar'), btrim(it ->> 'name_en'), '') = '';
      v_unit := case when it ->> 'unit' in ('portion', 'piece', 'kg', 'person') then it ->> 'unit' else 'portion' end;
      v_price := nullif(it ->> 'price', '')::numeric;
      v_item := null;
      select id into v_item from everwake.menu_items
       where tenant_id = p_tenant
         and (everwake.norm(name_ar) = everwake.norm(coalesce(it ->> 'name_ar', it ->> 'name_en'))
              or (nullif(it ->> 'name_en', '') is not null and everwake.norm(name_en) = everwake.norm(it ->> 'name_en')))
         and not (id = any(v_seen))
       order by is_active desc
       limit 1;
      if v_item is null then
        insert into everwake.menu_items (tenant_id, category_id, name_ar, name_en, aliases, description_ar, description_en,
                                         unit, price, qty_step, min_qty, tags, is_signature, sort, source_import_id)
        values (p_tenant, v_cat, coalesce(nullif(btrim(it ->> 'name_ar'), ''), btrim(it ->> 'name_en')),
                nullif(btrim(it ->> 'name_en'), ''),
                coalesce((select array_agg(btrim(a)) from jsonb_array_elements_text(it -> 'aliases') a where btrim(a) <> ''), '{}'),
                nullif(btrim(it ->> 'description_ar'), ''), nullif(btrim(it ->> 'description_en'), ''),
                v_unit, v_price,
                case when v_unit = 'kg' then 0.25 end, case when v_unit = 'kg' then 0.5 end,
                coalesce((select array_agg(lower(btrim(a))) from jsonb_array_elements_text(it -> 'tags') a where btrim(a) <> ''), '{}'),
                coalesce((it ->> 'is_signature')::boolean, false), v_isort, p_import)
        returning id into v_item;
        n_new := n_new + 1;
        if p_branch is not null then
          -- a dish from this branch's menu: on this branch only
          insert into everwake.menu_item_branches (tenant_id, item_id, branch_id, is_listed)
          select p_tenant, v_item, b.id, false from everwake.branches b where b.tenant_id = p_tenant and b.id <> p_branch;
        end if;
      elsif p_branch is null then
        update everwake.menu_items
           set category_id = v_cat, is_active = true, sort = v_isort, unit = v_unit,
               name_en = coalesce(nullif(btrim(it ->> 'name_en'), ''), name_en),
               description_ar = coalesce(nullif(btrim(it ->> 'description_ar'), ''), description_ar),
               description_en = coalesce(nullif(btrim(it ->> 'description_en'), ''), description_en),
               price = coalesce(v_price, price),
               aliases = case when jsonb_array_length(coalesce(it -> 'aliases', '[]'::jsonb)) > 0
                              then (select array_agg(distinct x) from unnest(aliases || (select array_agg(btrim(a)) from jsonb_array_elements_text(it -> 'aliases') a where btrim(a) <> '')) x)
                              else aliases end,
               is_signature = coalesce((it ->> 'is_signature')::boolean, is_signature),
               source_import_id = coalesce(p_import, source_import_id)
         where id = v_item;
        n_upd := n_upd + 1;
      else
        -- the restaurant's dish, now on this branch's menu at this branch's price
        select * into v_was from everwake.menu_items where id = v_item;
        update everwake.menu_items
           set is_active = true,
               name_en = coalesce(name_en, nullif(btrim(it ->> 'name_en'), '')),
               description_ar = coalesce(description_ar, nullif(btrim(it ->> 'description_ar'), '')),
               description_en = coalesce(description_en, nullif(btrim(it ->> 'description_en'), ''))
         where id = v_item;
        if not v_was.is_active then
          -- an archived dish comes back for this branch only
          insert into everwake.menu_item_branches as mb (tenant_id, item_id, branch_id, is_listed)
          select p_tenant, v_item, b.id, false from everwake.branches b where b.tenant_id = p_tenant and b.id <> p_branch
          on conflict (item_id, branch_id) do update set is_listed = false;
        end if;
        insert into everwake.menu_item_branches as mb (tenant_id, item_id, branch_id, is_listed, price)
        values (p_tenant, v_item, p_branch, true, case when v_price is distinct from v_was.price then v_price end)
        on conflict (item_id, branch_id) do update
          set is_listed = true,
              price = case when v_price is null then mb.price
                           when v_price is distinct from v_was.price then v_price end;
        n_upd := n_upd + 1;
      end if;
      v_seen := v_seen || v_item;

      if jsonb_array_length(coalesce(it -> 'options', '[]'::jsonb)) > 0 then
        if p_branch is not null and exists (select 1 from everwake.menu_option_groups where item_id = v_item) then
          -- the dish has its choices: this branch's choice prices, by name
          insert into everwake.menu_option_branches as x (tenant_id, option_id, branch_id, item_id, price_delta)
          select distinct on (o.id) p_tenant, o.id, p_branch, v_item,
                 nullif(coalesce(nullif(c ->> 'price_delta', '')::numeric, 0), o.price_delta)
            from jsonb_array_elements(it -> 'options') gj
            cross join jsonb_array_elements(coalesce(gj -> 'choices', '[]'::jsonb)) c
            join everwake.menu_option_groups g on g.item_id = v_item
            join everwake.menu_options o on o.group_id = g.id
                 and everwake.norm(o.name_ar) = everwake.norm(coalesce(nullif(c ->> 'name_ar', ''), c ->> 'name_en'))
           order by o.id, (everwake.norm(g.label_ar) = everwake.norm(gj ->> 'label_ar')) desc
          on conflict (option_id, branch_id) do update set price_delta = excluded.price_delta, is_available = true;
          get diagnostics v_level = row_count;
          n_choice := n_choice + v_level;
        else
          -- the choices are replaced as a whole when the import carries any
          v_kept := everwake.choice_overrides(v_item);
          delete from everwake.menu_option_groups where item_id = v_item;
          v_level := 0;
          for grp in select * from jsonb_array_elements(it -> 'options') loop
            continue when jsonb_array_length(coalesce(grp -> 'choices', '[]'::jsonb)) = 0;
            v_level := v_level + 1;
            insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
            values (p_tenant, v_item, v_level,
                    coalesce(nullif(btrim(grp ->> 'label_ar'), ''), nullif(btrim(grp ->> 'label_en'), ''), 'اختيار'),
                    nullif(btrim(grp ->> 'label_en'), ''),
                    coalesce((grp ->> 'required')::boolean, false),
                    greatest(0, coalesce((grp ->> 'min')::int, case when coalesce((grp ->> 'required')::boolean, false) then 1 else 0 end)),
                    nullif(grp ->> 'max', '')::int)
            returning id into v_group;
            v_osort := 0;
            for ch in select * from jsonb_array_elements(grp -> 'choices') loop
              v_osort := v_osort + 10;
              continue when coalesce(btrim(ch ->> 'name_ar'), btrim(ch ->> 'name_en'), '') = '';
              insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, price_delta, sort)
              values (p_tenant, v_group, coalesce(nullif(btrim(ch ->> 'name_ar'), ''), btrim(ch ->> 'name_en')),
                      nullif(btrim(ch ->> 'name_en'), ''), coalesce(nullif(ch ->> 'price_delta', '')::numeric, 0), v_osort);
            end loop;
          end loop;
          perform everwake.restore_choice_overrides(v_item, v_kept);
        end if;
      end if;
    end loop;
  end loop;

  if p_mode = 'replace' and p_branch is null then
    update everwake.menu_items set is_active = false
     where tenant_id = p_tenant and is_active and not (id = any(v_seen));
    get diagnostics n_arch = row_count;
  elsif p_mode = 'replace' then
    insert into everwake.menu_item_branches as mb (tenant_id, item_id, branch_id, is_listed)
    select p_tenant, i.id, p_branch, false
      from everwake.menu_items i
     where i.tenant_id = p_tenant and i.is_active and not (i.id = any(v_seen))
    on conflict (item_id, branch_id) do update set is_listed = false where mb.is_listed;
    get diagnostics n_unlisted = row_count;
  end if;

  if p_import is not null then
    update everwake.menu_imports
       set status = 'published', published_at = now(), published_by = everwake.current_user_id(), extracted = p_menu,
           branch_id = p_branch
     where id = p_import and tenant_id = p_tenant;
  end if;

  return jsonb_build_object('categories_created', n_cat_new, 'items_created', n_new, 'items_updated', n_upd,
                            'items_archived', n_arch, 'items_unlisted', n_unlisted, 'choice_prices', n_choice,
                            'branch_id', p_branch);
end $$;

-- ---------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------
create or replace function everwake.analytics(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  t    everwake.tenants%rowtype;
  s    jsonb;
  v    jsonb;
  v_comm numeric;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  select * into t from everwake.tenants where id = p_tenant;
  s := everwake.merged_settings(t.settings);
  v_comm := coalesce((s ->> 'aggregator_commission_percent')::numeric, 25);

  with o as (
    select * from everwake.orders
     where tenant_id = p_tenant and placed_at >= p_from and placed_at < p_to and status <> 'draft'
  ), good as (select * from o where status not in ('rejected', 'cancelled')),
  conv as (
    select count(distinct m.wa_id) as n
      from everwake.messages m
     where m.tenant_id = p_tenant and m.direction = 'inbound' and m.created_at >= p_from and m.created_at < p_to
  )
  select jsonb_build_object(
    'currency', t.currency,
    'currency_symbol', t.currency_symbol_ar,
    'orders', (select count(*) from good),
    'revenue', (select coalesce(sum(total), 0) from good),
    'average_order', (select coalesce(round(avg(total), 2), 0) from good),
    'cancelled', (select count(*) from o where status in ('rejected', 'cancelled')),
    'discounts', (select coalesce(sum(discount_total), 0) from good),
    'delivery_share', (select coalesce(round(100.0 * count(*) filter (where delivery_method = 'delivery') / nullif(count(*), 0), 1), 0) from good),
    'conversations', (select n from conv),
    'conversion_percent', (select case when (select n from conv) = 0 then 0
                                       else round(100.0 * count(distinct wa_id) / (select n from conv), 1) end from good),
    'new_customers', (select count(*) from everwake.customers where tenant_id = p_tenant and first_seen_at >= p_from and first_seen_at < p_to),
    'returning_orders', (select count(*) from good g
                          where exists (select 1 from everwake.orders x where x.customer_id = g.customer_id and x.status <> 'draft'
                                          and x.placed_at < g.placed_at and x.status not in ('rejected', 'cancelled'))),
    'commission_percent', v_comm,
    'commission_saved', (select coalesce(round(sum(total) * v_comm / 100, 2), 0) from good),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'orders', n, 'revenue', r) order by d)
                          from (select (placed_at at time zone t.timezone)::date as d, count(*) as n, sum(total) as r
                                  from good group by 1) x), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'orders', n) order by h)
                           from (select extract(hour from placed_at at time zone t.timezone)::int as h, count(*) as n
                                   from good group by 1) x), '[]'::jsonb),
    'by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch', coalesce(b.name_ar, '—'), 'orders', x.n, 'revenue', x.r) order by x.r desc)
                             from (select branch_id, count(*) as n, sum(total) as r from good group by 1) x
                             left join everwake.branches b on b.id = x.branch_id), '[]'::jsonb),
    'top_items', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', q, 'revenue', r) order by r desc nulls last)
                             from (select oi.name, sum(oi.quantity) as q, sum(oi.line_total) as r
                                     from everwake.order_items oi join good g on g.id = oi.order_id
                                    where not oi.is_gift
                                    group by oi.name order by sum(oi.line_total) desc nulls last limit 10) x), '[]'::jsonb),
    'agent', (select jsonb_build_object(
                'turns', count(*),
                'avg_reply_seconds', coalesce(round(avg(duration_total_ms) / 1000.0, 1), 0),
                'repairs', count(*) filter (where repair_used),
                'tokens', coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0))
                from everwake.agent_events where tenant_id = p_tenant and created_at >= p_from and created_at < p_to),
    'handoffs', (select count(*) from everwake.conversations
                  where tenant_id = p_tenant and attention_at >= p_from and attention_at < p_to))
  into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- The WhatsApp number. Secrets are written here and never read back by
-- the dashboard (see the column grants in 007).
-- ---------------------------------------------------------------------
create or replace function everwake.save_channel(p_tenant uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  c    everwake.whatsapp_channels%rowtype;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  if v_id is null then
    insert into everwake.whatsapp_channels (tenant_id, provider, label, phone_number, instance_name, base_url, api_key,
                                            default_branch_id, cloud_phone_number_id, cloud_access_token)
    values (p_tenant, coalesce(nullif(p ->> 'provider', ''), 'evolution'), nullif(p ->> 'label', ''),
            nullif(everwake.digits(p ->> 'phone_number'), ''), nullif(btrim(p ->> 'instance_name'), ''),
            nullif(rtrim(btrim(p ->> 'base_url'), '/'), ''), nullif(btrim(p ->> 'api_key'), ''),
            nullif(p ->> 'default_branch_id', '')::uuid, nullif(btrim(p ->> 'cloud_phone_number_id'), ''),
            nullif(btrim(p ->> 'cloud_access_token'), ''))
    returning * into c;
  else
    update everwake.whatsapp_channels
       set label = coalesce(p ->> 'label', label),
           phone_number = coalesce(nullif(everwake.digits(p ->> 'phone_number'), ''), phone_number),
           instance_name = coalesce(nullif(btrim(p ->> 'instance_name'), ''), instance_name),
           base_url = coalesce(nullif(rtrim(btrim(p ->> 'base_url'), '/'), ''), base_url),
           api_key = coalesce(nullif(btrim(p ->> 'api_key'), ''), api_key),
           cloud_phone_number_id = coalesce(nullif(btrim(p ->> 'cloud_phone_number_id'), ''), cloud_phone_number_id),
           cloud_access_token = coalesce(nullif(btrim(p ->> 'cloud_access_token'), ''), cloud_access_token),
           default_branch_id = case when p ? 'default_branch_id' then nullif(p ->> 'default_branch_id', '')::uuid else default_branch_id end,
           is_active = coalesce((p ->> 'is_active')::boolean, is_active),
           webhook_token = case when coalesce((p ->> 'rotate_token')::boolean, false)
                                then replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') else webhook_token end
     where id = v_id and tenant_id = p_tenant
    returning * into c;
    if not found then raise exception 'number not found'; end if;
  end if;
  return jsonb_build_object('id', c.id, 'instance_name', c.instance_name, 'webhook_token', c.webhook_token,
                            'has_api_key', c.api_key is not null, 'status', c.status);
end $$;

-- the webhook token is needed once, to paste the webhook URL into Evolution
create or replace function everwake.channel_webhook_token(p_channel uuid)
returns text language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare c everwake.whatsapp_channels%rowtype;
begin
  select * into c from everwake.whatsapp_channels where id = p_channel;
  if not found then raise exception 'number not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager']);
  return c.webhook_token;
end $$;

-- ---------------------------------------------------------------------
-- The team
-- ---------------------------------------------------------------------
create or replace function everwake.invite_member(p_tenant uuid, p_email text, p_role text default 'staff',
                                                  p_branch_ids uuid[] default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_id uuid;
begin
  perform everwake.require_role(p_tenant, array['owner']);
  if p_role not in ('owner', 'manager', 'staff') then raise exception 'unknown role'; end if;
  insert into everwake.tenant_invites (tenant_id, email, role, branch_ids, invited_by)
  values (p_tenant, lower(btrim(p_email)), p_role, p_branch_ids, everwake.current_user_id())
  on conflict (tenant_id, email) do update
    set role = excluded.role, branch_ids = excluded.branch_ids, accepted_at = null, accepted_by = null
  returning id into v_id;
  return jsonb_build_object('invite_id', v_id);
end $$;

-- run after every sign-in: joins the restaurants this e-mail was invited to
create or replace function everwake.accept_invites()
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_uid   uuid := everwake.current_user_id();
  v_email text := lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
  r       record;
  n       int := 0;
begin
  if v_uid is null or v_email is null then return 0; end if;
  for r in select * from everwake.tenant_invites where email = v_email and accepted_at is null loop
    insert into everwake.tenant_members (tenant_id, user_id, role, branch_ids, email, display_name)
    values (r.tenant_id, v_uid, r.role, r.branch_ids, v_email, split_part(v_email, '@', 1))
    on conflict (tenant_id, user_id) do update set role = excluded.role, branch_ids = excluded.branch_ids;
    update everwake.tenant_invites set accepted_at = now(), accepted_by = v_uid where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function everwake.update_member(p_tenant uuid, p_user uuid, p_role text,
                                                  p_branch_ids uuid[] default null, p_display_name text default null)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner']);
  if p_role not in ('owner', 'manager', 'staff') then raise exception 'unknown role'; end if;
  if p_role <> 'owner' and (select role from everwake.tenant_members where tenant_id = p_tenant and user_id = p_user) = 'owner'
     and (select count(*) from everwake.tenant_members where tenant_id = p_tenant and role = 'owner') = 1 then
    raise exception 'a restaurant always keeps at least one owner';
  end if;
  update everwake.tenant_members
     set role = p_role, branch_ids = p_branch_ids, display_name = coalesce(nullif(btrim(p_display_name), ''), display_name)
   where tenant_id = p_tenant and user_id = p_user;
end $$;

create or replace function everwake.remove_member(p_tenant uuid, p_user uuid)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner']);
  if (select role from everwake.tenant_members where tenant_id = p_tenant and user_id = p_user) = 'owner'
     and (select count(*) from everwake.tenant_members where tenant_id = p_tenant and role = 'owner') = 1 then
    raise exception 'a restaurant always keeps at least one owner';
  end if;
  delete from everwake.tenant_members where tenant_id = p_tenant and user_id = p_user;
end $$;

-- ---------------------------------------------------------------------
-- A dish's choices, saved as a whole (levels in the order given)
-- p_groups = [{"label_ar","label_en","required","min","max",
--              "options":[{"name_ar","name_en","aliases":[],"price_delta","extra_charge","is_available"}]}]
-- ---------------------------------------------------------------------
create or replace function everwake.save_item_choices(p_item uuid, p_groups jsonb)
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_tenant uuid;
  g jsonb; o jsonb;
  v_group uuid;
  v_level int := 0;
  v_sort int;
  v_kept jsonb;
begin
  select tenant_id into v_tenant from everwake.menu_items where id = p_item;
  if v_tenant is null then raise exception 'dish not found'; end if;
  perform everwake.require_role(v_tenant, array['owner', 'manager']);
  v_kept := everwake.choice_overrides(p_item);            -- the branches' own choice prices (012)
  delete from everwake.menu_option_groups where item_id = p_item;
  for g in select * from jsonb_array_elements(coalesce(p_groups, '[]'::jsonb)) loop
    continue when jsonb_array_length(coalesce(g -> 'options', '[]'::jsonb)) = 0 or coalesce(btrim(g ->> 'label_ar'), '') = '';
    v_level := v_level + 1;
    insert into everwake.menu_option_groups (tenant_id, item_id, level, label_ar, label_en, required, min_select, max_select)
    values (v_tenant, p_item, v_level, btrim(g ->> 'label_ar'), nullif(btrim(g ->> 'label_en'), ''),
            coalesce((g ->> 'required')::boolean, false),
            greatest(0, coalesce(nullif(g ->> 'min', '')::int, case when coalesce((g ->> 'required')::boolean, false) then 1 else 0 end)),
            nullif(g ->> 'max', '')::int)
    returning id into v_group;
    v_sort := 0;
    for o in select * from jsonb_array_elements(g -> 'options') loop
      continue when coalesce(btrim(o ->> 'name_ar'), '') = '';
      v_sort := v_sort + 10;
      insert into everwake.menu_options (tenant_id, group_id, name_ar, name_en, aliases, price_delta, extra_charge, is_available, sort)
      values (v_tenant, v_group, btrim(o ->> 'name_ar'), nullif(btrim(o ->> 'name_en'), ''),
              coalesce((select array_agg(btrim(a)) from jsonb_array_elements_text(o -> 'aliases') a where btrim(a) <> ''), '{}'),
              coalesce(nullif(o ->> 'price_delta', '')::numeric, 0), coalesce((o ->> 'extra_charge')::boolean, false),
              coalesce((o ->> 'is_available')::boolean, true), v_sort);
    end loop;
  end loop;
  perform everwake.restore_choice_overrides(p_item, v_kept);
  return v_level;
end $$;
