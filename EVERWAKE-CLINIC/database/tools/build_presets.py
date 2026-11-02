#!/usr/bin/env python3
"""Writes migrations/020_specialty_presets.sql — the shipped specialities.

Each preset carries: the words patients use for it (to route a complaint to
the right doctor in a polyclinic), starter services (prices left empty for
the doctor), a history form, and the red-flag words that make the agent
treat a message as urgent or an emergency. Edit here, then run:

    python3 database/tools/build_presets.py
"""
import json, os

def f(key, ar, en, type='text', unit=None, options=None):
    d = {'key': key, 'label_ar': ar, 'label_en': en, 'type': type}
    if unit: d['unit'] = unit
    if options: d['options'] = options
    return d

def sec(key, ar, en, fields):
    return {'key': key, 'title_ar': ar, 'title_en': en, 'fields': fields}

COMPLAINT = sec('complaint', 'الشكوى', 'Complaint', [
    f('chief_complaint', 'الشكوى الأساسية', 'Chief complaint', 'textarea'),
    f('onset', 'بدأت امتى', 'Onset'),
    f('duration', 'المدة', 'Duration'),
    f('severity', 'الشدة', 'Severity', 'scale'),
    f('hpi', 'تفاصيل الشكوى', 'History of present illness', 'textarea'),
    f('associated', 'أعراض مصاحبة', 'Associated symptoms', 'textarea'),
])
HISTORY = sec('history', 'التاريخ المرضي', 'History', [
    f('past_medical', 'أمراض سابقة / مزمنة', 'Past medical history', 'textarea'),
    f('past_surgical', 'عمليات سابقة', 'Past surgical history', 'textarea'),
    f('medications', 'أدوية حالية', 'Current medications', 'textarea'),
    f('allergies', 'حساسية', 'Allergies', 'textarea'),
    f('family', 'تاريخ عائلي', 'Family history', 'textarea'),
    f('social', 'تدخين / عادات', 'Smoking / social', 'textarea'),
])
VITALS = sec('vitals', 'العلامات الحيوية', 'Vitals', [
    f('bp', 'الضغط', 'Blood pressure', 'text', 'mmHg'),
    f('pulse', 'النبض', 'Pulse', 'number', 'bpm'),
    f('temp', 'الحرارة', 'Temperature', 'number', '°C'),
    f('spo2', 'الأكسجين', 'SpO2', 'number', '%'),
    f('weight', 'الوزن', 'Weight', 'number', 'kg'),
    f('height', 'الطول', 'Height', 'number', 'cm'),
])
def EXAM(fields):
    return sec('exam', 'الكشف', 'Examination', [f('general', 'الحالة العامة', 'General', 'textarea')] + fields)
PLAN = sec('plan', 'التشخيص والخطة', 'Assessment & plan', [
    f('investigations', 'تحاليل / أشعة مطلوبة', 'Investigations', 'textarea'),
    f('diagnosis', 'التشخيص', 'Diagnosis', 'textarea'),
    f('treatment', 'العلاج', 'Treatment', 'textarea'),
    f('advice', 'تعليمات للمريض', 'Advice', 'textarea'),
    f('follow_up', 'المتابعة', 'Follow-up', 'text'),
])

def form(extra_sections=None, exam=None, history_extra=None):
    hist = json.loads(json.dumps(HISTORY))
    if history_extra: hist['fields'] += history_extra
    s = [COMPLAINT, hist, VITALS, EXAM(exam or [])]
    if extra_sections: s += extra_sections
    s.append(PLAN)
    return {'sections': s}

def svc(name_ar, name_en, category='consultation', duration=20, price_kind='fixed', unit='visit', aliases=(), **kw):
    d = {'name_ar': name_ar, 'name_en': name_en, 'category': category, 'duration': duration,
         'price_kind': price_kind, 'unit': unit, 'aliases': list(aliases)}
    d.update(kw)
    return d

def base_services(extra=()):
    return [svc('كشف', 'Consultation', 'consultation', 20, aliases=['كشف جديد', 'consultation', 'checkup']),
            svc('إعادة / استشارة', 'Follow-up visit', 'follow_up', 15, aliases=['اعاده', 'استشاره', 'متابعه', 'follow up'])] + list(extra)

def tri(level, words, why):
    return {'level': level, 'words': words, 'why': why}

AFTER_EXTRACTION = ('اعضض على الشاش نص ساعة. متاكلش ولا تشرب سخن لمدة ساعتين. متمضمضش ولا تتف بقوة أول 24 ساعة. '
                    'ممنوع التدخين والشفاط. كمادات تلج من بره أول يوم لو في ورم. لو النزيف ما وقفش بعد ساعة كلمنا فوراً.')
AFTER_RCT = 'ممكن يكون في ألم خفيف يومين، خد المسكن اللي الدكتور كتبه. متمضغش على الناحية دي لحد ما الطربوش أو الحشو النهائي يتركب.'
AFTER_WHITENING = 'ابعد عن الشاي والقهوة والكولا والأكل الملوّن والتدخين 48 ساعة. ممكن يكون في حساسية خفيفة يوم أو اتنين وبتروح لوحدها.'
AFTER_IMPLANT = 'كمادات تلج من بره أول يوم، أكل طري وبارد 3 أيام، متمضغش على الزرعة، ومفيش تدخين. خد المضاد والمسكن في مواعيدهم.'
AFTER_SCALING = 'ممكن اللثة تنزف شوية أو يكون في حساسية يومين. استعمل فرشاة ناعمة ومعجون للحساسية، وحافظ على التنضيف كل 6 شهور.'

P = []
def preset(code, ar, en, group, keywords, services, form_t, triage=(), sort=100):
    P.append({'code': code, 'name_ar': ar, 'name_en': en, 'group_name': group, 'keywords': keywords,
              'starter_services': services, 'form_template': form_t, 'triage': list(triage), 'sort': sort})

DENTAL_FORM = {'sections': [
    sec('complaint', 'الشكوى', 'Complaint', [
        f('chief_complaint', 'الشكوى الأساسية', 'Chief complaint', 'textarea'),
        f('pain_site', 'مكان الألم (السنة)', 'Pain site (tooth)'),
        f('pain_character', 'نوع الألم', 'Pain character', 'select', options=['مستمر', 'متقطع', 'نابض', 'مع الأكل', 'بالليل']),
        f('triggers', 'بيزيد مع', 'Triggers', 'multiselect', options=['سخن', 'ساقع', 'حلو', 'العض', 'لوحده']),
        f('duration', 'المدة', 'Duration'),
        f('swelling', 'ورم', 'Swelling', 'boolean'),
    ]),
    sec('dental_history', 'تاريخ الأسنان', 'Dental history', [
        f('last_visit', 'آخر زيارة لدكتور أسنان', 'Last dental visit'),
        f('previous_treatment', 'علاجات سابقة', 'Previous treatment', 'textarea'),
        f('brushing', 'تفريش الأسنان', 'Brushing', 'select', options=['مرتين يومياً', 'مرة يومياً', 'أحياناً', 'نادراً']),
        f('bleeding_gums', 'نزيف اللثة', 'Bleeding gums', 'boolean'),
        f('bruxism', 'جز على الأسنان', 'Grinding (bruxism)', 'boolean'),
    ]),
    sec('medical', 'التاريخ الطبي', 'Medical history', [
        f('conditions', 'سكر / ضغط / قلب / أمراض مزمنة', 'Diabetes / BP / heart / chronic', 'textarea'),
        f('anticoagulants', 'أدوية سيولة', 'Blood thinners', 'boolean'),
        f('pregnancy', 'حمل', 'Pregnancy', 'boolean'),
        f('allergies', 'حساسية (بنج / بنسلين / غيره)', 'Allergies (anaesthetic / penicillin / other)', 'textarea'),
        f('medications', 'أدوية حالية', 'Current medications', 'textarea'),
        f('smoking', 'تدخين', 'Smoking', 'boolean'),
    ]),
    sec('exam', 'الكشف', 'Examination', [
        f('extraoral', 'من بره (ورم، غدد، المفصل)', 'Extra-oral (swelling, nodes, TMJ)', 'textarea'),
        f('hygiene', 'نظافة الفم', 'Oral hygiene', 'select', options=['ممتازة', 'جيدة', 'متوسطة', 'ضعيفة']),
        f('gingiva', 'اللثة', 'Gingiva', 'textarea'),
        f('occlusion', 'الإطباق', 'Occlusion', 'text'),
        f('teeth', 'الأسنان', 'Teeth', 'tooth_chart'),
    ]),
    sec('plan', 'التشخيص والخطة', 'Diagnosis & plan', [
        f('xrays', 'الأشعة', 'X-rays', 'textarea'),
        f('diagnosis', 'التشخيص', 'Diagnosis', 'textarea'),
        f('treatment_plan', 'خطة العلاج', 'Treatment plan', 'treatment_plan'),
        f('done_today', 'اللي اتعمل النهارده', 'Done today', 'textarea'),
        f('advice', 'تعليمات', 'Advice', 'textarea'),
        f('follow_up', 'الجلسة الجاية', 'Next session'),
    ]),
]}

preset('dentistry', 'طب الأسنان', 'Dentistry', 'dental',
  ['سنان', 'اسنان', 'سنه', 'سنة', 'ضرس', 'ضروس', 'ضرسي', 'لثه', 'لثة', 'تقويم', 'حشو', 'خلع', 'تبييض', 'زرعه', 'زرعة', 'فك', 'عصب',
   'طربوش', 'تركيبه', 'جير', 'tooth', 'teeth', 'dental', 'dentist', 'gum', 'braces', 'implant'],
  [svc('كشف أسنان', 'Dental check-up', 'consultation', 20, aliases=['كشف', 'كشف اسنان', 'checkup', 'dental exam'], resource_kind='chair'),
   svc('إعادة / متابعة', 'Follow-up', 'follow_up', 15, aliases=['متابعه', 'اعاده', 'follow up'], resource_kind='chair'),
   svc('أشعة بانوراما', 'Panoramic X-ray', 'diagnostic', 15, aliases=['بانوراما', 'اشعه بانوراما', 'panorama', 'opg']),
   svc('أشعة صغيرة على سنة', 'Periapical X-ray', 'diagnostic', 10, aliases=['اشعه صغيره', 'x-ray', 'periapical']),
   svc('تنضيف جير وتلميع', 'Scaling and polishing', 'procedure', 40, aliases=['تنظيف', 'تنضيف', 'جير', 'تلميع', 'تنظيف اسنان', 'scaling', 'cleaning'],
       resource_kind='chair', aftercare_ar=AFTER_SCALING),
   svc('حشو كومبوزيت (تجميلي)', 'Composite filling', 'procedure', 45, unit='tooth', aliases=['حشو', 'حشو عادي', 'حشو ابيض', 'حشوه', 'filling'], resource_kind='chair'),
   svc('حشو عصب', 'Root canal treatment', 'procedure', 60, price_kind='range', unit='tooth', sessions=2, session_gap_days=7,
       aliases=['علاج عصب', 'سحب عصب', 'عصب', 'root canal', 'rct'], resource_kind='chair', aftercare_ar=AFTER_RCT,
       price_note_ar='حسب عدد القنوات وحالة السنة'),
   svc('خلع عادي', 'Simple extraction', 'procedure', 30, unit='tooth', aliases=['خلع', 'خلع سنه', 'خلع ضرس', 'extraction'],
       resource_kind='chair', aftercare_ar=AFTER_EXTRACTION),
   svc('خلع ضرس عقل جراحي', 'Surgical wisdom tooth extraction', 'procedure', 60, price_kind='range', unit='tooth',
       aliases=['ضرس العقل', 'خلع جراحي', 'wisdom tooth'], resource_kind='chair', aftercare_ar=AFTER_EXTRACTION, needs_consult_first=True),
   svc('طربوش زيركون', 'Zirconia crown', 'procedure', 45, unit='tooth', sessions=2, session_gap_days=7,
       aliases=['طربوش', 'زيركون', 'تلبيسه', 'crown', 'zirconia'], resource_kind='chair', needs_consult_first=True),
   svc('طربوش بورسلين', 'Porcelain crown', 'procedure', 45, unit='tooth', sessions=2, session_gap_days=7,
       aliases=['بورسلين', 'porcelain'], resource_kind='chair', needs_consult_first=True),
   svc('زرعة أسنان', 'Dental implant', 'procedure', 90, price_kind='range', unit='tooth', sessions=3, session_gap_days=90,
       aliases=['زرعه', 'زراعة اسنان', 'زراعه', 'implant'], resource_kind='chair', aftercare_ar=AFTER_IMPLANT, needs_consult_first=True,
       price_note_ar='حسب نوع الزرعة وحالة العظم'),
   svc('تبييض الأسنان', 'Teeth whitening', 'cosmetic', 60, unit='course', aliases=['تبييض', 'تفتيح', 'whitening', 'bleaching'],
       resource_kind='chair', aftercare_ar=AFTER_WHITENING),
   svc('فينير', 'Veneers', 'cosmetic', 60, price_kind='range', unit='tooth', aliases=['فنير', 'عدسات', 'veneer', 'hollywood smile'],
       resource_kind='chair', needs_consult_first=True),
   svc('تقويم ثابت', 'Fixed braces', 'procedure', 45, price_kind='range', unit='course', sessions=18, session_gap_days=30,
       aliases=['تقويم', 'تقويم معدن', 'braces'], resource_kind='chair', needs_consult_first=True),
   svc('تقويم شفاف', 'Clear aligners', 'procedure', 30, price_kind='range', unit='course', aliases=['انفزلاين', 'تقويم شفاف', 'aligners', 'invisalign'],
       needs_consult_first=True),
   svc('طقم أسنان', 'Dentures', 'procedure', 40, price_kind='range', unit='jaw', sessions=4, session_gap_days=7,
       aliases=['طقم', 'طقم متحرك', 'dentures'], resource_kind='chair', needs_consult_first=True),
   svc('علاج اللثة', 'Gum treatment', 'procedure', 45, unit='session', aliases=['لثه', 'التهاب لثه', 'gum'], resource_kind='chair'),
   svc('حشو أسنان لبنية', 'Children\'s filling', 'procedure', 30, unit='tooth', aliases=['حشو اطفال', 'سنان لبن'], resource_kind='chair', max_age=12),
   svc('فلورايد للأطفال', 'Fluoride (children)', 'procedure', 20, aliases=['فلورايد', 'fluoride'], resource_kind='chair', max_age=14)],
  DENTAL_FORM,
  [tri('emergency', ['وشي وارم', 'ورم في وشي', 'خدي وارم جامد', 'مش قادر ابلع', 'مش قادره ابلع', 'صعوبه في البلع', 'مش قادر اتنفس', 'رقبتي وارمه',
                     'face swelling', 'cant swallow', 'difficulty breathing'],
       'facial swelling with trouble swallowing or breathing can be a spreading infection'),
   tri('urgent', ['سنتي وقعت', 'السنه وقعت', 'السنه طلعت من مكانها', 'سنه اتخلعت', 'خبطه في سناني', 'نزيف بعد الخلع', 'النزيف مش بيقف', 'مش بيقف نزيف',
                  'knocked out tooth', 'tooth knocked out', 'bleeding after extraction'],
       'a knocked-out tooth should be seen within the hour; bleeding that will not stop after an extraction needs the dentist now')],
  sort=1)

preset('general', 'ممارس عام', 'General practice', 'medical', ['كشف', 'عام', 'تعبان', 'سخونيه', 'برد', 'general'],
  base_services([svc('قياس ضغط وسكر', 'Blood pressure and sugar check', 'diagnostic', 10, aliases=['قياس ضغط', 'قياس سكر'])]),
  form(), sort=2)
preset('internal', 'باطنة', 'Internal medicine', 'medical',
  ['باطنه', 'معده', 'قولون', 'سكر', 'ضغط', 'كبد', 'سخونيه', 'حراره', 'internal'],
  base_services([svc('رسم قلب', 'ECG', 'diagnostic', 15, aliases=['ecg', 'رسم القلب']),
                 svc('سونار بطن', 'Abdominal ultrasound', 'diagnostic', 20, aliases=['سونار', 'سونار على البطن', 'ultrasound'])]),
  form(exam=[f('chest', 'الصدر', 'Chest', 'textarea'), f('heart', 'القلب', 'Heart', 'textarea'), f('abdomen', 'البطن', 'Abdomen', 'textarea'),
             f('lower_limbs', 'الرجلين', 'Lower limbs', 'textarea')]),
  [tri('emergency', ['سكري واطي جدا', 'هبوط سكر', 'غيبوبه سكر', 'تقيأ دم', 'ترجيع دم', 'براز اسود'], 'possible hypoglycaemia or GI bleeding')], sort=3)
preset('pediatrics', 'أطفال', 'Paediatrics', 'medical',
  ['ابني', 'بنتي', 'طفل', 'طفله', 'عيل', 'رضيع', 'رضيعه', 'بيبي', 'تطعيم', 'تطعيمات', 'سنتين', 'شهور', 'child', 'baby', 'kid'],
  base_services([svc('متابعة نمو وتطعيمات', 'Growth and vaccination check', 'consultation', 20, aliases=['تطعيم', 'متابعه نمو', 'vaccination']),
                 svc('جلسة بخار (نيبولايزر)', 'Nebuliser session', 'procedure', 20, aliases=['بخار', 'جلسه بخار', 'nebulizer'])]),
  form(history_extra=[f('birth', 'الولادة (طبيعي/قيصري، أسبوع كام)', 'Birth history'), f('feeding', 'الرضاعة / الأكل', 'Feeding'),
                      f('vaccinations', 'التطعيمات', 'Vaccinations', 'textarea'), f('development', 'النمو والتطور', 'Development', 'textarea')],
       exam=[f('head_circ', 'محيط الرأس', 'Head circumference', 'number', 'cm'), f('chest', 'الصدر', 'Chest', 'textarea'),
             f('ent', 'الأنف والأذن والحلق', 'ENT', 'textarea'), f('abdomen', 'البطن', 'Abdomen', 'textarea')]),
  [tri('emergency', ['تشنجات', 'بيتشنج', 'اتشنج', 'ازرق', 'لونه ازرق', 'مش بيصحى', 'مش بيفوق', 'مش بيتنفس', 'نفسه بيتقطع', 'بلع حاجه', 'convulsion', 'not breathing'],
       'seizure, blue colour, not waking or breathing difficulty in a child'),
   tri('urgent', ['رضيع سخن', 'عنده شهرين وسخن', 'مش بيرضع خالص', 'مبيبولش', 'ترجيع كتير', 'جفاف'], 'fever in a young infant, not feeding, dehydration')], sort=4)
preset('obgyn', 'نساء وتوليد', 'Obstetrics & gynaecology', 'medical',
  ['حامل', 'حمل', 'دوره', 'الدوره', 'رحم', 'ولاده', 'سونار', 'تأخير', 'متابعه حمل', 'pregnant', 'pregnancy', 'period', 'gyn'],
  base_services([svc('متابعة حمل', 'Antenatal visit', 'consultation', 20, aliases=['متابعه حمل', 'antenatal']),
                 svc('سونار رباعي الأبعاد', '4D ultrasound', 'diagnostic', 30, aliases=['سونار 4d', 'رباعي', '4d']),
                 svc('سونار مهبلي', 'Transvaginal ultrasound', 'diagnostic', 20, aliases=['سونار مهبلي'])]),
  form(history_extra=[f('lmp', 'آخر دورة', 'Last menstrual period', 'date'), f('gravida', 'عدد مرات الحمل/الولادة', 'Gravida / para'),
                      f('cycle', 'انتظام الدورة', 'Cycle'), f('contraception', 'وسيلة منع الحمل', 'Contraception')],
       exam=[f('abdomen', 'البطن', 'Abdomen', 'textarea'), f('fundal_height', 'ارتفاع الرحم', 'Fundal height', 'number', 'cm'),
             f('fetal_heart', 'نبض الجنين', 'Fetal heart', 'number', 'bpm'), f('ultrasound', 'السونار', 'Ultrasound', 'textarea')]),
  [tri('emergency', ['نزيف وانا حامل', 'حامل ونازل دم', 'نزيف جامد', 'المايه نزلت', 'نزلت مايه', 'حامل ومغص جامد', 'حامل وتشنجات', 'صداع جامد وزغلله وانا حامل'],
       'bleeding, waters breaking, severe pain or pre-eclampsia signs in pregnancy'),
   tri('urgent', ['حركه الجنين قلت', 'البيبي مش بيتحرك', 'مش حاسه بحركه'], 'reduced fetal movements')], sort=5)
preset('dermatology', 'جلدية وتجميل', 'Dermatology', 'medical',
  ['جلد', 'جلديه', 'حبوب', 'حب الشباب', 'بقع', 'اكزيما', 'صدفيه', 'شعر', 'تساقط', 'ليزر', 'بشره', 'حكه', 'skin', 'acne', 'hair', 'laser'],
  base_services([svc('جلسة ليزر إزالة شعر', 'Laser hair removal session', 'cosmetic', 30, unit='area', aliases=['ليزر', 'ازاله شعر', 'laser'], resource_kind='laser'),
                 svc('تقشير كيميائي', 'Chemical peel', 'cosmetic', 30, unit='session', aliases=['تقشير', 'peeling']),
                 svc('بلازما للشعر', 'PRP for hair', 'cosmetic', 30, unit='session', sessions=4, session_gap_days=30, aliases=['بلازما', 'prp']),
                 svc('ديرمابن', 'Microneedling', 'cosmetic', 40, unit='session', aliases=['ديرمابن', 'microneedling'])]),
  form(exam=[f('lesion', 'شكل الإصابة', 'Lesion description', 'textarea'), f('distribution', 'المكان والتوزيع', 'Distribution', 'textarea'),
             f('skin_type', 'نوع البشرة', 'Skin type', 'select', options=['I', 'II', 'III', 'IV', 'V', 'VI'])]),
  [tri('emergency', ['شفايفي ورمت', 'وشي ورم بعد الدوا', 'حساسيه جامده ونفسي', 'ورم في الزور'], 'possible anaphylaxis / angioedema')], sort=6)
preset('ophthalmology', 'رمد وعيون', 'Ophthalmology', 'medical',
  ['عين', 'عيني', 'عيون', 'نظاره', 'نظر', 'رمد', 'مياه بيضا', 'مياه زرقا', 'ليزك', 'eye', 'vision', 'lasik'],
  base_services([svc('قياس نظر', 'Refraction', 'diagnostic', 15, aliases=['قياس نظر', 'كشف نظر']),
                 svc('قياس ضغط العين', 'Eye pressure test', 'diagnostic', 10, aliases=['ضغط العين']),
                 svc('فحص قاع العين', 'Fundus exam', 'diagnostic', 20, aliases=['قاع العين'])]),
  form(exam=[f('va_right', 'حدة الإبصار يمين', 'Visual acuity R'), f('va_left', 'حدة الإبصار شمال', 'Visual acuity L'),
             f('iop', 'ضغط العين', 'IOP', 'text', 'mmHg'), f('anterior', 'الجزء الأمامي', 'Anterior segment', 'textarea'),
             f('fundus', 'قاع العين', 'Fundus', 'textarea')]),
  [tri('emergency', ['مش شايف فجأه', 'النظر راح فجأه', 'ماده كيماويه في عيني', 'كلور في عيني', 'حاجه دخلت في عيني', 'ضربه في عيني'],
       'sudden loss of vision, chemical or penetrating eye injury')], sort=7)
preset('ent', 'أنف وأذن وحنجرة', 'ENT', 'medical',
  ['ودن', 'ودني', 'اذن', 'زور', 'لوز', 'لوزتين', 'جيوب', 'مناخير', 'انف', 'صوت', 'شخير', 'ear', 'throat', 'nose', 'sinus'],
  base_services([svc('غسيل أذن', 'Ear wash', 'procedure', 15, aliases=['غسيل ودن', 'شمع']), svc('منظار أنف', 'Nasal endoscopy', 'diagnostic', 20, aliases=['منظار'])]),
  form(exam=[f('ears', 'الأذن', 'Ears', 'textarea'), f('nose', 'الأنف', 'Nose', 'textarea'), f('throat', 'الحلق', 'Throat', 'textarea'), f('neck', 'الرقبة', 'Neck', 'textarea')]),
  [tri('emergency', ['مش قادر اتنفس', 'جسم غريب في الزور', 'حاجه وقفت في زوري'], 'airway obstruction'),
   tri('urgent', ['نزيف من مناخيري مش بيقف', 'رعاف مش بيقف'], 'nosebleed that will not stop')], sort=8)
preset('cardiology', 'قلب وأوعية دموية', 'Cardiology', 'medical',
  ['قلب', 'ضغط', 'خفقان', 'صدري', 'نهجان', 'heart', 'pressure', 'palpitations'],
  base_services([svc('رسم قلب', 'ECG', 'diagnostic', 15, aliases=['ecg']), svc('إيكو على القلب', 'Echocardiogram', 'diagnostic', 30, aliases=['ايكو', 'echo']),
                 svc('هولتر', 'Holter monitor', 'diagnostic', 20, aliases=['هولتر', 'holter'])]),
  form(exam=[f('heart', 'القلب', 'Heart', 'textarea'), f('ecg', 'رسم القلب', 'ECG', 'textarea'), f('edema', 'ورم بالرجلين', 'Oedema', 'boolean')]),
  [tri('emergency', ['الم في صدري', 'وجع في صدري', 'صدري واجعني', 'ضغط على صدري', 'عرق وصدري', 'وجع بيروح لدراعي', 'مش قادر اخد نفسي', 'اغمى عليا'],
       'chest pain, breathlessness or fainting')], sort=9)
preset('orthopedics', 'عظام', 'Orthopaedics', 'medical',
  ['عضم', 'عظام', 'ركبه', 'ضهر', 'فقرات', 'كسر', 'مفصل', 'كتف', 'رقبه', 'غضروف', 'bone', 'knee', 'back', 'fracture'],
  base_services([svc('حقنة مفصل', 'Joint injection', 'procedure', 20, aliases=['حقنه', 'حقن مفصل']), svc('جبيرة', 'Cast', 'procedure', 30, aliases=['جبس', 'جبيره'])]),
  form(exam=[f('site', 'المكان', 'Site'), f('rom', 'مدى الحركة', 'Range of motion', 'textarea'), f('neuro', 'الأعصاب', 'Neurovascular', 'textarea'),
             f('xray', 'الأشعة', 'X-ray', 'textarea')]),
  [tri('emergency', ['العضمه طالعه', 'كسر مفتوح', 'رجلي مش حاسس بيها بعد الوقعه'], 'open fracture or nerve/vessel injury'),
   tri('urgent', ['وقعت ومش قادر اقف', 'كسر'], 'possible fracture')], sort=10)
preset('neurology', 'مخ وأعصاب', 'Neurology', 'medical',
  ['صداع', 'دماغ', 'اعصاب', 'تنميل', 'صرع', 'دوخه', 'شلل', 'رعشه', 'nerve', 'headache', 'migraine', 'epilepsy'],
  base_services([svc('رسم مخ', 'EEG', 'diagnostic', 40, aliases=['eeg', 'رسم المخ']), svc('رسم أعصاب', 'Nerve conduction study', 'diagnostic', 40, aliases=['رسم اعصاب', 'emg'])]),
  form(exam=[f('consciousness', 'الوعي', 'Consciousness'), f('cranial', 'الأعصاب الدماغية', 'Cranial nerves', 'textarea'),
             f('motor', 'الحركة', 'Motor', 'textarea'), f('sensory', 'الإحساس', 'Sensory', 'textarea'), f('reflexes', 'الانعكاسات', 'Reflexes', 'textarea')]),
  [tri('emergency', ['وشي مايل', 'بقي مايل', 'كلامي تقيل', 'مش قادر احرك دراعي', 'نص جسمي', 'تشنجات', 'اسوأ صداع في حياتي', 'فقد الوعي'],
       'stroke signs, seizure or thunderclap headache')], sort=11)
preset('psychiatry', 'نفسية', 'Psychiatry', 'medical',
  ['نفسي', 'نفسيه', 'اكتئاب', 'قلق', 'نوم', 'ارق', 'توتر', 'وسواس', 'depression', 'anxiety', 'insomnia'],
  base_services(), form(exam=[f('mse', 'الحالة العقلية', 'Mental state exam', 'textarea'), f('risk', 'تقييم الخطورة', 'Risk assessment', 'textarea')]),
  [tri('emergency', ['عايز انتحر', 'عايزه انتحر', 'هموت نفسي', 'هأذي نفسي', 'مش عايز اعيش', 'هقتل نفسي', 'kill myself', 'suicide'],
       'risk of suicide or self-harm')], sort=12)
preset('urology', 'مسالك بولية', 'Urology', 'medical',
  ['مسالك', 'بروستاتا', 'كلى', 'حصوه', 'بول', 'حرقان', 'kidney stone', 'urine', 'prostate'],
  base_services([svc('سونار مسالك', 'Urinary ultrasound', 'diagnostic', 20, aliases=['سونار'])]),
  form(exam=[f('abdomen', 'البطن', 'Abdomen', 'textarea'), f('genital', 'الكشف', 'Genital exam', 'textarea')]),
  [tri('emergency', ['مش قادر اعمل حمام خالص', 'البول وقف', 'احتباس'], 'urinary retention'),
   tri('urgent', ['مغص كلوي جامد', 'دم في البول'], 'renal colic, blood in urine')], sort=13)
preset('physiotherapy', 'علاج طبيعي', 'Physiotherapy', 'medical',
  ['علاج طبيعي', 'جلسات', 'اصابه ملاعب', 'تأهيل', 'physio', 'rehab'],
  [svc('تقييم علاج طبيعي', 'Physiotherapy assessment', 'consultation', 40, aliases=['تقييم', 'كشف']),
   svc('جلسة علاج طبيعي', 'Physiotherapy session', 'procedure', 45, unit='session', aliases=['جلسه', 'جلسه علاج طبيعي'], resource_kind='bed'),
   svc('باكدج 10 جلسات', '10-session package', 'package', 45, unit='course', sessions=10, session_gap_days=3, aliases=['باكدج', 'باقة'])],
  form(exam=[f('posture', 'القوام', 'Posture', 'textarea'), f('rom', 'مدى الحركة', 'Range of motion', 'textarea'), f('strength', 'القوة العضلية', 'Strength', 'textarea')]),
  sort=14)
preset('nutrition', 'تغذية علاجية', 'Nutrition', 'medical',
  ['تخسيس', 'وزن', 'دايت', 'رجيم', 'تغذيه', 'تسمين', 'diet', 'weight'],
  [svc('كشف تغذية وتحليل جسم', 'Nutrition visit with body analysis', 'consultation', 30, aliases=['كشف', 'inbody', 'ان بادي']),
   svc('متابعة', 'Follow-up', 'follow_up', 15, aliases=['متابعه'])],
  form(exam=[f('bmi', 'مؤشر كتلة الجسم', 'BMI', 'number'), f('body_fat', 'نسبة الدهون', 'Body fat', 'number', '%'), f('waist', 'محيط الوسط', 'Waist', 'number', 'cm')]),
  sort=15)
for code, ar, en, kws, extra, trig, s in [
  ('gastroenterology', 'جهاز هضمي ومناظير', 'Gastroenterology', ['معده', 'قولون', 'منظار', 'حموضه', 'ارتجاع', 'colon', 'endoscopy'],
   [svc('منظار معدة', 'Upper endoscopy', 'procedure', 30, aliases=['منظار']), svc('منظار قولون', 'Colonoscopy', 'procedure', 45, aliases=['منظار قولون'], prep_ar='تعليمات التحضير هتوصلك من العيادة قبل الميعاد.')],
   [tri('emergency', ['ترجيع دم', 'براز اسود', 'نزيف من ورا كتير'], 'GI bleeding')], 16),
  ('endocrinology', 'غدد صماء وسكر', 'Endocrinology & diabetes', ['غده', 'درقيه', 'سكر', 'هرمونات', 'thyroid', 'diabetes'], [], [tri('emergency', ['السكر واطي جدا', 'غيبوبه سكر', 'السكر عالي جدا ومش فايق'], 'hypo- or hyperglycaemic emergency')], 17),
  ('pulmonology', 'صدر وحساسية', 'Chest & allergy', ['صدر', 'نفس', 'ربو', 'كحه', 'سعال', 'حساسيه صدر', 'asthma', 'cough'], [svc('وظائف تنفس', 'Spirometry', 'diagnostic', 20, aliases=['وظائف رئه'])], [tri('emergency', ['مش قادر اتنفس', 'نهجان جامد', 'شفايفي زرقا'], 'severe breathlessness')], 18),
  ('nephrology', 'كلى', 'Nephrology', ['كلى', 'غسيل كلوي', 'kidney'], [], [], 19),
  ('rheumatology', 'روماتيزم ومناعة', 'Rheumatology', ['روماتيزم', 'مفاصل', 'روماتويد', 'نقرس', 'مناعه'], [], [], 20),
  ('oncology', 'أورام', 'Oncology', ['اورام', 'ورم', 'كيماوي', 'tumor', 'cancer'], [], [], 21),
  ('general_surgery', 'جراحة عامة', 'General surgery', ['فتق', 'مراره', 'زايده', 'جراحه', 'عمليه', 'hernia'], [svc('غيار جرح', 'Wound dressing', 'procedure', 15, aliases=['غيار'])], [tri('emergency', ['مغص جامد في الجنب اليمين', 'بطني ناشفه'], 'acute abdomen')], 22),
  ('plastic_surgery', 'جراحة تجميل', 'Plastic surgery', ['تجميل', 'شفط', 'بوتوكس', 'فيلر', 'botox', 'filler'], [svc('بوتوكس', 'Botox', 'cosmetic', 30, unit='area', aliases=['botox']), svc('فيلر', 'Filler', 'cosmetic', 30, unit='unit', aliases=['filler'])], [], 23),
  ('vascular', 'أوعية دموية', 'Vascular surgery', ['دوالي', 'شرايين', 'varicose'], [], [tri('emergency', ['رجلي باردة وزرقا', 'ورم مفاجئ في رجل واحده'], 'acute limb ischaemia or DVT')], 24),
  ('hematology', 'أمراض دم', 'Haematology', ['دم', 'انيميا', 'صفائح', 'anemia'], [], [], 25),
  ('fertility', 'تأخر إنجاب وحقن مجهري', 'Fertility & IVF', ['تأخر انجاب', 'حقن مجهري', 'اطفال انابيب', 'ivf', 'icsi'], [svc('متابعة تبويض', 'Ovulation monitoring', 'diagnostic', 20, aliases=['متابعه تبويض'])], [], 26),
  ('psychology', 'علاج نفسي (جلسات)', 'Psychotherapy', ['جلسه نفسيه', 'علاج نفسي', 'therapy'], [svc('جلسة علاج نفسي', 'Therapy session', 'procedure', 50, unit='session', aliases=['جلسه'])], [tri('emergency', ['عايز انتحر', 'هأذي نفسي'], 'risk of self-harm')], 27),
  ('speech_therapy', 'تخاطب', 'Speech therapy', ['تخاطب', 'نطق', 'تأخر كلام', 'speech'], [svc('جلسة تخاطب', 'Speech session', 'procedure', 45, unit='session', aliases=['جلسه'])], [], 28),
]:
    preset(code, ar, en, 'medical', kws, base_services(extra), form(), trig, sort=s)
preset('custom', 'تخصص آخر', 'Another speciality', 'medical', [], base_services(), form(), sort=99)

def q(s):
    return "'" + s.replace("'", "''") + "'"

out = ['-- =====================================================================',
       '-- Everwake Clinic · 020 · the shipped specialities',
       '-- Written by database/tools/build_presets.py — edit there and run it again.',
       '-- Prices are left empty on purpose: each doctor fills their own.',
       '-- =====================================================================', '']
for p in P:
    out.append('insert into clinic.specialty_presets (code, name_ar, name_en, group_name, keywords, starter_services, form_template, triage, is_custom, sort)')
    out.append('values (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %d)' % (
        q(p['code']), q(p['name_ar']), q(p['name_en']), q(p['group_name']),
        "array[" + ', '.join(q(k) for k in p['keywords']) + "]::text[]",
        q(json.dumps(p['starter_services'], ensure_ascii=False)), q(json.dumps(p['form_template'], ensure_ascii=False)),
        q(json.dumps(p['triage'], ensure_ascii=False)), 'true' if p['code'] == 'custom' else 'false', p['sort']))
    out.append('on conflict (code) do update set name_ar = excluded.name_ar, name_en = excluded.name_en, group_name = excluded.group_name,')
    out.append('  keywords = excluded.keywords, starter_services = excluded.starter_services, form_template = excluded.form_template,')
    out.append('  triage = excluded.triage, is_custom = excluded.is_custom, sort = excluded.sort;')
    out.append('')
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'migrations', '020_specialty_presets.sql')
open(path, 'w').write('\n'.join(out))
print('wrote', len(P), 'presets to', os.path.normpath(path))
