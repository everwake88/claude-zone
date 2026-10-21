import type { ExtractedGroup, ExtractedItem, ExtractedMenu } from './types';

// Ordering sites whose menu we can read exactly, without the AI guessing.
//
// "Pop-up" ordering sites (the Laravel restaurant template Bazooka and many
// Egyptian chains use: /<lang>/resturant/<slug>) list each dish with a
// data-config holding its meal_id, and load the dish's sizes and levels
// ("Level 1 (إختر 1 صنف)") only when the customer clicks it, from
// <site>/<lang>/meal-choices?meal_id=…  The page alone never shows them, so
// we ask for each dish's choices the same way the site's own pop-up does.

export type Get = (url: string, headers?: Record<string, string>) => Promise<string | null>;

const decode = (t: string) => t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = (h: string) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const PRICE = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(?:جنيه|ج\.?\s?م|EGP|LE|L\.E)/i;
const money = (s: string): number | null => {
  const m = PRICE.exec(s);
  return m ? Number(m[1].replace(/,/g, '') + (m[2] ? '.' + m[2] : '')) : null;
};
const LATIN = /^[\x00-\x7F]*$/;

interface Listed { id: number; section: number; name: string; desc: string | null; price: number | null; old: number | null }

// the dishes a menu page lists, in its order
function listing(html: string): { sections: Map<number, string>; meals: Listed[] } {
  const sections = new Map<number, string>();
  for (const m of html.matchAll(/<button[^>]*\bid="menu_section_(\d+)"[^>]*>([\s\S]*?)<\/button>/gi)) {
    sections.set(Number(m[1]), strip(m[2]));
  }
  const meals: Listed[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/onclick="Cart\.addToCart\(this\)[^"]*"\s+data-config="([^"]+)"/gi)) {
    let cfg: { meal_id?: number; menu_section_id?: number };
    try { cfg = JSON.parse(decode(m[1])); } catch { continue; }
    if (!cfg.meal_id) continue;
    const key = `${cfg.menu_section_id}:${cfg.meal_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = m.index! + m[0].length;
    const end = html.indexOf('</a>', start);
    const block = html.slice(start, end < 0 ? start + 6000 : end);
    const name = strip(/<h5[^>]*>([\s\S]*?)<\/h5>/i.exec(block)?.[1] || '')
      .replace(/\s*[—–-]+\s*[\d.,]+\s*(?:جنيه|EGP|LE)[^\p{L}\d]*$/iu, '').trim();   // "كبير الصيف — 420 جنيه🍔"
    const desc = strip(/<\/h5>\s*<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] || '') || null;
    const prices: number[] = [];
    let old: number | null = null;
    for (const s of block.matchAll(/<span([^>]*)>([^<]*)<\/span>/gi)) {
      const v = money(s[2]);
      if (v == null) continue;
      if (/line-through/i.test(s[1])) old = v; else prices.push(v);
    }
    if (!name) continue;
    meals.push({ id: cfg.meal_id, section: cfg.menu_section_id ?? 0, name, desc,
                 price: prices.length ? Math.min(...prices) : null, old });
  }
  return { sections, meals };
}

// one dish's pop-up → its sizes and levels, exactly as the site has them
export function parseChoices(html: string): { sizes: { name: string; price: number }[]; groups: ExtractedGroup[] } {
  const sizes: { name: string; price: number }[] = [];
  for (const m of html.matchAll(/<input[^>]*name="size_id"[^>]*>\s*<label[^>]*>([\s\S]*?)<\/label>/gi)) {
    const price = money(strip(m[1]));
    const name = strip(m[1].replace(/<span[\s\S]*?<\/span>/gi, '')).replace(/[()\s]+$/, '').trim();
    if (name && price != null) sizes.push({ name, price });
  }
  const groups: ExtractedGroup[] = [];
  const parts = html.split(/<div class="accordion"[^>]*>/i).slice(1);
  for (const seg of parts) {
    const gid = /choices\[(\d+)\]/.exec(seg)?.[1];
    if (!gid) continue;
    const header = strip(/<button[^>]*data-toggle="collapse"[^>]*>([\s\S]*?)<\/button>/i.exec(seg)?.[1] || '');
    const level = /level\s*(\d+)/i.exec(header)?.[1];
    const optional = /اختياري|إختياري|optional/i.test(header);
    const pick = Number(/(?:إختر|اختر|اختار|choose|select|pick)\s*(\d+)/i.exec(header)?.[1]) || null;
    const limit = Number(new RegExp(`limit${gid}\\s*=\\s*(\\d+)`).exec(html)?.[1]) || null;
    let radio = false, repeat = 0;
    const choices = [];
    const re = new RegExp(`<input([^>]*)name="choices\\[${gid}\\]\\[\\]"[^>]*>\\s*<label[^>]*>([\\s\\S]*?)<\\/label>([\\s\\S]*?)(?=<input[^>]*name="choices\\[|$)`, 'gi');
    for (const c of seg.matchAll(re)) {
      if (/type="radio"/i.test(c[1])) radio = true;
      const name = strip(c[2].replace(/<span[\s\S]*?<\/span>/gi, ''));
      if (!name) continue;
      const qty = Number(/name="meal_subchoice_quantity_\d+"[^>]*\bmax="(\d+)"/i.exec(c[3])?.[1]) || 0;
      repeat = Math.max(repeat, qty);
      choices.push({ name_ar: name, name_en: LATIN.test(name) ? name : null, price_delta: money(strip(c[2])) ?? 0 });
    }
    if (!choices.length) continue;
    // how many to pick: the site's own limit, else the number in the header
    let max = radio ? 1 : (limit ?? pick);
    if (max != null && repeat <= 1) max = Math.min(max, choices.length);
    const required = !optional;
    // "إختر 2 صنف" with a quantity per choice: two in total, the same one twice is fine
    const min = !required ? 0 : repeat > 1 && max ? max : 1;
    const label = level ? `Level ${level}` : header.replace(/\(.*$/, '').trim() || 'Level';
    groups.push({ label_ar: label, label_en: label, required, min, max,
                  choices: choices });
  }
  return { sizes, groups };
}

async function pool<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]); }
  }));
  return out;
}

// the page's menu with every dish's sizes and levels, or null when the page
// is not one of these sites
export async function popupSiteMenu(url: string, html: string, get: Get): Promise<ExtractedMenu | null> {
  const { sections, meals } = listing(html);
  const base = /var\s+config\s*=\s*\{\s*url:\s*"([^"]+)"/.exec(html)?.[1]?.trim();
  if (!meals.length || !base) return null;

  // the same page in English, for English names (same meal ids)
  const english = new Map<number, { name: string; desc: string | null }>();
  const englishSections = new Map<number, string>();
  const enUrl = url.replace(/\/ar(\/|$)/, '/en$1');
  if (enUrl !== url) {
    const en = await get(enUrl).catch(() => null);
    if (en) {
      const l = listing(en);
      for (const m of l.meals) english.set(m.id, { name: m.name, desc: m.desc });
      for (const [k, v] of l.sections) englishSections.set(k, v);
    }
  }

  const ids = [...new Set(meals.map(m => m.id))];
  const popups = new Map<number, ReturnType<typeof parseChoices>>();
  let missed = 0;
  await pool(ids, 6, async id => {
    const body = await get(`${base}/meal-choices?meal_id=${id}&resturant_branch_id=`, { 'X-Requested-With': 'XMLHttpRequest' })
      .catch(() => null);
    if (body) popups.set(id, parseChoices(body)); else missed++;
  });

  const cats = new Map<number, { name_ar: string; name_en: string | null; items: ExtractedItem[] }>();
  for (const m of meals) {
    if (!cats.has(m.section)) {
      const n = sections.get(m.section) || 'أصناف';
      const en = englishSections.get(m.section) || (LATIN.test(n) ? n : null);
      cats.set(m.section, { name_ar: n, name_en: en, items: [] });
    }
    const p = popups.get(m.id);
    const options: ExtractedGroup[] = [];
    let price = m.price;
    if (p?.sizes.length) {
      const low = Math.min(...p.sizes.map(s => s.price));
      price = low;
      options.push({ label_ar: 'الحجم', label_en: 'Size', required: true, min: 1, max: 1,
                     choices: p.sizes.map(s => ({ name_ar: s.name, name_en: LATIN.test(s.name) ? s.name : null,
                                                  price_delta: Math.round((s.price - low) * 100) / 100 })) });
    }
    options.push(...(p?.groups || []));
    const en = english.get(m.id);
    let desc = m.desc;
    if (m.old != null && price != null && m.old > price) desc = `${desc ? desc + ' — ' : ''}بدل ${m.old} جنيه`;
    cats.get(m.section)!.items.push({
      name_ar: m.name, name_en: en?.name && en.name !== m.name ? en.name : (LATIN.test(m.name) ? m.name : null),
      description_ar: desc, price, unit: 'portion', is_signature: false, aliases: [], tags: [], options
    });
  }
  const notes = [
    `Read directly from the site: ${meals.length} dishes, each with its sizes and levels as the site shows them.`,
    missed ? `${missed} dishes' choices could not be loaded — check them.` : null
  ].filter(Boolean).join(' ');
  return { categories: [...cats.values()], notes };
}
