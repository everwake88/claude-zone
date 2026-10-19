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
