// Small charts drawn from real figures, in SVG, with their own arrival motion in CSS
// (they draw, grow or sweep once; prefers-reduced-motion shows them still).

export function Sparkline({ values, width = 104, height = 44 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values), pad = 4;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (width - pad * 2), height - pad - (v / max) * (height - pad * 2)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [ex, ey] = pts[pts.length - 1];
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path className="line draw" d={d} pathLength={1} />
      <circle className="end" cx={ex} cy={ey} r="3.5" />
    </svg>
  );
}

export function MiniBars({ values }: { values: number[] }) {
  if (!values.length) return null;
  const max = Math.max(1, ...values);
  return (
    <div className="bars" aria-hidden="true">
      {values.map((v, i) => (
        <i key={i} className={i === values.length - 1 ? 'now' : undefined}
           style={{ height: `${Math.max(7, (v / max) * 100)}%`, ['--n' as string]: i }} />
      ))}
    </div>
  );
}

// a half dial: the filled share and a needle at its end
export function Gauge({ share, label }: { share: number | null; label: string }) {
  const p = share == null ? 0 : Math.max(0, Math.min(1, share));
  return (
    <div className="gauge" style={{ ['--p' as string]: p }} role="img" aria-label={label}>
      <svg viewBox="0 0 220 122" aria-hidden="true">
        <path className="track" d="M 22 110 A 88 88 0 0 1 198 110" />
        {share != null && <path className="fill" d="M 22 110 A 88 88 0 0 1 198 110" pathLength={1} />}
        {share != null && <g className="needle"><line x1="110" y1="4" x2="110" y2="40" /></g>}
      </svg>
      <div className="pct num">{share == null ? '—' : `${Math.round(p * 100)}%`}</div>
    </div>
  );
}
