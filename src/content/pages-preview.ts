import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { build as viteBuild } from 'vite';

import type { IntegratedBuild, IntegratedFile } from './batch-public.ts';
import type { BatchId, Sha256 } from './batch.ts';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

export interface PagesPreviewInputHashes {
  readonly contentTreeSha256: Sha256;
  readonly appSourceSha256: Sha256;
  readonly lockfileSha256: Sha256;
  readonly toolSha256: Sha256;
}

export interface PagesDistPreview {
  readonly distSha256: Sha256;
  readonly contentBuildSha256: Sha256;
  readonly outputRoot: string;
  readonly files: readonly IntegratedFile[];
  readonly inputHashes: PagesPreviewInputHashes;
  readonly batchId?: BatchId;
  readonly workId?: string;
}

export interface PagesBuildAdapter {
  readonly toolFile: string;
  build(appSource: string, publicRoot: string, outputRoot: string): Promise<void>;
}

export interface PagesPreviewOptions {
  readonly adapter?: PagesBuildAdapter;
}

export class PagesPreviewError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PagesPreviewError';
  }
}

function sha(bytes: Uint8Array | string): Sha256 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256;
}

function safeRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes(':') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

async function safeDirectory(path: string, code: string): Promise<string> {
  if (!isAbsolute(path)) throw new PagesPreviewError(code, 'directoryは絶対pathが必要です');
  const root = resolve(path);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe directory');
  } catch (error) {
    throw new PagesPreviewError(code, 'directory実体が不正です', { cause: error });
  }
  return root;
}

async function scanTree(root: string, code: string): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (directory: string, logical: string): Promise<void> => {
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink()) throw new PagesPreviewError(code, 'treeにreparseがあります');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const physical = join(directory, entry.name);
      const path = logical ? `${logical}/${entry.name}` : entry.name;
      if (!safeRelative(path)) throw new PagesPreviewError(code, `tree pathが不正です: ${path}`);
      if (entry.isDirectory()) await walk(physical, path);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push({ path, bytes: new Uint8Array(await readFile(physical)) });
      else throw new PagesPreviewError(code, `regular file以外があります: ${path}`);
    }
  };
  await walk(root, '');
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function treeSha(files: readonly { path: string; bytes: Uint8Array }[]): Sha256 {
  const digest = createHash('sha256');
  for (const file of files) digest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  return digest.digest('hex') as Sha256;
}

async function trackedAppHash(appSource: string): Promise<Sha256> {
  let stdout: string;
  try {
    ({ stdout } = await execFile('git', ['ls-files', '-z'], { cwd: appSource, encoding: 'utf8' }));
  } catch (error) {
    throw new PagesPreviewError('PAGES_PREVIEW_SOURCE_UNSAFE', 'app sourceをGit追跡確認できません', { cause: error });
  }
  const paths = stdout.split('\0').filter((path) => path !== '' && !path.startsWith('public/') && !path.startsWith('dist/') &&
    !path.startsWith('.cache/') && !path.startsWith('content/'));
  if (!paths.includes('index.html') || !paths.includes('package.json') || !paths.includes('package-lock.json') ||
    !paths.some((path) => path.startsWith('src/'))) {
    throw new PagesPreviewError('PAGES_PREVIEW_SOURCE_UNSAFE', '必須app source/lockfileがGit追跡されていません');
  }
  const digest = createHash('sha256');
  for (const path of paths.sort((a, b) => a.localeCompare(b, 'en'))) {
    if (!safeRelative(path)) throw new PagesPreviewError('PAGES_PREVIEW_SOURCE_UNSAFE', `追跡pathが不正です: ${path}`);
    const target = join(appSource, ...path.split('/'));
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new PagesPreviewError('PAGES_PREVIEW_REPARSE_POINT', `追跡source実体が不正です: ${path}`);
    const bytes = new Uint8Array(await readFile(target));
    digest.update(path).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes);
  }
  return digest.digest('hex') as Sha256;
}

const defaultAdapter: PagesBuildAdapter = {
  toolFile: require.resolve('vite/package.json'),
  async build(appSource, publicRoot, outputRoot) {
    await viteBuild({
      configFile: false,
      root: appSource,
      publicDir: publicRoot,
      base: '/bungo-zundamon/',
      logLevel: 'silent',
      plugins: [{
        name: 'deny-network-imports',
        enforce: 'pre',
        resolveId(source) {
          if (/^(?:https?:)?\/\//iu.test(source)) throw new PagesPreviewError('PAGES_PREVIEW_NETWORK_ATTEMPTED', 'network importを拒否しました');
          return null;
        },
      }],
      build: { outDir: outputRoot, emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0, sourcemap: false },
    });
  },
};

/** @des DES-F002-006 DES-F002-011 DES-F002-015 @fun FUN-F002-039 */
export async function buildPagesPreview(
  tree: IntegratedBuild,
  appSource: string,
  outputRoot: string,
  offline: true,
  options: PagesPreviewOptions = {},
): Promise<PagesDistPreview> {
  const adapter = options.adapter ?? defaultAdapter;
  let output: string | undefined;
  try {
    const [content, app] = await Promise.all([
      safeDirectory(tree.stagingRoot, 'PAGES_PREVIEW_SOURCE_UNSAFE'),
      safeDirectory(appSource, 'PAGES_PREVIEW_SOURCE_UNSAFE'),
    ]);
    output = await safeDirectory(outputRoot, 'PAGES_PREVIEW_SOURCE_UNSAFE');
    if (parse(output).root.toLowerCase() !== parse(content).root.toLowerCase() || (await readdir(output)).length !== 0) {
      throw new PagesPreviewError('PAGES_PREVIEW_SOURCE_UNSAFE', 'outputは同volumeの空random directoryが必要です');
    }
    const overlaps = (left: string, right: string): boolean => {
      const relation = relative(left, right);
      return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
    };
    const cacheRelation = relative(join(app, '.cache'), output);
    const isolatedRuntimeCache = cacheRelation !== '' && cacheRelation !== '..' &&
      !cacheRelation.startsWith(`..${sep}`) && !isAbsolute(cacheRelation);
    if ((overlaps(app, output) && !isolatedRuntimeCache) || overlaps(output, app) ||
      overlaps(content, output) || overlaps(output, content)) {
      throw new PagesPreviewError('PAGES_PREVIEW_SOURCE_UNSAFE', 'outputはapp/content treeから分離する必要があります');
    }
    if (offline !== true) throw new PagesPreviewError('PAGES_PREVIEW_NETWORK_ATTEMPTED', 'offline=trueが必須です');
    const contentFiles = await scanTree(content, 'PAGES_PREVIEW_REPARSE_POINT');
    if (treeSha(contentFiles) !== tree.buildSha256 || contentFiles.length !== tree.files.length ||
      contentFiles.some((file) => {
        const expected = tree.files.find((item) => item.path === file.path);
        return !expected || expected.bytes !== file.bytes.byteLength || expected.sha256 !== sha(file.bytes);
      })) throw new PagesPreviewError('PAGES_PREVIEW_INPUT_STALE', 'IntegratedBuildとcontent treeが一致しません');
    const lockfile = join(app, 'package-lock.json');
    const toolFile = resolve(adapter.toolFile);
    const toolInfo = await lstat(toolFile);
    if (!toolInfo.isFile() || toolInfo.isSymbolicLink()) throw new PagesPreviewError('PAGES_PREVIEW_SOURCE_UNSAFE', 'build tool実体が不正です');
    const [appHashBefore, lockBytes, toolBytes] = await Promise.all([
      trackedAppHash(app), readFile(lockfile), readFile(toolFile),
    ]);
    const inputs: PagesPreviewInputHashes = {
      contentTreeSha256: tree.buildSha256,
      appSourceSha256: appHashBefore,
      lockfileSha256: sha(lockBytes),
      toolSha256: sha(toolBytes),
    };
    const previousOffline = process.env.npm_config_offline;
    process.env.npm_config_offline = 'true';
    try { await adapter.build(app, content, output); } finally {
      if (previousOffline === undefined) delete process.env.npm_config_offline;
      else process.env.npm_config_offline = previousOffline;
    }
    if (await trackedAppHash(app) !== appHashBefore || treeSha(await scanTree(content, 'PAGES_PREVIEW_REPARSE_POINT')) !== tree.buildSha256) {
      throw new PagesPreviewError('PAGES_PREVIEW_INPUT_STALE', 'build中に入力hashが変化しました');
    }
    const outputFiles = await scanTree(output, 'PAGES_PREVIEW_REPARSE_POINT');
    const outputMap = new Map(outputFiles.map((file) => [file.path, file]));
    const requiredShell = ['index.html', '.nojekyll'];
    if (requiredShell.some((path) => !outputMap.has(path)) || !outputFiles.some((file) => file.path.endsWith('.js')) ||
      !outputFiles.some((file) => file.path.endsWith('.css')) || contentFiles.some((file) => {
        const built = outputMap.get(file.path);
        return !built || sha(built.bytes) !== sha(file.bytes) || built.bytes.byteLength !== file.bytes.byteLength;
      })) throw new PagesPreviewError('PAGES_PREVIEW_OUTPUT_INCOMPLETE', '完全distの必須fileまたはcontent assetが欠損・改変しています');
    const files = outputFiles.map((file) => Object.freeze({ path: file.path as IntegratedFile['path'], sha256: sha(file.bytes), bytes: file.bytes.byteLength }));
    return Object.freeze({
      distSha256: treeSha(outputFiles), contentBuildSha256: tree.buildSha256, outputRoot: output,
      files: Object.freeze(files), inputHashes: Object.freeze(inputs),
      ...(tree.activeBatchId ? { batchId: tree.activeBatchId } : tree.releaseCandidateBatchId ? { batchId: tree.releaseCandidateBatchId } : {}),
      ...(tree.activeWorkId ? { workId: tree.activeWorkId } : {}),
    });
  } catch (error) {
    if (output) await rm(output, { recursive: true, force: true });
    if (error instanceof PagesPreviewError) throw error;
    throw new PagesPreviewError('PAGES_PREVIEW_BUILD_FAILED', 'offline Pages preview buildに失敗しました', { cause: error });
  }
}
