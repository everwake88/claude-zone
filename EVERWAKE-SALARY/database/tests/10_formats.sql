-- national id, phone, name and work id: what is valid, and the compared form
do $$
declare s salary.settings;
begin
  select * into s from salary.settings;
  -- national id
  assert salary.national_id_problem('29001150101234') is null, 'a valid national id';
  assert salary.national_id_problem('٢٩٠٠١١٥٠١٠١٢٣٤') is null, 'Arabic digits are fine';
  assert salary.norm_national_id('2900 1150 1012 34') = '29001150101234', 'spaces are dropped';
  assert salary.national_id_problem('2900115010123') like '%14 digits (this has 13)%', 'too short';
  assert salary.national_id_problem('49001150101234') like '%starts with 2 or 3%', 'bad century';
  assert salary.national_id_problem('29013320101234') like '%not a real date%', 'month 13';
  assert salary.national_id_problem('29002300101234') like '%not a real date%', '30 February';
  assert salary.national_id_problem('29001159901234') like '%governorate%', 'governorate 99';
  assert salary.national_id_problem('32001010101234') like '%too recent%', 'born 2020';
  assert salary.national_id_problem('2900115O101234') like '%letters%', 'a letter O';
  -- phone
  assert salary.norm_phone('01001234567') = '01001234567';
  assert salary.norm_phone('+20 100 123 4567') = '01001234567';
  assert salary.norm_phone('00201001234567') = '01001234567';
  assert salary.norm_phone('201001234567') = '01001234567';
  assert salary.norm_phone('٠١٠٠١٢٣٤٥٦٧') = '01001234567';
  assert salary.norm_phone('1001234567') = '01001234567', 'Excel dropped the zero';
  assert salary.norm_phone('01301234567') is null, '013 is not a mobile prefix';
  assert salary.phone_problem('0100123') like '%11 digits%';
  -- names
  assert salary.norm_name('أحمد محمد عبد الله') = salary.norm_name('احمد محمد عبدالله'), 'alef and عبد الله';
  assert salary.norm_name('هبة الله') = salary.norm_name('هبه الله'), 'ة / ه';
  assert salary.norm_name('مُنى إبراهيم') = salary.norm_name('منى ابراهيم'), 'vowel marks';
  assert salary.norm_name('منى ابراهيم') = salary.norm_name('مني ابراهيم'), 'ى / ي';
  assert salary.norm_name('  Ahmed   Mohamed ') = 'ahmed mohamed';
  assert salary.name_problem('أحمد محمد', 3) like '%at least 3 names (this has 2)%';
  assert salary.name_problem('محمد عبد الله', 3) like '%this has 2%', 'عبد الله counts once';
  assert salary.name_problem('أحمد محمد عبد الله', 3) is null;
  assert salary.name_problem('أحمد 123 علي', 3) like '%no numbers%';
  -- work id
  assert salary.norm_work_id(' 01023 ') = '1023', 'leading zeros, as Excel drops them';
  assert salary.norm_work_id('emp-0012') = 'EMP-0012', 'letters keep their zeros';
  assert salary.work_id_problem('10#23', s) like '%letters, digits%';
  s.work_id_digits_only := true;
  assert salary.work_id_problem('EMP12', s) like '%digits only%';
  s.work_id_min_length := 4; s.work_id_max_length := 4;
  assert salary.work_id_problem('123', s) like '%exactly 4%';
  -- check_field
  assert salary.check_field('phone', '+201001234567', s) ->> 'value' = '01001234567';
  assert (salary.check_field('national_id', '123', s) ->> 'ok')::boolean = false;
  assert salary.mask('national_id', '29001150101234') = '••••••••••1234';
end $$;
