import { defineConfig } from '@playwright/test';

// Screenshot comparison of on-screen maths: legacy KaTeX setup vs the new
// sandboxed preview. No app server: both pages are served by page.route.
//   npx playwright test -c playwright.compare.config.js
export default defineConfig({
  testDir: './e2e',
  testMatch: /katex-compare\.spec\.mjs/,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  use: { browserName: 'chromium', viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 },
});
