'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, Sheet, MessageSquareWarning, MessagesSquare, ShieldCheck, Settings } from 'lucide-react';

const ICONS = { overview: LayoutGrid, sheets: Sheet, disputes: MessageSquareWarning, conversations: MessagesSquare, identity: ShieldCheck, settings: Settings };
export type NavItem = { href: string; icon: keyof typeof ICONS; label: string; count?: number };

export function Nav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {items.map((it) => {
        const Icon = ICONS[it.icon];
        const active = it.href === '/' ? path === '/' : path.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} aria-current={active ? 'page' : undefined}>
            <Icon aria-hidden="true" />
            <span>{it.label}</span>
            {it.count ? <span className="count" aria-label={`${it.count}`}>{it.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

// on a phone the menu is a sheet over the page; it closes itself when a page is chosen
export function MobileMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const path = usePathname();
  return (
    <details key={path}>
      <summary>{label}</summary>
      <div className="sheet-menu">{children}</div>
    </details>
  );
}
