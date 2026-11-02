'use client';
import { Bell, ChevronDown, LogOut, Menu as MenuIcon, Search, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { askNotificationPermission, chime, notify } from '@/lib/alerts';
import { clock, cx, timeAgo } from '@/lib/format';
import { LangSwitch, useLang } from '@/lib/i18n';
import { LiveProvider, useLive } from '@/lib/live';
import { sb } from '@/lib/supabase/client';
import type { Alert } from '@/lib/types';
import { AssistantDock } from '../assistant/Assistant';
import { NewBooking, type BookingPrefill } from '../booking/NewBooking';
import { Wordmark } from '../mark';
import { BlockTime, RunningLate } from '../today/DayActions';
import { Avatar, useToast } from '../ui';
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
  me: string;
}
const ShellCtx = createContext<ShellApi>({ newBooking: () => {}, runningLate: () => {}, blockTime: () => {},
  counts: { alerts: 0, emergencies: 0, inbox: 0, waiting_room: 0, waitlist: 0 }, me: '' });
// the day's three actions from any page (a new booking, "I'm running late", time off) and who is signed in
export const useShell = () => useContext(ShellCtx);

export function Shell({ children }: { children: ReactNode }) {
  const { tenant } = useTenant();
  return <LiveProvider tenantId={tenant.id}><Frame>{children}</Frame></LiveProvider>;
}

// The frame: a navy slab holds the way around; the selected page is a paper tab that runs out
// of it into the page. The work sits on white cards on paper. On a phone the slab folds into a
// navy bar under the thumb.
function Frame({ children }: { children: ReactNode }) {
  const { tenant, base } = useTenant();
  const path = usePathname();
  const router = useRouter();
  const toast = useToast();
  const { t, lang } = useLang();
  const palette = useCommandPalette();
  const [counts, setCounts] = useState<Counts>({ alerts: 0, emergencies: 0, inbox: 0, waiting_room: 0, waitlist: 0 });
  const [me, setMe] = useState('');
  const [drawerNav, setDrawerNav] = useState(false);
  const [booking, setBooking] = useState<{ open: boolean; prefill?: BookingPrefill }>({ open: false });
  const [late, setLate] = useState<{ open: boolean; doctor?: string }>({ open: false });
  const [block, setBlock] = useState<{ open: boolean; doctor?: string }>({ open: false });
  const toasted = useRef(new Set<string>());

  useEffect(() => { setDrawerNav(false); }, [path]);
  useEffect(() => { sb().rpc('my_name', { p_tenant: tenant.id }).then(({ data }) => setMe(String(data || ''))); }, [tenant.id]);

  const loadCounts = useCallback(async () => {
    const { data } = await sb().rpc('dashboard_counts', { p_tenant: tenant.id });
    if (data) setCounts(data as Counts);
  }, [tenant.id]);
  useEffect(() => { loadCounts(); askNotificationPermission(); }, [loadCounts]);
  useLive(['alerts', 'conversations', 'appointments', 'waitlist', 'team_questions'], loadCounts, 600);

  // what happened while the page was open, said once (an emergency has its own card)
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
    counts, me
  };
  const active = (href: string) => (href === '' ? path === base : path.startsWith(base + href));
  const count = (b?: Badge) => (b ? counts[b] || 0 : 0);

  return (
    <ShellCtx.Provider value={api}>
      <div className="min-h-dvh">
        <aside className="fixed inset-y-3 start-3 z-30 hidden w-[236px] lg:block">
          <Slab active={active} count={count} counts={counts} />
        </aside>

        {/* a phone: the slab slides in from the side */}
        <AnimatePresence>
          {drawerNav && (
            <div className="fixed inset-0 z-50 lg:hidden">
              <motion.div className="absolute inset-0 bg-navy/40" onClick={() => setDrawerNav(false)}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
              <motion.div className="absolute inset-y-2 start-2 w-[272px] max-w-[85vw]"
                initial={{ transform: `translateX(${lang === 'ar' ? 110 : -110}%)` }} animate={{ transform: 'translateX(0%)' }} exit={{ transform: `translateX(${lang === 'ar' ? 110 : -110}%)` }}
                transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}>
                <button onClick={() => setDrawerNav(false)} className="press absolute end-3 top-4 z-10 rounded-full p-2 text-on-navy-muted hover:bg-white/10" aria-label={t('Close')}><X className="size-4" /></button>
                <Slab active={active} count={count} counts={counts} phone />
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <div className="min-w-0 lg:ps-[260px]">
          <header className="sticky top-0 z-20 flex h-16 items-center gap-2 bg-paper/85 px-4 backdrop-blur-md lg:px-8">
            <button className="press flex size-10 items-center justify-center rounded-full text-ink hover:bg-sunk/70 lg:hidden" onClick={() => setDrawerNav(true)} aria-label={t('Menu')}>
              <MenuIcon className="size-5" />
            </button>
            <span className="truncate text-[15px] font-semibold lg:hidden">{(lang === 'ar' ? tenant.name_ar : tenant.name_en) || tenant.name_ar}</span>
            <button onClick={() => palette.setOpen(true)}
              className="press ms-auto flex h-10 items-center gap-2.5 rounded-full bg-sheet px-4 text-[13px] text-faint ring-1 ring-inset ring-border hover:text-muted max-lg:size-10 max-lg:justify-center max-lg:px-0 lg:ms-0 lg:w-[380px]"
              aria-label={t('Search')}>
              <Search className="size-4 shrink-0" aria-hidden />
              <span className="hidden truncate lg:inline">{t('A patient, a phone number, a page…')}</span>
              <kbd className="ms-auto hidden rounded-md bg-raised px-1.5 text-[11px] text-muted ring-1 ring-border lg:inline">/</kbd>
            </button>
            <div className="flex items-center gap-1.5 lg:ms-auto">
              {tenant.status === 'onboarding' && (
                <span className="hidden items-center gap-1.5 rounded-full bg-gold-wash px-3 py-1.5 text-xs font-medium text-gold-ink xl:inline-flex">
                  {t('Setting up — only test numbers reach the assistant')}
                </span>
              )}
              <span className="lg:hidden"><AgentSwitch compact /></span>
              <span className="hidden lg:inline"><LangSwitch /></span>
              <AlertsBell count={counts.alerts} urgent={counts.emergencies > 0} />
              <UserChip name={me} />
            </div>
          </header>
          <main key={path.split('/').slice(0, 4).join('/')} className="c-page mx-auto w-full max-w-[1340px] px-4 pb-28 pt-2 lg:px-8 lg:pb-12">
            <EmergencyBanner />
            {children}
          </main>
        </div>

        {/* a phone: the everyday pages under the thumb */}
        <nav aria-label={t('Main')} className="fixed inset-x-3 bottom-3 z-40 flex rounded-[22px] bg-navy p-1.5 shadow-[0_12px_32px_-12px_rgb(11_34_46/.6)] lg:hidden">
          {MOBILE_NAV.map(it => {
            const on = active(it.href), n = count(it.badge);
            return (
              <Link key={it.href} href={base + it.href} prefetch aria-current={on ? 'page' : undefined}
                className={cx('press relative flex h-[52px] flex-1 flex-col items-center justify-center gap-0.5 rounded-[16px] text-[11px] font-medium',
                  on ? 'text-navy' : 'text-on-navy-muted')}>
                {on && <motion.span layoutId="phone-nav-on" className="absolute inset-0 rounded-[16px] bg-paper" transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }} />}
                <it.icon className={cx('relative size-5', on && 'text-gold-ink')} aria-hidden /><span className="relative">{t(it.label)}</span>
                {n > 0 && <span className="absolute end-[calc(50%-18px)] top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[10px] font-semibold text-navy">{n}</span>}
              </Link>
            );
          })}
          <button onClick={() => setDrawerNav(true)} className="press relative flex h-[52px] flex-1 flex-col items-center justify-center gap-0.5 rounded-[16px] text-[11px] font-medium text-on-navy-muted">
            <MenuIcon className="size-5" aria-hidden />{t('More')}
            {counts.alerts + counts.waitlist > 0 && <span className={cx('absolute end-[calc(50%-14px)] top-2 size-2 rounded-full', counts.emergencies ? 'bg-critical' : 'bg-gold')} />}
          </button>
        </nav>
      </div>

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
      <NewBooking open={booking.open} prefill={booking.prefill} onClose={() => setBooking({ open: false })} />
      <RunningLate open={late.open} doctorId={late.doctor} onClose={() => setLate({ open: false })} />
      <BlockTime open={block.open} doctorId={block.doctor} onClose={() => setBlock({ open: false })} />
      <AssistantDock />
    </ShellCtx.Provider>
  );
}

// the navy slab: the product, the clinic, the pages, and the assistant's switch at its foot
function Slab({ active, count, counts, phone }: { active: (h: string) => boolean; count: (b?: Badge) => number; counts: Counts; phone?: boolean }) {
  const { tenant, tenants, base, brand, role } = useTenant();
  const { t, lang } = useLang();
  const router = useRouter();
  const [switcher, setSwitcher] = useState(false);
  const name = (lang === 'ar' ? tenant.name_ar : tenant.name_en) || tenant.name_ar;
  const initial = name.replace(/^(عيادات?|عيادة|مركز|clinics?|the)\s+/i, '').replace(/^ال(?=\S{2})/, '').slice(0, 1).toUpperCase();
  const signOut = async () => { await sb().auth.signOut(); router.replace('/login'); };
  return (
    <div className="flex h-full flex-col rounded-[24px] bg-navy text-white">
      <div className="px-5 pb-4 pt-6"><Wordmark /></div>
      <div className="relative px-3">
        <button onClick={() => setSwitcher(s => !s)} aria-expanded={switcher}
          className="press flex w-full items-center gap-2.5 rounded-2xl bg-navy-raised px-2.5 py-2 text-start hover:bg-navy-soft">
          {brand.logo_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={brand.logo_url} alt="" className="size-9 shrink-0 rounded-xl bg-white object-contain p-0.5" />
            : <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-navy-soft text-[15px] font-semibold text-gold-bright ring-1 ring-inset ring-navy-line">{initial}</span>}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold leading-tight">{name}</span>
            <span className="block truncate text-xs text-on-navy-muted">{t(role)}</span>
          </span>
          <ChevronDown className={cx('size-4 shrink-0 text-on-navy-muted transition-transform duration-200', switcher && 'rotate-180')} aria-hidden />
        </button>
        <AnimatePresence>
          {switcher && (
            <motion.div initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }} style={{ transformOrigin: 'top center' }}
              className="absolute inset-x-3 top-full z-50 mt-1.5 rounded-2xl bg-sheet p-1.5 text-ink shadow-[0_16px_40px_-16px_rgb(11_34_46/.45)] ring-1 ring-border">
              {tenants.map(x => (
                <Link key={x.id} href={`/c/${x.slug}`} className={cx('block truncate rounded-xl px-3 py-2 text-[13px] hover:bg-raised', x.id === tenant.id && 'font-semibold')}>
                  {lang === 'ar' ? x.name_ar : x.name_en}
                </Link>
              ))}
              <Link href="/new" className="block rounded-xl px-3 py-2 text-[13px] font-medium text-gold-ink hover:bg-gold-wash">+ {t('Add a clinic')}</Link>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <nav className="mt-5 flex flex-col gap-0.5 ps-3" aria-label={t('Main')}>
        {NAV.map((g, gi) => (
          <div key={gi} className={cx(gi > 0 && 'mt-5')}>
            {g.group && <p className="px-3 pb-1.5 text-[12px] font-medium text-on-navy-muted/80">{t(g.group)}</p>}
            {g.items.map(({ href, label, icon: Icon, badge }) => {
              const n = count(badge), on = active(href);
              const urgent = badge === 'alerts' && counts.emergencies > 0;
              return (
                <Link key={href} href={base + href} prefetch aria-current={on ? 'page' : undefined}
                  className={cx('group relative flex h-11 items-center gap-3 rounded-s-2xl px-3 text-[13.5px] transition-colors duration-200',
                    phone ? 'me-3 rounded-e-2xl' : '', on ? 'font-semibold text-navy' : 'text-on-navy-muted hover:text-white')}>
                  {on && <motion.span layoutId={phone ? 'nav-on-phone' : 'nav-on'}
                                      className={cx('absolute inset-0 bg-paper', phone ? 'rounded-2xl' : 'tab-notch rounded-s-2xl')}
                                      transition={{ duration: 0.32, ease: [0.23, 1, 0.32, 1] }} />}
                  <Icon className={cx('relative size-[18px] shrink-0', on ? 'text-gold-ink' : 'transition-transform duration-200 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5')} aria-hidden />
                  <span className="relative flex-1 truncate">{t(label)}</span>
                  {n > 0 && (
                    <span key={n} className={cx('c-pop relative me-2 flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
                      urgent ? 'bg-critical text-white' : on ? 'bg-gold-wash text-gold-ink' : 'bg-gold text-navy')}>{n}</span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="mt-auto space-y-2 px-3 pb-3 pt-6">
        <AgentSwitch dark />
        <div className="flex items-center justify-between gap-2">
          <LangSwitch dark />
          <button onClick={signOut} className="press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-on-navy-muted hover:bg-white/10 hover:text-white">
            <LogOut className="size-4 rtl:rotate-180" aria-hidden />{t('Sign out')}
          </button>
        </div>
      </div>
    </div>
  );
}

// the bell: how many things need someone, and the latest five, one tap from anywhere
function AlertsBell({ count, urgent }: { count: number; urgent: boolean }) {
  const { tenant, base } = useTenant();
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Alert[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    sb().rpc('alert_list', { p_tenant: tenant.id, p_status: 'open', p_kind: null, p_limit: 5 }).then(({ data }) => setList((data || []) as Alert[]));
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open, tenant.id]);
  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={t('{n} things need someone', { n: count })}
        className="press relative flex size-10 items-center justify-center rounded-full bg-sheet text-ink ring-1 ring-inset ring-border hover:bg-raised">
        <Bell className="size-[18px]" aria-hidden />
        {count > 0 && <span key={count} className={cx('c-pop absolute -end-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10.5px] font-semibold ring-2 ring-paper',
          urgent ? 'bg-critical text-white' : 'bg-gold text-navy')}>{count}</span>}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }} style={{ transformOrigin: 'top right' }}
            className="absolute end-0 top-12 z-50 w-[340px] max-w-[calc(100vw-2rem)] rounded-[20px] bg-sheet p-2 shadow-[0_20px_48px_-20px_rgb(11_34_46/.45)] ring-1 ring-border">
            <p className="px-3 pb-1 pt-2 text-[13px] font-semibold">{t('Needs you')}</p>
            {!list ? <div className="space-y-2 p-3"><span className="skeleton block h-9" /><span className="skeleton block h-9" /></div>
              : list.length === 0 ? <p className="px-3 pb-3 pt-1 text-[13px] text-muted">{t('Nothing needs you right now.')}</p>
              : <ul>{list.map(a => (
                  <li key={a.id}>
                    <Link href={a.conversation_id ? `${base}/inbox?c=${a.conversation_id}` : `${base}/alerts`} onClick={() => setOpen(false)}
                      className="flex items-start gap-2.5 rounded-xl px-3 py-2.5 hover:bg-raised">
                      <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', a.kind === 'emergency' ? 'bg-critical' : a.severity === 'high' ? 'bg-critical' : 'bg-caution')} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium"><bdi>{a.who || a.title}</bdi></span>
                        <span className="block truncate text-xs text-muted"><bdi>{a.body || a.title}</bdi></span>
                      </span>
                      <span className="shrink-0 text-[11px] text-faint">{timeAgo(a.created_at)}</span>
                    </Link>
                  </li>))}</ul>}
            <Link href={`${base}/alerts`} onClick={() => setOpen(false)} className="mt-1 block rounded-xl px-3 py-2 text-center text-[13px] font-medium text-gold-ink hover:bg-gold-wash">{t('All alerts')}</Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function UserChip({ name }: { name: string }) {
  const { role } = useTenant();
  const { t } = useLang();
  return (
    <span className="hidden items-center gap-2.5 rounded-full bg-sheet py-1 pe-3.5 ps-1 ring-1 ring-inset ring-border md:flex">
      <Avatar name={name || '?'} size={32} />
      <span className="leading-tight">
        <span className="block max-w-36 truncate text-[13px] font-medium"><bdi>{name || '—'}</bdi></span>
        <span className="block text-[11.5px] text-faint">{t(role)}</span>
      </span>
    </span>
  );
}
