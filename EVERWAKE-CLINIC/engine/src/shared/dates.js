// ---- shared: Egyptian dates and times, worked out in code ------------------
// The model never does calendar arithmetic. Build Brief runs this on what the
// patient wrote and puts the answers in FACTS:
//   «يوم الأربع اللي بعد الجاي» = الأربع 11/11 (2026-11-11)
// It understands Egyptian and English ways of naming a day or a time:
//   النهارده · بكره · بعد بكره · امبارح · كمان يومين · بعد أسبوع
//   السبت · يوم الحد · الخميس الجاي · الأربع اللي بعد الجاي · الاتنين الأسبوع الجاي · السبت ده
//   الأسبوع الجاي · آخر الأسبوع · أول الشهر الجاي · 15/11 · 15 نوفمبر · يوم 20
//   الساعة 5 · 5 ونص · 5 وربع · 5 إلا ربع · 5:30 · 7 بالليل · 10 الصبح · خمسة ونص
//   الصبح · الضهر · العصر · المغرب · بالليل · بعد الشغل · بعد الساعة 6 · قبل 4
//   بعده / اللي بعده (the next one after what was offered) · قبله · أقرب ميعاد
// A time with no ص/م is placed inside the clinic's hours when it can be
// (5 → 17:00 at an evening clinic); "ambiguous" says when it can't be sure.
// "السبت الجاي" two days away might mean the week after: ambiguous, with the
// other date, so the agent says the date in its offer instead of asking.
// Requires shared/clock.js and shared/arabic.js.

const WEEKDAYS = [
  [6, /^(?:ال)?سبت$/], [0, /^(?:الحد|الاحد|حد|احد)$/], [1, /^(?:الاتنين|الاثنين|اتنين|اثنين|الإثنين)$/],
  [2, /^(?:التلات|الثلاثاء|التلاتاء|الثلاث|التلاته|تلات|ثلاثاء)$/], [3, /^(?:الاربع|الاربعاء|الاربعا|اربعاء|اربع)$/],
  [4, /^(?:ال)?خميس$/], [5, /^(?:الجمعه|جمعه)$/]
];
// without "ال", these are also ordinary words (someone, two, three, four…): only after "يوم"
const NEEDS_YOM = /^(?:حد|احد|اتنين|اثنين|تلات|اربع|جمعه)$/;
const EN_DAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4,
                  thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MONTHS = { يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, ابريل: 4, مايو: 5, يونيو: 6, يونيه: 6, يوليو: 7, يوليه: 7, اغسطس: 8,
                 سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8,
                 sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7,
                 august: 8, september: 9, october: 10, november: 11, december: 12 };
const NUMS = { واحد: 1, واحده: 1, اتنين: 2, اثنين: 2, تلاته: 3, ثلاثه: 3, تلات: 3, ثلاث: 3, تلت: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5,
               سته: 6, ست: 6, سبعه: 7, سبع: 7, تمانيه: 8, ثمانيه: 8, تمن: 8, تسعه: 9, تسع: 9, عشره: 10, عشر: 10, حداشر: 11,
               احداشر: 11, اتناشر: 12, اطناشر: 12 };
const BANDS = [
  // the order matters: the longer phrase first
  [/بعد\s+الشغل|after\s+work/, 'evening', '17:00', '22:00'],
  [/بعد\s+المغرب/, 'evening', '18:00', '22:00'],
  [/بعد\s+(?:الضهر|الظهر)|afternoon/, 'afternoon', '13:00', '17:00'],
  [/(?<![\p{L}])(?:الصبح|الصباح|صباحا|بدري|morning)(?![\p{L}])/u, 'morning', '08:00', '12:00'],
  [/(?<![\p{L}])(?:الضهر|الظهر|noon)(?![\p{L}])/u, 'afternoon', '12:00', '15:00'],
  [/(?<![\p{L}])(?:العصر)(?![\p{L}])/u, 'afternoon', '15:00', '17:30'],
  [/(?<![\p{L}])(?:المغرب)(?![\p{L}])/u, 'evening', '17:00', '20:00'],
  [/(?<![\p{L}])(?:بالليل|بليل|الليل|مساء|مساءا|بالمسا|evening|night|tonight)(?![\p{L}])/u, 'evening', '18:00', '23:00']
];

function liteNorm(s) {
  return toWesternDigits(String(s == null ? '' : s)).toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[،؛]/g, ' ').replace(/\s+/g, ' ');
}
const pad = (n) => String(n).padStart(2, '0');
const hm = (mins) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
const toMins = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const dayLabel = (date) => `${DAY_AR[dowOf(date)]} ${dayMonth(date)}`;

function resolveDates(text, now, opts = {}) {
  const out = { dates: [], ranges: [], times: [], bands: [], relative: [], bounds: {}, lines: [], args: {} };
  if (!text || !now || !now.date) return out;
  let work = ' ' + liteNorm(text) + ' ';
  const today = now.date, tdow = dowOf(today);
  // a clinic's hours, as minute windows, for placing a time with no ص/م
  const windows = arr(opts.windows).map(w => [toMins(w[0] || w.from), toMins(w[1] || w.to)]).filter(w => w.every(Number.isFinite));
  const take = (re) => {   // the first match, blanked out so a shorter phrase can't match it again
    const m = work.match(re);
    if (m) work = work.slice(0, m.index) + ' '.repeat(m[0].length) + work.slice(m.index + m[0].length);
    return m;
  };
  const takeAll = (re, fn) => { let m; let guard = 0; while ((m = take(re)) && guard++ < 10) fn(m); };
  const addDate = (said, date, extra = {}) => out.dates.push({ said: said.trim(), date, day_ar: DAY_AR[dowOf(date)],
                                                               day_en: DAY_EN[dowOf(date)], label: dayLabel(date), ...extra });
  const addRange = (said, from, to) => out.ranges.push({ said: said.trim(), from, to, label: `${dayLabel(from)} → ${dayLabel(to)}` });
  const nextOcc = (dow, includeToday) => { let d = (dow - tdow + 7) % 7; if (d === 0 && !includeToday) d = 7; return d; };
  // the Egyptian week starts on Saturday
  const nextWeekStart = () => addDays(today, nextOcc(6, false));

  // ---- relative words for the last thing offered ----------------------------------
  takeAll(/(?<![\p{L}])(?:(?:اللي|الي)\s+)?(?:بعده|بعدها|بعديه)(?![\p{L}])|the one after|after that one|a later one/u,
          (m) => out.relative.push({ said: m[0].trim(), kind: 'after_previous' }));
  takeAll(/(?<![\p{L}])(?:(?:اللي|الي)\s+)?(?:قبله|قبلها)(?![\p{L}])|an earlier one|the one before/u,
          (m) => out.relative.push({ said: m[0].trim(), kind: 'before_previous' }));
  takeAll(/(?:اقرب|اول)\s+(?:ميعاد|معاد|حاجه|وقت|يوم|دور)|في\s+اقرب\s+وقت|(?<![\p{L}])(?:asap|earliest|soonest)(?![\p{L}])/u,
          (m) => out.relative.push({ said: m[0].trim(), kind: 'earliest' }));

  // ---- day words ---------------------------------------------------------------
  takeAll(/بعد\s+(?:بكره|بكرا)\s+بيوم/, (m) => addDate(m[0], addDays(today, 3)));
  takeAll(/بعد\s+(?:بكره|بكرا)|day after tomorrow/, (m) => addDate(m[0], addDays(today, 2)));
  takeAll(/(?<![\p{L}])(?:بكره|بكرا|غدا|tomorrow)(?![\p{L}])/u, (m) => addDate(m[0], addDays(today, 1)));
  takeAll(/(?<![\p{L}])(?:النهارده|انهارده|النهرده|النهارد|نهارده|اليوم|today|tonight)(?![\p{L}])/u, (m) => addDate(m[0], today));
  takeAll(/(?<![\p{L}])(?:امبارح|امس|yesterday)(?![\p{L}])/u, (m) => addDate(m[0], addDays(today, -1), { past: true }));
  takeAll(/(?:كمان|بعد|in)\s+(?:(يومين|two days)|(\d{1,2}|[\p{L}]+)\s*(?:ايام|يام|days?)(?![\p{L}]))/u, (m) => {
    const n = m[1] ? 2 : (Number(m[2]) || NUMS[m[2]] || 0);
    if (n > 0 && n <= 60) addDate(m[0], addDays(today, n));
  });
  takeAll(/(?:كمان|بعد|in)\s+(?:(اسبوعين|two weeks)|(اسبوع|a week|one week)|(\d)\s*(?:اسابيع|weeks))/u, (m) => {
    const n = m[1] ? 14 : m[2] ? 7 : Number(m[3]) * 7;
    addDate(m[0], addDays(today, n));
  });

  // ---- a weekday, and what comes with it ------------------------------------------
  const words = work.split(' ');
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let dow = null;
    for (const [d, re] of WEEKDAYS) if (re.test(w)) { dow = d; break; }
    if (dow === null && EN_DAYS[w] !== undefined) dow = EN_DAYS[w];
    if (dow === null) continue;
    const prev = words.slice(Math.max(0, i - 4), i).join(' ');
    if (NEEDS_YOM.test(w) && !/(?:^|\s)يوم$/.test(prev.trim())) continue;
    const tail = words.slice(i + 1, i + 6).join(' ').trim();
    const en = EN_DAYS[w] !== undefined;
    let said = (/(?:^|\s)يوم$/.test(prev.trim()) ? 'يوم ' : '') + w, date, extra = {};
    let m;
    if ((m = tail.match(/^(?:(?:اللي|الي|ال)\s*)?بعد\s+(?:(?:اللي|الي)\s+)?(?:الجاي|الجايه|جاي)/)) || (en && /after next/.test(prev + ' ' + tail))) {
      date = addDays(today, nextOcc(dow, false) + 7);
      said += m ? ' ' + m[0] : '';
    } else if ((m = tail.match(/^(?:(?:من|في)\s+)?(?:الاسبوع|الاسبوع)\s+(?:الجاي|اللي\s+جاي|الي\s+جاي)/)) || /(?:الاسبوع\s+(?:الجاي|اللي\s+جاي))\s*(?:يوم)?$/.test(prev.trim())
               || (en && /next week/.test(prev + ' ' + tail))) {
      const start = nextWeekStart();
      date = addDays(start, (dow - 6 + 7) % 7);
      said += m ? ' ' + m[0] : '';
      if (!m) {   // "الأسبوع الجاي يوم السبت": the words before belong to this day too
        said = 'الأسبوع الجاي ' + said;
        for (let k = i - 1; k >= Math.max(0, i - 4); k--) if (/^(?:الاسبوع|الجاي|اللي|الي|جاي|يوم|next|week)$/.test(words[k])) words[k] = '';
      }
    } else if ((m = tail.match(/^(?:(?:اللي|الي)\s+)?(?:الجاي|الجايه|جاي)(?![\p{L}])/u)) || (en && /(?:^|\s)next$/.test(prev.trim()))) {
      const d = nextOcc(dow, false);
      date = addDays(today, d);
      if (d <= 2) extra = { ambiguous: true, alt: addDays(today, d + 7), alt_label: dayLabel(addDays(today, d + 7)) };
      said += m ? ' ' + m[0] : '';
    } else if ((m = tail.match(/^(?:ده|دا|دي|ده\s+الجاي)(?![\p{L}])/u)) || (en && /(?:^|\s)this$/.test(prev.trim()))) {
      date = addDays(today, nextOcc(dow, true));
      said += m ? ' ' + m[0] : '';
    } else if ((m = tail.match(/^(?:(?:اللي|الي)\s+)?(?:فات|الماضي)(?![\p{L}])/u)) || (en && /(?:^|\s)last$/.test(prev.trim()))) {
      date = addDays(today, -(((tdow - dow + 7) % 7) || 7));
      extra = { past: true };
      said += m ? ' ' + m[0] : '';
    } else {
      const d = nextOcc(dow, true);
      date = addDays(today, d);
      if (d === 0) extra = { ambiguous: true, alt: addDays(today, 7), alt_label: dayLabel(addDays(today, 7)), note: 'today, or next week' };
    }
    addDate(said, date, extra);
    words.splice(i + 1, (m && m[0].split(' ').length) || 0);
  }
  work = ' ' + words.join(' ') + ' ';

  // ---- written dates: 15/11 · 15 نوفمبر · يوم 20 ---------------------------------------
  const year0 = Number(today.slice(0, 4));
  const mkDate = (d, mo, y) => {
    if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12)) return null;
    let yy = y ? (y < 100 ? 2000 + y : y) : year0;
    let s = `${yy}-${pad(mo)}-${pad(d)}`;
    if (new Date(s + 'T12:00:00Z').getUTCDate() !== d) return null;
    if (!y && s < today) s = `${yy + 1}-${pad(mo)}-${pad(d)}`;
    return s;
  };
  takeAll(/(?<![\d:])(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{2,4}))?(?![\d:])/, (m) => {
    const s = mkDate(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null);
    if (s) addDate(m[0], s, s < today ? { past: true } : {});
  });
  const monthNames = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  takeAll(new RegExp(`(?:يوم\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})(?![\\p{L}])`, 'u'), (m) => {
    const s = mkDate(Number(m[1]), MONTHS[m[2]]); if (s) addDate(m[0], s);
  });
  takeAll(new RegExp(`(?<![\\p{L}])(${monthNames})\\s+(\\d{1,2})(?!\\d)`, 'u'), (m) => {
    const s = mkDate(Number(m[2]), MONTHS[m[1]]); if (s) addDate(m[0], s);
  });
  takeAll(/يوم\s+(\d{1,2})(?:\s+(الشهر\s+(?:ده|الجاي|اللي\s+جاي)))?(?!\s*(?:\d|:|\/|ونص|وربع|الا|ساعه|يوم|ايام))/, (m) => {
    const d = Number(m[1]); const t = new Date(today + 'T12:00:00Z');
    let mo = t.getUTCMonth() + 1, y = t.getUTCFullYear();
    if ((m[2] && /الجاي|جاي/.test(m[2])) || (!m[2] && d < Number(today.slice(8, 10)))) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    const s = mkDate(d, mo, y); if (s) addDate(m[0], s);
  });

  // ---- weeks and months ---------------------------------------------------------
  takeAll(/(?:الاسبوع|الاسبوع)\s+(?:الجاي|اللي\s+جاي|الي\s+جاي)|next week/, (m) => {
    const s = nextWeekStart(); addRange(m[0], s, addDays(s, 5));
  });
  takeAll(/(?:اخر|نهايه|اخر)\s+الاسبوع|(?:this\s+)?weekend|end of the week/, (m) => {
    const thu = addDays(today, (4 - tdow + 7) % 7);
    addRange(m[0], tdow >= 4 || tdow === 6 ? today : thu, addDays(today, (6 - tdow + 7) % 7 || 0));
  });
  takeAll(/الاسبوع\s+(?:ده|دا|الحالي)|this week/, (m) => addRange(m[0], today, addDays(today, (5 - tdow + 7) % 7)));
  takeAll(/(?:اول|بدايه)\s+الشهر\s+(?:الجاي|اللي\s+جاي)|early next month|beginning of next month/, (m) => {
    const d = new Date(today + 'T12:00:00Z'); const first = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 12)));
    addRange(m[0], first, addDays(first, 6));
  });
  takeAll(/الشهر\s+(?:الجاي|اللي\s+جاي)|next month/, (m) => {
    const d = new Date(today + 'T12:00:00Z');
    const first = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 12)));
    const last = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0, 12)));
    addRange(m[0], first, last);
  });
  takeAll(/(?:اخر|نهايه)\s+الشهر|end of the month/, (m) => {
    const d = new Date(today + 'T12:00:00Z');
    const last = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)));
    addRange(m[0], addDays(last, -6) > today ? addDays(last, -6) : today, last);
  });

  // ---- times ---------------------------------------------------------------------
  const inHours = (mins) => !windows.length || windows.some(([a, b]) => b > a ? mins >= a && mins < b : mins >= a || mins < b);
  const placeHour = (h, mins, suffix) => {
    // explicit: ص / الصبح / am → morning; الضهر → around noon; م / العصر / المغرب / بالليل / pm → after noon
    if (/^(?:ص|صباحا|الصبح|الصباح|am|a\.m)$/.test(suffix || '')) return { t: (h % 12) * 60 + mins };
    if (/^(?:الضهر|الظهر)$/.test(suffix || '')) return { t: (h === 12 ? 12 : h + 12) * 60 + mins - (h >= 1 && h <= 4 ? 0 : 0) };
    if (/^(?:م|مساء|مساءا|العصر|المغرب|بالليل|بليل|الليل|pm|p\.m)$/.test(suffix || '')) return { t: ((h % 12) + 12) * 60 + mins };
    if (h >= 13) return { t: h * 60 + mins };
    const am = (h % 12) * 60 + mins, pm = ((h % 12) + 12) * 60 + mins;
    const a = inHours(am), p = inHours(pm);
    if (a && !p) return { t: am };
    if (p && !a) return { t: pm };
    // both or neither: Egyptian habit — 1 to 7 is the afternoon or evening, 8 to 11 the morning
    const guess = h >= 1 && h <= 7 ? pm : (h === 12 ? 12 * 60 + mins : am);
    const both = windows.length > 0 && a && p;
    return { t: guess, ambiguous: both, alt: both ? (guess === pm ? am : pm) : undefined, outside: !a && !p && windows.length > 0 };
  };
  const SUFFIX = '(?:\\s*(ص|م|صباحا|مساء|مساءا|الصبح|الصباح|الضهر|الظهر|العصر|المغرب|بالليل|بليل|الليل|am|pm|a\\.m|p\\.m)(?![\\p{L}]))?';
  const HOURW = Object.keys(NUMS).sort((a, b) => b.length - a.length).join('|');
  const MINUTES = '(?::(\\d{2})|\\s*(و\\s*نص|ونص|و\\s*ربع|وربع|الا\\s*ربع|إلا\\s*ربع|الا\\s*تلت|و\\s*تلت|وتلت|و\\s*(\\d{1,2})\\s*(?:دقيقه|دقايق|د)?))?';
  const minsOf = (m) => {
    if (m.colon) return Number(m.colon);
    const w = (m.word || '').replace(/\s/g, '');
    if (/ونص/.test(w)) return 30; if (/وربع/.test(w)) return 15; if (/الاربع|إلاربع/.test(w)) return -15;
    if (/الاتلت/.test(w)) return -20; if (/وتلت/.test(w)) return 20;
    if (m.plus) return Number(m.plus);
    return 0;
  };
  const addTime = (said, h, mm, suffix, bound) => {
    if (!(h >= 0 && h <= 24)) return;
    let mins = mm;
    if (mins < 0) { h -= 1; mins += 60; }
    if (h < 0 || mins > 59) return;
    const p = placeHour(h, mins, suffix);
    const time = hm(p.t);
    if (bound) out.bounds[bound] = time;
    out.times.push({ said: said.trim(), time, ...(p.ambiguous ? { ambiguous: true, alt: hm(p.alt) } : {}),
                     ...(p.outside ? { note: 'outside the clinic hours on file' } : {}), ...(bound ? { bound } : {}) });
  };
  // "بعد الساعة 6" / "قبل 4"
  takeAll(new RegExp(`(بعد|قبل|after|before)\\s+(?:الساعه\\s*|ساعه\\s*)?(\\d{1,2}|${HOURW})${MINUTES}${SUFFIX}`, 'u'), (m) => {
    const h = Number(m[2]) || NUMS[m[2]];
    addTime(m[0], h, minsOf({ colon: m[3], word: m[4], plus: m[5] }), m[6], /^(?:بعد|after)$/.test(m[1]) ? 'time_from' : 'time_to');
  });
  // a clock: only with "الساعة", minutes, or ص/م (a bare number is not a time: "3 عيال")
  takeAll(new RegExp(`(?:(?:الساعه|ساعه|at)\\s*(\\d{1,2}|${HOURW})${MINUTES}${SUFFIX})|(?:(?<![\\d/])(\\d{1,2}|${HOURW})(?::(\\d{2})|\\s*(و\\s*نص|ونص|و\\s*ربع|وربع|الا\\s*ربع|إلا\\s*ربع|الا\\s*تلت|و\\s*تلت|وتلت))${SUFFIX})|(?:(?<![\\d/])(\\d{1,2})\\s*(ص|م|am|pm|الصبح|العصر|المغرب|بالليل|بليل|الضهر|الظهر)(?![\\p{L}]))`, 'u'), (m) => {
    if (m[1] !== undefined) addTime(m[0], Number(m[1]) || NUMS[m[1]], minsOf({ colon: m[2], word: m[3], plus: m[4] }), m[5]);
    else if (m[6] !== undefined) addTime(m[0], Number(m[6]) || NUMS[m[6]], minsOf({ colon: m[7], word: m[8] }), m[9]);
    else addTime(m[0], Number(m[10]), 0, m[11]);
  });
  for (const [re, band, from, to] of BANDS) takeAll(re, (m) => out.bands.push({ said: m[0].trim(), band, from, to }));

  // ---- the arguments for find_slots, and the lines for FACTS ------------------------
  const future = out.dates.filter(d => !d.past);
  if (future.length === 1 && !out.ranges.length) out.args.date = future[0].date;
  else if (future.length > 1) { const s = future.map(d => d.date).sort(); out.args.from = s[0]; out.args.to = s[s.length - 1]; }
  if (out.ranges.length && !future.length) { out.args.from = out.ranges[0].from; out.args.to = out.ranges[0].to; }
  if (out.bands.length === 1) out.args.band = out.bands[0].band;
  if (out.bounds.time_from) out.args.time_from = out.bounds.time_from;
  if (out.bounds.time_to) out.args.time_to = out.bounds.time_to;
  const clock = out.times.filter(t => !t.bound);
  if (clock.length === 1) out.args.time = clock[0].time;
  if (out.relative.some(r => r.kind === 'after_previous')) out.args.after = 'last_offered';

  for (const d of out.dates) {
    out.lines.push(`«${d.said}» = ${d.label} (${d.date})${d.past ? ' — in the past' : ''}`
      + (d.ambiguous ? ` — or ${d.alt_label} (${d.alt}) if they mean the week after: say the date in your offer` : '')
      + (d.note && !d.ambiguous ? ` — ${d.note}` : ''));
  }
  for (const r of out.ranges) out.lines.push(`«${r.said}» = ${r.label} (${r.from} to ${r.to})`);
  for (const t of out.times) out.lines.push(`«${t.said}» = ${t.time}${t.bound ? (t.bound === 'time_from' ? ' or later' : ' or earlier') : ''}`
    + (t.ambiguous ? ` (or ${t.alt} — both are inside the clinic hours: say the time with ص/م)` : '') + (t.note ? ` — ${t.note}` : ''));
  for (const b of out.bands) out.lines.push(`«${b.said}» = the ${b.band} (${b.from}–${b.to})`);
  for (const r of out.relative) out.lines.push(`«${r.said}» = ${r.kind === 'after_previous' ? 'a time AFTER the last one offered (find_slots with after: "last_offered")'
    : r.kind === 'before_previous' ? 'an EARLIER time than the one offered' : 'the earliest free time'}`);
  return out;
}
