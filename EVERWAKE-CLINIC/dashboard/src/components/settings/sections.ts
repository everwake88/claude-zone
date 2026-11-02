import { Bot, Building2, CalendarClock, Clock3, MapPin, MessageSquareText, Palette, Smartphone, Stethoscope, UsersRound } from 'lucide-react';

// Settings, in the order a new clinic fills them in. `edit` sections need owner, manager or doctor;
// `owner` sections need the owner.
export const SETTINGS_SECTIONS = [
  { key: 'clinic', label: 'Clinic', sub: 'Name, about, insurance, payment', icon: Building2, need: 'edit' },
  { key: 'agent', label: 'The assistant', sub: 'Its name, tone, and what to say in an emergency', icon: Bot, need: 'edit' },
  { key: 'doctors', label: 'Doctors', sub: 'Who works here and what they treat', icon: Stethoscope, need: 'edit' },
  { key: 'locations', label: 'Locations & chairs', sub: 'Addresses, map pins, rooms and chairs', icon: MapPin, need: 'edit' },
  { key: 'schedules', label: 'Schedules & days off', sub: 'Each doctor’s week, slots or queue', icon: CalendarClock, need: 'edit' },
  { key: 'booking', label: 'Booking rules', sub: 'How far ahead, notice, holds, follow-ups', icon: Clock3, need: 'edit' },
  { key: 'messages', label: 'Reminders & messages', sub: 'When reminders go out and what they say', icon: MessageSquareText, need: 'edit' },
  { key: 'whatsapp', label: 'WhatsApp', sub: 'The number patients write to', icon: Smartphone, need: 'owner' },
  { key: 'team', label: 'Team', sub: 'Who can sign in, and what they see', icon: UsersRound, need: 'owner' },
  { key: 'brand', label: 'Brand', sub: 'Logo and colour', icon: Palette, need: 'edit' }
] as const;
export type SettingsKey = typeof SETTINGS_SECTIONS[number]['key'];
