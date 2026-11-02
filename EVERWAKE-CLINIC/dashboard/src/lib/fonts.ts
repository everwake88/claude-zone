import { Readex_Pro } from 'next/font/google';

// one family for the whole dashboard: Readex Pro reads well in Arabic and English at small sizes
export const readex = Readex_Pro({ subsets: ['arabic', 'latin'], display: 'swap', variable: '--font-readex' });
