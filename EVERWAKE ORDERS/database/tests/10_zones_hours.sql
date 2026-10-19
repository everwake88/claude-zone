-- Delivery zones, typed areas and opening hours
do $$
declare
  t uuid := (select id from everwake.tenants where slug = 'nile_grill');
  z record;
  m jsonb;
begin
  -- a pin in Zamalek → the Zamalek polygon
  select * into z from everwake.zones_at(t, 30.0610, 31.2200) limit 1;
  assert z.zone_name = 'الزمالك', 'zamalek pin should hit the zamalek zone, got ' || coalesce(z.zone_name, 'nothing');
  assert z.branch_code = 'zamalek';
  assert z.delivery_fee = 20, 'zone fee overrides the branch fee';

  -- a pin in Dokki → the radius zone
  select * into z from everwake.zones_at(t, 30.0400, 31.2080) limit 1;
  assert z.zone_name = 'الدقي والمهندسين', 'dokki pin should hit the radius zone, got ' || coalesce(z.zone_name, 'nothing');

  -- a pin in Maadi → maadi
  select * into z from everwake.zones_at(t, 29.9600, 31.2600) limit 1;
  assert z.branch_code = 'maadi';

  -- a pin in Alexandria → no zone
  assert not exists (select 1 from everwake.zones_at(t, 31.2001, 29.9187)), 'alexandria is outside every zone';

  -- typed areas
  m := everwake.match_area(t, 'أنا ساكن في المعادي جنب دجلة');
  assert (m ->> 'branches')::int = 1 and m -> 'matches' -> 0 ->> 'branch_code' = 'maadi', 'typed maadi: ' || m::text;
  m := everwake.match_area(t, 'Mohandessin, Shehab street');
  assert m -> 'matches' -> 0 ->> 'branch_code' = 'zamalek', 'typed mohandessin: ' || m::text;
  m := everwake.match_area(t, 'التجمع الخامس');
  assert jsonb_array_length(m -> 'matches') = 0, 'new cairo is not served';

  -- opening hours (12:00 → 02:00, and Maadi opens at 14:00 on Friday)
  assert everwake.is_open_at('{"default":[{"open":"12:00","close":"02:00"}]}', '2026-10-19 12:30') = true;
  assert everwake.is_open_at('{"default":[{"open":"12:00","close":"02:00"}]}', '2026-10-20 01:30') = true, 'after midnight still open';
  assert everwake.is_open_at('{"default":[{"open":"12:00","close":"02:00"}]}', '2026-10-20 03:00') = false;
  assert everwake.is_open_at('{"default":[{"open":"13:00","close":"01:00"}],"fri":[{"open":"14:00","close":"01:00"}]}', '2026-10-23 13:30') = false, 'friday opens later';
  assert everwake.is_open_at('{"default":[{"open":"13:00","close":"01:00"}],"fri":[{"open":"14:00","close":"01:00"}]}', '2026-10-22 13:30') = true;
  -- split shift
  assert everwake.is_open_at('{"default":[{"open":"08:00","close":"11:00"},{"open":"18:00","close":"23:00"}]}', '2026-10-19 15:00') = false;
  assert everwake.is_open_at('{"default":[{"open":"08:00","close":"11:00"},{"open":"18:00","close":"23:00"}]}', '2026-10-19 19:00') = true;
  assert everwake.is_open_at('{}', '2026-10-19 19:00') is null, 'no hours = unknown';
end $$;
