import type { NextConfig } from 'next';

const config: NextConfig = {
  // one self-contained server for Docker / a VPS (not needed on Vercel)
  output: process.env.VERCEL ? undefined : 'standalone',
  eslint: { ignoreDuringBuilds: true },
  devIndicators: false,
  experimental: {
    serverActions: { bodySizeLimit: '8mb' },
    // going back to a page seen in the last 30 seconds opens it at once: the pages fetch their own
    // data when they open, so the part kept here (the page's frame) never goes out of date
    staleTimes: { dynamic: 30, static: 180 }
  }
};

export default config;
