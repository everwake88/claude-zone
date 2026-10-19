import type { ExtractedGroup, ExtractedMenu } from './types';

// A spreadsheet menu (Excel → Save as CSV). One row per dish:
//   category_ar, category_en, name_ar, name_en, price, unit, description_ar, signature, choices
// choices: "الحجم*: صغير=0 | وسط=10 | كبير=20 ; الصوص: حار | عادي"
//   groups split by ";", "*" marks a required choice, "=n" is the extra price.
export const CSV_TEMPLATE =
  'category_ar,category_en,name_ar,name_en,price,unit,description_ar,signature,choices\n' +
  'ساندوتشات,Sandwiches,شاورما فراخ,Chicken Shawarma,85,portion,شاورما فراخ بالثومية,yes,"الحجم*: عادي=0 | كبير=30 ; إضافات: جبنة=10 | بطاطس=15"\n' +
  'مشويات,Grills,كفتة,Kofta,480,kg,كفتة على الفحم,no,\n';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim())) rows.push(row);
  return rows;
}

function parseChoices(s: string): ExtractedGroup[] {
  return s.split(';').map(g => g.trim()).filter(Boolean).map(g => {
    const [labelRaw, opts = ''] = g.split(':');
    const required = labelRaw.includes('*');
    const choices = opts.split('|').map(o => o.trim()).filter(Boolean).map(o => {
      const [n, p] = o.split('=');
      return { name_ar: n.trim(), name_en: null, price_delta: Number(p) || 0 };
    });
    return { label_ar: labelRaw.replace('*', '').trim() || 'اختيار', label_en: null, required, min: required ? 1 : 0,
             max: required ? 1 : null, choices };
  }).filter(g => g.choices.length);
}

export function csvToMenu(text: string): ExtractedMenu {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file has no dishes (the first row is the header).');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (r: string[], name: string) => (r[head.indexOf(name)] ?? '').trim();
  if (head.indexOf('name_ar') < 0) throw new Error('The header must include name_ar — download the template.');
  const cats = new Map<string, ExtractedMenu['categories'][number]>();
  for (const r of rows.slice(1)) {
    const name = col(r, 'name_ar');
    if (!name) continue;
    const catKey = col(r, 'category_ar') || 'أصناف';
    if (!cats.has(catKey)) cats.set(catKey, { name_ar: catKey, name_en: col(r, 'category_en') || null, items: [] });
    const unit = col(r, 'unit').toLowerCase();
    const price = col(r, 'price');
    cats.get(catKey)!.items.push({
      name_ar: name, name_en: col(r, 'name_en') || null, description_ar: col(r, 'description_ar') || null,
      price: price === '' ? null : Number(price.replace(/[^\d.]/g, '')),
      unit: (['portion', 'piece', 'kg', 'person'].includes(unit) ? unit : 'portion') as 'portion',
      is_signature: /^(yes|y|true|1|نعم|★)$/i.test(col(r, 'signature')),
      aliases: [], tags: [], options: parseChoices(col(r, 'choices'))
    });
  }
  return { categories: [...cats.values()], notes: null };
}
