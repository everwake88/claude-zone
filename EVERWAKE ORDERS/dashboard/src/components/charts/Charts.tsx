'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';

// One data hue (single-series charts need no legend; the title names it).
// #2a78d6 passes the dataviz validator on white: lightness band, chroma, ≥3:1.
export const DATA = '#2a78d6';
const GRID = '#E9EDEF';

export interface Point { label: string; value: number; display?: string }

const compact = (n: number) => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(Math.round(n * 100) / 100);
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = [1, 2, 2.5, 5, 10].find(x => x * p >= v) || 10;
  return m * p;
}

// A card that can always switch to a plain table — every value reachable without hover
export function ChartCard({ title, subtitle, rows, children, valueHeader = 'Value' }:
  { title: string; subtitle?: string; rows: Point[]; children: ReactNode; valueHeader?: string }) {
  const [table, setTable] = useState(false);
  return (
    <section className="rounded-xl border border-hairline bg-white p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div><h2 className="text-sm font-semibold">{title}</h2>{subtitle && <p className="text-xs text-muted">{subtitle}</p>}</div>
        <button onClick={() => setTable(t => !t)} className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline">{table ? 'Chart' : 'Table'}</button>
      </header>
      {table ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-sm"><thead className="text-left text-xs text-muted"><tr><th className="py-1">Label</th><th className="py-1 text-right">{valueHeader}</th></tr></thead>
            <tbody className="divide-y divide-hairline">{rows.map(r => <tr key={r.label}><td className="py-1" dir="auto">{r.label}</td><td className="py-1 text-right tabular-nums">{r.display ?? r.value}</td></tr>)}</tbody></table>
        </div>
      ) : children}
    </section>
  );
}

// Vertical columns: ≤24px wide, 4px rounded cap, square at the baseline,
// hairline grid, a hover/focus tooltip per column, the peak labelled.
export function ColumnChart({ data, height = 180, ariaLabel }: { data: Point[]; height?: number; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, padL = 36, padB = 22, padT = 18;
  const max = niceMax(Math.max(0, ...data.map(d => d.value)));
  const band = (W - padL) / Math.max(1, data.length);
  const bw = Math.min(24, Math.max(3, band - 2));
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const every = Math.ceil(data.length / 10);
  const peak = useMemo(() => data.reduce((b, d, i) => d.value > (data[b]?.value ?? -1) ? i : b, 0), [data]);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={ariaLabel}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#51666F">{compact(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = padL + band * i + (band - bw) / 2;
          const top = y(d.value);
          const h = Math.max(0, H - padB - top);
          const r = Math.min(4, h, bw / 2);
          const path = h <= 0 ? '' : `M${x},${H - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - padB} Z`;
          return (
            <g key={i} tabIndex={0} role="graphics-symbol" aria-label={`${d.label}: ${d.display ?? d.value}`}
              onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              className="outline-none">
              <rect x={padL + band * i} y={padT} width={band} height={H - padT - padB} fill="transparent" />
              {path && <path d={path} fill={DATA} opacity={hover === null || hover === i ? 1 : 0.55} />}
              {i === peak && d.value > 0 && hover === null && (
                <text x={x + bw / 2} y={top - 5} textAnchor="middle" fontSize={11} fontWeight={600} fill="#0B222E">{d.display ?? compact(d.value)}</text>
              )}
              {i % every === 0 && <text x={padL + band * i + band / 2} y={H - 6} textAnchor="middle" fontSize={10.5} fill="#51666F">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="pointer-events-none absolute top-0 rounded-lg bg-navy px-2.5 py-1.5 text-xs text-white shadow-lg"
          style={{ left: `${((padL + band * hover + band / 2) / W) * 100}%`, transform: 'translateX(-50%)' }}>
          <p className="font-semibold">{data[hover].display ?? data[hover].value}</p>
          <p className="text-on-navy-muted">{data[hover].label}</p>
        </div>
      )}
    </div>
  );
}

// Horizontal bars as rows: label, a thin bar, the value at its tip
export function BarList({ data, note }: { data: (Point & { note?: string })[]; note?: string }) {
  const max = Math.max(1, ...data.map(d => d.value));
  if (!data.length) return <p className="text-sm text-muted">No data in this period.</p>;
  return (
    <ul className="space-y-2.5">
      {data.map(d => (
        <li key={d.label} className="text-sm" title={`${d.label}: ${d.display ?? d.value}`}>
          <div className="mb-1 flex justify-between gap-3">
            <span className="truncate" dir="auto">{d.label}</span>
            <span className="shrink-0 tabular-nums font-medium">{d.display ?? d.value}{d.note && <span className="ml-1 font-normal text-muted">{d.note}</span>}</span>
          </div>
          <div className="h-2 rounded-r bg-transparent">
            <div className={cx('h-2 rounded-r-[4px]')} style={{ width: `${(d.value / max) * 100}%`, background: DATA }} />
          </div>
        </li>
      ))}
      {note && <li className="text-xs text-muted">{note}</li>}
    </ul>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-white p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}
