import type { Metadata } from 'next';
import { Alexandria } from 'next/font/google';
import { getT } from '@/lib/auth';
import './globals.css';

// Alexandria: one geometric face for Arabic and English, drawn by an Egyptian designer,
// with tabular figures (self-hosted by Next at build time)
const alex = Alexandria({ subsets: ['arabic', 'latin'], variable: '--font-alex', display: 'swap' });

export const metadata: Metadata = { title: 'Salary assistant · HR', robots: { index: false, follow: false } };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { lang, dir } = await getT();
  return (
    <html lang={lang} dir={dir} className={alex.variable}>
      <body>{children}</body>
    </html>
  );
}
