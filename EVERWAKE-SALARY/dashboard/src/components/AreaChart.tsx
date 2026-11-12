'use client';
import { useMemo, useRef, useState } from 'react';

type Point = { d: string; n: number };

// round, even steps above the highest value (0 · 5 · 10 …)
function niceMax(v: number) {
  if (v <= 4) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const m = [1, 2, 2.5, 5, 10].find((s) => s * pow >= v)!;
  return m * pow;
}

// The employees' messages per day. It draws itself from the left when it arrives; hovering (or
// touching) a day shows that day's count.
export function AreaChart({ data, locale, unit, empty }: { data: Point[]; locale: string; unit: string; empty: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const max = niceMax(Math.max(0, ...data.map((p) => p.n)));
  const n = data.length;
  const day = useMemo(() => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }), [locale]);
  const fmt = (s: string) => day.format(new Date(s + 'T12:00:00'));
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 1000 : 500);
  const y = (v: number) => 300 - (v / max) * 300;
  const line = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.n).toFixed(1)}`).join(' ');
  const area = `${line} L1000 300 L0 300 Z`;
  const labelsAt = n <= 7 ? data.map((_, i) => i) : [0, 1, 2, 3, 4].map((k) => Math.round((k * (n - 1)) / 4));
  const total = data.reduce((s, p) => s + p.n, 0);

  const onMove = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || n < 2) return;
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const h = hover == null ? null : data[hover];

  return (
    <div className="chart">
      <div className="ticks" aria-hidden="true">{[max, max / 2, 0].map((t) => <span key={t} className="num">{t}</span>)}</div>
      <svg viewBox="0 0 1000 300" preserveAspectRatio="none" role="img" aria-label={`${total} ${unit}`}>
        <defs>
          <linearGradient id="areaFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5b7b66" stopOpacity="0.22" />
            <stop offset="1" stopColor="#5b7b66" stopOpacity="0" />
          </linearGradient>
          <clipPath id="reveal"><rect className="reveal" x="0" y="-20" width="1000" height="340" /></clipPath>
        </defs>
        <g className="grid">{[0, 150, 300].map((g) => <line key={g} x1="0" x2="1000" y1={g} y2={g} />)}</g>
        <g clipPath="url(#reveal)">
          <path className="area" d={area} />
          <path className="line" d={line} />
        </g>
        {h && <line className="hover-line" x1={x(hover!)} x2={x(hover!)} y1="0" y2="300" />}
      </svg>
      <div ref={box} style={{ position: 'absolute', inset: '0 0 26px 34px', touchAction: 'pan-y' }}
           onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        {h && (
          <>
            <span className="hover-dot" style={{ left: `${(x(hover!) / 1000) * 100}%`, top: `${(y(h.n) / 300) * 100}%` }} />
            <span className="tip" style={{ left: `${Math.min(88, Math.max(12, (x(hover!) / 1000) * 100))}%`, top: `${(y(h.n) / 300) * 100}%` }}>
              {fmt(h.d)} · <b className="num">{h.n}</b> {unit}
            </span>
          </>
        )}
      </div>
      {total === 0 && <p className="chart-empty">{empty}</p>}
      <div className="xs" aria-hidden="true">{labelsAt.map((i) => <span key={i}>{fmt(data[i].d)}</span>)}</div>
    </div>
  );
}
