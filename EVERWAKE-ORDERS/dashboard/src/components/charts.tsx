'use client';
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
export function AreaChart({ points, format, height = 230 }: {
  points: { label: string; long: string; value: number }[]; format: (v: number) => string; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const pad = { l: 52, r: 12, t: 12, b: 28 };
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b;
  const { top, step } = niceScale(Math.max(...points.map(p => p.value), 0));
  const x = (i: number) => pad.l + (points.length < 2 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 70))));
  const near = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect(), px = clientX - r.left;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(((px - pad.l) / iw) * (points.length - 1)))));
  };
  return (
    <div ref={ref} dir="ltr" className="relative">
      <svg width={w} height={height} className="block touch-none" role="img"
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
        </div>
      )}
    </div>
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
      <svg width={w} height={height} className="block" role="img" onPointerLeave={() => setHover(null)}>
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
export function RankList({ rows, format }: { rows: { label: string; value: number; sub?: string }[]; format: (v: number) => string }) {
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
            <bdi className="min-w-0 flex-1 truncate font-medium text-ink">{r.label}</bdi>
            {r.sub && <span className="shrink-0 text-xs tabular-nums text-muted">{r.sub}</span>}
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
