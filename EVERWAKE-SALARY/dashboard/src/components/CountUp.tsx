'use client';
import { useEffect, useRef, useState } from 'react';

let hydrated = false;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

// A number that counts up to its value when its card arrives, and from the old value to the new
// one when a refresh changes it. The server renders the real value, so it is right without script.
export function CountUp({ value, locale, decimals = 0, suffix = '' }: { value: number; locale: string; decimals?: number; suffix?: string }) {
  const [shown, setShown] = useState(() => (hydrated ? 0 : value));
  const last = useRef<number | null>(null);
  useEffect(() => {
    const firstLoad = !hydrated;
    hydrated = true;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = last.current ?? (firstLoad && performance.now() > 1500 ? value : 0);
    last.current = value;
    if (reduce || from === value) { setShown(value); return; }
    let raf = 0; const t0 = performance.now(); const dur = 900;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setShown(from + (value - from) * ease(p));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  const f = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return <span className="num" aria-label={f.format(value) + suffix}><span aria-hidden="true">{f.format(shown)}{suffix}</span></span>;
}
