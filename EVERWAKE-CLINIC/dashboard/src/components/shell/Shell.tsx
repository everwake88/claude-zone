'use client';
import { ChevronsUpDown, LogOut, Menu as MenuIcon, Plus, Search, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { askNotificationPermission, chime, notify } from '@/lib/alerts';
import { useBrand } from '@/lib/brand';
import { clock, cx } from '@/lib/format';
import { LangSwitch, useLang } from '@/lib/i18n';
import { LiveProvider, useLive } from '@/lib/live';
import { sb } from '@/lib/supabase/client';
import { NewBooking, type BookingPrefill } from '../booking/NewBooking';
import { BlockTime, RunningLate } from '../today/DayActions';
import { Button, useToast } from '../ui';
import { useTenant } from '../tenant';
import { AgentSwitch } from './AgentSwitch';
import { CommandPalette, useCommandPalette } from './CommandPalette';
import { EmergencyBanner } from './EmergencyBanner';
import { MOBILE_NAV, NAV, type Badge } from './nav';

type Counts = Record<'alerts' | 'emergencies' | 'inbox' | 'waiting_room' | 'waitlist', number>;
interface ShellApi {
  newBooking: (prefill?: BookingPrefill) => void;
  runningLate: (doctorId?: string) => void;
  blockTime: (doctorId?: string) => void;
  counts: Counts;
}
const ShellCtx = createContext<ShellApi>({ newBooking: () => {}, runningLate: () => {}, blockTime: () => {},
  counts: { alerts: 0, emergencies: 0, inbox: 0, waiting_room: 0, waitlist: 0 } });
// the day's three actions, from any page: a new booking, "I'm running late", time off
export const useShell = () => useContext(ShellCtx);

export function Shell({ children }: { children: ReactNode }) {
  const { tenant, brand } = useTenant();
  useBrand(brand);
  return <LiveProvider tenantId={tenant.id}><Frame>{children}</Frame></LiveProvider>;
}

// The frame: the navigation on the clinic's paper, the work on a white sheet beside it.
// On a phone the sheet fills the screen and the everyday pages sit in a bar under the thumb.
function Frame({ children }: { children: ReactNode }) {
  const { tenant, tenants, base, brand, role } = useTenant();
  const path = usePathname();
  const router = useRouter();
  const toast = useToast();
  const { t, lang } = useLang();
  const palette = useCommandPalette();
  const [counts, setCounts] = useState<Counts>({ alerts: 0, emergencies: 0, inbox: 0, waiting_room: 0, waitlist: 0 });
  const [drawerNav, setDrawerNav] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [booking, setBooking] = useState<{ open: boolean; prefill?: BookingPrefill }>({ open: false });
  const [late, setLate] = useState<{ open: boolean; doctor?: string }>({ open: false });
  const [block, setBlock] = useState<{ open: boolean; doctor?: string }>({ open: false });
  const toasted = useRef(new Set<string>());

  useEffect(() => { setDrawerNav(false); setSwitcher(false); }, [path]);

  const loadCounts = useCallback(async () => {
    const { data } = await sb().rpc('dashboard_counts', { p_tenant: tenant.id });
    if (data) setCounts(data as Counts);
  }, [tenant.id]);
  useEffect(() => { loadCounts(); askNotificationPermission(); }, [loadCounts]);
  useLive(['alerts', 'conversations', 'appointments', 'waitlist', 'team_questions'], loadCounts, 600);

  // what happened while the page was open, said once: a booking the assistant made, a reply to a
  // delay, an alert. (An emergency has its own banner.)
  useLive(['appointments', 'delay_notice_items', 'alerts'], (e) => {
    const r = e.row as Record<string, string | number | null>;
    if (e.table === 'appointments' && r.source === 'whatsapp' && r.status === 'booked' && r.ref_no
        && Date.now() - new Date(String(r.created_at)).getTime() < 20 * 60_000 && !toasted.current.has('a' + r.id)) {
      toasted.current.add('a' + r.id);
      chime();
      toast(t('The assistant booked {ref} for {when}', { ref: r.ref_no, when: clock(String(r.est_at || r.starts_at), tenant.timezone) }), 'neutral');
    } else if (e.table === 'delay_notice_items' && e.event === 'UPDATE' && !toasted.current.has(`d${r.id}${r.status}`)) {
      const said: Record<string, string> = { accepted: 'A patient accepted the new time', changed: 'A patient moved to another time',
        cancelled: 'A patient cancelled after the delay notice', no_reply: 'A patient has not answered the delay notice' };
      if (said[String(r.status)]) { toasted.current.add(`d${r.id}${r.status}`); toast(t(said[String(r.status)]), r.status === 'accepted' ? 'positive' : 'neutral'); }
    } else if (e.table === 'alerts' && e.event === 'INSERT' && r.kind !== 'emergency' && !toasted.current.has('al' + r.id)) {
      toasted.current.add('al' + r.id);
      if (r.severity === 'high') { chime(); notify(String(r.title), String(r.body || '')); }
      toast(String(r.title), r.severity === 'high' ? 'critical' : 'neutral', { label: t('Open'), run: () => router.push(`${base}/alerts`) });
    }
  }, 0);

  const api: ShellApi = {
    newBooking: (prefill) => setBooking({ open: true, prefill }),
    runningLate: (doctor) => setLate({ open: true, doctor }),
    blockTime: (doctor) => setBlock({ open: true, doctor }),
    counts
  };

  const active = (href: string) => (href === '' ? path === base : path.startsWith(base + href));
  const count = (b?: Badge) => (b ? counts[b] || 0 : 0);
  const signOut = async () => { await sb().auth.signOut(); router.replace('/login'); };
  const name = (lang === 'ar' ? tenant.name_ar : tenant.name_en) || tenant.name_ar;

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label={t('Main')}>
      {NAV.map((g, gi) => (
        <div key={gi} className={cx(gi > 0 && 'mt-4')}>
          {g.group && <p className="px-2.5 pb-1 text-[11.5px] font-medium text-faint">{t(g.group)}</p>}
          {g.items.map(({ href, label, icon: Icon, badge }) => {
            const n = count(badge), on = active(href);
            const urgent = badge === 'alerts' && counts.emergencies > 0;
            return (
              <Link key={href} href={base + href} prefetch aria-current={on ? 'page' : undefined}
                className={cx('group relative flex h-9 items-center gap-2.5 rounded-[8px] px-2.5 text-[13.5px] transition-colors duration-150',
                  on ? 'font-medium text-ink' : 'text-muted hover:bg-active/60 hover:text-ink')}>
                {on && <motion.span layoutId="nav-on" className="absolute inset-0 rounded-[8px] bg-sheet shadow-[0_1px_2px_rgb(15_23_41/.08)] ring-1 ring-border"
                                    transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }} />}
                <Icon className={cx('relative size-[17px] shrink-0', on ? 'text-accent' : 'text-faint group-hover:text-muted')} aria-hidden />
                <span className="relative flex-1 truncate">{t(label)}</span>
                {n > 0 && (
                  <span key={n} className={cx('c-pop relative flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
                    urgent ? 'bg-critical text-white' : 'bg-accent-soft text-accent-ink')}>{n}</span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  const side = (
    <div className="flex h-full flex-col gap-4 px-3 py-4">
      <div className="relative">
        <button onClick={() => setSwitcher(s => !s)} aria-expanded={switcher}
          className="press flex w-full items-center gap-2.5 rounded-[10px] px-1.5 py-1.5 text-start hover:bg-active/60">
          {brand.logo_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={brand.logo_url} alt="" className="size-9 shrink-0 rounded-[9px] bg-sheet object-contain p-0.5 ring-1 ring-border" />
            : <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-accent text-[15px] font-semibold text-white">{name.replace(/^(عيادات?|عيادة|clinics?)\s+/i, '').slice(0, 1)}</span>}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold leading-tight">{name}</span>
            <span className="block truncate text-xs text-muted">{t(role)}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-faint" aria-hidden />
        </button>
        <AnimatePresence>
          {switcher && (
            <motion.div initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }} style={{ transformOrigin: 'top center' }}
              className="absolute inset-x-0 top-full z-50 mt-1 rounded-[10px] bg-sheet p-1 shadow-[0_16px_40px_-16px_rgb(15_23_41/.35)] ring-1 ring-border">
              {tenants.map(x => (
                <Link key={x.id} href={`/c/${x.slug}`} className={cx('block truncate rounded-[7px] px-2.5 py-2 text-[13px] hover:bg-raised', x.id === tenant.id && 'font-semibold')}>
                  {lang === 'ar' ? x.name_ar : x.name_en}
                </Link>
              ))}
              <Link href="/new" className="block rounded-[7px] px-2.5 py-2 text-[13px] text-accent hover:bg-raised">+ {t('Add a clinic')}</Link>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {nav}
      <div className="mt-auto space-y-2">
        <AgentSwitch />
        <div className="flex items-center justify-between gap-2 px-1">
          <LangSwitch />
          <button onClick={signOut} className="press inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2 text-[13px] text-muted hover:bg-active/60 hover:text-ink">
            <LogOut className="size-4 rtl:rotate-180" aria-hidden />{t('Sign out')}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <ShellCtx.Provider value={api}>
      <div className="min-h-dvh lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh overflow-y-auto lg:block">{side}</aside>

        {/* a phone: the navigation slides in from the side */}
        <AnimatePresence>
          {drawerNav && (
            <div className="fixed inset-0 z-50 lg:hidden">
              <motion.div className="absolute inset-0 bg-ink/30" onClick={() => setDrawerNav(false)}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
              <motion.aside className="absolute inset-y-0 start-0 w-[280px] max-w-[85vw] overflow-y-auto bg-ground shadow-xl"
                initial={{ x: lang === 'ar' ? '100%' : '-100%' }} animate={{ x: 0 }} exit={{ x: lang === 'ar' ? '100%' : '-100%' }}
                transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}>
                <button onClick={() => setDrawerNav(false)} className="press absolute end-2 top-3 z-10 rounded-md p-2 text-muted" aria-label={t('Close')}><X className="size-4" /></button>
                {side}
              </motion.aside>
            </div>
          )}
        </AnimatePresence>

        <div className="min-w-0 lg:py-2 lg:pe-2">
          <div className="flex min-h-dvh flex-col bg-sheet lg:min-h-[calc(100dvh-16px)] lg:rounded-2xl lg:border lg:border-border">
            <EmergencyBanner />
            <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-rule bg-sheet/90 px-3 backdrop-blur-md lg:rounded-t-2xl lg:px-6">
              <button className="press flex size-9 items-center justify-center rounded-[8px] text-ink hover:bg-raised lg:hidden" onClick={() => setDrawerNav(true)} aria-label={t('Menu')}>
                <MenuIcon className="size-5" />
              </button>
              <span className="truncate text-[14px] font-semibold lg:hidden">{name}</span>
              <button onClick={() => palette.setOpen(true)}
                className="press ms-auto flex h-9 items-center gap-2 rounded-[8px] px-2.5 text-[13px] text-faint ring-1 ring-inset ring-border hover:bg-raised hover:text-muted max-lg:size-9 max-lg:justify-center max-lg:px-0 lg:ms-0 lg:w-[320px]"
                aria-label={t('Search')}>
                <Search className="size-4 shrink-0" aria-hidden />
                <span className="hidden truncate lg:inline">{t('A patient, a phone number, a page…')}</span>
                <kbd className="ms-auto hidden rounded bg-raised px-1.5 text-[11px] text-muted ring-1 ring-border lg:inline">/</kbd>
              </button>
              <div className="flex items-center gap-2 lg:ms-auto">
                {tenant.status === 'onboarding' && (
                  <span className="hidden items-center gap-1.5 rounded-full bg-caution-soft px-2.5 py-1 text-xs font-medium text-caution xl:inline-flex">
                    {t('Setting up — only test numbers reach the assistant')}
                  </span>
                )}
                <span className="lg:hidden"><AgentSwitch compact /></span>
                <Button variant="accent" onClick={() => api.newBooking()} className="max-sm:size-9 max-sm:px-0" aria-label={t('New booking')}>
                  <Plus className="size-4" aria-hidden /><span className="max-sm:hidden">{t('New booking')}</span>
                </Button>
              </div>
            </header>
            <main key={path.split('/').slice(0, 4).join('/')} className="c-page mx-auto w-full max-w-[1320px] flex-1 px-4 pb-28 pt-5 lg:px-8 lg:pb-10">{children}</main>
          </div>
        </div>

        {/* a phone: the everyday pages under the thumb */}
        <nav aria-label={t('Main')} className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-sheet/95 px-1 pb-[max(env(safe-area-inset-bottom),4px)] pt-1 backdrop-blur-md lg:hidden">
          {MOBILE_NAV.map(it => {
            const on = active(it.href), n = count(it.badge);
            return (
              <Link key={it.href} href={base + it.href} prefetch aria-current={on ? 'page' : undefined}
                className={cx('press relative flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[11px] font-medium',
                  on ? 'text-accent' : 'text-muted')}>
                <it.icon className="size-5" aria-hidden />{t(it.label)}
                {n > 0 && <span className="absolute start-[calc(50%+6px)] top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-critical px-1 text-[10px] text-white">{n}</span>}
              </Link>
            );
          })}
          <button onClick={() => setDrawerNav(true)} className="press relative flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[11px] font-medium text-muted">
            <MenuIcon className="size-5" aria-hidden />{t('More')}
            {counts.alerts + counts.waitlist > 0 && <span className="absolute start-[calc(50%+6px)] top-1.5 size-2 rounded-full bg-critical" />}
          </button>
        </nav>
      </div>

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
      <NewBooking open={booking.open} prefill={booking.prefill} onClose={() => setBooking({ open: false })} />
      <RunningLate open={late.open} doctorId={late.doctor} onClose={() => setLate({ open: false })} />
      <BlockTime open={block.open} doctorId={block.doctor} onClose={() => setBlock({ open: false })} />
    </ShellCtx.Provider>
  );
}

