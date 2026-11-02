'use client';
import { AlertTriangle, BellRing, CalendarOff, ChevronLeft, ChevronRight, Clock4, Hourglass, Mic, Plus, Stethoscope, TimerReset } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { docName, useClinic } from '@/lib/clinic-data';
import { okOrThrow } from '@/lib/codes';
import { clock, cx, dayLabel, timeAgo } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { sb } from '@/lib/supabase/client';
import type { Alert, ApptCard, DelayNotice, TodayBoard } from '@/lib/types';
import { useCached } from '@/lib/use-cached';
import { zonedParts } from '@/lib/zoned';
import { ApptDrawer } from '../appointment/ApptDrawer';
import { DocDot } from '../booking/pickers';
import { Mark } from '../mark';
import { useShell } from '../shell/Shell';
import { Avatar, Button, Card, CountUp, Drawer, Pill, Ring, Segmented, Skeleton, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';
import { GoLive } from './GoLive';
import { Timeline } from './Timeline';

const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const EASE = [0.23, 1, 0.32, 1] as const;

// Today answers one question: who is next, and is the day running on time?
export function Today() {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const shell = useShell();
  const { doctors } = useClinic();
  const tz = tenant.timezone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const [date, setDate] = useState(today);
  const [doctor, setDoctor] = useState<string>(tenant.doctor_id || 'all');
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<ApptCard | null>(null);
  const [list, setList] = useState<null | 'seen' | 'tomorrow' | 'whatsapp'>(null);

  const { data: b, refresh } = useCached<TodayBoard>(`today:${tenant.id}:${date}:${doctor}`, async () => {
    const { data, error } = await sb().rpc('today_board', { p_tenant: tenant.id, p_date: date, p_doctor: doctor === 'all' ? null : doctor });
    if (error) throw new Error(error.message);
    return data as TodayBoard;
  });
  // the next day's list, for "tomorrow confirmed"
  const { data: tomorrow, refresh: refreshTomorrow } = useCached<ApptCard[]>(`tomorrow:${tenant.id}:${date}:${doctor}`, async () => {
    const d = addDays(date, 1);
    const { data } = await sb().rpc('calendar_range', { p_tenant: tenant.id, p_from: d, p_to: d, p_doctor: doctor === 'all' ? null : doctor });
    return (((data as { appointments?: ApptCard[] } | null)?.appointments) || []).filter(a => !['cancelled', 'held'].includes(a.status));
  });
  useLive(['appointments', 'alerts', 'delay_notice_items'], () => { refresh(); refreshTomorrow(); });
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(i); }, []);

  const isToday = date === today;
  const all = useMemo(() => b ? [...b.sessions.flatMap(s => s.appointments), ...b.outside] : [], [b]);
  const c = b?.counts;
  const left = all.filter(a => ['booked', 'confirmed', 'arrived', 'in_visit'].includes(a.status)).length;
  const late = (b?.sessions || []).filter(s => s.delay_minutes > 0);
  const delay = useMemo(() => {
    const moved = all.filter(a => a.delay_minutes > 0 && a.original_starts_at).map(a => +new Date(a.original_starts_at!));
    return moved.length && late.length ? { at: Math.min(...moved), minutes: Math.max(...late.map(s => s.delay_minutes)) } : null;
  }, [all, late]);

  // "Good evening, Dr Mona" — the doctor's own name when a doctor is signed in
  const hour = zonedParts(new Date(now), tz).hour;
  const greet = hour < 12 ? t('Good morning') : hour < 17 ? t('Good afternoon') : t('Good evening');
  const meDoc = doctors.find(d => d.id === tenant.doctor_id);
  const who = meDoc ? docName(meDoc, lang) : (shell.me || '').split(/\s+/)[0];
  const next = b?.next;
  const finding = !b ? '' : !c?.total ? (isToday ? t('No bookings today yet.') : t('No bookings on this day.'))
    : [isToday ? t('{n} patients left', { n: left }) : t('{n} patients', { n: c.total }),
       next && isToday ? t('next at {t}', { t: clock(next.est_at || next.starts_at, tz) }) : '',
       late.length ? late.map(s => t('{doc} is {n} min late', { doc: lang === 'en' ? s.doctor_en : s.doctor, n: s.delay_minutes })).join(' · ') : (isToday ? t('running on time') : '')]
      .filter(Boolean).join(' · ');

  const docs = doctors.filter(d => d.is_active);
  const tomorrowConfirmed = (tomorrow || []).filter(a => a.status === 'confirmed').length;

  return (
    <div className="space-y-5">
      {tenant.status === 'onboarding' && <GoLive />}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,372px)]">
        <div className="min-w-0 space-y-5">
          {/* the greeting: the day in one sentence, and the two things to do from here */}
          <section className="card c-rise relative overflow-hidden p-6 sm:p-7">
            <div className="relative z-10 max-w-[560px]">
              <p className="flex items-center gap-1 text-[13px] text-faint">
                <button onClick={() => setDate(d => addDays(d, -1))} className="press -ms-1.5 rounded-full p-1 hover:bg-sunk/70 hover:text-ink" aria-label={t('Previous day')}><ChevronLeft className="size-4 rtl:rotate-180" /></button>
                <span className="tabular-nums">{dayLabel(date, tz)}</span>
                <button onClick={() => setDate(d => addDays(d, 1))} className="press rounded-full p-1 hover:bg-sunk/70 hover:text-ink" aria-label={t('Next day')}><ChevronRight className="size-4 rtl:rotate-180" /></button>
                {!isToday && <button onClick={() => setDate(today)} className="press ms-1 rounded-full px-2 py-0.5 text-[12px] font-medium text-gold-ink hover:bg-gold-wash">{t('Back to today')}</button>}
              </p>
              <h1 className="mt-2 text-[26px] font-semibold leading-9 tracking-[-0.015em]">{isToday ? <>{greet}{who ? <>{lang === 'ar' ? '، ' : ', '}<bdi>{who}</bdi></> : null}</> : dayLabel(date, tz, { weekday: 'long' })}</h1>
              <p className="mt-1 text-[15px] leading-6 text-muted">{finding || <span className="skeleton inline-block h-4 w-64 align-middle" />}</p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button onClick={() => shell.newBooking()}><Plus className="size-4" aria-hidden />{t('New booking')}</Button>
                <Button variant="outline" onClick={() => shell.runningLate(doctor !== 'all' ? doctor : undefined)}><TimerReset className="size-4" aria-hidden />{t('Running late')}</Button>
                <Button variant="ghost" onClick={() => shell.blockTime(doctor !== 'all' ? doctor : undefined)} className="max-sm:hidden"><CalendarOff className="size-4" aria-hidden />{t('Block time')}</Button>
              </div>
            </div>
            {/* the mark, large and quiet, drawn once */}
            <div aria-hidden className="pointer-events-none absolute -bottom-10 end-4 hidden opacity-90 sm:block">
              <span className="absolute inset-6 rounded-full bg-gold-wash" />
              <Mark size={190} tone="onLight" draw className="relative" />
            </div>
          </section>

          <NowCard board={b} onOpen={setOpen} onChanged={refresh} />

          {/* three shares of the day, one strip */}
          <section className="card c-rise grid grid-cols-3 divide-x divide-rule rtl:divide-x-reverse" style={{ animationDelay: '80ms' }}>
            <RingStat label={t('Seen today')} value={c?.done ?? 0} total={c?.total ?? 0} onClick={() => setList('seen')}
              sub={c ? t('of {n}', { n: c.total }) : ''} />
            <RingStat label={t('Tomorrow confirmed')} value={tomorrowConfirmed} total={(tomorrow || []).length} onClick={() => setList('tomorrow')}
              sub={tomorrow ? t('of {n}', { n: tomorrow.length }) : ''} />
            <RingStat label={t('Booked on WhatsApp')} value={c?.by_agent ?? 0} total={c?.total ?? 0} onClick={() => setList('whatsapp')}
              sub={c ? t('of {n}', { n: c.total }) : ''} />
          </section>

          {late.length > 0 && <DelayCard delays={b?.delays || []} />}

          <div className="grid items-stretch gap-5 md:grid-cols-2">
            <NeedsYou list={b?.alerts || []} onChanged={refresh} />
            <WaitingRoom list={b?.waiting_room} now={now} onOpen={setOpen} onChanged={refresh} />
          </div>
        </div>

        {/* the day, as a column */}
        <Card className="c-rise lg:sticky lg:top-20" style={{ animationDelay: '60ms' }} title={isToday ? t('Today') : dayLabel(date, tz, { weekday: 'long', day: 'numeric', month: 'short' })}
          sub={b ? t('{n} bookings', { n: all.filter(a => a.status !== 'cancelled').length }) : undefined}>
          {docs.length > 1 && (
            <div className="rail -mx-1 mb-3 overflow-x-auto px-1">
              <Segmented label="today-doctor" size="sm" value={doctor} onChange={setDoctor}
                options={[{ value: 'all', label: t('All') }, ...docs.map(d => ({ value: d.id, label: <><DocDot color={d.color} />{docName(d, lang).replace(/^(د\.|Dr\.?)\s*/, '')}</> }))]} />
            </div>
          )}
          {!b ? <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
            : <Timeline appts={all} now={isToday ? now : 0} tz={tz} delay={isToday ? delay : null} onPick={setOpen} showDoctor={doctor === 'all' && docs.length > 1} />}
        </Card>
      </div>

      <ApptDrawer appt={open} onClose={() => setOpen(null)} onChanged={refresh} />
      <ListDrawer kind={list} onClose={() => setList(null)} board={b} tomorrow={tomorrow || []} onOpen={a => { setList(null); setOpen(a); }} />
    </div>
  );
}

function RingStat({ label, value, total, sub, onClick }: { label: string; value: number; total: number; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="press group flex items-center gap-4 px-4 py-4 text-start first:rounded-s-[20px] last:rounded-e-[20px] hover:bg-raised sm:px-5">
      <Ring value={value} total={total} size={58} stroke={6} label={`${label}: ${value} / ${total}`}>
        <span className="text-[13px] font-semibold tabular-nums">{total ? Math.round((value / total) * 100) : 0}%</span>
      </Ring>
      <span className="hidden min-w-0 sm:block">
        <span className="block truncate text-[12.5px] text-faint">{label}</span>
        <span className="block text-[22px] font-semibold leading-7 tabular-nums"><CountUp value={value} /></span>
        <span className="block truncate text-[12px] text-muted">{sub}</span>
      </span>
      <span className="min-w-0 sm:hidden">
        <span className="block text-[17px] font-semibold tabular-nums"><CountUp value={value} /></span>
        <span className="block truncate text-[11.5px] text-faint">{label}</span>
      </span>
    </button>
  );
}

// the patient with the doctor now, or the next one: what not to miss, and the next step
function NowCard({ board, onOpen, onChanged }: { board?: TodayBoard; onOpen: (a: ApptCard) => void; onChanged: () => void }) {
  const { tenant, base, can } = useTenant();
  const { t, lang } = useLang();
  const { busy, run } = useAction();
  const toast = useToast();
  const tz = tenant.timezone;
  if (!board) return <Skeleton className="h-44 rounded-[20px]" />;
  const n = board.next;
  if (!n) return null;
  const at = n.est_at || n.starts_at;
  const go = async (status: string, said: string) => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('set_appointment_status', { p_appt: n.id, p_status: status, p_note: null, p_notify: false });
      if (error) throw new Error(error.message);
      return okOrThrow(data as { ok?: boolean; error?: string });
    });
    if (r) { toast(said); onChanged(); }
  };
  const state = n.status === 'in_visit' ? { tone: 'gold' as const, label: t('With the doctor') } : n.status === 'arrived' ? { tone: 'caution' as const, label: t('In the waiting room') } : { tone: 'neutral' as const, label: t('Next') };
  const pre = Object.entries(n.pre_visit || {}).filter(([, v]) => v !== null && v !== '');
  const facts = [
    n.reason ? { k: t('Says'), v: <bdi>“{n.reason}”</bdi> } : null,
    n.last_visit ? { k: t('Last visit'), v: <>{dayLabel(n.last_visit.date, tz, { day: 'numeric', month: 'short' })} · <bdi>{n.last_visit.service}</bdi></> } : null,
    n.conditions?.length ? { k: t('Conditions'), v: <bdi>{n.conditions.join('، ')}</bdi> } : null,
    n.medications?.length ? { k: t('Medicines'), v: <bdi>{n.medications.join('، ')}</bdi> } : null,
    n.documents > 0 ? { k: t('Files'), v: t('{n} new from WhatsApp', { n: n.documents }) } : null,
    ...pre.slice(0, 2).map(([k, v]) => ({ k, v: <bdi>{String(v)}</bdi> }))
  ].filter(Boolean).slice(0, 4) as { k: string; v: React.ReactNode }[];
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.section key={n.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
        transition={{ duration: 0.32, ease: EASE }} className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={n.patient} size={52} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => onOpen(n)} className="max-w-full truncate text-start text-[19px] font-semibold leading-7 hover:underline">{n.patient || n.ref_no}</button>
              <Pill tone={state.tone}>{state.label}</Pill>
              {n.is_new && <Pill tone="accent">{t('New patient')}</Pill>}
            </div>
            <p className="mt-0.5 flex flex-wrap gap-x-2 text-[13.5px] text-muted">
              <span className="font-medium tabular-nums text-ink">{n.mode === 'queue' ? t('number {n}, about {t}', { n: n.queue_no, t: clock(at, tz) }) : clock(at, tz)}</span>
              <bdi>{(lang === 'en' && n.service_en) || n.service}</bdi>
              {(lang === 'en' ? n.age_en : n.age) && <span>{lang === 'en' ? n.age_en : n.age}</span>}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 max-sm:w-full">
            {can.clinical && n.status !== 'booked' && n.status !== 'confirmed'
              ? <Link href={`${base}/visit/${n.id}`} className="press inline-flex h-10 items-center gap-1.5 rounded-full bg-gold px-4 text-sm font-semibold text-navy hover:bg-gold-bright max-sm:flex-1 max-sm:justify-center"><Mic className="size-4" aria-hidden />{t('Start visit')}</Link>
              : null}
            {n.status === 'in_visit'
              ? <Button variant="outline" busy={busy} onClick={() => go('done', t('Visit done.'))} className="max-sm:flex-1">{t('Visit done')}</Button>
              : n.status === 'arrived'
                ? <Button variant="outline" busy={busy} onClick={() => go('in_visit', t('{name} is with the doctor.', { name: n.patient || '' }))} className="max-sm:flex-1"><Stethoscope className="size-4" aria-hidden />{t('Call in')}</Button>
                : <Button busy={busy} onClick={() => go('arrived', t('{name} is in the waiting room.', { name: n.patient || '' }))} className="max-sm:flex-1">{t('Arrived')}</Button>}
          </div>
        </div>
        {n.allergies && n.allergies.length > 0 && (
          <p className="mt-4 flex flex-wrap items-center gap-1.5 rounded-xl bg-critical-soft px-3 py-2 text-[13px] text-critical-ink">
            <AlertTriangle className="size-4 shrink-0" aria-hidden /><b className="font-semibold">{t('Allergic to')}</b>
            {n.allergies.map(x => <span key={x} className="rounded-full bg-white/70 px-2 py-0.5 text-[12px] font-medium"><bdi>{x}</bdi></span>)}
          </p>
        )}
        {facts.length > 0 && (
          <dl className="mt-4 grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
            {facts.map(f => (
              <div key={f.k} className="min-w-0">
                <dt className="text-[12px] text-faint">{f.k}</dt>
                <dd className="truncate text-[13.5px]">{f.v}</dd>
              </div>
            ))}
          </dl>
        )}
      </motion.section>
    </AnimatePresence>
  );
}

const ALERT_ICON: Record<string, typeof BellRing> = { urgent: AlertTriangle, no_reply: TimerReset, at_risk: Clock4 };
function NeedsYou({ list, onChanged }: { list: Alert[]; onChanged: () => void }) {
  const { base } = useTenant();
  const { t } = useLang();
  const shown = list.filter(a => a.kind !== 'emergency');
  const ack = async (id: number) => { await sb().rpc('acknowledge_alert', { p_alert: id, p_resolve: true }); onChanged(); };
  return (
    <Card className="c-rise" style={{ animationDelay: '120ms' }} title={t('Needs you')} sub={shown.length ? t('{n} to look at', { n: shown.length }) : undefined}
      more={shown.length > 3 ? { href: `${base}/alerts` } : undefined}>
      {shown.length === 0 ? <p className="py-2 text-[13px] text-muted">{t('Nothing needs you. The assistant has it.')}</p> : (
        <ul className="-mx-2 space-y-0.5">
          <AnimatePresence initial={false}>
            {shown.slice(0, 3).map(a => {
              const Icon = ALERT_ICON[a.kind] || BellRing;
              return (
                <motion.li key={a.id} layout exit={{ opacity: 0, x: 12, transition: { duration: 0.16 } }} className="flex items-start gap-3 rounded-xl px-2 py-2">
                  <span className={cx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', a.severity === 'high' || a.severity === 'critical' ? 'bg-critical-soft text-critical' : 'bg-caution-soft text-caution')}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium"><bdi>{a.who || a.title}</bdi></p>
                    <p className="truncate text-[12.5px] text-muted"><bdi>{a.who ? a.title : a.body}</bdi> · {timeAgo(a.created_at)}</p>
                  </div>
                  {a.conversation_id
                    ? <Link href={`${base}/inbox?c=${a.conversation_id}`} className="press shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-gold-ink hover:bg-gold-wash">{t('Chat')}</Link>
                    : <button onClick={() => ack(a.id)} className="press shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-muted ring-1 ring-inset ring-border hover:bg-raised">{t('Done')}</button>}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </Card>
  );
}

function WaitingRoom({ list, now, onOpen, onChanged }: { list?: ApptCard[]; now: number; onOpen: (a: ApptCard) => void; onChanged: () => void }) {
  const { t } = useLang();
  const { run } = useAction();
  const toast = useToast();
  const callIn = async (a: ApptCard) => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('set_appointment_status', { p_appt: a.id, p_status: 'in_visit', p_note: null, p_notify: false });
      if (error) throw new Error(error.message);
      return okOrThrow(data as { ok?: boolean; error?: string });
    });
    if (r) { toast(t('{name} is with the doctor.', { name: a.patient || '' })); onChanged(); }
  };
  return (
    <Card className="c-rise" style={{ animationDelay: '160ms' }} title={t('Waiting room')} sub={list?.length ? t('{n} waiting', { n: list.length }) : undefined}>
      {!list ? <Skeleton className="h-16" /> : list.length === 0 ? <p className="py-2 text-[13px] text-muted">{t('Nobody is waiting.')}</p> : (
        <ul className="-mx-2 space-y-0.5">
          <AnimatePresence initial={false}>
            {list.slice(0, 3).map(a => {
              const waited = a.arrived_at ? Math.max(0, Math.round((now - +new Date(a.arrived_at)) / 60_000)) : a.waiting_minutes || 0;
              return (
                <motion.li key={a.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.24, ease: EASE }} className="flex items-center gap-3 rounded-xl px-2 py-2">
                  <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-full', waited >= 30 ? 'bg-critical-soft text-critical' : 'bg-caution-soft text-caution')}>
                    <Hourglass className="size-4" aria-hidden />
                  </span>
                  <button onClick={() => onOpen(a)} className="min-w-0 flex-1 text-start">
                    <span className="block truncate text-[13.5px] font-medium">{a.patient}</span>
                    <span className={cx('block text-[12.5px] tabular-nums', waited >= 30 ? 'text-critical' : 'text-muted')}>{t('waiting {n} min', { n: waited })}</span>
                  </button>
                  <Button size="sm" variant="outline" onClick={() => callIn(a)}>{t('Call in')}</Button>
                </motion.li>
              );
            })}
          </AnimatePresence>
          {list.length > 3 && <li className="px-2 pt-1 text-[12.5px] text-muted">{t('+{n} more', { n: list.length - 3 })}</li>}
        </ul>
      )}
    </Card>
  );
}

// the delay notice and the answers coming in, as one bar
const TALLY: { k: string; label: string; cls: string }[] = [
  { k: 'accepted', label: 'accepted', cls: 'bg-positive' }, { k: 'changed', label: 'moved', cls: 'bg-navy' },
  { k: 'cancelled', label: 'cancelled', cls: 'bg-control' }, { k: 'sent', label: 'no answer yet', cls: 'bg-caution' },
  { k: 'no_reply', label: 'did not answer', cls: 'bg-critical' }, { k: 'skipped', label: 'to call', cls: 'bg-faint/50' }
];
function DelayCard({ delays }: { delays: DelayNotice[] }) {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const { doctors } = useClinic();
  const d = delays.find(x => x.kind === 'delay');
  if (!d) return null;
  const parts = TALLY.map(x => ({ ...x, n: d.tally?.[x.k] || 0 })).filter(x => x.n);
  const total = parts.reduce((s, x) => s + x.n, 0);
  return (
    <Card className="c-rise" title={<><bdi>{docName(doctors.find(x => x.id === d.doctor_id), lang) || d.doctor}</bdi> · {t('{n} min late', { n: d.minutes })}</>}
      sub={`${clock(d.at, tenant.timezone)} · ${d.via === 'whatsapp' ? t('from WhatsApp') : t('from the dashboard')}`}>
      {total > 0 && (
        <>
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map(p => `${t(p.label)} ${p.n}`).join(', ')}>
            {parts.map((p, i) => <span key={p.k} className={cx('c-bar h-full first:rounded-s-full last:rounded-e-full', p.cls)} style={{ width: `${(p.n / total) * 100}%`, animationDelay: `${i * 70}ms` }} />)}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
            {parts.map(p => <span key={p.k} className="inline-flex items-center gap-1.5"><span className={cx('size-2 rounded-full', p.cls)} /><b className="font-semibold tabular-nums text-ink">{p.n}</b>{t(p.label)}</span>)}
          </div>
        </>
      )}
      {d.reason && <p className="mt-2.5 text-[12.5px] text-faint"><bdi>{d.reason}</bdi></p>}
    </Card>
  );
}

// the patients behind each ring, one tap away
function ListDrawer({ kind, onClose, board, tomorrow, onOpen }:
  { kind: null | 'seen' | 'tomorrow' | 'whatsapp'; onClose: () => void; board?: TodayBoard; tomorrow: ApptCard[]; onOpen: (a: ApptCard) => void }) {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const all = board ? [...board.sessions.flatMap(s => s.appointments), ...board.outside] : [];
  const list = kind === 'seen' ? all.filter(a => a.status === 'done')
    : kind === 'tomorrow' ? [...tomorrow].sort((a, b) => Number(a.status === 'confirmed') - Number(b.status === 'confirmed'))
    : kind === 'whatsapp' ? all.filter(a => a.source === 'whatsapp' && a.status !== 'cancelled') : [];
  const title = kind === 'seen' ? t('Seen today') : kind === 'tomorrow' ? t('Tomorrow') : t('Booked on WhatsApp');
  return (
    <Drawer open={!!kind} onClose={onClose} title={title} width="max-w-[440px]">
      {list.length === 0 ? <p className="text-[13px] text-muted">{t('Nobody here yet.')}</p> : (
        <ul className="-mx-2 space-y-0.5">
          {list.map((a, i) => (
            <li key={a.id} className="c-rise" style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
              <button onClick={() => onOpen(a)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-start hover:bg-raised">
                <Avatar name={a.patient} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{a.patient}</span>
                  <span className="block truncate text-[12.5px] text-muted">{clock(a.est_at || a.starts_at, tenant.timezone)} · <bdi>{(lang === 'en' && a.service_en) || a.service}</bdi></span>
                </span>
                {kind === 'tomorrow' && <Pill tone={a.status === 'confirmed' ? 'positive' : 'caution'}>{t(a.status === 'confirmed' ? 'Confirmed' : 'Not confirmed')}</Pill>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

