import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: 'http://localhost:4321' },
  webServer: {
    command: 'npm run dev -- --port 4321',
    // The account e2e signs in through a mock customers capability; see src/lib/mock-customers.ts.
    env: { SKUIO_MOCK_CUSTOMERS: '1' },
    url: 'http://localhost:4321',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
