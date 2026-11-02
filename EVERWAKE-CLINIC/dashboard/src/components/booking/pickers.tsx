'use client';
import { Check } from 'lucide-react';
import { motion } from 'motion/react';
import { docName, placeName } from '@/lib/clinic-data';
import { cx } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import type { Doctor, Location } from '@/lib/types';

// a doctor's own colour, as a small dot beside their name everywhere
export const DocDot = ({ color, className }: { color?: string | null; className?: string }) =>
  <span aria-hidden className={cx('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: color || 'var(--color-accent)' }} />;

// choosing one of a few: the doctors, the locations — chips that show the choice
export function ChipPick<T extends { id: string }>({ items, value, onChange, label, render, layout = 'pick' }:
  { items: T[]; value: string | null; onChange: (id: string) => void; label: string; render: (x: T) => React.ReactNode; layout?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map(x => {
        const on = x.id === value;
        return (
          <button key={x.id} type="button" role="radio" aria-checked={on} onClick={() => onChange(x.id)}
            className={cx('press relative inline-flex h-9 items-center gap-2 rounded-[8px] px-3 text-[13px]', on ? 'font-medium text-accent-ink' : 'text-ink ring-1 ring-inset ring-border hover:bg-raised')}>
            {on && <motion.span layoutId={`chip-${layout}`} className="absolute inset-0 rounded-[8px] bg-accent-soft ring-1 ring-inset ring-accent/40"
                                transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }} />}
            <span className="relative inline-flex items-center gap-2">{render(x)}{on && <Check className="size-3.5" aria-hidden />}</span>
          </button>
        );
      })}
    </div>
  );
}

export function DoctorPick({ doctors, value, onChange, layout = 'doc' }: { doctors: Doctor[]; value: string | null; onChange: (id: string) => void; layout?: string }) {
  const { t, lang } = useLang();
  return <ChipPick items={doctors.filter(d => d.is_active)} value={value} onChange={onChange} label={t('Doctor')} layout={layout}
           render={d => <><DocDot color={d.color} />{docName(d, lang)}</>} />;
}
export function PlacePick({ locations, value, onChange, layout = 'loc' }: { locations: Location[]; value: string | null; onChange: (id: string) => void; layout?: string }) {
  const { t, lang } = useLang();
  return <ChipPick items={locations.filter(l => l.is_active)} value={value} onChange={onChange} label={t('Location')} layout={layout}
           render={l => placeName(l, lang)} />;
}
