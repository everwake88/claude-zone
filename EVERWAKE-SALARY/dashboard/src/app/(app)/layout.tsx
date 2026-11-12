import { headers } from 'next/headers';
import { requireUser, getT } from '@/lib/auth';
import { one } from '@/lib/db';
import { logout, setLanguage } from '../actions';
import { Mark } from '@/components/Mark';
import { Nav, MobileMenu, type NavItem } from '@/components/Nav';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const { t, lang } = await getT();
  const s = await one<{ company_name: string; agent_enabled: boolean; open_disputes: number }>(
    `select company_name, agent_enabled, (select count(*)::int from salary.disputes where status = 'open') as open_disputes from salary.settings`);
  const path = (await headers()).get('x-pathname') || '/';

  const items: NavItem[] = [
    { href: '/', icon: 'overview', label: t('nav.overview') },
    { href: '/sheets', icon: 'sheets', label: t('nav.sheets') },
    { href: '/disputes', icon: 'disputes', label: t('nav.disputes'), count: s?.open_disputes || 0 },
    { href: '/conversations', icon: 'conversations', label: t('nav.conversations') },
    { href: '/identity', icon: 'identity', label: t('nav.identity') },
    { href: '/settings', icon: 'settings', label: t('nav.settings') }
  ];
  const brand = (
    <div className="brand">
      <Mark />
      <div>
        <div className="brand-name">{s?.company_name}</div>
        <div className="brand-sub">{t('app.name')}</div>
      </div>
    </div>
  );
  const foot = (
    <div className="side-foot">
      <div className="agent-state">
        <span className={`dot${s?.agent_enabled ? '' : ' off'}`} aria-hidden="true" />
        {s?.agent_enabled ? t('nav.agentOn') : t('nav.agentOff')}
      </div>
      <div className="who">
        <span>{user.name || user.email}</span>
        <form action={logout}><button className="linkish" type="submit">{t('nav.signout')}</button></form>
      </div>
      <form action={setLanguage}>
        <input type="hidden" name="lang" value={lang === 'ar' ? 'en' : 'ar'} />
        <input type="hidden" name="back" value={path} />
        <button className="linkish" type="submit" lang={lang === 'ar' ? 'en' : 'ar'}>{t('nav.language')}</button>
      </form>
      <p className="powered">Powered by <b>Everwake</b></p>
    </div>
  );

  return (
    <div className="shell">
      <aside className="side">
        {brand}
        <Nav items={items} />
        {foot}
      </aside>
      <header className="topbar">
        {brand}
        <MobileMenu label={t('nav.menu')}>
          <Nav items={items} />
          {foot}
        </MobileMenu>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
