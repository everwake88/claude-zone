import { NextResponse, type NextRequest } from 'next/server';
import { openai } from '@/lib/menu-extract';
import { serverClient } from '@/lib/supabase/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// The kitchen holds the button and speaks — "١٢٣ جاهز", "قول لصاحب طلب ١٢٣ إن
// الطحينة خلصت", "الكفتة خلصت". The recording is transcribed, understood
// against this branch's open orders and its menu, and sent back for the
// screen to show ("Order 123 → ready?"). Nothing changes here: the kitchen
// screen runs it once confirmed, with the signed-in member's own rights.
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['action', 'order', 'note', 'item_codes', 'until'],
  properties: {
    action: { type: 'string', enum: ['start', 'ready', 'collected', 'note', 'sold_out', 'back_in_stock', 'unknown'] },
    order: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
    item_codes: { type: 'array', items: { type: 'string' } },
    until: { type: 'string', enum: ['end_of_day', 'one_hour', 'two_hours', 'until_back', 'none'] }
  }
};
const INSTRUCTIONS = `You hear one short command from a restaurant kitchen (usually Egyptian Arabic, numbers may be spoken in Arabic or English).
Decide what they want, using this branch's open orders and its menu:
- start: they started preparing an order ("123 بيتعمل", "ابدأ 123").
- ready: an order is ready ("123 جاهز", "طلب 123 خلص").
- collected: an order was picked up / served ("123 اتسلم", "123 خرج للترابيزة").
- note: something to tell the customer of an order ("قول لصاحب طلب 123 إن…", "بلغ 123 إن…"). note = that message, rewritten as one short, polite sentence in natural Egyptian Arabic, speaking to the customer (no greeting, no order number).
- sold_out: dishes ran out ("الكفتة خلصت"); back_in_stock: dishes are back ("الكفتة رجعت"). item_codes = those dishes' codes from the menu (match the spoken name; several if they say several).
- unknown: anything else, or you cannot tell.
order: the order number they said (digits only, as spoken — "123"), or null. until (sold_out only): "end_of_day" for "النهارده"/no time given, "one_hour"/"two_hours" when they say so, "until_back" for "لحد ما أقول", otherwise "none".`;

interface OpenOrder { id: number; order_no: string; status: string; table_label: string | null; cart: { items?: { display_name?: string; item_name?: string; quantity?: number }[] } }

export async function POST(req: NextRequest) {
  const { tenant_id, branch_id, audio, mime } = await req.json().catch(() => ({})) as { tenant_id?: string; branch_id?: string; audio?: string; mime?: string };
  if (!tenant_id || !branch_id || !audio) return NextResponse.json({ error: 'Send the recording' }, { status: 400 });
  if (audio.length > 6_000_000) return NextResponse.json({ error: 'The recording is too long' }, { status: 413 });
  const db = await serverClient();
  const { data: role } = await db.rpc('member_role', { p_tenant: tenant_id });
  if (!role) return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: 'OPENAI_API_KEY is not set on the server.' }, { status: 500 });

  const since = new Date(Date.now() - 18 * 3600 * 1000).toISOString();
  const [{ data: ordersData }, { data: itemsData }] = await Promise.all([
    db.from('orders').select('id, order_no, status, table_label, cart').eq('tenant_id', tenant_id).eq('branch_id', branch_id)
      .in('status', ['placed', 'accepted', 'preparing', 'ready', 'out_for_delivery']).gte('placed_at', since).order('placed_at').limit(80),
    db.from('menu_items').select('id, code, name_ar, name_en').eq('tenant_id', tenant_id).eq('is_active', true).order('code')
  ]);
  const orders = (ordersData || []) as OpenOrder[];
  const items = (itemsData || []) as { id: string; code: string; name_ar: string; name_en: string | null }[];

  // 1. what was said
  const type = (mime || 'audio/webm').split(';')[0];
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(audio, 'base64')], { type }), `voice.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`);
  form.append('model', process.env.KITCHEN_TRANSCRIBE_MODEL || 'gpt-transcribe');
  form.append('prompt', 'Restaurant kitchen in Egypt. Order numbers, ready, dishes sold out. ' + items.slice(0, 80).map(i => i.name_ar).join('، '));
  let heard = '';
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
                                                                               signal: AbortSignal.timeout(30000) });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || `OpenAI answered ${res.status}`);
    heard = String(j.text || '').trim();
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!heard) return NextResponse.json({ heard: '', action: 'unknown' });

  // 2. what they meant
  let r: { action: string; order: string | null; note: string | null; item_codes: string[]; until: string };
  try {
    const data = await openai({
      model: process.env.KITCHEN_AI_MODEL || process.env.MENU_AI_MODEL || 'gpt-5.6-luna',
      instructions: INSTRUCTIONS,
      input: [{ role: 'user', content: [{ type: 'input_text', text:
        `Open orders: ${orders.map(o => `${o.order_no} (${o.status}${o.table_label ? ', table ' + o.table_label : ''})`).join('; ') || 'none'}\n`
        + `Menu: ${items.map(i => `${i.code} ${i.name_ar}${i.name_en ? ' / ' + i.name_en : ''}`).join('; ')}\n\nThey said: "${heard}"` }] }],
      text: { format: { type: 'json_schema', name: 'kitchen_command', strict: true, schema: SCHEMA } },
      reasoning: { effort: 'low' }, max_output_tokens: 2000
    }, 40000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text: string = data.output_text || (data.output || []).flatMap((o: any) => o.content || []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
    r = JSON.parse(text);
  } catch (e) {
    return NextResponse.json({ heard, action: 'unknown', error: e instanceof Error ? e.message : String(e) });
  }

  // 3. the order they meant: the number spoken, matched to the end of an open order's number
  const digits = (r.order || '').replace(/[^\d٠-٩]/g, '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const matches = digits ? orders.filter(o => o.order_no.replace(/\D/g, '').endsWith(digits)) : [];
  const exact = matches.filter(o => o.order_no.replace(/\D/g, '') === digits);
  const order = (exact.length === 1 ? exact : matches)[0] || null;
  const needsOrder = ['start', 'ready', 'collected', 'note'].includes(r.action);
  const found = items.filter(i => (r.item_codes || []).includes(i.code));
  return NextResponse.json({
    heard, action: needsOrder && !order ? 'unknown' : r.action, said_order: digits || null,
    ambiguous: !exact.length && matches.length > 1,
    order: order ? { id: order.id, order_no: order.order_no, status: order.status, table: order.table_label,
                     items: (order.cart.items || []).map(i => `${i.quantity}× ${i.display_name || i.item_name}`).slice(0, 6) } : null,
    note: r.note, until: r.until, items: found.map(i => ({ id: i.id, code: i.code, name: i.name_ar }))
  });
}
