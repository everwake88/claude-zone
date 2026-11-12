import Link from 'next/link';
import { headers } from 'next/headers';
import { Search, Bell } from 'lucide-react';
import { requireUser, getT } from '@/lib/auth';
import { one } from '@/lib/db';
import { logout, setLanguage } from '../actions';
import { Mark } from '@/components/Mark';
import { Rail, TabBar, type NavItem } from '@/components/Nav';
import { initials } from '@/lib/format';

export const dynamic = 'force-dynamic';


export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const { t, lang } = await getT();
  const s = await one<{ company_name: string; open_disputes: number }>(
    `select company_name, (select count(*)::int from salary.disputes where status = 'open') as open_disputes from salary.settings`);
  const path = (await headers()).get('x-pathname') || '/';
  const open = s?.open_disputes || 0;

  const items: NavItem[] = [
    { href: '/', icon: 'overview', label: t('nav.overview') },
    { href: '/sheets', icon: 'sheets', label: t('nav.sheets') },
    { href: '/disputes', icon: 'disputes', label: open ? `${t('nav.disputes')} · ${open}` : t('nav.disputes'), dot: open > 0 },
    { href: '/conversations', icon: 'conversations', label: t('nav.conversations') },
    { href: '/identity', icon: 'identity', label: t('nav.identity') }
  ];
  const settings: NavItem = { href: '/settings', icon: 'settings', label: t('nav.settings') };

  const langForm = (
    <form action={setLanguage}>
      <input type="hidden" name="lang" value={lang === 'ar' ? 'en' : 'ar'} />
      <input type="hidden" name="back" value={path} />
      <button className="icon-btn" type="submit" lang={lang === 'ar' ? 'en' : 'ar'} aria-label={t('nav.language')}>
        {lang === 'ar' ? 'EN' : 'ع'}
      </button>
    </form>
  );
  const bell = (
    <Link className="icon-btn" href="/disputes" aria-label={open ? `${t('nav.disputes')} · ${open}` : t('nav.disputes')}>
      <Bell aria-hidden="true" />{open > 0 && <span className="rail-dot" aria-hidden="true" />}
    </Link>
  );

  return (
    <div className="app">
      <div className="rail-col">
        <Link href="/" className="rail-mark" aria-label={s?.company_name || t('app.name')}><Mark size={48} /></Link>
        <Rail items={items} bottom={settings} signOut={logout} signOutLabel={t('nav.signout')}
              me={{ initials: initials(user.name || user.email), name: user.name || user.email }} />
      </div>
      <div className="main-wrap">
        <div className="cluster">
          <form className="search" action="/search" role="search">
            <input name="q" placeholder={t('hd.search')} aria-label={t('hd.search')} />
            <button type="submit" aria-label={t('s.title')}><Search aria-hidden="true" /></button>
          </form>
          {langForm}
          {bell}
        </div>
        <header className="topbar">
          <Link href="/" className="brand"><Mark size={38} /><span className="brand-name">{s?.company_name}</span></Link>
          <div className="tools">
            <Link className="icon-btn" href="/search" aria-label={t('s.title')}><Search aria-hidden="true" /></Link>
            {langForm}
            {bell}
          </div>
        </header>
        <main className="main">{children}</main>
        <footer className="powered">Powered by <b>Everwake</b></footer>
      </div>
      <TabBar items={[...items, settings]} />
    </div>
  );
}
