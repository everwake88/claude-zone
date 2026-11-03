'use client';
import { ArrowRight, Pill as PillIcon, Plus, X } from 'lucide-react';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import type { RecordItem } from '@/lib/scribe/schema';
import { Card, Checkbox, Input } from '../ui';
import { CONDITIONS } from '../patients/Dental';
import type { Tooth } from '../patients/types';

export interface Ticks { allergies: number[]; medications: number[]; conditions: number[]; teeth: number[]; plan_items: number[] }
export interface RxLine { name: string; dose: string; frequency: string; duration: string; notes?: string }
type Fresh = { allergies: RecordItem[]; medications: RecordItem[]; conditions: RecordItem[] };

const toggle = (list: number[], i: number) => (list.includes(i) ? list.filter(x => x !== i) : [...list, i]);
const COND = Object.fromEntries(CONDITIONS.map(c => [c.key, c.label]));

// What this visit adds to the patient's file. Each line waits for a tick: nothing reaches the
// record on the AI's word alone.
export function FindingsCard({ fresh, teeth, planItems, chart, ticks, setTicks, signed, heard, unclear }:
  { fresh: Fresh; teeth: RecordItem[]; planItems: RecordItem[]; chart: Tooth[]; ticks: Ticks; setTicks: (t: Ticks) => void;
    signed: boolean; heard: number; unclear: number }) {
  const { t } = useLang();
  const rows: { group: keyof Ticks; i: number; tone: string; kind: string; label: string; sub?: string | null; quote?: string | null }[] = [
    ...fresh.allergies.map((a, i) => ({ group: 'allergies' as const, i, tone: 'bg-critical-soft text-critical-ink', kind: t('Allergy'), label: String(a.substance), sub: a.reaction as string | null, quote: a.quote })),
    ...fresh.medications.map((a, i) => ({ group: 'medications' as const, i, tone: 'bg-accent-soft text-navy', kind: t('Takes'), label: String(a.name), sub: [a.dose, a.frequency].filter(Boolean).join(' · ') || null, quote: a.quote })),
    ...fresh.conditions.map((a, i) => ({ group: 'conditions' as const, i, tone: 'bg-caution-soft text-caution', kind: t('Condition'), label: String(a.name), quote: a.quote }))
  ];
  const any = rows.length + teeth.length + planItems.length > 0;
  return (
    <Card title={t('New for the record')} sub={any ? t('Only what you tick goes on the file.') : undefined} className="c-rise">
      {!any && <p className="text-[13.5px] text-muted">{t('Nothing new for the file in this visit.')}</p>}
      {rows.length > 0 && (
        <ul className="-mx-2 space-y-0.5">
          {rows.map(r => {
            const on = ticks[r.group].includes(r.i);
            return (
              <li key={`${r.group}-${r.i}`}>
                <label className={cx('flex cursor-pointer items-start gap-3 rounded-xl px-2 py-2 transition-colors', on ? 'bg-gold-wash/70' : 'hover:bg-raised', signed && 'pointer-events-none')}>
                  <input type="checkbox" checked={on} disabled={signed} onChange={() => setTicks({ ...ticks, [r.group]: toggle(ticks[r.group], r.i) })}
                    className="mt-1 size-4 shrink-0 rounded accent-[var(--color-navy)]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={cx('rounded-full px-2 py-px text-[11px] font-semibold', r.tone)}>{r.kind}</span>
                      <bdi className="text-[14px] font-medium">{r.label}</bdi>
                      {r.sub && <bdi className="text-[12.5px] text-muted">{r.sub}</bdi>}
                    </span>
                    {r.quote && <span className="mt-0.5 block truncate text-[12px] text-faint" dir="auto">«{r.quote}»</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {teeth.length > 0 && (
        <div className={cx(rows.length > 0 && 'mt-4 border-t border-rule pt-4')}>
          <p className="mb-1.5 text-[13px] font-semibold">{t('Teeth')}</p>
          <ul className="-mx-2 space-y-0.5">
            {teeth.map((x, i) => {
              const before = chart.find(c => c.tooth === Number(x.tooth));
              const on = ticks.teeth.includes(i);
              return (
                <li key={i}>
                  <label className={cx('flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 transition-colors', on ? 'bg-gold-wash/70' : 'hover:bg-raised', signed && 'pointer-events-none')}>
                    <input type="checkbox" checked={on} disabled={signed} onChange={() => setTicks({ ...ticks, teeth: toggle(ticks.teeth, i) })} className="size-4 shrink-0 rounded accent-[var(--color-navy)]" />
                    <span className="grid h-7 min-w-9 place-items-center rounded-lg bg-navy px-1.5 text-[12.5px] font-semibold tabular-nums text-white">{String(x.tooth)}</span>
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[13.5px]">
                      {before && before.condition !== x.condition && <><span className="text-faint">{t(COND[before.condition] || before.condition)}</span><ArrowRight className="size-3.5 text-faint rtl:rotate-180" aria-hidden /></>}
                      <span className="font-medium">{t(COND[String(x.condition)] || String(x.condition))}</span>
                      {x.planned ? <span className="text-muted">· {t('planned')}: <bdi>{String(x.planned)}</bdi></span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {planItems.length > 0 && (
        <div className={cx((rows.length > 0 || teeth.length > 0) && 'mt-4 border-t border-rule pt-4')}>
          <p className="mb-1.5 text-[13px] font-semibold">{t('Treatment plan')}</p>
          <ul className="-mx-2 space-y-0.5">
            {planItems.map((x, i) => {
              const on = ticks.plan_items.includes(i);
              return (
                <li key={i}>
                  <label className={cx('flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 transition-colors', on ? 'bg-gold-wash/70' : 'hover:bg-raised', signed && 'pointer-events-none')}>
                    <input type="checkbox" checked={on} disabled={signed} onChange={() => setTicks({ ...ticks, plan_items: toggle(ticks.plan_items, i) })} className="size-4 shrink-0 rounded accent-[var(--color-navy)]" />
                    {x.tooth ? <span className="grid h-7 min-w-9 place-items-center rounded-lg bg-sunk px-1.5 text-[12.5px] font-semibold tabular-nums">{String(x.tooth)}</span> : null}
                    <span className="min-w-0 flex-1 text-[13.5px] font-medium"><bdi>{String(x.label)}</bdi></span>
                    {Number(x.sessions) > 1 && <span className="shrink-0 text-[12.5px] text-muted">{t('{n} sessions', { n: Number(x.sessions) })}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-rule pt-3 text-[12.5px]">
        <span className="text-gold-ink">{t('{n} fields filled from their words', { n: heard })}</span>
        {unclear > 0 && <span className="text-caution">{t('{n} not clear, left for you', { n: unclear })}</span>}
      </p>
    </Card>
  );
}

// The prescription: only what the doctor said, every line editable; printed once the visit is signed.
export function PrescriptionCard({ rx, setRx, toMeds, setToMeds, signed }:
  { rx: RxLine[]; setRx: (r: RxLine[]) => void; toMeds: boolean; setToMeds: (v: boolean) => void; signed: boolean }) {
  const { t } = useLang();
  const set = (i: number, k: keyof RxLine, v: string) => setRx(rx.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <Card title={<span className="inline-flex items-center gap-2"><PillIcon className="size-4 text-gold-ink" aria-hidden />{t('Prescription')}</span>}
      sub={signed ? undefined : t('Only what you dictated — check each line.')}
      action={!signed ? <button type="button" onClick={() => setRx([...rx, { name: '', dose: '', frequency: '', duration: '' }])}
        className="press inline-flex h-8 items-center gap-1 rounded-full px-3 text-[13px] font-medium ring-1 ring-inset ring-control hover:bg-raised"><Plus className="size-3.5" aria-hidden />{t('Add a medicine')}</button> : undefined}>
      {rx.length === 0 ? <p className="text-[13.5px] text-muted">{t('No medicine was prescribed in this visit.')}</p> : (
        <ol className="space-y-3">
          {rx.map((l, i) => (
            <li key={i} className="c-pop flex gap-2.5">
              <span className="mt-2.5 w-4 shrink-0 text-[12.5px] font-semibold tabular-nums text-faint">{i + 1}</span>
              <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                <Input disabled={signed} value={l.name} placeholder={t('Medicine')} aria-label={t('Medicine')} onChange={e => set(i, 'name', e.target.value)} className="font-medium" />
                <Input disabled={signed} value={l.dose} placeholder={t('Dose')} aria-label={t('Dose')} onChange={e => set(i, 'dose', e.target.value)} />
                <Input disabled={signed} value={l.frequency} placeholder={t('How often')} aria-label={t('How often')} onChange={e => set(i, 'frequency', e.target.value)} />
                <Input disabled={signed} value={l.duration} placeholder={t('For how long')} aria-label={t('For how long')} onChange={e => set(i, 'duration', e.target.value)} />
              </div>
              {!signed && <button type="button" onClick={() => setRx(rx.filter((_, j) => j !== i))} className="press mt-1 grid size-8 shrink-0 place-items-center rounded-full text-faint hover:bg-sunk/70 hover:text-critical" aria-label={t('Remove')}><X className="size-4" aria-hidden /></button>}
            </li>
          ))}
        </ol>
      )}
      {!signed && rx.length > 0 && <div className="mt-4 border-t border-rule pt-3"><Checkbox checked={toMeds} onChange={setToMeds} label={<span className="text-[13px]">{t('Add them to the patient’s medicines')}</span>} /></div>}
    </Card>
  );
}
