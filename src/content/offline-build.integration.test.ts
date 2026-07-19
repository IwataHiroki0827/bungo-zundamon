import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryDirectories: string[] = [];

async function copyProductionFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-it-offline-build-'));
  temporaryDirectories.push(root);
  await Promise.all([
    cp(join(projectRoot, 'src'), join(root, 'src'), { recursive: true }),
    cp(join(projectRoot, 'public'), join(root, 'public'), { recursive: true }),
    cp(join(projectRoot, 'index.html'), join(root, 'index.html')),
  ]);
  await writeFile(join(root, 'vite.config.mjs'), `
export default {
  base: '/bungo-zundamon/',
  build: {
    outDir: process.env.BUNGO_IT_OUTDIR,
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
};
`, 'utf8');
  return root;
}

function runOfflineProductionBuild(root: string, outDir: string): void {
  const preload = pathToFileURL(join(projectRoot, 'scripts/network-deny.mjs')).href;
  const inherited = process.env.NODE_OPTIONS?.trim();
  const result = spawnSync(process.execPath, [
    join(projectRoot, 'node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    join(root, 'vite.config.mjs'),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      BUNGO_IT_OUTDIR: outDir,
      NODE_OPTIONS: [inherited, `--import=${preload}`].filter(Boolean).join(' '),
      SOURCE_DATE_EPOCH: '1784332800',
      npm_config_offline: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
  expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toMatchObject({
    status: 0,
    signal: null,
    stderr: '',
  });
}

async function fileHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const logical = relative(root, path).replaceAll('\\', '/');
        hashes.set(logical, createHash('sha256').update(await readFile(path)).digest('hex'));
      }
    }
  };
  await walk(root);
  return hashes;
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('オフライン通常buildの再現性 [IT-F001-006]', () => {
  /** @des DES-F001-002 DES-F001-006 DES-F001-008 DES-F001-017 @test IT-F001-006 */
  it('production入力を通信禁止で2回buildすると全file hashが一致し、単一public入力変更は対応fileだけへ局在する', async () => {
    const root = await copyProductionFixture();

    runOfflineProductionBuild(root, 'dist-a');
    runOfflineProductionBuild(root, 'dist-b');
    const first = await fileHashes(join(root, 'dist-a'));
    const second = await fileHashes(join(root, 'dist-b'));
    expect(first.size).toBeGreaterThan(30);
    expect([...second.entries()]).toEqual([...first.entries()]);

    const licensePath = join(root, 'public/content/licenses.json');
    const license = JSON.parse(await readFile(licensePath, 'utf8')) as Record<string, unknown>;
    await writeFile(licensePath, `${JSON.stringify({ ...license, itFixtureMarker: 'localized-change' }, null, 2)}\n`, 'utf8');
    runOfflineProductionBuild(root, 'dist-local-change');
    const changed = await fileHashes(join(root, 'dist-local-change'));

    const allPaths = new Set([...first.keys(), ...changed.keys()]);
    const changedPaths = [...allPaths].filter((path) => first.get(path) !== changed.get(path));
    expect(changedPaths).toEqual(['content/licenses.json']);
  }, 60_000);
});
