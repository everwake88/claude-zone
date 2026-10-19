import type { NextConfig } from 'next';

const config: NextConfig = {
  // one self-contained server for Docker / a VPS; Vercel ignores it
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  experimental: { serverActions: { bodySizeLimit: '8mb' } }
};

export default config;
