'use client';
import { Plus, Send, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { docName, serviceName, useClinic } from '@/lib/clinic-data';
import { okOrThrow } from '@/lib/codes';
import { cx, dateShort, money } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { ping } from '@/lib/outbox-client';
import { sb } from '@/lib/supabase/client';
import { DoctorPick } from '../booking/pickers';
import { Button, Card, CountUp, Drawer, Empty, Field, Input, Pill, Select, Textarea, useAction, useToast } from '../ui';
import { useTenant } from '../tenant';
import type { Plan, PlanItem, Tooth } from './types';

// FDI numbering, drawn as the dentist sees the patient: the patient's right on the left.
const ADULT = { upper: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28], lower: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38] };
const CHILD = { upper: [55, 54, 53, 52, 51, 61, 62, 63, 64, 65], lower: [85, 84, 83, 82, 81, 71, 72, 73, 74, 75] };

export const CONDITIONS: { key: string; label: string; cls: string }[] = [
  { key: 'healthy', label: 'Healthy', cls: 'bg-sheet ring-control' },
  { key: 'caries', label: 'Caries', cls: 'bg-critical-soft ring-critical/50 text-critical-ink' },
  { key: 'filled', label: 'Filled', cls: 'bg-accent-soft ring-accent-track text-accent-ink' },
  { key: 'root_canal', label: 'Root canal', cls: 'bg-accent-track ring-accent/50 text-accent-ink' },
  { key: 'crown', label: 'Crown', cls: 'bg-caution-soft ring-caution-line text-caution' },
  { key: 'bridge', label: 'Bridge', cls: 'bg-caution-soft ring-caution text-caution' },
  { key: 'implant', label: 'Implant', cls: 'bg-[#e6e9ef] ring-faint/60 text-muted' },
  { key: 'veneer', label: 'Veneer', cls: 'bg-accent-soft ring-accent/40 text-accent-ink' },
  { key: 'missing', label: 'Missing', cls: 'bg-transparent ring-0 border border-dashed border-faint/70 text-faint' },
  { key: 'extraction_needed', label: 'To extract', cls: 'bg-sheet ring-critical text-critical-ink' },
  { key: 'impacted', label: 'Impacted', cls: 'bg-critical-soft ring-critical/40 text-critical-ink' },
  { key: 'fractured', label: 'Fractured', cls: 'bg-critical-soft ring-critical text-critical-ink' },
  { key: 'sensitive', label: 'Sensitive', cls: 'bg-caution-soft ring-caution-line text-caution' },
  { key: 'watch', label: 'Watch', cls: 'bg-sheet ring-caution text-caution' }
];
const COND = Object.fromEntries(CONDITIONS.map(c => [c.key, c]));
const SURFACES = ['M', 'O', 'D', 'B', 'L'];

export function DentalChart({ patientId, teeth, onChanged, onPlanTooth }:
  { patientId: number; teeth: Tooth[]; onChanged: () => void; onPlanTooth?: (tooth: number, planned: string | null) => void }) {
  const { t } = useLang();
  const { can } = useTenant();
  const { busy, run } = useAction();
  const [child, setChild] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [form, setForm] = useState<{ condition: string; surfaces: string[]; planned: string; notes: string }>({ condition: 'healthy', surfaces: [], planned: '', notes: '' });
  const map = useMemo(() => new Map(teeth.map(x => [x.tooth, x])), [teeth]);
  const set = child ? CHILD : ADULT;
  useEffect(() => { if (teeth.some(x => x.tooth > 50) && !teeth.some(x => x.tooth < 50)) setChild(true); }, [teeth]);

  const pick = (n: number) => {
    const x = map.get(n);
    setSel(n);
    setForm({ condition: x?.condition || 'healthy', surfaces: x?.surfaces || [], planned: x?.planned || '', notes: x?.notes || '' });
  };
  const save = async (clear = false) => {
    if (sel == null) return;
    const r = await run(async () => {
      const { data, error } = await sb().rpc('set_teeth', { p_patient: patientId, p_teeth: [clear ? { tooth: sel, clear: true } : { tooth: sel, ...form }] });
      if (error) throw new Error(error.message);
      return okOrThrow(data as { ok?: boolean; error?: string });
    });
    if (r) { onChanged(); setSel(null); }
  };

  const toothBtn = (n: number, lower: boolean) => {
    const x = map.get(n);
    const c = COND[x?.condition || 'healthy'];
    const molar = n % 10 >= 6 || (n > 50 && n % 10 >= 4);
    return (
      <button key={n} type="button" onClick={() => can.clinical && pick(n)} aria-pressed={sel === n}
        aria-label={`${t('Tooth')} ${n}: ${t(c.label)}${x?.planned ? ' · ' + x.planned : ''}`}
        className={cx('press group relative flex flex-col items-center gap-1', lower && 'flex-col-reverse')}>
        <span className={cx('relative flex items-center justify-center ring-1 ring-inset transition-[box-shadow,background-color] duration-150',
          molar ? 'h-9 w-[30px] rounded-[9px] sm:h-10 sm:w-9' : 'h-9 w-6 rounded-[10px] sm:h-10 sm:w-7', c.cls,
          sel === n && 'ring-2 ring-accent shadow-[0_0_0_3px_var(--color-accent-soft)]',
          x?.condition === 'missing' && 'opacity-60')}>
          {x?.surfaces?.length ? <span className="text-[8px] font-semibold leading-none tracking-tight">{x.surfaces.join('')}</span> : null}
          {x?.planned && <span className="absolute -top-1 end-[-3px] size-2 rounded-full bg-accent ring-2 ring-sheet" aria-hidden />}
        </span>
        <span className={cx('text-[10px] tabular-nums', sel === n ? 'font-semibold text-accent' : 'text-faint')}>{n}</span>
      </button>
    );
  };
  const half = (row: number[], lower: boolean) => (
    <div className="flex items-end justify-center gap-[3px] sm:gap-1">
      {row.slice(0, row.length / 2).map(n => toothBtn(n, lower))}
      <span className="mx-1 w-px self-stretch bg-control sm:mx-2" aria-hidden />
      {row.slice(row.length / 2).map(n => toothBtn(n, lower))}
    </div>
  );
  const used = CONDITIONS.filter(c => c.key !== 'healthy' && teeth.some(x => x.condition === c.key));

  return (
    <Card title={t('Dental chart')} sub={t('FDI numbering, as you face the patient. Tap a tooth.')}
      action={<div className="inline-flex rounded-[8px] bg-raised p-0.5 text-xs ring-1 ring-inset ring-border">
        {[false, true].map(v => <button key={String(v)} onClick={() => { setChild(v); setSel(null); }} className={cx('press rounded-[6px] px-2.5 py-1 font-medium', child === v ? 'bg-sheet text-ink shadow-sm ring-1 ring-border' : 'text-muted')}>{v ? t('Child') : t('Adult')}</button>)}
      </div>}>
      <div dir="ltr" className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="mx-auto w-max space-y-2 py-1">
          <p className="flex justify-between px-1 text-[10.5px] uppercase tracking-wide text-faint"><span>{t('Patient’s right')}</span><span>{t('Upper')}</span><span>{t('Patient’s left')}</span></p>
          {half(set.upper, false)}
          <div className="h-px bg-rule" aria-hidden />
          {half(set.lower, true)}
          <p className="text-center text-[10.5px] uppercase tracking-wide text-faint">{t('Lower')}</p>
        </div>
      </div>
      {used.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-rule pt-3 text-[12px] text-muted">
          {used.map(c => <span key={c.key} className="inline-flex items-center gap-1.5"><span className={cx('size-3 rounded-[4px] ring-1 ring-inset', c.cls)} />{t(c.label)} <b className="tabular-nums text-ink">{teeth.filter(x => x.condition === c.key).length}</b></span>)}
          {teeth.some(x => x.planned) && <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-accent" />{t('Work planned')}</span>}
        </div>
      )}
      <AnimatePresence initial={false}>
        {sel != null && (
          <motion.div key={sel} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }} className="mt-4 space-y-3 rounded-[10px] bg-raised p-4 ring-1 ring-inset ring-border">
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold">{t('Tooth {n}', { n: sel })}</h3>
              <button onClick={() => setSel(null)} className="press rounded-md p-1 text-muted hover:bg-active" aria-label={t('Close')}><X className="size-4" /></button>
            </div>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('Condition')}>
              {CONDITIONS.map(c => (
                <button key={c.key} type="button" role="radio" aria-checked={form.condition === c.key} onClick={() => setForm(f => ({ ...f, condition: c.key }))}
                  className={cx('press inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px]',
                    form.condition === c.key ? 'bg-ink text-white' : 'bg-sheet ring-1 ring-inset ring-border hover:bg-active/50')}>
                  <span className={cx('size-2.5 rounded-[3px] ring-1 ring-inset', c.cls)} />{t(c.label)}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] text-muted">{t('Surfaces')}</span>
              {SURFACES.map(sf => {
                const on = form.surfaces.includes(sf);
                return <button key={sf} type="button" aria-pressed={on} onClick={() => setForm(f => ({ ...f, surfaces: on ? f.surfaces.filter(x => x !== sf) : [...f.surfaces, sf] }))}
                  className={cx('press size-8 rounded-[7px] text-[12.5px] font-semibold', on ? 'bg-accent text-white' : 'bg-sheet text-muted ring-1 ring-inset ring-border')}>{sf}</button>;
              })}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('Planned work')}><Input value={form.planned} onChange={e => setForm(f => ({ ...f, planned: e.target.value }))} placeholder="حشو عصب + طربوش" /></Field>
              <Field label={t('Notes')}><Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <div className="flex gap-2">
                {map.has(sel) && <Button size="sm" variant="ghost" onClick={() => save(true)}>{t('Clear')}</Button>}
                {onPlanTooth && form.planned && <Button size="sm" variant="outline" onClick={() => onPlanTooth(sel, form.planned)}><Plus className="size-3.5" aria-hidden />{t('Add to a treatment plan')}</Button>}
              </div>
              <Button size="sm" variant="accent" busy={busy} onClick={() => save()}>{t('Save tooth {n}', { n: sel })}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

const PLAN_STATUS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'caution' }> = {
  draft: { label: 'Draft', tone: 'neutral' }, quoted: { label: 'Quote sent', tone: 'caution' }, accepted: { label: 'Accepted', tone: 'accent' },
  in_progress: { label: 'In progress', tone: 'accent' }, done: { label: 'Finished', tone: 'positive' }, cancelled: { label: 'Cancelled', tone: 'neutral' }
};

export function Plans({ patientId, plans, onChanged, draftTooth, onDraftUsed }:
  { patientId: number; plans: Plan[]; onChanged: () => void; draftTooth?: { tooth: number; planned: string | null } | null; onDraftUsed?: () => void }) {
  const { tenant } = useTenant();
  const { t } = useLang();
  const { busy, run } = useAction();
  const toast = useToast();
  const [edit, setEdit] = useState<Plan | null | 'new'>(null);
  useEffect(() => { if (draftTooth) setEdit('new'); }, [draftTooth]);
  const sym = tenant.currency_symbol;

  const quote = async (p: Plan) => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('plan_quote', { p_plan: p.id });
      if (error) throw new Error(error.message);
      return okOrThrow(data as { ok?: boolean; error?: string });
    });
    if (r) { ping(); toast(t('The quote is on its way on WhatsApp. When the patient replies “OK”, the assistant books the first session.')); onChanged(); }
  };
  const accept = async (p: Plan) => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('save_plan', { p_patient: patientId, p: { id: p.id, status: 'accepted' } });
      if (error) throw new Error(error.message);
      return data;
    }, t('Marked as accepted.'));
    if (r) onChanged();
  };

  return (
    <Card title={t('Treatment plans')} sub={t('Each item is a tooth, a treatment and its price; the patient gets the total on WhatsApp.')}
      action={<Button size="sm" variant="outline" onClick={() => setEdit('new')}><Plus className="size-3.5" aria-hidden />{t('New plan')}</Button>}>
      {plans.length === 0 ? <Empty>{t('No treatment plan yet.')}</Empty> : (
        <div className="space-y-4">
          {plans.map(p => {
            const sessions = p.items.reduce((s, i) => s + (i.status === 'cancelled' ? 0 : i.sessions), 0);
            const done = p.items.reduce((s, i) => s + Math.min(i.done_sessions, i.sessions), 0);
            const st = PLAN_STATUS[p.status] || PLAN_STATUS.draft;
            return (
              <section key={p.id} className="rounded-[10px] ring-1 ring-inset ring-border">
                <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold"><bdi>{p.title}</bdi><Pill tone={st.tone}>{t(st.label)}</Pill></p>
                    <p className="text-xs text-muted"><bdi>{p.doctor}</bdi> · {dateShort(p.created_at, tenant.timezone)}{p.quoted_at ? ` · ${t('quote sent {d}', { d: dateShort(p.quoted_at, tenant.timezone) })}` : ''}</p>
                  </div>
                  <p className="text-end">
                    <span className="block text-[17px] font-semibold tabular-nums">{money(p.total, sym)}</span>
                    {p.discount > 0 && <span className="block text-xs text-muted">{t('after {d} off', { d: money(p.discount, sym) })}</span>}
                  </p>
                </header>
                {sessions > 0 && p.status !== 'draft' && (
                  <div className="px-4 pb-3">
                    <div className="h-1.5 overflow-hidden rounded-full bg-rule"><span className="c-bar block h-full rounded-full bg-positive" style={{ width: `${(done / sessions) * 100}%` }} /></div>
                    <p className="mt-1 text-xs text-muted">{t('{done} of {n} sessions done', { done, n: sessions })}</p>
                  </div>
                )}
                <ul className="divide-y divide-rule border-t border-rule text-[13px]">
                  {p.items.map(i => (
                    <li key={i.id} className={cx('grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2', i.status === 'cancelled' && 'text-faint line-through')}>
                      <span className="tabular-nums text-muted">{i.tooth ? `#${i.tooth}` : '—'}</span>
                      <span className="min-w-0"><bdi className="block truncate">{i.label}</bdi>
                        <span className="text-xs text-muted">{i.sessions > 1 ? t('{done}/{n} sessions', { done: i.done_sessions, n: i.sessions }) : i.status === 'done' ? t('Done') : i.status === 'booked' ? t('Booked') : ''}</span></span>
                      <span className="tabular-nums">{i.price != null ? money(i.price, sym) : '—'}</span>
                    </li>
                  ))}
                </ul>
                <footer className="flex flex-wrap justify-end gap-2 border-t border-rule px-4 py-2.5">
                  {['draft', 'quoted'].includes(p.status) && <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>{t('Edit')}</Button>}
                  {p.status === 'quoted' && <Button size="sm" variant="outline" busy={busy} onClick={() => accept(p)}>{t('Patient agreed')}</Button>}
                  {['draft', 'quoted'].includes(p.status) && p.items.length > 0 &&
                    <Button size="sm" variant="accent" busy={busy} onClick={() => quote(p)}><Send className="size-3.5 rtl:-scale-x-100" aria-hidden />{p.status === 'quoted' ? t('Send again') : t('Send the quote on WhatsApp')}</Button>}
                </footer>
              </section>
            );
          })}
        </div>
      )}
      <PlanEditor patientId={patientId} plan={edit === 'new' ? null : edit} open={edit !== null} draftTooth={edit === 'new' ? draftTooth : null}
        onClose={() => { setEdit(null); onDraftUsed?.(); }} onSaved={() => { setEdit(null); onDraftUsed?.(); onChanged(); }} />
    </Card>
  );
}

type Row = { id?: number; tooth: string; service_id: string; label: string; price: string; sessions: string; status?: string };
function PlanEditor({ patientId, plan, open, onClose, onSaved, draftTooth }:
  { patientId: number; plan: Plan | null; open: boolean; onClose: () => void; onSaved: () => void; draftTooth?: { tooth: number; planned: string | null } | null }) {
  const { tenant } = useTenant();
  const { t, lang } = useLang();
  const { services, doctors } = useClinic();
  const { busy, run } = useAction();
  const [title, setTitle] = useState('');
  const [doctor, setDoctor] = useState<string | null>(null);
  const [discount, setDiscount] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const dental = services.filter(s => s.is_active && (s.specialty === 'dentistry' || !s.specialty));
  const dentist = doctors.find(d => d.is_active && d.specialty === 'dentistry');

  useEffect(() => {
    if (!open) return;
    setTitle(plan?.title || t('Treatment plan'));
    setDoctor(plan?.doctor_id || tenant.doctor_id || dentist?.id || null);
    setDiscount(plan?.discount ? String(plan.discount) : '');
    setNotes(plan?.notes || '');
    const base: Row[] = (plan?.items || []).map((i: PlanItem) => ({ id: i.id, tooth: i.tooth ? String(i.tooth) : '', service_id: i.service_id || '', label: i.label,
      price: i.price != null ? String(i.price) : '', sessions: String(i.sessions), status: i.status }));
    if (draftTooth) base.push({ tooth: String(draftTooth.tooth), service_id: '', label: draftTooth.planned || '', price: '', sessions: '1' });
    setRows(base.length ? base : [{ tooth: '', service_id: '', label: '', price: '', sessions: '1' }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan, draftTooth]);

  const setRow = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, k) => k === i ? { ...r, ...patch } : r));
  const pickService = (i: number, id: string) => {
    const s = services.find(x => x.id === id);
    setRow(i, { service_id: id, label: s ? serviceName(s, 'ar') : rows[i].label, price: s?.price != null ? String(s.price) : rows[i].price, sessions: s ? String(s.sessions || 1) : rows[i].sessions });
  };
  const subtotal = rows.reduce((s, r) => s + (Number(r.price) || 0), 0);
  const total = Math.max(0, subtotal - (Number(discount) || 0));

  const save = async () => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('save_plan', { p_patient: patientId, p: { id: plan?.id || null, title, doctor_id: doctor, discount: Number(discount) || 0, notes,
        items: rows.filter(r => r.label.trim() || r.service_id).map(r => ({ id: r.id || null, tooth: r.tooth || null, service_id: r.service_id || null, label: r.label,
          price: r.price === '' ? null : Number(r.price), sessions: Number(r.sessions) || 1, status: r.status })) } });
      if (error) throw new Error(error.message);
      return data as { ok: boolean; total: number };
    }, t('Plan saved.'));
    if (r) onSaved();
  };

  return (
    <Drawer open={open} onClose={onClose} title={plan ? t('Edit the plan') : t('New treatment plan')} width="max-w-[640px]"
      footer={<>
        <span className="me-auto text-[13px] text-muted">{t('Total')} <b className="ms-1 text-[16px] font-semibold tabular-nums text-ink"><CountUp value={total} format={v => money(v, tenant.currency_symbol)} /></b></span>
        <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="accent" busy={busy} onClick={save}>{t('Save the plan')}</Button>
      </>}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Title')}><Input value={title} onChange={e => setTitle(e.target.value)} /></Field>
          <Field label={t('Discount')}><Input inputMode="numeric" value={discount} onChange={e => setDiscount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></Field>
        </div>
        {doctors.filter(d => d.is_active).length > 1 && <Field label={t('Doctor')}><DoctorPick doctors={doctors} value={doctor} onChange={setDoctor} layout="plan-doc" /></Field>}
        <div>
          <p className="mb-2 text-[13px] font-medium">{t('Items')}</p>
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {rows.map((r, i) => (
                <motion.div key={r.id ?? `n${i}`} layout initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 8, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                  className="grid grid-cols-[64px_minmax(0,1fr)_32px] gap-2 rounded-[9px] bg-raised p-2 ring-1 ring-inset ring-border sm:grid-cols-[64px_minmax(0,1.4fr)_minmax(0,1fr)_96px_64px_32px]">
                  <Input aria-label={t('Tooth')} placeholder={t('Tooth')} inputMode="numeric" value={r.tooth} onChange={e => setRow(i, { tooth: e.target.value.replace(/\D/g, '').slice(0, 2) })} className="text-center tabular-nums" />
                  <Select aria-label={t('Treatment')} value={r.service_id} onChange={e => pickService(i, e.target.value)}>
                    <option value="">{t('Treatment…')}</option>
                    {dental.map(s => <option key={s.id} value={s.id}>{serviceName(s, lang)}</option>)}
                  </Select>
                  <button onClick={() => setRows(rs => rs.filter((_, k) => k !== i))} disabled={r.status && r.status !== 'planned' ? true : undefined}
                    className="press flex size-9 items-center justify-center rounded-[7px] text-muted hover:bg-active disabled:opacity-30 sm:order-last" aria-label={t('Remove')}><Trash2 className="size-4" /></button>
                  <Input aria-label={t('Label')} placeholder={t('What, in words')} value={r.label} onChange={e => setRow(i, { label: e.target.value })} className="col-span-3 sm:col-span-1" />
                  <Input aria-label={t('Price')} placeholder={t('Price')} inputMode="numeric" value={r.price} onChange={e => setRow(i, { price: e.target.value.replace(/[^\d.]/g, '') })} className="col-span-2 tabular-nums sm:col-span-1" />
                  <Input aria-label={t('Sessions')} title={t('Sessions')} inputMode="numeric" value={r.sessions} onChange={e => setRow(i, { sessions: e.target.value.replace(/\D/g, '') })} className="text-center tabular-nums" />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setRows(rs => [...rs, { tooth: '', service_id: '', label: '', price: '', sessions: '1' }])}><Plus className="size-3.5" aria-hidden />{t('Add an item')}</Button>
        </div>
        <Field label={t('Notes for the patient')}><Textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="ممكن التقسيط على 6 شهور" /></Field>
        {dentist && <p className="text-xs text-muted">{t('Prices start from {doc}’s list in Services & prices; change any of them here.', { doc: docName(dentist, lang) })}</p>}
      </div>
    </Drawer>
  );
}
