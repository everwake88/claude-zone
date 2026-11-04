import {
  BarChart3, Bike, CalendarDays, ChefHat, Flame, LayoutDashboard, Map, Megaphone, MessageCircle, Percent, Receipt, Settings, ShoppingBag, Store, Users
} from 'lucide-react';

// grouped so a new owner sees what is daily work, what is setting up, and what grows the business
export type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; badge?: 'orders' | 'inbox' | 'bookings'; editors?: boolean };
export const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [{ href: '', label: 'Overview', icon: LayoutDashboard }] },
  { group: 'Every day', items: [
    { href: '/orders', label: 'Orders', icon: ShoppingBag, badge: 'orders' },
    { href: '/kitchen', label: 'Kitchen', icon: Flame },
    { href: '/inbox', label: 'Inbox', icon: MessageCircle, badge: 'inbox' },
    { href: '/reservations', label: 'Table bookings', icon: CalendarDays, badge: 'bookings' },
    { href: '/customers', label: 'Customers', icon: Users }] },
  { group: 'Your restaurant', items: [
    { href: '/menu', label: 'Menu', icon: ChefHat },
    { href: '/branches', label: 'Branches', icon: Store },
    { href: '/zones', label: 'Delivery zones', icon: Map },
    { href: '/drivers', label: 'Drivers', icon: Bike },
    { href: '/offers', label: 'Offers', icon: Percent }] },
  { group: 'Grow', items: [
    { href: '/growth', label: 'Get customers', icon: Megaphone },
    { href: '/analytics', label: 'Analytics', icon: BarChart3 }] },
  { group: null, items: [{ href: '/billing', label: 'Bills', icon: Receipt, editors: true }, { href: '/settings', label: 'Settings', icon: Settings }] }
];
