import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui';
import './globals.css';

export const metadata: Metadata = {
  title: 'Everwake Orders',
  description: 'WhatsApp ordering for restaurant chains — live orders, the inbox, the menu and the agent, in one place.',
  icons: { icon: '/icon.svg' }
};
export const viewport: Viewport = { themeColor: '#0B222E', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
