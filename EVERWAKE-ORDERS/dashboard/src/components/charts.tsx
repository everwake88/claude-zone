'use client';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';

// Small charts drawn in SVG, in the restaurant's own colours (the theme's accent ink
// for the data that matters, greys for comparison). One series per chart, round
// ticks from zero, a hover readout on every mark, and one entrance when they first
// appear: lines draw themselves in, bars grow from the baseline. Time runs left to
// right in both languages, the way the numbers in it read.

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// round, even steps that end above the largest value
export function niceScale(max: number, ticks = 4) {
  if (!(max > 0)) return { top: ticks, step: 1 };
  const raw = max / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s * ticks >= max * 1.05) || 10 * mag;
  return { top: step * ticks, step };
}

const tip = 'pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-navy px-2.5 py-1.5 text-xs text-white shadow-lg';

// ---- the small trend on a number ---------------------------------------------------------
export function Sparkline({ values, className, color = 'var(--color-gold-ink)' }: { values: number[]; className?: string; color?: string }) {
  const id = useId();
  const W = 96, H = 34, max = Math.max(...values, 1);
  const pts = values.map((v, i) => [values.length < 2 ? W : (i / (values.length - 1)) * W, H - 3 - (v / max) * (H - 6)]);
  if (pts.length < 2) return null;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cx('h-[34px] w-24 overflow-visible', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${W} ${H} L0 ${H} Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" pathLength={1}
        style={{ strokeDasharray: 1, ['--len' as string]: 1, animation: reduced() ? undefined : 'ew-draw .9s cubic-bezier(.23,1,.32,1) .15s backwards' }} />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill={color} />
    </svg>
  );
}

// ---- a value over days -----------------------------------------------------------------------
export function AreaChart({ points, format, height = 230, compare, compareLabel }: {
  points: { label: string; long: string; value: number }[]; format: (v: number) => string; height?: number;
  // the period before, slot for slot: drawn as a grey dashed line so this period reads against it
  compare?: number[]; compareLabel?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const pad = { l: 52, r: 12, t: 12, b: 28 };
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
  const { top, step } = niceScale(Math.max(...points.map(p => p.value), ...(compare || []), 0));
  const x = (i: number) => pad.l + (points.length < 2 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const before = compare && compare.length === points.length
    ? compare.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ') : null;
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 70))));
  const near = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect(), px = clientX - r.left;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(((px - pad.l) / iw) * (points.length - 1)))));
  };
  return (
    <div ref={ref} dir="ltr" className="relative">
      <svg width={w} height={height} className="block max-w-full touch-none" role="img"
        onPointerMove={e => near(e.clientX, e.currentTarget)} onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--color-gold)" stopOpacity=".28" /><stop offset="1" stopColor="var(--color-gold)" stopOpacity="0" />
          </linearGradient>
          <clipPath id={id + 'c'}><rect x="0" y="0" height={height} width={w}
            style={{ transformOrigin: 'left', animation: reduced() ? undefined : 'ew-grow-x 1s cubic-bezier(.23,1,.32,1) backwards' }} /></clipPath>
        </defs>
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map(v => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="var(--color-hairline)" strokeWidth={v === 0 ? 1.5 : 1} />
            <text x={pad.l - 10} y={y(v) + 4} textAnchor="end" className="fill-muted text-[11px] tabular-nums">{format(v)}</text>
          </g>
        ))}
        {points.map((p, i) => i % every === 0 && (
          <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : 'middle'} className="fill-muted text-[11px]">{p.label}</text>
        ))}
        <g clipPath={`url(#${id}c)`}>
          {before && <path d={before} fill="none" stroke="var(--color-muted)" strokeOpacity=".55" strokeWidth="1.5" strokeDasharray="4 4" strokeLinejoin="round" />}
          <path d={`${line} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} fill={`url(#${id})`} />
          <path d={line} fill="none" stroke="var(--color-gold-ink)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        </g>
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={y(0)} stroke="var(--color-ink)" strokeOpacity=".18" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(points[hover].value)} r="5" fill="var(--color-gold-ink)" stroke="#fff" strokeWidth="2.5" />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className={tip} style={{ left: x(hover), top: y(points[hover].value) - 10 }}>
          <span className="opacity-70">{points[hover].long}</span> <b className="ms-1 tabular-nums">{format(points[hover].value)}</b>
          {before && compare && <span className="ms-1.5 opacity-70">· {compareLabel ? compareLabel + ' ' : ''}{format(compare[hover])}</span>}
        </div>
      )}
    </div>
  );
}

// the key under a chart with more than one series: each swatch is the mark itself
export function Legend({ items }: { items: { label: string; kind?: 'line' | 'dash' | 'box'; color: string }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      {items.map(i => (
        <li key={i.label} className="flex items-center gap-1.5">
          {i.kind === 'box' ? <span className="size-2.5 rounded-sm" style={{ background: i.color }} aria-hidden />
            : <svg width="18" height="6" aria-hidden><line x1="1" x2="17" y1="3" y2="3" stroke={i.color} strokeWidth={i.kind === 'dash' ? 1.5 : 2.5}
                strokeDasharray={i.kind === 'dash' ? '3 3' : undefined} strokeLinecap="round" /></svg>}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// ---- how much per slot, against a usual day ----------------------------------------------------
export function Columns({ bars, format, height = 200, now }: {
  bars: { label: string; long: string; value: number; usual?: number }[]; format: (v: number) => string; height?: number; now?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 34, r: 6, t: 10, b: 26 };
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
  const { top, step } = niceScale(Math.max(...bars.map(b => Math.max(b.value, b.usual || 0)), 0), 3);
  const slot = iw / Math.max(1, bars.length), bw = Math.max(4, Math.min(22, slot * 0.62));
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const every = Math.max(1, Math.ceil(bars.length / Math.max(3, Math.floor(iw / 44))));
  return (
    <div ref={ref} dir="ltr" className="relative">
      <svg width={w} height={height} className="block max-w-full" role="img" onPointerLeave={() => setHover(null)}>
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map(v => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="var(--color-hairline)" strokeWidth={v === 0 ? 1.5 : 1} />
            <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="fill-muted text-[11px] tabular-nums">{format(v)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const cx0 = pad.l + slot * i + slot / 2, isNow = now === i;
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              {b.usual !== undefined && b.usual > 0 && (
                <rect x={cx0 - bw / 2 - 2} y={y(b.usual)} width={bw + 4} height={y(0) - y(b.usual)} rx="4" fill="var(--color-ink)" fillOpacity=".07" />
              )}
              {b.value > 0 && (
                <rect x={cx0 - bw / 2} y={y(b.value)} width={bw} height={y(0) - y(b.value)} rx="4"
                  fill={isNow ? 'var(--color-gold)' : 'var(--color-gold-ink)'} fillOpacity={hover === null || hover === i ? 1 : 0.45}
                  style={{ transformOrigin: `${cx0}px ${y(0)}px`, transformBox: 'view-box',
                           animation: reduced() ? undefined : `ew-grow .7s cubic-bezier(.23,1,.32,1) ${Math.min(i * 25, 500)}ms backwards`,
                           transition: 'fill-opacity .15s' }} />
              )}
              {isNow && <circle cx={cx0} cy={height - 4} r="2.5" fill="var(--color-gold-ink)" />}
              {i % every === 0 && <text x={cx0} y={height - 10} textAnchor="middle" className="fill-muted text-[11px]">{b.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className={tip} style={{ left: pad.l + slot * hover + slot / 2, top: y(Math.max(bars[hover].value, bars[hover].usual || 0)) - 8 }}>
          <span className="opacity-70">{bars[hover].long}</span> <b className="ms-1 tabular-nums">{format(bars[hover].value)}</b>
          {bars[hover].usual !== undefined && <span className="ms-1.5 opacity-70">/ {format(Math.round((bars[hover].usual || 0) * 10) / 10)}</span>}
        </div>
      )}
    </div>
  );
}

// ---- shares of a whole: a thin ring with its legend as a small table ---------------------------
export function Ring({ parts, center, size = 148 }: { parts: { label: string; value: number; color: string; note?: string }[]; center: ReactNode; size?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = size / 2 - 10, C = 2 * Math.PI * r, gap = parts.filter(p => p.value > 0).length > 1 ? 3 : 0;
  let at = 0;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-paper-sunk)" strokeWidth="14" />
          {total > 0 && parts.map((p, i) => {
            const len = (p.value / total) * C, seg = Math.max(0, len - gap), off = at; at += len;
            return p.value > 0 && (
              <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.color} strokeWidth={hover === i ? 18 : 14} strokeLinecap="butt"
                strokeDasharray={`${seg} ${C - seg}`} strokeDashoffset={-off} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
                style={{ transition: 'stroke-width .15s', ['--len' as string]: C, animation: reduced() ? undefined : `ew-ring-in .9s cubic-bezier(.23,1,.32,1) ${i * 120}ms backwards` }} />
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>
      </div>
      <ul className="min-w-44 flex-1 basis-44 space-y-2.5 text-sm">
        {parts.map((p, i) => (
          <li key={p.label} className={cx('flex items-center gap-2.5 transition-opacity duration-150', hover !== null && hover !== i && 'opacity-50')}
              onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink">{p.label}</span>
            <span className="tabular-nums text-muted">{total ? Math.round((p.value / total) * 100) : 0}%</span>
            <span className="w-12 text-end font-semibold tabular-nums text-ink">{p.note ?? p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- who ranks: rows whose fill is the bar ----------------------------------------------------
// `trend`: the change against the period before, in percent (more is good: green up, red down);
// `badge`: a short word in its place when there is nothing to compare with ("New")
export function RankList({ rows, format }: {
  rows: { label: string; value: number; sub?: string; trend?: number | null; badge?: string }[]; format: (v: number) => string;
}) {
  const max = Math.max(...rows.map(r => r.value), 1);
  return (
    <ol className="space-y-2">
      {rows.map((r, i) => (
        <li key={r.label} className="relative overflow-hidden rounded-[var(--ui-radius-inner)] bg-paper/70 px-3 py-2.5">
          <span aria-hidden className="absolute inset-y-0 start-0 origin-left rounded-[inherit] bg-gold/20 rtl:origin-right"
            style={{ width: `${(r.value / max) * 100}%`,
                     animation: reduced() ? undefined : `ew-grow-x .8s cubic-bezier(.23,1,.32,1) ${i * 70}ms backwards` }} />
          <span className="relative flex items-center gap-3 text-sm">
            <span className="w-4 shrink-0 text-xs font-semibold tabular-nums text-muted">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate font-medium text-ink"><bdi>{r.label}</bdi></span>
            {r.sub && <span className="shrink-0 text-xs tabular-nums text-muted">{r.sub}</span>}
            {r.trend != null && r.trend !== 0 && (
              <span className={cx('flex shrink-0 items-center text-xs font-semibold tabular-nums', r.trend > 0 ? 'text-positive' : 'text-critical')}>
                {r.trend > 0 ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}{Math.abs(r.trend)}%
              </span>
            )}
            {r.badge && <span className="shrink-0 rounded-full bg-positive-wash px-1.5 py-px text-[11px] font-semibold text-positive">{r.badge}</span>}
            <span className="shrink-0 font-semibold tabular-nums text-ink">{format(r.value)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---- one whole split in a bar (delivery / pickup / dine-in) -----------------------------------
export function SplitBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return null;
  return (
    <div>
      <div className="flex h-3 gap-[3px] overflow-hidden rounded-full" dir="ltr">
        {parts.filter(p => p.value > 0).map(p => (
          <span key={p.label} className="h-full first:rounded-s-full last:rounded-e-full" title={`${p.label}: ${p.value}`}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {parts.filter(p => p.value > 0).map(p => (
          <li key={p.label} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: p.color }} aria-hidden />{p.label}
            <b className="font-semibold tabular-nums text-ink">{Math.round((p.value / total) * 100)}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}


// ---- when in the week: days down, hours across, darker where more orders came ------------------
// One hue, pale to full. Hours run from the quietest hour round to it again, so a night that runs
// past midnight stays in one piece; the hours nobody ordered in at either end are left out.
export function Heatmap({ cells, dayNames, hourLabel, format, order = [6, 0, 1, 2, 3, 4, 5], less, more }: {
  cells: { dow: number; hour: number; value: number }[]; dayNames: string[]; hourLabel: (h: number) => string;
  format: (v: number) => string; order?: number[]; less: string; more: string;
}) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const grid = new Map(cells.map(c => [`${c.dow}:${c.hour}`, c.value]));
  const perHour = Array.from({ length: 24 }, (_, h) => cells.filter(c => c.hour === h).reduce((s, c) => s + c.value, 0));
  // the longest run of empty hours, going round the clock; the day starts after it
  let bestLen = 0, bestEnd = 5;
  for (let st = 0; st < 24; st++) {
    let n = 0; while (n < 24 && !perHour[(st + n) % 24]) n++;
    if (n > bestLen) { bestLen = n; bestEnd = (st + n) % 24; }
  }
  const span = bestLen >= 24 ? 24 : 24 - bestLen;
  const hours = Array.from({ length: span }, (_, i) => (bestEnd + i) % 24);
  const max = Math.max(...cells.map(c => c.value), 1);
  const tone = (v: number) => v <= 0 ? 'var(--color-paper-sunk)'
    : `color-mix(in oklab, var(--color-gold-ink) ${Math.round(18 + (v / max) * 82)}%, var(--color-paper))`;
  const every = hours.length > 16 ? 3 : hours.length > 8 ? 2 : 1;
  return (
    <div dir="ltr" className="relative">
      <div className="grid items-center gap-[3px]" style={{ gridTemplateColumns: `minmax(2.75rem, auto) repeat(${hours.length}, minmax(0, 1fr))` }}
        onPointerLeave={() => setHover(null)}>
        {order.map(d => (
          <div key={d} className="contents">
            <span className="pe-2 text-end text-[11px] text-muted">{dayNames[d]}</span>
            {hours.map(h => {
              const v = grid.get(`${d}:${h}`) || 0, on = hover?.d === d && hover?.h === h;
              return (
                <span key={h} onPointerEnter={() => setHover({ d, h })}
                  className={cx('relative aspect-square min-h-3 rounded-[4px] transition-[box-shadow] duration-100', on && 'ring-2 ring-ink/70 ring-offset-1 ring-offset-[var(--ui-card)]')}
                  style={{ background: tone(v) }}>
                  {on && (
                    <span className={cx(tip, 'start-1/2 top-0 -mt-1')} style={{ left: '50%' }}>
                      <span className="opacity-70">{dayNames[d]} · {hourLabel(h)}</span> <b className="ms-1 tabular-nums">{format(v)}</b>
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        ))}
        <span />
        {hours.map((h, i) => <span key={h} className="pt-1 text-center text-[10px] text-muted">{i % every === 0 ? hourLabel(h) : ''}</span>)}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted">
        {less}
        {[0.05, 0.3, 0.55, 0.8, 1].map(k => <span key={k} className="size-3 rounded-[3px]" style={{ background: tone(k * max) }} aria-hidden />)}
        {more}
      </div>
    </div>
  );
}

// ---- people from one step to the next: each bar is a share of the first ----------------------
export function Funnel({ steps, format }: { steps: { label: string; value: number; note?: string }[]; format: (v: number) => string }) {
  const first = Math.max(steps[0]?.value || 0, 1);
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].value : 0, share = prev ? Math.round((s.value / prev) * 100) : null;
        return (
          <li key={s.label}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-ink">{s.label}</span>
              <span className="inline-flex shrink-0 items-baseline gap-1.5 tabular-nums"><b className="font-semibold text-ink">{format(s.value)}</b>
                {share !== null && <span className="text-xs text-muted">{share}%</span>}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-paper-sunk" dir="ltr">
              <span className="block h-full origin-left rounded-full"
                style={{ width: `${Math.max(s.value > 0 ? 2 : 0, (s.value / first) * 100)}%`,
                         background: i === steps.length - 1 ? 'var(--color-gold-ink)' : `color-mix(in oklab, var(--color-gold-ink) ${85 - i * 18}%, var(--color-paper))`,
                         animation: reduced() ? undefined : `ew-grow-x .8s cubic-bezier(.23,1,.32,1) ${i * 90}ms backwards` }} />
            </div>
            {s.note && <p className="mt-1 text-xs text-muted">{s.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}

// ---- per slot, split in parts (new and returning customers), parts stacked with a seam ---------
export function StackColumns({ bars, colors, names, format, height = 190 }: {
  bars: { label: string; long: string; parts: number[] }[]; colors: string[]; names: string[]; format: (v: number) => string; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 34, r: 6, t: 10, b: 26 };
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
  const { top, step } = niceScale(Math.max(...bars.map(b => b.parts.reduce((a, c) => a + c, 0)), 0), 3);
  const slot = iw / Math.max(1, bars.length), bw = Math.max(3, Math.min(20, slot * 0.62));
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const every = Math.max(1, Math.ceil(bars.length / Math.max(3, Math.floor(iw / 48))));
  return (
    <div ref={ref} dir="ltr" className="relative">
      <svg width={w} height={height} className="block max-w-full" role="img" onPointerLeave={() => setHover(null)}>
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map(v => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="var(--color-hairline)" strokeWidth={v === 0 ? 1.5 : 1} />
            <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="fill-muted text-[11px] tabular-nums">{format(v)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const cx0 = pad.l + slot * i + slot / 2;
          let acc = 0;
          return (
            <g key={i} onPointerEnter={() => setHover(i)} opacity={hover === null || hover === i ? 1 : 0.45} style={{ transition: 'opacity .15s' }}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              <g style={{ transformOrigin: `${cx0}px ${y(0)}px`, transformBox: 'view-box',
                          animation: reduced() ? undefined : `ew-grow .7s cubic-bezier(.23,1,.32,1) ${Math.min(i * 20, 400)}ms backwards` }}>
                {b.parts.map((v, k) => {
                  if (v <= 0) return null;
                  const y1 = y(acc + v), h = y(acc) - y1 - (acc > 0 ? 2 : 0); acc += v;
                  return <rect key={k} x={cx0 - bw / 2} y={y1} width={bw} height={Math.max(1, h)} rx="2" fill={colors[k]} />;
                })}
              </g>
              {i % every === 0 && <text x={cx0} y={height - 10} textAnchor="middle" className="fill-muted text-[11px]">{b.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className={tip} style={{ left: pad.l + slot * hover + slot / 2, top: y(bars[hover].parts.reduce((a, c) => a + c, 0)) - 8 }}>
          <span className="opacity-70">{bars[hover].long}</span>
          {bars[hover].parts.map((v, k) => <span key={k} className="ms-2">{names[k]} <b className="tabular-nums">{format(v)}</b></span>)}
        </div>
      )}
    </div>
  );
}

// ---- a chart, or the same numbers as a table (for reading exact values, and for screen readers) --
export function ChartTable({ head, rows, children, label, toolbar }: {
  head: string[]; rows: (string | number)[][]; children: ReactNode; label: { chart: string; table: string }; toolbar?: ReactNode;
}) {
  const [table, setTable] = useState(false);
  return (
    <div className="relative">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">{toolbar}</div>
        <button type="button" onClick={() => setTable(v => !v)} aria-pressed={table}
          className="rounded-full px-2.5 py-1 text-xs font-medium text-muted transition-colors duration-150 hover:bg-paper-sunk hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50">
          {table ? label.chart : label.table}
        </button>
      </div>
      {table ? (
        <div className="max-h-72 overflow-auto rounded-[var(--ui-radius-inner)]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--ui-card)] text-xs text-muted">
              <tr>{head.map((h, i) => <th key={h} className={cx('px-2 py-1.5 font-medium', i ? 'text-end' : 'text-start')}>{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-hairline/70">
              {rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} className={cx('px-2 py-1.5', j ? 'text-end tabular-nums' : 'text-ink')}><bdi>{c}</bdi></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : children}
    </div>
  );
}
