// What the scribe models are told. The rules are the product: only what was said, a quote behind
// every value, the patient's words kept apart from the doctor's findings, never a diagnosis or a
// medicine the doctor did not say. Pure, for `node --test`.
import type { FormTemplate } from '../../components/patients/types';
import type { Extraction } from './schema';
import { fillableFields, hasChart, propOf } from './schema.ts';
import type { Segment } from './transcript';
import { transcriptText } from './transcript.ts';

export interface ScribeCtx {
  date: string;                                    // the visit's day, YYYY-MM-DD
  lang: 'ar' | 'en';                               // the language the doctor writes notes in
  doctor: string; specialty: string;
  patient: { name: string; age?: string | null; sex?: string | null };
  onFile: { allergies: string[]; medications: string[]; conditions: string[] };
  preVisit?: Record<string, string>;
  template: Pick<FormTemplate, 'schema'> | null;
}

export const EXTRACT_SYSTEM = `You are the medical scribe at an Egyptian clinic. You listen to the visit's transcript and fill the doctor's own form. The doctor reviews and signs everything; your job is to be exactly right, never to be complete.

Rules, all of them strict:
1. Fill a value ONLY when the transcript says it. Otherwise the value is null. An empty field is fine; an invented one is a medical error.
2. Every value has "quote": words copied EXACTLY from the transcript (same spelling, same language, Egyptian Arabic as it was said), and "segment_ids": the [s…] ids of the lines the quote is in. No quote, no value.
3. "speaker": who said it. The patient's history and complaints are what the PATIENT (or their companion) said; exam findings, the assessment and the plan are what the DOCTOR said. Never turn a patient's guess into a finding.
4. Pertinent negatives count: "مفيش ورم" fills the swelling field with false, with that quote.
5. A select or multiselect value must be one of the form's options exactly; if what was said is not one of them, leave it null and put the words in a text field of the same section if there is one.
6. Medicines: spell the drug name correctly (generic or the Egyptian brand as said); dose, frequency and duration only as said.
7. "prescription": ONLY medicines the DOCTOR prescribed in this visit. Never add one, never complete a dose.
8. "record": what the patient HAS, for their file: allergies (substance, reaction), the medicines they take, their chronic conditions — as said in this visit.
9. Teeth (dental forms): FDI numbers. "اللي تحت شمال" with "السابعة" is 37 — only when it is clear; otherwise say it in the text field instead. The condition from the list; "planned" is the treatment the doctor said.
10. "assessment" and "plan": the doctor's own conclusion and plan in their words. You never diagnose.
11. "follow_up_date": only when the doctor gave a time ("بعد أسبوع"), counted from the visit's day.
12. "speakers": for each speaker label in the transcript (like "0:A"), say whether it is the doctor, the patient or another person.
13. "confidence": 0–1, how sure you are the value is what was meant.
14. "soap": a short SOAP note in the notes' language, built only from what you filled.
15. "summary_ar": for the patient, in warm Egyptian Arabic, 3–6 short lines: what the doctor found, the plan, the medicines exactly as prescribed, when to come back. Nothing that was not said, no new advice.`;

const fieldLine = (key: string, f: { type: string; options?: string[]; unit?: string; label_ar: string; label_en: string }) =>
  `- ${propOf(key)} (${f.type}${f.options?.length ? ': ' + f.options.join(' | ') : ''}${f.unit ? ', ' + f.unit : ''}) — ${f.label_ar} / ${f.label_en}`;

export function extractInput(c: ScribeCtx, segments: Segment[]): string {
  const fields = fillableFields(c.template).map(x => fieldLine(x.key, x.field)).join('\n');
  const pre = Object.entries(c.preVisit || {});
  return [
    `VISIT: ${c.date} · ${c.doctor} (${c.specialty}) · notes in ${c.lang === 'en' ? 'English' : 'Arabic'}`,
    `PATIENT: ${c.patient.name}${c.patient.age ? ' · ' + c.patient.age : ''}${c.patient.sex ? ' · ' + c.patient.sex : ''}`,
    `ALREADY ON FILE (do not repeat in "record" unless something changed): allergies: ${c.onFile.allergies.join('، ') || 'none'} · medicines: ${c.onFile.medications.join('، ') || 'none'} · conditions: ${c.onFile.conditions.join('، ') || 'none'}`,
    pre.length ? `ANSWERED ON WHATSAPP BEFORE THE VISIT (context only, never a quote): ${pre.map(([q, a]) => `${q} → ${a}`).join(' · ')}` : '',
    `THE FORM'S FIELDS:\n${fields || '- (none: fill the complaint, assessment and plan only)'}`,
    hasChart(c.template) ? 'This is a dental form: fill "teeth" and "plan_items" when the doctor said them.' : '',
    `TRANSCRIPT:\n${transcriptText(segments)}`
  ].filter(Boolean).join('\n\n');
}

export const VERIFY_SYSTEM = `You check a medical scribe's work against the visit's transcript, independently. For each filled field you get its key, the value and the quote the scribe gave.
Flag a field when the transcript does not support the value: it was not said, the transcript says the opposite, it was said about someone else, or the value adds something that was not said (a diagnosis, a dose, a number, a side, a tooth).
Do not flag wording, translation or summarising that keeps the meaning. When unsure, flag it: the doctor will fill it by hand.`;

export const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['flags'],
  properties: { flags: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'why'],
    properties: { field: { type: 'string' }, why: { type: 'string', description: 'one short reason, in English' } } } } }
};

export function verifyInput(x: Extraction, segments: Segment[]): string {
  const rows: string[] = [];
  const add = (k: string, v: unknown, q: string | null) => { if (v !== null && v !== undefined && v !== '') rows.push(`- ${k}: ${JSON.stringify(v)} — quote: «${q || ''}»`); };
  for (const [k, f] of Object.entries(x.fields)) if (!f.unsupported) add(k, f.value, f.quote);
  for (const k of ['chief_complaint', 'assessment', 'plan', 'follow_up_date'] as const) if (!x[k]?.unsupported) add(k, x[k]?.value, x[k]?.quote);
  return `FILLED FIELDS:\n${rows.join('\n') || '(none)'}\n\nTRANSCRIPT:\n${transcriptText(segments)}`;
}

// the spelling hint for the next 20 seconds: who, what kind of visit, the doctor's words, the last words
export function transcribeHint({ patient, specialty, terms, last }: { patient?: string; specialty?: string; terms?: string[]; last?: string }): string {
  return [
    `A medical visit in Egyptian Arabic, with English medical terms${specialty ? ` (${specialty})` : ''}.`,
    patient ? `The patient: ${patient}.` : '',
    terms?.length ? `Words this doctor uses: ${terms.slice(0, 40).join('، ')}.` : '',
    last ? `…${last}` : ''
  ].filter(Boolean).join(' ');
}
