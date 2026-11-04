'use client';
import { Bell, BookOpen, ChevronDown, Code2, Flame, LayoutDashboard, LogOut, Menu as MenuIcon, MessageCircle, Search, ShoppingBag, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { askNotificationPermission, chime, notify } from '@/lib/alerts';
import { cx, money } from '@/lib/format';
import { lalezarLazy as lalezar, readex } from '@/lib/fonts';
import { LangSwitch, useLang } from '@/lib/i18n';
import { sb } from '@/lib/supabase/client';
import { useBrandTheme } from '@/lib/theme';
import { Badge, useToast } from '../ui';
import { useTenant } from '../tenant';
import { AgentSwitch } from './AgentSwitch';
import { CommandPalette, useCommandPalette } from './CommandPalette';
import { NAV } from './nav';
import { ThemePicker } from './ThemePicker';

export function Shell({ children }: { children: ReactNode }) {
  const { tenant, tenants, base, brand, can, isAdmin } = useTenant();
  const path = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [newOrders, setNewOrders] = useState(0);
  const [attention, setAttention] = useState(0);
  // table bookings: shown once a branch takes them (or one is still waiting)
  const [bookings, setBookings] = useState({ waiting: 0, on: false });
  const [mobileNav, setMobileNav] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  // the header stays put; once the page scrolls under it, it frosts so the page shows through
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on(); window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const palette = useCommandPalette();
  useEffect(() => { setMobileNav(false); }, [path]);
  const seen = useRef<Set<number>>(new Set());
  const seenBookings = useRef<Set<number>>(new Set());
  const { t, lang } = useLang();
  // the dashboard in the restaurant's colours, from its logo
  useBrandTheme(tenant.id, brand);

  // badges + the new-order alarm, on every page
  useEffect(() => {
    const db = sb();
    const counts = async () => {
      const [o, c, r, b] = await Promise.all([
        db.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('status', 'placed'),
        db.from('conversations').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id)
          .or('needs_attention.eq.true,and(mode.eq.human,unread_count.gt.0)'),
        db.from('reservations').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('status', 'requested'),
        db.from('branches').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('is_active', true).neq('reservations', 'off')
      ]);
      setNewOrders(o.count || 0);
      setAttention(c.count || 0);
      setBookings({ waiting: r.count || 0, on: (b.count || 0) > 0 || (r.count || 0) > 0 });
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
      .on('postgres_changes', { event: '*', schema: 'everwake', table: 'reservations', filter: `tenant_id=eq.${tenant.id}` }, (p) => {
        const row = p.new as { id: number; status: string; ref_no: string; guests: number };
        if (row && row.status === 'requested' && !seenBookings.current.has(row.id)) {
          seenBookings.current.add(row.id);
          chime();
          notify(t('New table booking {ref}', { ref: row.ref_no }), t('{n} people', { n: row.guests }));
          toast(t('New table booking {ref} — {n} people', { ref: row.ref_no, n: row.guests }), 'neutral');
        }
        counts();
      })
      .subscribe();
    return () => { db.removeChannel(ch); };
  }, [tenant.id, tenant.currency_symbol, toast, t]);

  const dark = path.startsWith(base + '/kitchen');
  const active = (href: string) => href === '' ? path === base : path.startsWith(base + href);
  const signOut = async () => { await sb().auth.signOut(); router.replace('/login'); };

  const count = (badge?: string) => badge === 'orders' ? newOrders : badge === 'inbox' ? attention : badge === 'bookings' ? bookings.waiting : 0;
  const nav = (
    <nav className="flex flex-col gap-0.5 px-3" aria-label={t('Main')}>
      {NAV.map((g, gi) => (
        <div key={gi} className={cx(gi > 0 && 'mt-3', g.group === null && gi > 0 && 'border-t border-white/10 pt-3')}>
          {g.group && <p className="px-3 pb-1.5 text-xs font-medium text-on-navy-muted/70">{t(g.group)}</p>}
          {g.items.filter(x => (x.badge !== 'bookings' || bookings.on) && (!x.editors || can.edit)).map(({ href, label, icon: Icon, badge }) => {
            const n = count(badge), on = active(href);
            return (
              // fetched whole in the background, so a click opens the page at once (React would otherwise hold
              // a loading screen for a moment before showing it)
              <Link key={href} href={base + href} prefetch aria-current={on ? 'page' : undefined}
                className={cx('group relative flex items-center gap-3 rounded-[var(--ui-radius-inner)] px-3 py-2 text-sm transition-[background-color,color,box-shadow] duration-200',
                  on ? 'bg-white font-semibold text-navy shadow-[0_6px_16px_-8px_rgba(0,0,0,0.45)]' : 'text-on-navy-muted hover:bg-white/[.08] hover:text-white')}>
                <Icon className={cx('size-[18px] shrink-0', on ? 'text-gold-ink' : 'transition-transform duration-200 group-hover:scale-110')} aria-hidden />
                <span className="flex-1 truncate">{t(label)}</span>
                {n > 0 && (
                  <span className={cx('flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums',
                    badge === 'inbox' ? 'bg-critical text-white' : on ? 'bg-navy text-white' : 'bg-white text-navy')}>{n}</span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
  const name = (lang === 'ar' ? tenant.name_ar : tenant.name_en) || tenant.name_ar || tenant.name_en;
  const other = lang === 'ar' ? tenant.name_en : tenant.name_ar;
  const agentOn = tenant.agent_enabled;
  const bell = newOrders + attention;
  const roundBtn = dark ? 'bg-white/10 text-white hover:bg-white/15' : 'ew-card !rounded-full text-ink hover:text-gold-ink';

  return (
    <div className={cx('ew-app min-h-dvh', lalezar.variable, readex.variable)}>
      {/* the sidebar: a floating card in the restaurant's dark, the logo at its head with the agent's live dot */}
      <aside className={cx('ew-side fixed z-40 flex w-[248px] flex-col overflow-y-auto text-white transition-transform duration-300 lg:translate-x-0',
        'max-lg:!inset-y-0 max-lg:!start-0 max-lg:!rounded-none',
        mobileNav ? 'translate-x-0' : lang === 'ar' ? 'translate-x-[110%]' : '-translate-x-[110%]')}>
        <div className="relative px-4 pb-4 pt-5">
          <button onClick={() => setSwitcher(s => !s)} className="flex w-full flex-col items-center gap-2.5 text-center" aria-expanded={switcher}>
            <span className="relative">
              <span className="block rounded-full bg-gradient-to-br from-gold-bright via-gold to-white/40 p-[3px]">
                {brand.logo_url
                  ? <img src={brand.logo_url} alt="" crossOrigin="anonymous" className="size-16 rounded-full bg-white object-contain p-1" />
                  : <span className="flex size-16 items-center justify-center rounded-full bg-navy-soft text-2xl font-bold">{name.slice(0, 1).toUpperCase()}</span>}
              </span>
              <span title={agentOn ? t('Agent ON') : t('Agent OFF')}
                className={cx('absolute bottom-1 end-1 size-4 rounded-full border-[3px] border-navy', agentOn ? 'ew-live bg-positive' : 'bg-critical')} />
            </span>
            <span className="min-w-0">
              <span className="flex items-center justify-center gap-1 text-[15px] font-semibold">
                <span className="truncate">{name}</span>{tenants.length > 1 && <ChevronDown className="size-4 shrink-0 text-on-navy-muted" aria-hidden />}
              </span>
              {other && other !== name && <span className="block truncate text-xs text-on-navy-muted" dir="auto">{other}</span>}
            </span>
          </button>
          {switcher && tenants.length > 1 && (
            <div className="ew-pop absolute inset-x-3 top-full z-50 -mt-2 rounded-2xl bg-white p-1.5 text-ink shadow-xl">
              {tenants.map(x => (
                <Link key={x.id} href={`/r/${x.slug}`} onClick={() => setSwitcher(false)}
                  className={cx('block rounded-xl px-3 py-2 text-sm hover:bg-paper', x.id === tenant.id && 'font-semibold')}>
                  {x.name_en || x.name_ar}
                </Link>
              ))}
              <Link href="/new" className="block rounded-xl px-3 py-2 text-sm text-gold-ink hover:bg-paper">+ {t('Add a restaurant')}</Link>
            </div>
          )}
        </div>
        {nav}
        <div className="mt-auto space-y-0.5 px-3 pb-4 pt-6">
          {/* only for Everwake's developers: what the AI costs, the bills' percent, the AI settings */}
          {isAdmin && (
            <Link href="/dev" className="flex items-center gap-3 rounded-[var(--ui-radius-inner)] px-3 py-2 text-sm text-on-navy-muted hover:bg-white/[.08] hover:text-white">
              <Code2 className="size-4" aria-hidden /> Developer
            </Link>
          )}
          <a href="https://www.everwake.tech/" target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-[var(--ui-radius-inner)] px-3 py-2 text-xs text-on-navy-muted hover:text-white">
            <BookOpen className="size-4" aria-hidden /> Everwake Orders
          </a>
          <button onClick={signOut} className="flex w-full items-center gap-3 rounded-[var(--ui-radius-inner)] px-3 py-2 text-sm text-on-navy-muted hover:bg-white/[.08] hover:text-white">
            <LogOut className="size-4 rtl:rotate-180" aria-hidden /> {t('Sign out')}
          </button>
        </div>
      </aside>
      {mobileNav && <div className="ew-fade fixed inset-0 z-30 bg-navy/45 backdrop-blur-[2px] lg:hidden" onClick={() => setMobileNav(false)} />}

      {/* the panel: everything else floats in it, beside the sidebar */}
      <div className="lg:ps-[calc(248px+var(--ui-gap))]">
        <div className={cx('ew-panel min-h-dvh pb-24 lg:m-[var(--ui-gap)] lg:min-h-[calc(100dvh-var(--ui-gap)*2)] lg:pb-6 max-lg:!rounded-none', dark && '!bg-navy-deep')}>
          <header className={cx('sticky top-0 z-20 flex h-[72px] items-center gap-3 rounded-t-[inherit] px-4 transition-[background-color,box-shadow] duration-200 lg:px-7',
            scrolled && (dark ? 'bg-navy-deep/90 shadow-[0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-md' : 'bg-[color-mix(in_oklab,var(--ui-panel)_75%,transparent)] shadow-[0_1px_0_var(--color-hairline)] backdrop-blur-xl'))}>
            <button className={cx('flex size-10 items-center justify-center rounded-full lg:hidden', roundBtn)} onClick={() => setMobileNav(true)} aria-label={t('Menu')}>
              <MenuIcon className="size-5" />
            </button>
            {/* the search: pages, orders by number, customers by name or phone */}
            <button onClick={() => palette.setOpen(true)}
              className={cx('flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full px-4 text-sm transition-colors duration-150 sm:max-w-md lg:mx-auto',
                dark ? 'bg-white/10 text-white/70 hover:bg-white/15' : 'ew-card !rounded-full text-muted hover:text-ink')}>
              <Search className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{t('Search orders, customers or pages…')}</span>
              <kbd className={cx('ms-auto hidden rounded-md px-1.5 py-0.5 text-xs sm:block', dark ? 'bg-white/10' : 'bg-paper-sunk')}>/</kbd>
            </button>
            <div className="flex shrink-0 items-center gap-2">
              {tenant.status === 'onboarding' && <Badge tone="caution" className="hidden xl:inline-flex">{t('Onboarding — only test numbers reach the agent')}</Badge>}
              {tenant.status === 'suspended' && <Badge tone="critical">{t('Suspended')}</Badge>}
              <Link href={`${base}/${newOrders ? 'orders' : 'inbox'}`} aria-label={t('{n} things need you', { n: bell })} title={t('{n} things need you', { n: bell })}
                className={cx('relative hidden size-10 items-center justify-center rounded-full transition-transform duration-150 active:scale-95 sm:flex', roundBtn)}>
                <Bell className="size-[18px]" aria-hidden />
                {bell > 0 && <span key={bell} className="ew-pop absolute -end-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-critical px-1 text-[11px] font-semibold text-white ring-2 ring-white">{bell}</span>}
              </Link>
              <ThemePicker dark={dark} />
              <LangSwitch className="hidden sm:inline-flex" />
              <AgentSwitch />
            </div>
          </header>

          {/* a page arrives through a short blur; the kitchen screen uses every pixel, the others keep a readable width */}
          <main key={path.split('/').slice(0, 4).join('/')}
                className={cx('ew-page', dark ? 'w-full' : 'mx-auto w-full max-w-[1400px] px-4 pb-10 pt-2 lg:px-7')}>{children}</main>
        </div>
      </div>

      {/* a phone: the everyday pages in a dock under the thumb, the rest behind "Menu" */}
      <nav aria-label={t('Main')} className="ew-card fixed inset-x-3 bottom-3 z-30 flex items-center justify-between gap-1 !rounded-full p-1.5 lg:hidden">
        {[{ href: '', label: 'Overview', icon: LayoutDashboard }, { href: '/orders', label: 'Orders', icon: ShoppingBag, badge: 'orders' },
          { href: '/kitchen', label: 'Kitchen', icon: Flame }, { href: '/inbox', label: 'Inbox', icon: MessageCircle, badge: 'inbox' }].map(it => {
          const on = active(it.href), n = count(it.badge);
          return (
            <Link key={it.href} href={base + it.href} prefetch aria-current={on ? 'page' : undefined}
              className={cx('relative flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium transition-colors duration-200',
                on ? 'bg-navy text-white' : 'text-muted')}>
              <it.icon className="size-[18px]" aria-hidden />{t(it.label)}
              {n > 0 && <span className="absolute end-3 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-critical px-1 text-[10px] text-white">{n}</span>}
            </Link>
          );
        })}
        <button onClick={() => setMobileNav(true)} className="flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium text-muted">
          {mobileNav ? <X className="size-[18px]" aria-hidden /> : <MenuIcon className="size-[18px]" aria-hidden />}{t('More')}
        </button>
      </nav>

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
    </div>
  );
}
