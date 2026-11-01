'use client';
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from 'lucide-react';
import { Sparkline } from '@/components/charts';
import { CountUp } from '@/components/ui';
import { cx } from '@/lib/format';
import { useT } from '@/lib/i18n';

// A change against an earlier figure. Its colour says good or bad, not up or down: more orders is
// good, more cancelled orders or slower cooking is bad. Nothing to compare with says so in grey.
export interface Change {
  value: number | null;            // percent, or points for a rate; null = nothing to compare with
  unit?: '%' | 'pts';
  good?: 'up' | 'down';            // the direction that is good news (default: up)
  baseline: string;                // what it is measured against, in words ("against the previous 7 days")
  fresh?: boolean;                 // the earlier figure was zero: new, not "+100%"
}

export function changeOf(cur: number, prev: number): number | null {
  if (!(prev > 0)) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

export function ChangeLine({ change, fallback, className }: { change?: Change; fallback?: string; className?: string }) {
  const t = useT();
  if (!change || (change.value === null && !change.fresh)) return <p className={cx('flex items-center gap-1 text-xs text-ink/70', className)}>{fallback || '—'}</p>;
  if (change.fresh) return <p className={cx('flex items-center gap-1 text-xs text-ink/70', className)}><b className="font-semibold">{t('New')}</b> {change.baseline}</p>;
  const v = change.value!, good = change.good || 'up';
  const tone = v === 0 ? 'text-muted' : (v > 0) === (good === 'up') ? 'text-positive' : 'text-critical';
  const Icon = v === 0 ? Minus : v > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <p className={cx('flex flex-wrap items-center gap-x-1 text-xs text-ink/70', className)}>
      <span className={cx('flex items-center gap-0.5 font-semibold tabular-nums', tone)}>
        <Icon className="size-3.5" aria-hidden />{v > 0 ? '+' : ''}{v}{change.unit === 'pts' ? ' ' + t('pts') : '%'}
      </span>
      {change.baseline}
    </p>
  );
}

// One headline number in its tinted tile, with its trend and its change.
export function Kpi({ label, value, format, icon: Icon, tint, spark, change, fallback, delay = 0 }: {
  label: string; value: number; format: (v: number) => string; icon: LucideIcon; tint: number;
  spark?: number[]; change?: Change; fallback?: string; delay?: number;
}) {
  const ink = `var(--ui-tint-ink-${tint}, var(--color-gold-ink))`;
  return (
    <div className={cx('ew-card ew-lift ew-rise p-5', `ew-tint-${tint}`)} style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-10 items-center justify-center rounded-[14px] text-white shadow-[0_8px_16px_-10px_rgba(0,0,0,0.5)]" style={{ background: ink }}>
          <Icon className="size-5" aria-hidden />
        </span>
        {spark && spark.some(v => v > 0) && <Sparkline values={spark} color={ink} />}
      </div>
      <p className="mt-4 text-sm text-ink/70">{label}</p>
      <p className="mt-0.5 text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink"><CountUp value={value} format={format} /></p>
      <ChangeLine change={change} fallback={fallback} className="mt-1" />
    </div>
  );
}
