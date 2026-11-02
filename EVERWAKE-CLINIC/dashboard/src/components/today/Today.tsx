'use client';
import { AlertTriangle, BellRing, Bot, CalendarOff, ChevronLeft, ChevronRight, Clock4, FileText, Hourglass, Pill as PillIcon, Stethoscope, TimerReset } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { docName, useClinic } from '@/lib/clinic-data';
import { okOrThrow } from '@/lib/codes';
import { clock, cx, dayLabel, money, timeAgo } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { useLive } from '@/lib/live';
import { sb } from '@/lib/supabase/client';
import type { Alert, ApptCard, DelayNotice, TodayBoard } from '@/lib/types';
import { useCached } from '@/lib/use-cached';
import { ApptDrawer, STATUS_LABEL } from '../appointment/ApptDrawer';
import { DocDot } from '../booking/pickers';
import { useShell } from '../shell/Shell';
import { Avatar, Button, Card, CountUp, Empty, PageTitle, Pill, Segmented, Skeleton, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';
import { GoLive } from './GoLive';
import { Ribbon, type RibbonRow } from './Ribbon';

const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Today answers one question: who is next, and is the day running on time?
export function Today() {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const shell = useShell();
  const { doctors } = useClinic();
  const tz = tenant.timezone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const [date, setDate] = useState(today);
  // a doctor sees their own day first; the desk sees everyone
  const [doctor, setDoctor] = useState<string>(tenant.doctor_id || 'all');
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<ApptCard | null>(null);

  const { data: b, refresh } = useCached<TodayBoard>(`today:${tenant.id}:${date}:${doctor}`, async () => {
    const { data, error } = await sb().rpc('today_board', { p_tenant: tenant.id, p_date: date, p_doctor: doctor === 'all' ? null : doctor });
    if (error) throw new Error(error.message);
    return data as TodayBoard;
  });
  useLive(['appointments', 'alerts', 'delay_notice_items'], () => { refresh(); });
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(i); }, []);

  const rows = useMemo<RibbonRow[]>(() => {
    if (!b) return [];
    const r: RibbonRow[] = b.sessions.map(s => ({
      key: s.doctor_id + s.location_id + s.starts_at, session: s, appointments: s.appointments,
      label: lang === 'en' ? s.doctor_en : s.doctor,
      sub: `${lang === 'en' ? s.location_en : s.location} · ${clock(s.starts_at, tz)}–${clock(s.ends_at, tz)}${s.mode === 'queue' ? ' · ' + t('queue') : ''}`
    }));
    if (b.outside.length) r.push({ key: 'outside', session: null, appointments: b.outside, label: t('Outside the schedule'), sub: t('{n} bookings', { n: b.outside.length }) });
    return r;
  }, [b, lang, tz, t]);

  const c = b?.counts;
  const isToday = date === today;
  const late = (b?.sessions || []).filter(s => s.delay_minutes > 0);
  const finding = !b ? '' : !c?.total ? t('No bookings yet.')
    : [t('{n} patients', { n: c.total }), c.arrived ? t('{n} waiting', { n: c.arrived }) : '', c.done ? t('{n} seen', { n: c.done }) : '',
       late.length ? late.map(s => t('{doc} is {n} min late', { doc: lang === 'en' ? s.doctor_en : s.doctor, n: s.delay_minutes })).join(' · ') : (isToday ? t('running on time') : '')]
      .filter(Boolean).join(' · ');

  const activeDocs = doctors.filter(d => d.is_active);
  return (
    <div className="space-y-5">
      <PageTitle
        title={<span className="flex items-center gap-2">
          {isToday ? t('Today') : dayLabel(date, tz, { weekday: 'long' })}
          <span className="text-[15px] font-normal text-muted">{dayLabel(date, tz, { day: 'numeric', month: 'long' })}</span>
        </span>}
        finding={finding}
        actions={<>
          <div className="flex items-center rounded-[8px] ring-1 ring-inset ring-border">
            <button onClick={() => setDate(d => addDays(d, -1))} className="press flex size-9 items-center justify-center rounded-s-[8px] text-muted hover:bg-raised" aria-label={t('Previous day')}><ChevronLeft className="size-4 rtl:rotate-180" /></button>
            <button onClick={() => setDate(today)} disabled={isToday} className="press h-9 px-2.5 text-[13px] font-medium disabled:text-faint">{t('Today')}</button>
            <button onClick={() => setDate(d => addDays(d, 1))} className="press flex size-9 items-center justify-center rounded-e-[8px] text-muted hover:bg-raised" aria-label={t('Next day')}><ChevronRight className="size-4 rtl:rotate-180" /></button>
          </div>
          <Button variant="outline" onClick={() => shell.runningLate(doctor !== 'all' ? doctor : undefined)}><TimerReset className="size-4" aria-hidden />{t('Running late')}</Button>
          <Button variant="ghost" onClick={() => shell.blockTime(doctor !== 'all' ? doctor : undefined)} className="max-sm:hidden"><CalendarOff className="size-4" aria-hidden />{t('Block time')}</Button>
        </>} />

      {tenant.status === 'onboarding' && <GoLive />}

      {activeDocs.length > 1 && (
        <div className="rail -mx-1 overflow-x-auto px-1">
          <Segmented label="today-doctor" value={doctor} onChange={setDoctor}
            options={[{ value: 'all', label: t('All doctors') }, ...activeDocs.map(d => ({ value: d.id, label: <span className="inline-flex items-center gap-1.5"><DocDot color={d.color} />{docName(d, lang)}</span> }))]} />
        </div>
      )}

      {/* the day at a glance: where every booking is, as one bar */}
      <DayBar board={b} />

      <Card pad={false} title={t('The day')} sub={b && b.sessions.length ? t('Tap a patient to check them in, move or cancel') : undefined}
        action={<Legend />}>
        {!b ? <div className="space-y-2 p-4"><Skeleton className="h-6" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          : rows.length ? <div className="px-3 pb-1 sm:px-4"><Ribbon rows={rows} now={now} tz={tz} onPick={setOpen} /></div>
          : <div className="p-4"><Empty action={<Link href="calendar" className="text-[13px] font-medium text-accent hover:underline">{t('Open the calendar')}</Link>}>
              {isToday ? t('No clinic sessions today.') : t('No clinic sessions on this day.')}
            </Empty></div>}
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <NextPatient board={b} onOpen={setOpen} onChanged={refresh} />
          <Delays delays={b?.delays || []} />
          <AgentToday list={b?.agent_today || []} tz={tz} onOpen={setOpen} />
        </div>
        <div className="min-w-0 space-y-5">
          <WaitingRoom list={b?.waiting_room} now={now} onOpen={setOpen} onChanged={refresh} />
          <Alerts list={b?.alerts || []} onChanged={refresh} />
          {isToday && (b?.tomorrow_unconfirmed || 0) > 0 && (
            <p className="flex items-start gap-2.5 rounded-[10px] bg-raised px-3.5 py-3 text-[13px] text-muted ring-1 ring-inset ring-border">
              <Clock4 className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />
              {t('{n} of tomorrow’s patients have not confirmed yet. Their reminder goes out this evening.', { n: b!.tomorrow_unconfirmed })}
            </p>
          )}
          {c && c.expected > 0 && (
            <div className="card flex items-center justify-between px-4 py-3 text-[13px]">
              <span className="text-muted">{t('Expected from today’s visits')}</span>
              <span className="font-semibold tabular-nums"><CountUp value={c.expected} format={v => money(v, tenant.currency_symbol)} /></span>
            </div>
          )}
        </div>
      </div>

      <ApptDrawer appt={open} onClose={() => setOpen(null)} onChanged={refresh} />
    </div>
  );
}

function Legend() {
  const { t } = useLang();
  const item = (cls: string, label: string) => <span className="inline-flex items-center gap-1.5"><span className={cx('size-2.5 rounded-[3px]', cls)} />{t(label)}</span>;
  return (
    <div className="hidden flex-wrap items-center gap-3 text-[11.5px] text-muted md:flex">
      {item('bg-sheet ring-1 ring-control', 'Booked')}{item('bg-accent-soft ring-1 ring-accent-track', 'Confirmed')}
      {item('bg-caution-soft ring-1 ring-caution-line', 'Waiting')}{item('bg-accent', 'With the doctor')}{item('bg-positive-soft', 'Done')}
    </div>
  );
}

// every booking of the day as one bar: done, with the doctor, waiting, confirmed, booked, did not come
function DayBar({ board }: { board?: TodayBoard }) {
  const { t } = useLang();
  if (!board) return <Skeleton className="h-11" />;
  const c = board.counts;
  const parts = [
    { k: 'done', n: c.done, cls: 'bg-positive', label: 'Done' },
    { k: 'in_visit', n: c.in_visit, cls: 'bg-accent', label: 'With the doctor' },
    { k: 'arrived', n: c.arrived, cls: 'bg-caution', label: 'Waiting' },
    { k: 'confirmed', n: c.confirmed, cls: 'bg-accent-track', label: 'Confirmed' },
    { k: 'booked', n: c.booked, cls: 'bg-control', label: 'Booked' },
    { k: 'no_show', n: c.no_show, cls: 'bg-critical', label: 'Did not come' }
  ];
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (!total) return null;
  return (
    <div className="space-y-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-rule" role="img" aria-label={parts.filter(p => p.n).map(p => `${t(p.label)} ${p.n}`).join(', ')}>
        {parts.filter(p => p.n).map((p, i) => (
          <span key={p.k} className={cx('c-bar h-full', p.cls, i > 0 && 'border-s-2 border-sheet')} style={{ width: `${(p.n / total) * 100}%`, animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
        {parts.filter(p => p.n).map(p => (
          <span key={p.k} className="inline-flex items-center gap-1.5"><span className={cx('size-2 rounded-full', p.cls)} />{t(p.label)} <b className="font-semibold tabular-nums text-ink"><CountUp value={p.n} /></b></span>
        ))}
        {c.by_agent > 0 && <span className="inline-flex items-center gap-1.5"><Bot className="size-3.5 text-faint" aria-hidden />{t('Booked by the assistant')} <b className="font-semibold tabular-nums text-ink">{c.by_agent}</b></span>}
        {c.new_patients > 0 && <span>{t('New patients')} <b className="font-semibold tabular-nums text-ink">{c.new_patients}</b></span>}
      </div>
    </div>
  );
}

function NextPatient({ board, onOpen, onChanged }: { board?: TodayBoard; onOpen: (a: ApptCard) => void; onChanged: () => void }) {
  const { tenant, base } = useTenant();
  const { t, lang } = useLang();
  const { busy, run } = useAction();
  const toast = useToast();
  const tz = tenant.timezone;
  if (!board) return <Skeleton className="h-48" />;
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
  const label = n.status === 'in_visit' ? t('With the doctor now') : n.status === 'arrived' ? t('Next in — waiting') : t('Next patient');
  const pre = Object.entries(n.pre_visit || {}).filter(([, v]) => v !== null && v !== '');
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.section key={n.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
        className={cx('card overflow-hidden', n.status === 'in_visit' && 'ring-1 ring-accent/30')}>
        <div className="flex flex-wrap items-start gap-4 p-4 sm:p-5">
          <Avatar name={n.patient} size={52} />
          <div className="min-w-0 flex-1">
            <p className={cx('text-[12px] font-medium', n.status === 'in_visit' ? 'text-accent' : n.status === 'arrived' ? 'text-caution' : 'text-muted')}>{label}</p>
            <button onClick={() => onOpen(n)} className="mt-0.5 block max-w-full truncate text-start text-[20px] font-semibold leading-tight hover:underline">{n.patient || n.ref_no}</button>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
              <span className="font-medium tabular-nums text-ink">{n.mode === 'queue' ? t('number {n}, about {t}', { n: n.queue_no, t: clock(at, tz) }) : clock(at, tz)}</span>
              <span>{(lang === 'en' && n.service_en) || n.service}</span>
              {(lang === 'en' ? n.age_en : n.age) && <span>{lang === 'en' ? n.age_en : n.age}</span>}
              {n.is_new ? <Pill tone="accent">{t('New patient')}</Pill> : n.visits_count ? <Pill>{t('Visit {n}', { n: n.visits_count + 1 })}</Pill> : null}
            </p>
          </div>
          <div className="flex shrink-0 gap-2 max-sm:w-full">
            {n.status === 'in_visit'
              ? <Button variant="positive" busy={busy} onClick={() => go('done', t('Visit done.'))} className="max-sm:flex-1">{t('Visit done')}</Button>
              : n.status === 'arrived'
                ? <Button variant="accent" busy={busy} onClick={() => go('in_visit', t('{name} is with the doctor.', { name: n.patient || '' }))} className="max-sm:flex-1"><Stethoscope className="size-4" aria-hidden />{t('Call in')}</Button>
                : <Button variant="accent" busy={busy} onClick={() => go('arrived', t('{name} is in the waiting room.', { name: n.patient || '' }))} className="max-sm:flex-1">{t('Arrived')}</Button>}
            {n.patient_id && <Link href={`${base}/patients/${n.patient_id}`} className="press inline-flex h-9 items-center rounded-[7px] px-3 text-sm font-medium ring-1 ring-inset ring-control hover:bg-raised max-sm:flex-1 max-sm:justify-center">{t('Open file')}</Link>}
          </div>
        </div>
        {(n.reason || n.allergies?.length || n.conditions?.length || n.medications?.length || n.last_visit || n.documents > 0 || pre.length > 0) && (
          <div className="grid gap-x-6 gap-y-3 border-t border-rule bg-raised/60 px-4 py-3.5 text-[13px] sm:grid-cols-2 sm:px-5">
            {n.reason && <p className="sm:col-span-2"><span className="text-muted">{t('Says')}: </span><bdi>“{n.reason}”</bdi></p>}
            {n.allergies && n.allergies.length > 0 && (
              <p className="flex flex-wrap items-center gap-1.5 sm:col-span-2">
                <AlertTriangle className="size-4 text-critical" aria-hidden /><span className="font-medium text-critical-ink">{t('Allergic to')}</span>
                {n.allergies.map(x => <span key={x} className="rounded-full bg-critical-soft px-2 py-0.5 text-[12px] font-medium text-critical-ink">{x}</span>)}
              </p>
            )}
            {n.conditions && n.conditions.length > 0 && <p><span className="text-muted">{t('Conditions')}: </span>{n.conditions.join('، ')}</p>}
            {n.medications && n.medications.length > 0 && <p><PillIcon className="me-1 inline size-3.5 text-faint" aria-hidden />{n.medications.join('، ')}</p>}
            {n.last_visit && <p><span className="text-muted">{t('Last visit')}: </span>{dayLabel(n.last_visit.date, tz, { day: 'numeric', month: 'short', year: 'numeric' })} · <bdi>{n.last_visit.service}</bdi></p>}
            {n.documents > 0 && <p><FileText className="me-1 inline size-3.5 text-faint" aria-hidden />{t('{n} new documents from WhatsApp', { n: n.documents })}</p>}
            {pre.map(([k, v]) => <p key={k}><span className="text-muted">{k}: </span>{String(v)}</p>)}
          </div>
        )}
      </motion.section>
    </AnimatePresence>
  );
}

function WaitingRoom({ list, now, onOpen, onChanged }: { list?: ApptCard[]; now: number; onOpen: (a: ApptCard) => void; onChanged: () => void }) {
  const { tenant } = useTenant();
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
    <Card pad={false} title={<span className="inline-flex items-center gap-2"><Hourglass className="size-4 text-caution" aria-hidden />{t('Waiting room')}</span>}
      action={list && list.length > 0 ? <span className="text-[13px] tabular-nums text-muted">{list.length}</span> : undefined}>
      {!list ? <div className="p-4"><Skeleton className="h-10" /></div>
        : list.length === 0 ? <p className="px-4 py-4 text-[13px] text-muted">{t('Nobody is waiting.')}</p>
        : <ul className="divide-y divide-rule">
            <AnimatePresence initial={false}>
              {list.map(a => {
                const waited = a.arrived_at ? Math.max(0, Math.round((now - +new Date(a.arrived_at)) / 60_000)) : a.waiting_minutes || 0;
                return (
                  <motion.li key={a.id} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }} className="overflow-hidden">
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <button onClick={() => onOpen(a)} className="min-w-0 flex-1 text-start">
                        <span className="block truncate text-[13.5px] font-medium">{a.patient}</span>
                        <span className="block truncate text-xs text-muted">{t('Booked {t}', { t: clock(a.est_at || a.starts_at, tenant.timezone) })}{a.queue_no ? ` · #${a.queue_no}` : ''}</span>
                      </button>
                      <span className={cx('shrink-0 text-[12.5px] font-medium tabular-nums', waited >= 30 ? 'text-critical' : waited >= 15 ? 'text-caution' : 'text-muted')}>
                        {t('{n} min', { n: waited })}
                      </span>
                      <Button size="sm" variant="outline" onClick={() => callIn(a)}>{t('Call in')}</Button>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>}
    </Card>
  );
}

const ALERT_ICON: Record<string, typeof BellRing> = { emergency: AlertTriangle, urgent: AlertTriangle, no_reply: TimerReset, at_risk: Clock4 };
function Alerts({ list, onChanged }: { list: Alert[]; onChanged: () => void }) {
  const { base } = useTenant();
  const { t } = useLang();
  const shown = list.filter(a => a.kind !== 'emergency').slice(0, 5);
  if (!shown.length) return null;
  const ack = async (id: number) => { await sb().rpc('acknowledge_alert', { p_alert: id, p_resolve: true }); onChanged(); };
  return (
    <Card pad={false} title={<span className="inline-flex items-center gap-2"><BellRing className="size-4 text-accent" aria-hidden />{t('Needs you')}</span>}
      action={<Link href={`${base}/alerts`} className="text-[13px] font-medium text-accent hover:underline">{t('All')}</Link>}>
      <ul className="divide-y divide-rule">
        <AnimatePresence initial={false}>
          {shown.map(a => {
            const Icon = ALERT_ICON[a.kind] || BellRing;
            return (
              <motion.li key={a.id} layout exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.2 }} className="flex items-start gap-3 px-4 py-3">
                <Icon className={cx('mt-0.5 size-4 shrink-0', a.severity === 'high' || a.severity === 'critical' ? 'text-critical' : 'text-caution')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium leading-snug"><bdi>{a.title}</bdi>{a.who ? <span className="font-normal text-muted"> · <bdi>{a.who}</bdi></span> : null}</p>
                  {a.body && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted"><bdi>{a.body}</bdi></p>}
                  <p className="mt-1 flex items-center gap-3 text-xs text-faint">
                    {timeAgo(a.created_at)}
                    {a.conversation_id && <Link href={`${base}/inbox?c=${a.conversation_id}`} className="font-medium text-accent hover:underline">{t('Chat')}</Link>}
                  </p>
                </div>
                <button onClick={() => ack(a.id)} className="press shrink-0 rounded-[6px] px-2 py-1 text-xs font-medium text-muted ring-1 ring-inset ring-border hover:bg-raised">{t('Done')}</button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </Card>
  );
}

const TALLY: { k: string; label: string; cls: string }[] = [
  { k: 'accepted', label: 'accepted', cls: 'bg-positive-soft text-positive-ink' },
  { k: 'changed', label: 'moved', cls: 'bg-accent-soft text-accent-ink' },
  { k: 'cancelled', label: 'cancelled', cls: 'bg-raised text-muted ring-1 ring-inset ring-border' },
  { k: 'sent', label: 'no answer yet', cls: 'bg-caution-soft text-caution' },
  { k: 'no_reply', label: 'did not answer', cls: 'bg-critical-soft text-critical-ink' },
  { k: 'skipped', label: 'to call', cls: 'bg-raised text-muted ring-1 ring-inset ring-border' }
];
function Delays({ delays }: { delays: DelayNotice[] }) {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const { doctors } = useClinic();
  if (!delays.length) return null;
  return (
    <Card pad={false} title={<span className="inline-flex items-center gap-2"><TimerReset className="size-4 text-caution" aria-hidden />{t('Delay notices')}</span>}
      sub={t('Patients’ answers come in as they reply')}>
      <ul className="divide-y divide-rule">
        {delays.map(d => (
          <li key={d.id} className="px-4 py-3">
            <p className="text-[13.5px]">
              <span className="font-medium"><bdi>{docName(doctors.find(x => x.id === d.doctor_id), lang) || d.doctor}</bdi> · {d.kind === 'delay' ? t('{n} min late', { n: d.minutes }) : t('session cancelled')}</span>
              <span className="ms-2 text-xs text-faint">{clock(d.at, tenant.timezone)} · {d.via === 'whatsapp' ? t('from WhatsApp') : t('from the dashboard')}{d.by ? <> · <bdi>{d.by}</bdi></> : null}</span>
            </p>
            {d.reason && <p className="mt-0.5 text-[12.5px] text-muted"><bdi>{d.reason}</bdi></p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TALLY.filter(x => (d.tally?.[x.k] || 0) > 0).map(x => (
                <span key={x.k} className={cx('c-pop inline-flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-medium', x.cls)}>
                  <b className="tabular-nums">{d.tally![x.k]}</b>{t(x.label)}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AgentToday({ list, tz, onOpen }: { list: ApptCard[]; tz: string; onOpen: (a: ApptCard) => void }) {
  const { t, lang } = useLang();
  if (!list.length) return null;
  return (
    <Card pad={false} title={<span className="inline-flex items-center gap-2"><Bot className="size-4 text-accent" aria-hidden />{t('Booked by the assistant today')}</span>}>
      <ul className="divide-y divide-rule">
        {list.map((a, i) => (
          <li key={a.id} className="c-rise" style={{ animationDelay: `${i * 30}ms` }}>
            <button onClick={() => onOpen(a)} className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-raised">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{a.patient}</span>
                <span className="block truncate text-xs text-muted">{(lang === 'en' && a.service_en) || a.service} · {dayLabel(a.est_at || a.starts_at, tz, { weekday: 'short', day: 'numeric', month: 'short' })} {clock(a.est_at || a.starts_at, tz)}</span>
              </span>
              <span className="shrink-0 text-xs text-faint">{timeAgo(a.created_at)}</span>
              <span className="sr-only">{t(STATUS_LABEL[a.status])}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

