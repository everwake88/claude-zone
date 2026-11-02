-- =====================================================================
-- Everwake Clinic · a living demo day for the demo clinic (seed/demo_clinic.sql)
--
-- Patients with their histories, and TODAY happening around the time you run
-- it: sessions for both doctors that started a few hours ago, patients done,
-- one with the doctor, two waiting, the rest booked, the dentist 20 minutes
-- late with the patients' answers coming in, a possible emergency on
-- WhatsApp, and bookings the assistant made today. Also the past month of
-- visits and the next few days. For demos and screenshots only — run it on a
-- demo database, after the seed:   psql -f database/tools/showcase_clinic.sql
-- Running it again replaces the demo day.
-- =====================================================================
do $$
declare
  t      uuid;
  tz     text;
  d1     uuid; d2 uuid; maadi uuid; nasr uuid; ch1 uuid; ch2 uuid;
  s_chk  uuid; s_fol uuid; s_scl uuid; s_fill uuid; s_rct uuid; s_ext uuid; s_kid uuid; s_kfu uuid; s_white uuid;
  v_today date; v_now timestamp; v_start timestamp; v_end timestamp; v_qstart timestamp;
  p      bigint[] := '{}';
  c      bigint;
  conv   bigint;
  i      int;
  v_id   bigint;
  v_at   timestamptz;
  v_seq  int;
  v_notice bigint;
  names  text[] := array['سارة محمود', 'أحمد عبد الرحمن', 'منة الله طارق', 'محمد السيد', 'ياسمين فؤاد', 'عمر خالد', 'نادية إبراهيم',
                         'كريم مصطفى', 'هبة عادل', 'يوسف أحمد (طفل)', 'ليلى حسام (طفلة)', 'آدم وليد (طفل)', 'مريم شريف (طفلة)', 'زياد عمرو (طفل)',
                         'رنا سامي', 'حسن علي', 'دينا مجدي', 'تامر نبيل'];
  sexes  text[] := array['female', 'male', 'female', 'male', 'female', 'male', 'female', 'male', 'female', 'male', 'female', 'male', 'female', 'male',
                         'female', 'male', 'female', 'male'];
  ages   int[] := array[29, 41, 24, 56, 33, 38, 62, 45, 27, 6, 4, 2, 8, 1, 35, 49, 31, 52];
  reasons text[] := array['ضرس بيوجعني من يومين ومش بنام', 'عايز أنضف سناني', 'حشو وقع', 'متابعة الزرعة', 'عايزة أبيض سناني قبل الفرح',
                          'وجع في اللثة', 'متابعة الطقم', 'كشف', 'السنة اللي ورا بتوجعني مع الساقع', 'سخونية وكحة من 3 أيام',
                          'متابعة وزن وتطعيم', 'إسهال من امبارح', 'كحة بالليل', 'تطعيم 6 شهور', 'حساسية في سناني', 'خلع ضرس العقل', 'تقويم', 'كشف'];
begin
  select id, timezone into t, tz from clinic.tenants where slug = 'nile_clinics';
  if t is null then raise exception 'run seed/demo_clinic.sql first'; end if;
  select id into d1 from clinic.doctors where tenant_id = t and code = 'D1';
  select id into d2 from clinic.doctors where tenant_id = t and code = 'D2';
  select id into maadi from clinic.locations where tenant_id = t and code = 'maadi';
  select id into nasr from clinic.locations where tenant_id = t and code = 'nasr';
  select id into ch1 from clinic.resources where tenant_id = t and location_id = maadi order by sort limit 1;
  select id into ch2 from clinic.resources where tenant_id = t and location_id = maadi order by sort offset 1 limit 1;
  select id into s_chk from clinic.services where tenant_id = t and name_ar = 'كشف أسنان';
  select id into s_fol from clinic.services where tenant_id = t and specialty = 'dentistry' and category = 'follow_up' limit 1;
  select id into s_scl from clinic.services where tenant_id = t and name_ar = 'تنضيف جير وتلميع';
  select id into s_fill from clinic.services where tenant_id = t and name_ar = 'حشو كومبوزيت (تجميلي)';
  select id into s_rct from clinic.services where tenant_id = t and name_ar = 'حشو عصب';
  select id into s_ext from clinic.services where tenant_id = t and name_ar = 'خلع عادي';
  select id into s_white from clinic.services where tenant_id = t and name_ar = 'تبييض الأسنان';
  select id into s_kid from clinic.services where tenant_id = t and specialty = 'pediatrics' and category = 'consultation' order by sort limit 1;
  select id into s_kfu from clinic.services where tenant_id = t and specialty = 'pediatrics' and category = 'follow_up' order by sort limit 1;

  -- a clean slate for the demo day
  delete from clinic.alerts where tenant_id = t;
  delete from clinic.delay_notices where tenant_id = t;
  delete from clinic.appointments where tenant_id = t;
  delete from clinic.schedule_exceptions where tenant_id = t;
  delete from clinic.waitlist where tenant_id = t;
  delete from clinic.messages where tenant_id = t;
  delete from clinic.team_questions where tenant_id = t;
  delete from clinic.conversations where tenant_id = t;
  delete from clinic.patients where tenant_id = t;
  delete from clinic.contacts where tenant_id = t;

  v_now := now() at time zone tz;
  v_today := v_now::date;
  -- both doctors' sessions today: started about three hours ago, ending in about two
  v_start := greatest(date_trunc('hour', v_now) - interval '3 hours', v_today::timestamp);
  v_end := least(date_trunc('hour', v_now) + interval '2 hours 30 minutes', v_today::timestamp + interval '23 hours 59 minutes');
  v_qstart := greatest(date_trunc('hour', v_now) - interval '2 hours', v_today::timestamp);
  insert into clinic.schedule_exceptions (tenant_id, doctor_id, location_id, on_date, kind, start_time, end_time, mode, slot_minutes, reason)
  values (t, d1, maadi, v_today, 'changed', v_start::time, v_end::time, 'slots', 15, 'demo'),
         (t, d2, nasr, v_today, 'extra', v_qstart::time, v_end::time, 'queue', 15, 'demo');
  update clinic.schedule_exceptions set capacity = 20 where tenant_id = t and doctor_id = d2 and on_date = v_today;

  -- the patients, their WhatsApp numbers and chats
  for i in 1 .. array_length(names, 1) loop
    insert into clinic.contacts (tenant_id, wa_id, phone, reply_to, full_name, display_name, language)
    values (t, '2010' || lpad((12345600 + i * 7)::text, 8, '0'), '2010' || lpad((12345600 + i * 7)::text, 8, '0'),
            '2010' || lpad((12345600 + i * 7)::text, 8, '0'),
            case when i between 10 and 14 then 'والدة ' || split_part(names[i], ' ', 1) else names[i] end, split_part(names[i], ' ', 1), 'ar')
    returning id into c;
    insert into clinic.patients (tenant_id, full_name, sex, birth_date, birth_date_estimated, phone, visits_count, last_visit_at, first_visit_at, created_via)
    values (t, regexp_replace(names[i], '\s*\((طفل|طفلة)\)', ''), sexes[i],
            (v_today - make_interval(years => ages[i], days => (i * 37) % 300))::date, false,
            '2010' || lpad((12345600 + i * 7)::text, 8, '0'),
            case when i % 3 = 0 then 0 else 1 + i % 4 end,
            case when i % 3 = 0 then null else now() - make_interval(days => 20 + i * 9) end,
            case when i % 3 = 0 then null else now() - make_interval(days => 200 + i * 11) end, 'whatsapp')
    returning id into v_id;
    p := p || v_id;
    insert into clinic.patient_contacts (tenant_id, patient_id, contact_id, relation)
    values (t, v_id, c, case when i between 10 and 14 then 'child' else 'self' end);
    insert into clinic.conversations (tenant_id, contact_id, wa_id, last_message_at, last_inbound_at, last_message_preview)
    values (t, c, '2010' || lpad((12345600 + i * 7)::text, 8, '0'), now() - make_interval(mins => i * 23), now() - make_interval(mins => i * 23), reasons[i])
    returning id into conv;
    insert into clinic.messages (tenant_id, conversation_id, wa_id, direction, sender, body, status, created_at)
    values (t, conv, '2010' || lpad((12345600 + i * 7)::text, 8, '0'), 'inbound', 'patient', reasons[i], 'received', now() - make_interval(mins => i * 23 + 2)),
           (t, conv, '2010' || lpad((12345600 + i * 7)::text, 8, '0'), 'outbound', 'agent',
            'سلامتك يا ' || split_part(names[i], ' ', 1) || ' 🙏 أقرب ميعاد مع الدكتور النهارده، تحب أحجزلك؟', 'sent', now() - make_interval(mins => i * 23));
  end loop;

  -- what the doctors need to know
  insert into clinic.allergies (tenant_id, patient_id, substance, reaction, severity, status)
  values (t, p[1], 'بنسلين', 'طفح جلدي', 'moderate', 'active'), (t, p[4], 'البنج الموضعي (ليدوكايين)', 'دوخة وخفقان', 'severe', 'active'),
         (t, p[10], 'إيبوبروفين', 'ضيق تنفس', 'severe', 'active');
  insert into clinic.conditions (tenant_id, patient_id, name, status) values
    (t, p[1], 'سكر نوع 2', 'active'), (t, p[4], 'ضغط مرتفع', 'active'), (t, p[4], 'سكر نوع 2', 'active'), (t, p[7], 'ضغط مرتفع', 'active'),
    (t, p[10], 'ربو شعبي', 'active');
  insert into clinic.medications (tenant_id, patient_id, name, dose, status) values
    (t, p[1], 'جلوكوفاج', '500 مجم مرتين', 'active'), (t, p[4], 'كونكور', '5 مجم', 'active'), (t, p[4], 'أسبوسيد', '75 مجم', 'active'),
    (t, p[10], 'فنتولين بخاخ', 'عند اللزوم', 'active');
  insert into clinic.vitals (tenant_id, patient_id, taken_at, bp_sys, bp_dia, pulse, weight_kg)
  select t, p[4], now() - make_interval(days => k * 30), 128 + k * 3, 82 + k, 76 + k, 88 - k from generate_series(0, 5) k;
  insert into clinic.documents (tenant_id, patient_id, kind, title, source, ai_summary, ai_values, created_at)
  values (t, p[1], 'lab', 'تحليل سكر تراكمي', 'whatsapp', 'السكر التراكمي 7.8% (أعلى من الطبيعي).',
          '[{"name":"HbA1c","value":"7.8","unit":"%","flag":"high"}]', now() - interval '2 days'),
         (t, p[1], 'imaging', 'أشعة بانوراما', 'whatsapp', 'أشعة بانوراما من عيادة سابقة.', null, now() - interval '5 days');

  -- Sara's teeth and the plan she was quoted
  insert into clinic.dental_chart (tenant_id, patient_id, tooth, condition, surfaces, planned, notes) values
    (t, p[1], 16, 'root_canal', '{O}', 'طربوش زيركون', 'العصب اتشال الجلسة اللي فاتت'), (t, p[1], 26, 'caries', '{O,D}', 'حشو كومبوزيت', null),
    (t, p[1], 36, 'filled', '{O}', null, null), (t, p[1], 46, 'crown', '{}', null, 'طربوش من 2023'), (t, p[1], 38, 'impacted', '{}', 'خلع جراحي', 'بيوجع مع الأكل'),
    (t, p[1], 11, 'veneer', '{B}', null, null), (t, p[1], 21, 'veneer', '{B}', null, null), (t, p[1], 47, 'sensitive', '{}', null, null),
    (t, p[1], 37, 'extraction_needed', '{}', 'خلع', null), (t, p[1], 18, 'missing', '{}', null, null);
  insert into clinic.treatment_plans (tenant_id, patient_id, doctor_id, title, status, discount, notes, quoted_at)
  values (t, p[1], d1, 'خطة علاج الضروس', 'quoted', 500, 'ممكن التقسيط على 3 شهور', now() - interval '2 days') returning id into v_id;
  insert into clinic.treatment_plan_items (tenant_id, plan_id, seq, tooth, service_id, label, price, sessions, session_gap_days, done_sessions, status) values
    (t, v_id, 1, 16, s_rct, 'حشو عصب', 1800, 2, 7, 1, 'in_progress'),
    (t, v_id, 2, 16, (select id from clinic.services where tenant_id = t and name_ar = 'طربوش زيركون'), 'طربوش زيركون', 3500, 2, 7, 0, 'planned'),
    (t, v_id, 3, 26, s_fill, 'حشو كومبوزيت', 700, 1, null, 0, 'planned'),
    (t, v_id, 4, 38, (select id from clinic.services where tenant_id = t and name_ar = 'خلع ضرس عقل جراحي'), 'خلع ضرس عقل جراحي', 1500, 1, null, 0, 'planned');

  -- the dentist's day: 30-minute visits from the start of the session
  v_seq := (select appt_seq from clinic.tenants where id = t);
  for i in 0 .. 9 loop
    v_at := (v_start + make_interval(mins => i * 30)) at time zone tz;
    exit when v_at + interval '30 minutes' > (v_end at time zone tz);
    v_seq := v_seq + 1;
    insert into clinic.appointments (tenant_id, ref_no, doctor_id, location_id, resource_id, service_id, patient_id, contact_id, wa_id,
                                     status, source, mode, session_date, starts_at, ends_at, est_at, reason, is_new_patient, price, price_text,
                                     confirmed_at, arrived_at, visit_started_at, visit_ended_at, created_at)
    select t, 'NC-' || v_seq, d1, maadi, case when i % 2 = 0 then ch1 else ch2 end,
           (array[s_chk, s_scl, s_fill, s_fol, s_white, s_rct, s_fol, s_chk, s_ext, s_scl])[i + 1], p[i + 1], pc.contact_id, co.wa_id,
           st.status, (array['whatsapp', 'phone', 'whatsapp', 'whatsapp', 'dashboard', 'whatsapp', 'whatsapp', 'phone', 'whatsapp', 'whatsapp'])[i + 1],
           'slot', v_today, v_at, v_at + interval '30 minutes', v_at, reasons[i + 1], i in (0, 7),
           (array[300, 600, 700, 150, 3000, 1500, 150, 300, 400, 600])[i + 1],
           (array['300 ج', '600 ج', '700 ج', '150 ج', '3,000 ج', '1,500 – 2,500 ج', '150 ج', '300 ج', '400 ج', '600 ج'])[i + 1],
           case when st.status <> 'booked' then v_at - interval '1 day' end,
           case when st.status in ('arrived', 'in_visit', 'done') then least(v_at - interval '8 minutes', now() - make_interval(mins => 4 + i * 3)) end,
           case when st.status in ('in_visit', 'done') then v_at + interval '4 minutes' end,
           case when st.status = 'done' then v_at + interval '28 minutes' end,
           now() - make_interval(days => 3 + i)
      from (select case
              when v_at + interval '30 minutes' <= now() - interval '5 minutes' then (case when i = 2 then 'no_show' else 'done' end)
              when v_at <= now() then 'in_visit'
              when v_at <= now() + interval '35 minutes' then 'arrived'
              when i % 3 = 0 then 'booked' else 'confirmed' end as status) st,
           clinic.patient_contacts pc join clinic.contacts co on co.id = pc.contact_id
     where pc.patient_id = p[i + 1];
  end loop;

  -- the paediatrician's queue: numbers every 15 minutes
  for i in 1 .. 11 loop
    v_at := (v_qstart + make_interval(mins => (i - 1) * 15)) at time zone tz;
    exit when v_at > (v_end at time zone tz) - interval '15 minutes';
    v_seq := v_seq + 1;
    insert into clinic.appointments (tenant_id, ref_no, doctor_id, location_id, service_id, patient_id, contact_id, wa_id, status, source, mode,
                                     session_date, starts_at, ends_at, est_at, queue_no, reason, is_new_patient, is_follow_up, price, price_text,
                                     confirmed_at, arrived_at, visit_started_at, visit_ended_at, created_at, urgency)
    select t, 'NC-' || v_seq, d2, nasr, case when i % 4 = 0 then s_kfu else s_kid end, p[9 + ((i - 1) % 5) + 1], pc.contact_id, co.wa_id, st.status,
           case when i % 3 = 0 then 'phone' else 'whatsapp' end, 'queue', v_today, v_qstart at time zone tz, v_end at time zone tz, v_at, i,
           reasons[9 + ((i - 1) % 5) + 1], i = 3, i % 4 = 0, case when i % 4 = 0 then 0 else 350 end, case when i % 4 = 0 then 'مجانًا' else '350 ج' end,
           case when st.status <> 'booked' then v_at - interval '20 hours' end,
           case when st.status in ('arrived', 'in_visit', 'done') then least(v_at - interval '5 minutes', now() - make_interval(mins => 2 + i)) end,
           case when st.status in ('in_visit', 'done') then v_at end,
           case when st.status = 'done' then v_at + interval '13 minutes' end,
           now() - make_interval(hours => 30 + i), 'routine'
      from (select case
              when v_at + interval '15 minutes' <= now() then 'done'
              when v_at <= now() then 'in_visit'
              when v_at <= now() + interval '35 minutes' then 'arrived'
              when i % 2 = 0 then 'confirmed' else 'booked' end as status) st,
           clinic.patient_contacts pc join clinic.contacts co on co.id = pc.contact_id
     where pc.patient_id = p[9 + ((i - 1) % 5) + 1];
  end loop;

  -- the dentist is 20 minutes late for the rest of the session: the times moved, and answers are coming in
  insert into clinic.delay_notices (tenant_id, doctor_id, location_id, session_date, kind, minutes, reason, via, created_by_name, status, sent_at, counts)
  values (t, d1, maadi, v_today, 'delay', 20, 'حالة طارئة في المستشفى', 'whatsapp', 'د. منى عادل', 'sent', now() - interval '25 minutes', '{}')
  returning id into v_notice;
  set constraints clinic.appointments_doctor_free, clinic.appointments_resource_free deferred;
  update clinic.appointments set original_starts_at = starts_at, starts_at = starts_at + interval '20 minutes', ends_at = ends_at + interval '20 minutes',
                                 est_at = starts_at + interval '20 minutes', delay_minutes = 20
   where tenant_id = t and doctor_id = d1 and session_date = v_today and status in ('booked', 'confirmed') ;
  insert into clinic.delay_notice_items (tenant_id, notice_id, appointment_id, wa_id, old_at, new_at, status, replied_at, reply_due_at)
  select t, v_notice, a.id, a.wa_id, a.original_starts_at, a.starts_at,
         (array['accepted', 'accepted', 'sent', 'changed', 'no_reply'])[least(row_number() over (order by a.starts_at), 5)],
         case when row_number() over (order by a.starts_at) in (1, 2, 4) then now() - interval '15 minutes' end, now() + interval '20 minutes'
    from clinic.appointments a where a.tenant_id = t and a.doctor_id = d1 and a.session_date = v_today and a.delay_minutes = 20;

  -- what the patients sent before their visit
  update clinic.appointments set pre_visit = '{"آخر مرة كشف أسنان": "من سنة", "بياخد أدوية سيولة؟": "لا"}'
   where id = (select id from clinic.appointments where tenant_id = t and doctor_id = d1 and session_date = v_today and status in ('arrived', 'confirmed', 'booked') order by starts_at limit 1);

  -- bookings the assistant made today, for the next days; and tomorrow's list
  for i in 1 .. 6 loop
    v_seq := v_seq + 1;
    v_at := ((v_today + 1 + (i / 3)) + time '17:00' + make_interval(mins => i * 45)) at time zone tz;
    insert into clinic.appointments (tenant_id, ref_no, doctor_id, location_id, resource_id, service_id, patient_id, contact_id, wa_id, status, source,
                                     mode, session_date, starts_at, ends_at, est_at, reason, price, price_text, created_at, is_new_patient)
    select t, 'NC-' || v_seq, d1, maadi, ch1, (array[s_chk, s_scl, s_white, s_fill, s_chk, s_rct])[i], p[14 + ((i - 1) % 4) + 1], pc.contact_id, co.wa_id,
           'booked', 'whatsapp', 'slot', (v_at at time zone tz)::date, v_at, v_at + interval '30 minutes', v_at, reasons[14 + ((i - 1) % 4) + 1],
           300, '300 ج', now() - make_interval(mins => 12 + i * 41), i % 2 = 1
      from clinic.patient_contacts pc join clinic.contacts co on co.id = pc.contact_id where pc.patient_id = p[14 + ((i - 1) % 4) + 1];
  end loop;
  update clinic.tenants set appt_seq = v_seq where id = t;

  -- the past month: visits done, so profiles and patterns have a history
  for i in 1 .. 26 loop
    v_seq := v_seq + 1;
    v_at := ((v_today - (i + 1)) + time '17:30' + make_interval(mins => (i % 6) * 30)) at time zone tz;
    insert into clinic.appointments (tenant_id, ref_no, doctor_id, location_id, service_id, patient_id, contact_id, wa_id, status, source, mode,
                                     session_date, starts_at, ends_at, est_at, price, price_text, visit_started_at, visit_ended_at, created_at)
    select t, 'NC-' || v_seq, d1, maadi, (array[s_chk, s_scl, s_fill, s_fol])[1 + i % 4], p[1 + i % 9], pc.contact_id, co.wa_id,
           case when i % 9 = 0 then 'no_show' else 'done' end, case when i % 3 = 0 then 'phone' else 'whatsapp' end, 'slot',
           (v_at at time zone tz)::date, v_at, v_at + interval '30 minutes', v_at, 300, '300 ج', v_at, v_at + interval '25 minutes', v_at - interval '3 days'
      from clinic.patient_contacts pc join clinic.contacts co on co.id = pc.contact_id where pc.patient_id = p[1 + i % 9];
  end loop;
  update clinic.tenants set appt_seq = v_seq where id = t;

  -- what needs someone: a possible emergency on WhatsApp, a patient who has not answered the delay, a booking not confirmed
  select id into conv from clinic.conversations where tenant_id = t and contact_id = (select contact_id from clinic.patient_contacts where patient_id = p[12]);
  insert into clinic.messages (tenant_id, conversation_id, wa_id, direction, sender, body, status, created_at)
  select t, conv, wa_id, 'inbound', 'patient', 'ابني عنده سخونية 40 ومش قادر ياخد نفسه كويس وشفايفه زرقا شوية', 'received', now() - interval '3 minutes'
    from clinic.conversations where id = conv;
  insert into clinic.messages (tenant_id, conversation_id, wa_id, direction, sender, body, status, created_at)
  select t, conv, wa_id, 'outbound', 'agent', 'ده محتاج طوارئ حالًا 🙏 لو مش قادر ياخد نفسه أو شفايفه زرقا، اتصلي بالإسعاف 123 أو روحي أقرب طوارئ دلوقتي. بلغت د. كريم وهيكلمك.', 'sent', now() - interval '2 minutes'
    from clinic.conversations where id = conv;
  update clinic.conversations set urgency = 'emergency', needs_attention = true, attention_reason = 'سخونية 40 وصعوبة في التنفس', attention_at = now() - interval '2 minutes',
                                  last_message_preview = 'ده محتاج طوارئ حالًا 🙏', last_message_at = now() - interval '2 minutes', unread_count = 1
   where id = conv;
  insert into clinic.alerts (tenant_id, kind, severity, title, body, patient_id, contact_id, wa_id, conversation_id, doctor_id, created_at)
  select t, 'emergency', 'critical', 'حالة طارئة محتملة', 'ابني عنده سخونية 40 ومش قادر ياخد نفسه كويس وشفايفه زرقا شوية', p[12], co.contact_id, cv.wa_id, conv, d2, now() - interval '2 minutes'
    from clinic.conversations cv cross join lateral (select contact_id from clinic.patient_contacts where patient_id = p[12]) co where cv.id = conv;
  insert into clinic.alerts (tenant_id, kind, severity, title, body, patient_id, wa_id, appointment_id, doctor_id, created_at)
  select t, 'no_reply', 'normal', 'مريض مردش على تغيير الميعاد', a.reason, a.patient_id, a.wa_id, a.id, d1, now() - interval '6 minutes'
    from clinic.delay_notice_items i join clinic.appointments a on a.id = i.appointment_id where i.notice_id = v_notice and i.status = 'no_reply' limit 1;
  insert into clinic.alerts (tenant_id, kind, severity, title, body, patient_id, wa_id, appointment_id, doctor_id, created_at)
  select t, 'at_risk', 'normal', 'ميعاد لسه متأكدش', 'مأكدش بعد التذكيرين', a.patient_id, a.wa_id, a.id, a.doctor_id, now() - interval '50 minutes'
    from clinic.appointments a where a.tenant_id = t and a.session_date = v_today + 1 and a.status = 'booked' order by a.starts_at limit 1;

  -- a question the assistant asked the doctor
  insert into clinic.team_questions (tenant_id, conversation_id, wa_id, question, status, asked_at)
  select t, cv.id, cv.wa_id, 'المريضة بتسأل: ينفع تعمل تبييض وهي حامل في الشهر الرابع؟', 'open', now() - interval '18 minutes'
    from clinic.conversations cv where cv.tenant_id = t and cv.contact_id = (select contact_id from clinic.patient_contacts where patient_id = p[5]);
  update clinic.conversations set questions_open = 1, needs_attention = true where tenant_id = t and contact_id = (select contact_id from clinic.patient_contacts where patient_id = p[5]);

  -- people waiting for an earlier time
  insert into clinic.waitlist (tenant_id, patient_id, contact_id, wa_id, doctor_id, location_id, service_id, from_date, to_date, band, status, created_at)
  select t, p[15 + k], pc.contact_id, co.wa_id, d1, maadi, s_chk, v_today, v_today + 7, (array['evening', 'any', 'afternoon'])[k + 1], 'waiting', now() - make_interval(hours => k * 5 + 2)
    from generate_series(0, 2) k join clinic.patient_contacts pc on pc.patient_id = p[15 + k] join clinic.contacts co on co.id = pc.contact_id;
end $$;
