-- =====================================================================
-- Reset ONE real WhatsApp number at ONE restaurant, so the agent meets it
-- as a brand-new customer (for testing from your own phone).
--
-- Edit the two lines below, then run it in the Supabase SQL editor.
-- It deletes that number's chat, orders, bookings and customer record at
-- that restaurant only. Run it again any time you want a fresh start.
-- =====================================================================
do $$
declare
  v_slug  text := 'seagull';        -- the restaurant's slug
  v_phone text := '201XXXXXXXXX';   -- your WhatsApp number: 20 then the number without the 0 (01012345678 → 201012345678)
  t_id    uuid;
  v_cust  bigint[];
begin
  if v_phone !~ '^20[0-9]{10}$' then
    raise exception 'Write the number as 20 then 10 digits, e.g. 201012345678 (got %)', v_phone;
  end if;
  select id into t_id from everwake.tenants where slug = v_slug;
  if t_id is null then raise exception 'No restaurant with slug %', v_slug; end if;

  select coalesce(array_agg(id), '{}') into v_cust from everwake.customers where tenant_id = t_id and wa_id = v_phone;

  delete from everwake.orders             where tenant_id = t_id and (wa_id = v_phone or customer_id = any (v_cust));
  delete from everwake.reservations       where tenant_id = t_id and (wa_id = v_phone or customer_id = any (v_cust));
  delete from everwake.outbox             where tenant_id = t_id and wa_id = v_phone;
  delete from everwake.messages           where tenant_id = t_id and wa_id = v_phone;
  delete from everwake.conversations      where tenant_id = t_id and wa_id = v_phone;
  delete from everwake.inbound_buffer     where tenant_id = t_id and wa_id = v_phone;
  delete from everwake.conversation_locks where tenant_id = t_id and wa_id = v_phone;
  delete from everwake.pause_contacts     where tenant_id = t_id and wa_id = v_phone;
  delete from everwake.agent_events       where tenant_id = t_id and wa_id = v_phone;
  delete from everwake.customers          where id = any (v_cust);

  raise notice 'Done: % starts fresh at %', v_phone, v_slug;
end $$;
