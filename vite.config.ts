import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/bungo-zundamon/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
  },
});
