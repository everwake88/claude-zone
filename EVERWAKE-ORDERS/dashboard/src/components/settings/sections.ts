import { BookOpenText, Bot, ClipboardList, CreditCard, FileBarChart, MessagesSquare, Palette, PlugZap, QrCode, Smartphone, UsersRound } from 'lucide-react';

// Every settings area: its name, its group in the settings list, and in one plain line what it changes.
export const SETTINGS_SECTIONS = [
  { key: 'agent', group: 'The agent', label: 'The agent', icon: Bot,
    about: 'Its name, how it talks, and the facts about your restaurant it may tell customers.' },
  { key: 'knowledge', group: 'The agent', label: 'Answers to questions', icon: BookOpenText,
    about: 'Your answers to questions that are not about the menu: parking, parties, allergies, Wi-Fi…' },
  { key: 'ordering', group: 'Orders and payment', label: 'Ordering rules', icon: ClipboardList,
    about: 'Payment methods, what the agent asks before placing an order, ordering outside opening hours, test numbers and new-order tickets.' },
  { key: 'payments', group: 'Orders and payment', label: 'Online payments', icon: CreditCard,
    about: 'Connect Paymob so customers can pay by card or mobile wallet through a link.' },
  { key: 'qr', group: 'Orders and payment', label: 'QR ordering in the branch', icon: QrCode,
    about: 'A QR code for the counter and each table: customers see the menu, order and pay from their phone, and the kitchen gets it.' },
  { key: 'integrations', group: 'Connections', label: 'Your POS and systems', icon: PlugZap,
    about: 'Send every order to your POS, ERP or CRM (Odoo, Foodics…), and let it update stock and order status here.' },
  { key: 'messages', group: 'Orders and payment', label: 'Automatic messages', icon: MessagesSquare,
    about: 'The WhatsApp messages sent when an order moves on the board, and while the agent is switched off.' },
  { key: 'whatsapp', group: 'Connections', label: 'WhatsApp number', icon: Smartphone,
    about: 'The number customers message, and whether it is connected.' },
  { key: 'brand', group: 'Your restaurant', label: 'Logo and colour', icon: Palette,
    about: 'Your logo and colour on the dashboard and on the menu pictures.' },
  { key: 'report', group: 'Your restaurant', label: 'Daily report', icon: FileBarChart,
    about: 'A summary of the day, sent to the owner’s WhatsApp.' },
  { key: 'team', group: 'Your restaurant', label: 'Team', icon: UsersRound,
    about: 'Who can use the dashboard, and what each person can do.' }
] as const;
