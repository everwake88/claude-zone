-- Everwake Orders · patch 2026-10-23 · branches that differ
-- Each branch can have its own menu (dishes and categories on or off, its own
-- dish and choice prices, choices it doesn't have), seating or not (dine-in),
-- and its own payment methods. The dashboard edits one branch's menu many
-- dishes at a time, sets a branch up like another, and imports a menu for one
-- branch; the agent reads each branch's own menu, seating and payment methods.
-- The same as 012_branch_differences.sql, plus the functions it changes in
-- 003 (the snapshot), 004 (details), 006 (menu import, choices) and 010 (bookings).
-- Already in the migrations for new installs. Run once in Supabase → SQL Editor,
-- after 2026-10-22_payment_secrets.sql.

-- the signatures that change (each gets a branch)
drop function if exists everwake.item_choices_json(uuid);
drop function if exists everwake.item_choices_text(uuid, text);
drop function if exists everwake.publish_menu(uuid, jsonb, text, uuid);

-- ---- 012 -------------------------------------------------------------------
alter table everwake.branches
  add column dine_in         boolean,   -- seating: true / false; null = not said (the agent promises nothing)
  add column payment_methods text[]     -- null = the restaurant's list
    check (payment_methods <@ array['cash', 'card', 'wallet', 'instapay', 'online'] and cardinality(payment_methods) > 0),
  add constraint branches_bookings_need_seating check (dine_in is not false or reservations = 'off');

alter table everwake.menu_categories
  add column branch_ids uuid[];         -- null = every branch; else only these

alter table everwake.menu_imports
  add column branch_id uuid references everwake.branches(id) on delete set null;  -- imported for one branch

-- per-branch choices: a choice has its dish's price and is offered at every
-- branch unless a row here says otherwise
create table everwake.menu_option_branches (
  tenant_id    uuid not null references everwake.tenants(id) on delete cascade,
  option_id    uuid not null references everwake.menu_options(id) on delete cascade,
  branch_id    uuid not null references everwake.branches(id) on delete cascade,
  item_id      uuid not null references everwake.menu_items(id) on delete cascade,
  price_delta  numeric(10, 2),          -- null = the choice's own price
  is_available boolean not null default true,
  updated_at   timestamptz not null default now(),
  primary key (option_id, branch_id)
);
create index menu_option_branches_item_idx on everwake.menu_option_branches (item_id, branch_id);

create trigger menu_option_branches_touch before update on everwake.menu_option_branches
  for each row execute function everwake.touch_updated_at();
create trigger menu_option_branches_menu_rev after insert or update or delete on everwake.menu_option_branches
  for each row execute function everwake.bump_menu_rev();
create trigger menu_option_branches_audit after insert or update or delete on everwake.menu_option_branches
  for each row execute function everwake.audit_change();

-- ---------------------------------------------------------------------
-- The payment methods a branch takes: its own list, or the restaurant's.
-- "online" only while the restaurant's Paymob account is on. No branch
-- given: every method at least one branch takes.
-- ---------------------------------------------------------------------
create or replace function everwake.payment_methods_at(p_tenant uuid, p_branch uuid default null)
returns jsonb language sql stable as $$
  with t as (
    select array(select jsonb_array_elements_text(coalesce(everwake.merged_settings(x.settings) -> 'payment_methods',
                                                           '["cash"]'::jsonb))) as pm,
           exists (select 1 from everwake.payment_accounts a where a.tenant_id = p_tenant and a.enabled) as online
      from everwake.tenants x where x.id = p_tenant
  ), lists as (
    select coalesce(nullif(array(select m from unnest(b.payment_methods) m where m <> 'online' or (select online from t)), '{}'),
                    (select pm from t)) as pm
      from everwake.branches b
     where b.tenant_id = p_tenant and b.is_active and (p_branch is null or b.id = p_branch)
  )
  select to_jsonb(array(
           select k.m from unnest(array['cash', 'card', 'wallet', 'instapay', 'online']) with ordinality k(m, n)
            where k.m = any (coalesce((select array_agg(x) from lists, unnest(lists.pm) x), (select pm from t)))
              and (k.m <> 'online' or (select online from t))
            order by k.n))
$$;

-- ---------------------------------------------------------------------
-- A dish's choices are saved as a whole (006: written again from scratch).
-- The branches' own choice prices and switches are kept across that, on
-- the choice with the same name (in the question with the same name, or
-- at the same level).
-- ---------------------------------------------------------------------
create or replace function everwake.choice_overrides(p_item uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'label', everwake.norm(g.label_ar), 'level', g.level, 'name', everwake.norm(o.name_ar),
           'branch_id', x.branch_id, 'price_delta', x.price_delta, 'is_available', x.is_available)), '[]'::jsonb)
    from everwake.menu_option_branches x
    join everwake.menu_options o on o.id = x.option_id
    join everwake.menu_option_groups g on g.id = o.group_id
   where x.item_id = p_item
$$;

create or replace function everwake.restore_choice_overrides(p_item uuid, p_kept jsonb)
returns int language plpgsql as $$
declare n int;
begin
  insert into everwake.menu_option_branches (tenant_id, option_id, branch_id, item_id, price_delta, is_available)
  select distinct on (o.id, k ->> 'branch_id')
         o.tenant_id, o.id, (k ->> 'branch_id')::uuid, p_item,
         nullif(k ->> 'price_delta', '')::numeric, coalesce((k ->> 'is_available')::boolean, true)
    from everwake.menu_option_groups g
    join everwake.menu_options o on o.group_id = g.id
    join jsonb_array_elements(coalesce(p_kept, '[]'::jsonb)) k
      on k ->> 'name' = everwake.norm(o.name_ar)
     and (k ->> 'label' = everwake.norm(g.label_ar) or (k ->> 'level')::int = g.level)
    join everwake.branches b on b.id = (k ->> 'branch_id')::uuid
   where g.item_id = p_item
   order by o.id, k ->> 'branch_id', (k ->> 'label' = everwake.norm(g.label_ar)) desc
  on conflict (option_id, branch_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- a price as menus print it: to the nearest p_step (1, 5, …); 0 = to the piastre
create or replace function everwake.round_price(p numeric, p_step numeric)
returns numeric language sql immutable as $$
  select case when p is null then null
              when coalesce(p_step, 0) <= 0 then round(p, 2)
              else round(p / p_step) * p_step end
$$;

-- ---------------------------------------------------------------------
-- Many dishes at one branch at once (the menu page with a branch chosen)
-- p = {"items": ["<item id>", …],
--      "listed": true | false,                        on / off this branch's menu
--      "available": true | false,                     the stock switch at this branch
--      "price": {"mode": "reset" | "set" | "percent" | "amount",
--                "value": 10,                         the price, or +/- % or amount
--                "from": "current" | "restaurant",    what a % or amount starts from
--                "round": 1,                          to the nearest pound (5, 0.5, 0 = exact)
--                "choices": true}}                    a % or a reset also moves the choice prices
-- A price that comes out equal to the restaurant's is stored as "the
-- restaurant's" (no override), so later restaurant price changes reach it.
-- ---------------------------------------------------------------------
create or replace function everwake.branch_menu_update(p_tenant uuid, p_branch uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  v_items   uuid[];
  v_mode    text := nullif(p -> 'price' ->> 'mode', '');
  v_val     numeric := nullif(p -> 'price' ->> 'value', '')::numeric;
  v_from    text := coalesce(nullif(p -> 'price' ->> 'from', ''), 'current');
  v_round   numeric := coalesce(nullif(p -> 'price' ->> 'round', '')::numeric, 1);
  v_choices boolean := coalesce((p -> 'price' ->> 'choices')::boolean, true);
  n_items   int := 0;
  n_choices int := 0;
  n         int;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  if not exists (select 1 from everwake.branches where id = p_branch and tenant_id = p_tenant) then
    raise exception 'branch not found';
  end if;
  if v_mode is not null and v_mode not in ('reset', 'set', 'percent', 'amount') then
    raise exception 'price mode is reset, set, percent or amount';
  end if;
  if v_mode in ('set', 'percent', 'amount') and v_val is null then raise exception 'a price change needs a value'; end if;
  if v_mode = 'set' and v_val < 0 then raise exception 'a price cannot be below zero'; end if;
  if v_mode = 'percent' and v_val <= -100 then raise exception 'a price cannot go down by 100%% or more'; end if;
  if v_from not in ('current', 'restaurant') then raise exception 'from is current or restaurant'; end if;

  select array_agg(i.id) into v_items
    from everwake.menu_items i
   where i.tenant_id = p_tenant
     and i.id in (select x::uuid from jsonb_array_elements_text(coalesce(p -> 'items', '[]'::jsonb)) x);
  if v_items is null then
    return jsonb_build_object('items', 0, 'choices', 0);
  end if;

  -- each dish gets its row for this branch (as it is now: on the menu, the restaurant's price)
  insert into everwake.menu_item_branches (tenant_id, item_id, branch_id)
  select p_tenant, x, p_branch from unnest(v_items) x
  on conflict (item_id, branch_id) do nothing;

  if p ? 'listed' then
    update everwake.menu_item_branches set is_listed = (p ->> 'listed')::boolean
     where branch_id = p_branch and item_id = any(v_items) and is_listed is distinct from (p ->> 'listed')::boolean;
    get diagnostics n = row_count; n_items := greatest(n_items, n);
  end if;

  if p ? 'available' then
    update everwake.menu_item_branches set is_available = (p ->> 'available')::boolean, sold_out_until = null
     where branch_id = p_branch and item_id = any(v_items)
       and (is_available is distinct from (p ->> 'available')::boolean or sold_out_until is not null);
    get diagnostics n = row_count; n_items := greatest(n_items, n);
  end if;

  if v_mode is not null then
    update everwake.menu_item_branches mb
       set price = x.new_price
      from (select mb2.item_id,
                   case when v_mode = 'reset' then null
                        else nullif(greatest(0, everwake.round_price(
                               case v_mode
                                 when 'set' then v_val
                                 when 'percent' then b.base * (1 + v_val / 100)
                                 when 'amount' then b.base + v_val end, v_round)), i.price) end as new_price,
                   b.base
              from everwake.menu_item_branches mb2
              join everwake.menu_items i on i.id = mb2.item_id
              cross join lateral (select case when v_from = 'restaurant' then i.price else coalesce(mb2.price, i.price) end as base) b
             where mb2.branch_id = p_branch and mb2.item_id = any(v_items)) x
     where mb.branch_id = p_branch and mb.item_id = x.item_id
       and (v_mode in ('reset', 'set') or x.base is not null)        -- "+10%" of a price the branch confirms: nothing to move
       and mb.price is distinct from x.new_price;
    get diagnostics n = row_count; n_items := greatest(n_items, n);

    if v_choices and v_mode = 'reset' then
      update everwake.menu_option_branches set price_delta = null
       where branch_id = p_branch and item_id = any(v_items) and price_delta is not null;
      get diagnostics n_choices = row_count;
    elsif v_choices and v_mode = 'percent' then
      insert into everwake.menu_option_branches (tenant_id, option_id, branch_id, item_id)
      select p_tenant, o.id, p_branch, g.item_id
        from everwake.menu_options o join everwake.menu_option_groups g on g.id = o.group_id
       where g.item_id = any(v_items) and o.price_delta <> 0
      on conflict (option_id, branch_id) do nothing;
      update everwake.menu_option_branches x
         set price_delta = nullif(everwake.round_price(
                             (case when v_from = 'restaurant' then o.price_delta else coalesce(x.price_delta, o.price_delta) end)
                             * (1 + v_val / 100), v_round), o.price_delta)
        from everwake.menu_options o
       where o.id = x.option_id and x.branch_id = p_branch and x.item_id = any(v_items)
         and (case when v_from = 'restaurant' then o.price_delta else coalesce(x.price_delta, o.price_delta) end) <> 0
         and x.price_delta is distinct from nullif(everwake.round_price(
                             (case when v_from = 'restaurant' then o.price_delta else coalesce(x.price_delta, o.price_delta) end)
                             * (1 + v_val / 100), v_round), o.price_delta);
      get diagnostics n_choices = row_count;
    end if;
  end if;

  -- rows that change nothing any more
  delete from everwake.menu_item_branches
   where branch_id = p_branch and item_id = any(v_items)
     and is_listed and price is null and is_available and sold_out_until is null;
  delete from everwake.menu_option_branches
   where branch_id = p_branch and item_id = any(v_items) and price_delta is null and is_available;

  return jsonb_build_object('items', n_items, 'choices', n_choices);
end $$;

-- ---------------------------------------------------------------------
-- One branch's menu set up like another's (a new branch "the same as
-- Zamalek"): the same dishes on and off, the same prices, the same choice
-- prices and choices, the same categories. p_from null: back to the
-- restaurant's menu — every dish, the restaurant's prices and choices.
-- The stock switches stay as they are: those are the branch's own, today.
-- ---------------------------------------------------------------------
create or replace function everwake.copy_branch_menu(p_tenant uuid, p_from uuid, p_to uuid)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare n_items int; n_choices int; n_cats int := 0;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  if not exists (select 1 from everwake.branches where id = p_to and tenant_id = p_tenant)
     or (p_from is not null and not exists (select 1 from everwake.branches where id = p_from and tenant_id = p_tenant)) then
    raise exception 'branch not found';
  end if;
  if p_from = p_to then raise exception 'choose another branch to copy from'; end if;

  insert into everwake.menu_item_branches as mb (tenant_id, item_id, branch_id, is_listed, price)
  select p_tenant, i.id, p_to, coalesce(f.is_listed, true), f.price
    from everwake.menu_items i
    left join everwake.menu_item_branches f on f.item_id = i.id and f.branch_id = p_from
   where i.tenant_id = p_tenant
  on conflict (item_id, branch_id) do update
    set is_listed = excluded.is_listed, price = excluded.price
    where (mb.is_listed, mb.price) is distinct from (excluded.is_listed, excluded.price);
  get diagnostics n_items = row_count;
  delete from everwake.menu_item_branches
   where branch_id = p_to and is_listed and price is null and is_available and sold_out_until is null;

  delete from everwake.menu_option_branches where branch_id = p_to;
  insert into everwake.menu_option_branches (tenant_id, option_id, branch_id, item_id, price_delta, is_available)
  select tenant_id, option_id, p_to, item_id, price_delta, is_available
    from everwake.menu_option_branches where branch_id = p_from;
  get diagnostics n_choices = row_count;

  if p_from is not null then
    update everwake.menu_categories
       set branch_ids = case when p_from = any(branch_ids) then branch_ids || p_to else array_remove(branch_ids, p_to) end
     where tenant_id = p_tenant and branch_ids is not null
       and (p_from = any(branch_ids)) <> coalesce(p_to = any(branch_ids), false);
    get diagnostics n_cats = row_count;
  end if;

  return jsonb_build_object('items', n_items, 'choices', n_choices, 'categories', n_cats);
end $$;

-- ---------------------------------------------------------------------
-- Who can see and change what
-- ---------------------------------------------------------------------
alter table everwake.menu_option_branches enable row level security;
create policy member_read on everwake.menu_option_branches for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));
create policy editor_write on everwake.menu_option_branches for all to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
grant select, insert, update, delete on everwake.menu_option_branches to authenticated;
grant all on everwake.menu_option_branches to service_role;

revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;
grant execute on function everwake.branch_menu_update(uuid, uuid, jsonb), everwake.copy_branch_menu(uuid, uuid, uuid),
  everwake.payment_methods_at(uuid, uuid)
  to authenticated;

-- ---- 003 · the snapshot: each branch its own menu, seating and payment methods ----

-- one dish's choices as the engine reads them, at one branch (its own
-- choice prices, without the choices it doesn't have — 012)
create or replace function everwake.item_choices_json(p_item uuid, p_branch uuid default null)
returns jsonb language plpgsql stable as $$
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'level', g.level, 'label_ar', g.label_ar, 'label_en', g.label_en,
             'required', g.required, 'min', g.min_select, 'max', g.max_select,
             'options', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'name', o.name_ar, 'name_en', o.name_en, 'aliases', to_jsonb(o.aliases),
                        'price', coalesce(x.price_delta, o.price_delta), 'extra_charge', o.extra_charge)
                      order by o.sort, o.name_ar)
                 from everwake.menu_options o
                 left join everwake.menu_option_branches x on x.option_id = o.id and x.branch_id = p_branch
                where o.group_id = g.id and o.is_available and coalesce(x.is_available, true)), '[]'::jsonb))
           order by g.level), '[]'::jsonb)
      from everwake.menu_option_groups g
     where g.item_id = p_item);
end $$;

-- one dish's choices as the model reads them (one line), at one branch
create or replace function everwake.item_choices_text(p_item uuid, p_sym text, p_branch uuid default null)
returns text language plpgsql stable as $$
begin
  return (
    select string_agg(
             g.label_ar
             || ' (' || case when g.required then 'مطلوب' else 'اختياري' end
             || case when coalesce(g.max_select, 99) > 1 and g.max_select is not null then '، لحد ' || g.max_select
                     when g.max_select is null and not g.required then '، أكتر من اختيار'
                     else '' end
             || '): '
             || coalesce((
                  select string_agg(o.name_ar
                                    || case when p.price > 0 then ' +' || everwake.fmt_money(p.price) || p_sym
                                            when p.price < 0 then ' ' || everwake.fmt_money(p.price) || p_sym
                                            else '' end
                                    || case when o.extra_charge then ' (+رسوم تسوية يحددها الفرع)' else '' end,
                                    ' / ' order by o.sort, o.name_ar)
                    from everwake.menu_options o
                    left join everwake.menu_option_branches x on x.option_id = o.id and x.branch_id = p_branch
                    cross join lateral (select coalesce(x.price_delta, o.price_delta) as price) p
                   where o.group_id = g.id and o.is_available and coalesce(x.is_available, true)), '—'),
             ' · ' order by g.level)
      from everwake.menu_option_groups g
     where g.item_id = p_item);
end $$;

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
     and (c.branch_ids is null or br.id = any(c.branch_ids))      -- a category only some branches serve
     and coalesce(mib.is_listed, true)
     and (i.orderable or br.dine_in is not false);               -- dine-in only: not where there is no seating

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
           'dine_in', br.dine_in,
           'payment_methods', everwake.payment_methods_at(p_tenant, br.id),
           'own_payment_methods', br.payment_methods is not null,
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
           coalesce(jsonb_object_agg(e.code, jsonb_build_object('levels', everwake.item_choices_json(e.item_id, b.id)))
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
                    || coalesce(E'\n  اختيارات: ' || everwake.item_choices_text(e.item_id, v_sym, b.id), ''),
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

-- ---- 004 · details: the payment methods of the customer's branch ----

create or replace function everwake.details_context(p_tenant uuid, p_wa text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'state', coalesce((select state from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa), '{}'::jsonb),
    'settings', everwake.merged_settings((select settings from everwake.tenants where id = p_tenant)),
    'saved_addresses', coalesce((
       select jsonb_agg(to_jsonb(a) order by a.last_used_at desc)
         from everwake.customer_addresses a
         join everwake.conversations c on c.customer_id = a.customer_id
        where c.tenant_id = p_tenant and c.wa_id = p_wa), '[]'::jsonb),
    'zones_drawn', exists (select 1 from everwake.delivery_zones where tenant_id = p_tenant and is_active),
    -- each branch takes its own payment methods (012)
    'payment_methods_by_branch', coalesce((
       select jsonb_object_agg(b ->> 'id', b -> 'payment_methods')
         from everwake.menu_snapshot s, jsonb_array_elements(s.lookup -> 'branches') b
        where s.tenant_id = p_tenant and s.scope = 'all'), '{}'::jsonb))
$$;

-- ---- 006 · a menu imported for one branch; choices saved keep the branches' prices ----

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

-- ---- 010 · bookings: "no seating" said plainly ----

create or replace function everwake.reservation_tool(p_tenant uuid, p_wa text, p_action text, p_details text)
returns jsonb language plpgsql as $$
declare
  t        everwake.tenants%rowtype;
  setup    jsonb := everwake.reservation_setup(p_tenant);
  v        jsonb;
  r        everwake.reservations%rowtype;
  b        everwake.branches%rowtype;
  bset     jsonb;
  conv     everwake.conversations%rowtype;
  cust     everwake.customers%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  problems jsonb := '[]'::jsonb;
  missing  text[] := '{}';
  v_local  timestamp;
  v_txt    text;
  v_d      date;
  v_t      time;
  v_n      int;
  v_max    int;
  v_changed boolean := false;
  v_ready  boolean;
  v_lang   text := everwake.customer_language(p_tenant, p_wa);
  upcoming jsonb;
begin
  select * into t from everwake.tenants where id = p_tenant;
  begin
    v := coalesce(nullif(btrim(coalesce(p_details, '')), '')::jsonb, '{}'::jsonb);
  exception when others then
    v := '{}'::jsonb;
    problems := problems || jsonb_build_object('problem', 'BAD_DETAILS_JSON', 'fact', 'details_json was not a JSON object — send {"field":"value"}');
  end;
  if jsonb_typeof(v) <> 'object' then v := '{}'::jsonb; end if;

  upcoming := coalesce((select jsonb_agg(everwake.reservation_view(x) order by x.reserved_for)
                          from everwake.reservations x
                         where x.tenant_id = p_tenant and x.wa_id = p_wa and x.status in ('requested', 'confirmed')
                           and x.reserved_for > now() - interval '3 hours'), '[]'::jsonb);

  if not coalesce((setup ->> 'enabled')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'NOT_TAKEN_ON_WHATSAPP',
      'fact', 'this restaurant does not take table bookings on WhatsApp',
      'by_phone', (select coalesce(jsonb_agg(jsonb_build_object('branch', x ->> 'name_ar', 'phone', x ->> 'phone', 'note', x ->> 'note')), '[]'::jsonb)
                     from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'phone'),
      'upcoming', upcoming);
  end if;
  if v_action not in ('update', 'summary', 'submit', 'cancel', 'status') then
    return jsonb_build_object('ok', false, 'error', 'UNKNOWN_ACTION', 'fact', 'action is one of: update, summary, submit, cancel, status');
  end if;

  -- ---- cancel -----------------------------------------------------------
  if v_action = 'cancel' then
    delete from everwake.reservations where tenant_id = p_tenant and wa_id = p_wa and status = 'draft' returning * into r;
    if found then return jsonb_build_object('ok', true, 'status', 'DRAFT_DISCARDED', 'upcoming', upcoming); end if;
    select * into r from everwake.reservations
     where tenant_id = p_tenant and wa_id = p_wa and status in ('requested', 'confirmed') and reserved_for > now()
       and (nullif(v ->> 'ref_no', '') is null or upper(ref_no) = upper(v ->> 'ref_no'))
     order by reserved_for limit 1 for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'NOTHING_TO_CANCEL', 'upcoming', upcoming); end if;
    update everwake.reservations set status = 'cancelled', decided_at = now(), decline_reason = 'cancelled by the customer on WhatsApp'
     where id = r.id returning * into r;
    perform everwake.queue_reservation_ticket(r, everwake.reservation_ticket(r, '❌ العميل لغى الحجز'));
    return jsonb_build_object('ok', true, 'status', 'CANCELLED', 'reservation', everwake.reservation_view(r),
                              'fact', 'cancelled; the branch team was told');
  end if;

  -- ---- the booking in progress -------------------------------------------------
  select * into r from everwake.reservations where tenant_id = p_tenant and wa_id = p_wa and status = 'draft' for update;
  if not found and v_action = 'status' then
    return jsonb_build_object('ok', true, 'status', 'NO_BOOKING_IN_PROGRESS', 'upcoming', upcoming);
  end if;
  if not found then
    select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
    select * into cust from everwake.customers where id = conv.customer_id;
    insert into everwake.reservations (tenant_id, wa_id, conversation_id, customer_id, full_name, phone)
    values (p_tenant, p_wa, conv.id, cust.id, nullif(cust.full_name, ''),
            case when not coalesce(cust.phone_hidden, false) then everwake.wa_phone(coalesce(cust.phone, case when p_wa ~ '^[0-9]+$' then p_wa end), t.country) end)
    returning * into r;
    -- one branch takes bookings: that is the branch
    if jsonb_array_length((select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'whatsapp')) = 1
       and (select count(*) from jsonb_array_elements(setup -> 'branches')) = 1 then
      update everwake.reservations set branch_id = (setup -> 'branches' -> 0 ->> 'id')::uuid where id = r.id returning * into r;
    end if;
  end if;

  if v_action = 'update' then
    -- branch
    if nullif(btrim(coalesce(v ->> 'branch', '')), '') is not null then
      v_txt := everwake.norm(v ->> 'branch');
      select * into b from everwake.branches x
       where x.tenant_id = p_tenant and x.is_active
         and (everwake.norm(x.code) = v_txt or everwake.norm(x.name_ar) = v_txt or everwake.norm(coalesce(x.name_en, '')) = v_txt
              or v_txt = any (select everwake.norm(a) from unnest(x.aliases) a)
              or (length(v_txt) >= 3 and (everwake.norm(x.name_ar) like '%' || v_txt || '%' or v_txt like '%' || everwake.norm(x.name_ar) || '%')))
       order by (everwake.norm(x.code) = v_txt or everwake.norm(x.name_ar) = v_txt) desc, x.sort
       limit 1;
      if b.id is null then
        problems := problems || jsonb_build_object('problem', 'BRANCH_UNKNOWN', 'said', v ->> 'branch',
          'branches_taking_bookings', (select jsonb_agg(x ->> 'name_ar') from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'whatsapp'));
      elsif b.reservations = 'phone' then
        problems := problems || jsonb_build_object('problem', 'BOOKED_BY_PHONE_ONLY', 'branch', b.name_ar, 'phone', b.phone, 'note', b.reservation_note_ar,
          'fact', 'this branch takes bookings by phone only — give them the number');
      elsif b.reservations = 'off' then
        problems := problems || jsonb_build_object('problem', 'NO_BOOKINGS_AT_THIS_BRANCH', 'branch', b.name_ar,
          'no_seating', b.dine_in is false,          -- delivery and pickup only (012)
          'branches_taking_bookings', (select jsonb_agg(x ->> 'name_ar') from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'whatsapp'));
      elsif r.branch_id is distinct from b.id then
        r.branch_id := b.id; v_changed := true;
      end if;
    end if;
    -- day and time
    if nullif(btrim(coalesce(v ->> 'date', '')), '') is not null then
      begin
        v_d := to_date(btrim(v ->> 'date'), 'YYYY-MM-DD');
        if btrim(v ->> 'date') !~ '^\d{4}-\d{1,2}-\d{1,2}$' then raise exception 'format'; end if;
        if r.reserve_date is distinct from v_d then r.reserve_date := v_d; v_changed := true; end if;
      exception when others then
        problems := problems || jsonb_build_object('problem', 'DATE_FORMAT', 'said', v ->> 'date', 'fact', 'send the date as YYYY-MM-DD, worked out from "Now" in FACTS');
      end;
    end if;
    if nullif(btrim(coalesce(v ->> 'time', '')), '') is not null then
      begin
        v_txt := btrim(v ->> 'time');
        if v_txt ~ '^\d{1,2}$' then v_txt := v_txt || ':00'; end if;
        if v_txt !~ '^\d{1,2}:\d{2}$' then raise exception 'format'; end if;
        v_t := v_txt::time;
        if r.reserve_time is distinct from v_t then r.reserve_time := v_t; v_changed := true; end if;
      exception when others then
        problems := problems || jsonb_build_object('problem', 'TIME_FORMAT', 'said', v ->> 'time', 'fact', 'send the time as HH:MM on the 24-hour clock (9 at night = 21:00)');
      end;
    end if;
    -- guests
    if nullif(btrim(coalesce(v ->> 'guests', '')), '') is not null then
      begin
        v_n := (v ->> 'guests')::numeric::int;
        if v_n < 1 then raise exception 'few'; end if;
        if r.guests is distinct from v_n then r.guests := v_n; v_changed := true; end if;
      exception when others then
        problems := problems || jsonb_build_object('problem', 'GUESTS_FORMAT', 'said', v ->> 'guests', 'fact', 'guests is a whole number');
      end;
    end if;
    -- who
    if v ? 'full_name' and nullif(btrim(v ->> 'full_name'), '') is not null and r.full_name is distinct from btrim(v ->> 'full_name') then
      r.full_name := left(btrim(v ->> 'full_name'), 80); v_changed := true;
    end if;
    if nullif(btrim(coalesce(v ->> 'phone', '')), '') is not null then
      v_txt := everwake.wa_phone(v ->> 'phone', t.country);
      if v_txt is null then
        problems := problems || jsonb_build_object('problem', 'PHONE_FORMAT', 'said', v ->> 'phone', 'fact', 'that does not look like a phone number — ask again');
      elsif r.phone is distinct from v_txt then r.phone := v_txt; v_changed := true;
      end if;
    end if;
    if v ? 'occasion' and r.occasion is distinct from nullif(btrim(v ->> 'occasion'), '') then
      r.occasion := left(nullif(btrim(v ->> 'occasion'), ''), 80); v_changed := true;
    end if;
    if v ? 'requests' and r.requests is distinct from nullif(btrim(v ->> 'requests'), '') then
      r.requests := left(nullif(btrim(v ->> 'requests'), ''), 400); v_changed := true;
    end if;
    if v_changed then
      update everwake.reservations
         set branch_id = r.branch_id, reserve_date = r.reserve_date, reserve_time = r.reserve_time, guests = r.guests,
             full_name = r.full_name, phone = r.phone, occasion = r.occasion, requests = r.requests,
             changed_at = clock_timestamp(), updated_at = now()
       where id = r.id returning * into r;
    end if;
  end if;

  -- ---- does it work as it stands? ---------------------------------------------------
  b := null;
  if r.branch_id is not null then
    select * into b from everwake.branches where id = r.branch_id;
    select x into bset from jsonb_array_elements(setup -> 'branches') x where x ->> 'id' = r.branch_id::text;
    v_max := coalesce((bset ->> 'max_guests')::int, 20);
  end if;
  if r.reserve_date is not null and r.reserve_time is not null then
    v_local := r.reserve_date + r.reserve_time;
    r.reserved_for := v_local at time zone t.timezone;
    update everwake.reservations set reserved_for = r.reserved_for where id = r.id and reserved_for is distinct from r.reserved_for;
    if r.reserved_for < now() + make_interval(mins => (setup ->> 'lead_minutes')::int) then
      problems := problems || jsonb_build_object('problem', 'TOO_SOON',
        'fact', 'bookings are taken at least ' || (setup ->> 'lead_minutes') || ' minutes ahead — suggest a later time, or the branch number for right now',
        'earliest', to_char((now() + make_interval(mins => (setup ->> 'lead_minutes')::int)) at time zone t.timezone, 'YYYY-MM-DD HH24:MI'));
    elsif r.reserved_for > now() + make_interval(days => (setup ->> 'days_ahead')::int) then
      problems := problems || jsonb_build_object('problem', 'TOO_FAR_AHEAD', 'fact', 'bookings are taken up to ' || (setup ->> 'days_ahead') || ' days ahead');
    elsif b.id is not null and everwake.is_open_at(b.hours, v_local) = false then
      problems := problems || jsonb_build_object('problem', 'BRANCH_CLOSED_AT_THAT_TIME', 'branch', b.name_ar, 'hours', b.hours_text_ar,
        'fact', 'the branch is closed at that time — suggest a time within its hours');
    end if;
  end if;
  if r.guests is not null and v_max is not null and r.guests > v_max then
    problems := problems || jsonb_build_object('problem', 'GROUP_TOO_LARGE', 'max_guests', v_max,
      'fact', 'more than ' || v_max || ' guests is arranged by the team — take their details and mark a handoff');
  end if;

  if r.branch_id is null then missing := array_append(missing, 'branch'); end if;
  if r.reserve_date is null then missing := array_append(missing, 'date'); end if;
  if r.reserve_time is null then missing := array_append(missing, 'time'); end if;
  if r.guests is null then missing := array_append(missing, 'guests'); end if;
  if r.full_name is null then missing := array_append(missing, 'full_name'); end if;
  if r.phone is null then missing := array_append(missing, 'phone'); end if;
  v_ready := cardinality(missing) = 0
             and not exists (select 1 from jsonb_array_elements(problems) p
                              where p ->> 'problem' in ('TOO_SOON', 'TOO_FAR_AHEAD', 'BRANCH_CLOSED_AT_THAT_TIME', 'GROUP_TOO_LARGE'));

  if v_action = 'summary' then
    if not v_ready then
      return jsonb_build_object('ok', false, 'error', 'NOT_READY', 'reservation', everwake.reservation_view(r),
                                'missing', to_jsonb(missing), 'problems', problems);
    end if;
    update everwake.reservations set summary_at = clock_timestamp() where id = r.id returning * into r;
    return jsonb_build_object('ok', true, 'status', 'SUMMARY_READY', 'summary_text', everwake.reservation_summary(r, v_lang),
      'fact', 'show this summary as it is and ask them to confirm; send it only after a clear yes');
  end if;

  if v_action = 'submit' then
    if not v_ready then
      return jsonb_build_object('ok', false, 'error', 'NOT_READY', 'reservation', everwake.reservation_view(r),
                                'missing', to_jsonb(missing), 'problems', problems);
    end if;
    if r.summary_at is null or r.summary_at < r.changed_at then
      return jsonb_build_object('ok', false, 'error', 'SUMMARY_NOT_CONFIRMED',
        'fact', 'show the summary first (action summary) and send only after they say yes to it — it changed since, or was never shown');
    end if;
    update everwake.tenants set reservation_seq = reservation_seq + 1 where id = p_tenant returning * into t;
    update everwake.reservations
       set status = 'requested', requested_at = now(), updated_at = now(), ref_no = t.order_no_prefix || '-R' || t.reservation_seq
     where id = r.id returning * into r;
    update everwake.reservations
       set ops_notified = everwake.queue_reservation_ticket(r, everwake.reservation_ticket(r, '🍽 طلب حجز ترابيزة')
                            || E'\n\n' || 'كلّموا العميل وأكّدوا الحجز، وبعدها دوسوا «تأكيد» في صفحة الحجوزات عشان يوصله تأكيد على الواتساب.')
     where id = r.id returning * into r;
    return jsonb_build_object('ok', true, 'status', 'REQUESTED', 'ref_no', r.ref_no, 'reservation', everwake.reservation_view(r),
      'fact', 'sent to the branch team — they will contact the customer to confirm it. It is NOT confirmed yet: say so, warmly, with the reference number.');
  end if;

  -- update / status
  return jsonb_build_object('ok', true, 'status', case when v_changed then 'SAVED' else 'UNCHANGED' end,
    'reservation', everwake.reservation_view(r), 'missing', to_jsonb(missing), 'problems', problems,
    'ready_for_summary', v_ready, 'occasions', setup -> 'occasions', 'upcoming', upcoming);
end $$;

grant execute on function everwake.publish_menu(uuid, jsonb, text, uuid, uuid) to authenticated;
revoke execute on all functions in schema everwake from public, anon;
grant execute on all functions in schema everwake to service_role;

-- every restaurant's snapshot again, so the agent reads the new facts at once
select everwake.rebuild_snapshot(id) from everwake.tenants;
