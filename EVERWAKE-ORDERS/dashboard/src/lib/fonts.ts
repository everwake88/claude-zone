import { Cairo } from 'next/font/google';

// the menu pictures' typeface: Arabic and Latin, bold enough for a phone screen
export const cairo = Cairo({ subsets: ['arabic', 'latin'], weight: ['400', '600', '700', '800'], display: 'swap' });
