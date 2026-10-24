// ---- shared: basics ----------------------------------------------------
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
const arr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
const str = (v) => String(v == null ? '' : v).trim();
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const money = (n) => Math.round(num(n) * 100) / 100;
const fmt = (n) => String(money(n));
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const parseJson = (v, d) => {
  if (v && typeof v === 'object') return v;
  try { const x = JSON.parse(v); return x == null ? d : x; } catch (e) { return d; }
};
// a Postgres node returns { r: <jsonb> }; a missing row returns {}
const row = (j) => obj(parseJson(obj(j).r, {}));
// an Egyptian number as people write it: 201554354929 → 01554354929
const localPhone = (p) => str(p).replace(/^\+?20(1\d{9})$/, '0$1');
// a villa or a house has no floor or apartment to ask for
const HOUSE_RE = /فيلا|فيلّا|ڤيلا|villa|بيت مستقل|دوبلكس|duplex|تاون ?هاوس|توين ?هاوس|town ?house|twin ?house/i;
const fieldNeeded = (f, d) => !(['address_floor', 'address_apartment'].includes(f)
  && HOUSE_RE.test([d.address_building, d.address_street, d.address_notes, d.address_landmark].map(str).join(' ')));
// a weight the Egyptian way: 0.5 → نص كيلو, 1.5 → كيلو ونص
const kiloText = (q) => {
  const n = Math.round(num(q) * 100) / 100, whole = Math.floor(n), part = Math.round((n - whole) * 100) / 100;
  const frac = { 0.25: 'ربع', 0.5: 'نص', 0.75: 'تلت تربع' }[part];
  if (part && !frac) return `${fmt(n)} كيلو`;
  if (!whole) return `${frac} كيلو`;
  const w = whole === 1 ? 'كيلو' : whole === 2 ? '2 كيلو' : `${whole} كيلو`;
  return frac ? `${w} و${frac}` : w;
};
