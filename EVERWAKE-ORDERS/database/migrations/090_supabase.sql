-- =====================================================================
-- Everwake Orders · 090 · Supabase only
-- Run on Supabase after 001–007. Skip on a plain Postgres.
--
--   media   (public)  <tenant_id>/items/…   dish photos the agent sends
--                     <tenant_id>/menus/…   full menu pages / PDF
--                     <tenant_id>/chat/…    pictures staff send in a chat
--   imports (private) <tenant_id>/…         menus uploaded for the AI to read
-- WhatsApp fetches media by URL, so the media bucket is public; nothing
-- private ever goes in it.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', true, 15728640)
on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public, file_size_limit)
values ('imports', 'imports', false, 31457280)
on conflict (id) do nothing;

grant execute on function everwake.my_tenant_ids(), everwake.my_editor_tenant_ids() to authenticated;

drop policy if exists "everwake media write" on storage.objects;
create policy "everwake media write" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (
    (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text)
    or ((storage.foldername(name))[2] = 'chat'
        and (storage.foldername(name))[1] in (select unnest(everwake.my_tenant_ids())::text))));

drop policy if exists "everwake media change" on storage.objects;
create policy "everwake media change" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text));

drop policy if exists "everwake media delete" on storage.objects;
create policy "everwake media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text));

drop policy if exists "everwake imports" on storage.objects;
create policy "everwake imports" on storage.objects for all to authenticated
  using (bucket_id = 'imports' and (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text))
  with check (bucket_id = 'imports' and (storage.foldername(name))[1] in (select unnest(everwake.my_editor_tenant_ids())::text));

-- live dashboard: new orders ring, new messages appear, the switch updates, booking requests ring
do $$
declare t text;
begin
  foreach t in array array['orders', 'conversations', 'messages', 'tenants', 'reservations'] loop
    begin
      execute format('alter publication supabase_realtime add table everwake.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
