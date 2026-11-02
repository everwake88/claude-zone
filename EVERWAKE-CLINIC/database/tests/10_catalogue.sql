\i tests/fixtures/helpers.sql
-- the catalogue: price shapes, matching, the most specific price, changing it in words, undo, the snapshot
do $$
declare
  t uuid := pg_temp.tid();
  s uuid;
  r jsonb; r2 jsonb;
  v jsonb;
begin
  assert clinic.price_words('range', 1500, 2500, 'tooth', 'ar', 'ج') = 'من 1,500 لـ 2,500 ج للسنة', clinic.price_words('range', 1500, 2500, 'tooth', 'ar', 'ج');
  assert clinic.price_words('from', 12000, null, 'tooth', 'en') = 'from 12,000 EGP per tooth';
  assert clinic.price_words('after_exam', null, null, 'visit') = 'السعر بيتحدد بعد الكشف';
  assert clinic.price_words('fixed', 300, null, 'visit') = '300 ج';
  assert clinic.price_words('free', 0, null, 'visit') = 'مجاناً';

  -- the patient's own words find the service
  s := clinic.match_service(t, 'تنظيف');
  assert (select name_ar from clinic.services where id = s) = 'تنضيف جير وتلميع', 'تنظيف → scaling';
  assert (select name_ar from clinic.services where id = clinic.match_service(t, 'زرعه')) = 'زرعة أسنان', 'زرعه → implant';
  assert (select name_ar from clinic.services where id = clinic.match_service(t, 'root canal')) = 'حشو عصب', 'root canal';
  assert (select name_ar from clinic.services where id = clinic.match_service(t, 'S013')) = 'تبييض الأسنان', 'by code';
  assert clinic.match_doctor(t, 'دكتورة منى') is null or clinic.match_doctor(t, 'د منى') = pg_temp.doc('D1');
  assert clinic.match_doctor(t, 'منى') = pg_temp.doc('D1'), 'doctor by first name';
  assert clinic.match_doctor(t, 'دكتور كريم') = pg_temp.doc('D2'), 'دكتور كريم';
  assert clinic.match_location(t, 'مدينه نصر') = pg_temp.loc('nasr');

  -- who does what
  assert clinic.service_offered(s, pg_temp.doc('D1')), 'the dentist cleans';
  assert not clinic.service_offered(s, pg_temp.doc('D2')), 'the paediatrician does not';

  -- the place's own price wins over the clinic's
  v := clinic.service_price(pg_temp.svc('كشف أسنان'), pg_temp.doc('D1'), pg_temp.loc('nasr'));
  assert (v ->> 'price')::numeric = 250, 'Nasr City check-up';
  v := clinic.service_price(pg_temp.svc('كشف أسنان'), pg_temp.doc('D1'), pg_temp.loc('maadi'));
  assert (v ->> 'price')::numeric = 300, 'Maadi check-up';

  -- shown first, saved only when applied
  r := clinic.catalog_change(t, '[{"op":"set_price","service":"تنظيف","price":700}]', false, 'whatsapp');
  assert r ->> 'status' = 'PREVIEW', r::text;
  assert (select price from clinic.services where id = s) = 600, 'nothing changes on a preview';
  assert r ->> 'summary_ar' like '%700 ج ← 600 ج%', r ->> 'summary_ar';
  r2 := clinic.catalog_apply((r ->> 'change_id')::bigint);
  assert r2 ->> 'status' = 'APPLIED';
  assert (select price from clinic.services where id = s) = 700;
  r2 := clinic.catalog_apply((r ->> 'change_id')::bigint);
  assert r2 ->> 'error' = 'ALREADY_APPLIED', 'applied once';
  -- the agent sees it on the next turn
  perform clinic.ensure_snapshot(t);
  assert (select digest_text like '%Scaling and polishing — 700 ج%' from clinic.catalog_snapshot where tenant_id = t), 'snapshot rebuilt';
  assert (select lookup -> 'amounts' @> '[700]'::jsonb from clinic.catalog_snapshot where tenant_id = t), 'amounts for Check Reply';
  r2 := clinic.catalog_undo((r ->> 'change_id')::bigint);
  assert (select price from clinic.services where id = s) = 600, 'undone';

  -- several at once, then all undone
  r := clinic.catalog_change(t, '[{"op":"add_service","name_ar":"تقويم أطفال","price":8000,"price_max":12000,"unit":"course","doctor":"منى"},
                                  {"op":"remove_service","service":"بورسلين"},
                                  {"op":"add_faq","topic":"طرق الدفع","content_ar":"كاش أو فيزا أو انستاباي"},
                                  {"op":"add_offer","title_ar":"كشف أطفال مجاني يوم الجمعة","kind":"free","services":["فلورايد"]},
                                  {"op":"add_rule","text_ar":"متحجزش زرعة في رمضان"}]', true, 'assistant');
  assert r ->> 'status' = 'APPLIED', r::text;
  assert exists (select 1 from clinic.services where tenant_id = t and name_ar = 'تقويم أطفال' and price_kind = 'range' and price_unit = 'course'
                   and pg_temp.doc('D1') = any(doctor_ids)), 'added for the dentist';
  assert not (select is_active from clinic.services where tenant_id = t and name_ar = 'طربوش بورسلين'), 'removed';
  assert exists (select 1 from clinic.knowledge_entries where tenant_id = t and topic = 'طرق الدفع' and is_active);
  assert exists (select 1 from clinic.agent_rules where tenant_id = t and text_ar = 'متحجزش زرعة في رمضان');
  r2 := clinic.catalog_undo((r ->> 'change_id')::bigint);
  assert r2 ->> 'status' = 'UNDONE';
  assert not exists (select 1 from clinic.services where tenant_id = t and name_ar = 'تقويم أطفال'), 'add undone';
  assert (select is_active from clinic.services where tenant_id = t and name_ar = 'طربوش بورسلين'), 'remove undone';
  assert not exists (select 1 from clinic.knowledge_entries where tenant_id = t and topic = 'طرق الدفع'), 'answer undone';
  assert not exists (select 1 from clinic.offers where tenant_id = t and title_ar like 'كشف أطفال مجاني%'), 'offer undone';

  -- a doctor-only price
  r := clinic.catalog_change(t, '[{"op":"set_price","service":"كشف أسنان","doctor":"منى","location":"المعادي","price":320}]', true);
  assert (clinic.service_price(pg_temp.svc('كشف أسنان'), pg_temp.doc('D1'), pg_temp.loc('maadi')) ->> 'price')::numeric = 320, 'doctor at place';
  perform clinic.catalog_undo((r ->> 'change_id')::bigint);
  assert (clinic.service_price(pg_temp.svc('كشف أسنان'), pg_temp.doc('D1'), pg_temp.loc('maadi')) ->> 'price')::numeric = 300, 'back';

  -- what is not on the list is reported, nothing invented
  r := clinic.catalog_change(t, '[{"op":"set_price","service":"عملية قلب مفتوح","price":5}]', false);
  assert r ->> 'error' = 'NOTHING_TO_CHANGE' and r -> 'problems' -> 0 ->> 'problem' = 'SERVICE_NOT_FOUND', r::text;
  r := clinic.catalog_change(t, '[{"op":"add_service","name_ar":"تبييض الأسنان","price":1}]', false);
  assert r -> 'problems' -> 0 ->> 'problem' = 'ALREADY_EXISTS', r::text;
end $$;
