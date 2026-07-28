import { defineConfig } from 'vitest/config';

// @des DES-F001-015 @fun FUN-F001-030
export const PAGES_BASE = '/bungo-zundamon/' as const;
const outputRoot = process.env.PLAYWRIGHT_DIST_ROOT ?? 'dist';

export default defineConfig({
  base: PAGES_BASE,
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});
