import { BookOpenText, Bot, ClipboardList, CreditCard, FileBarChart, MessagesSquare, Palette, Smartphone, UsersRound } from 'lucide-react';

// Every settings area: its tab name, and in one plain line what it changes.
export const SETTINGS_SECTIONS = [
  { key: 'agent', label: 'The agent', icon: Bot,
    about: 'Its name, how it talks, and the facts about your restaurant it may tell customers.' },
  { key: 'knowledge', label: 'Answers to questions', icon: BookOpenText,
    about: 'Your answers to questions that are not about the menu: parking, parties, allergies, Wi-Fi…' },
  { key: 'ordering', label: 'Ordering rules', icon: ClipboardList,
    about: 'Payment methods, what the agent asks before placing an order, ordering outside opening hours, test numbers and new-order tickets.' },
  { key: 'payments', label: 'Online payments', icon: CreditCard,
    about: 'Connect Paymob so customers can pay by card or mobile wallet through a link.' },
  { key: 'messages', label: 'Automatic messages', icon: MessagesSquare,
    about: 'The WhatsApp messages sent when an order moves on the board, and while the agent is switched off.' },
  { key: 'whatsapp', label: 'WhatsApp number', icon: Smartphone,
    about: 'The number customers message, and whether it is connected.' },
  { key: 'brand', label: 'Logo and colour', icon: Palette,
    about: 'Your logo and colour on the dashboard and on the menu pictures.' },
  { key: 'report', label: 'Daily report', icon: FileBarChart,
    about: 'A summary of the day, sent to the owner’s WhatsApp.' },
  { key: 'team', label: 'Team', icon: UsersRound,
    about: 'Who can use the dashboard, and what each person can do.' }
] as const;
