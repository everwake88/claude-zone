'use client';
import {
  BarChart3, Bike, BookOpen, ChefHat, ChevronDown, LayoutDashboard, LogOut, Map, Megaphone, MessageCircle, Percent, Settings,
  ShoppingBag, Store, Users, Menu as MenuIcon
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { askNotificationPermission, chime, notify } from '@/lib/alerts';
import { cx, money } from '@/lib/format';
import { LangSwitch, useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { Badge, useToast } from '../ui';
import { useTenant } from '../tenant';
import { AgentSwitch } from './AgentSwitch';

const NAV = [
  { href: '', label: 'Overview', icon: LayoutDashboard },
  { href: '/orders', label: 'Orders', icon: ShoppingBag, badge: 'orders' as const },
  { href: '/inbox', label: 'Inbox', icon: MessageCircle, badge: 'inbox' as const },
  { href: '/menu', label: 'Menu', icon: ChefHat },
  { href: '/offers', label: 'Offers', icon: Percent },
  { href: '/growth', label: 'Get customers', icon: Megaphone },
  { href: '/branches', label: 'Branches', icon: Store },
  { href: '/zones', label: 'Delivery zones', icon: Map },
  { href: '/drivers', label: 'Drivers', icon: Bike },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings }
];

export function Shell({ children }: { children: ReactNode }) {
  const { tenant, tenants, base, brand } = useTenant();
  const path = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [newOrders, setNewOrders] = useState(0);
  const [attention, setAttention] = useState(0);
  const [mobileNav, setMobileNav] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const seen = useRef<Set<number>>(new Set());
  const { t, lang } = useLang();

  // badges + the new-order alarm, on every page
  useEffect(() => {
    const db = sb();
    const counts = async () => {
      const [o, c] = await Promise.all([
        db.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('status', 'placed'),
        db.from('conversations').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id)
          .or('needs_attention.eq.true,and(mode.eq.human,unread_count.gt.0)')
      ]);
      setNewOrders(o.count || 0);
      setAttention(c.count || 0);
    };
    counts();
    askNotificationPermission();
    const ch = db.channel('shell-' + tenant.id)
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'orders', filter: `tenant_id=eq.${tenant.id}` }, (p) => {
        const row = p.new as { id: number; status: string; order_no: string; total: number };
        if (row && row.status === 'placed' && !seen.current.has(row.id)) {
          seen.current.add(row.id);
          chime();
          notify(t('New order {no}', { no: row.order_no }), money(row.total, tenant.currency_symbol));
          toast(t('New order {no} — {total}', { no: row.order_no, total: money(row.total, tenant.currency_symbol) }), 'neutral');
        }
        counts();
      })
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'conversations', filter: `tenant_id=eq.${tenant.id}` }, () => counts())
      .subscribe();
    return () => { db.removeChannel(ch); };
  }, [tenant.id, tenant.currency_symbol, toast, t]);

  const active = (href: string) => href === '' ? path === base : path.startsWith(base + href);
  const signOut = async () => { await sb().auth.signOut(); router.replace('/login'); };

  const nav = (
    <nav className="flex flex-col gap-0.5 px-3">
      {NAV.map(({ href, label, icon: Icon, badge }) => {
        const n = badge === 'orders' ? newOrders : badge === 'inbox' ? attention : 0;
        return (
          <Link key={href} href={base + href} onClick={() => setMobileNav(false)}
            className={cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
              active(href) ? 'bg-navy-soft text-white' : 'text-on-navy-muted hover:bg-navy-raised hover:text-white')}>
            <Icon className="size-4" />
            <span className="flex-1">{t(label)}</span>
            {n > 0 && <span className={cx('rounded-full px-1.5 text-xs font-semibold', badge === 'orders' ? 'bg-gold text-navy ring-new' : 'bg-critical text-white')}>{n}</span>}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen lg:ps-60">
      {/* sidebar */}
      <aside className={cx('fixed inset-y-0 start-0 z-40 flex w-60 flex-col bg-navy text-white transition-transform lg:translate-x-0',
        mobileNav ? 'translate-x-0' : lang === 'ar' ? 'translate-x-full' : '-translate-x-full')}>
        <div className="relative px-5 pb-4 pt-5">
          <button onClick={() => setSwitcher(s => !s)} className="flex w-full items-center gap-2 text-start">
            {brand.logo_url
              ? <img src={brand.logo_url} alt="" className="size-9 shrink-0 rounded-full bg-white object-contain p-0.5" />
              : <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gold font-bold text-navy">
                  {(tenant.name_en || tenant.name_ar).slice(0, 1).toUpperCase()}
                </span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{tenant.name_en || tenant.name_ar}</span>
              <span className="block truncate text-xs text-on-navy-muted ar" dir="rtl">{tenant.name_ar}</span>
            </span>
            {tenants.length > 1 && <ChevronDown className="size-4 text-on-navy-muted" />}
          </button>
          {switcher && tenants.length > 1 && (
            <div className="absolute start-3 end-3 top-16 z-50 rounded-xl bg-white p-1 text-ink shadow-xl">
              {tenants.map(t => (
                <Link key={t.id} href={`/r/${t.slug}`} onClick={() => setSwitcher(false)}
                  className={cx('block rounded-lg px-3 py-2 text-sm hover:bg-paper', t.id === tenant.id && 'font-semibold')}>
                  {t.name_en || t.name_ar}
                </Link>
              ))}
              <Link href="/new" className="block rounded-lg px-3 py-2 text-sm text-gold-ink hover:bg-paper">+ {t('Add a restaurant')}</Link>
            </div>
          )}
        </div>
        {nav}
        <div className="mt-auto space-y-1 px-3 pb-4">
          <a href="https://www.everwake.tech/" target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg px-3 py-2 text-xs text-on-navy-muted hover:text-white">
            <BookOpen className="size-4" /> Everwake Orders
          </a>
          <button onClick={signOut} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-on-navy-muted hover:bg-navy-raised hover:text-white">
            <LogOut className="size-4 rtl:rotate-180" /> {t('Sign out')}
          </button>
        </div>
      </aside>
      {mobileNav && <div className="fixed inset-0 z-30 bg-navy/40 lg:hidden" onClick={() => setMobileNav(false)} />}

      {/* top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-hairline bg-white/85 px-4 backdrop-blur lg:px-6">
        <button className="rounded-lg p-1.5 hover:bg-paper lg:hidden" onClick={() => setMobileNav(true)} aria-label={t('Menu')}><MenuIcon className="size-5" /></button>
        {tenant.status === 'onboarding' && <Badge tone="caution">{t('Onboarding — only test numbers reach the agent')}</Badge>}
        {tenant.status === 'suspended' && <Badge tone="critical">{t('Suspended')}</Badge>}
        <div className="ms-auto flex items-center gap-2">
          <LangSwitch />
          <AgentSwitch />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 lg:px-6">{children}</main>
    </div>
  );
}
