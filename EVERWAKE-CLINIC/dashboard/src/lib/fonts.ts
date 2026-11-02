import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';

// Everwake's type: Inter for Latin (the brand's open stand-in for San Francisco) and
// IBM Plex Sans Arabic for Arabic, one voice for everything.
export const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });
export const plexArabic = IBM_Plex_Sans_Arabic({ subsets: ['arabic'], weight: ['400', '500', '600', '700'], display: 'swap', variable: '--font-plex-ar' });
export const fontVars = `${inter.variable} ${plexArabic.variable}`;
