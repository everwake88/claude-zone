// Days as the restaurant lives them: midnight and dates in its own time zone, not the browser's.

// midnight in the time zone `tz`, `daysAgo` days back, as an instant
export function zonedMidnight(tz: string, daysAgo = 0, from = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(from).map(x => [x.type, x.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - from.getTime();
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day - daysAgo) - offset);
}

// midnight in `tz` at the start of a calendar date written YYYY-MM-DD
export function zonedDate(tz: string, ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return zonedMidnight(tz, 0, new Date(Date.UTC(y, m - 1, d, 12)));
}

// the calendar date (YYYY-MM-DD) of an instant in `tz`
export const dayKey = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// the hour (0–23) and the day of the week (0 = Sunday) of an instant in `tz`
export function zonedParts(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { hour: +p.hour, minute: +p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
