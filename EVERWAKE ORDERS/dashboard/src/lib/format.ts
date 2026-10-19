import type { OrderStatus } from './types';

export function money(n: number | string | null | undefined, sym = 'ج'): string {
  if (n === null || n === undefined || n === '') return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${sym.length > 1 ? ' ' + sym : sym}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function clock(iso: string | null | undefined, tz?: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function dateTime(iso: string | null | undefined, tz?: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(iso));
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  draft: 'Cart', placed: 'New', accepted: 'Accepted', preparing: 'Preparing', ready: 'Ready for pickup',
  out_for_delivery: 'On the way', delivered: 'Delivered', picked_up: 'Picked up', rejected: 'Rejected', cancelled: 'Cancelled'
};

export const UNIT_LABEL: Record<string, string> = { portion: '', piece: 'pcs', kg: 'kg', person: 'per person' };

export function qty(q: number, unit: string): string {
  return unit === 'kg' ? `${q} kg` : `×${q}`;
}

export function displayName(c?: { full_name?: string | null; display_name?: string | null } | null, fallback = 'Customer'): string {
  return (c?.full_name || c?.display_name || fallback).trim();
}

export function phoneLabel(waId: string, phone?: string | null, hidden?: boolean): string {
  if (phone) return '+' + phone;
  return hidden ? 'Number hidden by WhatsApp' : '+' + waId;
}

// "https://maps.google.com/?q=30.06,31.22" or "…/@30.06,31.22,17z" → [lat, lng]
export function parseLatLng(text: string): [number, number] | null {
  const m = text.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
}

export const cx = (...c: (string | false | null | undefined | 0)[]) => c.filter(Boolean).join(' ');
