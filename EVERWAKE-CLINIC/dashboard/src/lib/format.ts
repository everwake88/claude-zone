import { currentLang, tt } from './i18n-core';

export const cx = (...c: (string | false | null | undefined | 0)[]) => c.filter(Boolean).join(' ');

export function money(n: number | string | null | undefined, sym = 'ج'): string {
  if (n === null || n === undefined || n === '') return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return currentLang() === 'en' ? `EGP ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${sym}`;
}

const locale = () => (currentLang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');

// 17:30 → "5:30 م" / "5:30 pm", in the clinic's time zone
export function clock(iso: string | null | undefined, tz?: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(currentLang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(iso)).replace(':00', '').replace(/\s?([AP])M/, (_, x) => ' ' + x.toLowerCase() + 'm');
}
export const hhmm = (iso: string, tz?: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

export function dayLabel(iso: string | null | undefined, tz?: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(), { timeZone: tz, ...opts }).format(new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso));
}
export const dateShort = (iso: string | null | undefined, tz?: string) => dayLabel(iso, tz, { day: 'numeric', month: 'short' });

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return tt('just now');
  if (s < 3600) return tt('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return tt('{n} h ago', { n: Math.round(s / 3600) });
  return tt('{n} d ago', { n: Math.round(s / 86400) });
}
export const minutes = (n: number) => (n >= 60 ? tt('{h} h {m} min', { h: Math.floor(n / 60), m: n % 60 }) : tt('{n} min', { n }));

// 201001234567 → 0100 123 4567
export function phone(p: string | null | undefined): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '').replace(/^20(1\d{9})$/, '0$1');
  return /^01\d{9}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : '+' + d;
}

export const PRICE_UNITS: Record<string, string> = { visit: 'per visit', tooth: 'per tooth', canal: 'per canal', jaw: 'per jaw', session: 'per session',
                                                    area: 'per area', course: 'full course', unit: 'per unit' };
export function priceText(kind: string, price: number | null, max: number | null, unit: string, sym = 'ج'): string {
  if (kind === 'free') return tt('Free');
  if (kind === 'after_exam') return tt('After the check-up');
  if (price == null) return tt('No price yet');
  const u = unit && unit !== 'visit' ? ' · ' + tt(PRICE_UNITS[unit] || unit) : '';
  if (kind === 'range' && max != null) return `${money(price, sym)} – ${money(max, sym)}${u}`;
  if (kind === 'from' || kind === 'range') return tt('from {p}', { p: money(price, sym) }) + u;
  return money(price, sym) + u;
}

export const initials = (name: string | null | undefined) =>
  (name || '?').replace(/^(د\.|dr\.?)\s*/i, '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('');
