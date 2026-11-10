import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8790);
export default defineConfig({
  testDir: './e2e',
  testIgnore: /katex-compare/,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  forbidOnly: !!process.env.CI,
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium', acceptDownloads: true, navigationTimeout: 60_000 },
  webServer: {
    command: 'node e2e/doorway-double.mjs',
    url: `http://127.0.0.1:${port}/manifold-companion/api-wait`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
