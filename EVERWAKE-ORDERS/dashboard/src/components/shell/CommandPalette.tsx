'use client';
import { CornerDownLeft, Search, ShoppingBag, User } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { cx, money } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { useTenant } from '../tenant';
import { NAV } from './nav';

interface Hit { key: string; label: string; sub?: string; href: string; icon: typeof Search; group: string }

// One box to reach anything: a page or a setting by its name, an order by its number,
// a customer by name or phone. "/" or Ctrl+K opens it from anywhere. It opens and closes
// instantly (it is used many times a day and from the keyboard, where motion only slows it).
export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setOpen(o => !o); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return { open, setOpen };
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenant, base } = useTenant();
  const router = useRouter();
  const t = useT();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Hit[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(''); setFound([]); setAt(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  const pages = useMemo<Hit[]>(() => [
    ...NAV.flatMap(g => g.items.map(i => ({ key: 'p' + i.href, label: t(i.label), href: base + i.href, icon: i.icon, group: t('Pages') }))),
    ...SETTINGS_SECTIONS.map(s => ({ key: 's' + s.key, label: t(s.label), sub: t('Settings'), href: `${base}/settings/${s.key}`, icon: s.icon, group: t('Pages') }))
  ], [base, t]);

  // orders and customers, asked of the database as they type
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound([]); return; }
    const timer = setTimeout(async () => {
      const like = `%${term.replace(/[%_]/g, '')}%`;
      const digits = term.replace(/\D/g, '');
      const [o, c] = await Promise.all([
        sb().from('orders').select('id, order_no, total, status, customer').eq('tenant_id', tenant.id).neq('status', 'draft')
          .ilike('order_no', like).order('placed_at', { ascending: false }).limit(5),
        sb().from('customers').select('id, full_name, display_name, phone').eq('tenant_id', tenant.id)
          .or([`full_name.ilike.${like}`, `display_name.ilike.${like}`, digits.length >= 3 ? `phone.ilike.%${digits}%` : ''].filter(Boolean).join(',')).limit(5)
      ]);
      setFound([
        ...((o.data || []) as { id: number; order_no: string; total: number; status: string; customer: { full_name?: string } | null }[]).map(x => ({
          key: 'o' + x.id, label: x.order_no, sub: [x.customer?.full_name, money(x.total, tenant.currency_symbol)].filter(Boolean).join(' — '),
          href: `${base}/orders?o=${x.id}`, icon: ShoppingBag, group: t('Orders') })),
        ...((c.data || []) as { id: number; full_name: string | null; display_name: string | null; phone: string | null }[]).map(x => ({
          key: 'c' + x.id, label: x.full_name || x.display_name || x.phone || '—', sub: x.phone || undefined,
          href: `${base}/customers?q=${encodeURIComponent(x.phone || x.full_name || '')}`, icon: User, group: t('Customers') }))
      ]);
    }, 160);
    return () => clearTimeout(timer);
  }, [q, tenant.id, tenant.currency_symbol, base, t]);

  const term = q.trim().toLowerCase();
  const list = useMemo(() => [
    ...pages.filter(p => !term || p.label.toLowerCase().includes(term) || (p.sub || '').toLowerCase().includes(term)).slice(0, term ? 6 : 8),
    ...found
  ], [pages, found, term]);
  useEffect(() => { setAt(0); }, [term, found.length]);

  const go = useCallback((h: Hit) => { onClose(); router.push(h.href); }, [onClose, router]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label={t('Search')}>
      <div className="absolute inset-0 bg-navy/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="ew-card relative w-full max-w-xl overflow-hidden !bg-white">
        <label className="flex items-center gap-3 border-b border-hairline px-4">
          <Search className="size-5 shrink-0 text-muted" aria-hidden />
          <input ref={input} value={q} onChange={e => setQ(e.target.value)} dir="auto"
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setAt(i => Math.min(list.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(i => Math.max(0, i - 1)); }
              else if (e.key === 'Enter' && list[at]) go(list[at]);
            }}
            placeholder={t('Search orders, customers or pages…')} aria-label={t('Search')}
            className="h-14 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-muted/70" />
          <kbd className="rounded-md bg-paper-sunk px-1.5 py-0.5 text-xs text-muted">Esc</kbd>
        </label>
        <ul className="max-h-[50vh] overflow-y-auto p-2" role="listbox">
          {list.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t('Nothing found for “{q}”', { q })}</li>}
          {list.map((h, i) => (
            <li key={h.key} role="option" aria-selected={i === at}>
              {(i === 0 || list[i - 1].group !== h.group) && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted">{h.group}</p>}
              <button onMouseMove={() => setAt(i)} onClick={() => go(h)}
                className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start text-sm', i === at ? 'bg-gold-wash text-ink' : 'text-ink')}>
                <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', i === at ? 'bg-white text-gold-ink' : 'bg-paper text-muted')}>
                  <h.icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <bdi className="block truncate font-medium">{h.label}</bdi>
                  {h.sub && <bdi className="block truncate text-xs text-muted">{h.sub}</bdi>}
                </span>
                {i === at && <CornerDownLeft className="size-4 text-muted rtl:-scale-x-100" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
