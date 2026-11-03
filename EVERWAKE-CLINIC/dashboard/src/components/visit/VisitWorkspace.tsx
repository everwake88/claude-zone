'use client';
import { AlertTriangle, ArrowLeft, Lock, MessageCircleQuestion, PenLine } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clock as timeOf, cx, dayLabel } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sourcesOf, type FieldFill } from '@/lib/scribe/schema';
import type { Segment } from '@/lib/scribe/transcript';
import { newForRecord } from '@/lib/scribe/verify';
import { sb } from '@/lib/supabase/client';
import { Avatar, Button, Card, Dialog, Field, Input, Pill, Skeleton, Textarea, useAction } from '../ui';
import { useTenant } from '../tenant';
import { VisitProvider } from './context';
import { FindingsCard, PrescriptionCard, type RxLine, type Ticks } from './Findings';
import { FieldBox, FormCards, type Values } from './FormCards';
import { Outputs, type Note } from './Outputs';
import { Recorder } from './Recorder';
import type { VisitContext } from './types';

const NO_TICKS: Ticks = { allergies: [], medications: [], conditions: [], teeth: [], plan_items: [] };
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const flat = (data: Record<string, Record<string, unknown>> | null | undefined): Values =>
  Object.fromEntries(Object.entries(data || {}).filter(([k]) => !k.startsWith('_')).flatMap(([s, f]) => Object.entries(f || {}).map(([k, v]) => [`${s}.${k}`, v])));
const nest = (values: Values) => {
  const d: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(values)) { if (isEmpty(v)) continue; const [s, f] = k.split('.'); (d[s] ||= {})[f] = v; }
  return d;
};
const rxOf = (items: unknown): RxLine[] => (Array.isArray(items) ? items : []).map((r: Record<string, unknown>) => ({
  name: String(r.name || ''), dose: String(r.dose || ''), frequency: String(r.frequency || ''), duration: String(r.duration || ''), notes: r.notes ? String(r.notes) : undefined }));

// The visit, one screen: who the patient is, listening on the left, the doctor's own form on the
// right filling in with the words behind every value, what is new for the file, then Sign.
export function VisitWorkspace({ id }: { id: number }) {
  const { t, lang } = useLang();
  const { tenant, base, can } = useTenant();
  const { busy, run: act } = useAction();
  const [ctx, setCtx] = useState<VisitContext | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [note, setNote] = useState<Note>({ cc: '', assessment: '', plan: '', follow: '' });
  const [rx, setRx] = useState<RxLine[]>([]);
  const [toMeds, setToMeds] = useState(true);
  const [ticks, setTicks] = useState<Ticks>(NO_TICKS);
  const [flash, setFlash] = useState(0);
  const [live, setLive] = useState<Segment[] | null>(null);
  const [askSign, setAskSign] = useState(false);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const dirty = useRef(false);
  const encId = useRef<number | null>(null);
  const seen = useRef<string>('');

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('visit_context', { p_appt: id });
    if (error) { setFailed(error.message); return; }
    setCtx(data as VisitContext);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const rec = ctx?.recording && ctx.recording.status !== 'discarded' ? ctx.recording : null;
  const run = rec && ctx?.run && ctx.run.recording_id === rec.id ? ctx.run : null;
  const fills: Record<string, FieldFill> = run?.extraction?.fields || {};
  const enc = ctx?.encounter || null;
  const signed = enc?.status === 'signed' || rec?.status === 'signed';

  // what the screen starts from: the doctor's saved work first, then what was heard
  useEffect(() => {
    if (!ctx) return;
    const key = `${enc?.id}-${enc?.status}-${run?.id}`;
    if (seen.current === key) return;
    const first = !seen.current;
    seen.current = key;
    encId.current = enc?.id || null;
    const x = run?.extraction;
    setValues(v => {
      const base = first ? flat(enc?.data) : v;
      const out = { ...base };
      for (const [k, f] of Object.entries(x?.fields || {})) if (!f.unsupported && isEmpty(out[k])) out[k] = f.value;
      return out;
    });
    setNote(n => {
      const pick = (cur: string, saved: string | null | undefined, heard: FieldFill | undefined) =>
        (first ? saved || '' : cur) || (heard && !heard.unsupported && heard.value ? String(heard.value) : '');
      return {
        cc: pick(n.cc, enc?.chief_complaint, x?.chief_complaint) || (first ? ctx.appointment.reason || '' : ''),
        assessment: pick(n.assessment, enc?.assessment, x?.assessment),
        plan: pick(n.plan, enc?.plan, x?.plan),
        follow: pick(n.follow, enc?.follow_up_date, x?.follow_up_date)
      };
    });
    setRx(r => {
      const savedRx = rxOf((enc?.data as Record<string, unknown> | undefined)?._rx);
      if (first && savedRx.length) return savedRx;
      return r.length ? r : rxOf(run?.outputs?.prescription || x?.prescription);
    });
    if (run) { setFlash(f => f + 1); setTicks(NO_TICKS); setLive(null); }
  }, [ctx, enc, run]);

  const setValue = (k: string, v: unknown) => { dirty.current = true; setValues(s => ({ ...s, [k]: v })); };
  const setN = (k: keyof Note, v: string) => { dirty.current = true; setNote(n => ({ ...n, [k]: v })); };
  const setRxD = (r: RxLine[]) => { dirty.current = true; setRx(r); };

  const payload = () => ({ template_id: ctx?.template?.id || null, chief_complaint: note.cc || null,
    data: { ...nest(values), ...(rx.some(r => r.name) ? { _rx: rx.filter(r => r.name) } : {}) },
    assessment: note.assessment || null, plan: note.plan || null, follow_up_date: note.follow || null });

  // the draft saves itself a few seconds after the doctor stops typing
  const saveDraft = useCallback(async (quiet: boolean) => {
    if (!ctx || signed) return;
    setSaved('saving');
    const { data, error } = await sb().rpc('save_encounter', { p_patient: ctx.patient.id,
      p: { id: encId.current, appointment_id: ctx.appointment.id, doctor_id: ctx.doctor.id, ...payload(), sign: false } });
    if (error) { setSaved('idle'); if (!quiet) throw new Error(error.message); return; }
    encId.current = (data as { encounter: { id: number } }).encounter.id;
    dirty.current = false;
    setSaved('saved');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, signed, values, note, rx]);
  useEffect(() => {
    if (!dirty.current || signed) return;
    const tm = setTimeout(() => { saveDraft(true); }, 4000);
    return () => clearTimeout(tm);
  }, [values, note, rx, saveDraft, signed]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty.current && !signed) { e.preventDefault(); } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [signed]);

  // the assistant fills the open visit from what the doctor says (the doctor still signs)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type: string; payload: Record<string, unknown> }>).detail;
      if (!d || signed || !ctx) return;
      const known = new Set((ctx.template?.schema.sections || []).flatMap(s => s.fields.map(f => `${s.key}.${f.key}`)));
      if (d.type === 'fill_visit_fields') {
        const p = d.payload;
        const fields = (Array.isArray(p.fields) ? p.fields : []) as { key: string; value: unknown }[];
        setValues(v => { const out = { ...v }; for (const f of fields) if (known.has(f.key)) out[f.key] = f.value; return out; });
        setNote(n => ({ cc: typeof p.chief_complaint === 'string' ? p.chief_complaint : n.cc, assessment: typeof p.assessment === 'string' ? p.assessment : n.assessment,
                        plan: typeof p.plan === 'string' ? p.plan : n.plan, follow: typeof p.follow_up === 'string' ? p.follow_up : n.follow }));
      } else if (d.type === 'draft_prescription') {
        setRx(r => [...r.filter(l => l.name), ...rxOf(d.payload.lines)]);
      } else return;
      dirty.current = true;
      setFlash(f => f + 1);
    };
    window.addEventListener('everwake:visit', on);
    return () => window.removeEventListener('everwake:visit', on);
  }, [ctx, signed]);

  const fresh = useMemo(() => run ? newForRecord(run.extraction, { allergies: ctx!.record.allergies, medications: ctx!.record.medications, conditions: ctx!.record.conditions })
    : { allergies: [], medications: [], conditions: [] }, [run, ctx]);
  const heard = Object.values(fills).filter(f => !f.unsupported).length;
  const unclear = Object.values(fills).filter(f => f.unsupported).length;

  const sign = async () => {
    if (!ctx) return;
    setAskSign(false);
    const p = payload();
    const r = await act(async () => {
      if (rec && run) {
        const lit = Object.keys(fills).filter(k => !fills[k].unsupported && JSON.stringify(values[k] ?? null) === JSON.stringify(fills[k].value ?? null));
        const teeth = ticks.teeth.map(i => run.extraction.teeth[i]).filter(Boolean);
        const items = ticks.plan_items.map(i => run.extraction.plan_items[i]).filter(Boolean);
        const { data, error } = await sb().rpc('scribe_sign', { p_rec: rec.id, p: { ...p,
          sources: sourcesOf(fills, lit),
          add: {
            allergies: ticks.allergies.map(i => fresh.allergies[i]).filter(Boolean).map(a => ({ substance: a.substance, reaction: a.reaction || null })),
            medications: [...ticks.medications.map(i => fresh.medications[i]).filter(Boolean).map(m => ({ name: m.name, dose: m.dose || null, frequency: m.frequency || null })),
                          ...(toMeds ? rx.filter(l => l.name).map(l => ({ ...l, prescribed_here: true })) : [])],
            conditions: ticks.conditions.map(i => fresh.conditions[i]).filter(Boolean).map(c => ({ name: c.name }))
          },
          teeth: teeth.map(x => ({ tooth: x.tooth, condition: x.condition, planned: x.planned || null, surfaces: x.surfaces || [] })),
          treatment: items.length ? { title: t('Treatment plan'), items: items.map(x => ({ tooth: x.tooth || null, label: x.label, sessions: x.sessions || 1 })) } : null } });
        if (error) throw new Error(error.message);
        const d = data as { ok: boolean; error?: string };
        if (!d.ok) throw new Error(d.error === 'ALREADY_SIGNED' ? t('This visit is already signed.') : t('That did not work. Try again.'));
      } else {
        const { error } = await sb().rpc('save_encounter', { p_patient: ctx.patient.id, p: { id: encId.current, appointment_id: ctx.appointment.id, doctor_id: ctx.doctor.id, ...p, sign: true } });
        if (error) throw new Error(error.message);
        if (toMeds) for (const l of rx.filter(x => x.name)) await sb().rpc('save_record', { p_patient: ctx.patient.id, p_table: 'medications', p: { ...l, prescribed_here: true, source: 'manual' } });
      }
      return true;
    }, t('Signed. It is on the patient’s file.'));
    if (r) { dirty.current = false; await load(); }
  };

  if (failed) return <Card className="c-rise"><p className="text-[14px] text-muted">{t(/clinical|insufficient|role/i.test(failed) ? 'Medical records are for the doctors and nurses.' : 'This visit could not be opened.')}</p></Card>;
  if (!ctx) return (
    <div className="space-y-5">
      <Skeleton className="h-28 rounded-[20px]" />
      <div className="grid gap-5 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]"><Skeleton className="h-80 rounded-[20px]" /><Skeleton className="h-[480px] rounded-[20px]" /></div>
    </div>
  );
  if (!can.clinical) return <Card><p className="flex items-center gap-2 text-[14px] text-muted"><Lock className="size-4" aria-hidden />{t('Medical records are for the doctors and nurses.')}</p></Card>;

  const a = ctx.appointment;
  const pt = ctx.patient;
  const segments = live || rec?.transcript?.segments || [];
  const pre = Object.entries(a.pre_visit || {});
  const allergies = ctx.record.allergies;
  const top = (k: 'chief_complaint' | 'assessment' | 'plan' | 'follow_up_date') => run?.extraction?.[k];
  const litTop = (k: 'chief_complaint' | 'assessment' | 'plan' | 'follow_up_date', v: string) => { const f = top(k); return !!f && !f.unsupported && !!f.value && String(f.value) === v; };
  const state = signed ? 'signed' : rec?.status === 'recording' ? 'listening' : run ? 'review' : enc ? 'draft' : 'new';

  return (
    <VisitProvider recording={rec} segments={segments}>
      <div className="space-y-5 pb-24">
        <Link href={base} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />{t('Today')}</Link>

        <header className="card c-rise flex flex-wrap items-start gap-4 p-5 sm:p-6">
          <Avatar name={pt.full_name} size={52} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-[22px] font-semibold leading-tight"><bdi>{pt.full_name}</bdi></h1>
              <Pill tone={state === 'signed' ? 'positive' : state === 'listening' ? 'critical' : state === 'review' ? 'gold' : state === 'draft' ? 'caution' : 'neutral'}>
                {state === 'listening' && <span className="c-breathe size-1.5 rounded-full bg-critical" aria-hidden />}
                {t(state === 'signed' ? 'Signed' : state === 'listening' ? 'Listening' : state === 'review' ? 'Ready to check' : state === 'draft' ? 'Draft' : 'Not started')}
              </Pill>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
              <span className="tabular-nums">#{pt.file_no}</span>
              {(lang === 'en' ? pt.age_en : pt.age) && <span>{lang === 'en' ? pt.age_en : pt.age}</span>}
              {pt.sex && <span>{t(pt.sex === 'female' ? 'Female' : 'Male')}</span>}
              <span>{dayLabel(a.starts_at, tenant.timezone, { weekday: 'short', day: 'numeric', month: 'short' })} · <span className="tabular-nums">{timeOf(a.est_at || a.starts_at, tenant.timezone)}</span></span>
              {(a.service || a.service_en) && <span><bdi>{(lang === 'en' && a.service_en) || a.service}</bdi></span>}
              <span><bdi>{lang === 'en' ? ctx.doctor.name_en || ctx.doctor.name : ctx.doctor.name}</bdi></span>
            </p>
            {allergies.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-1.5">
                <AlertTriangle className="size-4 text-critical" aria-hidden /><span className="text-[13px] font-semibold text-critical-ink">{t('Allergic to')}</span>
                {allergies.map(x => <span key={x.id} className="rounded-full bg-critical-soft px-2.5 py-0.5 text-[12.5px] font-medium text-critical-ink"><bdi>{x.substance}</bdi></span>)}
              </p>
            )}
          </div>
          {pre.length > 0 && (
            <div className="w-full rounded-2xl bg-raised px-4 py-3 ring-1 ring-inset ring-border sm:w-auto sm:max-w-[420px]">
              <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-ink"><MessageCircleQuestion className="size-3.5 text-gold-ink" aria-hidden />{t('Answered on WhatsApp before the visit')}</p>
              <dl className="space-y-1 text-[13px]">
                {pre.slice(0, 4).map(([q, ans]) => <div key={q} className="flex gap-2" dir="auto"><dt className="text-muted"><bdi>{q}</bdi></dt><dd className="font-medium"><bdi>{ans}</bdi></dd></div>)}
              </dl>
            </div>
          )}
        </header>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-5 lg:sticky lg:top-[84px]">
            <Recorder ctx={ctx} audioDays={ctx.audio_days || 30} onChanged={load} onSegments={setLive} />
          </aside>

          <div className="min-w-0 space-y-5">
            {signed && <Outputs ctx={ctx} run={run} values={values} note={note} rx={rx} onChanged={load} />}
            {run && !signed && (
              <FindingsCard fresh={fresh} teeth={run.extraction.teeth || []} planItems={run.extraction.plan_items || []} chart={ctx.record.teeth}
                ticks={ticks} setTicks={setTicks} signed={signed} heard={heard} unclear={unclear} />
            )}

            <section className="card c-rise min-w-0">
              <header className="flex items-baseline justify-between gap-3 px-5 pt-5">
                <h2 className="text-[15px] font-semibold leading-6">{t('The visit')}</h2>
                {!run && !signed && <span className="flex items-center gap-1.5 text-[12.5px] text-faint"><PenLine className="size-3.5" aria-hidden />{t('Type, or let it listen')}</span>}
              </header>
              <div className="grid gap-4 p-5 pt-4 sm:grid-cols-2">
                <FieldBox label={t('Reason for the visit')} fill={top('chief_complaint')} lit={litTop('chief_complaint', note.cc)} flash={litTop('chief_complaint', note.cc) ? `${flash}-cc` : ''} wide>
                  <Input disabled={signed} value={note.cc} onChange={e => setN('cc', e.target.value)} />
                </FieldBox>
                <FieldBox label={t('Assessment')} fill={top('assessment')} lit={litTop('assessment', note.assessment)} flash={litTop('assessment', note.assessment) ? `${flash}-a` : ''} wide
                  onUse={v => setN('assessment', String(v))}>
                  <Textarea rows={2} disabled={signed} value={note.assessment} onChange={e => setN('assessment', e.target.value)} />
                </FieldBox>
                <FieldBox label={t('Plan')} fill={top('plan')} lit={litTop('plan', note.plan)} flash={litTop('plan', note.plan) ? `${flash}-p` : ''} wide onUse={v => setN('plan', String(v))}>
                  <Textarea rows={2} disabled={signed} value={note.plan} onChange={e => setN('plan', e.target.value)} />
                </FieldBox>
                <FieldBox label={t('Follow-up on')} fill={top('follow_up_date')} lit={litTop('follow_up_date', note.follow)} flash={litTop('follow_up_date', note.follow) ? `${flash}-f` : ''}
                  onUse={v => setN('follow', String(v))}>
                  <Input type="date" disabled={signed} value={note.follow} onChange={e => setN('follow', e.target.value)} />
                </FieldBox>
              </div>
            </section>

            <FormCards template={ctx.template} values={values} setValue={setValue} fills={fills} signed={signed} flash={flash} />
            {(!signed || rx.some(r => r.name)) && <PrescriptionCard rx={rx} setRx={setRxD} toMeds={toMeds} setToMeds={setToMeds} signed={signed} />}

            {!signed && (
              <div className="no-print sticky bottom-4 z-20 max-lg:bottom-[92px]">
                <div className="c-rise flex flex-wrap items-center gap-3 rounded-[22px] bg-navy py-2.5 pe-2.5 ps-5 text-white shadow-[0_18px_40px_-18px_rgb(11_34_46/.75)]">
                  <p className="min-w-0 flex-1 truncate text-[13px] text-on-navy-muted">
                    {saved === 'saving' ? t('Saving…') : saved === 'saved' ? t('Draft saved') : run ? t('{n} filled from the visit · {m} to check', { n: heard, m: unclear }) : t('Nothing goes on the file until you sign.')}
                  </p>
                  <Button variant="ghost" className="text-white hover:bg-white/10" busy={busy && saved === 'saving'} onClick={() => act(() => saveDraft(false), t('Draft saved.'))}>{t('Save draft')}</Button>
                  <Button variant="accent" onClick={() => setAskSign(true)} disabled={busy || rec?.status === 'recording'}>{t('Sign')}</Button>
                </div>
              </div>
            )}
          </div>
        </div>

        <Dialog open={askSign} onClose={() => setAskSign(false)} title={t('Sign this visit?')}
          footer={<><Button variant="outline" onClick={() => setAskSign(false)}>{t('Not yet')}</Button><Button busy={busy} onClick={sign}>{t('Sign')}</Button></>}>
          <p className="text-muted">{t('The note goes on {name}’s file and can no longer be changed.', { name: pt.full_name })}</p>
          {(() => {
            const adds = ticks.allergies.length + ticks.medications.length + ticks.conditions.length + (toMeds ? rx.filter(r => r.name).length : 0);
            const parts = [adds && t('{n} added to the record', { n: adds }), ticks.teeth.length && t('{n} teeth', { n: ticks.teeth.length }),
                           ticks.plan_items.length && t('a treatment plan'), unclear && t('{n} fields left empty', { n: unclear })].filter(Boolean);
            return parts.length ? <p className={cx('mt-2 font-medium')}>{parts.join(' · ')}</p> : null;
          })()}
        </Dialog>
      </div>
    </VisitProvider>
  );
}
