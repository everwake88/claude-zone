// The scribe's pure logic: the doctor's form as a strict schema, the transcript's segments, and the
// check that nothing reaches the record without the words behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, extractionSchema, fillableFields, readExtraction, sourcesOf, toFormData, validTooth } from './schema.ts';
import { applySpeakers, locate, segmentsFromChunks, segmentsFromDiarized, splitSentences, tail, transcriptText } from './transcript.ts';
import { applyFlags, newForRecord, normalizeArabic, quoteFound, verifyExtraction } from './verify.ts';

const DENTAL = { schema: { sections: [
  { key: 'complaint', title_ar: 'الشكوى', title_en: 'Complaint', fields: [
    { key: 'chief_complaint', type: 'textarea', label_ar: 'الشكوى الأساسية', label_en: 'Chief complaint' },
    { key: 'pain_character', type: 'select', options: ['مستمر', 'متقطع', 'نابض'], label_ar: 'نوع الألم', label_en: 'Pain character' },
    { key: 'triggers', type: 'multiselect', options: ['سخن', 'ساقع', 'حلو'], label_ar: 'بيزيد مع', label_en: 'Triggers' },
    { key: 'swelling', type: 'boolean', label_ar: 'ورم', label_en: 'Swelling' },
    { key: 'severity', type: 'scale', label_ar: 'شدة الألم', label_en: 'Severity' }] },
  { key: 'exam', title_ar: 'الفحص', title_en: 'Exam', fields: [
    { key: 'chart', type: 'tooth_chart', label_ar: 'خريطة الأسنان', label_en: 'Chart' },
    { key: 'bp', type: 'number', unit: 'mmHg', label_ar: 'الضغط', label_en: 'BP' }] }] } };
const GENERAL = { schema: { sections: [{ key: 'h', title_ar: '', title_en: '', fields: [{ key: 'notes', type: 'textarea', label_ar: '', label_en: '' }] }] } };

test('the form becomes a strict schema: every property required, no others, options kept', () => {
  const s = extractionSchema(DENTAL) as any;
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, Object.keys(s.properties));
  const f = s.properties.fields;
  assert.deepEqual(f.required, ['complaint__chief_complaint', 'complaint__pain_character', 'complaint__triggers', 'complaint__swelling', 'complaint__severity', 'exam__bp']);
  assert.deepEqual(f.properties.complaint__pain_character.properties.value.enum, ['مستمر', 'متقطع', 'نابض', null]);
  assert.deepEqual(f.properties.complaint__triggers.properties.value.items.enum, ['سخن', 'ساقع', 'حلو']);
  for (const p of Object.values<any>(f.properties)) assert.deepEqual(p.required, ['value', 'quote', 'segment_ids', 'confidence', 'speaker']);
  assert.ok(s.properties.teeth && s.properties.plan_items, 'a dental form gets the chart and the plan');
  assert.equal(fillableFields(DENTAL).length, 6, 'the chart itself is not a free field');
  const g = extractionSchema(GENERAL) as any;
  assert.equal(g.properties.teeth, undefined, 'no chart without a dental form');
  assert.deepEqual(g.required, Object.keys(g.properties));
});

test('values are checked against the field: an option that is not on the form is never guessed', () => {
  const [ , sel, multi, bool, scale] = DENTAL.schema.sections[0].fields;
  assert.equal(coerce(sel, 'نابض'), 'نابض');
  assert.equal(coerce(sel, 'حاد'), null);
  assert.deepEqual(coerce(multi, ['ساقع', 'حامض', 'ساقع']), ['ساقع']);
  assert.equal(coerce(bool, false), false, 'a pertinent negative is kept');
  assert.equal(coerce(scale, 14), null);
  assert.equal(coerce(DENTAL.schema.sections[1].fields[1], '١٢٠'), 120);
  assert.ok(validTooth(37) && validTooth(85) && !validTooth(19) && !validTooth(49) && !validTooth(86));
});

test('the answer is read back with "section.field" keys, and the doctor\'s edits win', () => {
  const x = readExtraction({
    fields: {
      complaint__chief_complaint: { value: 'ألم في الضرس السفلي الأيسر', quote: 'الضرس اللي تحت شمال بيوجعني', segment_ids: ['s0_0'], confidence: 0.9, speaker: 'patient' },
      complaint__pain_character: { value: 'حاد', quote: 'وجع جامد', segment_ids: [], confidence: 0.5, speaker: 'patient' },
      complaint__swelling: { value: false, quote: 'لا مفيش ورم', segment_ids: ['s0_1'], confidence: 0.8, speaker: 'patient' }
    },
    teeth: [{ tooth: 37, condition: 'caries', planned: 'حشو عصب', surfaces: ['O'], quote: 'سبعة وتلاتين فيها تسوس', segment_ids: [], confidence: 0.8, speaker: 'doctor' },
            { tooth: 99, condition: 'caries', planned: null, surfaces: [], quote: 'x', segment_ids: [], confidence: 1, speaker: 'doctor' }],
    soap: { subjective: 'ألم', objective: '', assessment: '', plan: '' }, summary_ar: 'ملخص'
  }, DENTAL);
  assert.deepEqual(Object.keys(x.fields).sort(), ['complaint.chief_complaint', 'complaint.swelling'], 'an option not on the form is dropped');
  assert.equal(x.teeth.length, 1, 'tooth 99 does not exist');
  const data = toFormData(x.fields, { 'complaint.chief_complaint': 'ألم ضرس ٣٧' });
  assert.deepEqual(data, { complaint: { chief_complaint: 'ألم ضرس ٣٧', swelling: false } });
  assert.deepEqual(sourcesOf(x.fields, ['complaint.swelling']), { 'complaint.swelling': { quote: 'لا مفيش ورم', segment_ids: ['s0_1'] } });
});

test('chunks become segments on the visit\'s clock; a diarised chunk keeps its voices apart', () => {
  assert.deepEqual(splitSentences('الضرس بيوجعني من أسبوع. آه. وبيزيد مع الساقع؟ لا مع السخن'), ['الضرس بيوجعني من أسبوع. آه.', 'وبيزيد مع الساقع؟', 'لا مع السخن']);
  const segs = segmentsFromChunks([{ seq: 1, ms: 10000, text: 'وعندي حساسية من البنسلين.' }, { seq: 0, ms: 20000, text: 'الضرس اللي تحت شمال بيوجعني. من امتى؟ من أسبوع تقريبا' }]);
  assert.equal(segs[0].id, 's0_0');
  assert.equal(segs.at(-1)!.id, 's1_0');
  assert.equal(segs.at(-1)!.start, 20, 'the second chunk starts 20 s in');
  assert.ok(segs.every(s => s.end >= s.start));
  const d = segmentsFromDiarized([{ seq: 0, ms: 20000, segments: [{ speaker: 'A', start: 0, end: 3, text: 'إيه اللي تاعبك؟' }, { speaker: 'B', start: 3, end: 7, text: 'الضرس بيوجعني' }] },
                                  { seq: 1, ms: 20000, segments: [{ speaker: 'A', start: 1, end: 4, text: 'افتح بقك' }] }]);
  assert.deepEqual(d.map(s => [s.id, s.speaker, s.start]), [['s0_0', '0:A', 0], ['s0_1', '0:B', 3], ['s1_0', '1:A', 21]]);
  const named = applySpeakers(d, [{ label: '0:A', role: 'doctor' }, { label: '0:B', role: 'patient' }]);
  assert.deepEqual(named.map(s => s.speaker), ['doctor', 'patient', 'doctor'], 'the same letter in the next chunk keeps its role');
  assert.match(transcriptText(named), /^\[s0_0 · doctor · 0:00\] إيه اللي تاعبك؟/);
  assert.deepEqual(locate([{ seq: 0, ms: 20000, text: '' }, { seq: 1, ms: 20000, text: '' }], 26.5), { seq: 1, offset: 6.5 });
  assert.equal(tail('كلمة '.repeat(100), 20).split(' ').every(w => w === 'كلمة'), true);
});

test('Arabic is compared as it sounds: hamzas, taa marbuta, diacritics and digits do not matter', () => {
  assert.equal(normalizeArabic('أسنانُ الإبتسامة ٣٧'), 'اسنان الابتسامه 37');
  assert.equal(normalizeArabic('مُسْتَشْفَى'), 'مستشفي');
  const segs = [{ id: 's0', speaker: 'patient', start: 0, end: 4, text: 'الضرس اللي تحت شمال بيوجعني' },
                { id: 's1', speaker: 'patient', start: 4, end: 8, text: 'وعندى حساسيه من البنسلين' }];
  assert.ok(quoteFound('وعندي حساسية من البنسلين', segs, ['s1']));
  assert.ok(quoteFound('وعندي حساسية من البنسلين', segs, ['s0']), 'a wrong segment id is forgiven when the words are there');
  assert.ok(!quoteFound('عندي حساسية من الأسبرين', segs, ['s1']));
  assert.ok(quoteFound('الضرس اللي تحت شمال بيوجعنى جدا', segs, []) === false, 'words that were not said fail');
  assert.ok(quoteFound('الضرس اللى تحت شمال', segs));
});

test('the check empties what has no real quote, drops record lines without one, and a prescription is the doctor\'s words only', () => {
  const segs = [{ id: 's0_0', speaker: 'patient', start: 0, end: 4, text: 'الضرس اللي تحت شمال بيوجعني' },
                { id: 's0_1', speaker: 'patient', start: 4, end: 8, text: 'وعندي حساسية من البنسلين' },
                { id: 's1_0', speaker: 'doctor', start: 20, end: 26, text: 'هكتبلك أموكسيسيلين خمسمية كل تمن ساعات خمس أيام' }];
  const x = readExtraction({
    fields: {
      complaint__chief_complaint: { value: 'ألم بالضرس', quote: 'الضرس اللي تحت شمال بيوجعني', segment_ids: ['s0_0'], confidence: 0.9, speaker: 'patient' },
      complaint__swelling: { value: true, quote: 'وفيه ورم كبير', segment_ids: ['s0_0'], confidence: 0.6, speaker: 'patient' },
      complaint__severity: { value: 8, quote: null, segment_ids: [], confidence: 0.4, speaker: null }
    },
    record: { allergies: [{ substance: 'بنسلين', reaction: null, quote: 'حساسية من البنسلين', segment_ids: ['s0_1'], confidence: 0.95, speaker: 'patient' },
                          { substance: 'سلفا', reaction: null, quote: 'حساسية من السلفا', segment_ids: [], confidence: 0.5, speaker: 'patient' }],
              medications: [], conditions: [] },
    prescription: [{ name: 'Amoxicillin', dose: '500 mg', frequency: 'every 8 hours', duration: '5 days', notes: null, quote: 'أموكسيسيلين خمسمية كل تمن ساعات', segment_ids: ['s1_0'], confidence: 0.9, speaker: 'doctor' },
                   { name: 'Ibuprofen', dose: null, frequency: null, duration: null, notes: null, quote: 'الضرس اللي تحت شمال بيوجعني', segment_ids: ['s0_0'], confidence: 0.4, speaker: 'patient' }]
  }, DENTAL);
  const { extraction: v, verification } = verifyExtraction(x, segs);
  assert.equal(v.fields['complaint.chief_complaint'].value, 'ألم بالضرس');
  assert.equal(v.fields['complaint.swelling'].value, null, 'a quote that was not said empties the field');
  assert.equal(v.fields['complaint.swelling'].was, true, 'and keeps what the AI thought, for the doctor to see');
  assert.equal(v.fields['complaint.severity'].unsupported, true);
  assert.deepEqual(verification.supported, ['complaint.chief_complaint']);
  assert.deepEqual(verification.unsupported.map(u => u.field), ['complaint.swelling', 'complaint.severity']);
  assert.deepEqual(v.record.allergies.map(a => a.substance), ['بنسلين']);
  assert.deepEqual(v.prescription.map(p => p.name), ['Amoxicillin'], 'only what the doctor dictated');
  assert.ok(verification.dropped.some(d => d.list === 'prescription' && d.why === 'not said by the doctor'));
  // the model check flags one more
  const flagged = applyFlags(v, verification, [{ field: 'complaint__chief_complaint', why: 'the patient said the upper tooth' }]);
  assert.equal(flagged.extraction.fields['complaint.chief_complaint'].value, null);
  assert.deepEqual(flagged.verification.supported, []);
  assert.deepEqual(toFormData(flagged.extraction.fields), {}, 'nothing unsupported reaches the form');
  // the conflicts strip: penicillin is new, unless it is on file already
  assert.equal(newForRecord(v, { allergies: [], medications: [], conditions: [] }).allergies.length, 1);
  assert.equal(newForRecord(v, { allergies: [{ substance: 'البنسلين' }], medications: [], conditions: [] }).allergies.length, 0);
});
