'use client';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { placeName, useClinic } from '@/lib/clinic-data';
import { clock, cx, dayLabel } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import type { Slot } from '@/lib/types';
import { Skeleton } from '../ui';
import { useTenant } from '../tenant';

export const sameSlot = (a: Slot | null, b: Slot | null) => !!a && !!b && a.kind === b.kind && a.starts_at === b.starts_at && a.location_id === b.location_id;

// What is really free (the same slots the assistant offers): a strip of days, then that day's
// times or its queue number. `query` is passed to dashboard_slots as it is.
export function SlotPicker({ query, value, onChange, layout = 'slot', startDate }:
  { query: Record<string, unknown> | null; value: Slot | null; onChange: (s: Slot | null) => void; layout?: string; startDate?: string | null }) {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const { locations } = useClinic();
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [why, setWhy] = useState<string[] | null>(null);
  const [day, setDay] = useState<string | null>(startDate || null);
  const key = JSON.stringify(query);

  useEffect(() => {
    if (!query) return;
    let stale = false;
    setSlots(null); setWhy(null); onChange(null);
    sb().rpc('dashboard_slots', { p_tenant: tenant.id, p: { limit: 200, staff: true, ...query } }).then(({ data }) => {
      if (stale) return;
      const r = (data || {}) as { slots?: Slot[]; none_because?: string[] | null };
      const list = r.slots || [];
      setSlots(list); setWhy(r.none_because || null);
      setDay(d => (d && list.some(s => s.date === d) ? d : list[0]?.date || null));
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tenant.id]);

  const days = useMemo(() => {
    const m = new Map<string, Slot[]>();
    (slots || []).forEach(s => m.set(s.date, [...(m.get(s.date) || []), s]));
    return [...m.entries()].slice(0, 21);
  }, [slots]);
  const daySlots = days.find(([d]) => d === day)?.[1] || [];

  if (!query) return null;
  if (slots === null) return <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-24" /></div>;
  if (days.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-control px-3 py-3 text-[13px] text-muted">
        {why?.includes('AGE_NOT_SERVED') ? t('This service is not for the patient’s age.') : t('Nothing free in the next three weeks. Try another doctor, place or service.')}
      </p>
    );
  }
  return (
    <div className="space-y-2.5">
      <div className="rail -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {days.map(([d, list]) => {
          const on = d === day;
          return (
            <button key={d} type="button" onClick={() => { setDay(d); onChange(null); }} aria-pressed={on}
              className={cx('press relative flex h-14 w-[58px] shrink-0 flex-col items-center justify-center rounded-xl text-center',
                on ? 'text-white' : 'ring-1 ring-inset ring-border hover:bg-raised')}>
              {on && <motion.span layoutId={`${layout}-day`} className="absolute inset-0 rounded-xl bg-accent" transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }} />}
              <span className={cx('relative text-[11px]', on ? 'text-white/80' : 'text-muted')}>{dayLabel(d, tenant.timezone, { weekday: 'short' })}</span>
              <span className="relative text-[15px] font-semibold tabular-nums">{dayLabel(d, tenant.timezone, { day: 'numeric' })}</span>
              <span className={cx('relative text-[10px] tabular-nums', on ? 'text-white/75' : 'text-faint')}>{list[0].kind === 'queue' ? t('queue') : list.length}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted">{day && dayLabel(day, tenant.timezone)}{daySlots[0] ? ` · ${placeName(locations.find(l => l.id === daySlots[0].location_id), lang)}` : ''}</p>
      <div key={day} className="c-fade grid grid-cols-4 gap-1.5 sm:grid-cols-5">
        {daySlots.map((s, i) => {
          const on = sameSlot(value, s);
          return s.kind === 'queue' ? (
            <button key={'q' + s.location_id} type="button" onClick={() => onChange(s)} aria-pressed={on}
              className={cx('press col-span-4 flex min-h-12 flex-wrap items-center justify-between gap-x-3 rounded-xl px-3 py-1.5 text-start text-[13px] sm:col-span-5',
                on ? 'bg-accent text-white' : 'ring-1 ring-inset ring-border hover:bg-raised')}>
              <span><span className="font-semibold">{t('Number {n} in the queue', { n: s.queue_no })}</span>
                <span className={cx('ms-2', on ? 'text-white/80' : 'text-muted')}>{t('expected about {t}', { t: clock(s.est_at, tenant.timezone) })}</span></span>
              {s.left != null && <span className={cx('text-xs', on ? 'text-white/80' : 'text-faint')}>{t('{n} places left', { n: s.left })}</span>}
            </button>
          ) : (
            <button key={s.starts_at + s.location_id} type="button" onClick={() => onChange(s)} aria-pressed={on} style={{ animationDelay: `${Math.min(i, 12) * 14}ms` }}
              className={cx('c-rise press h-9 rounded-xl text-[13px] font-medium tabular-nums', on ? 'bg-accent text-white' : 'ring-1 ring-inset ring-border hover:bg-raised')}>
              {clock(s.starts_at, tenant.timezone)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
