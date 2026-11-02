// Red flags in Egyptian Arabic and English, with negation and the specialities' own words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadShared } from './load.mjs';

const { triage } = loadShared(['basics.js', 'arabic.js', 'triage.js'], ['triage']);
const DENTAL = [[{ level: 'emergency', words: ['وشي وارم', 'مش قادر ابلع'], why: 'spreading infection', specialty: 'dentistry' },
                 { level: 'urgent', words: ['سنتي وقعت', 'نزيف بعد الخلع'], why: 'knocked-out tooth', specialty: 'dentistry' }]];

const CASES = [
  ['عندي ألم في صدري وعرقان', 'emergency'], ['صدري واجعني جامد ودراعي الشمال', 'emergency'],
  ['ابني مش قادر يتنفس كويس ومش بيعرف يتنفس', 'emergency'], ['بابا وشه مايل وكلامه تقيل من ساعة', 'emergency'],
  ['البيبي اتشنج دلوقتي', 'emergency'], ['مراتي اغمى عليها', 'emergency'], ['في نزيف جامد', 'emergency'],
  ['مش عايز اعيش خلاص', 'emergency'], ['ابني بلع حبوب من الدولاب', 'emergency'], ['شفايفي ورمت بعد الدوا', 'emergency'],
  ['I have chest pain', 'emergency'], ["my son can't breathe", 'emergency'],
  ['الحرارة 40 ومش بتنزل', 'urgent'], ['عندي وجع فظيع في ضرسي', 'urgent'], ['بيرجع دم', 'urgent'],
  ['عايز احجز كشف', null], ['عندي كحة خفيفة', null], ['سناني بتوجعني شوية', null],
  ['مش عندي ألم في صدري الحمد لله', null], ['مفيش نزيف جامد', null], ['no chest pain, just a cough', null]
];
for (const [text, level] of CASES) {
  test(`«${text}» → ${level}`, () => assert.equal(triage(text).level, level, JSON.stringify(triage(text))));
}

test('the speciality adds its own red flags', () => {
  assert.equal(triage('وشي وارم ومش قادر ابلع', DENTAL).level, 'emergency');
  assert.equal(triage('وشي وارم ومش قادر ابلع', DENTAL).matches[0].specialty, 'dentistry');
  assert.equal(triage('سنتي وقعت وانا بلعب كورة', DENTAL).level, 'urgent');
  assert.equal(triage('وشي وارم ومش قادر ابلع').level, null, 'not without the dental preset');
});
