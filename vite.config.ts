import { defineConfig } from 'vitest/config';

// @des DES-F001-015 @fun FUN-F001-030
export const PAGES_BASE = '/bungo-zundamon/' as const;

export default defineConfig({
  base: PAGES_BASE,
  build: {
    outDir: 'dist',
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
