import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui';
import { LangProvider } from '@/lib/i18n';
import { serverLang } from '@/lib/i18n-server';
import { UI_THEME_SCRIPT } from '@/lib/ui-theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Everwake Orders',
  description: 'WhatsApp ordering for restaurant chains — live orders, the inbox, the menu and the agent, in one place.',
  icons: { icon: '/icon.svg' }
};
export const viewport: Viewport = { themeColor: '#0B222E', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await serverLang();
  return (
    <html lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: UI_THEME_SCRIPT }} /></head>
      <body>
        <LangProvider initial={lang}>
          <ToastProvider>{children}</ToastProvider>
        </LangProvider>
      </body>
    </html>
  );
}
