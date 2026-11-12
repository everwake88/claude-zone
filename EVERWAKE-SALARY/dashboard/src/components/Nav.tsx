'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayoutGrid, Sheet, MessageSquareWarning, MessagesSquare, Fingerprint, Settings, LogOut } from 'lucide-react';

const ICONS = { overview: LayoutGrid, sheets: Sheet, disputes: MessageSquareWarning, conversations: MessagesSquare, identity: Fingerprint, settings: Settings };
export type NavItem = { href: string; icon: keyof typeof ICONS; label: string; dot?: boolean };

const isActive = (href: string, path: string) => (href === '/' ? path === '/' : path.startsWith(href));

// The page you chose lights up the moment you click it, not when the server answers:
// the disc slides there at once, and the page follows.
function useActive(items: NavItem[]) {
  const path = usePathname();
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [path]);
  const active = chosen ?? items.find((i) => isActive(i.href, path))?.href ?? null;
  return { active, choose: setChosen };
}

// the floating rail (desktop): the main pages with the sliding disc, then settings, sign out and you
export function Rail({ items, bottom, signOut, signOutLabel, me }: {
  items: NavItem[]; bottom: NavItem; signOut: () => Promise<void>; signOutLabel: string; me: { initials: string; name: string };
}) {
  const { active, choose } = useActive([...items, bottom]);
  const at = items.findIndex((i) => i.href === active);
  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-group">
        <span className="rail-disc" aria-hidden="true" style={{ ['--at' as string]: Math.max(at, 0), opacity: at < 0 ? 0 : 1 }} />
        {items.map((it) => {
          const Icon = ICONS[it.icon];
          return (
            <Link key={it.href} href={it.href} className="rail-item" data-tip={it.label} aria-label={it.label}
                  aria-current={active === it.href ? 'page' : undefined} onClick={() => choose(it.href)}>
              <Icon aria-hidden="true" />
              {it.dot && <span className="rail-dot" aria-hidden="true" />}
            </Link>
          );
        })}
      </div>
      <div className="rail-group rail-bottom">
        <Link href={bottom.href} className="rail-item" data-tip={bottom.label} aria-label={bottom.label}
              aria-current={active === bottom.href ? 'page' : undefined} onClick={() => choose(bottom.href)}>
          <Settings aria-hidden="true" />
        </Link>
        <form action={signOut}>
          <button type="submit" className="rail-item" data-tip={signOutLabel} aria-label={signOutLabel}><LogOut aria-hidden="true" className="flip" /></button>
        </form>
        <Link href="/settings?tab=team" className="avatar" data-tip={me.name} aria-label={me.name} style={{ position: 'relative' }}>{me.initials}</Link>
      </div>
    </nav>
  );
}

// the same pages as a floating bar at the bottom of a phone
export function TabBar({ items }: { items: NavItem[] }) {
  const { active, choose } = useActive(items);
  const at = items.findIndex((i) => i.href === active);
  return (
    <nav className="tabbar" aria-label="Main" style={{ ['--n' as string]: items.length }}>
      <span className="tab-disc" aria-hidden="true" style={{ ['--at' as string]: Math.max(at, 0), opacity: at < 0 ? 0 : 1 }} />
      {items.map((it) => {
        const Icon = ICONS[it.icon];
        return (
          <Link key={it.href} href={it.href} className="rail-item" aria-label={it.label}
                aria-current={active === it.href ? 'page' : undefined} onClick={() => choose(it.href)}>
            <Icon aria-hidden="true" />
            {it.dot && <span className="rail-dot" aria-hidden="true" />}
          </Link>
        );
      })}
    </nav>
  );
}
