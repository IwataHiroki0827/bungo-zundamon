import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { serviceWorkerPlugin } from './scripts/service-worker-build.mjs';

// @des DES-F001-015 @fun FUN-F001-030
export const PAGES_BASE = '/bungo-zundamon/' as const;
const outputRoot = process.env.PLAYWRIGHT_DIST_ROOT ?? 'dist';

// F005 native guard(ETW等のマシングローバル資源)を使うテストと巨大fixtureコピーを伴う
// テストは並列spawnで競合しフレークするため、fileParallelism無効のserialレーンへ隔離する。
const SERIAL_TESTS = [
  'src/content/f005-*.test.ts',
  'src/content/offline-build.integration.test.ts',
  'src/content/batch-runtime.test.ts',
  'src/content/baseline.test.ts',
] as const;

export default defineConfig({
  base: PAGES_BASE,
  // @des DES-F012-006 @fun FUN-F012-014 production buildだけでdist/sw.js・dist/manifest.jsonを出力する。
  plugins: [serviceWorkerPlugin({ projectRoot: fileURLToPath(new URL('.', import.meta.url)) })],
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  test: {
    projects: [
      {
        test: {
          name: 'serial',
          environment: 'jsdom',
          include: [...SERIAL_TESTS],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'parallel',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
          exclude: [...configDefaults.exclude, ...SERIAL_TESTS],
        },
      },
    ],
  },
});
