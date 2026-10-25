-- =====================================================================
-- Remove ONE customer from ONE restaurant completely — also a customer
-- whose number WhatsApp hides (a private id instead of a phone number).
--
-- Find them by name and/or by a number (the one they typed, or their
-- WhatsApp number). Run it first with v_delete := false: it only LISTS
-- who matches. When the list is right, set v_delete := true and run again.
-- It deletes their chat, orders (and payments), bookings, pending
-- messages and the customer record, at that restaurant only.
-- =====================================================================
do $$
declare
  v_slug   text    := 'seagull';      -- the restaurant's slug
  v_name   text    := '';             -- their name as the dashboard shows it ('' = don't match by name)
  v_phone  text    := '';             -- a number: 01012345678 or 201012345678 ('' = don't match by number)
  v_delete boolean := false;          -- false = only list who matches; true = delete them
  t_id     uuid;
  v_ph     text;
  v_cust   bigint[];
  v_wa     text[];
  r        record;
begin
  select id into t_id from everwake.tenants where slug = v_slug;
  if t_id is null then raise exception 'No restaurant with slug %', v_slug; end if;
  if trim(v_name) = '' and trim(v_phone) = '' then raise exception 'Give a name or a number'; end if;
  v_ph := regexp_replace(v_phone, '\D', '', 'g');
  if v_ph ~ '^01\d{9}$' then v_ph := '2' || v_ph; end if;          -- 01… → 201…

  select coalesce(array_agg(c.id), '{}'), coalesce(array_agg(c.wa_id), '{}')
    into v_cust, v_wa
    from everwake.customers c
   where c.tenant_id = t_id
     and ((trim(v_name) <> '' and (c.full_name = trim(v_name) or c.display_name = trim(v_name)))
       or (v_ph <> '' and (c.wa_id = v_ph or c.phone = v_ph or c.alt_phone = v_ph
                           or exists (select 1 from everwake.customer_identities i
                                       where i.customer_id = c.id and regexp_replace(i.value, '\D', '', 'g') = v_ph))));
  -- a chat that never became a customer record (or a name only on the chat)
  select coalesce(array_agg(distinct x), '{}') into v_wa
    from (select unnest(v_wa) as x
          union select o.wa_id from everwake.orders o where o.tenant_id = t_id and v_ph <> '' and o.wa_id = v_ph) s;

  if coalesce(array_length(v_cust, 1), 0) = 0 and coalesce(array_length(v_wa, 1), 0) = 0 then
    raise notice 'Nobody matches at %', v_slug; return;
  end if;
  for r in select c.id, c.wa_id, c.full_name, c.display_name, c.phone, c.lid, c.orders_count
             from everwake.customers c where c.id = any (v_cust) loop
    raise notice 'match: customer % · chat % · name "%" / WhatsApp name "%" · phone % · lid % · % orders',
      r.id, r.wa_id, r.full_name, r.display_name, r.phone, r.lid, r.orders_count;
  end loop;
  if not v_delete then
    raise notice 'Nothing deleted. If this is the right customer, set v_delete := true and run again.';
    return;
  end if;

  delete from everwake.orders             where tenant_id = t_id and (wa_id = any (v_wa) or customer_id = any (v_cust));
  delete from everwake.reservations       where tenant_id = t_id and (wa_id = any (v_wa) or customer_id = any (v_cust));
  delete from everwake.outbox             where tenant_id = t_id and wa_id = any (v_wa);
  delete from everwake.messages           where tenant_id = t_id and wa_id = any (v_wa);
  delete from everwake.conversations      where tenant_id = t_id and (wa_id = any (v_wa) or customer_id = any (v_cust));
  delete from everwake.inbound_buffer     where tenant_id = t_id and wa_id = any (v_wa);
  delete from everwake.conversation_locks where tenant_id = t_id and wa_id = any (v_wa);
  delete from everwake.pause_contacts     where tenant_id = t_id and (wa_id = any (v_wa) or customer_id = any (v_cust));
  delete from everwake.agent_events       where tenant_id = t_id and wa_id = any (v_wa);
  delete from everwake.customers          where id = any (v_cust);   -- their addresses and ids go with them

  raise notice 'Done: % customer(s) and their chats removed from %', coalesce(array_length(v_cust, 1), 0), v_slug;
end $$;
