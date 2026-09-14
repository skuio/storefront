import { defineConfig } from '@playwright/test'

/**
 * The e2e run talks to a dev server backed by the local D1 database:
 * `npm run db:migrate:local && npm run seed` first (once). Secrets for the
 * run are passed in the environment, so no .dev.vars is required.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: 'http://localhost:4321' },
  webServer: {
    command: 'npm run dev -- --port 4321',
    env: {
      PAYMENT_PROVIDER: 'manual',
      MAIL_PROVIDER: 'console',
      STORE_API_KEY: 'e2e-store-api-key-e2e-store-api-key',
      SESSION_SECRET: 'e2e-session-secret',
      PUBLIC_SITE_URL: 'http://localhost:4321',
    },
    url: 'http://localhost:4321',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
