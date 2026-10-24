-- =====================================================================
-- Everwake Orders · patch 2026-10-24 · a delivery zone decides the branch
--
-- When a typed area (or a saved address) settles the delivery zone and no
-- branch is chosen yet, the zone's branch becomes the conversation's branch,
-- so the next turn shows that branch's own menu and prices instead of the
-- all-branches ranges. A pickup still chooses its branch itself.
-- Safe to run more than once.
-- =====================================================================
create or replace function everwake.persist_details(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_tenant uuid := (p ->> 'tenant_id')::uuid;
  v_wa     text := p ->> 'wa_id';
  v_phone  text := nullif(everwake.digits(p ->> 'link_phone'), '');
  v_cust   bigint;
  v_other  bigint;
  v_area   jsonb;
  v_patch  jsonb := coalesce(p -> 'state_patch', '{}'::jsonb);
  v_zone   jsonb;
  st       jsonb;
begin
  select customer_id, state into v_cust, st from everwake.conversations where tenant_id = v_tenant and wa_id = v_wa for update;

  -- a typed area: which delivery zone is that? (a pin, when shared, wins)
  if nullif(p ->> 'area_text', '') is not null
     and (coalesce((p ->> 'address_reset')::boolean, false) or coalesce(st -> 'zone' ->> 'source', '') <> 'pin') then
    v_area := everwake.match_area(v_tenant, p ->> 'area_text');
    if jsonb_array_length(v_area -> 'matches') > 0 and (v_area ->> 'branches')::int = 1 then
      v_zone := (v_area -> 'matches' -> 0);
      v_patch := v_patch || jsonb_build_object('zone', jsonb_build_object(
        'id', v_zone ->> 'zone_id', 'name', v_zone ->> 'zone_name', 'branch_id', v_zone ->> 'branch_id',
        'branch_code', v_zone ->> 'branch_code', 'branch_name', v_zone ->> 'branch_name',
        'delivery_fee', v_zone -> 'delivery_fee', 'min_order', v_zone -> 'min_order',
        'eta_min', v_zone -> 'eta_min', 'eta_max', v_zone -> 'eta_max', 'branch_state', v_zone ->> 'branch_state',
        'source', 'area_name', 'matched', v_zone ->> 'matched', 'at', now()));
    elsif coalesce((p ->> 'address_reset')::boolean, false) then
      v_patch := v_patch || jsonb_build_object('zone', null);
    end if;
  end if;

  -- a saved address chosen again: its zone comes with it
  if nullif(p ->> 'zone_id', '') is not null then
    select jsonb_build_object('id', z.id, 'name', z.name_ar, 'branch_id', b.id, 'branch_code', b.code, 'branch_name', b.name_ar,
                              'delivery_fee', coalesce(z.delivery_fee, b.delivery_fee), 'min_order', coalesce(z.min_order, b.min_order),
                              'eta_min', z.eta_min, 'eta_max', z.eta_max, 'branch_state', everwake.branch_state(b.id),
                              'source', 'saved_address', 'at', now())
      into v_zone
      from everwake.delivery_zones z join everwake.branches b on b.id = z.branch_id
     where z.id = (p ->> 'zone_id')::uuid and z.tenant_id = v_tenant and z.is_active and b.is_active;
    if v_zone is not null then
      v_patch := v_patch || jsonb_build_object('zone', v_zone);
    end if;
  end if;

  -- the zone of a delivery decides its branch: with none chosen yet, that is the branch now, so
  -- the next turn already shows its own menu and prices (a pickup chooses its branch itself)
  if v_zone is not null and nullif(st -> 'branch' ->> 'id', '') is null
     and coalesce(v_patch -> 'customer' ->> 'delivery_method', st -> 'customer' ->> 'delivery_method', '') <> 'pickup' then
    v_patch := v_patch || jsonb_build_object('branch', jsonb_build_object(
      'id', v_zone ->> 'branch_id', 'code', v_zone ->> 'branch_code', 'name_ar', v_zone ->> 'branch_name',
      'source', 'delivery_zone', 'set_at', now()));
  end if;

  -- a number typed for the order: remember it as theirs (so a customer
  -- hidden behind a WhatsApp private id is found by it next time)
  if v_phone is not null and v_cust is not null then
    select customer_id into v_other from everwake.customer_identities
     where tenant_id = v_tenant and kind = 'phone' and value = v_phone;
    if v_other is null then
      insert into everwake.customer_identities (tenant_id, kind, value, customer_id)
      values (v_tenant, 'phone', v_phone, v_cust) on conflict do nothing;
    elsif v_other <> v_cust then
      v_patch := v_patch || jsonb_build_object('contact', coalesce(st -> 'contact', '{}'::jsonb)
                                                || jsonb_build_object('linked_customer_id', v_other));
    end if;
  end if;

  update everwake.conversations c
     set state = coalesce(c.state, '{}'::jsonb)
                 || (v_patch - 'ledger')
                 || jsonb_build_object('ledger', coalesce(c.state -> 'ledger', '{}'::jsonb) || coalesce(p -> 'ledger_patch', '{}'::jsonb))
   where c.tenant_id = v_tenant and c.wa_id = v_wa
  returning c.state into st;

  return jsonb_build_object('state', st, 'area_match', v_area);
end $$;
