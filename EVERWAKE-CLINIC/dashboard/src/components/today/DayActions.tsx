'use client';
import { ArrowRight, MessageCircle, PhoneOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClinic } from '@/lib/clinic-data';
import { okOrThrow } from '@/lib/codes';
import { cx, hhmm } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ping } from '@/lib/outbox-client';
import { sb } from '@/lib/supabase/client';
import { DoctorPick } from '../booking/pickers';
import { Button, Dialog, Drawer, Field, Input, Segmented, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';

interface DelayItem { appointment_id: number; ref_no: string; patient: string | null; old_time: string; new_time: string; queue_no: number | null; whatsapp: boolean }
interface DelayPreview { ok: boolean; error?: string; count: number; minutes: number; items: DelayItem[]; doctor: string }

const to12 = (hm: string, lang: 'ar' | 'en') => {
  const [h, m] = hm.split(':').map(Number);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? (lang === 'ar' ? 'ص' : 'am') : (lang === 'ar' ? 'م' : 'pm')}`;
};

// "I'm running late": how many minutes, then who will hear and their new time, then send.
// Each patient can accept, pick another time or cancel on WhatsApp; their answers come back to Today.
export function RunningLate({ open, onClose, doctorId }: { open: boolean; onClose: () => void; doctorId?: string }) {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const { doctors } = useClinic();
  const { busy, run } = useAction();
  const toast = useToast();
  const [doctor, setDoctor] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(20);
  const [custom, setCustom] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<DelayPreview | null>(null);

  useEffect(() => {
    if (!open) return;
    setDoctor(doctorId || doctors.find(d => d.is_active)?.id || null);
    setMinutes(20); setCustom(''); setReason(''); setPreview(null);
  }, [open, doctorId, doctors]);
  const mins = custom ? Number(custom.replace(/\D/g, '')) || 0 : minutes;

  const ask = (send: boolean) => run(async () => {
    const { data, error } = await sb().rpc('dashboard_delay', { p_tenant: tenant.id, p: { doctor_id: doctor, minutes: mins, reason: reason || null, preview: !send } });
    if (error) throw new Error(error.message);
    return okOrThrow(data as DelayPreview & { messaged?: number });
  });
  const look = async () => { const r = await ask(false); if (r) setPreview(r); };
  const send = async () => {
    const r = await ask(true);
    if (!r) return;
    ping();
    onClose();
    toast(r.messaged ? t('Telling {n} patients their new time. Their answers will show on Today.', { n: r.messaged }) : t('Today’s times moved by {m} min.', { m: mins }));
  };
  const valid = !!doctor && mins >= 5 && mins <= 240;
  const onWa = preview?.items.filter(i => i.whatsapp).length || 0;

  return (
    <Dialog open={open} onClose={onClose} title={preview ? t('Who will be told') : t('Running late')}
      footer={preview ? <>
        <Button variant="outline" onClick={() => setPreview(null)}>{t('Back')}</Button>
        <Button variant="accent" busy={busy} disabled={!preview.count} onClick={send}>
          {onWa ? t('Tell {n} patients', { n: onWa }) : t('Move the times')}
        </Button>
      </> : <>
        <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="accent" busy={busy} disabled={!valid} onClick={look}>{t('See who is affected')}</Button>
      </>}>
      {!preview ? (
        <div className="space-y-4">
          {doctors.filter(d => d.is_active).length > 1 && <Field label={t('Doctor')}><DoctorPick doctors={doctors} value={doctor} onChange={setDoctor} layout="late-doc" /></Field>}
          <Field label={t('How late')}>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented label="late-min" value={custom ? 'x' : String(minutes)} onChange={v => { if (v !== 'x') { setMinutes(Number(v)); setCustom(''); } }}
                options={[10, 15, 20, 30, 45, 60].map(m => ({ value: String(m), label: <span className="tabular-nums">{m}</span> }))} />
              <Input inputMode="numeric" value={custom} onChange={e => setCustom(e.target.value)} placeholder={t('other')} aria-label={t('Other number of minutes')} className="!w-20" />
              <span className="text-[13px] text-muted">{t('minutes')}</span>
            </div>
          </Field>
          <Field label={t('Reason (optional — patients see it)')}>
            <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="عملية طارئة في المستشفى" />
          </Field>
          <p className="text-[13px] leading-relaxed text-muted">{t('Everyone booked with this doctor later today moves by the same minutes. Each patient can accept, pick another time or cancel; anyone who does not answer gets one more message, sooner for those whose time is close.')}</p>
        </div>
      ) : preview.count === 0 ? (
        <p className="text-muted">{t('Nobody is booked later today, so nobody needs to be told.')}</p>
      ) : (
        <div className="-mx-1 max-h-[46vh] space-y-1 overflow-y-auto px-1">
          <p className="mb-2 text-[13px] text-muted">{t('{n} patients · every time moves {m} min later', { n: preview.count, m: preview.minutes })}</p>
          {preview.items.map((it, i) => (
            <div key={it.appointment_id} style={{ animationDelay: `${Math.min(i, 10) * 35}ms` }}
              className="c-rise flex items-center gap-3 rounded-[8px] px-2.5 py-2 ring-1 ring-inset ring-border">
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{it.patient || it.ref_no}{it.queue_no ? <span className="ms-1.5 text-xs font-normal text-muted">#{it.queue_no}</span> : null}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums">
                <s className="text-faint">{to12(it.old_time, lang)}</s>
                <ArrowRight className="size-3.5 text-faint rtl:rotate-180" aria-hidden />
                <b className="font-semibold text-caution">{to12(it.new_time, lang)}</b>
              </span>
              {it.whatsapp
                ? <MessageCircle className="size-4 shrink-0 text-positive" aria-label={t('Will get a WhatsApp message')} />
                : <PhoneOff className="size-4 shrink-0 text-faint" aria-label={t('No WhatsApp — call them')} />}
            </div>
          ))}
          {preview.items.some(i => !i.whatsapp) && <p className="pt-1 text-xs text-muted">{t('Patients without WhatsApp are moved too; call them.')}</p>}
        </div>
      )}
    </Dialog>
  );
}

// Time off: a few hours or whole days. Nothing new is booked inside; bookings already there are counted
// so the desk can decide about them.
export function BlockTime({ open, onClose, doctorId }: { open: boolean; onClose: () => void; doctorId?: string }) {
  const { tenant } = useTenant();
  const { t } = useLang();
  const { doctors, refresh } = useClinic();
  const { busy, run } = useAction();
  const toast = useToast();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tenant.timezone }).format(new Date());
  const [doctor, setDoctor] = useState<string | null>(null);
  const [kind, setKind] = useState<'hours' | 'days'>('hours');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [fromT, setFromT] = useState('');
  const [toT, setToT] = useState('');
  const [reason, setReason] = useState('');
  const [inside, setInside] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setDoctor(doctorId || doctors.find(d => d.is_active)?.id || null);
    setKind('hours'); setFrom(today); setTo(today); setReason(''); setInside(null);
    const now = hhmm(new Date().toISOString(), tenant.timezone);
    setFromT(now); setToT(`${String(Math.min(23, Number(now.slice(0, 2)) + 2)).padStart(2, '0')}:${now.slice(3)}`);
  }, [open, doctorId, doctors, today, tenant.timezone]);

  const params = () => ({ doctor_id: doctor, date: from, to_date: kind === 'days' ? to : from,
    from_time: kind === 'hours' ? fromT : null, to_time: kind === 'hours' ? toT : null, reason: reason || null });
  useEffect(() => {
    if (!open || !doctor) return;
    const timer = setTimeout(async () => {
      const { data } = await sb().rpc('dashboard_block_time', { p_tenant: tenant.id, p: { ...params(), preview: true } });
      setInside((data as { bookings_inside?: number } | null)?.bookings_inside ?? null);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doctor, kind, from, to, fromT, toT, tenant.id]);

  const save = async () => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('dashboard_block_time', { p_tenant: tenant.id, p: params() });
      if (error) throw new Error(error.message);
      return okOrThrow(data as { ok?: boolean; error?: string; bookings_inside?: number });
    });
    if (r) { onClose(); refresh(); toast(t('Blocked. Nothing new will be booked in that time.')); }
  };

  return (
    <Drawer open={open} onClose={onClose} title={t('Block time')} width="max-w-[440px]"
      footer={<>
        <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="accent" busy={busy} disabled={!doctor} onClick={save}>{t('Block it')}</Button>
      </>}>
      <div className="space-y-4">
        {doctors.filter(d => d.is_active).length > 1 && <Field label={t('Doctor')}><DoctorPick doctors={doctors} value={doctor} onChange={setDoctor} layout="block-doc" /></Field>}
        <Segmented label="block-kind" value={kind} onChange={setKind} options={[{ value: 'hours', label: t('A few hours') }, { value: 'days', label: t('Whole days') }]} />
        <div className="grid grid-cols-2 gap-3">
          <Field label={kind === 'days' ? t('From') : t('Day')}><Input type="date" value={from} min={today} onChange={e => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} /></Field>
          {kind === 'days'
            ? <Field label={t('To')}><Input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></Field>
            : <div className="grid grid-cols-2 gap-2">
                <Field label={t('From')}><Input type="time" value={fromT} onChange={e => setFromT(e.target.value)} /></Field>
                <Field label={t('To')}><Input type="time" value={toT} onChange={e => setToT(e.target.value)} /></Field>
              </div>}
        </div>
        <Field label={t('Reason (only your team sees it)')}><Input value={reason} onChange={e => setReason(e.target.value)} placeholder={t('Conference, travel…')} /></Field>
        {inside !== null && (
          <p className={cx('c-fade rounded-[9px] px-3 py-2.5 text-[13px]', inside ? 'bg-caution-soft text-caution' : 'bg-raised text-muted')}>
            {inside ? t('{n} bookings are already inside this time. They stay until you move or cancel them.', { n: inside }) : t('No bookings inside this time.')}
          </p>
        )}
      </div>
    </Drawer>
  );
}
