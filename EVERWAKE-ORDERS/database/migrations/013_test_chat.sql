-- =====================================================================
-- Everwake Orders · 013 · the test chat
--
-- The n8n "Everwake — Test Runner" workflow chats with a restaurant's
-- agent from a pretend WhatsApp number (200000000001…99, never a real
-- one). It runs the real Main workflow, so it tests exactly what
-- customers get, but nothing goes out on WhatsApp: Main records the
-- replies without sending them, and no ticket goes to the kitchen.
-- It reaches the agent while the restaurant is still onboarding too
-- (intake, 004).
--
--   test_chat_prepare  finds the restaurant and its WhatsApp channel;
--                      "/reset" forgets the test chat (as if it never
--                      wrote), "/later N" moves it N hours into the past
--   test_chat_result   what the agent did with the last message: its
--                      reply, its plan, each tool call and its answer,
--                      what the checks caught
--
-- Only the database owner (n8n's connection) can run them.
-- =====================================================================

create or replace function everwake.is_test_number(p_wa text)
returns boolean language sql immutable as $$
  select coalesce(p_wa ~ '^20000000000[0-9]$|^2000000000[1-9][0-9]$', false)
$$;

create or replace function everwake.test_chat_prepare(p_restaurant text, p_wa text, p_reset boolean default false,
                                                      p_later_hours numeric default 0)
returns jsonb language plpgsql as $$
declare
  t      everwake.tenants%rowtype;
  ch     everwake.whatsapp_channels%rowtype;
  v_cust bigint[];
  v_back interval := make_interval(secs => greatest(coalesce(p_later_hours, 0), 0) * 3600);
  n      int;
begin
  if not everwake.is_test_number(p_wa) then
    raise exception 'The test chat only uses the pretend numbers 200000000001 to 200000000099, not %', p_wa;
  end if;

  select count(*) into n from everwake.tenants
   where slug = lower(btrim(p_restaurant)) or slug ilike btrim(p_restaurant) || '%'
      or name_en ilike btrim(p_restaurant) || '%' or name_ar = btrim(p_restaurant);
  if n <> 1 then
    raise exception '% restaurants match "%" — use the restaurant''s exact slug', n, p_restaurant;
  end if;
  select * into t from everwake.tenants
   where slug = lower(btrim(p_restaurant)) or slug ilike btrim(p_restaurant) || '%'
      or name_en ilike btrim(p_restaurant) || '%' or name_ar = btrim(p_restaurant);

  select * into ch from everwake.whatsapp_channels
   where tenant_id = t.id and provider = 'evolution' and is_active and instance_name is not null
   order by created_at limit 1;
  if ch.id is null then
    raise exception '% has no WhatsApp number connected yet (Settings → WhatsApp)', t.name_ar;
  end if;

  select coalesce(array_agg(id), '{}') into v_cust from everwake.customers where tenant_id = t.id and wa_id = p_wa;

  if p_reset then
    delete from everwake.orders             where tenant_id = t.id and (wa_id = p_wa or customer_id = any (v_cust));
    delete from everwake.reservations       where tenant_id = t.id and (wa_id = p_wa or customer_id = any (v_cust));
    delete from everwake.outbox             where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.messages           where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.conversations      where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.inbound_buffer     where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.conversation_locks where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.pause_contacts     where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.agent_events       where tenant_id = t.id and wa_id = p_wa;
    delete from everwake.customers          where id = any (v_cust);
  elsif v_back > interval '0' then
    update everwake.messages set created_at = created_at - v_back, sent_at = sent_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update everwake.conversations
       set last_message_at = last_message_at - v_back, last_inbound_at = last_inbound_at - v_back,
           last_outbound_at = last_outbound_at - v_back, updated_at = updated_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update everwake.customers set last_seen_at = last_seen_at - v_back, last_order_at = last_order_at - v_back
     where id = any (v_cust);
    update everwake.orders set created_at = created_at - v_back, placed_at = placed_at - v_back
     where tenant_id = t.id and wa_id = p_wa;
    update everwake.agent_events set created_at = created_at - v_back where tenant_id = t.id and wa_id = p_wa;
  end if;

  return jsonb_build_object(
    'tenant_id', t.id, 'restaurant', t.name_ar, 'slug', t.slug, 'status', t.status,
    'instance', ch.instance_name, 'token', ch.webhook_token, 'wa_id', p_wa,
    'reset', coalesce(p_reset, false), 'later_hours', greatest(coalesce(p_later_hours, 0), 0),
    'since', now(),
    'last_message_at', (select max(created_at) from everwake.messages
                         where tenant_id = t.id and wa_id = p_wa and direction = 'inbound'));
end $$;

create or replace function everwake.test_chat_result(p_tenant uuid, p_wa text, p_since timestamptz)
returns jsonb language plpgsql stable as $$
declare
  conv everwake.conversations%rowtype;
  ev   everwake.agent_events%rowtype;
begin
  if not everwake.is_test_number(p_wa) then
    raise exception 'not a test chat: %', p_wa;
  end if;
  select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
  select * into ev from everwake.agent_events
   where tenant_id = p_tenant and wa_id = p_wa and created_at >= p_since and stage = 'turn_complete'
   order by id desc limit 1;

  return jsonb_build_object(
    'customer', (select string_agg(body, E'\n' order by id) from everwake.messages
                  where tenant_id = p_tenant and wa_id = p_wa and direction = 'inbound' and created_at >= p_since),
    'replies', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'text', body, 'sender', sender) order by id)
                           from everwake.messages
                          where tenant_id = p_tenant and wa_id = p_wa and direction = 'outbound' and created_at >= p_since), '[]'),
    'turn', case when ev.id is null then null else jsonb_build_object(
              'stage', ev.order_stage, 'seconds', round(ev.duration_total_ms / 1000.0, 1),
              'tokens', coalesce(ev.prompt_tokens, 0) + coalesce(ev.completion_tokens, 0),
              'plan', ev.output -> 'brain', 'tools', ev.output -> 'tools_used', 'tool_problems', ev.output -> 'tool_problems',
              'caught', ev.output -> 'violations', 'rewritten', ev.repair_used,
              'calls', ev.output -> 'tool_calls', 'agent_error', ev.output ->> 'agent_error',
              'order_placed', ev.output ->> 'order_placed_no', 'handoff', ev.output -> 'handoff',
              'ask_team', ev.output -> 'ask_team') end,
    'mode', conv.mode,
    'details', conv.state -> 'customer',
    'branch', (select name_ar from everwake.branches b where b.id::text = conv.state -> 'branch' ->> 'id'),
    'cart', (select jsonb_agg(concat_ws(' ', i ->> 'quantity', coalesce(i ->> 'display_name', i ->> 'item_name'),
                                        nullif(i ->> 'line_total', '') || 'ج'))
               from everwake.orders o, jsonb_array_elements(coalesce(o.cart -> 'items', '[]')) i
              where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'),
    'orders', (select jsonb_agg(order_no || ' ' || status || ' ' || total || 'ج' order by id)
                 from everwake.orders where tenant_id = p_tenant and wa_id = p_wa and status <> 'draft'));
end $$;

revoke execute on function everwake.is_test_number(text),
  everwake.test_chat_prepare(text, text, boolean, numeric),
  everwake.test_chat_result(uuid, text, timestamptz) from public, anon, authenticated;
