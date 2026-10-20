import type { NextConfig } from 'next';

const config: NextConfig = {
  // one self-contained server for Docker / a VPS (not needed on Vercel)
  output: process.env.VERCEL ? undefined : 'standalone',
  eslint: { ignoreDuringBuilds: true },
  experimental: { serverActions: { bodySizeLimit: '8mb' } }
};

export default config;
