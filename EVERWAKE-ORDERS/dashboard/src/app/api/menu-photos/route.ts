import { NextResponse, type NextRequest } from 'next/server';
import { openai } from '@/lib/menu-extract';
import { serverClient } from '@/lib/supabase/server';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

// One picture of a dish — a card from an ordering app (photo, name, price)
// or just a photo — matched to a dish of this restaurant's menu by the
// AI, with where the food photo sits inside it so the browser can crop it.
// Nothing is saved here: the team checks every match first.
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['code', 'seen_name', 'confidence', 'photo'],
  properties: {
    code: { type: ['string', 'null'] },
    seen_name: { type: 'string' },
    confidence: { type: 'number' },
    photo: { type: 'object', additionalProperties: false, required: ['top', 'left', 'bottom', 'right'],
             properties: { top: { type: 'number' }, left: { type: 'number' }, bottom: { type: 'number' }, right: { type: 'number' } } }
  }
};
const INSTRUCTIONS = `You get one picture and a restaurant's menu (code, Arabic name, English name, description).
The picture is usually a dish card screenshotted from an ordering app or website — the dish's photo with its name, description and price — or simply a photo of a dish.
- code: the menu dish it shows. Match the name written on it (Arabic or English; spellings and word order may differ), helped by the description and price. With no name written, only a dish that is unmistakable from the photo. Not clearly one of these dishes → null.
- seen_name: the dish name as written on the picture ("" if none).
- confidence: 0 to 1, how sure the match is.
- photo: where the food photo itself is inside the picture, as fractions of its width and height (0 to 1): the photo only — not the name, the text, the price, buttons or the white space around it. If the whole picture is the photo: 0, 0, 1, 1.`;

interface Dish { id: string; code: string; name_ar: string; name_en: string | null; description_ar: string | null; price: number | null }

export async function POST(req: NextRequest) {
  const { tenant_id, image } = await req.json().catch(() => ({})) as { tenant_id?: string; image?: string };
  if (!tenant_id || !image?.startsWith('data:image/')) return NextResponse.json({ error: 'Send one picture' }, { status: 400 });
  if (image.length > 8_000_000) return NextResponse.json({ error: 'The picture is too large' }, { status: 413 });
  const db = await serverClient();
  const { data: role } = await db.rpc('member_role', { p_tenant: tenant_id });
  if (role !== 'owner' && role !== 'manager') return NextResponse.json({ error: 'Only owners and managers can change the menu' }, { status: 403 });
  const { data: rows } = await db.from('menu_items').select('id, code, name_ar, name_en, description_ar, price')
    .eq('tenant_id', tenant_id).eq('is_active', true).order('code');
  const dishes = (rows || []) as Dish[];
  if (!dishes.length) return NextResponse.json({ error: 'The menu has no dishes yet' }, { status: 400 });

  try {
    const data = await openai({
      model: process.env.MENU_AI_MODEL || 'gpt-5.6-luna',
      instructions: INSTRUCTIONS,
      input: [{ role: 'user', content: [
        { type: 'input_text', text: 'The menu:\n' + dishes.map(d => [d.code, d.name_ar, d.name_en || '', d.description_ar || '', d.price ?? ''].join(' | ')).join('\n') },
        { type: 'input_image', image_url: image, detail: 'high' }] }],
      text: { format: { type: 'json_schema', name: 'dish_photo', strict: true, schema: SCHEMA } },
      reasoning: { effort: process.env.MENU_PHOTO_REASONING || 'low' },
      max_output_tokens: 4000
    }, 100000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text: string = data.output_text || (data.output || []).flatMap((o: any) => o.content || []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
    const r = JSON.parse(text) as { code: string | null; seen_name: string; confidence: number; photo: { top: number; left: number; bottom: number; right: number } };
    const dish = r.code ? dishes.find(d => d.code === r.code) : undefined;
    const c = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));
    let box = { top: c(r.photo.top), left: c(r.photo.left), bottom: c(r.photo.bottom), right: c(r.photo.right) };
    // a box too small or upside down is no box: the whole picture
    if (box.bottom - box.top < 0.15 || box.right - box.left < 0.15) box = { top: 0, left: 0, bottom: 1, right: 1 };
    return NextResponse.json({ item_id: dish?.id || null, code: dish?.code || null, seen_name: r.seen_name || '',
                               confidence: dish ? c(r.confidence) : 0, box });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
