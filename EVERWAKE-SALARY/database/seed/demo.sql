-- =====================================================================
-- Everwake Salary · demo data: two payroll months for a small company,
-- with the columns an Egyptian payroll sheet usually has. For local
-- testing and the dashboard screenshots — never load it in production.
-- =====================================================================
update salary.settings set company_name = 'شركة النيل للتجارة', agent_name = 'نور',
  hr_contact = 'إدارة الموارد البشرية — داخلي 214', ask_full_name = true, ask_national_id = true,
  ask_work_id = true, ask_phone = false, phone_must_match_sender = true;

do $$
declare
  cols jsonb := '[
    {"key":"c1","header":"كود الموظف","visible":true},
    {"key":"c2","header":"الاسم","visible":true},
    {"key":"c3","header":"الرقم القومي","visible":false},
    {"key":"c4","header":"رقم الموبايل","visible":false},
    {"key":"c5","header":"القسم","visible":true},
    {"key":"c6","header":"الوظيفة","visible":true},
    {"key":"c7","header":"المرتب الأساسي","visible":true},
    {"key":"c8","header":"بدل انتقال","visible":true},
    {"key":"c9","header":"نسبة تحقيق KPI","visible":true},
    {"key":"c10","header":"حافز KPI","visible":true},
    {"key":"c11","header":"أيام الغياب","visible":true},
    {"key":"c12","header":"خصم غياب","visible":true},
    {"key":"c13","header":"خصم تأخير","visible":true},
    {"key":"c14","header":"قسط سلفة","visible":true},
    {"key":"c15","header":"تأمينات اجتماعية","visible":true},
    {"key":"c16","header":"ضريبة كسب العمل","visible":true},
    {"key":"c17","header":"صافي المرتب","visible":true},
    {"key":"c18","header":"ملاحظات HR","visible":false}]';
  ident jsonb := '{"work_id":"c1","full_name":"c2","national_id":"c3","phone":"c4"}';
  people jsonb := '[
    ["1023","أحمد محمد عبد الله السيد","29001150101234","01001234567","المبيعات","مندوب مبيعات",9000,600,92,1380,0,0,150,500,1004,412],
    ["1024","منى إبراهيم حسن علي","29203220201876","01112223344","الحسابات","محاسب",11000,600,100,2200,1,367,0,0,1227,610],
    ["1031","محمود سامي فتحي عبد الرحيم","28807110103345","01223334455","المخازن","أمين مخزن",7500,400,78,0,2,500,90,0,837,180],
    ["1040","سارة خالد مصطفى عمر","29811031401552","01556667788","خدمة العملاء","ممثل خدمة عملاء",6500,400,85,650,0,0,0,300,725,95],
    ["1052","يوسف عادل رمضان محمد","29502281201991","01009998877","المبيعات","مشرف مبيعات",14000,800,110,3500,0,0,0,1000,1562,1180],
    ["1060","هبة الله أشرف كامل حسين","29609150204410","01114445566","الموارد البشرية","أخصائي موارد بشرية",10000,600,95,1000,0,0,60,0,1116,505],
    ["1077","كريم وليد عبد العزيز محمود","30001011201234","01287776655","المخازن","عامل تحميل",5200,300,70,0,3,520,120,0,580,0],
    ["1088","نادية فؤاد زكي إسماعيل","28512250101118","01501112233","الإدارة","سكرتيرة تنفيذية",12500,700,100,1875,0,0,0,0,1395,890]
  ]';
  months date[] := array['2026-09-01'::date, '2026-10-01'::date];
  m date; sh uuid; p jsonb; i int; net numeric; kpi numeric; late numeric;
begin
  foreach m in array months loop
    insert into salary.payroll_sheets (period, title, file_name, sheet_name, columns, identity, status, published_at)
    values (m, 'مرتبات ' || case when m = '2026-09-01' then 'سبتمبر' else 'أكتوبر' end || ' 2026',
            'salaries-' || to_char(m, 'YYYY-MM') || '.xlsx', 'Sheet1', cols, ident, 'draft', null)
    returning id into sh;
    i := 0;
    for p in select value from jsonb_array_elements(people) loop
      i := i + 1;
      -- September differs a little, so the agent can compare months
      kpi := (p ->> 9)::numeric * case when m = '2026-09-01' then 0.8 else 1 end;
      late := (p ->> 12)::numeric + case when m = '2026-09-01' then 50 else 0 end;
      net := (p ->> 6)::numeric + (p ->> 7)::numeric + kpi - (p ->> 11)::numeric - late - (p ->> 13)::numeric
             - (p ->> 14)::numeric - (p ->> 15)::numeric;
      insert into salary.payroll_rows (sheet_id, row_no, cells) values (sh, i + 1, jsonb_build_object(
        'c1', p ->> 0, 'c2', p ->> 1, 'c3', p ->> 2, 'c4', p ->> 3, 'c5', p ->> 4, 'c6', p ->> 5,
        'c7', (p ->> 6)::numeric, 'c8', (p ->> 7)::numeric,
        'c9', ((p ->> 8)::numeric * case when m = '2026-09-01' then 0.9 else 1 end)::int || '%',
        'c10', kpi, 'c11', (p ->> 10)::int, 'c12', (p ->> 11)::numeric, 'c13', late,
        'c14', (p ->> 13)::numeric, 'c15', (p ->> 14)::numeric, 'c16', (p ->> 15)::numeric, 'c17', net,
        'c18', case when i = 3 then 'متابعة الغياب مع المدير المباشر' else '' end));
    end loop;
    perform salary.publish_sheet(sh);
  end loop;
end $$;
