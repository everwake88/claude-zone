-- Everwake Orders · patch 2026-10-22 · growth and reports
-- The commission saved, which QR card / link brought which customers, the sales
-- being missed, and the owner's daily report on WhatsApp (the same as
-- 009_growth.sql), plus the every-minute housekeeping that now sends that report.
-- Already in the migrations for new installs. Run once in Supabase → SQL Editor,
-- after 2026-10-21_drivers.sql.

-- =====================================================================
-- Everwake Orders · 009 · growth and reports
--
-- What an owner wants to see that a delivery app never shows them:
--   · the commission WhatsApp saved them (today, this month, ever)
--   · which QR card or link brought which customers (the link pre-fills
--     "… عرفتكم من <source>", so the first message says where they came from)
--   · the sales they are missing: carts never finished, customers outside the
--     delivery zones, people who wrote while every branch was closed,
--     rejected / cancelled orders, chats that ended without an order
--   · a daily summary on their own WhatsApp, at the hour they choose
-- =====================================================================

create table everwake.report_runs (
  tenant_id  uuid not null references everwake.tenants(id) on delete cascade,
  kind       text not null default 'daily',
  local_day  date not null,
  recipients int not null default 0,
  sent_at    timestamptz not null default now(),
  primary key (tenant_id, kind, local_day)
);

alter table everwake.outbox drop constraint outbox_purpose_check;
alter table everwake.outbox add constraint outbox_purpose_check
  check (purpose in ('staff_reply', 'order_status', 'pause_notice', 'resume_notice', 'order_ticket', 'broadcast', 'test',
                     'driver', 'driver_chat', 'report'));

-- 1,234 — money as people read it
create or replace function everwake.fmt_int(n numeric)
returns text language sql immutable as $$
  select case when n is null then '0' else to_char(round(n), 'FM999,999,999,990') end
$$;

-- ---------------------------------------------------------------------
-- The commission WhatsApp saved
-- ---------------------------------------------------------------------
create or replace function everwake.savings(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare
  t everwake.tenants%rowtype;
  v_pct numeric;
  v_today timestamptz;
  v_month timestamptz;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  select * into t from everwake.tenants where id = p_tenant;
  v_pct := coalesce((everwake.merged_settings(t.settings) ->> 'aggregator_commission_percent')::numeric, 25);
  v_today := date_trunc('day', now() at time zone t.timezone) at time zone t.timezone;
  v_month := date_trunc('month', now() at time zone t.timezone) at time zone t.timezone;
  return (
    select jsonb_build_object(
      'commission_percent', v_pct,
      'today', round(coalesce(sum(total) filter (where placed_at >= v_today), 0) * v_pct / 100, 2),
      'month', round(coalesce(sum(total) filter (where placed_at >= v_month), 0) * v_pct / 100, 2),
      'all_time', round(coalesce(sum(total), 0) * v_pct / 100, 2),
      'orders_today', count(*) filter (where placed_at >= v_today),
      'orders_month', count(*) filter (where placed_at >= v_month),
      'orders_all', count(*),
      'revenue_month', coalesce(sum(total) filter (where placed_at >= v_month), 0),
      'since', min(placed_at))
      from everwake.orders
     where tenant_id = p_tenant and placed_at is not null and status not in ('draft', 'rejected', 'cancelled'));
end $$;

-- ---------------------------------------------------------------------
-- Where customers came from: the sources the restaurant's links name
-- ---------------------------------------------------------------------
create or replace function everwake.growth_sources(p_tenant uuid, p_from timestamptz, p_to timestamptz, p_sources text[])
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
declare v_pct numeric;
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  v_pct := coalesce((select (everwake.merged_settings(settings) ->> 'aggregator_commission_percent')::numeric
                       from everwake.tenants where id = p_tenant), 25);
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.chats desc, r.source) from (
    with firsts as (
      -- the first message of each customer that names a source
      select distinct on (m.wa_id) m.wa_id, m.created_at, m.body
        from everwake.messages m
       where m.tenant_id = p_tenant and m.direction = 'inbound' and m.created_at >= p_from and m.created_at < p_to
         and m.body like '%عرفتكم من%'
       order by m.wa_id, m.created_at
    )
    select s.source,
           count(distinct f.wa_id) as chats,
           count(distinct o.wa_id) as customers,
           count(o.id) as orders,
           coalesce(sum(o.total), 0) as revenue,
           round(coalesce(sum(o.total), 0) * v_pct / 100, 2) as commission_saved
      from unnest(p_sources) s(source)
      left join firsts f on f.body like '%عرفتكم من ' || s.source || '%'
      left join everwake.orders o on o.tenant_id = p_tenant and o.wa_id = f.wa_id and o.placed_at >= f.created_at
                                 and o.status not in ('draft', 'rejected', 'cancelled')
     group by s.source) r), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- The sales the restaurant is missing (no role check: the daily report
-- uses it too; the dashboard calls lost_sales below)
-- ---------------------------------------------------------------------
create or replace function everwake.lost_sales_data(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable as $$
declare
  t everwake.tenants%rowtype;
begin
  select * into t from everwake.tenants where id = p_tenant;
  return jsonb_build_object(
    -- carts with dishes in them that never became an order (quiet for an hour or more)
    'abandoned', (
      with d as (
        select o.*, coalesce(o.conversation_id, c.id) as conv_id, coalesce(cu.full_name, cu.display_name) as name
          from everwake.orders o
          left join everwake.conversations c on c.tenant_id = o.tenant_id and c.wa_id = o.wa_id
          left join everwake.customers cu on cu.id = coalesce(o.customer_id, c.customer_id)
         where o.tenant_id = p_tenant and o.status = 'draft'
           and o.updated_at >= p_from and o.updated_at < p_to and o.updated_at < now() - interval '1 hour'
           and jsonb_array_length(coalesce(o.cart -> 'items', '[]'::jsonb)) > 0)
      select jsonb_build_object(
        'count', (select count(*) from d),
        'value', (select coalesce(sum(nullif(total, 0)), sum(subtotal), 0) from d),
        'carts', coalesce((select jsonb_agg(jsonb_build_object(
                    'conversation_id', conv_id, 'wa_id', wa_id, 'name', name, 'at', updated_at,
                    'total', coalesce(nullif(total, 0), subtotal),
                    'items', (select string_agg(coalesce(i ->> 'display_name', i ->> 'item_name') || ' ×' || (i ->> 'quantity'), '، ')
                                from jsonb_array_elements(cart -> 'items') i where not coalesce((i ->> 'gift')::boolean, false)))
                    order by updated_at desc)
                    from (select * from d order by updated_at desc limit 30) x), '[]'::jsonb),
        'top_items', coalesce((select jsonb_agg(jsonb_build_object('name', n, 'carts', c) order by c desc)
                                 from (select coalesce(i ->> 'display_name', i ->> 'item_name') as n, count(*) as c
                                         from d, jsonb_array_elements(d.cart -> 'items') i
                                        where not coalesce((i ->> 'gift')::boolean, false)
                                        group by 1 order by 2 desc limit 8) x), '[]'::jsonb))),
    -- a pin outside every delivery zone, and no order since
    'out_of_area', (
      with x as (
        select c.wa_id, c.id as conversation_id, (c.state -> 'location' ->> 'lat')::double precision as lat,
               (c.state -> 'location' ->> 'lng')::double precision as lng,
               coalesce(nullif(c.state -> 'location' -> 'geo' ->> 'district', ''), nullif(c.state -> 'location' -> 'geo' ->> 'city', ''), '—') as area,
               (c.state -> 'location' ->> 'at')::timestamptz as at
          from everwake.conversations c
         where c.tenant_id = p_tenant and c.state -> 'location' ->> 'in_delivery_area' = 'false'
           and (c.state -> 'location' ->> 'at')::timestamptz >= p_from and (c.state -> 'location' ->> 'at')::timestamptz < p_to
           and not exists (select 1 from everwake.orders o where o.tenant_id = p_tenant and o.wa_id = c.wa_id
                             and o.status not in ('draft', 'rejected', 'cancelled')
                             and o.placed_at >= (c.state -> 'location' ->> 'at')::timestamptz))
      select jsonb_build_object(
        'count', (select count(*) from x),
        'areas', coalesce((select jsonb_agg(jsonb_build_object('area', area, 'count', n) order by n desc)
                             from (select area, count(*) as n from x group by area order by 2 desc limit 10) a), '[]'::jsonb),
        'points', coalesce((select jsonb_agg(jsonb_build_object('lat', lat, 'lng', lng, 'area', area)) from x where lat is not null), '[]'::jsonb))),
    -- wrote while every branch with opening hours was closed, and ordered nothing within 12 hours
    'while_closed', (
      with firsts as (
        select distinct on (m.wa_id, (m.created_at at time zone t.timezone)::date) m.wa_id, m.created_at
          from everwake.messages m
         where m.tenant_id = p_tenant and m.direction = 'inbound' and m.created_at >= p_from and m.created_at < p_to
         order by m.wa_id, (m.created_at at time zone t.timezone)::date, m.created_at
      ), closed as (
        select f.* from firsts f
         where exists (select 1 from everwake.branches b where b.tenant_id = p_tenant and b.is_active and b.hours <> '{}'::jsonb)
           and not exists (select 1 from everwake.branches b
                            where b.tenant_id = p_tenant and b.is_active
                              and coalesce(everwake.is_open_at(b.hours, (f.created_at at time zone t.timezone)::timestamp), true))
           and not exists (select 1 from everwake.orders o where o.tenant_id = p_tenant and o.wa_id = f.wa_id
                             and o.status not in ('draft', 'rejected', 'cancelled')
                             and o.placed_at >= f.created_at and o.placed_at < f.created_at + interval '12 hours'))
      select jsonb_build_object(
        'count', (select count(*) from closed),
        'by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'count', n) order by h)
                               from (select extract(hour from created_at at time zone t.timezone)::int as h, count(*) as n
                                       from closed group by 1) x), '[]'::jsonb))),
    'refused', (
      with r as (select * from everwake.orders where tenant_id = p_tenant and status in ('rejected', 'cancelled')
                    and placed_at >= p_from and placed_at < p_to)
      select jsonb_build_object(
        'count', (select count(*) from r),
        'value', (select coalesce(sum(total), 0) from r),
        'reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by n desc)
                               from (select coalesce(nullif(btrim(reject_reason), ''), '—') as reason, count(*) as n
                                       from r group by 1 order by 2 desc limit 8) x), '[]'::jsonb))),
    -- talked to the restaurant, never ordered in the period
    'no_order_chats', (
      select count(distinct m.wa_id)
        from everwake.messages m
       where m.tenant_id = p_tenant and m.direction = 'inbound' and m.created_at >= p_from and m.created_at < p_to
         and not exists (select 1 from everwake.orders o where o.tenant_id = p_tenant and o.wa_id = m.wa_id
                           and o.status <> 'draft' and o.placed_at >= p_from)),
    'agent_off', (select count(*) from everwake.pause_contacts
                   where tenant_id = p_tenant and first_message_at >= p_from and first_message_at < p_to),
    'handoffs', (select count(*) from everwake.conversations
                  where tenant_id = p_tenant and attention_at >= p_from and attention_at < p_to));
end $$;

create or replace function everwake.lost_sales(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  return everwake.lost_sales_data(p_tenant, p_from, p_to);
end $$;

-- ---------------------------------------------------------------------
-- The daily report on the owner's WhatsApp
-- settings.daily_report = { enabled, numbers: ["010…"], time: "10:00" }
-- It covers the 24 hours before it is sent.
-- ---------------------------------------------------------------------
create or replace function everwake.report_text(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns text language plpgsql stable as $$
declare
  t   everwake.tenants%rowtype;
  s   jsonb;
  v_pct numeric;
  a   record;
  l   jsonb;
  v   text;
  x   text;
  sym text;
begin
  select * into t from everwake.tenants where id = p_tenant;
  s := everwake.merged_settings(t.settings);
  v_pct := coalesce((s ->> 'aggregator_commission_percent')::numeric, 25);
  sym := ' ' || coalesce(nullif(t.currency_symbol_ar, ''), 'ج');
  select count(*) filter (where status not in ('rejected', 'cancelled')) as orders,
         count(*) filter (where status in ('rejected', 'cancelled')) as refused,
         count(*) filter (where status not in ('rejected', 'cancelled') and delivery_method = 'delivery') as delivery,
         coalesce(sum(total) filter (where status not in ('rejected', 'cancelled')), 0) as revenue
    into a
    from everwake.orders where tenant_id = p_tenant and status <> 'draft' and placed_at >= p_from and placed_at < p_to;
  l := everwake.lost_sales_data(p_tenant, p_from, p_to);

  v := '📊 تقرير ' || coalesce(nullif(t.name_ar, ''), t.name_en) || E'\n'
       || 'من ' || to_char(p_from at time zone t.timezone, 'DD/MM HH24:MI') || ' لـ ' || to_char(p_to at time zone t.timezone, 'DD/MM HH24:MI')
       || E'\n\n'
       || '🧾 الطلبات: ' || a.orders || case when a.orders > 0 then ' (' || a.delivery || ' توصيل · ' || (a.orders - a.delivery) || ' استلام)' else '' end
       || case when a.refused > 0 then ' · اتلغى/اترفض ' || a.refused else '' end || E'\n'
       || '💰 المبيعات: ' || everwake.fmt_int(a.revenue) || sym
       || case when a.orders > 0 then ' · متوسط الطلب ' || everwake.fmt_int(a.revenue / a.orders) || sym else '' end || E'\n'
       || '💸 وفّرت عمولة: ' || everwake.fmt_int(a.revenue * v_pct / 100) || sym || ' (مقارنة بـ ' || trim_scale(v_pct) || '% عمولة التطبيقات)';

  select string_agg(i || '. ' || name || ' (' || trim_scale(q) || ')', ' · ' order by i) into x
    from (select row_number() over (order by sum(oi.quantity) desc) as i, oi.name, sum(oi.quantity) as q
            from everwake.order_items oi join everwake.orders o on o.id = oi.order_id
           where o.tenant_id = p_tenant and o.status not in ('draft', 'rejected', 'cancelled')
             and o.placed_at >= p_from and o.placed_at < p_to and not oi.is_gift
           group by oi.name order by sum(oi.quantity) desc limit 3) q;
  if x is not null then v := v || E'\n' || '🔥 الأكتر طلباً: ' || x; end if;

  if (select count(*) from everwake.branches where tenant_id = p_tenant and is_active) > 1 then
    select string_agg(coalesce(b.name_ar, '—') || ' ' || n || ' · ' || everwake.fmt_int(r) || sym, ' | ' order by r desc) into x
      from (select branch_id, count(*) as n, sum(total) as r from everwake.orders
             where tenant_id = p_tenant and status not in ('draft', 'rejected', 'cancelled') and placed_at >= p_from and placed_at < p_to
             group by branch_id) q left join everwake.branches b on b.id = q.branch_id;
    if x is not null then v := v || E'\n' || '🏪 الفروع: ' || x; end if;
  end if;

  v := v || E'\n' || '👥 عملاء جداد: ' || (select count(*) from everwake.customers where tenant_id = p_tenant and first_seen_at >= p_from and first_seen_at < p_to);

  select string_agg(d.name || ' ' || n || ' طلب' || case when c > 0 then ' (كاش ' || everwake.fmt_int(c) || sym || ')' else '' end, ' · ' order by n desc) into x
    from (select driver_id, count(*) as n,
                 coalesce(sum(total) filter (where coalesce(payment_method, 'cash') ilike '%cash%' or payment_method ilike '%كاش%'), 0) as c
            from everwake.orders where tenant_id = p_tenant and status = 'delivered' and driver_id is not null
             and completed_at >= p_from and completed_at < p_to group by driver_id) q
    join everwake.drivers d on d.id = q.driver_id;
  if x is not null then v := v || E'\n' || '🛵 الطيارين: ' || x; end if;

  v := v || E'\n\n' || '⚠️ فرص ضايعة:'
       || E'\n' || '• سلات مكملتش: ' || (l -> 'abandoned' ->> 'count')
       || case when (l -> 'abandoned' ->> 'value')::numeric > 0 then ' (بقيمة ' || everwake.fmt_int((l -> 'abandoned' ->> 'value')::numeric) || sym || ')' else '' end
       || E'\n' || '• برّه مناطق التوصيل: ' || (l -> 'out_of_area' ->> 'count')
       || coalesce(' — أكتر منطقة: ' || (select ar ->> 'area' from jsonb_array_elements(l -> 'out_of_area' -> 'areas') ar
                                        where ar ->> 'area' <> '—' limit 1), '')
       || E'\n' || '• كتبوا والفروع مقفولة: ' || (l -> 'while_closed' ->> 'count')
       || case when (l ->> 'handoffs')::int > 0 then E'\n' || '🙋 محادثات محتاجة حد من الفريق: ' || (l ->> 'handoffs') else '' end;
  return v;
end $$;

-- the dashboard's preview and "send it now"
create or replace function everwake.report_preview(p_tenant uuid)
returns text language plpgsql stable security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  return everwake.report_text(p_tenant, now() - interval '24 hours', now());
end $$;

create or replace function everwake.queue_report(p_tenant uuid, p_body text)
returns int language plpgsql as $$
declare t everwake.tenants%rowtype; v_ch uuid; v_to text; n int := 0;
begin
  select * into t from everwake.tenants where id = p_tenant;
  select ch.id into v_ch from everwake.whatsapp_channels ch where ch.tenant_id = p_tenant and ch.is_active order by ch.created_at limit 1;
  for v_to in select distinct everwake.wa_phone(x, t.country)
                from jsonb_array_elements_text(coalesce(everwake.merged_settings(t.settings) -> 'daily_report' -> 'numbers', '[]'::jsonb)) x loop
    continue when v_to is null;
    insert into everwake.outbox (tenant_id, channel_id, to_jid, purpose, body, created_by)
    values (p_tenant, v_ch, v_to, 'report', p_body, everwake.current_user_id());
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function everwake.send_report_now(p_tenant uuid)
returns int language plpgsql security definer set search_path = everwake, pg_temp as $$
begin
  perform everwake.require_role(p_tenant, array['owner', 'manager']);
  return everwake.queue_report(p_tenant, everwake.report_text(p_tenant, now() - interval '24 hours', now()));
end $$;

-- from the housekeeping, every minute: each restaurant's report once a day, at its hour
create or replace function everwake.send_due_reports()
returns int language plpgsql as $$
declare r record; n int := 0; v_sent int;
begin
  for r in
    select t.id, (now() at time zone t.timezone) as local_now,
           coalesce(nullif(everwake.merged_settings(t.settings) -> 'daily_report' ->> 'time', ''), '10:00')::time as at_time
      from everwake.tenants t
     where t.status in ('onboarding', 'live')
       and coalesce((everwake.merged_settings(t.settings) -> 'daily_report' ->> 'enabled')::boolean, false)
       and jsonb_array_length(coalesce(everwake.merged_settings(t.settings) -> 'daily_report' -> 'numbers', '[]'::jsonb)) > 0
  loop
    continue when r.local_now::time < r.at_time;
    continue when exists (select 1 from everwake.report_runs where tenant_id = r.id and kind = 'daily' and local_day = r.local_now::date);
    v_sent := everwake.queue_report(r.id, everwake.report_text(r.id, now() - interval '24 hours', now()));
    insert into everwake.report_runs (tenant_id, kind, local_day, recipients) values (r.id, 'daily', r.local_now::date, v_sent);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Who can see and call what
-- ---------------------------------------------------------------------
alter table everwake.report_runs enable row level security;
grant all on everwake.report_runs to service_role;
revoke execute on all functions in schema everwake from public, anon;
revoke execute on function everwake.lost_sales_data(uuid, timestamptz, timestamptz), everwake.report_text(uuid, timestamptz, timestamptz),
  everwake.queue_report(uuid, text), everwake.send_due_reports() from authenticated;
grant execute on all functions in schema everwake to service_role;
grant execute on function
  everwake.savings(uuid), everwake.growth_sources(uuid, timestamptz, timestamptz, text[]),
  everwake.lost_sales(uuid, timestamptz, timestamptz), everwake.report_preview(uuid), everwake.send_report_now(uuid),
  everwake.fmt_int(numeric)
  to authenticated;


-- ---------------------------------------------------------------------
-- From 005_operations.sql: the housekeeping sends the daily reports
-- ---------------------------------------------------------------------
create or replace function everwake.housekeeping()
returns jsonb language plpgsql as $$
declare
  n_release int; n_locks int; n_stuck int; n_buf int; n_snap int := 0; n_busy int; n_rep int;
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

  -- each restaurant's daily report on the owner's WhatsApp, at its hour (009)
  n_rep := everwake.send_due_reports();

  return jsonb_build_object('takeovers_released', n_release, 'locks_cleared', n_locks, 'outbox_requeued', n_stuck,
                            'buffer_cleared', n_buf, 'busy_cleared', n_busy, 'snapshots_rebuilt', n_snap,
                            'reports_queued', n_rep);
end $$;
