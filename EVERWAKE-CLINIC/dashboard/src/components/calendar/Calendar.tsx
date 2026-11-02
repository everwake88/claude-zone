'use client';
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { docName, useClinic } from '@/lib/clinic-data';
import { okOrThrow } from '@/lib/codes';
import { clock, cx, dayLabel } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { ping } from '@/lib/outbox-client';
import { sb } from '@/lib/supabase/client';
import type { ApptCard } from '@/lib/types';
import { useCached } from '@/lib/use-cached';
import { dayKey, zonedDate, zonedParts } from '@/lib/zoned';
import { ApptDrawer, STATUS_LABEL, STATUS_TONE } from '../appointment/ApptDrawer';
import { DocDot } from '../booking/pickers';
import { useShell } from '../shell/Shell';
import { Button, Checkbox, Dialog, Empty, PageTitle, Pill, Segmented, Skeleton, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';

interface Session { doctor_id: string; location_id: string; date: string; starts_at: string; ends_at: string; mode: string; slot_minutes: number; capacity: number | null; online: boolean }
interface Exception { id: string; doctor_id: string; on_date: string; kind: string; start_time: string | null; end_time: string | null; reason: string | null }
interface Range { appointments: ApptCard[]; sessions: Session[]; exceptions: Exception[] }
type View = 'day' | 'week' | 'list';

const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const HOUR_PX = 72;
const SNAP = 15;

// The calendar: the week or a day in columns (a day per column, or a doctor per column), every
// booking where it falls. Drag a booking to move it; the patient is told on WhatsApp if you say so.
export function Calendar() {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const shell = useShell();
  const { doctors } = useClinic();
  const reduce = useReducedMotion();
  const tz = tenant.timezone;
  const today = dayKey(new Date(), tz);
  const [view, setView] = useState<View>('week');
  const [date, setDate] = useState(today);
  const [doctor, setDoctor] = useState<string>(tenant.doctor_id || 'all');
  const [open, setOpen] = useState<ApptCard | null>(null);
  const [drop, setDrop] = useState<{ a: ApptCard; startsAt: string; label: string } | null>(null);
  const [tell, setTell] = useState(true);
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => { if (window.innerWidth < 768) setView('list'); }, []);

  // the week starts on Saturday, as Egyptian clinics count it
  const weekStart = useMemo(() => { const dow = zonedParts(zonedDate(tz, date), tz).dow; return addDays(date, -((dow + 1) % 7)); }, [date, tz]);
  const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)) : [date];
  const from = days[0], to = days[days.length - 1];
  const { data, refresh } = useCached<Range>(`cal:${tenant.id}:${from}:${to}:${doctor}`, async () => {
    const { data, error } = await sb().rpc('calendar_range', { p_tenant: tenant.id, p_from: from, p_to: to, p_doctor: doctor === 'all' ? null : doctor });
    if (error) throw new Error(error.message);
    return data as Range;
  });
  useLive(['appointments'], () => refresh());

  const activeDocs = doctors.filter(d => d.is_active && (doctor === 'all' || d.id === doctor));
  // columns: a day each (week), or a doctor each (day)
  const cols = view === 'week' ? days.map(d => ({ key: d, date: d, doctor: null as string | null }))
    : activeDocs.map(d => ({ key: d.id, date, doctor: d.id as string | null }));
  const appts = (data?.appointments || []).filter(a => a.status !== 'cancelled' && a.status !== 'held');
  const minOf = (iso: string) => { const p = zonedParts(new Date(iso), tz); return p.hour * 60 + p.minute; };
  const [lo, hi] = useMemo(() => {
    const ms = [...(data?.sessions || []).flatMap(s => [minOf(s.starts_at), minOf(s.ends_at) || 1440]), ...appts.flatMap(a => [minOf(a.est_at || a.starts_at), minOf(a.est_at || a.starts_at) + 30])];
    if (!ms.length) return [9 * 60, 21 * 60];
    return [Math.floor(Math.min(...ms) / 60) * 60, Math.min(24 * 60, Math.ceil(Math.max(...ms) / 60) * 60)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tz]);
  const ypx = (min: number) => ((min - lo) / 60) * HOUR_PX;
  const hours = Array.from({ length: (hi - lo) / 60 + 1 }, (_, i) => lo + i * 60);
  const nowMin = minOf(new Date().toISOString());

  const startDrop = (a: ApptCard, col: { date: string }, dy: number, dxCols: number) => {
    const startMin = minOf(a.est_at || a.starts_at) + Math.round((dy / HOUR_PX) * 60 / SNAP) * SNAP;
    const newDate = view === 'week' ? addDays(col.date, dxCols) : col.date;
    if (startMin === minOf(a.est_at || a.starts_at) && newDate === col.date) return;
    const at = new Date(+zonedDate(tz, newDate) + startMin * 60_000).toISOString();
    setTell(a.whatsapp);
    setDrop({ a, startsAt: at, label: `${dayLabel(newDate, tz, { weekday: 'long', day: 'numeric', month: 'short' })} · ${clock(at, tz)}` });
  };
  const confirmMove = async () => {
    if (!drop) return;
    const r = await run(async () => {
      const { data, error } = await sb().rpc('move_appointment', { p_appt: drop.a.id, p: { starts_at: drop.startsAt, kind: 'slot', notify: tell } });
      if (error) throw new Error(error.message);
      return okOrThrow(data as { ok?: boolean; error?: string });
    });
    setDrop(null);
    if (r) { if (tell) ping(); toast(tell ? t('Moved. The patient is being told.') : t('Moved.')); }
    refresh();
  };

  const title = view === 'week'
    ? `${dayLabel(from, tz, { day: 'numeric', month: 'short' })} – ${dayLabel(to, tz, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : dayLabel(date, tz, { weekday: 'long', day: 'numeric', month: 'long' });
  const step = view === 'week' ? 7 : 1;
  const colsWrap = useRef<HTMLDivElement>(null);

  return (
    <div className="space-y-4">
      <PageTitle title={t('Calendar')} finding={title}
        actions={<>
          <div className="flex items-center rounded-[8px] ring-1 ring-inset ring-border">
            <button onClick={() => setDate(d => addDays(d, -step))} className="press flex size-9 items-center justify-center rounded-s-[8px] text-muted hover:bg-raised" aria-label={t('Back')}><ChevronLeft className="size-4 rtl:rotate-180" /></button>
            <button onClick={() => setDate(today)} className="press h-9 px-2.5 text-[13px] font-medium">{t('Today')}</button>
            <button onClick={() => setDate(d => addDays(d, step))} className="press flex size-9 items-center justify-center rounded-e-[8px] text-muted hover:bg-raised" aria-label={t('Forward')}><ChevronRight className="size-4 rtl:rotate-180" /></button>
          </div>
          <Segmented label="cal-view" value={view} onChange={setView} options={[{ value: 'day', label: t('Day') }, { value: 'week', label: t('Week') }, { value: 'list', label: t('List') }]} />
        </>} />
      {doctors.filter(d => d.is_active).length > 1 && (
        <div className="rail -mx-1 overflow-x-auto px-1">
          <Segmented label="cal-doctor" value={doctor} onChange={setDoctor}
            options={[{ value: 'all', label: t('All doctors') }, ...doctors.filter(d => d.is_active).map(d => ({ value: d.id, label: <span className="inline-flex items-center gap-1.5"><DocDot color={d.color} />{docName(d, lang)}</span> }))]} />
        </div>
      )}

      {!data ? <Skeleton className="h-[480px]" /> : view === 'list' ? (
        <AgendaList days={view === 'list' ? [date, addDays(date, 1), addDays(date, 2)] : days} appts={appts} onOpen={setOpen} tz={tz} />
      ) : cols.length === 0 ? <Empty>{t('No doctors yet.')}</Empty> : (
        <div className="card overflow-hidden">
          <div ref={colsWrap} className="overflow-x-auto">
            <div className="grid min-w-[760px]" style={{ gridTemplateColumns: `56px repeat(${cols.length}, minmax(0, 1fr))` }}>
              {/* heads */}
              <div className="sticky top-0 z-10 border-b border-rule bg-sheet" />
              {cols.map(c => {
                const d = c.doctor ? doctors.find(x => x.id === c.doctor) : null;
                const isToday = c.date === today;
                return (
                  <div key={c.key} className="sticky top-0 z-10 border-b border-s border-rule bg-sheet px-2 py-2 text-center">
                    {d ? <p className="flex items-center justify-center gap-1.5 truncate text-[13px] font-medium"><DocDot color={d.color} />{docName(d, lang)}</p> : (
                      <button onClick={() => { setDate(c.date); setView('day'); }} className="mx-auto block rounded-[7px] px-2 hover:bg-raised">
                        <span className="block text-[11.5px] text-muted">{dayLabel(c.date, tz, { weekday: 'short' })}</span>
                        <span className={cx('mx-auto flex size-7 items-center justify-center rounded-full text-[14px] font-semibold tabular-nums', isToday && 'bg-accent text-white')}>{dayLabel(c.date, tz, { day: 'numeric' })}</span>
                      </button>
                    )}
                  </div>
                );
              })}
              {/* the hours */}
              <div className="relative" style={{ height: ypx(hi) }}>
                {hours.slice(0, -1).map(h => <span key={h} className="absolute end-2 -translate-y-1/2 text-[11px] tabular-nums text-faint" style={{ top: ypx(h) }}>{h > lo ? clock(new Date(+zonedDate(tz, date) + h * 60_000).toISOString(), tz) : ''}</span>)}
              </div>
              {cols.map(c => {
                const sessions = (data.sessions || []).filter(s => s.date === c.date && (!c.doctor || s.doctor_id === c.doctor) && (doctor === 'all' || s.doctor_id === doctor));
                const offs = (data.exceptions || []).filter(e => e.on_date === c.date && e.kind === 'off' && (!c.doctor || e.doctor_id === c.doctor));
                const list = appts.filter(a => a.session_date === c.date && (!c.doctor || a.doctor_id === c.doctor));
                // a week's day with several doctors: a lane each, side by side
                const laneIds = c.doctor ? [c.doctor] : doctors.filter(d => sessions.some(s => s.doctor_id === d.id) || list.some(a => a.doctor_id === d.id)).map(d => d.id);
                const lane = (docId: string) => { const n = Math.max(laneIds.length, 1), i = Math.max(laneIds.indexOf(docId), 0);
                  return { insetInlineStart: `calc(${(i / n) * 100}% + 4px)`, width: `calc(${100 / n}% - 8px)` }; };
                return (
                  <div key={c.key} className="relative border-s border-rule" style={{ height: ypx(hi) }}>
                    {hours.slice(1, -1).map(h => <span key={h} aria-hidden className="absolute inset-x-0 h-px bg-rule" style={{ top: ypx(h) }} />)}
                    {sessions.map((s, i) => (
                      <button key={i} onClick={() => shell.newBooking({ doctorId: s.doctor_id, locationId: s.location_id, date: s.date })}
                        aria-label={t('Book in this session')} title={t('Book in this session')}
                        className="absolute rounded-[8px] bg-raised ring-1 ring-inset ring-border transition-colors hover:bg-accent-soft/60"
                        style={{ ...lane(s.doctor_id), top: ypx(minOf(s.starts_at)), height: ypx(minOf(s.ends_at) || 1440) - ypx(minOf(s.starts_at)) }} />
                    ))}
                    {offs.map(o => (
                      <div key={o.id} className="hatch absolute rounded-[8px] opacity-70" title={o.reason || t('Time off')}
                        style={{ ...lane(o.doctor_id), top: ypx(o.start_time ? Number(o.start_time.slice(0, 2)) * 60 + Number(o.start_time.slice(3, 5)) : lo), height: o.start_time && o.end_time ? ((Number(o.end_time.slice(0, 2)) * 60 + Number(o.end_time.slice(3, 5))) - (Number(o.start_time.slice(0, 2)) * 60 + Number(o.start_time.slice(3, 5)))) / 60 * HOUR_PX : ypx(hi) }} />
                    ))}
                    {c.date === today && nowMin >= lo && nowMin <= hi && (
                      <span aria-hidden className="absolute inset-x-0 z-20 h-0.5 bg-critical" style={{ top: ypx(nowMin) }}><span className="absolute -start-1 -top-[3px] size-2 rounded-full bg-critical" /></span>
                    )}
                    {list.map(a => {
                      const st = minOf(a.est_at || a.starts_at);
                      const len = a.mode === 'queue' ? 14 : Math.max(15, (+new Date(a.ends_at) - +new Date(a.starts_at)) / 60_000);
                      const doc = doctors.find(d => d.id === a.doctor_id);
                      const movable = a.mode === 'slot' && ['booked', 'confirmed'].includes(a.status);
                      const colW = colsWrap.current ? (colsWrap.current.scrollWidth - 56) / cols.length : 120;
                      return (
                        <motion.button key={a.id} layout={reduce ? false : 'position'} onClick={() => setOpen(a)}
                          drag={movable ? (view === 'week' ? true : 'y') : false} dragMomentum={false} dragSnapToOrigin dragElastic={0}
                          whileDrag={{ scale: 1.03, zIndex: 40, boxShadow: '0 12px 28px -12px rgb(15 23 41 / .45)' }}
                          onDragEnd={(_, info) => startDrop(a, c, info.offset.y, Math.round((lang === 'ar' ? -info.offset.x : info.offset.x) / colW))}
                          title={`${a.patient || ''} · ${clock(a.est_at || a.starts_at, tz)} · ${(lang === 'en' && a.service_en) || a.service || ''}`}
                          className={cx('group absolute z-10 flex flex-col justify-center overflow-hidden rounded-[7px] border-s-[3px] px-1.5 text-start text-[11.5px] leading-tight',
                            a.status === 'done' ? 'bg-positive-soft text-positive-ink' : a.status === 'no_show' ? 'bg-critical-soft text-critical-ink line-through' :
                            a.status === 'arrived' ? 'bg-caution-soft text-caution' : a.status === 'in_visit' ? 'bg-accent text-white' : a.status === 'confirmed' ? 'bg-accent-soft text-accent-ink' : 'bg-sheet text-ink ring-1 ring-inset ring-control',
                            movable && 'cursor-grab active:cursor-grabbing')}
                          style={{ ...lane(a.doctor_id), top: ypx(st) + 1, height: Math.max(18, (len / 60) * HOUR_PX - 2), borderInlineStartColor: doc?.color || 'var(--color-accent)' }}>
                          <span className="flex items-center gap-1 font-medium"><span className="truncate">{a.queue_no ? `${a.queue_no} · ` : ''}{a.patient || a.ref_no}</span>
                            {movable && <GripVertical className="ms-auto size-3 shrink-0 opacity-0 group-hover:opacity-50" aria-hidden />}</span>
                          {len >= 45 && <span className="truncate opacity-75">{clock(a.est_at || a.starts_at, tz)} · {(lang === 'en' && a.service_en) || a.service}</span>}
                        </motion.button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <ApptDrawer appt={open} onClose={() => setOpen(null)} onChanged={refresh} />
      <Dialog open={!!drop} onClose={() => setDrop(null)} title={t('Move this booking?')}
        footer={<><Button variant="outline" onClick={() => setDrop(null)}>{t('Cancel')}</Button><Button variant="accent" busy={busy} onClick={confirmMove}>{t('Move it')}</Button></>}>
        {drop && (
          <div className="space-y-3">
            <p><b className="font-semibold"><bdi>{drop.a.patient}</bdi></b> {t('to')} <b className="font-semibold">{drop.label}</b></p>
            <p className="text-muted">{t('Now: {when}', { when: `${dayLabel(drop.a.est_at || drop.a.starts_at, tz, { weekday: 'long', day: 'numeric', month: 'short' })} · ${clock(drop.a.est_at || drop.a.starts_at, tz)}` })}</p>
            {drop.a.whatsapp && <Checkbox checked={tell} onChange={setTell} label={t('Tell the patient on WhatsApp')} />}
          </div>
        )}
      </Dialog>
    </div>
  );
}

function AgendaList({ days, appts, onOpen, tz }: { days: string[]; appts: ApptCard[]; onOpen: (a: ApptCard) => void; tz: string }) {
  const { t, lang } = useLang();
  const { doctors } = useClinic();
  return (
    <div className="space-y-4">
      {days.map(d => {
        const list = appts.filter(a => a.session_date === d).sort((x, y) => +new Date(x.est_at || x.starts_at) - +new Date(y.est_at || y.starts_at));
        return (
          <section key={d} className="card overflow-hidden">
            <h2 className="border-b border-rule bg-raised/60 px-4 py-2 text-[13px] font-semibold">{dayLabel(d, tz)} <span className="font-normal text-muted">· {t('{n} bookings', { n: list.length })}</span></h2>
            {list.length === 0 ? <p className="px-4 py-3 text-[13px] text-muted">{t('Nothing booked.')}</p> : (
              <ul className="divide-y divide-rule">
                {list.map(a => {
                  const doc = doctors.find(x => x.id === a.doctor_id);
                  return (
                    <li key={a.id}>
                      <button onClick={() => onOpen(a)} className="grid w-full grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-start hover:bg-raised">
                        <span className="text-[13px] font-semibold tabular-nums">{a.queue_no ? `#${a.queue_no}` : clock(a.est_at || a.starts_at, tz)}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13.5px] font-medium">{a.patient}</span>
                          <span className="flex items-center gap-1.5 truncate text-xs text-muted"><DocDot color={doc?.color} />{docName(doc, lang)} · <bdi>{(lang === 'en' && a.service_en) || a.service}</bdi></span>
                        </span>
                        <Pill tone={STATUS_TONE[a.status]}>{t(STATUS_LABEL[a.status])}</Pill>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
