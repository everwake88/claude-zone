// ---- shared: the clinic's clock ------------------------------------------
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_AR = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];
const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// now in the clinic's time zone: { date 'YYYY-MM-DD', dow 0–6, minutes since midnight, label 'HH:MM' }
function localNow(tz, at) {
  const when = at ? new Date(at) : new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Africa/Cairo', weekday: 'short', hour: '2-digit',
      minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(when);
    const g = (t) => (parts.find(p => p.type === t) || {}).value;
    const h = Number(g('hour')) % 24, m = Number(g('minute'));
    return { dow: DAYS.indexOf(String(g('weekday')).toLowerCase().slice(0, 3)), minutes: h * 60 + m,
             label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, date: `${g('year')}-${g('month')}-${g('day')}` };
  } catch (e) {
    const d = new Date(when.getTime() + 2 * 3600 * 1000);
    return { dow: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
             label: d.toISOString().slice(11, 16), date: d.toISOString().slice(0, 10) };
  }
}
// plain calendar arithmetic on 'YYYY-MM-DD' (no time zone involved)
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const dowOf = (date) => new Date(date + 'T12:00:00Z').getUTCDay();
const dayMonth = (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
// 17:30 → "5:30 م"
function clockAr(hhmm, en = false) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${en ? (h < 12 ? 'am' : 'pm') : (h < 12 ? 'ص' : 'م')}`;
}
function localTime(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  } catch (e) { return String(iso || '').slice(11, 16); }
}
