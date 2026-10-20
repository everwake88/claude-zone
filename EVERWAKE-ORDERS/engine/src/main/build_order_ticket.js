// =====================================================================
// EVERWAKE — Main · NODE: Build Order Ticket
// A placed order becomes one WhatsApp message to the branch's operations
// number (branches.ops_whatsapp, else the restaurant's ops_whatsapp).
// The live order board in the dashboard rings either way; this is the
// second channel for kitchens that work from a phone. No number, or
// tickets switched off → nothing is sent.
// =====================================================================
// @include shared/basics.js

const o = row($input.first().json);
const intake = row($('Intake').first().json);
const ops = String(o.ops_whatsapp || '').replace(/\D/g, '');
if (!o.order_no || o.send_ticket === false || ops.length < 10) return [];

const c = obj(o.customer);
const SYM = str(o.currency_symbol) || 'ج';
const m = (n) => `${fmt(n)}${SYM}`;
const UNIT = { kg: 'كيلو', piece: 'قطعة', person: 'فرد' };
const PAY = { cash: 'كاش', card: 'فيزا/كارت', wallet: 'محفظة', instapay: 'إنستاباي' };

const lines = arr(obj(o.cart).items).map(i => {
  const ch = arr(i.choices).map(x => arr(x.selected).map(s => (s.name || s) + (s.extra_charge ? ' (+رسوم تسوية)' : '')).join(' + ')).filter(Boolean).join('، ');
  const q = UNIT[i.unit] ? `${fmt(i.quantity)} ${UNIT[i.unit]}` : `× ${fmt(i.quantity)}`;
  return `• ${i.display_name || i.item_name} ${q}${ch ? ' — ' + ch : ''}${i.notes ? ' — ملاحظة: ' + i.notes : ''} = ${i.gift ? 'هدية' : m(i.line_total)}`;
});
const loc = obj(o.location);
const offers = arr(o.applied_offers).filter(a => num(a.amount) > 0).map(a => `${a.title}: −${m(a.amount)}`);
const text = [
  `🧾 أوردر جديد ${o.order_no} — فرع ${o.branch_name || '-'}`,
  '',
  ...lines,
  '',
  `المجموع: ${m(o.subtotal)}`,
  ...offers.map(x => 'خصم ' + x),
  o.vat == null ? 'الضريبة/الرسوم: يحددها الفرع' : `الضريبة ${fmt(o.vat_percent)}%: ${m(o.vat)}`,
  `التوصيل: ${o.delivery_fee == null ? (o.delivery_method === 'pickup' ? '—' : 'يحدده الفرع') : m(o.delivery_fee)}`,
  `الإجمالي: ${m(o.total)}`,
  '',
  `الاسم: ${c.full_name || '-'}`,
  `الموبايل: ${c.phone || (intake.phone_hidden ? '-' : o.wa_id)}${c.alt_phone ? ' / ' + c.alt_phone : ''}`,
  `${o.delivery_method === 'pickup' ? 'استلام من الفرع' : 'توصيل'} — الدفع: ${PAY[o.payment_method] || o.payment_method || '-'}`,
  o.delivery_method === 'pickup' ? '' : `العنوان: ${o.address_text || '-'}`,
  o.zone_name ? `منطقة التوصيل: ${o.zone_name}` : '',
  loc.maps_url ? `اللوكيشن: ${loc.maps_url}` : '',
  o.notes ? `ملاحظات: ${o.notes}` : '',
  c.phone ? `واتساب العميل: wa.me/${String(c.phone).replace(/\D/g, '')}` : 'واتساب العميل: الرقم مخفي — رد عليه من الداشبورد'
].filter(x => x !== '').join('\n');

const ch = obj(intake.channel);
return [{ json: { ops_number: ops, text, base_url: str(ch.base_url), instance: str(ch.instance), api_key: str(ch.api_key) } }];
