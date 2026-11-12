-- the demo sheets were published and indexed; problems are found; a month is replaced
do $$
declare sh uuid; r jsonb; n int;
begin
  assert (select count(*) from salary.payroll_sheets where status = 'published') = 2, 'two months';
  assert (select row_count from salary.payroll_sheets where period = '2026-10-01') = 8;
  assert (select problem_count from salary.payroll_sheets where period = '2026-10-01') = 0, 'demo rows are clean';
  assert (select person_key from salary.payroll_rows r join salary.payroll_sheets s on s.id = r.sheet_id
          where s.period = '2026-10-01' and r.work_id = '1023') = 'nid:29001150101234';

  -- a new October with a bad id, a duplicate and a missing phone
  insert into salary.payroll_sheets (period, title, columns, identity)
  values ('2026-10-01', 'October again', '[{"key":"c1","header":"Name"},{"key":"c2","header":"NID"},{"key":"c3","header":"Mobile"},{"key":"c4","header":"Net"}]',
          '{"full_name":"c1","national_id":"c2","phone":"c3"}') returning id into sh;
  insert into salary.payroll_rows (sheet_id, row_no, cells) values
    (sh, 2, '{"c1":"أحمد محمد عبد الله السيد","c2":29001150101234,"c3":"1001234567","c4":9100}'),
    (sh, 3, '{"c1":"منى إبراهيم حسن علي","c2":"29213320201876","c3":"01112223344","c4":5}'),
    (sh, 4, '{"c1":"X Y Z","c2":"28807110103345","c3":"","c4":5}'),
    (sh, 5, '{"c1":"X Y Z","c2":"28807110103345","c3":"01223334455","c4":5}');
  r := salary.index_sheet(sh);
  assert (r ->> 'problems')::int = 3, 'bad id + two duplicates: ' || r::text;
  assert (select problems from salary.payroll_rows where sheet_id = sh and row_no = 3) = array['national_id_invalid'];
  assert (select problems from salary.payroll_rows where sheet_id = sh and row_no = 4) = array['phone_missing', 'duplicate'];
  assert (select phone from salary.payroll_rows where sheet_id = sh and row_no = 2) = '01001234567', 'number cell, zero restored';

  -- publishing replaces the month; a sheet with no id column cannot be published
  r := salary.publish_sheet(sh);
  assert (r ->> 'replaced')::boolean, 'replaced October';
  assert (select count(*) from salary.payroll_sheets where period = '2026-10-01') = 1;
  update salary.payroll_sheets set identity = '{"full_name":"c1"}' where id = sh;
  assert (salary.publish_sheet(sh) ->> 'ok')::boolean = false, 'needs an id column';
  raise exception 'rollback' using errcode = 'P0001';
exception when raise_exception then
  if sqlerrm <> 'rollback' then raise; end if;
end $$;
