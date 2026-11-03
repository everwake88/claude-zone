'use client';
import { CalendarPlus, CheckCircle2, Copy, MessageCircle, Printer } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dayLabel } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ping } from '@/lib/outbox-client';
import { sb } from '@/lib/supabase/client';
import { Button, Card, Field, Input, Segmented, Textarea, useAction, useToast } from '../ui';
import { Mark } from '../mark';
import { useShell } from '../shell/Shell';
import { useTenant } from '../tenant';
import type { FormTemplate } from '../patients/types';
import type { RxLine } from './Findings';
import type { Values } from './FormCards';
import type { Run, VisitContext } from './types';

type Tab = 'note' | 'rx' | 'patient' | 'letters';
export interface Note { cc: string; assessment: string; plan: string; follow: string }

const shown = (v: unknown, yes: string, no: string) => (Array.isArray(v) ? v.join('، ') : v === true ? yes : v === false ? no : String(v));

// the note as SOAP: the AI's when it listened, else built from the form
export function composeSoap(tpl: FormTemplate | null, values: Values, n: Note, rx: RxLine[], lang: 'ar' | 'en', t: (k: string, v?: Record<string, string | number>) => string) {
  const lines = (pick: (k: string) => boolean) => (tpl?.schema.sections || []).filter(s => pick(s.key)).flatMap(s => s.fields.map(f => {
    const v = values[`${s.key}.${f.key}`];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) ? null : `${lang === 'en' ? f.label_en : f.label_ar}: ${shown(v, t('yes'), t('no'))}`;
  }).filter(Boolean) as string[]);
  const exam = (k: string) => /exam|vital|finding|sign/.test(k);
  const later = (k: string) => /plan|diagnos|assess/.test(k);
  return {
    subjective: [n.cc, ...lines(k => !exam(k) && !later(k))].filter(Boolean).join('\n'),
    objective: lines(exam).join('\n'),
    assessment: [n.assessment, ...lines(k => /diagnos|assess/.test(k))].filter(Boolean).join('\n'),
    plan: [n.plan, ...rx.filter(r => r.name).map(r => `${r.name} ${[r.dose, r.frequency, r.duration].filter(Boolean).join(' · ')}`),
           n.follow ? t('Follow-up on {d}', { d: n.follow }) : ''].filter(Boolean).join('\n')
  };
}

// After signing: the note, the prescription and the letters ready to print on the clinic's paper,
// the patient's summary to send, the follow-up to book.
export function Outputs({ ctx, run, values, note, rx, onChanged }:
  { ctx: VisitContext; run: Run | null; values: Values; note: Note; rx: RxLine[]; onChanged: () => void }) {
  const { t, lang } = useLang();
  const { tenant } = useTenant();
  const shell = useShell();
  const toast = useToast();
  const { busy, run: act } = useAction();
  const [tab, setTab] = useState<Tab>('note');
  const soap = useMemo(() => {
    const s = run?.outputs?.soap;
    return s && (s.subjective || s.objective || s.assessment || s.plan) ? s : composeSoap(ctx.template, values, note, rx, lang, t);
  }, [run, ctx.template, values, note, rx, lang, t]);
  const pt = ctx.patient;
  const doctor = lang === 'en' ? ctx.doctor.name_en || ctx.doctor.name : ctx.doctor.name;
  const [summary, setSummary] = useState(() => run?.outputs?.summary_ar || defaultSummary());
  const [days, setDays] = useState('3');
  const [from, setFrom] = useState(ctx.appointment.session_date);
  const [letter, setLetter] = useState<'report' | 'leave'>('report');
  const [printing, setPrinting] = useState<{ title: string; body: ReactNode } | null>(null);

  function defaultSummary() {
    const meds = rx.filter(r => r.name).map(r => `• ${r.name} ${[r.dose, r.frequency, r.duration].filter(Boolean).join(' – ')}`);
    return [`أهلاً ${pt.full_name.split(' ')[0]} 🌿 ده ملخص زيارتك النهارده مع ${ctx.doctor.name}:`,
      note.assessment && `• ${note.assessment}`, note.plan && `• ${note.plan}`, ...(meds.length ? ['الأدوية:', ...meds] : []),
      note.follow && `• ميعاد المتابعة: ${note.follow}`, 'ألف سلامة عليك.'].filter(Boolean).join('\n');
  }

  useEffect(() => {
    if (!printing) return;
    const done = () => { document.body.classList.remove('printing'); setPrinting(null); };
    document.body.classList.add('printing');
    window.addEventListener('afterprint', done, { once: true });
    const id = setTimeout(() => window.print(), 60);
    return () => { clearTimeout(id); window.removeEventListener('afterprint', done); document.body.classList.remove('printing'); };
  }, [printing]);

  const soapText = [`S: ${soap.subjective}`, `O: ${soap.objective}`, `A: ${soap.assessment}`, `P: ${soap.plan}`].join('\n\n');
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); toast(t('Copied.')); } catch { toast(t('Could not copy.'), 'critical'); } };
  const send = async () => {
    const r = await act(async () => {
      const { data, error } = await sb().rpc('visit_summary_send', { p_appt: ctx.appointment.id, p_text: summary });
      if (error) throw new Error(error.message);
      const d = data as { ok: boolean; error?: string };
      if (!d.ok) throw new Error(d.error === 'NO_WHATSAPP' ? t('This patient has no WhatsApp number.') : t('Write the summary first.'));
      return d;
    }, t('Sent on WhatsApp.'));
    if (r) ping();
  };
  const markDone = async () => {
    const r = await act(async () => {
      const { error } = await sb().rpc('set_appointment_status', { p_appt: ctx.appointment.id, p_status: 'done', p_note: null, p_notify: false });
      if (error) throw new Error(error.message);
      return true;
    }, t('Visit done.'));
    if (r) onChanged();
  };

  const age = lang === 'en' ? pt.age_en : pt.age;
  const reportText = [
    lang === 'en' ? `${pt.full_name}${age ? `, ${age}` : ''}, was seen on ${dayLabel(ctx.appointment.starts_at, tenant.timezone)}.` : `تم الكشف على ${pt.full_name}${age ? ` (${age})` : ''} بتاريخ ${dayLabel(ctx.appointment.starts_at, tenant.timezone)}.`,
    note.cc && `${t('Complaint')}: ${note.cc}`, soap.objective && `${t('Findings')}:\n${soap.objective}`,
    note.assessment && `${t('Assessment')}: ${note.assessment}`, note.plan && `${t('Plan')}: ${note.plan}`
  ].filter(Boolean).join('\n\n');
  const leaveText = lang === 'en'
    ? `${pt.full_name} is advised to rest for ${days} day(s), from ${from}, for medical reasons.`
    : `يُنصح ${pt.full_name} بالراحة لمدة ${days} ${Number(days) > 10 || Number(days) < 3 ? 'يوم' : 'أيام'} اعتباراً من ${from} لأسباب طبية.`;

  const sheet = (title: string, body: ReactNode) => setPrinting({ title, body });

  return (
    <Card title={t('After the visit')} sub={t('Signed. Print, send, book the follow-up.')} className="c-rise"
      action={ctx.appointment.status !== 'done'
        ? <Button size="sm" variant="positive" busy={busy} onClick={markDone}><CheckCircle2 className="size-3.5" aria-hidden />{t('The visit is done')}</Button>
        : undefined}>
      <div className="space-y-4">
        {note.follow && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-gold-wash px-4 py-3">
            <span className="min-w-0 flex-1 text-[13.5px]">{t('Follow-up on {d}', { d: dayLabel(`${note.follow}T12:00:00Z`, tenant.timezone) })}</span>
            <Button size="sm" onClick={() => shell.newBooking({ patientId: pt.id, patientName: pt.full_name, doctorId: ctx.doctor.id, date: note.follow })}>
              <CalendarPlus className="size-3.5" aria-hidden />{t('Book it')}
            </Button>
          </div>
        )}
        <div className="rail -mx-1 overflow-x-auto px-1">
          <Segmented label="visit-out" value={tab} onChange={setTab} size="sm"
            options={[{ value: 'note', label: t('The note') }, { value: 'rx', label: t('Prescription') }, { value: 'patient', label: t('For the patient') }, { value: 'letters', label: t('Letters') }]} />
        </div>

        <div key={tab} className="c-fade">
          {tab === 'note' && (
            <div className="space-y-3">
              <dl className="space-y-3 text-[13.5px] leading-relaxed">
                {(['subjective', 'objective', 'assessment', 'plan'] as const).map(k => (
                  <div key={k} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2">
                    <dt className="font-semibold text-gold-ink">{k[0].toUpperCase()}</dt>
                    <dd className="whitespace-pre-line" dir="auto"><bdi>{soap[k] || '—'}</bdi></dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => copy(soapText)}><Copy className="size-3.5" aria-hidden />{t('Copy')}</Button>
                <Button size="sm" variant="outline" onClick={() => sheet(t('Visit note'), <Pre text={soapText} />)}><Printer className="size-3.5" aria-hidden />{t('Print')}</Button>
              </div>
            </div>
          )}
          {tab === 'rx' && (
            <div className="space-y-3">
              {rx.filter(r => r.name).length === 0 ? <p className="text-[13.5px] text-muted">{t('No medicine was prescribed in this visit.')}</p> : (
                <ol className="space-y-2 text-[14px]">
                  {rx.filter(r => r.name).map((r, i) => (
                    <li key={i} className="flex gap-2.5"><span className="w-4 shrink-0 font-semibold tabular-nums text-faint">{i + 1}</span>
                      <span><bdi className="font-semibold">{r.name}</bdi> <bdi className="text-muted">{[r.dose, r.frequency, r.duration].filter(Boolean).join(' · ')}</bdi></span></li>
                  ))}
                </ol>
              )}
              {rx.some(r => r.name) && <Button size="sm" variant="outline" onClick={() => sheet(t('Prescription'), <RxSheet rx={rx} />)}><Printer className="size-3.5" aria-hidden />{t('Print on the clinic’s paper')}</Button>}
            </div>
          )}
          {tab === 'patient' && (
            <div className="space-y-3">
              <Textarea rows={7} value={summary} onChange={e => setSummary(e.target.value)} aria-label={t('The summary for the patient')} />
              <p className="text-[12.5px] text-muted">{t('Read it and change anything before it goes. It is sent from the clinic’s WhatsApp.')}</p>
              <Button size="sm" busy={busy} onClick={send} disabled={!summary.trim()}><MessageCircle className="size-3.5" aria-hidden />{t('Send on WhatsApp')}</Button>
            </div>
          )}
          {tab === 'letters' && (
            <div className="space-y-3">
              <Segmented label="visit-letter" size="sm" value={letter} onChange={setLetter} options={[{ value: 'report', label: t('Medical report') }, { value: 'leave', label: t('Sick leave') }]} />
              {letter === 'leave' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('Days')}><Input inputMode="numeric" value={days} onChange={e => setDays(e.target.value.replace(/\D/g, '').slice(0, 2))} /></Field>
                  <Field label={t('From')}><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
                </div>
              )}
              <p className="whitespace-pre-line rounded-2xl bg-raised px-4 py-3 text-[13.5px] leading-relaxed ring-1 ring-inset ring-border" dir="auto">{letter === 'report' ? reportText : leaveText}</p>
              <Button size="sm" variant="outline" onClick={() => sheet(letter === 'report' ? t('Medical report') : t('Sick leave'), <Pre text={letter === 'report' ? reportText : leaveText} />)}>
                <Printer className="size-3.5" aria-hidden />{t('Print')}
              </Button>
            </div>
          )}
        </div>
      </div>
      {printing && <PrintSheet title={printing.title} ctx={ctx} doctor={doctor}>{printing.body}</PrintSheet>}
    </Card>
  );
}

const Pre = ({ text }: { text: string }) => <div className="whitespace-pre-line text-[13pt] leading-relaxed" dir="auto">{text}</div>;
const RxSheet = ({ rx }: { rx: RxLine[] }) => (
  <div>
    <p className="mb-3 text-[22pt] font-semibold">℞</p>
    <ol className="space-y-3 text-[13pt]">
      {rx.filter(r => r.name).map((r, i) => (
        <li key={i} className="flex gap-3"><span className="w-5 shrink-0 font-semibold">{i + 1}.</span>
          <span><b>{r.name}</b>{r.dose ? ` ${r.dose}` : ''}<br /><span>{[r.frequency, r.duration].filter(Boolean).join(' — ')}</span></span></li>
      ))}
    </ol>
  </div>
);

// the clinic's paper: logo and name, the doctor, the patient, the day; a line to sign
function PrintSheet({ title, ctx, doctor, children }: { title: string; ctx: VisitContext; doctor: string; children: ReactNode }) {
  const { tenant, brand } = useTenant();
  const { t, lang } = useLang();
  const pt = ctx.patient;
  return createPortal(
    <div className="print-sheet bg-white p-2 text-black" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <header className="flex items-center justify-between gap-4 border-b-2 border-black/80 pb-3">
        <div>
          <p className="text-[17pt] font-semibold">{lang === 'en' ? tenant.name_en || tenant.name_ar : tenant.name_ar}</p>
          <p className="text-[11pt]">{doctor}</p>
        </div>
        {brand.logo_url ? <img src={brand.logo_url} alt="" className="h-14 w-auto" /> : <Mark size={44} tone="onLight" />}
      </header>
      <p className="mt-3 flex flex-wrap justify-between gap-2 text-[11pt]">
        <span>{t('Patient')}: <b>{pt.full_name}</b>{(lang === 'en' ? pt.age_en : pt.age) ? ` · ${lang === 'en' ? pt.age_en : pt.age}` : ''} · #{pt.file_no}</span>
        <span>{dayLabel(ctx.appointment.starts_at, tenant.timezone)}</span>
      </p>
      <h1 className="mb-4 mt-5 text-[15pt] font-semibold">{title}</h1>
      {children}
      <footer className="mt-16 flex justify-end"><span className="border-t border-black/70 px-10 pt-1 text-[10pt]">{t('Signature')}</span></footer>
    </div>,
    document.body
  );
}
