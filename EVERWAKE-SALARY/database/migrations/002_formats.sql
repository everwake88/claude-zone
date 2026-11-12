-- =====================================================================
-- Everwake Salary · 002 · formats
--
-- How each identity field is written, checked and compared. The same
-- functions read the HR sheet (salary.index_sheet) and what the employee
-- types on WhatsApp (salary.verify_identity), so both sides are compared
-- in exactly the same shape:
--
--   national id   14 digits; 2 or 3 first (born 19xx / 20xx), a real birth
--                 date, a real governorate code. Arabic digits accepted.
--   phone         an Egyptian mobile, 01[0125] + 8 digits. +20 / 0020 accepted.
--   full name     letters only, at least N names (as on the ID card).
--                 Compared without vowel marks, tatweel, or the أ/ا ة/ه ى/ي
--                 spellings people mix, and "عبد الله" = "عبدالله".
--   work id       letters, digits, - / _ ; HR sets the length and "digits only".
--                 All-digit ids drop leading zeros (Excel drops them too).
-- =====================================================================

-- any digits (Arabic-Indic, Persian or ASCII) → ASCII digits only
create or replace function salary.digits(t text) returns text
language sql immutable parallel safe as $$
  select regexp_replace(translate(coalesce(t, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g')
$$;

-- ---- national id ---------------------------------------------------------------------------
create or replace function salary.norm_national_id(t text) returns text
language sql immutable parallel safe as $$
  select case when length(salary.digits(t)) = 14 then salary.digits(t) end
$$;

-- why a national id is not valid (null when it is). Plain English for the agent to put in its own words.
create or replace function salary.national_id_problem(t text) returns text
language plpgsql stable parallel safe as $$
declare
  d text := salary.digits(t);
  c int; birth date;
begin
  if coalesce(btrim(t), '') = '' then return 'empty'; end if;
  if t ~ '[A-Za-zء-ي]' then return 'a national ID is digits only (it has letters in it)'; end if;
  if length(d) <> 14 then return format('a national ID is exactly 14 digits (this has %s)', length(d)); end if;
  c := substr(d, 1, 1)::int;
  if c not in (2, 3) then return 'a national ID starts with 2 or 3'; end if;
  begin
    birth := make_date(1700 + c * 100 + substr(d, 2, 2)::int, substr(d, 4, 2)::int, substr(d, 6, 2)::int);
  exception when others then
    return 'digits 2 to 7 of a national ID are the birth date (YYMMDD), and these are not a real date';
  end;
  if birth > current_date - interval '15 years' then return 'the birth date inside this national ID is too recent'; end if;
  if substr(d, 8, 2) not in ('01','02','03','04','11','12','13','14','15','16','17','18','19',
                             '21','22','23','24','25','26','27','28','29','31','32','33','34','35','88') then
    return 'digits 8 and 9 of a national ID are the governorate code, and this one does not exist';
  end if;
  return null;
end $$;

-- ---- phone ----------------------------------------------------------------------------------
create or replace function salary.norm_phone(t text) returns text
language sql immutable parallel safe as $$
  select case
    when d ~ '^01[0125][0-9]{8}$'     then d
    when d ~ '^1[0125][0-9]{8}$'      then '0' || d
    when d ~ '^201[0125][0-9]{8}$'    then substr(d, 2)
    when d ~ '^00201[0125][0-9]{8}$'  then substr(d, 4)
  end
  from (select salary.digits(t) as d) x
$$;

create or replace function salary.phone_problem(t text) returns text
language sql immutable parallel safe as $$
  select case
    when coalesce(btrim(t), '') = '' then 'empty'
    when salary.norm_phone(t) is null then 'an Egyptian mobile number is 11 digits starting with 010, 011, 012 or 015'
  end
$$;

-- ---- full name ------------------------------------------------------------------------------
create or replace function salary.norm_name(t text) returns text
language sql immutable parallel safe as $$
  -- vowel marks and tatweel out, the mixed spellings unified, anything not a letter is a space,
  -- then "عبد الله" / "ابو بكر" joined into one word
  select nullif(btrim(regexp_replace(regexp_replace(
           translate(lower(regexp_replace(coalesce(t, ''), '[ً-ْٰـ]', '', 'g')), 'أإآٱىةؤئ', 'اااايهوي'),
           '[^a-zء-ي]+', ' ', 'g'),
           '(^| )(عبد|ابو) ', '\1\2', 'g')), '')
$$;

create or replace function salary.name_problem(t text, min_words int) returns text
language sql immutable parallel safe as $$
  select case
    when coalesce(btrim(t), '') = '' then 'empty'
    when salary.digits(t) <> '' then 'a name has no numbers in it'
    when salary.norm_name(t) is null then 'this is not a name'
    -- counted as names, so "عبد الله" is one
    when array_length(string_to_array(salary.norm_name(t), ' '), 1) < min_words
      then format('the full name as written on the national ID card has at least %s names (this has %s)', min_words,
                  array_length(string_to_array(salary.norm_name(t), ' '), 1))
  end
$$;

-- ---- work id --------------------------------------------------------------------------------
create or replace function salary.norm_work_id(t text) returns text
language sql immutable parallel safe as $$
  select nullif(case when w ~ '^[0-9]+$' then coalesce(nullif(ltrim(w, '0'), ''), '0') else w end, '')
  from (select upper(regexp_replace(translate(coalesce(t, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '\s+', '', 'g')) as w) x
$$;

create or replace function salary.work_id_problem(t text, s salary.settings) returns text
language sql immutable parallel safe as $$
  select case
    when w = '' then 'empty'
    when w !~ '^[A-Za-z0-9/_-]+$' then 'a work ID has only letters, digits and - / _'
    when s.work_id_digits_only and w !~ '^[0-9]+$' then 'a work ID here is digits only'
    when length(w) < s.work_id_min_length or length(w) > s.work_id_max_length then
      case when s.work_id_min_length = s.work_id_max_length then format('a work ID here is exactly %s characters (this has %s)', s.work_id_min_length, length(w))
           else format('a work ID here is %s to %s characters (this has %s)', s.work_id_min_length, s.work_id_max_length, length(w)) end
  end
  from (select regexp_replace(translate(coalesce(t, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '\s+', '', 'g') as w) x
$$;

-- ---- one field: is it valid, and its compared form -------------------------------------------
-- {"ok":true,"value":"29001011234567"} or {"ok":false,"problem":"…"}
create or replace function salary.check_field(field text, v text, s salary.settings) returns jsonb
language plpgsql stable as $$
declare p text;
begin
  p := case field
    when 'full_name'   then salary.name_problem(v, s.name_min_words)
    when 'national_id' then salary.national_id_problem(v)
    when 'work_id'     then salary.work_id_problem(v, s)
    when 'phone'       then salary.phone_problem(v)
    else 'unknown field' end;
  if p is not null then return jsonb_build_object('ok', false, 'problem', p); end if;
  return jsonb_build_object('ok', true, 'value', case field
    when 'full_name'   then regexp_replace(btrim(v), '\s+', ' ', 'g')
    when 'national_id' then salary.norm_national_id(v)
    when 'work_id'     then salary.norm_work_id(v)
    when 'phone'       then salary.norm_phone(v) end);
end $$;

-- a value as the attempts log keeps it: enough for HR to recognise, not enough to reuse
create or replace function salary.mask(field text, v text) returns text
language sql immutable as $$
  select case
    when v is null or v = '' then null
    when field = 'full_name' then split_part(v, ' ', 1) || ' …'
    when length(v) <= 4 then repeat('•', length(v))
    else repeat('•', length(v) - 4) || right(v, 4) end
$$;
