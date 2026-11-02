// ---- shared: red flags, in code ---------------------------------------------
// Runs on every message (and every transcribed voice note) before the model
// sees it. A match is a FACT for the Brain and the Agent and an alert on the
// dashboard; an emergency also reaches the doctor's own WhatsApp, and the
// reply must carry the emergency guidance first (Check Reply adds it when
// it is missing). It errs on the side of caution: a false alarm costs a
// minute of the doctor's attention, a missed one can cost far more.
//   triage(text, presetTriage) → { level: 'emergency' | 'urgent' | null, matches: [...] }
// presetTriage = the specialities' own words (turn_context.specialty_triage).
// Requires shared/arabic.js.

const RED_FLAGS = [
  ['emergency', 'chest pain or pressure', ['الم في صدري', 'وجع في صدري', 'صدري واجعني', 'صدري بيوجعني', 'ضغط على صدري', 'صدري مقبوض',
    'تقل على صدري', 'الم في الصدر', 'وجع في الصدر', 'chest pain', 'chest tightness', 'pressure in my chest']],
  ['emergency', 'cannot breathe', ['مش قادر اتنفس', 'مش قادره اتنفس', 'مش قادر يتنفس', 'مش قادره تتنفس', 'مش عارف اتنفس', 'مش عارفه اتنفس', 'نفسي مقطوع', 'بيتخنق', 'بتتخنق',
    'مش بيعرف يتنفس', 'مش بتعرف تتنفس', 'cant breathe', 'can t breathe', 'cannot breathe', 'difficulty breathing', 'not breathing']],
  ['emergency', 'signs of a stroke', ['وشي مايل', 'بقه مايل', 'بقي مايل', 'وشه مايل', 'كلامه تقيل', 'كلامي تقيل', 'لسانه تقيل',
    'مش قادر يحرك', 'مش قادر احرك', 'نص جسمه', 'نص جسمي', 'شلل مفاجئ', 'face drooping', 'slurred speech', 'stroke']],
  ['emergency', 'unconscious, fainting or a seizure', ['اغمى عليه', 'اغمي عليه', 'اغمى عليها', 'اغمي عليها', 'اغمى عليا', 'اغمي عليا',
    'فاقد الوعي', 'فاقده الوعي', 'مش بيفوق', 'مش بتفوق', 'مش بيصحى', 'مش بتصحى', 'تشنجات', 'بيتشنج', 'بتتشنج', 'اتشنج', 'اتشنجت',
    'unconscious', 'seizure', 'fitting', 'passed out', 'fainted']],
  ['emergency', 'heavy bleeding', ['نزيف جامد', 'نزيف شديد', 'نزيف مش بيقف', 'النزيف مش بيقف', 'بينزف جامد', 'بتنزف جامد', 'دم كتير',
    'heavy bleeding', 'bleeding wont stop', 'bleeding won t stop', 'bleeding heavily']],
  ['emergency', 'thoughts of suicide or self-harm', ['انتحر', 'انتحار', 'اموت نفسي', 'هموت نفسي', 'اقتل نفسي', 'هقتل نفسي', 'اذي نفسي',
    'هأذي نفسي', 'هاذي نفسي', 'مش عايز اعيش', 'مش عايزه اعيش', 'kill myself', 'suicide', 'end my life', 'hurt myself']],
  ['emergency', 'poisoning or an overdose', ['شرب كلور', 'شربت كلور', 'بلع دوا كتير', 'بلعت دوا كتير', 'بلع حبوب', 'بلعت حبوب', 'شرب جاز',
    'شرب مبيد', 'تسمم', 'overdose', 'poisoned', 'swallowed bleach', 'swallowed pills']],
  ['emergency', 'a severe allergic reaction', ['زوري بيقفل', 'زوري قفل', 'الزور بيقفل', 'شفايفي ورمت', 'شفايفه ورمت', 'لسانه ورم', 'لساني ورم',
    'throat closing', 'tongue swelling', 'anaphylaxis']],
  ['emergency', 'a serious injury', ['حادثه', 'عربيه خبطته', 'عربيه خبطتها', 'وقع من عالي', 'وقعت من عالي', 'وقع من البلكونه',
    'car accident', 'hit by a car', 'fell from']],
  ['urgent', 'a very high fever', ['حراره 40', 'حراره 41', 'سخونيه 40', 'سخونيه 41', 'الحراره مش بتنزل', 'السخونيه مش بتنزل',
    'fever of 40', 'fever 40', 'fever wont go down', 'fever won t go down']],
  ['urgent', 'severe pain', ['وجع مش قادر استحمله', 'الم مش قادر استحمله', 'وجع فظيع', 'الم فظيع', 'وجع رهيب', 'unbearable pain', 'severe pain']],
  ['urgent', 'vomiting blood or black stool', ['ترجيع دم', 'بيرجع دم', 'برجع دم', 'براز اسود', 'vomiting blood', 'black stool']]
];
const NEGATION = /(?:^|\s)(?:مش|مفيش|معنديش|ما عنديش|مافيش|ولا|بدون|من غير|no|not|without|never)\s+(?:\S+\s+){0,2}$/;

function triage(text, presetTriage) {
  const t = ' ' + normalizeArabic(text) + ' ';
  const matches = [];
  const lists = RED_FLAGS.map(([level, why, words]) => ({ level, why, words, specialty: null }));
  for (const group of arr(presetTriage)) {
    for (const x of arr(group)) {
      const o = obj(x);
      if (o.level && arr(o.words).length) lists.push({ level: o.level, why: str(o.why), words: arr(o.words), specialty: o.specialty || null });
    }
  }
  for (const L of lists) {
    for (const w of L.words) {
      const n = normalizeArabic(w);
      if (!n) continue;
      // the phrase at the start of a word — also after و / ال ("ومش قادر…", "الحرارة 40")
      let i = -1, from = 0, k;
      while ((k = t.indexOf(n, from)) >= 0) {
        if (/(?:^|\s)(?:و|ال|وال|بال|فال|لل)?$/.test(t.slice(Math.max(0, k - 4), k))) { i = k; break; }
        from = k + 1;
      }
      if (i < 0) continue;
      if (NEGATION.test(t.slice(Math.max(0, i - 40), i))) continue;   // "مش عندي ألم في صدري"
      matches.push({ level: L.level, why: L.why, said: w, specialty: L.specialty });
      break;
    }
  }
  // a temperature of 39.5 or more, however it is written
  const fever = t.match(/(?:حراره|سخونيه|سخونه|fever|temperature|temp)\D{0,8}(39[.,][5-9]|4[0-2](?:[.,]\d)?)(?!\d)/);
  if (fever && !matches.some(m => m.why === 'a very high fever')) matches.push({ level: 'urgent', why: 'a very high fever', said: fever[0], specialty: null });
  const level = matches.some(m => m.level === 'emergency') ? 'emergency' : matches.some(m => m.level === 'urgent') ? 'urgent' : null;
  return { level, matches };
}
