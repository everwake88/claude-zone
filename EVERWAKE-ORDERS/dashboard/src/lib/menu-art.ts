'use client';

// Designed menu pictures, drawn in the browser: the restaurant's logo and
// colour on top, the menu in two columns, at most three pages. They become
// the pictures the agent sends when a customer asks for the menu.
//
// Drawn on a canvas rather than rendered on the server: the browser shapes
// Arabic properly, and nothing leaves the dashboard until the owner saves.

export interface ArtItem { name: string; sub: string | null; price: string }
export interface ArtCategory { name: string; items: ArtItem[] }
export interface ArtInput {
  title: string; subtitle: string | null; logo: HTMLImageElement | null; color: string;
  categories: ArtCategory[]; footer: string; font: string; maxPages: number;
}

export const W = 1080, H = 1600;           // WhatsApp shows this size without shrinking it
const M = 48, GAP = 40, COL = (W - 2 * M - GAP) / 2, FOOT = 80;
const INK = '#1F1A17', MUTED = '#857A70', PAPER = '#FFFBF5', DOTS = '#D9CFC4';

// ---- colour -------------------------------------------------------------------
const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) || 0) as [number, number, number];
};
const hex = (c: number[]) => '#' + c.map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
const lum = (c: string) => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const onColor = (c: string) => (lum(c) > 0.45 ? INK : '#FFFFFF');
// the brand colour, dark enough to read on paper
const inkOf = (c: string) => { let x = c; for (let i = 0; i < 6 && lum(x) > 0.18; i++) x = mix(x, '#000000', 0.2); return x; };

// the logo's main colours, most vivid first — offered as the brand colour
export function logoColors(img: HTMLImageElement): string[] {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, 48, 48);
  const px = ctx.getImageData(0, 0, 48, 48).data;
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
    if (a < 200) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 235 && min > 220) continue;              // white
    if (max < 28) continue;                            // black
    const k = `${r >> 5}-${g >> 5}-${b >> 5}`;
    const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(k, e);
  }
  return [...buckets.values()]
    .map(e => { const c = [e.r / e.n, e.g / e.n, e.b / e.n]; const s = (Math.max(...c) - Math.min(...c)) / 255; return { c: hex(c), score: e.n * (0.3 + s) }; })
    .sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.c);
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';                     // so the canvas can still be saved
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the logo'));
    img.src = url;
  });
}

// ---- layout -----------------------------------------------------------------------
interface Tier { sub: boolean; s: number }
const TIERS: Tier[] = [{ sub: true, s: 1 }, { sub: false, s: 1 }, { sub: false, s: 0.92 }, { sub: false, s: 0.85 }, { sub: false, s: 0.78 }];
const sizes = (t: Tier) => ({ name: 27 * t.s, price: 26 * t.s, sub: 19 * t.s, cat: 27 * t.s,
                              row: (t.sub ? 70 : 47) * t.s, catH: 74 * t.s });
const headH = (page: number, logo: boolean) => (page === 0 ? (logo ? 350 : 270) : 150);

type Block = { kind: 'cat'; name: string; more: boolean; y: number } | { kind: 'item'; item: ArtItem; y: number };
type Page = Block[][];                                 // [right column, left column]

function layout(input: ArtInput, t: Tier, maxPages: number): Page[] | null {
  const z = sizes(t);
  const pages: Page[] = [];
  let p = -1, col = 1, y = 0, bottom = 0;
  const next = () => {
    if (col === 0) { col = 1; } else { p++; col = 0; pages.push([[], []]); }
    y = headH(p, !!input.logo) + 30;
    bottom = H - FOOT - 16;
    return p < maxPages;
  };
  if (!next()) return null;
  for (const c of input.categories) {
    if (!c.items.length) continue;
    if (y + z.catH + z.row > bottom && !next()) return null;
    pages[p][col].push({ kind: 'cat', name: c.name, more: false, y }); y += z.catH;
    for (const it of c.items) {
      if (y + z.row > bottom) {
        if (!next()) return null;
        pages[p][col].push({ kind: 'cat', name: c.name, more: true, y }); y += z.catH;
      }
      pages[p][col].push({ kind: 'item', item: it, y }); y += z.row;
    }
    y += 14 * t.s;
  }
  return pages;
}

// ---- drawing ------------------------------------------------------------------------
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > width) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
}

function drawPage(input: ArtInput, page: Page, index: number, total: number, t: Tier): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const F = (w: number, px: number) => `${w} ${px}px ${input.font}`;
  const brand = input.color, on = onColor(brand), ink = inkOf(brand);
  const z = sizes(t);
  ctx.direction = 'rtl';
  ctx.textBaseline = 'alphabetic';

  // paper, with soft rings of the brand colour in the corners
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = mix(brand, PAPER, 0.92);
  ctx.beginPath(); ctx.arc(-60, H - 120, 260, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(W + 40, H * 0.55, 200, 0, Math.PI * 2); ctx.fill();

  // header band
  const hh = headH(index, !!input.logo);
  ctx.fillStyle = brand;
  ctx.beginPath(); ctx.roundRect(0, 0, W, hh, [0, 0, 44, 44]); ctx.fill();
  ctx.fillStyle = mix(brand, '#FFFFFF', 0.12);
  ctx.beginPath(); ctx.arc(W - 90, -40, 180, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(110, hh + 30, 120, Math.PI, Math.PI * 2); ctx.fill();

  // a round badge for a square logo, a rounded card for a wide one; returns its width
  const drawLogo = (x: number, cy: number, r: number, anchor: 'center' | 'right') => {
    const img = input.logo;
    if (!img) return 0;
    const wide = img.width / img.height > 1.4;
    const h = wide ? r * 1.7 : 2 * r, w = wide ? Math.min(r * 4.6, h * img.width / img.height + r * 0.6) : 2 * r;
    const cx = anchor === 'center' ? x : x - w / 2;
    const shape = () => { ctx.beginPath(); if (wide) ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2.6); else ctx.arc(cx, cy, r, 0, Math.PI * 2); };
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#FFFFFF'; shape(); ctx.fill();
    ctx.restore();
    ctx.save();
    shape(); ctx.clip();
    const pad = wide ? h * 0.16 : 14, k = Math.min((w - 2 * pad) / img.width, (h - 2 * pad) / img.height);
    ctx.drawImage(img, cx - (img.width * k) / 2, cy - (img.height * k) / 2, img.width * k, img.height * k);
    ctx.restore();
    return w;
  };

  ctx.fillStyle = on;
  if (index === 0) {
    const top = input.logo ? 150 : 20;
    drawLogo(W / 2, 128, 92, 'center');
    ctx.fillStyle = on; ctx.textAlign = 'center';
    ctx.font = F(800, 56); ctx.fillText(fit(ctx, input.title, W - 2 * M), W / 2, top + 120);
    if (input.subtitle) {
      ctx.globalAlpha = 0.85; ctx.font = F(600, 26); ctx.fillText(fit(ctx, input.subtitle, W - 2 * M), W / 2, top + 166); ctx.globalAlpha = 1;
    }
  } else {
    const lw = drawLogo(W - M, hh / 2, 48, 'right');
    ctx.fillStyle = on; ctx.textAlign = 'right';
    ctx.font = F(800, 40);
    ctx.fillText(fit(ctx, input.title, W - 2 * M - 220 - lw), W - M - (lw ? lw + 24 : 0), hh / 2 + 14);
    ctx.textAlign = 'left'; ctx.globalAlpha = 0.85; ctx.font = F(700, 26);
    ctx.fillText('المنيو', M, hh / 2 + 10); ctx.globalAlpha = 1;
  }

  // the two columns: the first on the right
  page.forEach((blocks, ci) => {
    const right = ci === 0 ? W - M : M + COL, left = right - COL;
    for (const b of blocks) {
      if (b.kind === 'cat') {
        ctx.font = F(800, z.cat);
        const label = b.more ? `${b.name} — تابع` : b.name;
        const w = Math.min(ctx.measureText(label).width + 44, COL);
        ctx.fillStyle = brand; roundRect(ctx, right - w, b.y + 10, w, z.catH - 22, (z.catH - 22) / 2);
        ctx.fillStyle = on; ctx.textAlign = 'right';
        ctx.fillText(fit(ctx, label, COL - 44), right - 22, b.y + 10 + (z.catH - 22) / 2 + z.cat * 0.36);
        ctx.fillStyle = mix(brand, PAPER, 0.6); ctx.fillRect(left, b.y + z.catH / 2, Math.max(0, COL - w - 14), 2);
        continue;
      }
      const it = b.item, base = b.y + z.name * 1.2;
      ctx.font = F(800, z.price);
      const pw = it.price ? ctx.measureText(it.price).width : 0;
      ctx.fillStyle = ink; ctx.textAlign = 'left';
      if (it.price) ctx.fillText(it.price, left, base);
      ctx.font = F(700, z.name); ctx.fillStyle = INK; ctx.textAlign = 'right';
      const name = fit(ctx, it.name, COL - pw - 40);
      const nw = ctx.measureText(name).width;
      ctx.fillText(name, right, base);
      // dotted leader between the name and the price
      ctx.fillStyle = DOTS;
      for (let x = right - nw - 14; x > left + pw + 12; x -= 9) { ctx.beginPath(); ctx.arc(x, base - 6, 1.6, 0, Math.PI * 2); ctx.fill(); }
      if (t.sub && it.sub) {
        ctx.font = F(400, z.sub); ctx.fillStyle = MUTED; ctx.textAlign = 'right';
        ctx.fillText(fit(ctx, it.sub, COL - 10), right, base + z.sub * 1.45);
      }
    }
  });

  // footer
  ctx.fillStyle = mix(brand, PAPER, 0.75); ctx.fillRect(M, H - FOOT, W - 2 * M, 2);
  ctx.font = F(700, 22); ctx.fillStyle = INK; ctx.textAlign = 'right';
  ctx.fillText(fit(ctx, input.footer, W - 2 * M - 120), W - M, H - FOOT / 2 + 10);
  if (total > 1) { ctx.direction = 'ltr'; ctx.textAlign = 'left'; ctx.fillStyle = MUTED; ctx.fillText(`${index + 1} / ${total}`, M, H - FOOT / 2 + 10); }
  return c;
}

// the menu as up to maxPages pictures, roomiest design that fits; null when
// even the tightest one needs more pages
export function drawMenu(input: ArtInput): HTMLCanvasElement[] | null {
  for (const t of TIERS) {
    const pages = layout(input, t, input.maxPages);
    if (pages) return pages.map((p, i) => drawPage(input, p, i, pages.length, t));
  }
  return null;
}

export const toJpeg = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('Could not save the picture'))), 'image/jpeg', 0.92));
