import type { Hours, Window } from './types';
import { zonedParts } from './zoned';

// A branch's opening hours as the day goes: is it open now, when does that change, and today's
// windows to draw. Mirrors the database's is_open_at / day_windows: a day without its own hours
// takes "default", a closing time at or before the opening time runs past midnight.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h || 0) * 60 + (m || 0); };

export function windowsOn(hours: Hours | null | undefined, dow: number): Window[] {
  if (!hours) return [];
  const w = hours[DAYS[((dow % 7) + 7) % 7]] !== undefined ? hours[DAYS[((dow % 7) + 7) % 7]] : hours.default;
  return Array.isArray(w) ? w : w ? [w] : [];
}

export interface Today {
  known: boolean;                          // false: no hours on file
  open: boolean;
  now: number;                             // minutes since midnight, in the restaurant's time zone
  spans: [number, number][];               // today's open time, minutes from midnight, cut to the day (for the strip)
  change: { kind: 'closes' | 'opens'; in: number; at: number } | null;   // the next change: minutes from now, and the clock time (minutes of its day)
}

export function today(hours: Hours | null | undefined, tz: string, at = new Date()): Today {
  const { hour, minute, dow } = zonedParts(at, tz);
  const now = hour * 60 + minute;
  const known = !!hours && Object.keys(hours).length > 0;
  // yesterday's late windows, today's, and tomorrow's, all measured from today's midnight
  const spans: [number, number][] = [];
  for (const [shift, day] of [[-1440, dow - 1], [0, dow], [1440, dow + 1]] as const) {
    for (const w of windowsOn(hours, day)) {
      const o = mins(w.open); let c = mins(w.close); if (c <= o) c += 1440;
      spans.push([o + shift, c + shift]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  // windows that touch become one (12:00–17:00 and 17:00–02:00 close at 02:00)
  const merged: [number, number][] = [];
  for (const s of spans) { const last = merged[merged.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([...s]); }
  const cur = merged.find(([a, b]) => now >= a && now < b);
  const next = merged.find(([a]) => a > now);
  const change = cur ? { kind: 'closes' as const, in: cur[1] - now, at: ((cur[1] % 1440) + 1440) % 1440 }
    : next ? { kind: 'opens' as const, in: next[0] - now, at: ((next[0] % 1440) + 1440) % 1440 } : null;
  const day = merged.map(([a, b]) => [Math.max(0, a), Math.min(1440, b)] as [number, number]).filter(([a, b]) => b > a);
  return { known, open: !!cur, now, spans: day, change };
}
