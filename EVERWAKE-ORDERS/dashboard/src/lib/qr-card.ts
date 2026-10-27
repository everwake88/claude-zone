'use client';
import QRCode from 'qrcode';
import { inkOf, logoBackground, mix, onColor } from './menu-art';

// A printable card with the restaurant's WhatsApp QR code: for the bags that
// go out with delivery-app orders, the counter, flyers. A6 at 300 dpi.
export const CARD_W = 1240, CARD_H = 1748;

export interface CardInput {
  link: string; title: string; headline: string; offer: string; branch: string | null; phone: string;
  logo: HTMLImageElement | null; color: string; font: string;
}

export async function qrCanvas(link: string, size = 1024): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  await QRCode.toCanvas(c, link, { errorCorrectionLevel: 'M', margin: 2, width: size, color: { dark: '#111111', light: '#FFFFFF' } });
  return c;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = []; let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(next).width > width) { out.push(line); line = w; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

export async function drawCard(p: CardInput): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = CARD_W; c.height = CARD_H;
  const ctx = c.getContext('2d')!;
  const F = (w: number, px: number) => `${w} ${px}px ${p.font}`;
  const W = CARD_W, H = CARD_H, on = onColor(p.color), ink = inkOf(p.color);
  ctx.direction = 'rtl';
  ctx.textAlign = 'center';

  // the brand colour on top, paper below, the QR on a white panel across both
  ctx.fillStyle = '#FFFBF5'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = p.color;
  ctx.beginPath(); ctx.roundRect(0, 0, W, 760, [0, 0, 80, 80]); ctx.fill();
  ctx.fillStyle = mix(p.color, '#FFFFFF', 0.12);
  ctx.beginPath(); ctx.arc(W - 120, -60, 300, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(140, 760, 170, Math.PI, Math.PI * 2); ctx.fill();

  // the header block (logo or name, headline, offer) centred in the band
  ctx.font = F(600, 44);
  const offerLines = wrapLines(ctx, p.offer, W - 200).slice(0, 2);
  const wideLogo = !!p.logo && p.logo.width / p.logo.height > 1.4;
  const top = p.logo ? (wideLogo ? 170 : 220) + 40 : 130;
  let y = Math.max(60, (700 - (top + 140 + offerLines.length * 62)) / 2);
  if (p.logo) {
    const img = p.logo, wide = wideLogo;
    const h = wide ? 170 : 220, w = wide ? Math.min(620, h * img.width / img.height + 80) : 220;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 8;
    const bg = logoBackground(img);
    const badge = () => { ctx.beginPath(); if (wide) ctx.roundRect(W / 2 - w / 2, y, w, h, h / 2.6); else ctx.arc(W / 2, y + h / 2, h / 2, 0, Math.PI * 2); };
    ctx.fillStyle = bg || '#FFFFFF'; badge(); ctx.fill(); ctx.restore();
    // a logo with its own background fills its badge in that colour; one on transparency sits on white
    const pad = bg ? 0 : wide ? 30 : 26;
    const k = bg && !wide ? Math.max(w / img.width, h / img.height) : Math.min((w - 2 * pad) / img.width, (h - 2 * pad) / img.height);
    ctx.save(); badge(); ctx.clip();
    ctx.drawImage(img, W / 2 - img.width * k / 2, y + h / 2 - img.height * k / 2, img.width * k, img.height * k);
    ctx.restore();
    y += h + 40;
  } else {
    ctx.fillStyle = on; ctx.font = F(800, 80); ctx.fillText(p.title, W / 2, y + 80); y += 130;
  }
  ctx.fillStyle = on;
  ctx.font = F(800, 92); ctx.fillText(p.headline, W / 2, y + 90); y += 140;
  ctx.font = F(600, 44); ctx.globalAlpha = 0.92;
  for (const line of offerLines) { ctx.fillText(line, W / 2, y + 30); y += 62; }
  ctx.globalAlpha = 1;

  // the code
  const qr = await qrCanvas(p.link, 640);
  const qy = 800;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.12)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 10;
  ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.roundRect(W / 2 - 380, qy - 60, 760, 760, 48); ctx.fill();
  ctx.restore();
  ctx.drawImage(qr, W / 2 - 320, qy - 20, 640, 640);
  ctx.fillStyle = '#857A70'; ctx.font = F(600, 36);
  ctx.fillText('امسح الكود بكاميرا الموبايل', W / 2, qy + 670);

  // the branch and the number
  ctx.fillStyle = ink; ctx.font = F(800, 54);
  if (p.branch) ctx.fillText(`فرع ${p.branch}`, W / 2, H - 230);
  ctx.fillStyle = '#1F1A17'; ctx.font = F(700, 46);
  ctx.save(); ctx.direction = 'ltr'; ctx.fillText(`WhatsApp  ${p.phone}`, W / 2, H - 150); ctx.restore();
  ctx.fillStyle = '#857A70'; ctx.font = F(600, 32);
  ctx.fillText(p.title, W / 2, H - 80);
  return c;
}

export const toPng = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('Could not save the picture'))), 'image/png'));
