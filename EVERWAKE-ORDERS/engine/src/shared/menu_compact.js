// ---- the MENU, written compactly: the same information in fewer words ----------------------------
// · a set of choices that two or more dishes share is written once, in a list at the top, and each
//   of those dishes points to it ("اختيارات: #1") — on a menu where many dishes share the same
//   sizes, sauces and sides this is most of the saving
// · the currency is said once, at the top, instead of after every price
// · runs of spaces and empty lines are dropped
// Every dish keeps its code, names, price, unit, marks, description and every choice with its price.
const CHOICES_PREFIX = '  اختيارات: ';
function compactMenu(text, sym) {
  const lines = String(text || '').split('\n');
  // the choice sets that are worth naming: shared by two or more dishes, and long enough to save words
  const count = new Map();
  for (const l of lines) if (l.startsWith(CHOICES_PREFIX)) {
    const k = l.slice(CHOICES_PREFIX.length); count.set(k, (count.get(k) || 0) + 1);
  }
  const label = new Map();
  for (const l of lines) if (l.startsWith(CHOICES_PREFIX)) {
    const k = l.slice(CHOICES_PREFIX.length);
    if (!label.has(k) && count.get(k) >= 2 && k.length >= 20) label.set(k, '#' + (label.size + 1));
  }
  let body = lines.map(l => (l.startsWith(CHOICES_PREFIX) && label.has(l.slice(CHOICES_PREFIX.length))
    ? CHOICES_PREFIX + label.get(l.slice(CHOICES_PREFIX.length)) : l.replace(/(\S) {2,}/g, '$1 '))).join('\n')
    .replace(/\n{3,}/g, '\n\n');
  const legend = [...label.entries()].map(([k, id]) => `${id} = ${k}`);
  let all = [...(legend.length ? ['CHOICE SETS (a dish that says "اختيارات: #n" has exactly that set):', ...legend, ''] : []), body].join('\n');
  // the currency after every price → once at the top
  const s = String(sym || '');
  if (s.trim()) {
    const esc = s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp('(\\d)\\s?' + esc + '(?![\\u0600-\\u06FFA-Za-z])', 'g');
    if (rx.test(all)) all = `Prices are in ${s.trim()} (written without it below; "+N" on a choice adds N to the dish).\n` + all.replace(rx, '$1');
  }
  return all;
}
