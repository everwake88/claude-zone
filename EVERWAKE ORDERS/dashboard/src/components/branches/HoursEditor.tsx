'use client';
import { Plus, X } from 'lucide-react';
import type { Hours, Window } from '@/lib/types';
import { Button, Input } from '../ui';

const DAYS = [['sat', 'Saturday'], ['sun', 'Sunday'], ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday']] as const;
type Day = typeof DAYS[number][0];

const windowsOf = (h: Hours, d: Day): Window[] => {
  const w = h[d] !== undefined ? h[d] : h.default;
  return Array.isArray(w) ? w : (w ? [w] : []);
};

// Opening hours per day, split shifts allowed; a closing time before the
// opening time runs past midnight (12:00 → 02:00).
export function HoursEditor({ value, onChange }: { value: Hours; onChange: (h: Hours) => void }) {
  const full: Record<Day, Window[]> = Object.fromEntries(DAYS.map(([d]) => [d, windowsOf(value || {}, d)])) as Record<Day, Window[]>;
  const write = (next: Record<Day, Window[]>) => onChange(Object.fromEntries(DAYS.map(([d]) => [d, next[d]])) as Hours);
  const set = (d: Day, ws: Window[]) => write({ ...full, [d]: ws });

  return (
    <div className="space-y-2">
      {DAYS.map(([d, label]) => (
        <div key={d} className="flex flex-wrap items-center gap-2">
          <span className="w-24 text-sm">{label}</span>
          {full[d].length === 0 && <span className="text-sm text-muted">Closed</span>}
          {full[d].map((w, i) => (
            <span key={i} className="flex items-center gap-1">
              <Input type="time" className="w-28" value={w.open} onChange={e => set(d, full[d].map((x, j) => j === i ? { ...x, open: e.target.value } : x))} />
              <span className="text-muted">–</span>
              <Input type="time" className="w-28" value={w.close} onChange={e => set(d, full[d].map((x, j) => j === i ? { ...x, close: e.target.value } : x))} />
              <button onClick={() => set(d, full[d].filter((_, j) => j !== i))} className="text-muted hover:text-critical" aria-label="Remove"><X className="size-4" /></button>
            </span>
          ))}
          <Button size="sm" variant="ghost" onClick={() => set(d, [...full[d], { open: '12:00', close: '00:00' }])}><Plus className="size-3.5" /> {full[d].length ? 'Shift' : 'Open'}</Button>
          {d === 'sat' && <Button size="sm" variant="ghost" onClick={() => write(Object.fromEntries(DAYS.map(([x]) => [x, full.sat])) as Record<Day, Window[]>)}>Copy to every day</Button>}
        </div>
      ))}
      <p className="text-xs text-muted">A closing time earlier than the opening time means after midnight (12:00 – 02:00).</p>
    </div>
  );
}
