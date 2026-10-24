-- Everwake Orders · patch 2026-10-24 · removing a WhatsApp number
-- Settings → WhatsApp number → Remove: owners and managers. Chats, orders and
-- messages stay; replies still waiting go out from the restaurant's other number.
-- Already in the migrations for new installs. Run once in Supabase → SQL Editor.

-- remove a WhatsApp number. Chats, orders and messages stay (they only lose the
-- link to it); replies still waiting to be sent go out from the restaurant's
-- other number, if it has one. Messages arriving later for its instance are ignored.
create or replace function everwake.remove_channel(p_channel uuid)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  c       everwake.whatsapp_channels%rowtype;
  v_other uuid;
  n       int := 0;
begin
  select * into c from everwake.whatsapp_channels where id = p_channel;
  if not found then raise exception 'number not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager']);
  select id into v_other from everwake.whatsapp_channels
   where tenant_id = c.tenant_id and id <> c.id and is_active
   order by created_at limit 1;
  if v_other is not null then
    update everwake.outbox set channel_id = v_other where channel_id = c.id and status = 'queued';
    get diagnostics n = row_count;
  end if;
  delete from everwake.whatsapp_channels where id = c.id;
  return jsonb_build_object('removed', c.id, 'instance_name', c.instance_name,
                            'other_number', v_other is not null, 'queued_moved', n);
end $$;

grant execute on function everwake.remove_channel(uuid) to authenticated;
