-- Times in customer messages, bookings and the payment link's expiry, said the Egyptian way (3:34 بالليل, not صباحاً)
-- the part of the day as people say it after a time: الصبح، الضهر، العصر، بالليل (till dawn it's still بالليل)
create or replace function everwake.day_part_ar(t time)
returns text language sql immutable as $$
  select case when t >= '05:00' and t < '12:00' then 'الصبح'
              when t >= '12:00' and t < '15:00' then 'الضهر'
              when t >= '15:00' and t < '18:00' then 'العصر'
              else 'بالليل' end
$$;

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
                 to_char(r.reserve_time, 'FMHH12:MI') || ' ' || everwake.day_part_ar(r.reserve_time) end,
    'guests', r.guests, 'occasion', r.occasion, 'full_name', r.full_name, 'phone', everwake.local_phone(r.phone),
    'requests', r.requests,
    'summary', case when r.summary_at is null then 'not shown yet'
                    when r.summary_at >= r.changed_at then 'shown and still matches — a clear yes can be sent now'
                    else 'shown before, but something changed since — show the updated summary' end)) end
$$;

-- a time the way people say it: "3:34 بالليل", "10 الصبح", "2 الضهر" (not the formal صباحاً / مساءً)
create or replace function everwake.local_clock(p timestamptz, p_tz text, p_lang text default 'ar')
returns text language sql stable as $$
  select case when p_lang = 'en' then to_char(p at time zone p_tz, 'FMHH12:MI AM')
              else to_char(p at time zone p_tz, 'FMHH12:MI') || ' ' || everwake.day_part_ar((p at time zone p_tz)::time) end
$$;
