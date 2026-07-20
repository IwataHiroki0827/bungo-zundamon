import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson, fingerprintArtifact, writeJsonArtifactAtomic } from './artifacts.ts';
import type {
  BatchId,
  BatchManifest,
  PublishableBatch,
  ReleaseBuildContext,
  ReleasePreparationContext,
  Sha256,
  WorkspaceRelativePath,
} from './batch.ts';
import type { CatalogV2 } from './processing.ts';
import { validateCatalogV2 } from '../ui/catalog-loader.ts';

const execFile = promisify(execFileCallback);

export type IntegratedBuildMode = 'work-preview' | 'prepare-release' | 'release-verify';

export interface IntegratedFile {
  readonly path: WorkspaceRelativePath;
  readonly sha256: Sha256;
  readonly bytes: number;
}

export interface F001BaselineBundle {
  readonly sourceRoot: string;
  readonly files: readonly IntegratedFile[];
  readonly catalog: Readonly<Partial<CatalogV2>>;
  readonly syntheticBatch: CatalogV2['batches'][number];
  readonly baselineSha256: Sha256;
}

export interface ActiveBatchPreview {
  readonly manifest: BatchManifest;
  readonly workId: string;
  readonly catalogFragment: BatchCatalogFragment;
  readonly catalogBatch: CatalogV2['batches'][number];
  readonly stagingRoot: string;
  readonly stagedFiles: readonly { readonly source: string; readonly publicPath: WorkspaceRelativePath; readonly sha256: Sha256; readonly bytes: number }[];
}

export interface IntegratedBuildOptions {
  readonly mode: IntegratedBuildMode;
  readonly workspaceRoot: string;
  readonly batchCatalogs?: Readonly<Record<string, BatchCatalogFragment>>;
  readonly trackedPublicRoot?: string;
}

export interface BatchCatalogFragment {
  readonly authors: CatalogV2['authors'];
  readonly works: CatalogV2['works'];
  readonly audioAssets: CatalogV2['audioAssets'];
  readonly candidateCounts: Omit<CatalogV2['candidateCounts'], 'byBatch'>;
  readonly publicFiles?: readonly {
    readonly source: WorkspaceRelativePath;
    readonly publicPath: WorkspaceRelativePath;
    readonly sha256: Sha256;
    readonly bytes: number;
  }[];
}

export interface IntegratedBuild {
  readonly mode: IntegratedBuildMode;
  readonly stagingRoot: string;
  readonly buildSha256: Sha256;
  readonly files: readonly IntegratedFile[];
  readonly releaseCandidateBatchId?: BatchId;
  readonly feature?: string;
  readonly sourceCommit?: string;
  readonly releaseCommit?: string;
  readonly buildMetadataPath?: string;
  readonly activeBatchId?: BatchId;
  readonly activeWorkId?: string;
}

export interface F001ContentInvariantReport {
  readonly result: 'pass' | 'blocked';
  readonly buildSha256: Sha256;
  readonly stagingSha256: Sha256;
  readonly baselineSha256: Sha256;
}

export class PublicIntegrationError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublicIntegrationError';
  }
}

export interface PublicPromotionOptions {
  readonly afterPhase?: (phase: 'prepared' | 'old-moved' | 'new-moved' | 'verified') => void | Promise<void>;
}

function hash(bytes: Uint8Array | string): Sha256 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256;
}

function safeRelativePath(value: string): value is WorkspaceRelativePath {
  return value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.includes(':') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function insidePath(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

async function verifiedRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new PublicIntegrationError('PUBLIC_WORKSPACE_BOUNDARY', 'rootは絶対pathが必要です');
  const lexical = resolve(root);
  const info = await lstat(lexical);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(lexical) !== lexical) {
    throw new PublicIntegrationError('PUBLIC_WORKSPACE_BOUNDARY', 'root実体が不正です');
  }
  return lexical;
}

async function assertDescendant(root: string, target: string): Promise<void> {
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new PublicIntegrationError('PUBLIC_WORKSPACE_BOUNDARY', 'pathがroot外です');
  }
  let cursor = root;
  for (const part of relation.split(sep)) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new PublicIntegrationError('PUBLIC_WORKSPACE_BOUNDARY', 'pathにlink/reparseがあります');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function treeFiles(root: string): Promise<Array<{ path: WorkspaceRelativePath; bytes: Uint8Array }>> {
  const files: Array<{ path: WorkspaceRelativePath; bytes: Uint8Array }> = [];
  const walk = async (current: string, logical: string): Promise<void> => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new PublicIntegrationError('PUBLIC_REPRODUCIBILITY_MISMATCH', 'treeにlink/reparseがあります');
    if (info.isFile()) {
      files.push({ path: logical as WorkspaceRelativePath, bytes: await readFile(current) });
      return;
    }
    if (!info.isDirectory()) throw new PublicIntegrationError('PUBLIC_REPRODUCIBILITY_MISMATCH', 'treeにはregular fileだけを許可します');
    for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right, 'en'))) {
      await walk(join(current, name), logical ? `${logical}/${name}` : name);
    }
  };
  await walk(root, '');
  return files;
}

function treeHash(files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): Sha256 {
  const digest = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    digest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  }
  return digest.digest('hex') as Sha256;
}

async function copyVerified(source: string, target: string, expectedSha: string, expectedBytes: number): Promise<void> {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedBytes || hash(await readFile(source)) !== expectedSha) {
    throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_HASH_MISMATCH', `copy sourceがmanifestと一致しません: ${source}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  if (hash(await readFile(target)) !== expectedSha) throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_HASH_MISMATCH', 'copy後SHAが一致しません');
}

async function assertCleanTrackedBuildInputs(
  workspace: string,
  expectedCommit: string,
  paths: readonly string[],
): Promise<void> {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
    execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: workspace, encoding: 'utf8' }),
  ]);
  if (head.trim() !== expectedCommit || status.trim() !== '') {
    throw new PublicIntegrationError('PUBLIC_CLEAN_CHECKOUT_REQUIRED', 'build input checkoutがexact clean commitではありません');
  }
  for (const path of [...new Set(paths)]) {
    if (!safeRelativePath(path)) throw new PublicIntegrationError('PUBLIC_CLEAN_CHECKOUT_REQUIRED', `追跡対象pathが不正です: ${path}`);
    try {
      await execFile('git', ['ls-files', '--error-unmatch', '--', path], { cwd: workspace, encoding: 'utf8' });
    } catch {
      throw new PublicIntegrationError('PUBLIC_CLEAN_CHECKOUT_REQUIRED', `build inputがGit追跡されていません: ${path}`);
    }
  }
}

function catalogFor(
  batches: readonly PublishableBatch[],
  f001: F001BaselineBundle,
  fragments: Readonly<Record<string, BatchCatalogFragment>>,
  active?: ActiveBatchPreview,
): CatalogV2 {
  const base = f001.catalog as Partial<CatalogV2>;
  if (!Array.isArray(base.authors) || !Array.isArray(base.works) || !Array.isArray(base.audioAssets) || !base.candidateCounts ||
    typeof base.candidateCounts !== 'object' || typeof base.creditsRef !== 'string') {
    throw new PublicIntegrationError('PUBLIC_BASELINE_FAILED', 'F001 bundleにCatalogV2項目がありません');
  }
  const existing = Array.isArray(base.batches) ? base.batches : [];
  const syntheticIds = existing.filter((item) => typeof item === 'object' && item !== null && (item as { batchId?: unknown }).batchId === 'F001');
  if (syntheticIds.length > 1) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', 'F001 synthetic batchが重複しています');
  if (syntheticIds.length === 1 && canonicalJson(syntheticIds[0]) !== canonicalJson(f001.syntheticBatch)) {
    throw new PublicIntegrationError('PUBLIC_BASELINE_FAILED', 'F001 synthetic batchがbaseline定義と一致しません');
  }
  const added = batches.map((batch) => {
    const fragment = fragments[batch.manifest.batchId];
    if (!fragment) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `batch catalog fragmentがありません: ${batch.manifest.batchId}`);
    return fragment;
  });
  if (active) added.push(active.catalogFragment);
  const f001Counts = base.candidateCounts;
  const byBatch = { ...(f001Counts.byBatch ?? { F001: {
    total: f001Counts.total, published: f001Counts.published,
    editorialExcluded: f001Counts.editorialExcluded, audioExcluded: f001Counts.audioExcluded,
    ...(f001Counts.editorialReasons ? { editorialReasons: f001Counts.editorialReasons } : {}),
    ...(f001Counts.audioFailureReasons ? { audioFailureReasons: f001Counts.audioFailureReasons } : {}),
  } }) };
  for (let index = 0; index < batches.length; index += 1) byBatch[batches[index]!.manifest.batchId] = added[index]!.candidateCounts;
  if (active) byBatch[active.manifest.batchId] = active.catalogFragment.candidateCounts;
  const summed = Object.values(byBatch).reduce((result, counts) => ({
    total: result.total + counts.total,
    published: result.published + counts.published,
    editorialExcluded: result.editorialExcluded + counts.editorialExcluded,
    audioExcluded: result.audioExcluded + counts.audioExcluded,
  }), { total: 0, published: 0, editorialExcluded: 0, audioExcluded: 0 });
  const mergedAuthors: CatalogV2['authors'] = [];
  for (const author of [...base.authors, ...added.flatMap((fragment) => fragment.authors)]) {
    const prior = mergedAuthors.find((item) => item.authorId === author.authorId);
    if (!prior) {
      mergedAuthors.push(author);
      continue;
    }
    if (prior.identitySha256 !== author.identitySha256 || prior.name !== author.name || prior.originalName !== author.originalName ||
      prior.slug !== author.slug || canonicalJson(prior.artwork) !== canonicalJson(author.artwork)) {
      throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', `author identityが矛盾しています: ${author.authorId}`);
    }
  }
  const catalogBatches: CatalogV2['batches'] = batches.map((batch) => ({
    batchId: batch.manifest.batchId,
    feature: batch.manifest.feature,
    status: batch.manifest.status === 'published' ? 'published' : 'accepted',
    authorId: batch.manifest.author.authorId,
    workIds: [...batch.manifest.workIds],
    acceptedAt: batch.manifest.acceptedAt as string,
    ...(batch.manifest.publishedAt ? { publishedAt: batch.manifest.publishedAt } : {}),
    evidenceSha256: batch.manifestSha256,
  }));
  if (active) catalogBatches.push(active.catalogBatch);
  const catalog: CatalogV2 = {
    schemaVersion: '2.0.0',
    authors: mergedAuthors,
    works: [...base.works, ...added.flatMap((fragment) => fragment.works)],
    audioAssets: [...base.audioAssets, ...added.flatMap((fragment) => fragment.audioAssets)],
    batches: [
      ...existing,
      ...(syntheticIds.length === 0 ? [f001.syntheticBatch] : []),
      ...catalogBatches,
    ],
    candidateCounts: { ...summed, byBatch },
    creditsRef: base.creditsRef,
  };
  const authorIds = new Set<string>();
  const workIds = new Set<string>();
  const audioIds = new Set<string>();
  for (const author of catalog.authors) {
    if (authorIds.has(author.authorId)) throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', `author IDが重複しています: ${author.authorId}`);
    authorIds.add(author.authorId);
  }
  for (const work of catalog.works) {
    if (workIds.has(work.workId)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `work IDが重複しています: ${work.workId}`);
    if (!safeRelativePath(work.source.provenancePath)) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `provenancePathが不正です: ${work.workId}`);
    workIds.add(work.workId);
  }
  for (const audio of catalog.audioAssets) {
    if (audioIds.has(audio.audioId)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `audio IDが重複しています: ${audio.audioId}`);
    audioIds.add(audio.audioId);
  }
  for (const batch of batches) {
    if (hash(canonicalJson(batch.manifest)) !== batch.manifestSha256) {
      throw new PublicIntegrationError('PUBLIC_BATCH_NOT_ACCEPTED', `batch manifest schema/hashが不正です: ${batch.manifest.batchId}`);
    }
    const author = catalog.authors.find((item) => item.authorId === batch.manifest.author.authorId);
    if (!author || author.identitySha256 !== batch.manifest.author.identitySha256 || author.name !== batch.manifest.author.name ||
      author.originalName !== batch.manifest.author.originalName || author.slug !== batch.manifest.author.slug) {
      throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', `manifestとcatalogのauthor identityが一致しません: ${batch.manifest.batchId}`);
    }
    const actualWorkIds = new Set(catalog.works.filter((work) => work.batchId === batch.manifest.batchId).map((work) => work.workId));
    if (actualWorkIds.size !== batch.manifest.workIds.length || batch.manifest.workIds.some((workId) => !actualWorkIds.has(workId))) {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `manifestとcatalogのwork集合が一致しません: ${batch.manifest.batchId}`);
    }
  }
  if (active) {
    const author = catalog.authors.find((item) => item.authorId === active.manifest.author.authorId);
    if (!author || author.identitySha256 !== active.manifest.author.identitySha256 || active.catalogBatch.batchId !== active.manifest.batchId ||
      active.catalogBatch.authorId !== active.manifest.author.authorId) {
      throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', 'active batchのcatalog tupleが一致しません');
    }
  }
  return catalog;
}

/** @des DES-F002-001 DES-F002-003 DES-F002-006 DES-F002-009 DES-F002-010 @fun FUN-F002-018 */
export async function buildIntegratedPublicTree(
  batches: readonly PublishableBatch[],
  f001: F001BaselineBundle,
  stagingRoot: string,
  options: IntegratedBuildOptions,
  active?: ActiveBatchPreview,
  preparation?: ReleasePreparationContext,
  release?: ReleaseBuildContext,
): Promise<IntegratedBuild> {
  const staging = await verifiedRoot(stagingRoot);
  const workspace = await verifiedRoot(options.workspaceRoot);
  await assertDescendant(workspace, staging);
  if ((await readdir(staging)).length !== 0) throw new PublicIntegrationError('PUBLIC_REPRODUCIBILITY_MISMATCH', 'stagingは空である必要があります');
  if (options.mode === 'work-preview' && (!active || preparation || release)) throw new PublicIntegrationError('PUBLIC_UNAPPROVED_BATCH_INCLUDED', 'work-preview contextが不正です');
  if (options.mode === 'prepare-release' && (!preparation || active || release)) throw new PublicIntegrationError('PUBLIC_RELEASE_CANDIDATE_MISSING', 'prepare contextが不正です');
  if (options.mode === 'release-verify' && (!release || active || preparation || !options.trackedPublicRoot)) {
    throw new PublicIntegrationError('PUBLIC_RELEASE_CANDIDATE_MISSING', 'release contextが不正です');
  }
  let activePriorSources: PublishableBatch['acceptedAudioSources'] = [];
  if (active) {
    const activeIndex = active.manifest.workIds.indexOf(active.workId as BatchManifest['workIds'][number]);
    if (activeIndex < 0 || active.manifest.workProgress[activeIndex]?.status !== 'voiced' ||
      active.manifest.workProgress.slice(0, activeIndex).some((work) => work.status !== 'accepted')) {
      throw new PublicIntegrationError('PUBLIC_BATCH_NOT_ACCEPTED', 'active workまたは先行accepted順序が不正です');
    }
    const expectedWorkIds = active.manifest.workIds.slice(0, activeIndex + 1);
    if (canonicalJson(active.catalogBatch.workIds) !== canonicalJson(expectedWorkIds) || active.catalogBatch.status !== 'accepted' ||
      active.catalogBatch.batchId !== active.manifest.batchId || active.catalogBatch.feature !== active.manifest.feature ||
      active.catalogBatch.authorId !== active.manifest.author.authorId) {
      throw new PublicIntegrationError('PUBLIC_RELEASE_CANDIDATE_MISMATCH', 'active catalogBatchがmanifest累積範囲と一致しません');
    }
    const fragmentWorkIds = active.catalogFragment.works.map((work) => work.workId);
    if (canonicalJson(fragmentWorkIds) !== canonicalJson(expectedWorkIds) ||
      active.catalogFragment.works.some((work) => work.batchId !== active.manifest.batchId || work.authorId !== active.manifest.author.authorId)) {
      throw new PublicIntegrationError('PUBLIC_CROSS_AUTHOR_REFERENCE', 'active fragmentに後続・欠落・作者混線があります');
    }
    activePriorSources = active.manifest.workProgress.slice(0, activeIndex)
      .flatMap((work) => work.acceptedAudioSources ?? []);
  }
  if (preparation || release) {
    const tracked = batches.flatMap((batch) => [
      batch.manifestPath,
      ...batch.acceptedAudioSources.map((source) => source.path),
      ...(options.batchCatalogs?.[batch.manifest.batchId]?.publicFiles ?? []).map((file) => file.source),
    ]);
    await assertCleanTrackedBuildInputs(workspace, preparation?.sourceCommit ?? release!.releaseCommit, tracked);
  }
  const f001Root = await verifiedRoot(f001.sourceRoot);
  const destinations = new Set<string>();
  for (const file of f001.files) {
    if (!safeRelativePath(file.path) || destinations.has(file.path)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `F001 path重複: ${file.path}`);
    destinations.add(file.path);
    await copyVerified(join(f001Root, ...file.path.split('/')), join(staging, ...file.path.split('/')), file.sha256, file.bytes);
  }
  const f001Required = new Set([
    ...(f001.catalog.authors ?? []).map((author) => author.artwork.path),
    ...(f001.catalog.works ?? []).map((work) => work.source.provenancePath),
    ...(f001.catalog.audioAssets ?? []).map((asset) => asset.path),
    ...(f001.catalog.creditsRef ? [f001.catalog.creditsRef] : []),
  ]);
  if ([...f001Required].some((path) => !destinations.has(path))) {
    throw new PublicIntegrationError('PUBLIC_BASELINE_FAILED', 'F001 catalog参照実体がbundle filesにありません');
  }
  const candidate = preparation?.releaseCandidateBatchId ?? release?.releaseCandidateBatchId;
  if (candidate && batches.filter((batch) => batch.manifest.batchId === candidate && batch.candidate).length !== 1) {
    throw new PublicIntegrationError('PUBLIC_RELEASE_CANDIDATE_MISMATCH', 'candidate tupleに一致するbatchが1件ではありません');
  }
  for (const batch of batches) {
    if (batch.manifest.status !== 'published' && !(batch.candidate && batch.manifest.batchId === candidate)) {
      throw new PublicIntegrationError('PUBLIC_UNAPPROVED_BATCH_INCLUDED', `公開不可batchです: ${batch.manifest.batchId}`);
    }
    const fragment = options.batchCatalogs?.[batch.manifest.batchId];
    if (!fragment) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `batch catalog fragmentがありません: ${batch.manifest.batchId}`);
    for (const file of fragment.publicFiles ?? []) {
      const allowedPaths = new Set([
        ...fragment.authors.map((author) => author.artwork.path),
        ...fragment.works.map((work) => work.source.provenancePath),
      ]);
      if (!safeRelativePath(file.source) || !safeRelativePath(file.publicPath) || destinations.has(file.publicPath)) {
        throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `batch public pathが不正または重複しています: ${file.publicPath}`);
      }
      if (!file.source.startsWith(`content/batches/${batch.manifest.batchId}/public-files/`)) {
        throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `public file sourceがcanonical公開source外です: ${file.source}`);
      }
      if (!allowedPaths.has(file.publicPath)) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `未参照public fileです: ${file.publicPath}`);
      destinations.add(file.publicPath);
      const source = join(workspace, ...file.source.split('/'));
      await assertDescendant(workspace, source);
      await copyVerified(source, join(staging, ...file.publicPath.split('/')), file.sha256, file.bytes);
    }
    const requiredPublicFiles = new Set([
      ...fragment.authors.map((author) => author.artwork.path),
      ...fragment.works.map((work) => work.source.provenancePath),
    ]);
    if ([...requiredPublicFiles].some((path) => !destinations.has(path))) {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `batchのprovenance/artwork実体がありません: ${batch.manifest.batchId}`);
    }
    const expectedAudio = new Map(fragment.audioAssets.map((asset) => [asset.path, asset]));
    for (const source of batch.acceptedAudioSources) {
      const audioId = basename(source.path, '.wav');
      const publicPath = `audio/${batch.manifest.batchId}/${audioId}.wav`;
      const catalogAudio = expectedAudio.get(publicPath);
      if (!catalogAudio || catalogAudio.batchId !== batch.manifest.batchId || catalogAudio.sha256 !== source.sha256 ||
        catalogAudio.bytes !== source.bytes || catalogAudio.configHash !== source.configHash) {
        throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `accepted audioとcatalog参照が一致しません: ${publicPath}`);
      }
      expectedAudio.delete(publicPath);
      if (destinations.has(publicPath)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `public pathが重複しています: ${publicPath}`);
      destinations.add(publicPath);
      if (!safeRelativePath(source.path)) throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_MISSING', 'accepted audio pathが不正です');
      const sourcePath = join(workspace, ...source.path.split('/'));
      await assertDescendant(workspace, sourcePath);
      await copyVerified(sourcePath, join(staging, ...publicPath.split('/')), source.sha256, source.bytes);
    }
    if (expectedAudio.size !== 0) throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_MISSING', `catalog音声にaccepted sourceがありません: ${batch.manifest.batchId}`);
  }
  if (active) {
    const activeStageRoot = await verifiedRoot(active.stagingRoot);
    await assertDescendant(workspace, activeStageRoot);
    const priorPublicPaths = new Set<string>();
    for (const source of activePriorSources) {
      const audioId = basename(source.path, '.wav');
      const publicPath = `audio/${active.manifest.batchId}/${audioId}.wav`;
      const catalogAudio = active.catalogFragment.audioAssets.find((asset) => asset.path === publicPath);
      if (!catalogAudio || catalogAudio.sha256 !== source.sha256 || catalogAudio.bytes !== source.bytes || catalogAudio.configHash !== source.configHash) {
        throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `先行accepted audioがactive catalogと一致しません: ${publicPath}`);
      }
      if (!priorPublicPaths.has(publicPath)) {
        if (destinations.has(publicPath)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `先行audio pathが重複しています: ${publicPath}`);
        const sourcePath = join(workspace, ...source.path.split('/'));
        await assertDescendant(workspace, sourcePath);
        await copyVerified(sourcePath, join(staging, ...publicPath.split('/')), source.sha256, source.bytes);
        destinations.add(publicPath);
        priorPublicPaths.add(publicPath);
      }
    }
    const expectedFiles = new Map<string, { sha256: string; bytes: number }>([
      ...active.catalogFragment.audioAssets.filter((asset) => !priorPublicPaths.has(asset.path))
        .map((asset) => [asset.path, { sha256: asset.sha256, bytes: asset.bytes }] as const),
      ...(active.catalogFragment.publicFiles ?? []).map((file) => [file.publicPath, { sha256: file.sha256, bytes: file.bytes }] as const),
    ]);
    const expectedFileCount = active.catalogFragment.audioAssets.filter((asset) => !priorPublicPaths.has(asset.path)).length +
      (active.catalogFragment.publicFiles?.length ?? 0);
    if (expectedFiles.size !== expectedFileCount ||
      active.stagedFiles.length !== expectedFiles.size) {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', 'preview expected file集合に重複・欠損があります');
    }
    for (const file of active.stagedFiles) {
      const allowedPaths = new Set([
        ...active.catalogFragment.audioAssets.map((asset) => asset.path),
        ...(active.catalogFragment.publicFiles ?? []).map((item) => item.publicPath),
      ]);
      if (!safeRelativePath(file.publicPath) || !allowedPaths.has(file.publicPath) || destinations.has(file.publicPath) || !isAbsolute(file.source)) {
        throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `preview pathが未参照・不正・重複です: ${file.publicPath}`);
      }
      const expected = expectedFiles.get(file.publicPath);
      if (!expected || expected.sha256 !== file.sha256 || expected.bytes !== file.bytes) {
        throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_HASH_MISMATCH', `preview metadataがcatalogと一致しません: ${file.publicPath}`);
      }
      expectedFiles.delete(file.publicPath);
      if (!insidePath(activeStageRoot, resolve(file.source))) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', 'preview sourceがactive staging外です');
      await assertDescendant(workspace, resolve(file.source));
      destinations.add(file.publicPath);
      await copyVerified(file.source, join(staging, ...file.publicPath.split('/')), file.sha256, file.bytes);
    }
    if (expectedFiles.size !== 0) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', 'preview expected fileが欠損しています');
  }
  const catalog = catalogFor(batches, f001, options.batchCatalogs ?? {}, active);
  const catalogBytes = canonicalJson(catalog);
  const validation = validateCatalogV2(catalog, Buffer.byteLength(catalogBytes, 'utf8'));
  if (!validation.ok) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `CatalogV2 validationに失敗しました: ${validation.error.code}`);
  await mkdir(join(staging, 'content'), { recursive: true });
  await writeFile(join(staging, 'content', 'catalog.json'), catalogBytes, 'utf8');
  const files = await treeFiles(staging);
  const buildSha256 = treeHash(files);
  let buildMetadataPath: string | undefined;
  if (options.mode === 'prepare-release') {
    const metadataPath = join(workspace, '.cache', 'build-metadata', `${buildSha256}.json`);
    await writeJsonArtifactAtomic(workspace, metadataPath, {
      schemaVersion: '1.0.0', mode: options.mode, buildSha256,
      staging: relative(workspace, staging).replaceAll('\\', '/'),
      releaseCandidateBatchId: candidate,
      feature: preparation?.feature,
      sourceCommit: preparation?.sourceCommit,
    }, { expectedFingerprint: await fingerprintArtifact(metadataPath) });
    await syncDirectory(dirname(metadataPath));
    buildMetadataPath = metadataPath;
  }
  if (options.mode === 'release-verify' && options.trackedPublicRoot) {
    const tracked = await treeFiles(await verifiedRoot(options.trackedPublicRoot));
    if (treeHash(tracked) !== buildSha256) throw new PublicIntegrationError('PUBLIC_REPRODUCIBILITY_MISMATCH', 'tracked publicと再生成treeが一致しません');
  }
  return Object.freeze({
    mode: options.mode,
    stagingRoot: staging,
    buildSha256,
    files: Object.freeze(files.map((file) => Object.freeze({ path: file.path, sha256: hash(file.bytes), bytes: file.bytes.byteLength }))),
    ...(candidate ? { releaseCandidateBatchId: candidate } : {}),
    ...(preparation ? { feature: preparation.feature, sourceCommit: preparation.sourceCommit } : {}),
    ...(release ? { feature: release.feature, releaseCommit: release.releaseCommit } : {}),
    ...(buildMetadataPath ? { buildMetadataPath } : {}),
    ...(active ? { activeBatchId: active.manifest.batchId, activeWorkId: active.workId } : {}),
  });
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EINVAL', 'EISDIR', 'EBADF', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function renameRetry(source: string, target: string): Promise<void> {
  const delays = [0, 100, 250, 500];
  let last: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    try {
      await rename(source, target);
      return;
    } catch (error) {
      last = error;
      if (!['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw last;
}

interface PublicPromotionJournal {
  readonly schemaVersion: '1.0.0';
  readonly phase: 'prepared' | 'old-moved' | 'new-moved' | 'verified';
  readonly staging: string;
  readonly backup: string;
  readonly expectedBuildSha: Sha256;
  readonly expectedCurrentPublicSha: Sha256;
  readonly preparation: ReleasePreparationContext;
  readonly owner: PublicLockOwner;
}

interface PublicLockOwner {
  readonly schemaVersion: '1.0.0';
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function digestTree(path: string): Promise<Sha256 | undefined> {
  if (!await exists(path)) return undefined;
  return treeHash(await treeFiles(await verifiedRoot(path)));
}

async function allowedPublicAudioOwners(staging: string, releaseCandidateBatchId: BatchId): Promise<ReadonlySet<string>> {
  const catalogPath = join(staging, 'content', 'catalog.json');
  const catalogBytes = await readFile(catalogPath);
  let catalog: unknown;
  try {
    catalog = JSON.parse(catalogBytes.toString('utf8'));
  } catch {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'staging catalog JSONが不正です');
  }
  const validation = validateCatalogV2(catalog, catalogBytes.byteLength);
  if (!validation.ok) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', `staging CatalogV2 validationに失敗しました: ${validation.error.code}`);
  }
  const owners = new Set(validation.value.batches.map((batch) => batch.batchId));
  if (!owners.has('F001') || !owners.has(releaseCandidateBatchId)) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'staging catalogにF001またはrelease candidateがありません');
  }
  return owners;
}

async function quarantineUnknownPublicAudioOwners(
  root: string,
  publicRoot: string,
  staging: string,
  releaseCandidateBatchId: BatchId,
): Promise<void> {
  const audioRoot = join(publicRoot, 'audio');
  if (!await exists(audioRoot)) return;
  const audioInfo = await lstat(audioRoot);
  if (!audioInfo.isDirectory() || audioInfo.isSymbolicLink()) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'current public audio root実体が不正です');
  }
  const allowedOwners = await allowedPublicAudioOwners(staging, releaseCandidateBatchId);
  const unknownOwners: string[] = [];
  for (const name of (await readdir(audioRoot)).sort((left, right) => left.localeCompare(right, 'en'))) {
    const info = await lstat(join(audioRoot, name));
    if (!allowedOwners.has(name) || !info.isDirectory() || info.isSymbolicLink()) unknownOwners.push(name);
  }
  if (unknownOwners.length === 0) return;

  const quarantineRoot = join(root, '.cache', 'quarantine', 'public-audio-owner', randomUUID());
  await mkdir(quarantineRoot, { recursive: true });
  await assertDescendant(root, quarantineRoot);
  for (const name of unknownOwners) {
    await renameRetry(join(audioRoot, name), join(quarantineRoot, name));
  }
  await Promise.all([syncDirectory(audioRoot), syncDirectory(quarantineRoot), syncDirectory(dirname(quarantineRoot))]);
  throw new PublicIntegrationError(
    'PUBLIC_AUDIO_OWNER_QUARANTINED',
    `未知のpublic audio ownerを隔離しました: ${unknownOwners.join(', ')}`,
  );
}

function samePreparation(left: ReleasePreparationContext, right: ReleasePreparationContext): boolean {
  return left.releaseCandidateBatchId === right.releaseCandidateBatchId && left.feature === right.feature && left.sourceCommit === right.sourceCommit;
}

function resolveJournalPath(root: string, value: string): string {
  if (!safeRelativePath(value)) throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'journal pathが不正です');
  const path = join(root, ...value.split('/'));
  const relation = relative(root, path);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`)) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'journal pathがworkspace外です');
  }
  return path;
}

function parsePromotionJournal(text: string): PublicPromotionJournal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'journal JSONが不正です');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || canonicalJson(value) !== text) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'journalがcanonical objectではありません');
  }
  const record = value as Record<string, unknown>;
  const keys = ['backup', 'expectedBuildSha', 'expectedCurrentPublicSha', 'owner', 'phase', 'preparation', 'schemaVersion', 'staging'];
  if (Object.keys(record).sort((a, b) => a.localeCompare(b, 'en')).join('\0') !== keys.join('\0') ||
    record.schemaVersion !== '1.0.0' || !['prepared', 'old-moved', 'new-moved', 'verified'].includes(String(record.phase)) ||
    typeof record.staging !== 'string' || typeof record.backup !== 'string' ||
    typeof record.expectedBuildSha !== 'string' || !/^[a-f0-9]{64}$/u.test(record.expectedBuildSha) ||
    typeof record.expectedCurrentPublicSha !== 'string' || !/^[a-f0-9]{64}$/u.test(record.expectedCurrentPublicSha) ||
    record.preparation === null || typeof record.preparation !== 'object' || Array.isArray(record.preparation) ||
    record.owner === null || typeof record.owner !== 'object' || Array.isArray(record.owner)) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'journal schemaが不正です');
  }
  const preparation = record.preparation as Record<string, unknown>;
  const preparationKeys = ['feature', 'releaseCandidateBatchId', 'sourceCommit'];
  if (Object.keys(preparation).sort((a, b) => a.localeCompare(b, 'en')).join('\0') !== preparationKeys.join('\0') ||
    typeof preparation.releaseCandidateBatchId !== 'string' || typeof preparation.feature !== 'string' || typeof preparation.sourceCommit !== 'string') {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'journal preparation schemaが不正です');
  }
  const owner = record.owner as Record<string, unknown>;
  const ownerKeys = ['pid', 'schemaVersion', 'startedAt', 'token'];
  if (Object.keys(owner).sort((a, b) => a.localeCompare(b, 'en')).join('\0') !== ownerKeys.join('\0') || owner.schemaVersion !== '1.0.0' ||
    !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt)) ||
    typeof owner.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(owner.token)) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'journal owner schemaが不正です');
  }
  return value as PublicPromotionJournal;
}

function publicOwnerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function acquirePublicLock(
  root: string,
  lockPath: string,
  journalPath: string,
): Promise<{ handle: Awaited<ReturnType<typeof open>>; owner: PublicLockOwner }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner: PublicLockOwner = {
      schemaVersion: '1.0.0', pid: process.pid,
      startedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(), token: randomUUID(),
    };
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(canonicalJson(owner), 'utf8');
      await handle.sync();
      await syncDirectory(dirname(lockPath));
      return { handle, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt !== 0) {
        throw new PublicIntegrationError('PUBLIC_LOCKED', 'public promotion lockを取得できません');
      }
      let stale: PublicLockOwner;
      try {
        const text = await readFile(lockPath, 'utf8');
        stale = JSON.parse(text) as PublicLockOwner;
        if (canonicalJson(stale) !== text || stale.schemaVersion !== '1.0.0' || !Number.isSafeInteger(stale.pid) || stale.pid <= 0 ||
          !Number.isFinite(Date.parse(stale.startedAt)) || !/^[0-9a-f-]{36}$/u.test(stale.token)) {
          throw new PublicIntegrationError('PUBLIC_LOCKED', '既存public lock schemaが不正です', { cause: error });
        }
      } catch (parseError) {
        throw new PublicIntegrationError('PUBLIC_LOCKED', '既存public lock ownerを検証できません', { cause: parseError });
      }
      if (publicOwnerAlive(stale.pid)) throw new PublicIntegrationError('PUBLIC_LOCKED', '生存中ownerがpublic lockを保持しています');
      if (await exists(journalPath)) {
        const journal = parsePromotionJournal(await readFile(journalPath, 'utf8'));
        if (canonicalJson(journal.owner) !== canonicalJson(stale)) throw new PublicIntegrationError('PUBLIC_LOCKED', 'stale public lockとjournal ownerが一致しません');
      }
      await rm(lockPath, { force: true });
      await syncDirectory(dirname(lockPath));
    }
  }
  throw new PublicIntegrationError('PUBLIC_LOCKED', 'public promotion lockを取得できません');
}

function resolveBackupPath(root: string, value: string): string {
  if (!/^\.public-backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'journal backup名が不正です');
  }
  return resolveJournalPath(root, value);
}

async function readBuildMetadata(root: string, buildSha256: Sha256): Promise<Record<string, unknown>> {
  const path = join(root, '.cache', 'build-metadata', `${buildSha256}.json`);
  await assertDescendant(root, path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'build metadata実体が不正です');
  }
  const text = await readFile(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'build metadata JSONが不正です');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || canonicalJson(value) !== text) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'build metadataがcanonical objectではありません');
  }
  const record = value as Record<string, unknown>;
  const keys = ['buildSha256', 'feature', 'mode', 'releaseCandidateBatchId', 'schemaVersion', 'sourceCommit', 'staging'];
  if (Object.keys(record).sort((a, b) => a.localeCompare(b, 'en')).join('\0') !== keys.join('\0')) {
    throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'build metadata schemaが不正です');
  }
  return record;
}

/** @des DES-F002-006 DES-F002-015 @fun FUN-F002-019 */
export async function promoteIntegratedTree(
  workspace: string,
  staging: string,
  expectedBuildSha: Sha256,
  expectedCurrentPublicSha: Sha256,
  invariant: F001ContentInvariantReport,
  preparation: ReleasePreparationContext,
  options: PublicPromotionOptions = {},
): Promise<void> {
  const root = await verifiedRoot(workspace);
  if (!isAbsolute(staging)) throw new PublicIntegrationError('PUBLIC_WORKSPACE_BOUNDARY', 'stagingは絶対pathが必要です');
  const stage = resolve(staging);
  await assertDescendant(root, stage);
  if (parse(root).root.toLowerCase() !== parse(stage).root.toLowerCase()) throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'stagingはworkspaceと同volumeが必要です');
  const publicRoot = join(root, 'public');
  const lockPath = join(root, '.cache', 'locks', 'public-build.lock');
  const journalPath = join(root, '.cache', 'transactions', 'public-build.json');
  await mkdir(dirname(lockPath), { recursive: true });
  await assertDescendant(root, dirname(lockPath));
  await assertDescendant(root, dirname(journalPath));
  const lock = await acquirePublicLock(root, lockPath, journalPath);
  let backup = join(root, `.public-backup-${randomUUID()}`);
  const writeJournal = async (phase: PublicPromotionJournal['phase']): Promise<void> => {
    const expectedFingerprint = await fingerprintArtifact(journalPath);
    await writeJsonArtifactAtomic(root, journalPath, {
      schemaVersion: '1.0.0', phase, staging: relative(root, stage).replaceAll('\\', '/'), backup: relative(root, backup).replaceAll('\\', '/'),
      expectedBuildSha, expectedCurrentPublicSha, preparation, owner: lock.owner,
    }, { expectedFingerprint });
    await syncDirectory(dirname(journalPath));
    await options.afterPhase?.(phase);
  };
  let oldMoved = false;
  let newMoved = false;
  try {
    let phase: PublicPromotionJournal['phase'] | undefined;
    if (await exists(journalPath)) {
      const journalInfo = await lstat(journalPath);
      if (!journalInfo.isFile() || journalInfo.isSymbolicLink() || await realpath(journalPath) !== journalPath) {
        throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'journal実体が不正です');
      }
      const recovered = parsePromotionJournal(await readFile(journalPath, 'utf8'));
      if (recovered.schemaVersion !== '1.0.0' || recovered.expectedBuildSha !== expectedBuildSha ||
        recovered.expectedCurrentPublicSha !== expectedCurrentPublicSha || recovered.staging !== relative(root, stage).replaceAll('\\', '/') ||
        !samePreparation(recovered.preparation, preparation) || !['prepared', 'old-moved', 'new-moved', 'verified'].includes(recovered.phase)) {
        throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', '既存journalのtransaction tupleが一致しません');
      }
      backup = resolveBackupPath(root, recovered.backup);
      phase = recovered.phase;
      if (canonicalJson(recovered.owner) !== canonicalJson(lock.owner)) await writeJournal(phase);
    }

    if ((!phase || phase === 'prepared') && await exists(stage) && await exists(publicRoot)) {
      await quarantineUnknownPublicAudioOwners(root, publicRoot, stage, preparation.releaseCandidateBatchId);
    }

    if (!phase) {
      const verifiedStage = await verifiedRoot(stage);
      const metadata = await readBuildMetadata(root, expectedBuildSha);
      if (metadata.mode !== 'prepare-release' || metadata.buildSha256 !== expectedBuildSha ||
        metadata.staging !== relative(root, verifiedStage).replaceAll('\\', '/') ||
        metadata.releaseCandidateBatchId !== preparation.releaseCandidateBatchId || metadata.feature !== preparation.feature ||
        metadata.sourceCommit !== preparation.sourceCommit || invariant.result !== 'pass' ||
        invariant.buildSha256 !== expectedBuildSha || invariant.stagingSha256 !== expectedBuildSha) {
        throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'prepare marker/invariant tupleが一致しません');
      }
      const [{ stdout: head }, { stdout: status }] = await Promise.all([
        execFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }),
        execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }),
      ]);
      if (head.trim() !== preparation.sourceCommit || status.trim() !== '') throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'sourceCommit checkoutがcleanではありません');
      if (await digestTree(stage) !== expectedBuildSha) throw new PublicIntegrationError('PUBLIC_STAGING_HASH_CHANGED', 'staging digestが変化しています');
      if (await digestTree(publicRoot) !== expectedCurrentPublicSha) throw new PublicIntegrationError('PUBLIC_CURRENT_HASH_CHANGED', 'current public digestが変化しています');
      await writeJournal('prepared');
      phase = 'prepared';
    }

    if (phase === 'prepared') {
      if (await digestTree(stage) !== expectedBuildSha) throw new PublicIntegrationError('PUBLIC_STAGING_HASH_CHANGED', 'staging digestが変化しています');
      if (await digestTree(publicRoot) !== expectedCurrentPublicSha) throw new PublicIntegrationError('PUBLIC_CURRENT_HASH_CHANGED', 'current public digestが変化しています');
      await renameRetry(publicRoot, backup);
      await syncDirectory(root);
      oldMoved = true;
      await writeJournal('old-moved');
      phase = 'old-moved';
    }
    if (phase === 'old-moved') {
      if (await digestTree(backup) !== expectedCurrentPublicSha || await digestTree(stage) !== expectedBuildSha || await exists(publicRoot)) {
        throw new PublicIntegrationError('PUBLIC_PROMOTION_CONFLICT', 'old-moved recovery treeが一致しません');
      }
      oldMoved = true;
      await renameRetry(stage, publicRoot);
      await Promise.all([syncDirectory(root), syncDirectory(dirname(stage))]);
      newMoved = true;
      await writeJournal('new-moved');
      phase = 'new-moved';
    }
    if ((phase === 'new-moved' || phase === 'verified') &&
      (await digestTree(publicRoot) !== expectedBuildSha || await digestTree(backup) !== expectedCurrentPublicSha)) {
      throw new PublicIntegrationError('PUBLIC_POSTPROMOTION_MISMATCH', 'recovery後digestが一致しません');
    }
    await syncDirectory(root);
    if (phase !== 'verified') await writeJournal('verified');
    await rm(backup, { recursive: true, force: true });
    await syncDirectory(root);
    await rm(journalPath, { force: true });
    await syncDirectory(dirname(journalPath));
    const metadataPath = join(root, '.cache', 'build-metadata', `${expectedBuildSha}.json`);
    await rm(metadataPath, { force: true });
    await syncDirectory(dirname(metadataPath));
  } catch (error) {
    if (oldMoved && !newMoved) {
      try {
        await renameRetry(backup, publicRoot);
        await syncDirectory(root);
        await rm(journalPath, { force: true });
        await syncDirectory(dirname(journalPath));
      } catch {
        throw new PublicIntegrationError('PUBLIC_ROLLBACK_FAILED', '旧publicを復元できません');
      }
    }
    throw error;
  } finally {
    await lock.handle.close();
    const current = await readFile(lockPath, 'utf8').then((text) => JSON.parse(text) as PublicLockOwner).catch(() => undefined);
    if (current?.token === lock.owner.token) await rm(lockPath, { force: true });
    await syncDirectory(dirname(lockPath));
  }
}
