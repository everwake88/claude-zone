'use client';
import { useEffect, useLayoutEffect } from 'react';
import { loadImage, logoColors } from './menu-art';
import type { Brand } from './types';

// The dashboard in the restaurant's own colours, taken from its logo.
//
// Two jobs, kept apart so nothing shouts:
// - the logo's dark (or its colour made very dark and quiet) becomes the
//   sidebar and the text — large areas, so low in colour;
// - the logo's lively colour becomes the accent — only small things: the main
//   buttons, badges, the marker on the page you're on, links.
// Pages stay near white; green / amber / red keep their meanings.
// The values replace the Everwake tokens in globals.css (--color-navy…, --color-gold…).

type Lch = { L: number; C: number; H: number };
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toLch(hex: string): Lch | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => lin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), H: (Math.atan2(B, A) * 180 / Math.PI + 360) % 360 };
}
function rgbOf({ L, C, H }: Lch): number[] {
  const a = C * Math.cos(H * Math.PI / 180), b = C * Math.sin(H * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
// a colour the screen can show: the chroma comes down until it fits
function toHex(c: Lch): string {
  let lo = 0, hi = c.C, rgb = rgbOf(c);
  if (rgb.some(v => v < 0 || v > 1)) {
    for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (rgbOf({ ...c, C: mid }).some(v => v < 0 || v > 1)) hi = mid; else lo = mid; }
    rgb = rgbOf({ ...c, C: lo });
  }
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, gam(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, '0')).join('');
}
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => lin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

export function brandTokens(colors: string[]): Record<string, string> | null {
  const cs = colors.map(toLch).filter((c): c is Lch => !!c);
  // the accent: the first colour lively enough to carry a button (the saved brand colour comes first)
  const lively = cs.find(c => c.C >= 0.07 && c.L >= 0.45 && c.L <= 0.92) || cs.find(c => c.C >= 0.07);
  if (!lively) return null;                       // a black-and-white logo: Everwake's own colours stay
  // the chrome: the logo's own dark if it has one, else the accent's hue, very dark and quiet
  const dark = cs.find(c => c.L < 0.42 && c.C >= 0.02);
  const H = dark ? dark.H : lively.H;
  const Cc = Math.min(dark ? dark.C : lively.C * 0.3, 0.038);
  const at = (L: number, C: number, h = H) => toHex({ L, C, H: h });

  const ink = at(0.23, Math.min(Cc, 0.035));
  const acc: Lch = { L: Math.min(0.82, Math.max(0.5, lively.L)), C: Math.min(lively.C, 0.19), H: lively.H };
  // a button's words must read on it: a deep colour darkens a little for white text, a light one lightens for dark text
  const best = () => Math.max(contrast(toHex(acc), '#FFFFFF'), contrast(toHex(acc), ink));
  for (let i = 0; i < 20 && best() < 4.5; i++) acc.L += acc.L < 0.66 ? -0.015 : 0.015;
  const gold = toHex(acc);
  // accent text on white: darker until it reads
  let goldInk = gold;
  for (let L = acc.L; L > 0.25 && contrast(goldInk, '#FFFFFF') < 4.6; L -= 0.02) goldInk = toHex({ ...acc, L, C: Math.min(acc.C, 0.16) });

  return {
    '--color-navy-deep': at(0.165, Cc), '--color-navy': at(0.205, Cc), '--color-navy-raised': at(0.255, Cc), '--color-navy-soft': at(0.3, Cc),
    '--color-on-navy-muted': at(0.79, Math.min(Cc, 0.025)),
    '--color-ink': ink, '--color-muted': at(0.49, Math.min(Cc, 0.02)),
    '--color-paper': at(0.972, Math.min(Cc, 0.007)), '--color-paper-sunk': at(0.945, Math.min(Cc, 0.01)), '--color-hairline': at(0.905, Math.min(Cc, 0.012)),
    '--color-gold': gold, '--color-gold-bright': toHex({ ...acc, L: Math.min(0.88, acc.L + 0.05) }), '--color-gold-ink': goldInk,
    '--color-gold-wash': toHex({ L: 0.966, C: Math.min(acc.C * 0.22, 0.028), H: acc.H }),
    '--color-gold-line': toHex({ L: 0.88, C: Math.min(acc.C * 0.45, 0.07), H: acc.H }),
    '--color-on-gold': contrast(gold, '#FFFFFF') >= contrast(gold, ink) ? '#FFFFFF' : ink
  };
}

const KEYS = ['--color-navy-deep', '--color-navy', '--color-navy-raised', '--color-navy-soft', '--color-on-navy-muted', '--color-ink', '--color-muted',
  '--color-paper', '--color-paper-sunk', '--color-hairline', '--color-gold', '--color-gold-bright', '--color-gold-ink', '--color-gold-wash',
  '--color-gold-line', '--color-on-gold'];
const apply = (tokens: Record<string, string> | null) => {
  const s = document.documentElement.style;
  KEYS.forEach(k => (tokens?.[k] ? s.setProperty(k, tokens[k]) : s.removeProperty(k)));
};
const read = (key: string) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };

// Inside a restaurant's dashboard: its colours, remembered on this browser so
// they are there from the first paint next time; leaving it brings Everwake's back.
export function useBrandTheme(tenantId: string, brand: Brand) {
  const key = 'ew-theme:' + tenantId;
  useLayoutEffect(() => { apply(read(key)?.tokens || null); return () => apply(null); }, [key]);
  useEffect(() => {
    const sig = `${brand.logo_url || ''}|${brand.color || ''}`;
    if (sig === '|') return;                      // brand not loaded yet, or none set: keep what is showing
    if (read(key)?.sig === sig) return;
    let gone = false;
    (async () => {
      const colors = brand.color ? [brand.color] : [];
      if (brand.logo_url) { try { colors.push(...logoColors(await loadImage(brand.logo_url))); } catch { /* the colour alone */ } }
      if (gone) return;
      const tokens = brandTokens(colors);
      apply(tokens);
      try { localStorage.setItem(key, JSON.stringify({ sig, tokens })); } catch { /* private mode */ }
    })();
    return () => { gone = true; };
  }, [key, brand.logo_url, brand.color]);
}
