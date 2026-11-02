// The Egyptian date and time resolver, at fixed "now"s. Whatever the patient
// writes, the agent is handed the real date — it never counts days itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadShared } from './load.mjs';

const { resolveDates } = loadShared(['basics.js', 'arabic.js', 'clock.js', 'dates.js'], ['resolveDates']);
const MON = { date: '2026-11-02', dow: 1, minutes: 10 * 60 };   // Monday 2 November 2026
const THU = { date: '2026-11-05', dow: 4, minutes: 10 * 60 };
const FRI = { date: '2026-11-06', dow: 5, minutes: 10 * 60 };
const EVENING = { windows: [['17:00', '22:00']] };
const SPLIT = { windows: [['10:00', '14:00'], ['17:00', '21:00']] };

const dateOf = (text, now = MON, o) => { const r = resolveDates(text, now, o); return r.dates.map(d => d.date); };
const one = (text, now = MON, o) => resolveDates(text, now, o).dates[0];

const DAYS = [
  // [what they wrote, the date, ambiguous?]
  ['النهارده', '2026-11-02'], ['انهارده بالليل', '2026-11-02'], ['اليوم', '2026-11-02'],
  ['بكره', '2026-11-03'], ['بكرة', '2026-11-03'], ['بكرا الصبح', '2026-11-03'], ['tomorrow', '2026-11-03'],
  ['بعد بكره', '2026-11-04'], ['بعد بكرة', '2026-11-04'], ['day after tomorrow', '2026-11-04'], ['بعد بكره بيوم', '2026-11-05'],
  ['يوم الأربع اللي بعد الجاي', '2026-11-11'], ['الاربع اللي بعد الجاي', '2026-11-11'], ['الأربعاء الي بعد الجاي', '2026-11-11'],
  ['wednesday after next', '2026-11-11'],
  ['الأربع الجاي', '2026-11-04', true], ['الخميس الجاي', '2026-11-05'], ['الخميس اللي جاي', '2026-11-05'],
  ['السبت', '2026-11-07'], ['يوم السبت', '2026-11-07'], ['يوم الحد', '2026-11-08'], ['الأحد', '2026-11-08'],
  ['الاتنين', '2026-11-02', true], ['الاتنين الجاي', '2026-11-09'], ['التلات', '2026-11-03'], ['يوم التلات', '2026-11-03'],
  ['الثلاثاء', '2026-11-03'], ['الجمعة', '2026-11-06'], ['الخميس ده', '2026-11-05'],
  ['التلات الأسبوع الجاي', '2026-11-10'], ['الاسبوع الجاي يوم السبت', '2026-11-07'], ['الخميس من الاسبوع الجاي', '2026-11-12'],
  ['كمان يومين', '2026-11-04'], ['بعد تلات ايام', '2026-11-05'], ['بعد 4 أيام', '2026-11-06'], ['بعد اسبوع', '2026-11-09'],
  ['كمان اسبوعين', '2026-11-16'], ['in 3 days', '2026-11-05'],
  ['15/11', '2026-11-15'], ['١٥/١١', '2026-11-15'], ['15-11-2026', '2026-11-15'], ['1/1', '2027-01-01'],
  ['20 نوفمبر', '2026-11-20'], ['يوم 20 نوفمبر', '2026-11-20'], ['3 ديسمبر', '2026-12-03'], ['nov 20', '2026-11-20'],
  ['يوم 20', '2026-11-20'], ['يوم 1', '2026-12-01'], ['يوم 5 الشهر الجاي', '2026-12-05'],
  ['next tuesday', '2026-11-03', true], ['this friday', '2026-11-06'], ['saturday', '2026-11-07']
];
for (const [text, date, ambiguous] of DAYS) {
  test(`«${text}» → ${date}`, () => {
    const d = one(text);
    assert.ok(d, `nothing found in «${text}»`);
    assert.equal(d.date, date, JSON.stringify(d));
    assert.equal(!!d.ambiguous, !!ambiguous, `ambiguous: ${JSON.stringify(d)}`);
  });
}

test('the weekday words that are also ordinary words need "يوم"', () => {
  assert.deepEqual(dateOf('عايز اتنين كشف'), [], 'two check-ups');
  assert.deepEqual(dateOf('عندي تلات عيال'), [], 'three children');
  assert.deepEqual(dateOf('حد يرد عليا'), [], 'someone');
  assert.deepEqual(dateOf('يوم اتنين'), ['2026-11-02']);
});

test('"السبت الجاي" on a Thursday is two days away — or the week after: both dates are given', () => {
  const d = one('السبت الجاي', THU);
  assert.equal(d.date, '2026-11-07');
  assert.equal(d.alt, '2026-11-14');
  const r = resolveDates('السبت الجاي', THU);
  assert.match(r.lines[0], /السبت 07\/11 \(2026-11-07\) — or السبت 14\/11 \(2026-11-14\) if they mean the week after/);
});

test('"الأسبوع الجاي" on a Friday starts tomorrow (the Egyptian week starts on Saturday)', () => {
  const r = resolveDates('الأسبوع الجاي', FRI);
  assert.equal(r.ranges[0].from, '2026-11-07');
  assert.equal(r.ranges[0].to, '2026-11-12');
  assert.deepEqual(r.args, { from: '2026-11-07', to: '2026-11-12' });
});

test('آخر الأسبوع and the next month', () => {
  assert.deepEqual(resolveDates('اخر الاسبوع', MON).ranges[0], { said: 'اخر الاسبوع', from: '2026-11-05', to: '2026-11-07', label: 'الخميس 05/11 → السبت 07/11' });
  assert.equal(resolveDates('أول الشهر الجاي', MON).ranges[0].from, '2026-12-01');
});

const TIMES = [
  // [what they wrote, options, the time, ambiguous?]
  ['الساعة 5', EVENING, '17:00'], ['الساعه 5', EVENING, '17:00'], ['5 ونص', EVENING, '17:30'], ['5 و نص', EVENING, '17:30'],
  ['6 الا ربع', EVENING, '17:45'], ['6 إلا ربع', EVENING, '17:45'], ['7 وربع', EVENING, '19:15'], ['5:30', EVENING, '17:30'],
  ['8 الا تلت', EVENING, '19:40'], ['الساعه خمسه ونص', EVENING, '17:30'], ['الساعة ٧', EVENING, '19:00'],
  ['10 الصبح', EVENING, '10:00'], ['8 بالليل', {}, '20:00'], ['3 العصر', {}, '15:00'], ['1 الضهر', {}, '13:00'],
  ['12 الضهر', {}, '12:00'], ['5 م', {}, '17:00'], ['9 ص', {}, '09:00'], ['at 6 pm', {}, '18:00'], ['5pm', {}, '17:00'],
  ['الساعة 11', SPLIT, '11:00'], ['الساعة 12', SPLIT, '12:00'], ['الساعة 6', SPLIT, '18:00'],
  ['الساعة 5', {}, '17:00'], ['الساعة 10', {}, '10:00'],
  ['الساعة 1', { windows: [['00:00', '23:59']] }, '13:00', true]
];
for (const [text, o, time, ambiguous] of TIMES) {
  test(`«${text}» → ${time}`, () => {
    const r = resolveDates(text, MON, o);
    assert.equal(r.times.length, 1, JSON.stringify(r));
    assert.equal(r.times[0].time, time, JSON.stringify(r.times[0]));
    assert.equal(!!r.times[0].ambiguous, !!ambiguous);
  });
}

test('a bare number is not a time', () => {
  for (const t of ['عندي 3 عيال', 'عمري 32 سنة', 'السنة رقم 36 بتوجعني', 'الحجز لـ 2']) {
    assert.deepEqual(resolveDates(t, MON, EVENING).times, [], t);
  }
});

test('before and after a time', () => {
  assert.deepEqual(resolveDates('بعد الساعة 6', MON, EVENING).args, { time_from: '18:00' });
  assert.deepEqual(resolveDates('قبل 8 بالليل', MON, EVENING).args, { time_to: '20:00' });
});

test('parts of the day', () => {
  for (const [text, band] of [['الصبح', 'morning'], ['بدري', 'morning'], ['بالليل', 'evening'], ['بعد الشغل', 'evening'], ['العصر', 'afternoon'],
                              ['بعد الضهر', 'afternoon'], ['المغرب', 'evening'], ['in the morning', 'morning'], ['evening', 'evening']]) {
    const r = resolveDates(text, MON);
    assert.equal(r.bands[0]?.band, band, `${text}: ${JSON.stringify(r.bands)}`);
  }
});

test('"بعده" and "أقرب ميعاد" are about the times offered', () => {
  const r = resolveDates('لا بعده', MON);
  assert.equal(r.relative[0].kind, 'after_previous');
  assert.equal(r.args.after, 'last_offered');
  assert.equal(resolveDates('اللي بعده', MON).relative[0].kind, 'after_previous');
  assert.equal(resolveDates('عايز أقرب ميعاد', MON).relative[0].kind, 'earliest');
  assert.equal(resolveDates('لا قبله', MON).relative[0].kind, 'before_previous');
  assert.deepEqual(resolveDates('بعد بكره', MON).relative, [], '"بعد بكره" is a day, not "بعده"');
});

test('a whole message: the day, the time and the part of the day together', () => {
  const r = resolveDates('عايز احجز يوم الاربع اللي بعد الجاي الساعة 6 ونص بالليل لابني', MON, EVENING);
  assert.deepEqual(r.dates.map(d => d.date), ['2026-11-11']);
  assert.deepEqual(r.times.map(t => t.time), ['18:30']);
  assert.deepEqual(r.bands, [], '"بالليل" belongs to the time');
  assert.deepEqual(r.args, { date: '2026-11-11', time: '18:30' });
  assert.match(r.lines.join('\n'), /«يوم الاربع اللي بعد الجاي» = الأربع 11\/11 \(2026-11-11\)/);
});

test('two days → a range for find_slots', () => {
  const r = resolveDates('السبت او الحد بالليل', MON);
  assert.deepEqual(r.args, { from: '2026-11-07', to: '2026-11-08', band: 'evening' });
});

test('English', () => {
  const r = resolveDates('Can I come tomorrow at 5:30 pm?', MON);
  assert.equal(r.dates[0].date, '2026-11-03');
  assert.equal(r.times[0].time, '17:30');
});
