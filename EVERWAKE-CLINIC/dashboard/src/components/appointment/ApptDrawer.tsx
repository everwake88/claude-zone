'use client';
import { AlertTriangle, CalendarClock, Check, FileText, MessageCircle, Phone, UserX, X as XIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { docName, placeName, useClinic } from '@/lib/clinic-data';
import { okOrThrow } from '@/lib/codes';
import { clock, cx, dayLabel, phone as fmtPhone, timeAgo } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ping } from '@/lib/outbox-client';
import { sb } from '@/lib/supabase/client';
import type { ApptCard, ApptStatus, Slot } from '@/lib/types';
import { SlotPicker } from '../booking/SlotPicker';
import { Avatar, Button, Checkbox, Dialog, Drawer, Field, Pill, Textarea, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';

export const STATUS_LABEL: Record<ApptStatus, string> = {
  held: 'Being booked', booked: 'Booked', confirmed: 'Confirmed', arrived: 'In the waiting room', in_visit: 'With the doctor',
  done: 'Done', no_show: 'Did not come', cancelled: 'Cancelled'
};
export const STATUS_TONE: Record<ApptStatus, 'neutral' | 'positive' | 'caution' | 'critical' | 'accent'> = {
  held: 'neutral', booked: 'neutral', confirmed: 'accent', arrived: 'caution', in_visit: 'accent', done: 'positive', no_show: 'critical', cancelled: 'neutral'
};
const SOURCE: Record<string, string> = { whatsapp: 'WhatsApp assistant', dashboard: 'The desk', phone: 'By phone', walk_in: 'Walked in', web: 'Website' };
const DELAY_REPLY: Record<string, string> = { sent: 'Told about the delay — no answer yet', accepted: 'Accepted the new time', changed: 'Moved to another time',
  cancelled: 'Cancelled after the delay notice', no_reply: 'Did not answer the delay notice', skipped: 'No WhatsApp — call about the delay' };

const STEPS: ApptStatus[] = ['booked', 'confirmed', 'arrived', 'in_visit', 'done'];

// One appointment: who, when, why, and the one next step for the desk (confirmed → arrived → with
// the doctor → done), plus moving it, a no-show or cancelling it. Today and the calendar both open it.
export function ApptDrawer({ appt, onClose, onChanged }: { appt: ApptCard | null; onClose: () => void; onChanged?: () => void }) {
  const { tenant, base } = useTenant();
  const { t, lang } = useLang();
  const { doctors, locations } = useClinic();
  const { busy, run } = useAction();
  const toast = useToast();
  const [a, setA] = useState<ApptCard | null>(appt);
  const [moving, setMoving] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [tell, setTell] = useState(true);
  const [cancel, setCancel] = useState(false);
  const [why, setWhy] = useState('');

  useEffect(() => { if (appt) { setA(appt); setMoving(false); setSlot(null); setTell(true); setCancel(false); setWhy(''); } }, [appt]);
  if (!a) return <Drawer open={false} onClose={onClose} title="">{null}</Drawer>;

  const tz = tenant.timezone;
  const at = a.est_at || a.starts_at;
  const doc = doctors.find(d => d.id === a.doctor_id);
  const loc = locations.find(l => l.id === a.location_id);
  const live = ['booked', 'confirmed', 'arrived', 'in_visit'].includes(a.status);

  const set = async (status: string, done?: string, notify = false, note?: string) => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('set_appointment_status', { p_appt: a.id, p_status: status, p_note: note || null, p_notify: notify });
      if (error) throw new Error(error.message);
      return okOrThrow(data as { ok?: boolean; error?: string; appointment?: ApptCard });
    }, done);
    if (r) {
      if (r.appointment) setA({ ...a, ...r.appointment });
      if (notify) ping();
      onChanged?.();
    }
    return r;
  };
  const undo = (prev: ApptStatus) => ({ label: t('Undo'), run: () => { set(prev); } });
  const step = async (status: ApptStatus, said: string) => {
    const prev = a.status;
    const r = await set(status);
    if (r) toast(said, 'positive', undo(prev));
  };
  const move = async () => {
    if (!slot) return;
    const r = await run(async () => {
      const { data, error } = await sb().rpc('move_appointment', { p_appt: a.id, p: { starts_at: slot.kind === 'slot' ? slot.starts_at : null, date: slot.date,
        kind: slot.kind, location_id: slot.location_id, notify: tell } });
      if (error) throw new Error(error.message);
      return okOrThrow(data as { ok?: boolean; error?: string });
    }, tell ? t('Moved. The patient is being told.') : t('Moved.'));
    if (r) { if (tell) ping(); onChanged?.(); onClose(); }
  };
  const doCancel = async () => {
    const r = await set('cancelled', tell ? t('Cancelled. The patient is being told.') : t('Cancelled.'), tell, why);
    if (r) { setCancel(false); onClose(); }
  };

  // the one next step, by where the visit is
  const next: { status: ApptStatus; label: string; said: string } | null =
    a.status === 'booked' || a.status === 'confirmed' ? { status: 'arrived', label: t('Arrived'), said: t('{name} is in the waiting room.', { name: a.patient || '' }) }
    : a.status === 'arrived' ? { status: 'in_visit', label: t('Call in'), said: t('{name} is with the doctor.', { name: a.patient || '' }) }
    : a.status === 'in_visit' ? { status: 'done', label: t('Visit done'), said: t('Visit done.') } : null;

  return (
    <>
      <Drawer open={!!appt} onClose={onClose} title={<span className="flex items-center gap-2">{t('Appointment')} <span className="text-[13px] font-normal text-muted tabular-nums" dir="ltr">{a.ref_no}</span></span>}
        footer={moving ? <>
          <Button variant="outline" onClick={() => setMoving(false)}>{t('Back')}</Button>
          <Button variant="accent" busy={busy} disabled={!slot} onClick={move}>{t('Move it')}</Button>
        </> : live ? <>
          {a.status === 'booked' && <Button variant="outline" busy={busy} onClick={() => step('confirmed', t('Marked as confirmed.'))}><Check className="size-4" aria-hidden />{t('Confirmed by phone')}</Button>}
          {next && <Button variant="accent" busy={busy} onClick={() => step(next.status, next.said)}>{next.label}</Button>}
        </> : (a.status === 'done' || a.status === 'no_show') ? <Button variant="outline" busy={busy} onClick={() => set(a.status === 'done' ? 'in_visit' : 'booked', t('Undone.'))}>{t('Undo')}</Button> : undefined}>
        {moving ? (
          <div className="space-y-4">
            <p className="text-[13px] text-muted">{t('Now: {when}', { when: `${dayLabel(at, tz)} · ${clock(at, tz)}` })}</p>
            <SlotPicker query={{ doctor_id: a.doctor_id, service_id: a.service_id, patient_id: a.patient_id, ignore_appointment: a.id }} value={slot} onChange={setSlot} layout="mv" />
            {a.whatsapp && <Checkbox checked={tell} onChange={setTell} label={t('Tell the patient on WhatsApp')} />}
          </div>
        ) : (
          <div className="space-y-5">
            {/* who */}
            <div className="flex items-start gap-3">
              <Avatar name={a.patient} size={44} />
              <div className="min-w-0 flex-1">
                {a.patient_id
                  ? <Link href={`${base}/patients/${a.patient_id}`} className="block truncate text-[17px] font-semibold hover:underline">{a.patient || t('Patient')}</Link>
                  : <p className="truncate text-[17px] font-semibold">{a.patient || t('Patient')}</p>}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
                  {(lang === 'en' ? a.age_en : a.age) && <span>{lang === 'en' ? a.age_en : a.age}</span>}
                  {a.sex && <span>{t(a.sex === 'female' ? 'Female' : 'Male')}</span>}
                  {a.file_no && <span className="tabular-nums">#{a.file_no}</span>}
                  {a.is_new && <Pill tone="accent">{t('New patient')}</Pill>}
                  {a.is_follow_up && <Pill>{t('Follow-up')}</Pill>}
                  {(a.no_show_count || 0) > 0 && <Pill tone="caution">{t('Missed {n} before', { n: a.no_show_count })}</Pill>}
                </p>
              </div>
            </div>
            {a.allergies && a.allergies.length > 0 && (
              <p className="flex flex-wrap items-center gap-1.5 rounded-[9px] bg-critical-soft px-3 py-2 text-[13px] text-critical-ink">
                <AlertTriangle className="size-4 shrink-0" aria-hidden /><b className="font-semibold">{t('Allergic to')}</b>{a.allergies.join('، ')}
              </p>
            )}

            {/* where the visit is */}
            {a.status !== 'cancelled' && a.status !== 'no_show' ? (
              <ol className="flex items-center gap-1" aria-label={t('Progress')}>
                {STEPS.map((s, i) => {
                  const reached = STEPS.indexOf(a.status) >= i;
                  return (
                    <li key={s} className="flex-1">
                      <span className={cx('block h-1.5 rounded-full transition-colors duration-300', reached ? (a.status === 'done' ? 'bg-positive' : 'bg-accent') : 'bg-rule')} />
                      <span className={cx('mt-1 block truncate text-[11px]', s === a.status ? 'font-medium text-ink' : 'text-faint')}>{t(STATUS_LABEL[s])}</span>
                    </li>
                  );
                })}
              </ol>
            ) : <Pill tone={STATUS_TONE[a.status]}>{t(STATUS_LABEL[a.status])}</Pill>}

            {/* when, with whom, for what */}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-[13.5px]">
              <dt className="text-muted">{t('When')}</dt>
              <dd>
                <span className="font-medium">{dayLabel(at, tz)} · {a.mode === 'queue' ? t('number {n}, about {t}', { n: a.queue_no, t: clock(at, tz) }) : clock(at, tz)}</span>
                {a.delay_minutes > 0 && a.original_starts_at && <span className="ms-2 text-caution">{t('was {t}', { t: clock(a.original_starts_at, tz) })}</span>}
              </dd>
              <dt className="text-muted">{t('Doctor')}</dt><dd>{docName(doc, lang)}</dd>
              <dt className="text-muted">{t('Where')}</dt><dd>{placeName(loc, lang)}{a.resource ? ` · ${a.resource}` : ''}</dd>
              <dt className="text-muted">{t('For')}</dt><dd>{(lang === 'en' && a.service_en) || a.service || '—'}{a.price_text ? <span className="text-muted"> · {a.price_text}</span> : null}</dd>
              <dt className="text-muted">{t('Booked')}</dt><dd>{t(SOURCE[a.source] || a.source)}{a.created_at ? <span className="text-muted"> · {timeAgo(a.created_at)}</span> : null}</dd>
              {a.delay_reply && <><dt className="text-muted">{t('Delay')}</dt><dd className={a.delay_reply === 'accepted' ? 'text-positive' : 'text-caution'}>{t(DELAY_REPLY[a.delay_reply] || a.delay_reply)}</dd></>}
            </dl>
            {a.reason && <blockquote className="rounded-[9px] bg-raised px-3 py-2.5 text-[13.5px] leading-relaxed" dir="auto">“{a.reason}”</blockquote>}
            {a.staff_notes && <p className="text-[13px] text-muted"><FileText className="me-1 inline size-3.5" aria-hidden />{a.staff_notes}</p>}

            {/* reach them */}
            <div className="flex flex-wrap gap-2">
              {a.conversation_id && <Link href={`${base}/inbox?c=${a.conversation_id}`} className="press inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] ring-1 ring-inset ring-border hover:bg-raised"><MessageCircle className="size-4 text-positive" aria-hidden />{t('Chat')}</Link>}
              {a.phone && <a href={`tel:+${a.phone}`} className="press inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] ring-1 ring-inset ring-border hover:bg-raised"><Phone className="size-4 text-muted" aria-hidden /><bdi dir="ltr">{fmtPhone(a.phone)}</bdi></a>}
            </div>

            {(a.status === 'booked' || a.status === 'confirmed') && (
              <div className="flex flex-wrap gap-2 border-t border-rule pt-4">
                <Button variant="outline" size="sm" onClick={() => setMoving(true)}><CalendarClock className="size-4" aria-hidden />{t('Move')}</Button>
                <Button variant="ghost" size="sm" onClick={() => step('no_show', t('Marked as did not come.'))}><UserX className="size-4" aria-hidden />{t('Did not come')}</Button>
                <Button variant="ghost" size="sm" className="text-critical" onClick={() => setCancel(true)}><XIcon className="size-4" aria-hidden />{t('Cancel')}</Button>
              </div>
            )}
          </div>
        )}
      </Drawer>

      <Dialog open={cancel} onClose={() => setCancel(false)} tone="critical" title={t('Cancel this appointment?')}
        footer={<>
          <Button variant="outline" onClick={() => setCancel(false)}>{t('Keep it')}</Button>
          <Button variant="danger" busy={busy} onClick={doCancel}>{t('Cancel it')}</Button>
        </>}>
        <div className="space-y-3">
          <p className="text-muted">{a.patient} · {dayLabel(at, tz)} · {clock(at, tz)}</p>
          <Field label={t('Reason (optional)')}><Textarea rows={2} value={why} onChange={e => setWhy(e.target.value)} /></Field>
          {a.whatsapp && <Checkbox checked={tell} onChange={setTell} label={t('Tell the patient on WhatsApp, with a link to book again')} />}
        </div>
      </Dialog>
    </>
  );
}
