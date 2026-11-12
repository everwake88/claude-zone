-- =====================================================================
-- Everwake Salary · 003 · payroll sheets
--
-- The dashboard writes an uploaded sheet as a draft (its columns, and every
-- row's cells under the column keys). HR says which column is the name, the
-- national id, the work id and the phone; index_sheet then reads those cells
-- into the compared form and notes each row's problems (a missing or invalid
-- national id, a duplicate). publish_sheet makes it the month's sheet, and
-- replaces the month's earlier one.
-- =====================================================================

create or replace function salary.index_sheet(p_sheet uuid) returns jsonb
language plpgsql as $$
declare
  sh salary.payroll_sheets;
  s  salary.settings;
  k_name text; k_nid text; k_wid text; k_phone text;
  n_rows int; n_problems int;
begin
  select * into sh from salary.payroll_sheets where id = p_sheet for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such sheet'); end if;
  select * into s from salary.settings;
  k_name := nullif(sh.identity ->> 'full_name', '');
  k_nid := nullif(sh.identity ->> 'national_id', '');
  k_wid := nullif(sh.identity ->> 'work_id', '');
  k_phone := nullif(sh.identity ->> 'phone', '');

  update salary.payroll_rows r set
    name_norm   = salary.norm_name(r.cells ->> k_name),
    national_id = salary.norm_national_id(r.cells ->> k_nid),
    work_id     = salary.norm_work_id(r.cells ->> k_wid),
    phone       = salary.norm_phone(r.cells ->> k_phone)
  where r.sheet_id = p_sheet;

  update salary.payroll_rows r set
    person_key = coalesce('nid:' || r.national_id, 'wid:' || r.work_id),
    problems = array_remove(array[
      case when k_name is not null and r.name_norm is null then 'name_missing' end,
      case when k_nid is not null and coalesce(btrim(r.cells ->> k_nid), '') = '' then 'national_id_missing'
           when k_nid is not null and salary.national_id_problem(r.cells ->> k_nid) is not null then 'national_id_invalid' end,
      case when k_wid is not null and r.work_id is null then 'work_id_missing' end,
      case when k_phone is not null and coalesce(btrim(r.cells ->> k_phone), '') = '' then 'phone_missing'
           when k_phone is not null and r.phone is null then 'phone_invalid' end,
      case when r.national_id is null and r.work_id is null then 'no_identity' end
    ], null)
  where r.sheet_id = p_sheet;

  -- the same person twice in one month: neither row can be matched until HR fixes it
  update salary.payroll_rows r set problems = r.problems || array['duplicate']
  where r.sheet_id = p_sheet and r.person_key is not null
    and exists (select 1 from salary.payroll_rows o
                where o.sheet_id = p_sheet and o.person_key = r.person_key and o.id <> r.id);

  select count(*), count(*) filter (where cardinality(problems) > 0) into n_rows, n_problems
  from salary.payroll_rows where sheet_id = p_sheet;
  update salary.payroll_sheets set row_count = n_rows, problem_count = n_problems where id = p_sheet;
  return jsonb_build_object('ok', true, 'rows', n_rows, 'problems', n_problems);
end $$;

-- the draft becomes the month's sheet; the month's earlier sheet (if any) is removed
create or replace function salary.publish_sheet(p_sheet uuid) returns jsonb
language plpgsql as $$
declare sh salary.payroll_sheets; replaced int;
begin
  select * into sh from salary.payroll_sheets where id = p_sheet for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such sheet'); end if;
  if coalesce(sh.identity ->> 'national_id', '') = '' and coalesce(sh.identity ->> 'work_id', '') = '' then
    return jsonb_build_object('ok', false, 'error', 'choose the national ID column or the work ID column first');
  end if;
  perform salary.index_sheet(p_sheet);
  delete from salary.payroll_sheets where period = sh.period and status = 'published' and id <> p_sheet;
  get diagnostics replaced = row_count;
  update salary.payroll_sheets set status = 'published', published_at = now() where id = p_sheet;
  return jsonb_build_object('ok', true, 'replaced', replaced > 0);
end $$;
