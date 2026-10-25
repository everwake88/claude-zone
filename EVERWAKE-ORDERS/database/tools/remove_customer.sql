-- =====================================================================
-- Remove ONE customer from ONE restaurant completely — also a customer
-- whose number WhatsApp hides (a private id instead of a phone number).
--
-- Find them by name and/or a number (the one they typed, or their
-- WhatsApp number — 01…, 201… or +20… all match). Edit the lines below,
-- run it in the Supabase SQL editor, and read the table it returns:
--   v_delete = false → the table lists who matches, nothing is deleted
--   v_delete = true  → the table lists who was removed
-- It removes their chat, orders (and payments), bookings, pending
-- messages and the customer record, at that restaurant only.
-- =====================================================================
create temp table if not exists _remove_customer_result (customer_id bigint, chat text, name text, whatsapp_name text,
                                                         phone text, orders int, what_happened text);
truncate _remove_customer_result;

do $$
declare
  v_slug   text    := 'seagull';      -- the restaurant's slug
  v_name   text    := '';             -- their name as the dashboard shows it ('' = don't match by name)
  v_phone  text    := '';             -- a number they used ('' = don't match by number)
  v_delete boolean := false;          -- false = only list who matches; true = remove them
  t_id     uuid;
  v_ten    text;
  v_cust   bigint[];
  v_wa     text[];
begin
  select id into t_id from everwake.tenants where slug = v_slug;
  if t_id is null then raise exception 'No restaurant with slug %', v_slug; end if;
  if trim(v_name) = '' and trim(v_phone) = '' then raise exception 'Give a name or a number'; end if;
  -- the last 10 digits are the number, however it was written (01…, 201…, +20…)
  v_ten := right(regexp_replace(v_phone, '\D', '', 'g'), 10);
  if length(v_ten) < 10 then v_ten := ''; end if;

  -- customers by name (the profile, the name on the order, or the chat) or by any number they used
  select coalesce(array_agg(distinct c.id), '{}') into v_cust
    from everwake.customers c
   where c.tenant_id = t_id
     and ((trim(v_name) <> '' and (trim(c.full_name) = trim(v_name) or trim(c.display_name) = trim(v_name)
            or exists (select 1 from everwake.conversations cv where cv.tenant_id = t_id and cv.wa_id = c.wa_id
                        and trim(cv.state -> 'customer' ->> 'full_name') = trim(v_name))))
       or (v_ten <> '' and (right(regexp_replace(coalesce(c.wa_id, ''), '\D', '', 'g'), 10) = v_ten
            or right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = v_ten
            or right(regexp_replace(coalesce(c.alt_phone, ''), '\D', '', 'g'), 10) = v_ten
            or exists (select 1 from everwake.customer_identities i
                        where i.customer_id = c.id and right(regexp_replace(i.value, '\D', '', 'g'), 10) = v_ten)
            or exists (select 1 from everwake.conversations cv where cv.tenant_id = t_id and cv.wa_id = c.wa_id
                        and right(regexp_replace(coalesce(cv.state -> 'customer' ->> 'phone', ''), '\D', '', 'g'), 10) = v_ten))));

  -- their chats: the customers' own, and any chat whose name or number on file matches
  select coalesce(array_agg(distinct x), '{}') into v_wa from (
    select c.wa_id as x from everwake.customers c where c.id = any (v_cust)
    union select cv.wa_id from everwake.conversations cv where cv.tenant_id = t_id
       and (cv.customer_id = any (v_cust)
            or (trim(v_name) <> '' and trim(cv.state -> 'customer' ->> 'full_name') = trim(v_name))
            or (v_ten <> '' and right(regexp_replace(coalesce(cv.state -> 'customer' ->> 'phone', ''), '\D', '', 'g'), 10) = v_ten))
  ) s;

  insert into _remove_customer_result
  select c.id, c.wa_id, c.full_name, c.display_name, c.phone, c.orders_count,
         case when v_delete then 'REMOVED' else 'matches — set v_delete := true to remove' end
    from everwake.customers c where c.id = any (v_cust);
  insert into _remove_customer_result
  select null, w, null, null, null, null, case when v_delete then 'REMOVED (chat)' else 'chat matches' end
    from unnest(v_wa) w where not exists (select 1 from everwake.customers c where c.id = any (v_cust) and c.wa_id = w);
  if not exists (select 1 from _remove_customer_result) then
    insert into _remove_customer_result (what_happened) values ('nobody matches at ' || v_slug);
  end if;
  if not v_delete then return; end if;

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
end $$;

select * from _remove_customer_result;
