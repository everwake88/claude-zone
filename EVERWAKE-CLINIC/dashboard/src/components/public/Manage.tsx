'use client';
import { CalendarCheck2, CalendarClock, Check, MapPin, Phone, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { brandVars } from '@/lib/brand';
import { clock, cx, dayLabel } from '@/lib/format';
import { LangSwitch, useLang } from '@/lib/i18n';
import type { Slot } from '@/lib/types';

export interface ManageView {
  ok: boolean; first_name: string | null; can_change: boolean; cancel_hours: number;
  appointment: { ref_no: string; status: string; mode: string; doctor: string; service: string | null; starts_at: string; est_at: string | null; queue_no: number | null;
    date: string; delay_minutes: number; original_time: string | null; price_text: string | null };
  clinic: { name: string; brand: { color?: string; logo_url?: string } | null; phone: string | null; timezone: string };
  place: { name: string; address: string | null; directions: string | null; maps_url: string | null; phone: string | null };
}

// The patient's page, from the reminder: their appointment in big type, and the three things they
// may want: keep it, move it, cancel it. In the clinic's colour; Arabic unless they chose English.
export function Manage({ token, view }: { token: string; view: ManageView | null }) {
  const { t } = useLang();
  const [v, setV] = useState(view);
  const [mode, setMode] = useState<'view' | 'move' | 'cancel'>('view');
  const [done, setDone] = useState<null | 'confirmed' | 'moved' | 'cancelled'>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [pick, setPick] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const style = useMemo(() => (brandVars(v?.clinic.brand?.color) || {}) as React.CSSProperties, [v]);

  useEffect(() => {
    if (mode !== 'move' || slots) return;
    fetch(`/api/a/${token}`).then(r => r.json()).then((d: { slots?: Slot[] }) => { const list = d.slots || []; setSlots(list); setDay(list[0]?.date || null); });
  }, [mode, slots, token]);

  if (!v) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 text-center">
        <div className="max-w-sm"><p className="text-[17px] font-semibold">{t('This link is not valid any more.')}</p>
          <p className="mt-2 text-sm text-muted">{t('Message the clinic on WhatsApp and they will help you.')}</p></div>
      </main>
    );
  }
  const a = v.appointment, tz = v.clinic.timezone;
  const at = a.est_at || a.starts_at;
  const act = async (action: 'confirm' | 'cancel' | 'move', extra: Record<string, unknown> = {}) => {
    setBusy(true); setErr('');
    const res = await fetch(`/api/a/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !j.ok) { setErr(j.error === 'TOO_LATE_TO_CHANGE' ? t('It is too close to the time to change it here. Please call the clinic.') : j.error === 'SLOT_NOT_AVAILABLE' || j.error === 'SLOT_TAKEN' ? t('That time was just taken. Pick another.') : t('That did not work. Try again.')); return; }
    if (action === 'move' && pick) setV({ ...v, appointment: { ...a, starts_at: pick.starts_at, est_at: pick.est_at || pick.starts_at, date: pick.date, queue_no: pick.queue_no ?? null, delay_minutes: 0, original_time: null } });
    setDone(action === 'confirm' ? 'confirmed' : action === 'cancel' ? 'cancelled' : 'moved');
    setMode('view');
  };
  const days = [...new Set((slots || []).map(s => s.date))].slice(0, 14);
  const status = done === 'cancelled' ? 'cancelled' : done === 'confirmed' ? 'confirmed' : a.status;

  return (
    <main style={style} className="min-h-dvh bg-ground px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-md">
        <header className="mb-4 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {v.clinic.brand?.logo_url ? <img src={v.clinic.brand.logo_url} alt="" className="size-10 rounded-[10px] bg-sheet object-contain p-0.5 ring-1 ring-border" />
            : <span className="flex size-10 items-center justify-center rounded-[10px] bg-accent text-[16px] font-semibold text-white">{v.clinic.name.slice(0, 1)}</span>}
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold">{v.clinic.name}</p>
          <LangSwitch />
        </header>

        <section className="sheet c-rise overflow-hidden">
          <div className="p-5">
            <p className="text-[14px] text-muted">{v.first_name ? t('Hello {name}, your appointment', { name: v.first_name }) : t('Your appointment')}</p>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={at + status} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.26, ease: [0.23, 1, 0.32, 1] }}>
                <p className={cx('mt-2 text-[26px] font-semibold leading-tight', status === 'cancelled' && 'text-faint line-through')}>{dayLabel(a.date, tz)}</p>
                <p className={cx('text-[22px] font-semibold tabular-nums text-accent', status === 'cancelled' && 'text-faint line-through')}>
                  {a.mode === 'queue' ? t('Number {n}, about {t}', { n: a.queue_no, t: clock(at, tz) }) : clock(at, tz)}
                </p>
                {a.delay_minutes > 0 && a.original_time && <p className="mt-1 text-[13px] text-caution">{t('Moved {n} minutes later: the doctor is running late.', { n: a.delay_minutes })}</p>}
              </motion.div>
            </AnimatePresence>
            <dl className="mt-4 space-y-1.5 text-[14px]">
              <div className="flex gap-2"><dt className="w-16 shrink-0 text-muted">{t('Doctor')}</dt><dd><bdi>{a.doctor}</bdi></dd></div>
              {a.service && <div className="flex gap-2"><dt className="w-16 shrink-0 text-muted">{t('For')}</dt><dd><bdi>{a.service}</bdi>{a.price_text ? <span className="text-muted"> · {a.price_text}</span> : null}</dd></div>}
              <div className="flex gap-2"><dt className="w-16 shrink-0 text-muted">{t('Booking')}</dt><dd className="tabular-nums" dir="ltr">{a.ref_no}</dd></div>
            </dl>
          </div>
          <div className="border-t border-rule bg-raised/70 px-5 py-4 text-[13.5px]">
            <p className="flex items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
              <span><b className="font-semibold"><bdi>{v.place.name}</bdi></b>{v.place.address ? <> — <bdi>{v.place.address}</bdi></> : null}
                {v.place.directions && <span className="block text-muted"><bdi>{v.place.directions}</bdi></span>}</span></p>
            <div className="mt-3 flex flex-wrap gap-2">
              {v.place.maps_url && <a href={v.place.maps_url} target="_blank" rel="noreferrer" className="press inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-sheet px-3 font-medium ring-1 ring-inset ring-border">{t('Open the map')}</a>}
              {(v.place.phone || v.clinic.phone) && <a href={`tel:${v.place.phone || v.clinic.phone}`} className="press inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-sheet px-3 font-medium ring-1 ring-inset ring-border"><Phone className="size-4" aria-hidden />{t('Call the clinic')}</a>}
            </div>
          </div>
        </section>

        <AnimatePresence mode="wait">
          {done ? (
            <motion.div key={done} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
              className={cx('mt-4 flex items-center gap-3 rounded-[14px] p-4 text-[14.5px] font-medium', done === 'cancelled' ? 'bg-sheet ring-1 ring-border' : 'bg-positive-soft text-positive-ink')}>
              <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full', done === 'cancelled' ? 'bg-raised text-muted' : 'bg-positive text-white')}>
                {done === 'cancelled' ? <X className="size-5" aria-hidden /> : <Check className="size-5" aria-hidden />}
              </span>
              {done === 'confirmed' ? t('Confirmed. See you then.') : done === 'moved' ? t('Moved. You will get a reminder before it.') : t('Cancelled. Message us on WhatsApp whenever you want another time.')}
            </motion.div>
          ) : !v.can_change ? (
            <p className="mt-4 rounded-[14px] bg-sheet p-4 text-[13.5px] text-muted ring-1 ring-border">
              {a.status === 'cancelled' ? t('This appointment was cancelled.') : t('To change it now, please call the clinic.')}
            </p>
          ) : mode === 'view' ? (
            <motion.div key="actions" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 grid gap-2">
              {a.status === 'booked' && <button disabled={busy} onClick={() => act('confirm')} className="press flex h-12 items-center justify-center gap-2 rounded-[12px] bg-accent text-[15px] font-semibold text-white disabled:opacity-60"><CalendarCheck2 className="size-5" aria-hidden />{t('I’ll be there')}</button>}
              <button onClick={() => setMode('move')} className="press flex h-12 items-center justify-center gap-2 rounded-[12px] bg-sheet text-[15px] font-medium ring-1 ring-inset ring-control"><CalendarClock className="size-5" aria-hidden />{t('Another time')}</button>
              <button onClick={() => setMode('cancel')} className="press h-11 rounded-[12px] text-[14px] font-medium text-critical">{t('Cancel the appointment')}</button>
            </motion.div>
          ) : mode === 'move' ? (
            <motion.section key="move" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="sheet mt-4 space-y-3 p-4">
              <p className="text-[14px] font-semibold">{t('Pick another time')}</p>
              {!slots ? <div className="skeleton h-24" /> : !slots.length ? <p className="text-[13.5px] text-muted">{t('No free times in the next weeks. Please message the clinic.')}</p> : <>
                <div className="rail -mx-1 flex gap-1.5 overflow-x-auto px-1">
                  {days.map(d => (
                    <button key={d} onClick={() => { setDay(d); setPick(null); }} aria-pressed={d === day}
                      className={cx('press flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-[10px] text-center', d === day ? 'bg-accent text-white' : 'ring-1 ring-inset ring-border')}>
                      <span className="text-[11px] opacity-80">{dayLabel(d, tz, { weekday: 'short' })}</span><span className="text-[16px] font-semibold tabular-nums">{dayLabel(d, tz, { day: 'numeric' })}</span>
                    </button>
                  ))}
                </div>
                <div key={day} className="c-fade grid grid-cols-3 gap-1.5">
                  {(slots || []).filter(s => s.date === day).map(s => {
                    const on = pick?.starts_at === s.starts_at && pick?.kind === s.kind;
                    return <button key={s.kind + s.starts_at + s.location_id} onClick={() => setPick(s)} aria-pressed={on}
                      className={cx('press h-10 rounded-[9px] text-[14px] font-medium tabular-nums', s.kind === 'queue' && 'col-span-3', on ? 'bg-accent text-white' : 'ring-1 ring-inset ring-border')}>
                      {s.kind === 'queue' ? t('Number {n}, about {t}', { n: s.queue_no, t: clock(s.est_at, tz) }) : clock(s.starts_at, tz)}</button>;
                  })}
                </div>
              </>}
              <div className="flex gap-2 pt-1">
                <button onClick={() => setMode('view')} className="press h-11 flex-1 rounded-[11px] text-[14px] font-medium ring-1 ring-inset ring-border">{t('Back')}</button>
                <button disabled={!pick || busy} onClick={() => pick && act('move', { starts_at: pick.kind === 'slot' ? pick.starts_at : null, date: pick.date, kind: pick.kind, location_id: pick.location_id })}
                  className="press h-11 flex-[2] rounded-[11px] bg-accent text-[14px] font-semibold text-white disabled:opacity-50">{pick ? t('Move to {t}', { t: pick.kind === 'queue' ? `#${pick.queue_no}` : clock(pick.starts_at, tz) }) : t('Pick a time')}</button>
              </div>
            </motion.section>
          ) : (
            <motion.section key="cancel" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="sheet mt-4 space-y-3 p-4">
              <p className="text-[14px] font-semibold">{t('Cancel the appointment?')}</p>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} dir="auto" placeholder={t('Why (optional)')} className="w-full rounded-[9px] border border-control bg-sheet px-3 py-2 text-[14px] focus:border-accent focus:outline-none" />
              <div className="flex gap-2">
                <button onClick={() => setMode('view')} className="press h-11 flex-1 rounded-[11px] text-[14px] font-medium ring-1 ring-inset ring-border">{t('Keep it')}</button>
                <button disabled={busy} onClick={() => act('cancel', { reason })} className="press h-11 flex-1 rounded-[11px] bg-critical text-[14px] font-semibold text-white disabled:opacity-60">{t('Cancel it')}</button>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
        {err && <p role="alert" className="c-fade mt-3 rounded-[10px] bg-critical-soft px-3 py-2 text-[13.5px] text-critical-ink">{err}</p>}
        {v.cancel_hours > 0 && !done && v.can_change && <p className="mt-4 text-center text-xs text-muted">{t('Changes here up to {n} hours before.', { n: v.cancel_hours })}</p>}
        <p className="mt-6 text-center text-[11px] text-faint">Everwake Clinic</p>
      </div>
    </main>
  );
}
