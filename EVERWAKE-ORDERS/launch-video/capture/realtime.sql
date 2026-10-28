-- FOR FILMING ONLY: tells local-supabase.mjs about changes to the tables the
-- dashboard watches (on Supabase, Realtime does this from the publication).
create or replace function public.everwake_rt() returns trigger language plpgsql as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  body text;
begin
  body := jsonb_build_object('schema', tg_table_schema, 'table', tg_table_name, 'type', tg_op, 'record', rec, 'old', old)::text;
  if octet_length(body) > 7800 then   -- NOTIFY's limit: send the plain columns only
    rec := (select jsonb_object_agg(key, value) from jsonb_each(rec) where jsonb_typeof(value) not in ('object', 'array'));
    old := (select jsonb_object_agg(key, value) from jsonb_each(old) where jsonb_typeof(value) not in ('object', 'array'));
    body := jsonb_build_object('schema', tg_table_schema, 'table', tg_table_name, 'type', tg_op, 'record', rec, 'old', old)::text;
  end if;
  begin
    perform pg_notify('everwake_rt', body);
  exception when others then null;
  end;
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['orders', 'conversations', 'messages', 'tenants', 'reservations', 'team_questions'] loop
    execute format('drop trigger if exists zz_everwake_rt on everwake.%I', t);
    execute format('create trigger zz_everwake_rt after insert or update or delete on everwake.%I for each row execute function public.everwake_rt()', t);
  end loop;
end $$;
