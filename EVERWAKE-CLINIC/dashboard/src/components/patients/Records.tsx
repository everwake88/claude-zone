'use client';
import { Plus, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { cx, dateShort } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { Button, Card, Input, Select, useAction } from '../ui';
import { useTenant } from '../tenant';
import type { RecordRow } from './types';

type Table = 'conditions' | 'allergies' | 'medications' | 'patient_history';
const SPEC: Record<Table, { title: string; main: string; mainLabel: string; extra?: { key: string; label: string }[]; empty: string; tone?: string }> = {
  allergies: { title: 'Allergies', main: 'substance', mainLabel: 'Allergic to', extra: [{ key: 'reaction', label: 'Reaction' }], empty: 'No known allergies recorded.', tone: 'critical' },
  conditions: { title: 'Conditions', main: 'name', mainLabel: 'Condition', extra: [{ key: 'since', label: 'Since' }], empty: 'No conditions recorded.' },
  medications: { title: 'Medicines', main: 'name', mainLabel: 'Medicine', extra: [{ key: 'dose', label: 'Dose' }, { key: 'frequency', label: 'How often' }], empty: 'No medicines recorded.' },
  patient_history: { title: 'History', main: 'title', mainLabel: 'What', extra: [{ key: 'detail', label: 'Detail' }], empty: 'No surgeries, family or social history recorded.' }
};
const HISTORY_KINDS = ['surgery', 'family', 'social', 'obstetric', 'vaccination', 'hospitalization', 'other'];
const HISTORY_LABEL: Record<string, string> = { surgery: 'Surgery', family: 'Family', social: 'Social', obstetric: 'Pregnancy', vaccination: 'Vaccination', hospitalization: 'Hospital stay', other: 'Other' };

// One list of the patient's record (allergies, conditions, medicines, history): add a line, stop or remove one.
export function RecordList({ patientId, table, rows, onChanged }: { patientId: number; table: Table; rows: RecordRow[]; onChanged: () => void }) {
  const { t } = useLang();
  const { tenant, can } = useTenant();
  const { busy, run } = useAction();
  const spec = SPEC[table];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const save = async (p: Record<string, unknown>) => {
    const r = await run(async () => {
      const { data, error } = await sb().rpc('save_record', { p_patient: patientId, p_table: table, p });
      if (error) throw new Error(error.message);
      return data;
    });
    if (r) { setAdding(false); setForm({}); onChanged(); }
  };
  const active = (r: RecordRow) => !r.status || r.status === 'active' || r.status === 'chronic';

  return (
    <Card title={t(spec.title)} pad={false}
      action={can.clinical && !adding ? <Button size="sm" variant="ghost" onClick={() => { setAdding(true); setForm(table === 'patient_history' ? { kind: 'surgery' } : {}); }}><Plus className="size-3.5" aria-hidden />{t('Add')}</Button> : undefined}>
      <ul className="divide-y divide-rule">
        <AnimatePresence initial={false}>
          {rows.map(r => (
            <motion.li key={r.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }}
              className="group flex items-start gap-3 px-5 py-2.5">
              <div className={cx('min-w-0 flex-1', !active(r) && 'text-faint')}>
                <p className={cx('text-[13.5px] font-medium', spec.tone === 'critical' && active(r) && 'text-critical-ink', !active(r) && 'line-through')}>
                  {table === 'patient_history' && <span className="me-1.5 text-xs font-normal text-muted">{t(HISTORY_LABEL[String(r.kind)] || String(r.kind))}</span>}
                  <bdi>{String(r[spec.main] ?? '')}</bdi>
                </p>
                <p className="text-xs text-muted">
                  {(spec.extra || []).map(e => r[e.key]).filter(Boolean).map((v, i) => <bdi key={i}>{i > 0 ? ' · ' : ''}{String(v)}</bdi>)}
                  {r.source && r.source !== 'manual' ? <span className="text-faint"> · {t(r.source === 'agent' ? 'from WhatsApp' : r.source === 'scribe' ? 'from the visit recording' : String(r.source))}</span> : null}
                  <span className="text-faint"> · {dateShort(r.created_at, tenant.timezone)}</span>
                </p>
              </div>
              {can.clinical && (
                <div className="flex shrink-0 gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                  {table === 'medications' && active(r) && <button onClick={() => save({ id: r.id, status: 'stopped', stopped_on: new Date().toISOString().slice(0, 10) })} className="press rounded-lg px-2 py-1 text-xs text-muted ring-1 ring-inset ring-border hover:bg-raised">{t('Stopped')}</button>}
                  {table === 'conditions' && active(r) && <button onClick={() => save({ id: r.id, status: 'resolved' })} className="press rounded-lg px-2 py-1 text-xs text-muted ring-1 ring-inset ring-border hover:bg-raised">{t('Resolved')}</button>}
                  <button onClick={() => save({ id: r.id, delete: true })} className="press rounded-lg p-1.5 text-muted hover:bg-raised hover:text-critical" aria-label={t('Remove')}><Trash2 className="size-3.5" /></button>
                </div>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
        {rows.length === 0 && !adding && <li className="px-5 py-3 text-[13px] text-muted">{t(spec.empty)}</li>}
      </ul>
      {adding && (
        <form className="c-fade flex flex-wrap items-end gap-2 border-t border-rule bg-raised/60 px-5 py-3" onSubmit={e => { e.preventDefault(); if (form[spec.main]?.trim()) save({ ...form }); }}>
          {table === 'patient_history' && (
            <Select aria-label={t('Kind')} value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value }))} className="!w-36">
              {HISTORY_KINDS.map(k => <option key={k} value={k}>{t(HISTORY_LABEL[k])}</option>)}
            </Select>
          )}
          <Input autoFocus aria-label={t(spec.mainLabel)} placeholder={t(spec.mainLabel)} value={form[spec.main] || ''} onChange={e => setForm(f => ({ ...f, [spec.main]: e.target.value }))} className="min-w-40 flex-1" />
          {(spec.extra || []).map(e => <Input key={e.key} aria-label={t(e.label)} placeholder={t(e.label)} value={form[e.key] || ''} onChange={ev => setForm(f => ({ ...f, [e.key]: ev.target.value }))} className="min-w-28 flex-1" />)}
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('Cancel')}</Button>
          <Button size="sm" type="submit" busy={busy}>{t('Add')}</Button>
        </form>
      )}
    </Card>
  );
}

// blood pressure over the visits, drawn by hand: two lines and the last reading
export function Vitals({ rows }: { rows: RecordRow[] }) {
  const { t } = useLang();
  const { tenant } = useTenant();
  const bp = rows.filter(r => r.bp_sys && r.bp_dia).slice(0, 12).reverse();
  const last = rows[0];
  if (!last) return null;
  const W = 280, H = 72;
  const lo = Math.min(...bp.map(r => Number(r.bp_dia))) - 8, hi = Math.max(...bp.map(r => Number(r.bp_sys))) + 8;
  const x = (i: number) => (bp.length < 2 ? W / 2 : (i / (bp.length - 1)) * (W - 12) + 6);
  const y = (v: number) => H - ((v - lo) / Math.max(hi - lo, 1)) * (H - 10) - 5;
  const line = (k: string) => bp.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(r[k])).toFixed(1)}`).join(' ');
  const facts = [
    last.bp_sys && last.bp_dia ? [t('Blood pressure'), `${last.bp_sys}/${last.bp_dia}`] : null,
    last.pulse ? [t('Pulse'), `${last.pulse}`] : null, last.temp_c ? [t('Temperature'), `${last.temp_c}°`] : null,
    last.spo2 ? [t('Oxygen'), `${last.spo2}%`] : null, last.weight_kg ? [t('Weight'), `${Number(last.weight_kg)} kg`] : null,
    last.glucose ? [t('Sugar'), `${last.glucose}`] : null
  ].filter(Boolean) as string[][];
  return (
    <Card title={t('Vitals')} sub={t('Last taken {d}', { d: dateShort(String(last.taken_at), tenant.timezone) })}>
      <dl className="grid grid-cols-3 gap-3">
        {facts.map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="text-[15px] font-semibold tabular-nums" dir="ltr">{v}</dd></div>)}
      </dl>
      {bp.length > 1 && (
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 h-[72px] w-full" role="img" aria-label={t('Blood pressure over the last visits')}>
          <path d={line('bp_sys')} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <path d={line('bp_dia')} fill="none" stroke="var(--color-accent-track)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {bp.map((r, i) => <circle key={i} cx={x(i)} cy={y(Number(r.bp_sys))} r={i === bp.length - 1 ? 3.5 : 2} fill="var(--color-accent)" />)}
        </svg>
      )}
    </Card>
  );
}
