/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const base = env.VITE_BASE_PATH || '/';

  return {
    base,
    plugins: [
      react(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['icons/favicon.svg', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'PocketLedger',
          short_name: 'PocketLedger',
          description: 'Private household expense tracker that works offline.',
          start_url: base,
          scope: base,
          display: 'standalone',
          orientation: 'any',
          background_color: '#f6f7f9',
          theme_color: '#1f6f5c',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // App shell only. Financial data lives in IndexedDB, never in the HTTP cache.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // The OCR engine (~4 MB of the 12 MB of variants, plus a 3 MB model) is cached on first use instead of at install.
          globIgnores: ['tesseract/**'],
          navigateFallback: `${base}index.html`,
          navigateFallbackDenylist: [/\/tesseract\//],
          runtimeCaching: [
            {
              // Public OCR engine files from this app's own origin — never user data.
              urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.includes('/tesseract/'),
              handler: 'CacheFirst',
              options: { cacheName: 'ocr-engine-v1', expiration: { maxEntries: 10 } },
            },
          ],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    build: { chunkSizeWarningLimit: 800 },
    test: {
      environment: 'jsdom',
      setupFiles: ['tests/setup.ts'],
      include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
      testTimeout: 30_000,
    },
  };
});
