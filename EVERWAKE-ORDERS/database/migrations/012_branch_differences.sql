-- =====================================================================
-- Everwake Orders · 012 · branches that differ
--
-- The branches of one restaurant rarely sell the same things the same
-- way. Each branch can have:
--   · its own menu — dishes and whole categories on or off, its own dish
--     prices (menu_item_branches, 001), its own choice prices and choices
--     it doesn't have (menu_option_branches), categories only some
--     branches serve (menu_categories.branch_ids)
--   · seating or not (branches.dine_in): no seating → no table bookings
--     and no "dine-in only" dishes there
--   · its own payment methods (branches.payment_methods; empty = the
--     restaurant's, Settings → Ordering)
--
-- The dashboard edits one branch's menu many dishes at a time
-- (branch_menu_update), sets a branch up like another one or back to the
-- restaurant's menu (copy_branch_menu), and imports a menu for one branch
-- (publish_menu with a branch, 006). The agent reads all of it from the
-- branch's snapshot (003).
-- =====================================================================

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
-- "online" only while the restaurant's Paymob account is on and knows the
-- dashboard's address (without it no payment link can be made). No branch
-- given: every method at least one branch takes.
-- ---------------------------------------------------------------------
create or replace function everwake.payment_methods_at(p_tenant uuid, p_branch uuid default null)
returns jsonb language sql stable as $$
  with t as (
    select array(select jsonb_array_elements_text(coalesce(everwake.merged_settings(x.settings) -> 'payment_methods',
                                                           '["cash"]'::jsonb))) as pm,
           exists (select 1 from everwake.payment_accounts a
                    where a.tenant_id = p_tenant and a.enabled and nullif(btrim(a.dashboard_url), '') is not null) as online
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
