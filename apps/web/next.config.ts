import type { NextConfig } from 'next';
import { buildSecurityHeaders } from './lib/security/headers';

const nextConfig: NextConfig = {
  // The dev badge overlapped the join page's tip button in evidence screenshots.
  devIndicators: false,
  // Phones reach `next dev` through a Cloudflare quick tunnel; without this Next blocks the
  // cross-origin dev resources (chunks, HMR) and the join page never hydrates ("Funding your
  // wallet" forever). Production `next start` has no such restriction.
  allowedDevOrigins: ['*.trycloudflare.com', 'localhost', '127.0.0.1'],
  // Review M7: baseline CSP and security headers on every route.
  async headers() {
    return [{ source: '/(.*)', headers: buildSecurityHeaders(process.env, { dev: process.env.NODE_ENV !== 'production' }) }];
  },
};

export default nextConfig;
