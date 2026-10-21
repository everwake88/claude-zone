import 'server-only';
import type { ExtractedMenu } from './types';

// The menu the AI returns — strict JSON schema, so the reply always parses.
const choice = {
  type: 'object', additionalProperties: false, required: ['name_ar', 'name_en', 'price_delta'],
  properties: { name_ar: { type: 'string' }, name_en: { type: ['string', 'null'] }, price_delta: { type: 'number' } }
};
const group = {
  type: 'object', additionalProperties: false, required: ['label_ar', 'label_en', 'required', 'min', 'max', 'choices'],
  properties: {
    label_ar: { type: 'string' }, label_en: { type: ['string', 'null'] }, required: { type: 'boolean' },
    min: { type: 'integer' }, max: { type: ['integer', 'null'] }, choices: { type: 'array', items: choice }
  }
};
const item = {
  type: 'object', additionalProperties: false,
  required: ['name_ar', 'name_en', 'description_ar', 'price', 'unit', 'is_signature', 'aliases', 'tags', 'options'],
  properties: {
    name_ar: { type: 'string' }, name_en: { type: ['string', 'null'] }, description_ar: { type: ['string', 'null'] },
    price: { type: ['number', 'null'] }, unit: { type: 'string', enum: ['portion', 'piece', 'kg', 'person'] },
    is_signature: { type: 'boolean' }, aliases: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } }, options: { type: 'array', items: group }
  }
};
export const MENU_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['categories', 'notes'],
  properties: {
    categories: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name_ar', 'name_en', 'items'],
               properties: { name_ar: { type: 'string' }, name_en: { type: ['string', 'null'] }, items: { type: 'array', items: item } } }
    },
    notes: { type: ['string', 'null'] }
  }
};

const INSTRUCTIONS = `You read a restaurant's menu (PDF pages, photos, a web page or pasted text) and return it as structured data for a WhatsApp ordering agent.

Rules:
- Every dish exactly as printed, in the menu's own order and categories. Never invent a dish or a price. A price you cannot read is null.
- name_ar is required: the Arabic name as printed; if the menu has only English, write the Arabic name the way customers in the region say it. name_en: the English name as printed, or a short natural translation.
- Sizes or variants with different prices (S / M / L, single / double, half / whole, 1 piece / 2 pieces) are ONE dish with a required choice (label e.g. "الحجم"): price = the cheapest variant, and each choice's price_delta = its price minus that cheapest price (0 for the cheapest).
- Dishes priced by weight ("الكيلو", "per kg") have unit "kg" and the price per kilo; "per person" → "person"; counted pieces sold individually → "piece"; everything else "portion".
- Add-ons or sauces listed for a section become an optional choice group (required false, min 0, max = how many can be picked, or null for any) on the dishes they apply to, with their prices as price_delta. Add-ons that stand alone become dishes in their own category.
- Combos and meals: one dish, with what is inside in description_ar.
- An offers / deals section ("عروض", "Offers", "Deals", "Boxes") that sells bundles at a fixed price stays its own category, each bundle one dish at that price; where the customer picks what goes inside (which sandwich, which drink) that is a required choice group. Discounts that are not a dish (percent off, free delivery, promo codes) and any dates or hours an offer runs are not dishes: put them in notes.
- is_signature: true only when the menu marks it (chef's special, ★, best seller, new, the house dish).
- aliases: 1–4 other ways customers might write the dish (common spellings, Franco-Arabic, short names). tags: 2–5 lowercase English words (main ingredient, type: chicken, beef, seafood, vegetarian, spicy, sandwich, pizza, drink, dessert, side…).
- description_ar: the printed description, or null. Keep it short.
- notes: anything the restaurant should check (unreadable prices, prices that differ by branch, taxes or service mentioned on the menu), or null.`;

export async function extractMenu(parts: Record<string, unknown>[]): Promise<{ menu: ExtractedMenu; usage: unknown; model: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set on the server.');
  const model = process.env.MENU_AI_MODEL || 'gpt-5.6-luna';
  const effort = process.env.MENU_AI_REASONING ?? 'medium';
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: INSTRUCTIONS,
      input: [{ role: 'user', content: parts }],
      text: { format: { type: 'json_schema', name: 'restaurant_menu', strict: true, schema: MENU_SCHEMA } },
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: 60000
    }),
    signal: AbortSignal.timeout(280000)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI answered ${res.status}`);
  if (data.status === 'incomplete') {
    throw new Error('The menu is too long to read in one go — import it in parts (a few pages or one section at a time).');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (data.output || []).flatMap((o: any) => o.content || []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refusal = content.find((c: any) => c.type === 'refusal');
  if (refusal) throw new Error('The AI could not read this file: ' + refusal.refusal);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text: string = data.output_text || content.filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
  const menu = JSON.parse(text) as ExtractedMenu;
  return { menu: tidy(menu), usage: data.usage || null, model };
}

// trims, drops empty rows, keeps an Arabic name on everything
export function tidy(m: ExtractedMenu): ExtractedMenu {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    notes: m.notes || null,
    categories: (m.categories || []).map(c => ({
      name_ar: s(c.name_ar) || s(c.name_en) || 'أصناف', name_en: s(c.name_en) || null,
      items: (c.items || []).filter(i => s(i.name_ar) || s(i.name_en)).map(i => ({
        name_ar: s(i.name_ar) || s(i.name_en), name_en: s(i.name_en) || null, description_ar: s(i.description_ar) || null,
        price: typeof i.price === 'number' && i.price >= 0 ? i.price : null,
        unit: ['portion', 'piece', 'kg', 'person'].includes(i.unit) ? i.unit : 'portion',
        is_signature: !!i.is_signature,
        aliases: [...new Set((i.aliases || []).map(s).filter(Boolean))].slice(0, 6),
        tags: [...new Set((i.tags || []).map(t => s(t).toLowerCase()).filter(Boolean))].slice(0, 6),
        options: (i.options || []).filter(g => (g.choices || []).length).map(g => ({
          label_ar: s(g.label_ar) || s(g.label_en) || 'اختيار', label_en: s(g.label_en) || null, required: !!g.required,
          min: Math.max(0, Number(g.min) || (g.required ? 1 : 0)), max: g.max == null ? null : Math.max(1, Number(g.max)),
          choices: g.choices.filter(x => s(x.name_ar) || s(x.name_en)).map(x => ({
            name_ar: s(x.name_ar) || s(x.name_en), name_en: s(x.name_en) || null, price_delta: Number(x.price_delta) || 0 }))
        }))
      }))
    })).filter(c => c.items.length)
  };
}

// a web page → readable text for the model
// only public web pages: never the server's own network
function publicUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid link'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) links can be imported');
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0' || h.startsWith('[') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || /^\d+$/.test(h)) {
    throw new Error('That link points to a private address');
  }
  return u;
}

// A restaurant's menu page → everything the AI can read from it:
//  · the visible text
//  · the data a modern site ships for its own JavaScript (JSON-LD, Next.js /
//    Nuxt page data). Ordering sites keep sizes and add-ons there, behind the
//    "add to cart" pop-ups, even when the visible page is nearly empty
//  · the menu pictures shown on the page, and a menu PDF it links to
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; Everwake menu import)' };
const MENU_WORD = /menu|food|منيو|قائمة|المنيو|منيو/i;

async function fetchPublic(url: string, timeoutMs = 20000): Promise<Response> {
  // follow redirects ourselves, so each hop is checked too
  let target = publicUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(target, { headers: UA, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) return res;
    target = publicUrl(new URL(next, target).toString());
  }
  throw new Error('That link redirects too many times');
}

// a file from the page, as a data URL the AI reads, or null when it is not usable
async function fetchAsDataUrl(url: string, kind: 'image' | 'pdf', maxBytes: number): Promise<string | null> {
  try {
    const res = await fetchPublic(url, 20000);
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (kind === 'image' && !/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    if (kind === 'pdf' && type !== 'application/pdf') return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes || buf.length < 2000) return null;   // too big, or an icon
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

const decode = (t: string) => t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

export async function pageParts(url: string): Promise<Record<string, unknown>[]> {
  const res = await fetchPublic(url);
  if (!res.ok) throw new Error(`That page answered ${res.status}`);
  const base = res.url || url;
  const html = await res.text();

  const text = decode(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

  // the page's own data: JSON-LD menus, __NEXT_DATA__, __NUXT_DATA__ …
  const data: string[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1].trim();
    if (body.length > 40) data.push(body);
  }
  const dataText = data.join('\n').replace(/\s+/g, ' ').slice(0, 150000);

  const abs = (u: string) => { try { return publicUrl(new URL(decode(u), base).toString()).toString(); } catch { return null; } };
  // menu pictures: an <img> whose address, alt text or class says "menu"
  const images: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /(?:data-src|src)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src || src.startsWith('data:') || /\.svg(\?|$)/i.test(src) || !MENU_WORD.test(tag)) continue;
    const u = abs(src);
    if (u && !images.includes(u)) images.push(u);
  }
  // a menu PDF the page links to
  const pdfs: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>/gi)) {
    const u = abs(m[1]);
    if (u && !pdfs.includes(u)) pdfs.push(u);
  }

  const parts: Record<string, unknown>[] = [];
  if (text.length > 80) parts.push({ type: 'input_text', text: `Menu page ${base} — the visible text:\n\n${text.slice(0, 120000)}` });
  if (dataText) parts.push({ type: 'input_text', text: `The same page's built-in data (JSON). Ordering sites keep the full menu here, with sizes, add-ons and their prices — use it:\n\n${dataText}` });
  for (const u of pdfs.slice(0, 2)) {
    const d = await fetchAsDataUrl(u, 'pdf', 20_000_000);
    if (d) parts.push({ type: 'input_file', filename: 'menu.pdf', file_data: d });
  }
  for (const u of images.slice(0, 8)) {
    const d = await fetchAsDataUrl(u, 'image', 8_000_000);
    if (d) parts.push({ type: 'input_image', image_url: d, detail: 'high' });
  }
  if (!parts.length || (parts.length === 1 && text.length < 600 && !dataText)) {
    throw new Error('This page builds its menu in the browser, so the link alone shows no dishes. ' +
                    'Take screenshots of the menu (or download its PDF) and use "PDF or photos" instead.');
  }
  return parts;
}
