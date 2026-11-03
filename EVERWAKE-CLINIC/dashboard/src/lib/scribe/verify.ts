// Nothing goes on the record without the words behind it. Every filled field, allergy, medicine,
// tooth and prescription line must quote the transcript; a quote that is not really there (after
// Arabic is normalised: hamzas, taa marbuta, diacritics, digits) empties the field and flags it
// "not heard clearly" for the doctor. A second, independent model check can flag more.
// Pure, for `node --test`.
import type { Extraction, FieldFill, RecordItem } from './schema';
import type { Segment } from './transcript';

export interface Flag { field: string; why: string }
export interface Verification { supported: string[]; unsupported: Flag[]; flags: Flag[]; dropped: { list: string; item: string; why: string }[]; model_check?: 'done' | 'skipped' }

const DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

export function normalizeArabic(s: string): string {
  return (s || '').toLowerCase()
    .replace(/[ً-ٰٟۖ-ۭ]/g, '')     // diacritics
    .replace(/ـ/g, '')                                  // tatweel
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/گ/g, 'ك').replace(/ڤ/g, 'ف')
    .replace(/[٠-٩۰-۹]/g, d => DIGITS[d] || d)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

const words = (s: string) => normalizeArabic(s).split(' ').filter(w => w.length > 1 || /\d/.test(w));

// Is the quote in the transcript? Exactly (normalised), or nearly: at least 85% of its words, in a
// window of the cited segments and their neighbours (a chunk boundary can split a sentence).
export function quoteFound(quote: string | null | undefined, segments: Segment[], ids: string[] = []): boolean {
  const q = normalizeArabic(quote || '');
  if (q.length < 2) return false;
  const idx = new Set<number>();
  ids.forEach(id => { const i = segments.findIndex(s => s.id === id); if (i >= 0) [i - 1, i, i + 1].forEach(j => j >= 0 && j < segments.length && idx.add(j)); });
  const pool = idx.size ? [...idx].sort((a, b) => a - b).map(i => segments[i]) : segments;
  const hay = normalizeArabic(pool.map(s => s.text).join(' '));
  if (hay.includes(q)) return true;
  if (idx.size && normalizeArabic(segments.map(s => s.text).join(' ')).includes(q)) return true;   // cited the wrong segment, said all the same
  const qw = words(q);
  if (!qw.length) return false;
  const hw = new Set(words(hay));
  const hit = qw.filter(w => hw.has(w) || [...hw].some(h => h.length > 3 && w.length > 3 && (h.startsWith(w) || w.startsWith(h)))).length;
  return qw.length >= 3 && hit / qw.length >= 0.85;
}

const emptyFill = (f: FieldFill, why: string): FieldFill => ({ ...f, was: f.value, value: null, unsupported: true, why });

// the code check: every value must stand on a quote that is really in the transcript
export function verifyExtraction(x: Extraction, segments: Segment[]): { extraction: Extraction; verification: Verification } {
  const v: Verification = { supported: [], unsupported: [], flags: [], dropped: [] };
  const check = (key: string, f: FieldFill | undefined): FieldFill | undefined => {
    if (!f || f.value === null || f.value === undefined || f.value === '') return f;
    if (!f.quote) { v.unsupported.push({ field: key, why: 'no quote' }); return emptyFill(f, 'no quote'); }
    if (!quoteFound(f.quote, segments, f.segment_ids)) { v.unsupported.push({ field: key, why: 'the quote is not in the transcript' }); return emptyFill(f, 'the quote is not in the transcript'); }
    v.supported.push(key);
    return f;
  };
  const fields: Record<string, FieldFill> = {};
  for (const [k, f] of Object.entries(x.fields)) fields[k] = check(k, f) as FieldFill;
  const keep = (list: string, items: RecordItem[], label: (i: RecordItem) => string) => items.filter(i => {
    if (i.quote && quoteFound(i.quote, segments, i.segment_ids)) return true;
    v.dropped.push({ list, item: label(i), why: i.quote ? 'the quote is not in the transcript' : 'no quote' });
    return false;
  });
  const out: Extraction = {
    ...x, fields,
    chief_complaint: check('chief_complaint', x.chief_complaint) as FieldFill,
    assessment: check('assessment', x.assessment) as FieldFill,
    plan: check('plan', x.plan) as FieldFill,
    follow_up_date: check('follow_up_date', x.follow_up_date) as FieldFill,
    record: {
      allergies: keep('allergies', x.record.allergies, i => String(i.substance)),
      medications: keep('medications', x.record.medications, i => String(i.name)),
      conditions: keep('conditions', x.record.conditions, i => String(i.name))
    },
    // a prescription line must be the doctor's own words
    prescription: keep('prescription', x.prescription.filter(i => {
      if (i.speaker && i.speaker !== 'doctor') { v.dropped.push({ list: 'prescription', item: String(i.name), why: 'not said by the doctor' }); return false; }
      return true;
    }), i => String(i.name)),
    teeth: keep('teeth', x.teeth, i => String(i.tooth)),
    plan_items: keep('plan_items', x.plan_items, i => String(i.label))
  };
  return { extraction: out, verification: v };
}

// the model check's flags: a field it calls unsupported or contradicted is emptied too
export function applyFlags(x: Extraction, v: Verification, flags: Flag[]): { extraction: Extraction; verification: Verification } {
  const fields = { ...x.fields };
  const top: Record<string, FieldFill> = { chief_complaint: x.chief_complaint, assessment: x.assessment, plan: x.plan, follow_up_date: x.follow_up_date };
  const vv: Verification = { ...v, supported: [...v.supported], unsupported: [...v.unsupported], flags: [...v.flags] };
  for (const fl of flags) {
    const key = fl.field.replace('__', '.');
    const f = fields[key] || top[key];
    if (!f || f.unsupported || f.value === null) continue;
    const e = emptyFill(f, fl.why || 'the check could not find it in the visit');
    if (fields[key]) fields[key] = e; else top[key] = e;
    vv.supported = vv.supported.filter(s => s !== key);
    vv.flags.push({ field: key, why: e.why || '' });
  }
  return { extraction: { ...x, fields, chief_complaint: top.chief_complaint, assessment: top.assessment, plan: top.plan, follow_up_date: top.follow_up_date }, verification: vv };
}

// what is new for the record compared with what is already on file (the conflicts strip)
export function newForRecord(x: Extraction, onFile: { allergies: { substance: string }[]; medications: { name: string }[]; conditions: { name: string }[] }) {
  const has = (list: string[], s: string) => { const n = normalizeArabic(s); return list.some(l => { const m = normalizeArabic(l); return m === n || (m.length > 3 && (m.includes(n) || n.includes(m))); }); };
  return {
    allergies: x.record.allergies.filter(a => !has(onFile.allergies.map(o => o.substance), String(a.substance))),
    medications: x.record.medications.filter(a => !has(onFile.medications.map(o => o.name), String(a.name))),
    conditions: x.record.conditions.filter(a => !has(onFile.conditions.map(o => o.name), String(a.name)))
  };
}
