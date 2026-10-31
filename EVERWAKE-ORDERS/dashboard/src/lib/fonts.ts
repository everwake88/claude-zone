import { Cairo, Lalezar, Readex_Pro } from 'next/font/google';

// the menu pictures' typeface: Arabic and Latin, bold enough for a phone screen
export const cairo = Cairo({ subsets: ['arabic', 'latin'], weight: ['400', '600', '700', '800'], display: 'swap' });

// the customer's QR menu and the kitchen: Lalezar is the lettering of Egyptian
// shop signs and menu boards (names, prices, order numbers); Readex Pro reads
// easily in both Arabic and English at phone sizes
export const lalezar = Lalezar({ subsets: ['arabic', 'latin'], weight: '400', display: 'swap', variable: '--font-board' });
export const readex = Readex_Pro({ subsets: ['arabic', 'latin'], display: 'swap', variable: '--font-qr' });
