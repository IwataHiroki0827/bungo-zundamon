import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import type { IntegratedBuild, IntegratedFile } from './batch-public.ts';
import type { Sha256, WorkspaceRelativePath } from './batch.ts';
import { buildPagesPreview, type PagesBuildAdapter } from './pages-preview.ts';

const execFile = promisify(execFileCallback);
const sha = (value: Uint8Array | string): Sha256 => createHash('sha256').update(value).digest('hex') as Sha256;

async function scan(root: string): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (dir: string, logical: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = logical ? `${logical}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else files.push({ path, bytes: new Uint8Array(await readFile(join(dir, entry.name))) });
    }
  };
  await walk(root, '');
  return files;
}

function treeHash(files: readonly { path: string; bytes: Uint8Array }[]): Sha256 {
  const digest = createHash('sha256');
  for (const file of files) digest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  return digest.digest('hex') as Sha256;
}

async function fixture(): Promise<{ app: string; content: string; output: string; tree: IntegratedBuild; adapter: PagesBuildAdapter }> {
  const parent = await mkdtemp(join(tmpdir(), 'pages-preview-'));
  const app = join(parent, 'app');
  const content = join(parent, 'content-tree');
  const output = join(parent, 'random-output');
  await Promise.all([mkdir(join(app, 'src'), { recursive: true }), mkdir(join(app, 'public'), { recursive: true }), mkdir(join(app, 'dist'), { recursive: true }), mkdir(output), mkdir(join(content, 'content'), { recursive: true }), mkdir(join(content, 'audio', 'F001'), { recursive: true }), mkdir(join(content, 'artwork'), { recursive: true })]);
  await writeFile(join(app, 'index.html'), '<div id="app"></div><script type="module" src="/src/main.ts"></script>');
  await writeFile(join(app, 'src', 'main.ts'), "import './style.css'; document.querySelector('#app')!.textContent='ok';");
  await writeFile(join(app, 'src', 'style.css'), 'body{color:black}');
  await writeFile(join(app, 'package.json'), '{"type":"module"}');
  await writeFile(join(app, 'package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(join(app, 'public', 'ignored.txt'), 'old-public');
  await writeFile(join(app, 'dist', 'ignored.txt'), 'old-dist');
  await writeFile(join(content, '.nojekyll'), '');
  await writeFile(join(content, 'content', 'catalog.json'), '{"schemaVersion":"2.0.0"}');
  await writeFile(join(content, 'content', 'licenses.json'), 'licenses');
  await writeFile(join(content, 'audio', 'F001', 'a.wav'), 'wav');
  await writeFile(join(content, 'artwork', 'a.png'), 'png');
  await execFile('git', ['init'], { cwd: app });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: app });
  await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: app });
  await execFile('git', ['add', 'index.html', 'src', 'package.json', 'package-lock.json'], { cwd: app });
  await execFile('git', ['commit', '-m', 'app'], { cwd: app });
  const scanned = await scan(content);
  const files: IntegratedFile[] = scanned.map((file) => ({ path: file.path as WorkspaceRelativePath, sha256: sha(file.bytes), bytes: file.bytes.byteLength }));
  const tree: IntegratedBuild = { mode: 'work-preview', stagingRoot: content, buildSha256: treeHash(scanned), files, activeBatchId: 'F002' as never, activeWorkId: '000473' };
  const adapter: PagesBuildAdapter = {
    toolFile: join(app, 'package-lock.json'),
    async build(_app, publicRoot, out) {
      await cp(publicRoot, out, { recursive: true });
      await mkdir(join(out, 'assets'), { recursive: true });
      await writeFile(join(out, 'index.html'), '<html></html>');
      await writeFile(join(out, 'assets', 'app.js'), 'js');
      await writeFile(join(out, 'assets', 'app.css'), 'css');
    },
  };
  return { app, content, output, tree, adapter };
}

describe('FUN-F002-039 offline Pages preview', () => {
  it('明示入力だけから完全distと全file/input hashを返す', async () => {
    const value = await fixture();
    const runtimeOutput = join(value.app, '.cache', 'runtime-pages');
    await mkdir(runtimeOutput, { recursive: true });
    const result = await buildPagesPreview(value.tree, value.app, runtimeOutput, true, { adapter: value.adapter });
    expect(result).toMatchObject({ contentBuildSha256: value.tree.buildSha256, batchId: 'F002', workId: '000473' });
    expect(result.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'index.html', '.nojekyll', 'assets/app.js', 'assets/app.css', 'content/catalog.json', 'content/licenses.json', 'audio/F001/a.wav', 'artwork/a.png',
    ]));
    expect(result.inputHashes).toMatchObject({ contentTreeSha256: value.tree.buildSha256 });
    expect(result.distSha256).toBe(treeHash(await scan(runtimeOutput)));
  });

  it('offline違反・stale入力・build失敗はoutputを破棄する', async () => {
    const offline = await fixture();
    await expect(buildPagesPreview(offline.tree, offline.app, offline.output, false as true, { adapter: offline.adapter }))
      .rejects.toMatchObject({ code: 'PAGES_PREVIEW_NETWORK_ATTEMPTED' });

    const stale = await fixture();
    await writeFile(join(stale.content, 'audio', 'F001', 'a.wav'), 'changed');
    await expect(buildPagesPreview(stale.tree, stale.app, stale.output, true, { adapter: stale.adapter }))
      .rejects.toMatchObject({ code: 'PAGES_PREVIEW_INPUT_STALE' });
    await expect(readdir(stale.output)).rejects.toThrow();

    const failed = await fixture();
    const adapter = { ...failed.adapter, async build() { throw new Error('network secret'); } };
    await expect(buildPagesPreview(failed.tree, failed.app, failed.output, true, { adapter }))
      .rejects.toMatchObject({ code: 'PAGES_PREVIEW_BUILD_FAILED' });
    await expect(readdir(failed.output)).rejects.toThrow();
  });
});
