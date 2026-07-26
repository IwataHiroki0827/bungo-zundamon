import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson } from '../src/content/artifacts.ts';
import { loadAndVerifyF001Baseline, verifyF001Invariant } from '../src/content/baseline.ts';
import {
  buildIntegratedPublicTree,
  promoteIntegratedTree,
  type F001BaselineBundle,
} from '../src/content/batch-public.ts';
import {
  hashBatchManifest,
  loadAcceptedBatches,
  validateBatchManifest,
  type Sha256,
} from '../src/content/batch.ts';
import {
  loadAcceptedF003CatalogFragment,
  loadPublishedF002CatalogFragment,
} from '../src/content/f003-catalog.ts';
import {
  F002_PUBLISHED_RELEASE,
  loadAndVerifyPublishedBaseline,
  verifyPublishedInvariant,
} from '../src/content/published-baseline.ts';
import { validateCatalogV2 } from '../src/ui/catalog-loader.ts';

const execFile = promisify(execFileCallback);
const BATCH_ID = 'F003';

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function writeCanonicalAtomic(path: string, value: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function treeSha256(root: string): Promise<Sha256> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (current: string, logical: string): Promise<void> => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('public treeにlink/reparseがあります');
    if (info.isFile()) {
      files.push({ path: logical, bytes: await readFile(current) });
      return;
    }
    if (!info.isDirectory()) throw new Error('public treeにはregular fileだけを許可します');
    for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right, 'en'))) {
      await walk(join(current, name), logical ? `${logical}/${name}` : name);
    }
  };
  await walk(root, '');
  const digest = createHash('sha256');
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    digest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  }
  return digest.digest('hex') as Sha256;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((value) => value !== '--promote') || args.filter((value) => value === '--promote').length > 1) {
    throw new Error('usage: f003-final-integration.ts [--promote]');
  }
  const promote = args.includes('--promote');
  const workspace = resolve(process.cwd());
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
    execFile('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' }),
  ]);
  const sourceCommit = head.trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || status.trim() !== '') {
    throw new Error('F003最終統合にはexact clean source commitが必要です');
  }
  const checked = validateBatchManifest(await readJson<unknown>(
    join(workspace, 'content', 'batches', BATCH_ID, 'batch.json'),
  ));
  if (!checked.ok || checked.value.status !== 'accepted' ||
    checked.value.workProgress.some((work) => work.status !== 'accepted')) {
    throw new Error('F003全3作品がacceptedではありません');
  }
  const manifest = checked.value;
  const preparation = {
    releaseCandidateBatchId: manifest.batchId,
    feature: manifest.feature,
    sourceCommit,
  } as const;
  const expectedCurrentPublicSha256 = await treeSha256(join(workspace, 'public'));
  const [f001, published, f002, f003, batches] = await Promise.all([
    loadAndVerifyF001Baseline(
      join(workspace, 'public'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    ),
    loadAndVerifyPublishedBaseline(workspace, F002_PUBLISHED_RELEASE),
    loadAndVerifyPublishedBaseline(workspace, F002_PUBLISHED_RELEASE).then((baseline) =>
      loadPublishedF002CatalogFragment(workspace, baseline.catalog)),
    loadAcceptedF003CatalogFragment(workspace),
    loadAcceptedBatches(workspace, { preparation }),
  ]);
  const publishedF002Batch = published.catalog.batches.find((batch) => batch.batchId === 'F002');
  if (!publishedF002Batch) throw new Error('固定v0.2.0 CatalogにF002 batchがありません');

  const staging = await mkdtemp(join(workspace, '.cache', 'f003-final-integration-'));
  let promoted = false;
  try {
    const baselineBundle: F001BaselineBundle = {
      baselineSha256: f001.baselineSha256,
      catalog: f001.catalog,
      files: f001.files,
      sourceRoot: f001.sourceRoot,
      syntheticBatch: f001.syntheticBatch,
    };
    const build = await buildIntegratedPublicTree(
      batches,
      baselineBundle,
      staging,
      {
        mode: 'prepare-release',
        workspaceRoot: workspace,
        batchCatalogs: { F002: f002, F003: f003 },
        publishedCatalogBatches: { F002: publishedF002Batch },
      },
      undefined,
      preparation,
    );
    const catalogBytes = await readFile(join(staging, 'content', 'catalog.json'));
    const catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes));
    const validation = validateCatalogV2(catalog, catalogBytes.byteLength);
    if (!validation.ok) throw new Error(`F003最終Catalogが不正です: ${validation.error.code}`);
    const { authors, works, audioAssets } = f001.catalog;
    if (!authors || !works || !audioAssets) throw new Error('固定F001 Catalog projectionが不完全です');
    const [f001Invariant, publishedInvariant] = await Promise.all([
      verifyF001Invariant(validation.value, staging, {
        baselineSha256: f001.baselineSha256,
        files: f001.files,
        catalog: { authors, works, audioAssets },
      }),
      verifyPublishedInvariant(published, {
        target: 'integrated-tree',
        root: staging,
        treeSha256: build.buildSha256,
      }),
    ]);
    if (f001Invariant.result !== 'pass' || publishedInvariant.result !== 'pass') {
      throw new Error(`F003最終統合の既存公開不変違反: ${publishedInvariant.mismatches.join(',')}`);
    }
    const f003Works = validation.value.works.filter((work) => work.batchId === 'F003');
    const reportCore = {
      schemaVersion: '1.0.0',
      batchId: manifest.batchId,
      sourceCommit,
      manifestSha256: hashBatchManifest(manifest),
      contentBuildSha256: build.buildSha256,
      catalogSha256: sha256(catalogBytes),
      fileCount: build.files.length,
      authorCount: validation.value.authors.length,
      workCount: validation.value.works.length,
      dialogueCount: validation.value.works.reduce((sum, work) => sum + work.dialogues.length, 0),
      audioCount: validation.value.audioAssets.length,
      f003WorkIds: f003Works.map((work) => work.workId),
      unfinishedWorkIds: f003Works
        .filter((work) => work.completionStatus === 'unfinished')
        .map((work) => work.workId),
      f001Invariant,
      publishedInvariant,
      result: 'pass',
    } as const;
    const report = { ...reportCore, reportSha256: sha256(canonicalJson(reportCore)) };
    await writeCanonicalAtomic(
      join(workspace, '.cache', 'batch-release', BATCH_ID, 'final-integration.json'),
      report,
    );
    if (promote) {
      await promoteIntegratedTree(
        workspace,
        staging,
        build.buildSha256,
        expectedCurrentPublicSha256,
        f001Invariant,
        preparation,
      );
      promoted = true;
    }
    process.stdout.write(`${canonicalJson(report)}\n`);
  } finally {
    const safePrefix = `${join(workspace, '.cache', 'f003-final-integration-')}`;
    if (!promoted && staging.startsWith(safePrefix)) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

await main();
