-- =====================================================================
-- Everwake Orders · 007 · who can see and change what
--
-- Three kinds of caller:
--   · the n8n engine and maintenance scripts — a database role (or the
--     Supabase service role): full access, no user
--   · a dashboard user — Supabase role `authenticated` with a JWT: sees
--     only the restaurants they belong to (row level security), edits
--     only what their role allows, and does everything sensitive through
--     the functions in 005/006
--   · anon — nothing at all
-- Roles inside a restaurant: owner (everything), manager (everything
-- but the team and the WhatsApp secrets' owner-only actions), staff
-- (orders, conversations, stock and busy switches, the agent switch).
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- the restaurants the caller belongs to (evaluated once per query)
create or replace function everwake.my_tenant_ids()
returns uuid[] language sql stable security definer set search_path = everwake, pg_temp as $$
  select case
    when everwake.current_user_id() is null then '{}'::uuid[]
    when everwake.is_platform_admin() then coalesce((select array_agg(id) from everwake.tenants), '{}')
    else coalesce((select array_agg(tenant_id) from everwake.tenant_members where user_id = everwake.current_user_id()), '{}')
  end
$$;

create or replace function everwake.my_editor_tenant_ids()
returns uuid[] language sql stable security definer set search_path = everwake, pg_temp as $$
  select case
    when everwake.current_user_id() is null then '{}'::uuid[]
    when everwake.is_platform_admin() then coalesce((select array_agg(id) from everwake.tenants), '{}')
    else coalesce((select array_agg(tenant_id) from everwake.tenant_members
                    where user_id = everwake.current_user_id() and role in ('owner', 'manager')), '{}')
  end
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on schema everwake from public;
grant usage on schema everwake to authenticated, service_role;

revoke all on all tables in schema everwake from public, anon, authenticated;
revoke all on all sequences in schema everwake from public, anon, authenticated;
revoke execute on all functions in schema everwake from public, anon, authenticated;
alter default privileges in schema everwake revoke execute on functions from public;

grant all on all tables in schema everwake to service_role;
grant all on all sequences in schema everwake to service_role;
grant execute on all functions in schema everwake to service_role;

-- read: every table the dashboard shows
grant select on everwake.tenants, everwake.tenant_members, everwake.branches, everwake.delivery_zones,
                everwake.menu_categories, everwake.menu_items, everwake.menu_option_groups, everwake.menu_options,
                everwake.menu_item_branches, everwake.item_media, everwake.menu_media, everwake.menu_imports,
                everwake.offers, everwake.knowledge_entries, everwake.customers, everwake.customer_identities,
                everwake.customer_addresses, everwake.conversations, everwake.messages, everwake.outbox,
                everwake.orders, everwake.order_items, everwake.order_events, everwake.agent_pauses,
                everwake.pause_contacts, everwake.agent_events, everwake.menu_snapshot, everwake.audit_log,
                everwake.tenant_invites, everwake.platform_admins
  to authenticated;
-- the WhatsApp number without its secrets
grant select (id, tenant_id, provider, label, phone_number, instance_name, base_url, cloud_phone_number_id,
              default_branch_id, status, is_active, last_inbound_at, connected_at, created_at, updated_at)
  on everwake.whatsapp_channels to authenticated;

-- write: what the restaurant configures (RLS narrows it to owners/managers)
grant insert, update, delete on everwake.branches, everwake.delivery_zones, everwake.menu_categories,
                                everwake.menu_items, everwake.menu_option_groups, everwake.menu_options,
                                everwake.menu_item_branches, everwake.item_media, everwake.menu_media,
                                everwake.offers, everwake.knowledge_entries
  to authenticated;
grant insert, update on everwake.menu_imports to authenticated;
grant update (name_ar, name_en, timezone, currency, currency_symbol_ar, default_language, order_no_prefix, profile, settings)
  on everwake.tenants to authenticated;
grant update (full_name, alt_phone, staff_notes, tags, is_blocked, marketing_opt_out, food_prefs)
  on everwake.customers to authenticated;
grant delete on everwake.customer_addresses to authenticated;

-- functions the dashboard calls
grant execute on function
  everwake.current_user_id(), everwake.member_role(uuid), everwake.is_platform_admin(), everwake.my_tenant_ids(),
  everwake.my_editor_tenant_ids(), everwake.can_see_branch(uuid, uuid),
  everwake.norm(text), everwake.digits(text), everwake.fmt_money(numeric), everwake.haversine_km(double precision, double precision, double precision, double precision),
  everwake.point_in_polygon(double precision, double precision, jsonb), everwake.day_windows(jsonb, int),
  everwake.is_open_at(jsonb, timestamp), everwake.branch_state(uuid), everwake.zones_at(uuid, double precision, double precision),
  everwake.match_area(uuid, text), everwake.default_settings(), everwake.default_profile(), everwake.merged_settings(jsonb),
  everwake.merged_profile(jsonb), everwake.render_template(text, jsonb),
  everwake.create_tenant(text, text, text, text, text, text, text), everwake.my_tenants(),
  everwake.onboarding_checklist(uuid), everwake.go_live(uuid, boolean),
  everwake.publish_menu(uuid, jsonb, text, uuid), everwake.save_item_choices(uuid, jsonb),
  everwake.analytics(uuid, timestamptz, timestamptz),
  everwake.save_channel(uuid, jsonb), everwake.channel_webhook_token(uuid),
  everwake.invite_member(uuid, text, text, uuid[]), everwake.accept_invites(),
  everwake.update_member(uuid, uuid, text, uuid[], text), everwake.remove_member(uuid, uuid),
  everwake.set_agent_enabled(uuid, boolean, text, boolean), everwake.pause_status(uuid),
  everwake.take_over(bigint, text), everwake.hand_back(bigint),
  everwake.send_staff_message(bigint, text, text, text, text, text),
  everwake.mark_read(bigint), everwake.resolve_attention(bigint),
  everwake.set_order_status(bigint, text, text, boolean, text),
  everwake.set_item_availability(uuid, boolean, uuid, timestamptz), everwake.set_option_availability(uuid, boolean),
  everwake.set_branch_busy(uuid, int, text), everwake.set_branch_accepting(uuid, boolean)
  to authenticated;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tenants', 'platform_admins', 'tenant_members', 'tenant_invites', 'branches', 'delivery_zones',
                           'whatsapp_channels', 'menu_categories', 'menu_items', 'menu_option_groups', 'menu_options',
                           'menu_item_branches', 'item_media', 'menu_media', 'menu_imports', 'offers', 'knowledge_entries',
                           'customers', 'customer_identities', 'customer_addresses', 'conversations', 'messages', 'outbox',
                           'inbound_buffer', 'conversation_locks', 'orders', 'order_items', 'order_events', 'agent_pauses',
                           'pause_contacts', 'agent_events', 'menu_snapshot', 'audit_log'] loop
    execute format('alter table everwake.%I enable row level security', t);
  end loop;

  -- members read their restaurant's rows
  foreach t in array array['tenant_members', 'branches', 'delivery_zones', 'whatsapp_channels', 'menu_categories',
                           'menu_items', 'menu_option_groups', 'menu_options', 'menu_item_branches', 'item_media',
                           'menu_media', 'offers', 'knowledge_entries', 'customers', 'customer_identities',
                           'customer_addresses', 'conversations', 'messages', 'outbox', 'agent_pauses', 'pause_contacts',
                           'menu_snapshot'] loop
    execute format('create policy member_read on everwake.%I for select to authenticated
                      using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]))', t);
  end loop;

  -- owners and managers change the configuration
  foreach t in array array['branches', 'delivery_zones', 'menu_categories', 'menu_items', 'menu_option_groups',
                           'menu_options', 'menu_item_branches', 'item_media', 'menu_media', 'menu_imports', 'offers',
                           'knowledge_entries', 'customer_addresses'] loop
    execute format('create policy editor_write on everwake.%I for all to authenticated
                      using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
                      with check (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]))', t);
  end loop;
end $$;

create policy member_read on everwake.tenants for select to authenticated
  using (id = any ((select everwake.my_tenant_ids())::uuid[]));
create policy editor_update on everwake.tenants for update to authenticated
  using (id = any ((select everwake.my_editor_tenant_ids())::uuid[]))
  with check (id = any ((select everwake.my_editor_tenant_ids())::uuid[]));

create policy self_read on everwake.platform_admins for select to authenticated
  using (user_id = everwake.current_user_id());

create policy owner_read on everwake.tenant_invites for select to authenticated
  using (everwake.member_role(tenant_id) = 'owner');

-- staff note, tags, block: any team member
create policy member_update on everwake.customers for update to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));

-- orders: branch staff see their branches only
create policy member_read on everwake.orders for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]) and everwake.can_see_branch(tenant_id, branch_id));
create policy member_read on everwake.order_items for select to authenticated
  using (exists (select 1 from everwake.orders o where o.id = order_id));
create policy member_read on everwake.order_events for select to authenticated
  using (exists (select 1 from everwake.orders o where o.id = order_id));

create policy member_read on everwake.menu_imports for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]));

-- telemetry and the audit trail: owners and managers
create policy editor_read on everwake.agent_events for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
create policy editor_read on everwake.audit_log for select to authenticated
  using (tenant_id = any ((select everwake.my_editor_tenant_ids())::uuid[]));
