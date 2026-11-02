-- =====================================================================
-- Everwake Clinic · 090 · Supabase only
-- Run on Supabase after the others. Skip on a plain Postgres.
--
--   clinic-media      (public)  <tenant_id>/…  logos, pictures staff send in a chat
--   clinic-documents  (private) <tenant_id>/…  lab reports, X-rays, photos patients send
--   clinic-imports    (private) <tenant_id>/…  price lists uploaded for the AI to read
--   clinic-recordings (private) <tenant_id>/…  visit recordings (stage 2), clinical members only
-- WhatsApp fetches media by URL, so only clinic-media is public; nothing private goes there.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit) values ('clinic-media', 'clinic-media', true, 15728640)
on conflict (id) do update set public = true;
insert into storage.buckets (id, name, public, file_size_limit) values ('clinic-documents', 'clinic-documents', false, 31457280)
on conflict (id) do nothing;
insert into storage.buckets (id, name, public, file_size_limit) values ('clinic-imports', 'clinic-imports', false, 31457280)
on conflict (id) do nothing;
insert into storage.buckets (id, name, public, file_size_limit) values ('clinic-recordings', 'clinic-recordings', false, 104857600)
on conflict (id) do nothing;

drop policy if exists "clinic media write" on storage.objects;
create policy "clinic media write" on storage.objects for insert to authenticated
  with check (bucket_id = 'clinic-media' and (storage.foldername(name))[1] in (select unnest(clinic.my_tenant_ids())::text));
drop policy if exists "clinic media change" on storage.objects;
create policy "clinic media change" on storage.objects for update to authenticated
  using (bucket_id = 'clinic-media' and (storage.foldername(name))[1] in (select unnest(clinic.my_editor_tenant_ids())::text));
drop policy if exists "clinic media delete" on storage.objects;
create policy "clinic media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'clinic-media' and (storage.foldername(name))[1] in (select unnest(clinic.my_editor_tenant_ids())::text));

drop policy if exists "clinic documents" on storage.objects;
create policy "clinic documents" on storage.objects for all to authenticated
  using (bucket_id = 'clinic-documents' and (storage.foldername(name))[1] in (select unnest(clinic.my_clinical_tenant_ids())::text))
  with check (bucket_id = 'clinic-documents' and (storage.foldername(name))[1] in (select unnest(clinic.my_clinical_tenant_ids())::text));
drop policy if exists "clinic recordings" on storage.objects;
create policy "clinic recordings" on storage.objects for all to authenticated
  using (bucket_id = 'clinic-recordings' and (storage.foldername(name))[1] in (select unnest(clinic.my_clinical_tenant_ids())::text))
  with check (bucket_id = 'clinic-recordings' and (storage.foldername(name))[1] in (select unnest(clinic.my_clinical_tenant_ids())::text));
drop policy if exists "clinic imports" on storage.objects;
create policy "clinic imports" on storage.objects for all to authenticated
  using (bucket_id = 'clinic-imports' and (storage.foldername(name))[1] in (select unnest(clinic.my_editor_tenant_ids())::text))
  with check (bucket_id = 'clinic-imports' and (storage.foldername(name))[1] in (select unnest(clinic.my_editor_tenant_ids())::text));

-- the live dashboard: new bookings, alerts, chats, delay replies
do $$
declare t text;
begin
  foreach t in array array['appointments', 'alerts', 'conversations', 'messages', 'tenants', 'team_questions',
                           'delay_notice_items', 'waitlist'] loop
    begin
      execute format('alter publication supabase_realtime add table clinic.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- the dashboard reads the `clinic` schema through the API: add it under
-- Project Settings → API → Exposed schemas (see docs/SETUP.md)
grant usage on schema clinic to anon;
