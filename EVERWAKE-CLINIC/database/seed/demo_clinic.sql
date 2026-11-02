-- =====================================================================
-- Everwake Clinic · demo clinic (the tests use it)
--
-- "عيادات النيل" — a polyclinic with two doctors who book differently:
--   D1 د. منى عادل   dentistry · fixed times, 15-minute grid, on chairs
--                    المعادي  Sat · Mon · Wed  17:00–22:00 (two chairs)
--                    مدينة نصر Sun · Tue       12:00–16:00 (one chair)
--   D2 د. كريم حسن   paediatrics · queue numbers (الدور), 20 a session
--                    مدينة نصر Sun · Tue · Thu 18:00–22:00
-- WhatsApp instance 'nileclinic', webhook token 'demo-token'.
-- Safe to run again: it deletes and recreates itself.
-- =====================================================================

delete from clinic.tenants where slug = 'nile_clinics';

do $$
declare
  t   uuid;
  d1  uuid;
  d2  uuid;
  maadi uuid;
  nasr uuid;
begin
  insert into clinic.tenants (slug, name_ar, name_en, status, specialty, ref_prefix, live_at, profile, settings)
  values ('nile_clinics', 'عيادات النيل', 'Nile Clinics', 'live', 'dentistry', 'NC', now(),
          jsonb_build_object(
            'agent_name', jsonb_build_object('ar', 'نور', 'en', 'Nour'),
            'about_ar', 'عيادات النيل: أسنان مع د. منى عادل وأطفال مع د. كريم حسن، في المعادي ومدينة نصر.',
            'about_en', 'Nile Clinics: dentistry with Dr. Mona Adel and paediatrics with Dr. Karim Hassan, in Maadi and Nasr City.',
            'insurance', jsonb_build_array('AXA', 'MetLife', 'Allianz'),
            'contacts', jsonb_build_object('phone', '0225250000', 'whatsapp', '201000000100', 'emergency', '123'),
            'google_review_url', 'https://g.page/r/nile-clinics/review'),
          jsonb_build_object('public_url', 'https://clinic.everwake.tech', 'test_numbers', jsonb_build_array('201000000999')))
  returning id into t;

  insert into clinic.locations (tenant_id, code, name_ar, name_en, aliases, area_ar, address_ar, address_en, directions_ar, lat, lng, maps_url, phone, sort)
  values (t, 'maadi', 'المعادي', 'Maadi', array['معادي', 'المعادى'], 'المعادي', '15 شارع 9، المعادي', '15 Road 9, Maadi',
          'الدور التالت فوق صيدلية العزبي', 29.9602, 31.2569, 'https://maps.google.com/?q=29.9602,31.2569', '0225250000', 1)
  returning id into maadi;
  insert into clinic.locations (tenant_id, code, name_ar, name_en, aliases, area_ar, address_ar, address_en, directions_ar, lat, lng, maps_url, phone, sort)
  values (t, 'nasr', 'مدينة نصر', 'Nasr City', array['مدينه نصر', 'نصر', 'عباس العقاد'], 'مدينة نصر', '40 عباس العقاد، مدينة نصر',
          '40 Abbas El Akkad, Nasr City', 'برج الأطباء، الدور الخامس', 30.0566, 31.3301, 'https://maps.google.com/?q=30.0566,31.3301', '0222700000', 2)
  returning id into nasr;

  insert into clinic.doctors (tenant_id, code, name_ar, name_en, gender, specialty, sub_specialty_ar, bio_ar, color, ops_whatsapp, follow_up_days, sort)
  values (t, 'D1', 'منى عادل', 'Mona Adel', 'female', 'dentistry', 'تجميل وزراعة الأسنان', 'ماجستير طب الأسنان، جامعة القاهرة.', '#2f7d6d', '201000000101', 14, 1)
  returning id into d1;
  insert into clinic.doctors (tenant_id, code, name_ar, name_en, gender, specialty, sub_specialty_ar, bio_ar, color, ops_whatsapp, follow_up_days, sort)
  values (t, 'D2', 'كريم حسن', 'Karim Hassan', 'male', 'pediatrics', 'حديثي الولادة', 'استشاري طب الأطفال.', '#b8693f', '201000000102', 7, 2)
  returning id into d2;

  insert into clinic.resources (tenant_id, location_id, kind, name_ar, name_en, sort) values
    (t, maadi, 'chair', 'كرسي 1', 'Chair 1', 1), (t, maadi, 'chair', 'كرسي 2', 'Chair 2', 2), (t, nasr, 'chair', 'كرسي نصر', 'Nasr chair', 1);

  insert into clinic.schedules (tenant_id, doctor_id, location_id, weekday, start_time, end_time, mode, slot_minutes, capacity)
  select t, d1, maadi, w, '17:00', '22:00', 'slots', 15, null from unnest(array[6, 1, 3]) w;
  insert into clinic.schedules (tenant_id, doctor_id, location_id, weekday, start_time, end_time, mode, slot_minutes, capacity)
  select t, d1, nasr, w, '12:00', '16:00', 'slots', 15, null from unnest(array[0, 2]) w;
  insert into clinic.schedules (tenant_id, doctor_id, location_id, weekday, start_time, end_time, mode, slot_minutes, capacity)
  select t, d2, nasr, w, '18:00', '22:00', 'queue', 15, 20 from unnest(array[0, 2, 4]) w;

  perform clinic.apply_preset(t, 'dentistry', d1);
  perform clinic.apply_preset(t, 'pediatrics', d2);

  -- the dentist's prices
  update clinic.services s set price = x.price, price_max = x.price_max
    from (values ('كشف أسنان', 300, null), ('إعادة / متابعة', 150, null), ('أشعة بانوراما', 350, null), ('أشعة صغيرة على سنة', 100, null),
                 ('تنضيف جير وتلميع', 600, null), ('حشو كومبوزيت (تجميلي)', 700, null), ('حشو عصب', 1500, 2500), ('خلع عادي', 400, null),
                 ('خلع ضرس عقل جراحي', 1200, 2000), ('طربوش زيركون', 3500, null), ('طربوش بورسلين', 2000, null), ('زرعة أسنان', 12000, 18000),
                 ('تبييض الأسنان', 3000, null), ('فينير', 4000, 6000), ('تقويم ثابت', 15000, 25000), ('طقم أسنان', 5000, 8000),
                 ('علاج اللثة', 800, null), ('حشو أسنان لبنية', 400, null), ('فلورايد للأطفال', 300, null)) as x(name, price, price_max)
   where s.tenant_id = t and s.name_ar = x.name;
  update clinic.services set price_kind = 'after_exam' where tenant_id = t and name_ar = 'تقويم شفاف';
  -- Nasr City is cheaper for the check-up
  insert into clinic.service_prices (tenant_id, service_id, location_id, price)
  select t, id, nasr, 250 from clinic.services where tenant_id = t and name_ar = 'كشف أسنان';

  -- the paediatrician's prices (a follow-up within a week is free)
  update clinic.services set price = 350 where tenant_id = t and specialty = 'pediatrics' and category = 'consultation' and name_ar = 'كشف';
  update clinic.services set price_kind = 'free', price = 0 where tenant_id = t and specialty = 'pediatrics' and category = 'follow_up';
  update clinic.services set price = 300 where tenant_id = t and name_ar = 'متابعة نمو وتطعيمات';
  update clinic.services set price = 100 where tenant_id = t and name_ar = 'جلسة بخار (نيبولايزر)';

  insert into clinic.offers (tenant_id, title_ar, kind, value, service_ids, ends_at)
  select t, 'خصم 20% على التبييض الشهر ده', 'percent_off', 20, array[id], date_trunc('month', now()) + interval '1 month'
    from clinic.services where tenant_id = t and name_ar = 'تبييض الأسنان';

  insert into clinic.knowledge_entries (tenant_id, topic, content_ar, sort) values
    (t, 'الركن', 'في جراج قدام العيادة في المعادي، وفي مدينة نصر جراج البرج.', 1),
    (t, 'التأمين', 'بنتعامل مع AXA وMetLife وAllianz. هات الكارنيه معاك.', 2),
    (t, 'التقسيط', 'الزرعة والتقويم ممكن يتقسطوا على 6 شهور من غير فوايد بعد الكشف.', 3),
    (t, 'سن الأطفال عند الأسنان', 'د. منى بتكشف على الأطفال من 4 سنين.', 4),
    (t, 'الإلغاء', 'لو هتلغي يا ريت تبلغنا قبلها بـ 3 ساعات على الأقل.', 5);

  insert into clinic.agent_rules (tenant_id, kind, text_ar) values
    (t, 'note', 'مع كشف الزرعة قول إن أشعة البانوراما عليها خصم 50%.');
  insert into clinic.agent_rules (tenant_id, kind, doctor_id, params, text_ar) values
    (t, 'new_patients_until', d1, '{"time":"21:00"}', 'آخر كشف جديد عند د. منى الساعة 9');

  insert into clinic.whatsapp_channels (tenant_id, provider, label, phone_number, instance_name, base_url, api_key, webhook_token, status)
  values (t, 'evolution', 'رقم العيادة', '201000000100', 'nileclinic', 'https://evo.example.com', 'demo-evo-key', 'demo-token', 'connected');

  perform clinic.rebuild_snapshot(t);
end $$;
