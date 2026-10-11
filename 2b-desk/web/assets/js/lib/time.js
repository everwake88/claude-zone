// Time: one clock synced to the server (so every countdown agrees), and
// formatting in the team's time zone.
import { useEffect, useState } from './h.js';

let offset = 0;
let tz = 'Africa/Cairo';

export function syncServerTime(iso, sentAt = null) {
  const server = new Date(iso).getTime();
  if (!Number.isFinite(server)) return;
  const rtt = sentAt ? Date.now() - sentAt : 0;
  offset = server + rtt / 2 - Date.now();
}
export const now = () => Date.now() + offset;
export const setTimeZone = (z) => {
  if (z) tz = z;
};
export const timeZone = () => tz;

// Re-render every `ms` (one shared timer would be fancier; this is plenty).
export function useNow(ms = 1000) {
  const [t, set] = useState(now());
  useEffect(() => {
    const id = setInterval(() => set(now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

const cache = new Map();
function fmt(opts) {
  const key = tz + JSON.stringify(opts);
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }));
  return cache.get(key);
}

export const clock = (d) => (d ? fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d)) : '—');
export const clockSec = (d) =>
  d ? fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(d)) : '—';

export function dateKey(d) {
  const p = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(d));
  const get = (t) => p.find((x) => x.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function dayLabel(d) {
  const k = dateKey(d);
  if (k === dateKey(now())) return 'Today';
  if (k === dateKey(now() - 86400000)) return 'Yesterday';
  return fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d));
}

export function longDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

export function shiftDay(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

// 75_000 -> "1:15", 3_725_000 -> "1:02:05"
export function stopwatch(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// 45_000 -> "45s", 720_000 -> "12m", 4_320_000 -> "1h 12m"
export function human(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 && m < 10 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

export const since = (d) => human(now() - new Date(d).getTime());
