import type { Lang, T } from './i18n';

const nf = (lang: Lang, digits = 0) =>
  new Intl.NumberFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const count = (lang: Lang, n: number) => nf(lang).format(n);

// a cell from the payroll sheet, as HR typed it: numbers with separators (two decimals only when it has them)
// raw = an identity column (a national ID, a code, a phone): its digits exactly, no separators
export function cell(lang: Lang, v: unknown, raw = false): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return raw || (Number.isInteger(v) && Math.abs(v) >= 1e9) ? String(v) : nf(lang, Number.isInteger(v) ? 0 : 2).format(v);
  if (typeof v === 'boolean') return v ? '✓' : '—';
  return String(v);
}
export const isNumeric = (v: unknown) => typeof v === 'number';

export function ago(t: T, iso: string | Date | null): string {
  if (!iso) return t('c.never');
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 2) return t('c.justNow');
  if (min < 60) return t('c.minutesAgo', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('c.hoursAgo', { n: h });
  const days = Math.round(h / 24);
  if (days === 1) return t('c.yesterday');
  return t('c.daysAgo', { n: days });
}

export function dateTime(lang: Lang, iso: string | Date | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo'
  }).format(typeof iso === 'string' ? new Date(iso) : iso);
}
export function time(lang: Lang, iso: string | Date): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo'
  }).format(typeof iso === 'string' ? new Date(iso) : iso);
}
// a WhatsApp id as people read it: 201001234567 → 0100 123 4567
export function phone(waOrPhone: string | null): string {
  const d = String(waOrPhone || '').replace(/\D/g, '');
  const local = d.replace(/^20(1\d{9})$/, '0$1');
  return /^01\d{9}$/.test(local) ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : d;
}

// Names as people say them: "عبد الرحمن" and "أبو بكر" are one name, not two.
export function nameParts(full: string): string[] {
  const w = String(full || '').trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    if (/^(عبد|ابو|أبو|abd|abdel|abu)$/i.test(w[i]) && w[i + 1]) { out.push(`${w[i]} ${w[i + 1]}`); i++; }
    else out.push(w[i]);
  }
  return out;
}
export const firstName = (full: string) => nameParts(full)[0] || '';
export const initials = (full: string) => nameParts(full).slice(0, 2).map((p) => [...p][0]).join('').toUpperCase() || '؟';
// a stable pale tint per person (four families, far apart), for their initials
export const tint = (name: string) => `tint-${[...String(name || '')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 4}`;
