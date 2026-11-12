import type { NextConfig } from 'next';

const config: NextConfig = {
  // the payroll sheet is uploaded through a server action; Vercel accepts request bodies up to 4.5 MB
  experimental: { serverActions: { bodySizeLimit: '4mb' } },
  serverExternalPackages: ['pg', 'exceljs'],
  poweredByHeader: false
};
export default config;
