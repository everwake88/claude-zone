-- =====================================================================
-- A turn now holds its chat for up to 5 minutes (was 2).
-- The Brain thinks and runs the tools itself; a long turn (several tool
-- rounds) could outlive a 2-minute lock, and a message the customer sent
-- meanwhile could start a second turn at the same time. Run once in the
-- Supabase SQL editor; safe to run again.
-- =====================================================================
create or replace function everwake.claim_window(p_tenant uuid, p_wa text, p_run text, p_buffer bigint)
returns jsonb language plpgsql as $$
declare
  v_mode    text;
  v_enabled boolean;
  v_newest  bigint;
  v_lock    text;
  r         record;
begin
  select c.mode into v_mode from everwake.conversations c where c.tenant_id = p_tenant and c.wa_id = p_wa;
  select t.agent_enabled into v_enabled from everwake.tenants t where t.id = p_tenant;
  if v_mode = 'human' or not v_enabled then
    delete from everwake.inbound_buffer where tenant_id = p_tenant and wa_id = p_wa and claimed_by_run_id is null;
    return jsonb_build_object('is_newest', false, 'lock_acquired', false,
                              'blocked_reason', case when v_mode = 'human' then 'human' else 'paused' end);
  end if;

  select b.id into v_newest
    from everwake.inbound_buffer b
   where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
   order by b.received_at desc, b.id desc
   limit 1;
  if v_newest is distinct from p_buffer then
    return jsonb_build_object('is_newest', false, 'lock_acquired', false);
  end if;

  insert into everwake.conversation_locks as l (tenant_id, wa_id, run_id, locked_at, expires_at)
  values (p_tenant, p_wa, p_run, now(), now() + interval '300 seconds')
  on conflict (tenant_id, wa_id) do update
    set run_id = excluded.run_id, locked_at = now(), expires_at = excluded.expires_at
    where l.expires_at < now()
  returning run_id into v_lock;
  if v_lock is null then
    return jsonb_build_object('is_newest', true, 'lock_acquired', false);
  end if;

  with drained as (
    update everwake.inbound_buffer b
       set claimed_by_run_id = p_run
     where b.tenant_id = p_tenant and b.wa_id = p_wa and b.claimed_by_run_id is null
    returning b.message_text, b.has_location, b.location, b.received_at
  )
  select coalesce(string_agg(nullif(d.message_text, ''), E'\n' order by d.received_at), '') as combined_text,
         coalesce(bool_or(d.has_location), false) as has_location,
         (array_remove(array_agg(d.location order by d.received_at desc), null))[1] as location,
         count(*) as buffered_count
    into r
    from drained d;

  return jsonb_build_object('is_newest', true, 'lock_acquired', true,
                            'combined_text', r.combined_text, 'has_location', r.has_location,
                            'location', r.location, 'buffered_count', r.buffered_count);
end $$;
