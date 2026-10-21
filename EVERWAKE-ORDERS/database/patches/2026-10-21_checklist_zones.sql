-- Everwake Orders · patch 2026-10-21
-- The go-live checklist ticked "Delivery zones" for a restaurant with no
-- branches yet. Now it ticks only once there is a branch, and every
-- delivering branch has a zone. Already in 006_dashboard.sql for new installs.
-- Run once in Supabase → SQL Editor on an existing database.

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
