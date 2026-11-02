'use client';
import { useEffect } from 'react';
import type { Brand } from './types';

// The clinic's own colour as the dashboard's ink: darkened until white text on it
// and it on white both pass 4.5:1, with a soft and a track tint of the same hue.
function hexToRgb(h: string) {
  const m = h.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? m.slice(1).map(x => parseInt(x, 16)) : null;
}
const lum = (rgb: number[]) => {
  const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a: number[], b: number[], k: number) => a.map((v, i) => Math.round(v * (1 - k) + b[i] * k));
const hex = (rgb: number[]) => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');

export function brandVars(color?: string | null): Record<string, string> | null {
  let rgb = color ? hexToRgb(color) : null;
  if (!rgb) return null;
  let guard = 0;
  while (contrast(rgb, [255, 255, 255]) < 4.6 && guard++ < 30) rgb = mix(rgb, [10, 15, 30], 0.08);
  return { '--brand': hex(rgb), '--brand-soft': hex(mix(rgb, [255, 255, 255], 0.91)), '--brand-track': hex(mix(rgb, [255, 255, 255], 0.76)),
           '--brand-ink': hex(mix(rgb, [8, 12, 24], 0.45)) };
}

export function useBrand(brand: Brand) {
  useEffect(() => {
    const vars = brandVars(brand.color);
    const root = document.documentElement;
    for (const k of ['--brand', '--brand-soft', '--brand-track', '--brand-ink']) root.style.removeProperty(k);
    if (vars) for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }, [brand.color]);
}

// the most saturated common colour of a logo, as the suggestion for the clinic's colour
export async function logoColour(url: string): Promise<string | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode().catch(() => null);
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d');
  if (!ctx || !img.width) return null;
  ctx.drawImage(img, 0, 0, 48, 48);
  const px = ctx.getImageData(0, 0, 48, 48).data;
  const bins = new Map<string, { n: number; sat: number; rgb: number[] }>();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 200) continue;
    const rgb = [px[i], px[i + 1], px[i + 2]];
    const mx = Math.max(...rgb), mn = Math.min(...rgb);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (sat < 0.25 || mx < 40) continue;
    const key = rgb.map(v => v >> 5).join(',');
    const b = bins.get(key) || { n: 0, sat, rgb };
    b.n += 1; bins.set(key, b);
  }
  const best = [...bins.values()].sort((a, b) => b.n * b.sat - a.n * a.sat)[0];
  return best ? hex(best.rgb) : null;
}
