import { NextResponse, type NextRequest } from 'next/server';
import { parsePriceLines, type ImportItem } from '@/lib/price-lines';
import { serverClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// A price list in, reviewed lines out. The import is saved with the member's own client (row level
// security allows only owners, managers and doctors), then read: by AI when OPENAI_API_KEY is set
// (PDFs, photos and messy lists), else line by line from pasted text. Nothing is published here;
// the review screen publishes through publish_catalog_import, which can be undone.
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['name_ar', 'name_en', 'category', 'price', 'price_max', 'price_kind', 'unit', 'duration', 'sessions', 'description_ar'],
    properties: {
      name_ar: { type: 'string' }, name_en: { type: ['string', 'null'] },
      category: { type: 'string', enum: ['consultation', 'follow_up', 'diagnostic', 'procedure', 'cosmetic', 'package', 'other'] },
      price: { type: ['number', 'null'] }, price_max: { type: ['number', 'null'] },
      price_kind: { type: 'string', enum: ['fixed', 'range', 'from', 'after_exam', 'free'] },
      unit: { type: 'string', enum: ['visit', 'tooth', 'canal', 'jaw', 'session', 'area', 'course', 'unit'] },
      duration: { type: ['integer', 'null'] }, sessions: { type: ['integer', 'null'] }, description_ar: { type: ['string', 'null'] }
    } } } }
};
const PROMPT = `You read a doctor's or clinic's price list (Egypt; Arabic, English or both) and return every service on it.
- name_ar: the service's name in Arabic as patients say it (translate an English-only name to Egyptian clinic Arabic); name_en: its English name or null.
- price_kind: "fixed" for one price; "range" for from–to (price and price_max); "from" for a starting price; "after_exam" for "بعد الكشف" or "حسب الحالة"; "free" for free.
- unit: what the price is per: visit, tooth (للسنة), canal, jaw (للفك), session, area, course (the whole treatment), unit.
- Prices are numbers in the list's currency, without symbols. 12 ألف = 12000. Never invent a price: null when the list has none.
- category: consultation (كشف), follow_up (إعادة/استشارة), diagnostic (أشعة/تحاليل), procedure, cosmetic, package, other.
- duration in minutes and sessions only when the list says them, else null. description_ar: a short note from the list, else null.
Leave out headings, phone numbers, addresses and anything that is not a service.`;

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Send the list as a form' }, { status: 400 });
  const tenant = String(form.get('tenant_id') || '');
  const doctor = String(form.get('doctor_id') || '') || null;
  const text = String(form.get('text') || '').trim();
  const file = form.get('file') as File | null;
  const db = await serverClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in again' }, { status: 401 });
  if (!text && !file) return NextResponse.json({ error: 'Paste the list or choose a file' }, { status: 400 });

  const kind = file ? (file.type === 'application/pdf' ? 'pdf' : file.type.startsWith('image/') ? 'image' : 'text') : 'text';
  const { data: im, error } = await db.from('catalog_imports')
    .insert({ tenant_id: tenant, doctor_id: doctor, source_kind: kind, raw_text: text || null, status: 'extracting', created_by: user.id })
    .select('id').single();
  if (error || !im) return NextResponse.json({ error: error?.message || 'Only owners, managers and doctors can import prices' }, { status: 403 });
  const id = (im as { id: string }).id;

  let items: ImportItem[] = [];
  let via = 'lines';
  try {
    const key = process.env.OPENAI_API_KEY;
    if (key) {
      const content: unknown[] = [{ type: 'text', text: text ? `The list:\n${text}` : 'The list is in the attached file.' }];
      if (file) {
        const b64 = Buffer.from(await file.arrayBuffer()).toString('base64');
        if (kind === 'image') content.push({ type: 'image_url', image_url: { url: `data:${file.type};base64,${b64}` } });
        else if (kind === 'pdf') content.push({ type: 'file', file: { filename: file.name || 'prices.pdf', file_data: `data:application/pdf;base64,${b64}` } });
        else content.push({ type: 'text', text: Buffer.from(b64, 'base64').toString('utf8').slice(0, 60000) });
      }
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.CATALOG_AI_MODEL || 'gpt-5.6-luna',
          messages: [{ role: 'system', content: PROMPT }, { role: 'user', content }],
          response_format: { type: 'json_schema', json_schema: { name: 'price_list', strict: true, schema: SCHEMA } } }),
        signal: AbortSignal.timeout(110_000)
      });
      if (!res.ok) throw new Error(`The AI could not read it (${res.status})`);
      const j = await res.json();
      items = (JSON.parse(j.choices?.[0]?.message?.content || '{}').items || []) as ImportItem[];
      via = 'ai';
    } else if (text) {
      items = parsePriceLines(text);
    } else {
      throw new Error('Reading PDFs and photos needs OPENAI_API_KEY on the server. Paste the list as text instead.');
    }
    await db.from('catalog_imports').update({ status: 'review', extracted: { items, via } }).eq('id', id);
    return NextResponse.json({ import_id: id, items, via });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from('catalog_imports').update({ status: 'failed', error: msg }).eq('id', id);
    return NextResponse.json({ error: msg }, { status: 422 });
  }
}
