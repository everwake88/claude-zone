import { BellRing, BookOpenText, CalendarDays, ClipboardList, Hourglass, MessageCircle, Settings, Stethoscope, Sun, Users } from 'lucide-react';

// What the front desk and the doctor use every day, then what sets the clinic up.
export type Badge = 'inbox' | 'alerts' | 'waitlist';
export type NavItem = { href: string; label: string; icon: typeof Sun; badge?: Badge; edit?: boolean };
export const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [
    { href: '', label: 'Today', icon: Sun },
    { href: '/calendar', label: 'Calendar', icon: CalendarDays },
    { href: '/patients', label: 'Patients', icon: Users },
    { href: '/inbox', label: 'Inbox', icon: MessageCircle, badge: 'inbox' },
    { href: '/alerts', label: 'Alerts', icon: BellRing, badge: 'alerts' },
    { href: '/waitlist', label: 'Waitlist', icon: Hourglass, badge: 'waitlist' }] },
  { group: 'Your clinic', items: [
    { href: '/services', label: 'Services & prices', icon: ClipboardList },
    { href: '/knowledge', label: 'Knowledge & rules', icon: BookOpenText },
    { href: '/settings', label: 'Settings', icon: Settings }] }
];
export const MOBILE_NAV: NavItem[] = [
  { href: '', label: 'Today', icon: Sun },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/patients', label: 'Patients', icon: Stethoscope },
  { href: '/inbox', label: 'Inbox', icon: MessageCircle, badge: 'inbox' }
];
