-- Everwake Orders · patch 2026-10-21
-- The agent now sends up to 10 menu pictures (was 6) when a customer asks
-- for the menu, so a long menu drawn by "Design menu pictures" goes out whole.
-- Already in 004_engine.sql for new installs.
-- Run once in Supabase → SQL Editor on an existing database.

create or replace function everwake.reply_media(p jsonb)
returns jsonb language sql stable as $$
  with pages as (
    select m.kind, m.url, m.mime, m.file_name, m.caption, m.position
      from everwake.menu_media m
     where m.tenant_id = (p ->> 'tenant_id')::uuid and m.is_active
       and coalesce((p ->> 'send_menu')::boolean, false)
       and (m.branch_id::text = p ->> 'branch_id'
            or (m.branch_id is null and not exists (
                  select 1 from everwake.menu_media x
                   where x.tenant_id = m.tenant_id and x.is_active and x.branch_id::text = p ->> 'branch_id')))
     order by m.position
     limit 10
  ), photos as (
    select distinct on (i.code) i.code, i.name_ar, im.url, im.mime, coalesce(mib.price, i.price) as price, i.unit, x.ord
      from jsonb_array_elements_text(coalesce(p -> 'item_codes', '[]'::jsonb)) with ordinality x(code, ord)
      join everwake.menu_items i on i.tenant_id = (p ->> 'tenant_id')::uuid and i.code = upper(x.code) and i.is_active
      join everwake.item_media im on im.item_id = i.id
      left join everwake.menu_item_branches mib on mib.item_id = i.id and mib.branch_id::text = p ->> 'branch_id'
     order by i.code, im.is_primary desc, im.sort
  )
  select jsonb_build_object(
    'menu_pages', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'url', url, 'mime', mime,
                                                                'file_name', file_name, 'caption', caption) order by position) from pages), '[]'::jsonb),
    'item_photos', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name_ar, 'url', url, 'mime', mime,
                                                                 'price', price, 'unit', unit) order by ord) from (select * from photos limit 3) ph), '[]'::jsonb))
$$;
