-- Everwake Orders · patch 2026-10-22 · table bookings (dine-in)
-- Branches take bookings on WhatsApp, by phone only, or not at all; the agent's
-- manage_reservation tool; the ticket to the branch's operations WhatsApp; the
-- dashboard's Table bookings page (confirm / decline / arrived / no-show) — the
-- same as 010_reservations.sql — plus the agent's turn context with the bookings,
-- the bookings line in the owner's daily report, and live updates on the page.
-- Already in the migrations for new installs. Run once in Supabase → SQL Editor,
-- after 2026-10-22_growth.sql.

-- =====================================================================
-- Everwake Orders · 010 · table bookings (dine-in)
--
-- A branch takes bookings on WhatsApp, by phone only (the agent gives the
-- number), or not at all. The agent gathers the booking in conversation —
-- branch, day, time, guests, name, phone, and an occasion or special
-- request if there is one — through the manage_reservation tool, which
-- checks every value (in the future, not too far ahead, while the branch is
-- open, not more guests than the branch seats). It writes the summary the
-- customer confirms; only a booking whose summary they agreed to, unchanged
-- since, is sent. Sending it puts a ticket on the branch's operations
-- WhatsApp and on the dashboard's Reservations page; the team confirms with
-- the customer, and confirming or declining there tells the customer.
-- =====================================================================

alter table everwake.branches
  add column reservations           text not null default 'off' check (reservations in ('off', 'whatsapp', 'phone')),
  add column reservation_note_ar    text,             -- e.g. "الحجز في الويك إند بالتليفون بس"
  add column reservation_max_guests int;              -- null = the restaurant's default
alter table everwake.tenants add column reservation_seq bigint not null default 1000;

create table everwake.reservations (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references everwake.tenants(id) on delete cascade,
  ref_no          text,
  wa_id           text not null,
  conversation_id bigint references everwake.conversations(id) on delete set null,
  customer_id     bigint references everwake.customers(id) on delete set null,
  branch_id       uuid references everwake.branches(id) on delete set null,
  status          text not null default 'draft'
                  check (status in ('draft', 'requested', 'confirmed', 'declined', 'cancelled', 'seated', 'no_show')),
  reserve_date    date,
  reserve_time    time,
  reserved_for    timestamptz,
  guests          int,
  occasion        text,
  full_name       text,
  phone           text,
  requests        text,
  source          text not null default 'whatsapp_agent',
  changed_at      timestamptz not null default now(),   -- last change to what the customer confirms
  summary_at      timestamptz,                          -- when the summary was shown
  requested_at    timestamptz,
  decided_at      timestamptz,
  decided_by      uuid,
  decline_reason  text,
  ops_notified    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, ref_no)
);
create unique index reservations_one_draft_uidx on everwake.reservations (tenant_id, wa_id) where status = 'draft';
create index reservations_board_idx on everwake.reservations (tenant_id, status, reserved_for);
create index reservations_customer_idx on everwake.reservations (tenant_id, wa_id, reserved_for desc);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- which branches book how, and the restaurant's rules
create or replace function everwake.reservation_setup(p_tenant uuid)
returns jsonb language sql stable as $$
  with s as (select everwake.merged_settings(settings) as s from everwake.tenants where id = p_tenant)
  select jsonb_build_object(
    'enabled', exists (select 1 from everwake.branches b where b.tenant_id = p_tenant and b.is_active and b.reservations = 'whatsapp'),
    'branches', coalesce((select jsonb_agg(jsonb_build_object(
                   'id', b.id, 'code', b.code, 'name_ar', b.name_ar, 'name_en', b.name_en, 'mode', b.reservations,
                   'note', b.reservation_note_ar, 'phone', b.phone, 'hours_text', b.hours_text_ar,
                   'max_guests', coalesce(b.reservation_max_guests, nullif(s.s ->> 'reservation_max_guests', '')::int, 20))
                   order by b.sort, b.name_ar)
                   from everwake.branches b where b.tenant_id = p_tenant and b.is_active and b.reservations <> 'off'), '[]'::jsonb),
    'occasions', coalesce(s.s -> 'reservation_occasions',
                          '["عيد ميلاد", "عيد جواز", "خطوبة", "اجتماع عمل", "عزومة عائلية"]'::jsonb),
    'lead_minutes', coalesce(nullif(s.s ->> 'reservation_lead_minutes', '')::int, 60),
    'days_ahead', coalesce(nullif(s.s ->> 'reservation_days_ahead', '')::int, 30))
  from s
$$;

create or replace function everwake.local_phone(p text)
returns text language sql immutable as $$
  select case when p is null then null when p ~ '^20[0-9]{10}$' then '0' || substr(p, 3) else p end
$$;

-- a booking as people read it
create or replace function everwake.reservation_view(r everwake.reservations)
returns jsonb language sql stable as $$
  select case when r.id is null then null else jsonb_strip_nulls(jsonb_build_object(
    'ref_no', r.ref_no, 'status', r.status,
    'branch', (select b.name_ar from everwake.branches b where b.id = r.branch_id),
    'branch_code', (select b.code from everwake.branches b where b.id = r.branch_id),
    'date', to_char(r.reserve_date, 'YYYY-MM-DD'),
    'day', case when r.reserve_date is not null then
             (array['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'])[extract(dow from r.reserve_date)::int + 1]
             || ' ' || to_char(r.reserve_date, 'DD/MM') end,
    'time', to_char(r.reserve_time, 'HH24:MI'),
    'time_ar', case when r.reserve_time is not null then
                 to_char(r.reserve_time, 'FMHH12:MI') || case when r.reserve_time < '12:00' then ' صباحاً' else ' مساءً' end end,
    'guests', r.guests, 'occasion', r.occasion, 'full_name', r.full_name, 'phone', everwake.local_phone(r.phone),
    'requests', r.requests,
    'summary', case when r.summary_at is null then 'not shown yet'
                    when r.summary_at >= r.changed_at then 'shown and still matches — a clear yes can be sent now'
                    else 'shown before, but something changed since — show the updated summary' end)) end
$$;

-- the summary the customer confirms (their language)
create or replace function everwake.reservation_summary(r everwake.reservations, p_lang text)
returns text language plpgsql stable as $$
declare v jsonb := everwake.reservation_view(r);
begin
  if p_lang = 'en' then
    return 'Your booking:' || E'\n'
      || '🏪 Branch: ' || coalesce(v ->> 'branch', '') || E'\n'
      || '📅 ' || to_char(r.reserve_date, 'Dy DD/MM') || ' · ' || to_char(r.reserve_time, 'FMHH12:MI AM') || E'\n'
      || '👥 ' || r.guests || case when r.guests = 1 then ' guest' else ' guests' end || E'\n'
      || coalesce('🎉 Occasion: ' || r.occasion || E'\n', '')
      || '👤 ' || coalesce(r.full_name, '') || ' · 📞 ' || coalesce(v ->> 'phone', '')
      || coalesce(E'\n' || '📝 ' || r.requests, '');
  end if;
  return 'تفاصيل الحجز:' || E'\n'
    || '🏪 الفرع: ' || coalesce(v ->> 'branch', '') || E'\n'
    || '📅 ' || coalesce(v ->> 'day', '') || ' · الساعة ' || coalesce(v ->> 'time_ar', '') || E'\n'
    || '👥 ' || r.guests || case when r.guests between 3 and 10 then ' أشخاص' else ' شخص' end || E'\n'
    || coalesce('🎉 المناسبة: ' || r.occasion || E'\n', '')
    || '👤 باسم: ' || coalesce(r.full_name, '') || ' · 📞 ' || coalesce(v ->> 'phone', '')
    || coalesce(E'\n' || '📝 طلبات خاصة: ' || r.requests, '');
end $$;

-- the ticket for the branch team
create or replace function everwake.reservation_ticket(r everwake.reservations, p_headline text)
returns text language sql stable as $$
  select p_headline || ' ' || coalesce(r.ref_no, '') || E'\n'
    || '🏪 فرع ' || coalesce((select name_ar from everwake.branches where id = r.branch_id), '') || E'\n'
    || '📅 ' || coalesce(v ->> 'day', '') || ' · الساعة ' || coalesce(v ->> 'time_ar', '') || E'\n'
    || '👥 ' || r.guests || ' أشخاص' || coalesce(' · 🎉 ' || r.occasion, '') || E'\n'
    || '👤 ' || coalesce(r.full_name, '') || ' · 📞 ' || coalesce(v ->> 'phone', '')
    || coalesce(E'\n' || '📝 ' || r.requests, '')
  from (select everwake.reservation_view(r) as v) x
$$;

create or replace function everwake.queue_reservation_ticket(r everwake.reservations, p_body text)
returns boolean language plpgsql as $$
declare v_to text; v_ch uuid;
begin
  select everwake.wa_phone(coalesce(nullif(b.ops_whatsapp, ''), nullif(everwake.merged_settings(t.settings) ->> 'ops_whatsapp', '')), t.country)
    into v_to
    from everwake.tenants t left join everwake.branches b on b.id = r.branch_id
   where t.id = r.tenant_id;
  if v_to is null then return false; end if;
  select ch.id into v_ch from everwake.whatsapp_channels ch where ch.tenant_id = r.tenant_id and ch.is_active order by ch.created_at limit 1;
  insert into everwake.outbox (tenant_id, channel_id, to_jid, purpose, body) values (r.tenant_id, v_ch, v_to, 'order_ticket', p_body);
  return true;
end $$;

-- ---------------------------------------------------------------------
-- The agent's tool
-- actions: update (details_json with any of branch, date YYYY-MM-DD,
-- time HH:MM, guests, full_name, phone, occasion, requests) · summary ·
-- submit · cancel · status
-- ---------------------------------------------------------------------
create or replace function everwake.reservation_tool(p_tenant uuid, p_wa text, p_action text, p_details text)
returns jsonb language plpgsql as $$
declare
  t        everwake.tenants%rowtype;
  setup    jsonb := everwake.reservation_setup(p_tenant);
  v        jsonb;
  r        everwake.reservations%rowtype;
  b        everwake.branches%rowtype;
  bset     jsonb;
  conv     everwake.conversations%rowtype;
  cust     everwake.customers%rowtype;
  v_action text := lower(btrim(coalesce(p_action, '')));
  problems jsonb := '[]'::jsonb;
  missing  text[] := '{}';
  v_local  timestamp;
  v_txt    text;
  v_d      date;
  v_t      time;
  v_n      int;
  v_max    int;
  v_changed boolean := false;
  v_ready  boolean;
  v_lang   text := everwake.customer_language(p_tenant, p_wa);
  upcoming jsonb;
begin
  select * into t from everwake.tenants where id = p_tenant;
  begin
    v := coalesce(nullif(btrim(coalesce(p_details, '')), '')::jsonb, '{}'::jsonb);
  exception when others then
    v := '{}'::jsonb;
    problems := problems || jsonb_build_object('problem', 'BAD_DETAILS_JSON', 'fact', 'details_json was not a JSON object — send {"field":"value"}');
  end;
  if jsonb_typeof(v) <> 'object' then v := '{}'::jsonb; end if;

  upcoming := coalesce((select jsonb_agg(everwake.reservation_view(x) order by x.reserved_for)
                          from everwake.reservations x
                         where x.tenant_id = p_tenant and x.wa_id = p_wa and x.status in ('requested', 'confirmed')
                           and x.reserved_for > now() - interval '3 hours'), '[]'::jsonb);

  if not coalesce((setup ->> 'enabled')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'NOT_TAKEN_ON_WHATSAPP',
      'fact', 'this restaurant does not take table bookings on WhatsApp',
      'by_phone', (select coalesce(jsonb_agg(jsonb_build_object('branch', x ->> 'name_ar', 'phone', x ->> 'phone', 'note', x ->> 'note')), '[]'::jsonb)
                     from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'phone'),
      'upcoming', upcoming);
  end if;
  if v_action not in ('update', 'summary', 'submit', 'cancel', 'status') then
    return jsonb_build_object('ok', false, 'error', 'UNKNOWN_ACTION', 'fact', 'action is one of: update, summary, submit, cancel, status');
  end if;

  -- ---- cancel -----------------------------------------------------------
  if v_action = 'cancel' then
    delete from everwake.reservations where tenant_id = p_tenant and wa_id = p_wa and status = 'draft' returning * into r;
    if found then return jsonb_build_object('ok', true, 'status', 'DRAFT_DISCARDED', 'upcoming', upcoming); end if;
    select * into r from everwake.reservations
     where tenant_id = p_tenant and wa_id = p_wa and status in ('requested', 'confirmed') and reserved_for > now()
       and (nullif(v ->> 'ref_no', '') is null or upper(ref_no) = upper(v ->> 'ref_no'))
     order by reserved_for limit 1 for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'NOTHING_TO_CANCEL', 'upcoming', upcoming); end if;
    update everwake.reservations set status = 'cancelled', decided_at = now(), decline_reason = 'cancelled by the customer on WhatsApp'
     where id = r.id returning * into r;
    perform everwake.queue_reservation_ticket(r, everwake.reservation_ticket(r, '❌ العميل لغى الحجز'));
    return jsonb_build_object('ok', true, 'status', 'CANCELLED', 'reservation', everwake.reservation_view(r),
                              'fact', 'cancelled; the branch team was told');
  end if;

  -- ---- the booking in progress -------------------------------------------------
  select * into r from everwake.reservations where tenant_id = p_tenant and wa_id = p_wa and status = 'draft' for update;
  if not found and v_action = 'status' then
    return jsonb_build_object('ok', true, 'status', 'NO_BOOKING_IN_PROGRESS', 'upcoming', upcoming);
  end if;
  if not found then
    select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
    select * into cust from everwake.customers where id = conv.customer_id;
    insert into everwake.reservations (tenant_id, wa_id, conversation_id, customer_id, full_name, phone)
    values (p_tenant, p_wa, conv.id, cust.id, nullif(cust.full_name, ''),
            case when not coalesce(cust.phone_hidden, false) then everwake.wa_phone(coalesce(cust.phone, case when p_wa ~ '^[0-9]+$' then p_wa end), t.country) end)
    returning * into r;
    -- one branch takes bookings: that is the branch
    if jsonb_array_length((select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'whatsapp')) = 1
       and (select count(*) from jsonb_array_elements(setup -> 'branches')) = 1 then
      update everwake.reservations set branch_id = (setup -> 'branches' -> 0 ->> 'id')::uuid where id = r.id returning * into r;
    end if;
  end if;

  if v_action = 'update' then
    -- branch
    if nullif(btrim(coalesce(v ->> 'branch', '')), '') is not null then
      v_txt := everwake.norm(v ->> 'branch');
      select * into b from everwake.branches x
       where x.tenant_id = p_tenant and x.is_active
         and (everwake.norm(x.code) = v_txt or everwake.norm(x.name_ar) = v_txt or everwake.norm(coalesce(x.name_en, '')) = v_txt
              or v_txt = any (select everwake.norm(a) from unnest(x.aliases) a)
              or (length(v_txt) >= 3 and (everwake.norm(x.name_ar) like '%' || v_txt || '%' or v_txt like '%' || everwake.norm(x.name_ar) || '%')))
       order by (everwake.norm(x.code) = v_txt or everwake.norm(x.name_ar) = v_txt) desc, x.sort
       limit 1;
      if b.id is null then
        problems := problems || jsonb_build_object('problem', 'BRANCH_UNKNOWN', 'said', v ->> 'branch',
          'branches_taking_bookings', (select jsonb_agg(x ->> 'name_ar') from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'whatsapp'));
      elsif b.reservations = 'phone' then
        problems := problems || jsonb_build_object('problem', 'BOOKED_BY_PHONE_ONLY', 'branch', b.name_ar, 'phone', b.phone, 'note', b.reservation_note_ar,
          'fact', 'this branch takes bookings by phone only — give them the number');
      elsif b.reservations = 'off' then
        problems := problems || jsonb_build_object('problem', 'NO_BOOKINGS_AT_THIS_BRANCH', 'branch', b.name_ar,
          'branches_taking_bookings', (select jsonb_agg(x ->> 'name_ar') from jsonb_array_elements(setup -> 'branches') x where x ->> 'mode' = 'whatsapp'));
      elsif r.branch_id is distinct from b.id then
        r.branch_id := b.id; v_changed := true;
      end if;
    end if;
    -- day and time
    if nullif(btrim(coalesce(v ->> 'date', '')), '') is not null then
      begin
        v_d := to_date(btrim(v ->> 'date'), 'YYYY-MM-DD');
        if btrim(v ->> 'date') !~ '^\d{4}-\d{1,2}-\d{1,2}$' then raise exception 'format'; end if;
        if r.reserve_date is distinct from v_d then r.reserve_date := v_d; v_changed := true; end if;
      exception when others then
        problems := problems || jsonb_build_object('problem', 'DATE_FORMAT', 'said', v ->> 'date', 'fact', 'send the date as YYYY-MM-DD, worked out from "Now" in FACTS');
      end;
    end if;
    if nullif(btrim(coalesce(v ->> 'time', '')), '') is not null then
      begin
        v_txt := btrim(v ->> 'time');
        if v_txt ~ '^\d{1,2}$' then v_txt := v_txt || ':00'; end if;
        if v_txt !~ '^\d{1,2}:\d{2}$' then raise exception 'format'; end if;
        v_t := v_txt::time;
        if r.reserve_time is distinct from v_t then r.reserve_time := v_t; v_changed := true; end if;
      exception when others then
        problems := problems || jsonb_build_object('problem', 'TIME_FORMAT', 'said', v ->> 'time', 'fact', 'send the time as HH:MM on the 24-hour clock (9 at night = 21:00)');
      end;
    end if;
    -- guests
    if nullif(btrim(coalesce(v ->> 'guests', '')), '') is not null then
      begin
        v_n := (v ->> 'guests')::numeric::int;
        if v_n < 1 then raise exception 'few'; end if;
        if r.guests is distinct from v_n then r.guests := v_n; v_changed := true; end if;
      exception when others then
        problems := problems || jsonb_build_object('problem', 'GUESTS_FORMAT', 'said', v ->> 'guests', 'fact', 'guests is a whole number');
      end;
    end if;
    -- who
    if v ? 'full_name' and nullif(btrim(v ->> 'full_name'), '') is not null and r.full_name is distinct from btrim(v ->> 'full_name') then
      r.full_name := left(btrim(v ->> 'full_name'), 80); v_changed := true;
    end if;
    if nullif(btrim(coalesce(v ->> 'phone', '')), '') is not null then
      v_txt := everwake.wa_phone(v ->> 'phone', t.country);
      if v_txt is null then
        problems := problems || jsonb_build_object('problem', 'PHONE_FORMAT', 'said', v ->> 'phone', 'fact', 'that does not look like a phone number — ask again');
      elsif r.phone is distinct from v_txt then r.phone := v_txt; v_changed := true;
      end if;
    end if;
    if v ? 'occasion' and r.occasion is distinct from nullif(btrim(v ->> 'occasion'), '') then
      r.occasion := left(nullif(btrim(v ->> 'occasion'), ''), 80); v_changed := true;
    end if;
    if v ? 'requests' and r.requests is distinct from nullif(btrim(v ->> 'requests'), '') then
      r.requests := left(nullif(btrim(v ->> 'requests'), ''), 400); v_changed := true;
    end if;
    if v_changed then
      update everwake.reservations
         set branch_id = r.branch_id, reserve_date = r.reserve_date, reserve_time = r.reserve_time, guests = r.guests,
             full_name = r.full_name, phone = r.phone, occasion = r.occasion, requests = r.requests,
             changed_at = clock_timestamp(), updated_at = now()
       where id = r.id returning * into r;
    end if;
  end if;

  -- ---- does it work as it stands? ---------------------------------------------------
  b := null;
  if r.branch_id is not null then
    select * into b from everwake.branches where id = r.branch_id;
    select x into bset from jsonb_array_elements(setup -> 'branches') x where x ->> 'id' = r.branch_id::text;
    v_max := coalesce((bset ->> 'max_guests')::int, 20);
  end if;
  if r.reserve_date is not null and r.reserve_time is not null then
    v_local := r.reserve_date + r.reserve_time;
    r.reserved_for := v_local at time zone t.timezone;
    update everwake.reservations set reserved_for = r.reserved_for where id = r.id and reserved_for is distinct from r.reserved_for;
    if r.reserved_for < now() + make_interval(mins => (setup ->> 'lead_minutes')::int) then
      problems := problems || jsonb_build_object('problem', 'TOO_SOON',
        'fact', 'bookings are taken at least ' || (setup ->> 'lead_minutes') || ' minutes ahead — suggest a later time, or the branch number for right now',
        'earliest', to_char((now() + make_interval(mins => (setup ->> 'lead_minutes')::int)) at time zone t.timezone, 'YYYY-MM-DD HH24:MI'));
    elsif r.reserved_for > now() + make_interval(days => (setup ->> 'days_ahead')::int) then
      problems := problems || jsonb_build_object('problem', 'TOO_FAR_AHEAD', 'fact', 'bookings are taken up to ' || (setup ->> 'days_ahead') || ' days ahead');
    elsif b.id is not null and everwake.is_open_at(b.hours, v_local) = false then
      problems := problems || jsonb_build_object('problem', 'BRANCH_CLOSED_AT_THAT_TIME', 'branch', b.name_ar, 'hours', b.hours_text_ar,
        'fact', 'the branch is closed at that time — suggest a time within its hours');
    end if;
  end if;
  if r.guests is not null and v_max is not null and r.guests > v_max then
    problems := problems || jsonb_build_object('problem', 'GROUP_TOO_LARGE', 'max_guests', v_max,
      'fact', 'more than ' || v_max || ' guests is arranged by the team — take their details and mark a handoff');
  end if;

  if r.branch_id is null then missing := array_append(missing, 'branch'); end if;
  if r.reserve_date is null then missing := array_append(missing, 'date'); end if;
  if r.reserve_time is null then missing := array_append(missing, 'time'); end if;
  if r.guests is null then missing := array_append(missing, 'guests'); end if;
  if r.full_name is null then missing := array_append(missing, 'full_name'); end if;
  if r.phone is null then missing := array_append(missing, 'phone'); end if;
  v_ready := cardinality(missing) = 0
             and not exists (select 1 from jsonb_array_elements(problems) p
                              where p ->> 'problem' in ('TOO_SOON', 'TOO_FAR_AHEAD', 'BRANCH_CLOSED_AT_THAT_TIME', 'GROUP_TOO_LARGE'));

  if v_action = 'summary' then
    if not v_ready then
      return jsonb_build_object('ok', false, 'error', 'NOT_READY', 'reservation', everwake.reservation_view(r),
                                'missing', to_jsonb(missing), 'problems', problems);
    end if;
    update everwake.reservations set summary_at = clock_timestamp() where id = r.id returning * into r;
    return jsonb_build_object('ok', true, 'status', 'SUMMARY_READY', 'summary_text', everwake.reservation_summary(r, v_lang),
      'fact', 'show this summary as it is and ask them to confirm; send it only after a clear yes');
  end if;

  if v_action = 'submit' then
    if not v_ready then
      return jsonb_build_object('ok', false, 'error', 'NOT_READY', 'reservation', everwake.reservation_view(r),
                                'missing', to_jsonb(missing), 'problems', problems);
    end if;
    if r.summary_at is null or r.summary_at < r.changed_at then
      return jsonb_build_object('ok', false, 'error', 'SUMMARY_NOT_CONFIRMED',
        'fact', 'show the summary first (action summary) and send only after they say yes to it — it changed since, or was never shown');
    end if;
    update everwake.tenants set reservation_seq = reservation_seq + 1 where id = p_tenant returning * into t;
    update everwake.reservations
       set status = 'requested', requested_at = now(), updated_at = now(), ref_no = t.order_no_prefix || '-R' || t.reservation_seq
     where id = r.id returning * into r;
    update everwake.reservations
       set ops_notified = everwake.queue_reservation_ticket(r, everwake.reservation_ticket(r, '🍽 طلب حجز ترابيزة')
                            || E'\n\n' || 'كلّموا العميل وأكّدوا الحجز، وبعدها دوسوا «تأكيد» في صفحة الحجوزات عشان يوصله تأكيد على الواتساب.')
     where id = r.id returning * into r;
    return jsonb_build_object('ok', true, 'status', 'REQUESTED', 'ref_no', r.ref_no, 'reservation', everwake.reservation_view(r),
      'fact', 'sent to the branch team — they will contact the customer to confirm it. It is NOT confirmed yet: say so, warmly, with the reference number.');
  end if;

  -- update / status
  return jsonb_build_object('ok', true, 'status', case when v_changed then 'SAVED' else 'UNCHANGED' end,
    'reservation', everwake.reservation_view(r), 'missing', to_jsonb(missing), 'problems', problems,
    'ready_for_summary', v_ready, 'occasions', setup -> 'occasions', 'upcoming', upcoming);
end $$;

-- ---------------------------------------------------------------------
-- The dashboard: confirm, decline, seated, no-show, cancel
-- ---------------------------------------------------------------------
create or replace function everwake.set_reservation_status(p_id bigint, p_status text, p_note text default null,
                                                            p_notify boolean default true)
returns jsonb language plpgsql security definer set search_path = everwake, pg_temp as $$
declare
  r      everwake.reservations%rowtype;
  s      jsonb;
  v      jsonb;
  v_lang text;
  v_body text;
  v_sent boolean := false;
  v_tpl  text;
begin
  select * into r from everwake.reservations where id = p_id for update;
  if not found or r.status = 'draft' then raise exception 'Booking not found'; end if;
  perform everwake.require_role(r.tenant_id, array['owner', 'manager', 'staff']);
  if everwake.current_user_id() is not null and not everwake.can_see_branch(r.tenant_id, r.branch_id) then
    raise exception 'not allowed for this branch' using errcode = '42501';
  end if;
  if not (
       (r.status = 'requested' and p_status in ('confirmed', 'declined', 'cancelled'))
    or (r.status = 'confirmed' and p_status in ('seated', 'no_show', 'cancelled'))) then
    raise exception 'This booking is % and cannot become %', r.status, p_status;
  end if;
  update everwake.reservations
     set status = p_status, decided_at = now(), decided_by = everwake.current_user_id(), updated_at = now(),
         decline_reason = case when p_status in ('declined', 'cancelled') then nullif(btrim(coalesce(p_note, '')), '') else decline_reason end
   where id = r.id returning * into r;

  if coalesce(p_notify, true) and p_status in ('confirmed', 'declined', 'cancelled') then
    s := everwake.merged_settings((select settings from everwake.tenants where id = r.tenant_id));
    v_lang := everwake.customer_language(r.tenant_id, r.wa_id);
    v := everwake.reservation_view(r);
    v_tpl := nullif(btrim(coalesce(s -> 'templates' ->> ('reservation_' || p_status || '_' || v_lang), '')), '');
    v_body := coalesce(nullif(everwake.render_template(v_tpl, jsonb_build_object('ref_no', r.ref_no, 'branch', v ->> 'branch',
                                                  'day', v ->> 'day', 'time', v ->> 'time_ar', 'guests', r.guests,
                                                  'reason', coalesce(nullif(btrim(coalesce(p_note, '')), ''), ''))), ''),
      case
        when v_lang = 'en' and p_status = 'confirmed' then
          'Your table is confirmed ✅ ' || r.ref_no || E'\n' || coalesce(v ->> 'branch', '') || ' · ' || to_char(r.reserve_date, 'Dy DD/MM')
          || ' · ' || to_char(r.reserve_time, 'FMHH12:MI AM') || ' · ' || r.guests || ' guests' || E'\n' || 'See you then!'
        when v_lang = 'en' and p_status = 'declined' then
          'Sorry, we could not confirm booking ' || r.ref_no || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), '') || '. Shall we look at another time?'
        when v_lang = 'en' then 'Booking ' || r.ref_no || ' is cancelled' || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), '') || '.'
        when p_status = 'confirmed' then
          'تم تأكيد حجزك ✅ ' || r.ref_no || E'\n' || '🏪 ' || coalesce(v ->> 'branch', '') || ' · 📅 ' || coalesce(v ->> 'day', '')
          || ' · الساعة ' || coalesce(v ->> 'time_ar', '') || ' · 👥 ' || r.guests || E'\n' || 'مستنيينك!'
        when p_status = 'declined' then
          'للأسف مش هنقدر نأكد الحجز ' || r.ref_no || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), '') || '. تحب نشوف معاد تاني؟'
        else 'تم إلغاء الحجز ' || r.ref_no || coalesce(' — ' || nullif(btrim(coalesce(p_note, '')), ''), '') || '.'
      end);
    perform everwake.queue_customer_message(r.tenant_id, r.wa_id, 'order_status', v_body, p_user => everwake.current_user_id());
    v_sent := true;
  end if;
  return jsonb_build_object('id', r.id, 'status', r.status, 'notified', v_sent);
end $$;

-- ---------------------------------------------------------------------
-- Who can see and call what
-- ---------------------------------------------------------------------
alter table everwake.reservations enable row level security;
-- branch staff see their branches' bookings; a booking still being written in the chat is not shown
create policy member_read on everwake.reservations for select to authenticated
  using (tenant_id = any ((select everwake.my_tenant_ids())::uuid[]) and everwake.can_see_branch(tenant_id, branch_id) and status <> 'draft');
grant select on everwake.reservations to authenticated;
grant all on everwake.reservations to service_role;

revoke execute on all functions in schema everwake from public, anon;
revoke execute on function everwake.reservation_tool(uuid, text, text, text),
  everwake.queue_reservation_ticket(everwake.reservations, text) from authenticated;
grant execute on all functions in schema everwake to service_role;
grant execute on function everwake.set_reservation_status(bigint, text, text, boolean), everwake.reservation_setup(uuid),
  everwake.reservation_view(everwake.reservations), everwake.local_phone(text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 004 · the agent sees the booking rules, the booking in progress and
-- what is coming up, every turn
-- ---------------------------------------------------------------------
create or replace function everwake.turn_context(p_tenant uuid, p_wa text)
returns jsonb language plpgsql as $$
declare
  t       everwake.tenants%rowtype;
  conv    everwake.conversations%rowtype;
  cust    everwake.customers%rowtype;
  v_bid   text;
  v_ids   bigint[];
  v_phones text[];
  v_all   everwake.menu_snapshot%rowtype;
  v_br    everwake.menu_snapshot%rowtype;
begin
  perform everwake.ensure_snapshot(p_tenant);
  select * into t from everwake.tenants where id = p_tenant;
  select * into conv from everwake.conversations where tenant_id = p_tenant and wa_id = p_wa;
  select * into cust from everwake.customers where id = conv.customer_id;

  -- a restaurant with one branch never has to ask which one
  if (conv.state -> 'branch' ->> 'id') is null
     and (select count(*) from everwake.branches b where b.tenant_id = p_tenant and b.is_active) = 1 then
    update everwake.conversations c
       set state = c.state || jsonb_build_object('branch', (
                     select jsonb_build_object('id', b.id, 'code', b.code, 'name_ar', b.name_ar,
                                               'source', 'only_branch', 'set_at', now())
                       from everwake.branches b where b.tenant_id = p_tenant and b.is_active))
     where c.id = conv.id
    returning * into conv;
  end if;
  v_bid := conv.state -> 'branch' ->> 'id';

  -- previous orders: by this customer, or by the number they gave us
  v_ids := array_remove(array[cust.id, nullif(conv.state -> 'contact' ->> 'linked_customer_id', '')::bigint], null);
  select array_agg(ci.value) into v_phones
    from everwake.customer_identities ci where ci.customer_id = any(v_ids) and ci.kind = 'phone';

  select * into v_all from everwake.menu_snapshot where tenant_id = p_tenant and scope = 'all';
  select * into v_br from everwake.menu_snapshot where tenant_id = p_tenant and scope = v_bid;

  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'slug', t.slug, 'status', t.status, 'agent_enabled', t.agent_enabled),
    'state', coalesce(conv.state, '{}'::jsonb),
    'conversation', jsonb_build_object('id', conv.id, 'mode', conv.mode, 'needs_attention', conv.needs_attention,
                                       'created_at', conv.created_at),
    'customer', jsonb_build_object(
       'id', cust.id, 'wa_id', cust.wa_id, 'phone', cust.phone, 'phone_hidden', cust.phone_hidden,
       'display_name', cust.display_name, 'full_name', cust.full_name, 'alt_phone', cust.alt_phone,
       'food_prefs', cust.food_prefs, 'language', cust.language, 'tags', to_jsonb(cust.tags),
       'orders_count', (select count(*) from everwake.orders o
                         where o.tenant_id = p_tenant and o.status not in ('draft', 'cancelled', 'rejected')
                           and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))),
       'first_seen_at', cust.first_seen_at),
    'active_order', coalesce((select to_jsonb(o) from everwake.orders o
                               where o.tenant_id = p_tenant and o.wa_id = p_wa and o.status = 'draft'
                               order by o.updated_at desc limit 1), 'null'::jsonb),
    'last_orders', coalesce((
       select jsonb_agg(x order by (x ->> 'placed_at') desc) from (
         select jsonb_build_object(
                  'order_no', o.order_no, 'status', o.status, 'placed_at', o.placed_at,
                  'branch_id', o.branch_id, 'branch_name', b.name_ar, 'total', o.total,
                  'delivery_method', o.delivery_method, 'payment_method', o.payment_method,
                  'address_text', o.address_text, 'eta_text', o.eta_text,
                  'last_update_at', greatest(o.accepted_at, o.ready_at, o.out_for_delivery_at, o.completed_at, o.cancelled_at),
                  -- the restaurant's driver on it, and how far they were at their last position
                  'driver', (select jsonb_build_object('name', d.name, 'phone', d.phone) from everwake.drivers d where d.id = o.driver_id),
                  'tracking', case when o.delivery_track_at > now() - interval '10 minutes' then
                                jsonb_build_object('km_left', o.delivery_km_left, 'eta_min', o.delivery_eta_min,
                                                   'minutes_ago', floor(extract(epoch from now() - o.delivery_track_at) / 60)) end,
                  'items', coalesce((select jsonb_agg(jsonb_build_object(
                                       'code', oi.item_code, 'name', oi.name, 'quantity', oi.quantity, 'unit', oi.unit,
                                       'choices', oi.choices, 'notes', oi.notes, 'line_total', oi.line_total,
                                       'gift', oi.is_gift) order by oi.line_no)
                                       from everwake.order_items oi where oi.order_id = o.id), '[]'::jsonb)) as x
           from everwake.orders o
           left join everwake.branches b on b.id = o.branch_id
          where o.tenant_id = p_tenant and o.status <> 'draft'
            and (o.customer_id = any(v_ids) or (o.customer ->> 'phone') = any(coalesce(v_phones, '{}')))
          order by o.placed_at desc nulls last
          limit 3) q), '[]'::jsonb),
    'saved_addresses', coalesce((
       select jsonb_agg(jsonb_build_object('id', a.id, 'text', a.address_text, 'area', a.area, 'street', a.street,
                                           'building', a.building, 'floor', a.floor, 'apartment', a.apartment,
                                           'landmark', a.landmark, 'zone_id', a.zone_id, 'branch_id', a.branch_id,
                                           'has_pin', a.lat is not null, 'last_used_at', a.last_used_at)
                        order by a.last_used_at desc)
         from (select * from everwake.customer_addresses
                where customer_id = any(v_ids) order by last_used_at desc limit 3) a), '[]'::jsonb),
    'recent_messages', coalesce((
       select jsonb_agg(jsonb_build_object('direction', m.direction, 'sender', m.sender, 'kind', m.kind,
                                           'text', m.body, 'at', m.created_at, 'staff_name', m.staff_name,
                                           'status', m.status)
                        order by m.created_at)
         from (select mm.*, tm.display_name as staff_name
                 from everwake.messages mm
                 left join everwake.tenant_members tm on tm.tenant_id = mm.tenant_id and tm.user_id = mm.staff_user_id
                where mm.tenant_id = p_tenant and mm.wa_id = p_wa and mm.status <> 'failed'
                order by mm.created_at desc limit 20) m), '[]'::jsonb),
    'pause', (select jsonb_build_object('apologized_at', pc.apologized_at, 'resume_notified_at', pc.resume_notified_at,
                                        'paused_at', ap.started_at, 'resumed_at', ap.ended_at)
                from everwake.pause_contacts pc join everwake.agent_pauses ap on ap.id = pc.pause_id
               where pc.tenant_id = p_tenant and pc.wa_id = p_wa and pc.last_message_at > now() - interval '24 hours'
               order by pc.last_message_at desc limit 1),
    -- table bookings (010): the rules, the one in progress, and what is coming up
    'reservation_setup', everwake.reservation_setup(p_tenant),
    'reservation', (select everwake.reservation_view(x) from everwake.reservations x
                     where x.tenant_id = p_tenant and x.wa_id = p_wa and x.status = 'draft'),
    'reservations_upcoming', coalesce((select jsonb_agg(everwake.reservation_view(x) order by x.reserved_for)
                                         from everwake.reservations x
                                        where x.tenant_id = p_tenant and x.wa_id = p_wa and x.status in ('requested', 'confirmed')
                                          and x.reserved_for > now() - interval '3 hours'), '[]'::jsonb),
    'all_lookup', coalesce(v_all.lookup, '{}'::jsonb),
    'all_digest', coalesce(v_all.digest_text, ''),
    'branch_lookup', coalesce(v_br.lookup, '{}'::jsonb),
    'menu_digest', coalesce(v_br.digest_text, v_all.digest_text, ''),
    'menu_version', coalesce(v_br.version_hash, v_all.version_hash, 'none'),
    'current_review_hash', everwake.review_hash(p_tenant, p_wa));
end $$;

-- ---------------------------------------------------------------------
-- 009 · the daily report counts the booking requests
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

  -- table bookings (010): asked for in the period, and what still waits for the team
  select case when count(*) = 0 and count(*) filter (where status = 'requested') = 0 then null
              else count(*) || ' طلب حجز' || case when count(*) filter (where status = 'requested') > 0
                                                 then ' · مستنيين تأكيد: ' || count(*) filter (where status = 'requested') else '' end end
    into x
    from everwake.reservations where tenant_id = p_tenant and status <> 'draft' and requested_at >= p_from and requested_at < p_to;
  if x is not null then v := v || E'\n' || '🍽 الحجوزات: ' || x; end if;

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

-- ---------------------------------------------------------------------
-- 090 · a new booking request rings on the dashboard
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table everwake.reservations;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
