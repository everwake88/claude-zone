'use client';
import { Play, Quote, Square } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import type { FieldFill } from '@/lib/scribe/schema';
import { Input, Select, Textarea } from '../ui';
import type { FormField, FormTemplate } from '../patients/types';
import { useVisit } from './context';

export type Values = Record<string, unknown>;
const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// One card per section of the doctor's own form. A field the AI filled has its words one tap away;
// a field it could not stand behind stays empty with a quiet amber edge.
export function FormCards({ template, values, setValue, fills, signed, flash }:
  { template: FormTemplate | null; values: Values; setValue: (k: string, v: unknown) => void; fills: Record<string, FieldFill>; signed: boolean; flash: number }) {
  const { t, lang } = useLang();
  if (!template) return null;
  let n = 0;
  return (
    <>
      {template.schema.sections.map((s, si) => {
        const fields = s.fields.filter(f => f.type !== 'tooth_chart' && f.type !== 'treatment_plan');
        if (!fields.length) return null;
        const filled = fields.filter(f => !empty(values[`${s.key}.${f.key}`])).length;
        return (
          <section key={s.key} className="card c-rise min-w-0" style={{ animationDelay: `${Math.min(si, 5) * 40}ms` }}>
            <header className="flex items-baseline justify-between gap-3 px-5 pt-5">
              <h2 className="truncate text-[15px] font-semibold leading-6">{lang === 'en' ? s.title_en : s.title_ar}</h2>
              <span className="shrink-0 text-[12.5px] tabular-nums text-faint">{t('{n} of {m}', { n: filled, m: fields.length })}</span>
            </header>
            <div className="grid gap-x-4 gap-y-4 p-5 pt-4 sm:grid-cols-2">
              {fields.map(f => {
                const key = `${s.key}.${f.key}`;
                const fill = fills[key];
                const lit = !!fill && !fill.unsupported && same(values[key], fill.value);
                return (
                  <FieldBox key={key} field={f} fill={fill} lit={lit} flash={lit ? `${flash}-${n++}` : ''} wide={['textarea', 'multiselect', 'scale'].includes(f.type)}
                    label={lang === 'en' ? f.label_en : f.label_ar} onUse={v => setValue(key, v)}>
                    <FieldInput field={f} value={values[key]} disabled={signed} onChange={v => setValue(key, v)} />
                  </FieldBox>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}

// a field with its words: the label, the input, and the evidence chip
export function FieldBox({ label, field, fill, lit, flash, wide, children, onUse }:
  { label: ReactNode; field?: FormField; fill?: FieldFill; lit: boolean; flash: string; wide?: boolean; children: ReactNode; onUse?: (v: unknown) => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const { setFocus } = useVisit();
  const unclear = !!fill?.unsupported;
  const toggle = () => { const o = !open; setOpen(o); setFocus(o && fill ? fill.segment_ids : []); };
  return (
    <div className={cx('min-w-0', wide && 'sm:col-span-2')}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-medium text-ink">{label}{field?.unit && <span className="ms-1 font-normal text-faint">({field.unit})</span>}</span>
        {fill && !unclear && fill.quote && (
          <button type="button" onClick={toggle} aria-expanded={open}
            className={cx('press inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium transition-colors',
              lit ? 'bg-gold-wash text-gold-ink hover:bg-gold-line/60' : 'bg-sunk/70 text-muted hover:bg-sunk')}>
            <Quote className="size-3" aria-hidden />{lit ? t('Heard') : t('Edited')}
          </button>
        )}
      </div>
      <div key={flash} className={cx('rounded-xl', flash && 'c-flash', unclear && 'outline-1 outline-dashed outline-offset-2 outline-caution/60')}>{children}</div>
      {unclear && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-snug text-caution">
          {t('Not clear in the recording — fill it in.')}
          {fill.was !== null && fill.was !== undefined && onUse && (
            <button type="button" onClick={() => onUse(fill.was)} className="press rounded-full bg-caution-soft px-2 py-0.5 font-medium hover:bg-caution-line/60">
              {t('Use «{v}»', { v: Array.isArray(fill.was) ? fill.was.join('، ') : fill.was === true ? t('yes') : fill.was === false ? t('no') : String(fill.was) })}
            </button>
          )}
        </p>
      )}
      {open && fill?.quote && <Evidence fill={fill} />}
    </div>
  );
}

function Evidence({ fill }: { fill: FieldFill }) {
  const { t } = useLang();
  const { play, playing, canPlay } = useVisit();
  const seg = fill.segment_ids[0];
  return (
    <div className="c-pop mt-2 flex items-start gap-2.5 rounded-xl bg-raised px-3 py-2.5 ring-1 ring-inset ring-border">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-relaxed text-ink" dir="auto"><bdi>«{fill.quote}»</bdi></p>
        <p className="mt-0.5 text-[11.5px] text-faint">
          {fill.speaker ? t(fill.speaker === 'doctor' ? 'Said by the doctor' : fill.speaker === 'patient' ? 'Said by the patient' : 'Said by someone with them') : t('From the visit')}
          {fill.confidence > 0 && <> · {t('{n}% sure', { n: Math.round(fill.confidence * 100) })}</>}
        </p>
      </div>
      {canPlay && seg && (
        <button type="button" onClick={() => play(seg)} className="press grid size-8 shrink-0 place-items-center rounded-full bg-navy text-gold-bright hover:bg-navy-soft" aria-label={t('Hear that moment')}>
          {playing === seg ? <Square className="size-3 fill-current" aria-hidden /> : <Play className="size-3.5 fill-current" aria-hidden />}
        </button>
      )}
    </div>
  );
}

// the input for one field of the form; a yes/no keeps "not asked" apart from "no"
export function FieldInput({ field: f, value: v, disabled, onChange }: { field: FormField; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  const { t } = useLang();
  switch (f.type) {
    case 'textarea': return <Textarea rows={2} disabled={disabled} value={String(v ?? '')} onChange={e => onChange(e.target.value)} />;
    case 'boolean': return (
      <div className="flex gap-1.5" role="group">
        {[true, false].map(b => (
          <button key={String(b)} type="button" disabled={disabled} aria-pressed={v === b} onClick={() => onChange(v === b ? null : b)}
            className={cx('press h-9 min-w-[64px] rounded-full px-3.5 text-[13px] font-medium transition-colors',
              v === b ? (b ? 'bg-navy text-white' : 'bg-ink/80 text-white') : 'ring-1 ring-inset ring-control hover:bg-raised disabled:opacity-50')}>
            {b ? t('Yes') : t('No')}
          </button>
        ))}
      </div>
    );
    case 'select': return (
      <Select disabled={disabled} value={String(v ?? '')} onChange={e => onChange(e.target.value || null)}>
        <option value="">—</option>{(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
      </Select>
    );
    case 'multiselect': {
      const list = Array.isArray(v) ? (v as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {(f.options || []).map(o => {
            const on = list.includes(o);
            return <button key={o} type="button" disabled={disabled} aria-pressed={on} onClick={() => onChange(on ? list.filter(x => x !== o) : [...list, o])}
              className={cx('press h-8 rounded-full px-3 text-[12.5px] transition-colors', on ? 'bg-navy text-white' : 'ring-1 ring-inset ring-control hover:bg-raised')}>{o}</button>;
          })}
        </div>
      );
    }
    case 'scale': return (
      <div className="flex gap-1">{Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
        <button key={n} type="button" disabled={disabled} aria-pressed={v === n} onClick={() => onChange(v === n ? null : n)}
          className={cx('press h-9 flex-1 rounded-lg text-xs font-medium tabular-nums transition-colors', v === n ? 'bg-navy text-white' : 'ring-1 ring-inset ring-control hover:bg-raised')}>{n}</button>))}
      </div>
    );
    case 'date': return <Input type="date" disabled={disabled} value={String(v ?? '')} onChange={e => onChange(e.target.value || null)} />;
    case 'number': return <Input inputMode="decimal" disabled={disabled} value={String(v ?? '')} onChange={e => onChange(e.target.value === '' ? null : (Number(e.target.value.replace(',', '.')) || e.target.value))} />;
    default: return <Input disabled={disabled} value={String(v ?? '')} onChange={e => onChange(e.target.value)} />;
  }
}
