import { defineConfig, devices } from '@playwright/test';
import { E2E_HOST_SECRET, loadDotEnvLocal } from './e2e/env';

loadDotEnvLocal();

// W15: the default suite runs on the simulator and must not depend on apps/web/.env.local. A
// testnet .env.local sets HOST_SECRET (and a chain), which made host.spec fail against a mock
// server. Pin both explicitly for the dev server AND the specs (workers load this file too).
// The anvil suites (BLOCKBEAT_E2E_ANVIL=1) keep .env.local as it is.
if (process.env.BLOCKBEAT_E2E_ANVIL?.trim() !== '1') {
  process.env.NEXT_PUBLIC_BLOCKBEAT_MOCK = '1';
  process.env.HOST_SECRET = E2E_HOST_SECRET;
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
    // The default suite runs the in-memory simulator (review C1: a zero address on testnet refuses to boot).
    env: { ...process.env, NEXT_PUBLIC_BLOCKBEAT_MOCK: process.env.NEXT_PUBLIC_BLOCKBEAT_MOCK ?? '1', HOST_SECRET: process.env.HOST_SECRET ?? E2E_HOST_SECRET },
  },
  projects: [
    { name: 'stage', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
    { name: 'phone', use: { ...devices['iPhone 14'] } },
  ],
});
