// The doctor's own form (the speciality's template) turned into the strict JSON schema the AI
// fills, and the AI's answer turned back into the form's data. Every filled field carries the
// words it came from (a quote and the transcript segments), who said them, and how sure it is.
// Pure: no imports at runtime, so `node --test` runs it as it is.
import type { FormField, FormTemplate } from '../../components/patients/types';

export interface Evidence { quote: string | null; segment_ids: string[]; confidence: number; speaker: 'doctor' | 'patient' | 'other' | null }
export interface FieldFill extends Evidence { value: unknown; unsupported?: boolean; why?: string; was?: unknown }
export interface RecordItem extends Evidence { [k: string]: unknown }
export interface Extraction {
  fields: Record<string, FieldFill>;                 // "section.field"
  chief_complaint: FieldFill;
  assessment: FieldFill;
  plan: FieldFill;
  follow_up_date: FieldFill;
  record: { allergies: RecordItem[]; medications: RecordItem[]; conditions: RecordItem[] };
  prescription: RecordItem[];                        // only what the doctor dictated
  teeth: RecordItem[];                               // dentistry: {tooth, condition, planned, surfaces}
  plan_items: RecordItem[];                          // dentistry: {tooth, label, sessions}
  speakers: { label: string; role: 'doctor' | 'patient' | 'other' }[];
  soap: { subjective: string; objective: string; assessment: string; plan: string };
  summary_ar: string;                                // for the patient, on WhatsApp, after the doctor reads it
}

// what the AI can fill (the chart and the plan have their own lists)
export const FILLABLE = ['text', 'textarea', 'number', 'boolean', 'select', 'multiselect', 'scale', 'date'];
export const TOOTH_CONDITIONS = ['healthy', 'caries', 'filled', 'root_canal', 'crown', 'bridge', 'implant', 'veneer', 'missing',
  'extraction_needed', 'impacted', 'fractured', 'sensitive', 'watch'];

// "complaint.chief_complaint" ⇄ "complaint__chief_complaint" (a JSON schema property name stays plain)
export const propOf = (key: string) => key.replace('.', '__');
export const keyOf = (prop: string) => prop.replace('__', '.');

export function fillableFields(tpl: Pick<FormTemplate, 'schema'> | null | undefined): { key: string; section: string; field: FormField }[] {
  const out: { key: string; section: string; field: FormField }[] = [];
  for (const s of tpl?.schema?.sections || []) for (const f of s.fields || []) {
    if (FILLABLE.includes(f.type)) out.push({ key: `${s.key}.${f.key}`, section: s.key, field: f });
  }
  return out;
}
export const hasChart = (tpl: Pick<FormTemplate, 'schema'> | null | undefined) =>
  !!tpl?.schema?.sections?.some(s => s.fields?.some(f => f.type === 'tooth_chart' || f.type === 'treatment_plan'));

const nullable = (t: string) => ({ type: [t, 'null'] });
export function valueSchema(f: FormField): Record<string, unknown> {
  switch (f.type) {
    case 'number': return nullable('number');
    case 'scale': return { ...nullable('integer'), description: '1 to 10' };
    case 'boolean': return { ...nullable('boolean'), description: 'true only when said; false when they said no (a pertinent negative); null when not discussed' };
    case 'select': return f.options?.length ? { type: ['string', 'null'], enum: [...f.options, null] } : nullable('string');
    case 'multiselect': return f.options?.length ? { type: ['array', 'null'], items: { type: 'string', enum: f.options } } : { type: ['array', 'null'], items: { type: 'string' } };
    case 'date': return { ...nullable('string'), description: 'YYYY-MM-DD' };
    default: return nullable('string');
  }
}

const EVIDENCE = {
  quote: { type: ['string', 'null'], description: 'the exact words from the transcript, copied, in their language' },
  segment_ids: { type: 'array', items: { type: 'string' } },
  confidence: { type: 'number', description: '0 to 1' },
  speaker: { type: ['string', 'null'], enum: ['doctor', 'patient', 'other', null] }
};
const obj = (props: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
const filled = (value: Record<string, unknown>) => obj({ value, ...EVIDENCE });
const list = (props: Record<string, unknown>) => ({ type: 'array', items: obj({ ...props, ...EVIDENCE }) });

// The strict schema (every property required, no others): OpenAI structured outputs.
export function extractionSchema(tpl: Pick<FormTemplate, 'schema'> | null | undefined): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const { key, field } of fillableFields(tpl)) fields[propOf(key)] = filled(valueSchema(field));
  const dental = hasChart(tpl);
  const s = nullable('string');
  return obj({
    fields: obj(fields),
    chief_complaint: filled(s), assessment: filled(s), plan: filled(s), follow_up_date: filled({ ...s, description: 'YYYY-MM-DD, only when the doctor said when' }),
    record: obj({
      allergies: list({ substance: { type: 'string' }, reaction: s }),
      medications: list({ name: { type: 'string', description: 'the generic or brand name, spelled correctly' }, dose: s, frequency: s, duration: s }),
      conditions: list({ name: { type: 'string' } })
    }),
    prescription: list({ name: { type: 'string' }, dose: s, frequency: s, duration: s, notes: s }),
    ...(dental ? {
      teeth: list({ tooth: { type: 'integer', description: 'FDI number, 11–48 (or 51–85 for a child)' },
                    condition: { type: 'string', enum: TOOTH_CONDITIONS }, planned: s, surfaces: { type: 'array', items: { type: 'string', enum: ['M', 'O', 'D', 'B', 'L'] } } }),
      plan_items: list({ tooth: nullable('integer'), label: { type: 'string' }, sessions: nullable('integer') })
    } : {}),
    speakers: { type: 'array', items: obj({ label: { type: 'string' }, role: { type: 'string', enum: ['doctor', 'patient', 'other'] } }) },
    soap: obj({ subjective: { type: 'string' }, objective: { type: 'string' }, assessment: { type: 'string' }, plan: { type: 'string' } }),
    summary_ar: { type: 'string' }
  });
}

// the model's answer → the extraction with "section.field" keys and every value checked against its type
export function readExtraction(raw: unknown, tpl: Pick<FormTemplate, 'schema'> | null | undefined): Extraction {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rf = (r.fields && typeof r.fields === 'object' ? r.fields : {}) as Record<string, unknown>;
  const fields: Record<string, FieldFill> = {};
  for (const { key, field } of fillableFields(tpl)) {
    const f = evidenceOf(rf[propOf(key)] ?? rf[key]);
    f.value = coerce(field, f.value);
    if (f.value !== null) fields[key] = f;
  }
  const rec = (r.record && typeof r.record === 'object' ? r.record : {}) as Record<string, unknown>;
  const items = (x: unknown, need: string): RecordItem[] => (Array.isArray(x) ? x : []).map(v => evidenceOf(v) as unknown as RecordItem)
    .filter(i => typeof i[need] === 'string' ? !!String(i[need]).trim() : i[need] != null);
  const soap = (r.soap && typeof r.soap === 'object' ? r.soap : {}) as Record<string, unknown>;
  return {
    fields,
    chief_complaint: evidenceOf(r.chief_complaint), assessment: evidenceOf(r.assessment), plan: evidenceOf(r.plan), follow_up_date: evidenceOf(r.follow_up_date),
    record: { allergies: items(rec.allergies, 'substance'), medications: items(rec.medications, 'name'), conditions: items(rec.conditions, 'name') },
    prescription: items(r.prescription, 'name'),
    teeth: items(r.teeth, 'tooth').filter(t => validTooth(Number(t.tooth)) && TOOTH_CONDITIONS.includes(String(t.condition))),
    plan_items: items(r.plan_items, 'label'),
    speakers: (Array.isArray(r.speakers) ? r.speakers : []).filter((s): s is { label: string; role: 'doctor' | 'patient' | 'other' } =>
      !!s && typeof s.label === 'string' && ['doctor', 'patient', 'other'].includes(s.role)),
    soap: { subjective: str(soap.subjective), objective: str(soap.objective), assessment: str(soap.assessment), plan: str(soap.plan) },
    summary_ar: str(r.summary_ar)
  };
}

export const validTooth = (n: number) => Number.isInteger(n) && ((n >= 11 && n <= 48 && n % 10 >= 1 && n % 10 <= 8) || (n >= 51 && n <= 85 && n % 10 >= 1 && n % 10 <= 5));
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function evidenceOf(v: unknown): FieldFill {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }) as Record<string, unknown>;
  const out: FieldFill = { ...o, value: o.value ?? null, quote: typeof o.quote === 'string' && o.quote.trim() ? o.quote.trim() : null,
    segment_ids: Array.isArray(o.segment_ids) ? o.segment_ids.filter((x): x is string => typeof x === 'string') : [],
    confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0,
    speaker: o.speaker === 'doctor' || o.speaker === 'patient' || o.speaker === 'other' ? o.speaker : null };
  return out;
}

// a value the field can hold, or null (an option that is not on the form is dropped, never guessed)
export function coerce(f: FormField, v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  switch (f.type) {
    case 'number': { const n = typeof v === 'number' ? v : Number(String(v).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(',', '.')); return Number.isFinite(n) ? n : null; }
    case 'scale': { const n = Math.round(Number(v)); return n >= 1 && n <= 10 ? n : null; }
    case 'boolean': return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null;
    case 'select': return f.options?.length ? (f.options.includes(String(v)) ? String(v) : null) : String(v);
    case 'multiselect': { const a = (Array.isArray(v) ? v : [v]).map(String).filter(x => !f.options?.length || f.options.includes(x)); return a.length ? [...new Set(a)] : null; }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null;
    default: { const s = String(v).trim(); return s || null; }
  }
}

// the form's data ({section: {field: value}}) from what is filled; the doctor's own edits win
export function toFormData(fields: Record<string, { value: unknown; unsupported?: boolean }>, edits: Record<string, unknown> = {}): Record<string, Record<string, unknown>> {
  const data: Record<string, Record<string, unknown>> = {};
  const put = (key: string, v: unknown) => {
    const [s, f] = key.split('.');
    if (!s || !f || v === null || v === undefined || v === '') return;
    (data[s] ||= {})[f] = v;
  };
  for (const [k, f] of Object.entries(fields)) if (!f.unsupported && !(k in edits)) put(k, f.value);
  for (const [k, v] of Object.entries(edits)) put(k, v);
  return data;
}

// the quotes behind what is signed, kept with the note ("where did this come from?")
export function sourcesOf(fields: Record<string, FieldFill>, keys: string[]): Record<string, { quote: string; segment_ids: string[] }> {
  const out: Record<string, { quote: string; segment_ids: string[] }> = {};
  for (const k of keys) { const f = fields[k]; if (f && !f.unsupported && f.quote) out[k] = { quote: f.quote, segment_ids: f.segment_ids }; }
  return out;
}
