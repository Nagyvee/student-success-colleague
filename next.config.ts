import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This app lives inside another repo's folder; trace files from here, not from the parent lockfile.
  outputFileTracingRoot: process.cwd(),
  // The office engine keeps its world in one Node process (SSE fan-out and the
  // in-memory store), so the server bundle must not be split across workers.
  serverExternalPackages: ['@anthropic-ai/sdk', 'imapflow', 'mailparser'],
  // The office is presented from `npm run dev` on stage; the dev badge would sit on the story band.
  devIndicators: false,
  // A check build can go to its own folder (CZ_DIST=.next-check) without disturbing a running dev server.
  distDir: process.env.CZ_DIST || '.next',
};

export default nextConfig;
