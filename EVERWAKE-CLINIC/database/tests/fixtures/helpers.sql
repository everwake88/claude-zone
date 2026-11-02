-- Shared by every test file (\i tests/fixtures/helpers.sql). Session-local helpers.
create or replace function pg_temp.tid() returns uuid language sql as $$ select id from clinic.tenants where slug = 'nile_clinics' $$;
create or replace function pg_temp.doc(p text) returns uuid language sql as $$ select id from clinic.doctors where tenant_id = pg_temp.tid() and code = p $$;
create or replace function pg_temp.loc(p text) returns uuid language sql as $$ select id from clinic.locations where tenant_id = pg_temp.tid() and code = p $$;
create or replace function pg_temp.svc(p text) returns uuid language sql as $$ select id from clinic.services where tenant_id = pg_temp.tid() and name_ar = p and is_active $$;
-- the next local date on this weekday (0 = Sunday), at least p_ahead days away
create or replace function pg_temp.next_dow(p_dow int, p_ahead int default 2) returns date language sql as $$
  select d::date from generate_series(clinic.local_today(pg_temp.tid()) + p_ahead, clinic.local_today(pg_temp.tid()) + p_ahead + 6, interval '1 day') d
   where extract(dow from d) = p_dow limit 1 $$;
create or replace function pg_temp.at(p_date date, p_time text) returns timestamptz language sql as $$
  select (p_date + p_time::time) at time zone 'Africa/Cairo' $$;
-- a WhatsApp message through intake, as Evolution would post it
create or replace function pg_temp.say(p_wa text, p_text text, p_name text default null) returns jsonb language sql as $$
  select clinic.intake(jsonb_build_object('instance', 'nileclinic', 'token', 'demo-token', 'wa_id', p_wa, 'phone', p_wa,
                                          'reply_to', p_wa, 'text', p_text, 'push_name', p_name,
                                          'external_id', 'T-' || md5(random()::text || clock_timestamp()::text))) $$;
create or replace function pg_temp.tool(p_wa text, p_action text, p_details jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select clinic.booking_tool(pg_temp.tid(), p_wa, p_action, p_details::text) $$;
