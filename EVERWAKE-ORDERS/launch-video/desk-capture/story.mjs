// The chats the film follows, sent into the desk the way the AI agent hands
// them over (POST /api/ingest/handoff). A made-up store ("Volta"), made-up
// customers. The sale starts as a comment on a Facebook post.
export const SALE = {
  channel: 'messenger', external_id: 'film-sale-1', customer_name: 'Ahmed Samir', category: 'sales',
  summary: 'Ready to buy the Lenovo LOQ 15 (42,999 EGP) on installments. Came from a comment on the Facebook post; gaming and video editing; budget up to 45,000.',
  history: [
    { role: 'customer', text: 'كام؟' },
    { role: 'ai', text: 'أهلاً يا أحمد، ده الـ Lenovo LOQ اللي علّقت عليه 👌\nسعره 42,999 جنيه\n\nالـ RTX 4050 بيخلّي الألعاب التقيلة سلسة، والرندر بيخلص في دقايق مش ساعة\nوالشاشة 144Hz، هتشوف الخصم قبل ما هو يشوفك\n\nهتستخدمه في الألعاب بس ولا في الشغل كمان؟' },
    { role: 'customer', text: 'الاتنين، بعمل مونتاج. وميزانيتي 45 ألف بالكتير' },
    { role: 'ai', text: 'تمام، يبقى قدامك اختيارين:\n\nالـ LOQ بـ 42,999، ألعاب ومونتاج 1080p من غير ما تستنى\nأو الـ Legion 5 بـ 47,999، 32 جيجا رام والمونتاج 4K يبقى مريح\n\nتحب نكمّل على أنهي فيهم؟' },
    { role: 'customer', text: 'خلاص هاخد الـ LOQ، ينفع تقسيط؟' },
    { role: 'ai', text: 'اختيار ممتاز 👌 زميلي من فريق المبيعات هيكمّل معاك الطلب والتقسيط حالاً' },
  ],
};

export const COMPLAINT = {
  channel: 'whatsapp', external_id: '201011234567@s.whatsapp.net', customer_name: 'Mariam Khaled', category: 'complaint',
  summary: 'The TV arrived with a cracked screen; she is upset and wants a replacement today.',
  history: [
    { role: 'customer', text: 'الشاشة وصلت مكسورة 😡 عايزة حل النهارده' },
    { role: 'ai', text: 'متأسفين جداً على ده 🙏 هحولك لزميلي من خدمة العملاء يحلها معاك فوراً' },
  ],
};

export const REPLY = 'أهلاً يا أحمد 👋 معاك نور من Volta\nالتقسيط متاح على 12 شهر من غير فوايد، أبعتلك لينك الطلب؟';
export const TRANSFER_NOTE = 'عميلة زعلانة، الشاشة وصلت مكسورة. تقدر تاخدها؟ عندي 4 شكاوى مفتوحة';

// More of her shift: one of each kind, so the queue shows every source and category.
export const MORE = [
  { channel: 'instagram', external_id: 'film-ig-1', customer_name: 'Nadine Hany', category: 'inquiry', summary: 'Asks whether the AirPods Pro 2 are original and what the warranty covers.',
    history: [{ role: 'customer', text: 'الإيربودز دي أصلية؟ والضمان عليها كام؟' }] },
  { channel: 'whatsapp', external_id: '201001112233@s.whatsapp.net', customer_name: 'Karim Fathy', category: 'followup', summary: 'Order 48213 shows "shipped" since Tuesday; wants a delivery time.',
    history: [{ role: 'customer', text: 'الأوردر رقم 48213 وصل فين؟ بقاله من التلات' }] },
  { channel: 'messenger', external_id: 'film-fb-2', customer_name: 'Laila Osman', category: 'sales', summary: 'Wants the iPhone 15 Pro 256GB today, pickup from the Nasr City branch.',
    history: [{ role: 'customer', text: 'عايزة الـ iPhone 15 Pro 256 النهارده، ينفع أستلمه من فرع مدينة نصر؟' }] },
  { channel: 'whatsapp', external_id: '201223344556@s.whatsapp.net', customer_name: 'Hossam Reda', category: 'complaint', summary: 'Charged twice on his card for one order; wants a refund check.',
    history: [{ role: 'customer', text: 'اتخصم مني المبلغ مرتين على الفيزا!' }] },
  { channel: 'instagram', external_id: 'film-ig-2', customer_name: 'Farah Nabil', category: 'sales', summary: 'Wants the PS5 Slim bundle with a second controller; asks about installments.',
    history: [{ role: 'customer', text: 'عايزة الـ PS5 Slim مع دراع زيادة، ينفع تقسيط؟' }] },
];
