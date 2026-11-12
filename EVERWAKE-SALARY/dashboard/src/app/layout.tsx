import type { Metadata } from 'next';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import { getT } from '@/lib/auth';
import './globals.css';

// One face for Arabic and English, with tabular figures (self-hosted by Next at build time)
const plex = IBM_Plex_Sans_Arabic({ subsets: ['arabic', 'latin'], weight: ['400', '500', '600'], variable: '--font-plex', display: 'swap' });

export const metadata: Metadata = { title: 'Salary assistant · HR', robots: { index: false, follow: false } };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { lang, dir } = await getT();
  return (
    <html lang={lang} dir={dir} className={plex.variable}>
      <body>{children}</body>
    </html>
  );
}
