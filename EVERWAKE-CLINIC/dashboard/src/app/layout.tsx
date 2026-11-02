import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui';
import { fontVars } from '@/lib/fonts';
import { LangProvider } from '@/lib/i18n';
import { serverLang } from '@/lib/i18n-server';
import './globals.css';

export const metadata: Metadata = {
  title: 'Everwake Clinic',
  description: "The clinic's day in one place: appointments, patients and their records, and the WhatsApp assistant that books them.",
  icons: { icon: '/icon.svg' }
};
export const viewport: Viewport = { themeColor: '#0b222e', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await serverLang();
  return (
    <html lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} className={fontVars} suppressHydrationWarning>
      <body>
        <LangProvider initial={lang}>
          <ToastProvider>{children}</ToastProvider>
        </LangProvider>
      </body>
    </html>
  );
}
