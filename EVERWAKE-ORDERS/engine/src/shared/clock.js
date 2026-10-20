// ---- shared: the restaurant's clock and opening hours --------------------
// hours = {"sun":[{"open":"12:00","close":"02:00"}], …, "default":[…]}; a day
// may also be one {"open","close"} object, or [] for closed all day.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_AR = { sun: 'الأحد', mon: 'الاتنين', tue: 'التلات', wed: 'الأربع', thu: 'الخميس', fri: 'الجمعة', sat: 'السبت' };

function localNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Africa/Cairo', weekday: 'short', hour: '2-digit',
      minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const g = (t) => (parts.find(p => p.type === t) || {}).value;
    const h = Number(g('hour')) % 24, m = Number(g('minute'));
    return { day: DAYS.indexOf(String(g('weekday')).toLowerCase().slice(0, 3)), minutes: h * 60 + m,
             label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, date: `${g('year')}-${g('month')}-${g('day')}` };
  } catch (e) {
    const d = new Date(Date.now() + 2 * 3600 * 1000);
    return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
             label: d.toISOString().slice(11, 16), date: d.toISOString().slice(0, 10) };
  }
}
const toMin = (s) => { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
function dayWindows(hours, d) {
  const h = (hours && typeof hours === 'object') ? hours : {};
  const w = h[DAYS[((d % 7) + 7) % 7]] !== undefined ? h[DAYS[((d % 7) + 7) % 7]] : h.default;
  return (Array.isArray(w) ? w : (w ? [w] : [])).filter(x => x && x.open && x.close);
}
function openStatus(hours, now) {
  if (!hours || !Object.keys(hours).length) return { state: 'unknown', text: 'hours not on file' };
  const m = now.minutes;
  for (const w of dayWindows(hours, now.day)) {
    let o = toMin(w.open), c = toMin(w.close); if (c <= o) c += 1440;
    if (m >= o && m < c) return { state: 'open', text: `OPEN now (until ${w.close})`, until: w.close };
  }
  for (const w of dayWindows(hours, now.day - 1)) {
    let o = toMin(w.open), c = toMin(w.close); if (c <= o) c += 1440;
    if (m + 1440 >= o && m + 1440 < c) return { state: 'open', text: `OPEN now (until ${w.close})`, until: w.close };
  }
  const later = dayWindows(hours, now.day).filter(w => toMin(w.open) > m).sort((a, b) => toMin(a.open) - toMin(b.open))[0];
  if (later) return { state: 'closed', text: `CLOSED now — opens today at ${later.open}`, opens: later.open };
  for (let i = 1; i <= 7; i++) {
    const w = dayWindows(hours, now.day + i).sort((a, b) => toMin(a.open) - toMin(b.open))[0];
    if (w) return { state: 'closed', text: `CLOSED now — opens ${i === 1 ? 'tomorrow' : DAYS[(now.day + i) % 7]} at ${w.open}`, opens: w.open };
  }
  return { state: 'closed', text: 'CLOSED (no opening hours this week)' };
}
// accepting switch + busy pause + hours, as one fact
function localTime(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(iso));
  } catch (e) { return String(iso || '').slice(11, 16); }
}
function branchStatus(b, now, tz) {
  if (!b) return { state: 'unknown', text: 'unknown branch' };
  if (b.accepting_orders === false) return { state: 'not_accepting', text: 'NOT taking orders' + (b.seasonal ? ' (seasonal)' : '') };
  if (b.busy_until && new Date(b.busy_until).getTime() > Date.now()) {
    return { state: 'busy', text: `PAUSED by the branch (too busy) until about ${localTime(b.busy_until, tz)}`
      + (b.busy_reason ? ` — ${b.busy_reason}` : ''), until: localTime(b.busy_until, tz) };
  }
  return openStatus(b.hours, now);
}
