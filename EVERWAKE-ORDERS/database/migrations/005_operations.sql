-- =====================================================================
-- Everwake Orders · 005 · operations
--
-- What the restaurant does from the dashboard, and what the system
-- sends on its behalf:
--   · the agent ON / OFF switch, and the "we're back" message to everyone
--     who wrote while it was off
--   · taking over a conversation, replying, handing it back
--   · moving an order along the board (the customer hears each step)
--   · out-of-stock and busy switches
--   · the outbox every one of those messages goes through
--   · housekeeping (idle takeovers, stuck locks, expired snapshots)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Who may do what. Dashboard users carry a JWT with their user id; the
-- n8n engine and maintenance scripts connect as a database role with no
-- user and are trusted (anon never gets EXECUTE — see 007).
-- ---------------------------------------------------------------------
create or replace function everwake.member_role(p_tenant uuid)
returns text language sql stable security definer set search_path = everwake, pg_temp as $$
  select case
    when everwake.current_user_id() is null then null
    when exists (select 1 from everwake.platform_admins a where a.user_id = everwake.current_user_id()) then 'owner'
    else (select m.role from everwake.tenant_members m
           where m.tenant_id = p_tenant and m.user_id = everwake.current_user_id())
  end
$$;

create or replace function everwake.is_platform_admin()
returns boolean language sql stable security definer set search_path = everwake, pg_temp as $$
  select exists (select 1 from everwake.platform_admins a where a.user_id = everwake.current_user_id())
$$;

create or replace function everwake.require_role(p_tenant uuid, p_roles text[])
returns text language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare r text;
begin
  if everwake.current_user_id() is null then
    return 'system';
  end if;
  r := everwake.member_role(p_tenant);
  if r is null or not (r = any(p_roles)) then
    raise exception 'not allowed for this restaurant' using errcode = '42501';
  end if;
  return r;
end $$;

-- branch-scoped staff see only their branches' orders
create or replace function everwake.can_see_branch(p_tenant uuid, p_branch uuid)
returns boolean language sql stable security definer set search_path = everwake, pg_temp as $$
  select everwake.is_platform_admin()
      or exists (select 1 from everwake.tenant_members m
                  where m.tenant_id = p_tenant and m.user_id = everwake.current_user_id()
                    and (m.branch_ids is null or p_branch is null or p_branch = any(m.branch_ids)))
$$;

create or replace function everwake.customer_language(p_tenant uuid, p_wa text)
returns text language sql stable as $$
  select coalesce(nullif(c.state ->> 'last_language', ''), cu.language, t.default_language, 'ar')
    from everwake.tenants t
    left join everwake.conversations c on c.tenant_id = t.id and c.wa_id = p_wa
    left join everwake.customers cu on cu.id = c.customer_id
   where t.id = p_tenant
$$;

-- ---------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------
create or replace function everwake.queue_customer_message(
  p_tenant uuid, p_wa text, p_purpose text, p_body text,
  p_kind text default 'text', p_media_url text default null, p_media_mime text default null,
  p_file_name text default null, p_sender text default 'system', p_user uuid default null,
  p_not_before timestamptz default now())
returns jsonb language plpgsql as $$
declare
  conv  everwake.conversations%rowtype;
  cust  everwake.customers%rowtype;
  v_ch  uuid;
  v_to  text;
  v_msg bigint;
  v_out bigint;
begin
  select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
  if not found then
    raise exception 'no conversation with % for this restaurant', p_wa;
  end if;
  select * into cust from everwake.customers where id = conv.customer_id;
  select ch.id into v_ch
    from everwake.whatsapp_channels ch
   where ch.tenant_id = p_tenant and ch.is_active
   order by (ch.id::text = conv.state -> 'contact' ->> 'channel_id') desc, ch.created_at
   limit 1;
  v_to := coalesce(nullif(conv.state -> 'contact' ->> 'reply_to', ''), cust.reply_to, p_wa);

  insert into everwake.messages (tenant_id, conversation_id, wa_id, direction, sender, staff_user_id, kind, body,
                                 media_url, media_mime, status, meta)
  values (p_tenant, conv.id, p_wa, 'outbound', p_sender, p_user, p_kind, p_body, p_media_url, p_media_mime, 'queued',
          jsonb_build_object('purpose', p_purpose))
  returning id into v_msg;

  insert into everwake.outbox (tenant_id, channel_id, to_jid, wa_id, message_id, purpose, kind, body, media_url,
                               media_mime, file_name, not_before, created_by)
  values (p_tenant, v_ch, v_to, p_wa, v_msg, p_purpose, p_kind, p_body, p_media_url, p_media_mime, p_file_name,
          p_not_before, p_user)
  returning id into v_out;

  update everwake.conversations
     set last_message_at = now(),
         last_message_preview = left(coalesce(p_body, '[' || p_kind || ']'), 160)
   where id = conv.id;
  return jsonb_build_object('outbox_id', v_out, 'message_id', v_msg);
end $$;

-- the sender (n8n "Everwake — Outbox") takes a batch; nobody else gets the same rows
create or replace function everwake.outbox_claim(p_limit int default 20, p_worker text default 'n8n')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  -- nothing to send with: fail fast so the dashboard shows why
  update everwake.outbox o
     set status = 'failed', last_error = 'No WhatsApp number is connected for this restaurant.'
   where o.status = 'queued' and o.not_before <= now()
     and not exists (select 1 from everwake.whatsapp_channels ch where ch.id = o.channel_id and ch.is_active);
  update everwake.messages m set status = 'failed', error = 'No WhatsApp number is connected.'
    from everwake.outbox o
   where o.message_id = m.id and o.status = 'failed' and m.status = 'queued';

  with c as (
    select o.id from everwake.outbox o
     where o.status = 'queued' and o.not_before <= now()
     order by o.not_before, o.id
     for update skip locked
     limit greatest(1, least(p_limit, 100))
  ), u as (
    update everwake.outbox o
       set status = 'sending', claimed_at = now(), claimed_by = p_worker, attempts = o.attempts + 1
      from c where o.id = c.id
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'tenant_id', u.tenant_id, 'wa_id', u.wa_id, 'to', u.to_jid, 'purpose', u.purpose,
           'kind', u.kind, 'body', u.body, 'media_url', u.media_url, 'media_mime', u.media_mime,
           'file_name', u.file_name, 'attempts', u.attempts,
           'channel', jsonb_build_object('id', ch.id, 'provider', ch.provider, 'base_url', rtrim(ch.base_url, '/'),
                                         'instance', ch.instance_name, 'api_key', ch.api_key))
         order by u.id), '[]'::jsonb)
    into v
    from u join everwake.whatsapp_channels ch on ch.id = u.channel_id;

  update everwake.messages m set status = 'sending'
    from everwake.outbox o
   where o.message_id = m.id and o.status = 'sending' and m.status = 'queued';
  return v;
end $$;

create or replace function everwake.outbox_result(p jsonb)
returns jsonb language plpgsql as $$
declare
  o     everwake.outbox%rowtype;
  v_ok  boolean := coalesce((p ->> 'ok')::boolean, false);
  v_fin boolean;
begin
  select * into o from everwake.outbox where id = (p ->> 'id')::bigint for update;
  if not found then return jsonb_build_object('updated', false); end if;
  v_fin := v_ok or o.attempts >= 3;

  update everwake.outbox
     set status = case when v_ok then 'sent' when v_fin then 'failed' else 'queued' end,
         sent_at = case when v_ok then now() end,
         external_id = nullif(p ->> 'external_id', ''),
         last_error = case when v_ok then null else left(coalesce(p ->> 'error', 'send failed'), 500) end,
         not_before = case when v_ok or v_fin then not_before else now() + make_interval(secs => 30 * o.attempts) end
   where id = o.id;

  if o.message_id is not null then
    update everwake.messages
       set status = case when v_ok then 'sent' when v_fin then 'failed' else 'queued' end,
           external_id = coalesce(nullif(p ->> 'external_id', ''), external_id),
           sent_at = case when v_ok then now() else sent_at end,
           error = case when v_ok then null else left(coalesce(p ->> 'error', 'send failed'), 500) end
     where id = o.message_id
       -- a duplicate external id would violate the unique index: keep the row, drop the id
       and not exists (select 1 from everwake.messages x
                        where x.tenant_id = o.tenant_id and x.external_id = nullif(p ->> 'external_id', '')
                          and x.id <> o.message_id);
  end if;
  if v_ok and o.wa_id is not null then
    update everwake.conversations set last_outbound_at = now()
     where tenant_id = o.tenant_id and wa_id = o.wa_id;
  end if;
  return jsonb_build_object('updated', true, 'final', v_fin, 'ok', v_ok);
end $$;

-- ---------------------------------------------------------------------
-- The agent switch
-- OFF: every new customer gets one warm apology and is remembered.
-- ON:  everyone remembered gets a "we're back" message (staggered, so
--      WhatsApp never sees a burst), unless the restaurant says not to.
-- ---------------------------------------------------------------------
create or replace function everwake.set_agent_enabled(p_tenant uuid, p_enabled boolean,
                                                       p_reason text default null, p_notify boolean default true)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  t       everwake.tenants%rowtype;
  s       jsonb;
  v_pause bigint;
  pc      record;
  n       int := 0;
  v_lang  text;
  v_body  text;
  v_uid   uuid := everwake.current_user_id();
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager', 'staff']);
  select * into t from everwake.tenants where id = p_tenant for update;
  s := everwake.merged_settings(t.settings);

  if not p_enabled then
    if not t.agent_enabled then
      return jsonb_build_object('agent_enabled', false, 'pause_id', t.current_pause_id, 'changed', false);
    end if;
    insert into everwake.agent_pauses (tenant_id, started_by, reason, notify_on_resume)
    values (p_tenant, v_uid, nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_notify, true))
    returning id into v_pause;
    update everwake.tenants set agent_enabled = false, current_pause_id = v_pause where id = p_tenant;
    insert into everwake.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
    values (p_tenant, v_uid, 'agent_off', 'tenants', p_tenant::text, jsonb_build_object('reason', p_reason));
    return jsonb_build_object('agent_enabled', false, 'pause_id', v_pause, 'changed', true);
  end if;

  if t.agent_enabled then
    return jsonb_build_object('agent_enabled', true, 'changed', false, 'notified', 0);
  end if;
  v_pause := t.current_pause_id;
  update everwake.agent_pauses set ended_at = now(), ended_by = v_uid where id = v_pause;
  update everwake.tenants set agent_enabled = true, current_pause_id = null where id = p_tenant;

  if coalesce(p_notify, true) and v_pause is not null then
    for pc in
      select x.*, cu.full_name, cu.display_name
        from everwake.pause_contacts x
        left join everwake.customers cu on cu.id = x.customer_id
       where x.pause_id = v_pause and x.resume_notified_at is null and not coalesce(cu.is_blocked, false)
       order by x.first_message_at
    loop
      v_lang := everwake.customer_language(p_tenant, pc.wa_id);
      v_body := everwake.render_template(s -> 'templates' ->> ('resume_notice_' || v_lang),
                                         jsonb_build_object('name', everwake.first_name(pc.full_name, pc.display_name)));
      perform everwake.queue_customer_message(p_tenant, pc.wa_id, 'resume_notice', v_body,
                                              p_not_before => now() + make_interval(secs => n * 3));
      update everwake.pause_contacts set resume_notified_at = now() where pause_id = v_pause and wa_id = pc.wa_id;
      n := n + 1;
    end loop;
  end if;
  update everwake.agent_pauses set notified_count = n where id = v_pause;
  insert into everwake.audit_log (tenant_id, user_id, action, entity, entity_id, detail)
  values (p_tenant, v_uid, 'agent_on', 'tenants', p_tenant::text, jsonb_build_object('notified', n, 'pause_id', v_pause));
  return jsonb_build_object('agent_enabled', true, 'changed', true, 'notified', n, 'pause_id', v_pause);
end $$;

-- how many people are waiting for the "we're back" message
create or replace function everwake.pause_status(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = everwake, pg_temp as $$
  select jsonb_build_object(
    'agent_enabled', t.agent_enabled,
    'pause', case when t.current_pause_id is null then null else (
       select jsonb_build_object('id', ap.id, 'started_at', ap.started_at, 'reason', ap.reason,
                                 'waiting', (select count(*) from everwake.pause_contacts pc
                                              where pc.pause_id = ap.id and pc.resume_notified_at is null))
         from everwake.agent_pauses ap where ap.id = t.current_pause_id) end)
  from everwake.tenants t
  where t.id = p_tenant and everwake.member_role(p_tenant) is not null
$$;

-- ---------------------------------------------------------------------
-- Take over · reply · hand back
-- ---------------------------------------------------------------------
create or replace function everwake.take_over(p_conversation bigint, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare c everwake.conversations%rowtype;
begin
  select * into c from everwake.conversations where id = p_conversation for update;
  if not found then raise exception 'conversation not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.conversations
     set mode = 'human', assigned_user_id = coalesce(everwake.current_user_id(), assigned_user_id),
         human_since = coalesce(human_since, now()), human_last_activity_at = now(),
         human_reason = coalesce(nullif(p_reason, ''), human_reason, 'taken over from the dashboard'),
         needs_attention = false
   where id = c.id
  returning * into c;
  -- an agent turn already running for this chat will see the mode and stay quiet
  delete from everwake.inbound_buffer where tenant_id = c.tenant_id and wa_id = c.wa_id and claimed_by_run_id is null;
  return jsonb_build_object('mode', c.mode, 'human_since', c.human_since);
end $$;

create or replace function everwake.hand_back(p_conversation bigint)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare c everwake.conversations%rowtype;
begin
  select * into c from everwake.conversations where id = p_conversation for update;
  if not found then raise exception 'conversation not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.conversations
     set mode = 'agent', assigned_user_id = null, human_reason = null, human_last_activity_at = null,
         state = state || jsonb_build_object('handback', jsonb_build_object(
                   'at', now(), 'by', coalesce(everwake.current_user_id()::text, 'system'), 'human_since', c.human_since)),
         human_since = null
   where id = c.id
  returning * into c;
  return jsonb_build_object('mode', c.mode);
end $$;

create or replace function everwake.send_staff_message(p_conversation bigint, p_body text, p_kind text default 'text',
                                                        p_media_url text default null, p_media_mime text default null,
                                                        p_file_name text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  c everwake.conversations%rowtype;
  r jsonb;
begin
  select * into c from everwake.conversations where id = p_conversation for update;
  if not found then raise exception 'conversation not found'; end if;
  perform everwake.require_role(c.tenant_id, array['owner', 'manager', 'staff']);
  if coalesce(btrim(p_body), '') = '' and p_media_url is null then
    raise exception 'empty message';
  end if;
  -- writing to the customer means a person has this conversation now
  update everwake.conversations
     set mode = 'human', assigned_user_id = coalesce(assigned_user_id, everwake.current_user_id()),
         human_since = coalesce(human_since, now()), human_last_activity_at = now(),
         human_reason = coalesce(human_reason, 'replied from the dashboard'),
         needs_attention = false, unread_count = 0
   where id = c.id;
  delete from everwake.inbound_buffer where tenant_id = c.tenant_id and wa_id = c.wa_id and claimed_by_run_id is null;
  r := everwake.queue_customer_message(c.tenant_id, c.wa_id, 'staff_reply', nullif(btrim(p_body), ''),
                                       coalesce(p_kind, 'text'), p_media_url, p_media_mime, p_file_name,
                                       'staff', everwake.current_user_id());
  return r;
end $$;

create or replace function everwake.mark_read(p_conversation bigint)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from everwake.conversations where id = p_conversation;
  perform everwake.require_role(v_tenant, array['owner', 'manager', 'staff']);
  update everwake.conversations set unread_count = 0 where id = p_conversation;
end $$;

create or replace function everwake.resolve_attention(p_conversation bigint)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from everwake.conversations where id = p_conversation;
  perform everwake.require_role(v_tenant, array['owner', 'manager', 'staff']);
  update everwake.conversations set needs_attention = false, attention_reason = null where id = p_conversation;
end $$;

-- ---------------------------------------------------------------------
-- The order board
-- placed → accepted → preparing → ready / out_for_delivery → delivered | picked_up
-- placed / accepted / preparing / ready / out_for_delivery → rejected | cancelled
-- ---------------------------------------------------------------------
create or replace function everwake.set_order_status(p_order bigint, p_status text, p_note text default null,
                                                      p_notify boolean default true, p_eta text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  o       everwake.orders%rowtype;
  t       everwake.tenants%rowtype;
  s       jsonb;
  v_rank  jsonb := '{"placed":1,"accepted":2,"preparing":3,"ready":4,"out_for_delivery":5,"delivered":6,"picked_up":6}';
  v_lang  text;
  v_tpl   text;
  v_body  text;
  v_sent  boolean := false;
  v_bname text;
  v_line  text;
begin
  select * into o from everwake.orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  perform everwake.require_role(o.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(o.tenant_id, o.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  if p_status not in ('accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'picked_up', 'rejected', 'cancelled') then
    raise exception 'unknown status %', p_status;
  end if;
  if o.status in ('draft', 'delivered', 'picked_up', 'rejected', 'cancelled') then
    raise exception 'this order is % and cannot change', o.status;
  end if;
  if p_status not in ('rejected', 'cancelled') and (v_rank ->> p_status)::int <= (v_rank ->> o.status)::int then
    raise exception 'the order is already %', o.status;
  end if;

  update everwake.orders
     set status = p_status,
         accepted_at = case when p_status in ('accepted', 'preparing') then coalesce(accepted_at, now()) else accepted_at end,
         ready_at = case when p_status = 'ready' then now() else ready_at end,
         out_for_delivery_at = case when p_status = 'out_for_delivery' then now() else out_for_delivery_at end,
         completed_at = case when p_status in ('delivered', 'picked_up') then now() else completed_at end,
         cancelled_at = case when p_status in ('rejected', 'cancelled') then now() else cancelled_at end,
         reject_reason = case when p_status in ('rejected', 'cancelled') then nullif(btrim(coalesce(p_note, '')), '') else reject_reason end,
         eta_text = coalesce(nullif(btrim(coalesce(p_eta, '')), ''), eta_text)
   where id = o.id
  returning * into o;

  -- a rejected / cancelled order is not money the customer spent
  if p_status in ('rejected', 'cancelled') and o.customer_id is not null then
    update everwake.customers
       set orders_count = greatest(0, orders_count - 1), total_spent = greatest(0, total_spent - coalesce(o.total, 0))
     where id = o.customer_id;
  end if;

  select * into t from everwake.tenants where id = o.tenant_id;
  s := everwake.merged_settings(t.settings);
  if coalesce(p_notify, true) then
    v_lang := everwake.customer_language(o.tenant_id, o.wa_id);
    v_tpl := s -> 'templates' ->> ('status_' || p_status || '_' || v_lang);
    -- on its way with one of the restaurant's drivers: their name, number and how far
    if p_status = 'out_for_delivery' then v_line := everwake.driver_line(o, v_lang); end if;
    if nullif(btrim(coalesce(v_tpl, '')), '') is not null or v_line is not null then
      select case when v_lang = 'en' then coalesce(nullif(name_en, ''), name_ar) else name_ar end
        into v_bname from everwake.branches where id = o.branch_id;
      v_body := everwake.render_template(v_tpl, jsonb_build_object(
        'order_no', o.order_no,
        'branch', coalesce(v_bname, ''),
        'eta', case when o.eta_text is null then ''
                    when v_lang = 'en' then ' Expected in about ' || o.eta_text || '.'
                    else ' الوقت المتوقع حوالي ' || o.eta_text || '.' end,
        'reason', case when nullif(btrim(coalesce(p_note, '')), '') is null then ''
                       when v_lang = 'en' then ' ' || btrim(p_note) || '.'
                       else ' ' || btrim(p_note) || '.' end,
        'name', ''));
      v_body := concat_ws(E'\n', nullif(btrim(coalesce(v_body, '')), ''), v_line);
      perform everwake.queue_customer_message(o.tenant_id, o.wa_id, 'order_status', v_body,
                                              p_user => everwake.current_user_id());
      v_sent := true;
    end if;
  end if;

  insert into everwake.order_events (tenant_id, order_id, status, note, by_user, by_role, notified)
  values (o.tenant_id, o.id, p_status, nullif(btrim(coalesce(p_note, '')), ''), everwake.current_user_id(),
          case when everwake.current_user_id() is null then 'system' else 'staff' end, v_sent);
  return jsonb_build_object('order_id', o.id, 'status', o.status, 'notified', v_sent);
end $$;

-- ---------------------------------------------------------------------
-- Stock and busy switches (any team member — it is a floor decision)
-- available=false, until=null  → off until switched back on
-- available=false, until=X     → off until X, then back by itself
-- ---------------------------------------------------------------------
create or replace function everwake.set_item_availability(p_item uuid, p_available boolean,
                                                           p_branch uuid default null, p_until timestamptz default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from everwake.menu_items where id = p_item;
  if v_tenant is null then raise exception 'item not found'; end if;
  perform everwake.require_role(v_tenant, array['owner', 'manager', 'staff']);
  if p_branch is null then
    update everwake.menu_items
       set is_available = p_available or p_until is not null,
           sold_out_until = case when p_available then null else p_until end
     where id = p_item;
    -- back on everywhere means every branch too
    if p_available then
      update everwake.menu_item_branches
         set is_available = true, sold_out_until = null, updated_at = now()
       where item_id = p_item and (not is_available or sold_out_until is not null);
    end if;
  else
    insert into everwake.menu_item_branches (tenant_id, item_id, branch_id, is_available, sold_out_until)
    values (v_tenant, p_item, p_branch, p_available or p_until is not null, case when p_available then null else p_until end)
    on conflict (item_id, branch_id) do update
      set is_available = excluded.is_available, sold_out_until = excluded.sold_out_until, updated_at = now();
  end if;
  return jsonb_build_object('item_id', p_item, 'branch_id', p_branch, 'available', p_available, 'until', p_until);
end $$;

create or replace function everwake.set_option_availability(p_option uuid, p_available boolean)
returns void language plpgsql security definer set search_path = everwake, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from everwake.menu_options where id = p_option;
  perform everwake.require_role(v_tenant, array['owner', 'manager', 'staff']);
  update everwake.menu_options set is_available = p_available where id = p_option;
end $$;

create or replace function everwake.set_branch_busy(p_branch uuid, p_minutes int, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare b everwake.branches%rowtype;
begin
  select * into b from everwake.branches where id = p_branch;
  if not found then raise exception 'branch not found'; end if;
  perform everwake.require_role(b.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.branches
     set busy_until = case when coalesce(p_minutes, 0) > 0 then now() + make_interval(mins => p_minutes) end,
         busy_reason = case when coalesce(p_minutes, 0) > 0 then nullif(btrim(coalesce(p_reason, '')), '') end
   where id = p_branch
  returning * into b;
  return jsonb_build_object('branch_id', b.id, 'busy_until', b.busy_until);
end $$;

create or replace function everwake.set_branch_accepting(p_branch uuid, p_accepting boolean)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare b everwake.branches%rowtype;
begin
  select * into b from everwake.branches where id = p_branch;
  if not found then raise exception 'branch not found'; end if;
  perform everwake.require_role(b.tenant_id, array['owner', 'manager', 'staff']);
  update everwake.branches set accepting_orders = p_accepting, busy_until = null where id = p_branch returning * into b;
  return jsonb_build_object('branch_id', b.id, 'accepting_orders', b.accepting_orders);
end $$;

-- ---------------------------------------------------------------------
-- Housekeeping (every minute, from the n8n outbox workflow)
-- ---------------------------------------------------------------------
create or replace function everwake.housekeeping()
returns jsonb language plpgsql as $$
declare
  n_release int; n_locks int; n_stuck int; n_buf int; n_snap int := 0; n_busy int;
  r record;
begin
  -- a takeover nobody touched for a while goes back to the agent
  with idle as (
    select c.id, c.human_since
      from everwake.conversations c
      join everwake.tenants t on t.id = c.tenant_id
     where c.mode = 'human'
       and coalesce((everwake.merged_settings(t.settings) ->> 'human_auto_release_minutes')::int, 0) > 0
       and coalesce(c.human_last_activity_at, c.human_since, c.updated_at)
           < now() - make_interval(mins => (everwake.merged_settings(t.settings) ->> 'human_auto_release_minutes')::int)
  )
  update everwake.conversations c
     set mode = 'agent', assigned_user_id = null, human_reason = null, human_last_activity_at = null, human_since = null,
         state = c.state || jsonb_build_object('handback', jsonb_build_object('at', now(), 'by', 'auto', 'human_since', idle.human_since))
    from idle where c.id = idle.id;
  get diagnostics n_release = row_count;

  delete from everwake.conversation_locks where expires_at < now() - interval '1 minute';
  get diagnostics n_locks = row_count;

  update everwake.outbox set status = 'queued', not_before = now()
   where status = 'sending' and claimed_at < now() - interval '5 minutes';
  get diagnostics n_stuck = row_count;

  delete from everwake.inbound_buffer
   where (claimed_by_run_id is not null and received_at < now() - interval '1 hour')
      or (claimed_by_run_id is null and received_at < now() - interval '15 minutes');
  get diagnostics n_buf = row_count;

  update everwake.branches set busy_until = null, busy_reason = null where busy_until < now();
  get diagnostics n_busy = row_count;

  for r in select s.tenant_id from everwake.menu_snapshot s
            where s.scope = 'all' and s.valid_until is not null and s.valid_until <= now() loop
    perform everwake.rebuild_snapshot(r.tenant_id, false);
    n_snap := n_snap + 1;
  end loop;

  return jsonb_build_object('takeovers_released', n_release, 'locks_cleared', n_locks, 'outbox_requeued', n_stuck,
                            'buffer_cleared', n_buf, 'busy_cleared', n_busy, 'snapshots_rebuilt', n_snap);
end $$;
