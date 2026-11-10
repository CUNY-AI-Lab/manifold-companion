import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the Worker under the Doorway mount. Everything is bundled and served
// same-origin (CSP default-src 'self'): no CDN, no web fonts, no analytics.
export default defineConfig({
  base: '/manifold-companion/',
  plugins: [react()],
  build: { outDir: 'dist', assetsInlineLimit: 0, sourcemap: false },
  test: { include: ['test/**/*.test.js'], environment: 'node' },
});
