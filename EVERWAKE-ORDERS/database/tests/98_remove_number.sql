-- Removing a WhatsApp number: owners and managers only; chats and messages stay;
-- a reply still waiting to be sent goes out from the restaurant's other number.

reset role;
select set_config('request.jwt.claims', '', false);
insert into everwake.tenant_members (tenant_id, user_id, role, email, display_name)
select id, '11111111-1111-1111-1111-111111111111', 'owner', 'owner@nile.example', 'Owner' from everwake.tenants where slug = 'nile_grill'
on conflict do nothing;
insert into everwake.tenant_members (tenant_id, user_id, role, email, display_name)
select id, '33333333-3333-3333-3333-333333333333', 'staff', 'cashier@nile.example', 'Cashier' from everwake.tenants where slug = 'nile_grill'
on conflict do nothing;

-- a second number, with a reply waiting on it
do $$
declare t uuid := (select id from everwake.tenants where slug = 'nile_grill'); v uuid;
begin
  insert into everwake.whatsapp_channels (tenant_id, provider, label, phone_number, instance_name, base_url, api_key, status)
  values (t, 'evolution', 'Old line', '201000000098', 'nilegrill_old', 'https://evo.example.com', 'k', 'connected') returning id into v;
  insert into everwake.outbox (tenant_id, channel_id, to_jid, wa_id, purpose, kind, body)
  values (t, v, '201777000001', '201777000001', 'staff_reply', 'text', 'waiting on the old line');
end $$;

set role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"cashier@nile.example"}', false);
do $$
begin
  begin
    perform everwake.remove_channel((select id from everwake.whatsapp_channels where instance_name = 'nilegrill_old'));
    assert false, 'staff cannot remove a number';
  exception when others then
    assert sqlerrm not like 'assertion%', sqlerrm;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"owner@nile.example"}', false);
do $$
declare r jsonb; main uuid := (select id from everwake.whatsapp_channels where instance_name = 'nilegrill');
begin
  r := everwake.remove_channel((select id from everwake.whatsapp_channels where instance_name = 'nilegrill_old'));
  assert (r ->> 'other_number')::boolean and (r ->> 'queued_moved')::int = 1, r::text;
  assert not exists (select 1 from everwake.whatsapp_channels where instance_name = 'nilegrill_old');
  assert (select channel_id from everwake.outbox where body = 'waiting on the old line') = main, 'the reply goes out from the main number';
end $$;

reset role;
select set_config('request.jwt.claims', '', false);
do $$
begin
  assert exists (select 1 from everwake.audit_log where entity = 'whatsapp_channels' and action = 'delete'
                  and not (detail ? 'api_key')), 'the removal is in the audit trail, without the key';
  delete from everwake.outbox where body = 'waiting on the old line';
end $$;
