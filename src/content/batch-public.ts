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
import {
  assertArtworkProvenanceMatches,
  artworkCreditFromProvenance,
  validateArtworkProvenanceBundle,
  type ArtworkCreditManifest,
} from '../notices/artwork-bundle.ts';
import {
  loadAndVerifyTrustedArtworkMachineReview,
  validateArtworkProvenance,
  type ArtworkProvenanceV2,
  type ArtworkProvenanceV3,
} from '../notices/artwork-provenance.ts';
import {
  computeDHash64V1,
  parseAndRehydrateF005ArtworkProvenance,
  verifyF005ArtworkAgainstCatalog,
} from './f005-artwork.ts';
import { loadVerifiedF005Definition } from './f005-context.ts';
import {
  parseAndRehydrateF006ArtworkProvenance,
  verifyF006ArtworkAgainstCatalog,
} from './f006-artwork.ts';
import {
  parseAndRehydrateF007ArtworkProvenance,
  verifyF007ArtworkAgainstCatalog,
} from './f007-artwork.ts';
import {
  parseAndRehydrateF008ArtworkProvenance,
  verifyF008ArtworkAgainstCatalog,
} from './f008-artwork.ts';

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
  readonly publishedCatalogBatches?: Readonly<Record<string, CatalogV2['batches'][number]>>;
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
  readonly rename?: (source: string, target: string) => Promise<void>;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

function hash(bytes: Uint8Array | string): Sha256 {
  return createHash('sha256').update(bytes).digest('hex') as Sha256;
}

function parseBoundedJson(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > 262_144) {
    throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `${label}のsizeが不正です`);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `${label}が正しいUTF-8 JSONではありません`);
  }
}

async function integrateArtworkProvenances(
  catalog: CatalogV2,
  batches: readonly PublishableBatch[],
  active: ActiveBatchPreview | undefined,
  f001: F001BaselineBundle,
  workspace: string,
  staging: string,
  destinations: Set<string>,
): Promise<void> {
  const legacyRef = 'content/artwork-provenance.json' as WorkspaceRelativePath;
  const legacyFile = f001.files.find((file) => file.path === legacyRef);
  if (!legacyFile || !destinations.has(legacyRef)) {
    throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', 'F001画像provenanceがbaselineにありません');
  }
  const legacyBytes = new Uint8Array(await readFile(join(staging, ...legacyRef.split('/'))));
  if (legacyBytes.byteLength !== legacyFile.bytes || hash(legacyBytes) !== legacyFile.sha256) {
    throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', 'F001画像provenanceがbaseline metadataと一致しません');
  }
  const sources = new Map<string, { manifest: BatchManifest; source: string }>();
  for (const batch of batches) {
    sources.set(batch.manifest.batchId, {
      manifest: batch.manifest,
      source: join(workspace, ...batch.manifest.artworkProvenanceRef.split('/')),
    });
  }
  if (active) {
    if (sources.has(active.manifest.batchId)) {
      throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `画像provenance batchが重複しています: ${active.manifest.batchId}`);
    }
    sources.set(active.manifest.batchId, {
      manifest: active.manifest,
      source: join(workspace, ...active.manifest.artworkProvenanceRef.split('/')),
    });
  }

  const entries: ArtworkCreditManifest[] = [];
  for (const author of catalog.authors) {
    if (author.introducedByBatchId === 'F001') {
      const raw = parseBoundedJson(legacyBytes, legacyRef);
      if (!isRecord(raw) || typeof raw.manifestId !== 'string') {
        throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', 'F001画像provenance identityが不正です');
      }
      const entry: ArtworkCreditManifest = {
        authorId: author.authorId,
        batchId: 'F001',
        manifestId: raw.manifestId,
        provenanceRef: legacyRef,
        provenanceSha256: hash(legacyBytes),
        output: { path: author.artwork.path, sha256: author.artwork.sha256 },
      };
      try {
        assertArtworkProvenanceMatches(entry, raw);
        artworkCreditFromProvenance(entry, raw);
      } catch (error) {
        throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', 'F001画像provenanceがcatalogと一致しません', { cause: error });
      }
      entries.push(entry);
      continue;
    }

    const source = sources.get(author.introducedByBatchId);
    if (!source || source.manifest.author.authorId !== author.authorId ||
      !safeRelativePath(source.manifest.artworkProvenanceRef)) {
      throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', `作者画像provenanceのbatch/authorが不一致です: ${author.authorId}`);
    }
    await assertDescendant(workspace, source.source);
    const info = await lstat(source.source);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `作者画像provenanceが通常fileではありません: ${author.authorId}`);
    }
    const bytes = new Uint8Array(await readFile(source.source));
    const raw = parseBoundedJson(bytes, source.manifest.artworkProvenanceRef);
    if (!isRecord(raw) || typeof raw.manifestId !== 'string') {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `作者画像provenance identityが不正です: ${author.authorId}`);
    }
    if (
      author.introducedByBatchId !== 'F002' && author.introducedByBatchId !== 'F003' &&
      author.introducedByBatchId !== 'F005' && author.introducedByBatchId !== 'F006' &&
      author.introducedByBatchId !== 'F007' && author.introducedByBatchId !== 'F008'
    ) {
      throw new PublicIntegrationError(
        'PUBLIC_REFERENCE_MISSING',
        `作者画像provenance schema validatorが未登録です: ${author.introducedByBatchId}`,
      );
    }
    try {
      if (author.introducedByBatchId === 'F008') {
        const generationRaw = isRecord(raw.generation) ? raw.generation : undefined;
        if (!generationRaw) throw new Error('f008-generation-missing');
        const imageBytes = new Uint8Array(await readFile(join(staging, ...author.artwork.path.split('/'))));
        const provenance = parseAndRehydrateF008ArtworkProvenance(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          {
            generator: 'ComfyUI (local)',
            generatorVersion: generationRaw.generatorVersion as string,
            model: generationRaw.model as string,
            workflow: generationRaw.workflow as string,
            prompt: generationRaw.prompt as string,
            negativePrompt: generationRaw.negativePrompt as string,
            seed: generationRaw.seed as number,
            generatedAt: generationRaw.generatedAt as string,
            originalImageBytes: imageBytes,
          },
          { referenceInputs: [] },
          {
            sourcePath: 'content/batches/F008/public-files/artwork/edogawa-ranpo-zundamon.png',
            publicPath: 'artwork/edogawa-ranpo-zundamon.png',
            credit: typeof raw.credit === 'string' ? raw.credit : '',
            bytes: imageBytes,
          },
        );
        const existingArtwork = await Promise.all(
          catalog.authors
            .filter((item) => item.authorId !== author.authorId)
            .map(async (item) => {
              const existingBytes = new Uint8Array(await readFile(join(staging, ...item.artwork.path.split('/'))));
              return {
                authorId: item.authorId,
                path: item.artwork.path,
                bytes: existingBytes,
                sha256: item.artwork.sha256,
                dHash64: computeDHash64V1(existingBytes),
              };
            }),
        );
        const acceptance = verifyF008ArtworkAgainstCatalog(provenance, imageBytes, existingArtwork);
        if (acceptance.path !== author.artwork.path || acceptance.sha256 !== author.artwork.sha256) {
          throw new Error('f008-artwork-catalog-mismatch');
        }
      } else if (author.introducedByBatchId === 'F007') {
        const generationRaw = isRecord(raw.generation) ? raw.generation : undefined;
        if (!generationRaw) throw new Error('f007-generation-missing');
        const imageBytes = new Uint8Array(await readFile(join(staging, ...author.artwork.path.split('/'))));
        const provenance = parseAndRehydrateF007ArtworkProvenance(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          {
            generator: 'ComfyUI (local)',
            generatorVersion: generationRaw.generatorVersion as string,
            model: generationRaw.model as string,
            workflow: generationRaw.workflow as string,
            prompt: generationRaw.prompt as string,
            negativePrompt: generationRaw.negativePrompt as string,
            seed: generationRaw.seed as number,
            generatedAt: generationRaw.generatedAt as string,
            originalImageBytes: imageBytes,
          },
          { referenceInputs: [] },
          {
            sourcePath: 'content/batches/F007/public-files/artwork/mori-ogai-zundamon.png',
            publicPath: 'artwork/mori-ogai-zundamon.png',
            credit: typeof raw.credit === 'string' ? raw.credit : '',
            bytes: imageBytes,
          },
        );
        const existingArtwork = await Promise.all(
          catalog.authors
            .filter((item) => item.authorId !== author.authorId)
            .map(async (item) => {
              const existingBytes = new Uint8Array(await readFile(join(staging, ...item.artwork.path.split('/'))));
              return {
                authorId: item.authorId,
                path: item.artwork.path,
                bytes: existingBytes,
                sha256: item.artwork.sha256,
                dHash64: computeDHash64V1(existingBytes),
              };
            }),
        );
        const acceptance = verifyF007ArtworkAgainstCatalog(provenance, imageBytes, existingArtwork);
        if (acceptance.path !== author.artwork.path || acceptance.sha256 !== author.artwork.sha256) {
          throw new Error('f007-artwork-catalog-mismatch');
        }
      } else if (author.introducedByBatchId === 'F006') {
        const generationRaw = isRecord(raw.generation) ? raw.generation : undefined;
        if (!generationRaw) throw new Error('f006-generation-missing');
        const imageBytes = new Uint8Array(await readFile(join(staging, ...author.artwork.path.split('/'))));
        const provenance = parseAndRehydrateF006ArtworkProvenance(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          {
            generator: 'ComfyUI (local)',
            generatorVersion: generationRaw.generatorVersion as string,
            model: generationRaw.model as string,
            workflow: generationRaw.workflow as string,
            prompt: generationRaw.prompt as string,
            negativePrompt: generationRaw.negativePrompt as string,
            seed: generationRaw.seed as number,
            generatedAt: generationRaw.generatedAt as string,
            originalImageBytes: imageBytes,
          },
          { referenceInputs: [] },
          {
            sourcePath: 'content/batches/F006/public-files/artwork/nakajima-zundamon.png',
            publicPath: 'artwork/nakajima-zundamon.png',
            credit: typeof raw.credit === 'string' ? raw.credit : '',
            bytes: imageBytes,
          },
        );
        const existingArtwork = await Promise.all(
          catalog.authors
            .filter((item) => item.authorId !== author.authorId)
            .map(async (item) => {
              const existingBytes = new Uint8Array(await readFile(join(staging, ...item.artwork.path.split('/'))));
              return {
                authorId: item.authorId,
                path: item.artwork.path,
                bytes: existingBytes,
                sha256: item.artwork.sha256,
                dHash64: computeDHash64V1(existingBytes),
              };
            }),
        );
        const acceptance = verifyF006ArtworkAgainstCatalog(provenance, imageBytes, existingArtwork);
        if (acceptance.path !== author.artwork.path || acceptance.sha256 !== author.artwork.sha256) {
          throw new Error('f006-artwork-catalog-mismatch');
        }
      } else if (author.introducedByBatchId === 'F005') {
        const generationRaw = isRecord(raw.generation) ? raw.generation : undefined;
        if (!generationRaw) throw new Error('f005-generation-missing');
        const context = await loadVerifiedF005Definition(workspace);
        const imageBytes = new Uint8Array(await readFile(join(staging, ...author.artwork.path.split('/'))));
        const provenance = parseAndRehydrateF005ArtworkProvenance(
          context,
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          {
            generator: generationRaw.generator as string,
            generatorVersion: generationRaw.generatorVersion as string,
            tool: generationRaw.tool as string,
            providerTerms: generationRaw.providerTerms as never,
            characterGuideline: generationRaw.characterGuideline as never,
            prompt: generationRaw.prompt as string,
            negativePrompt: generationRaw.negativePrompt as string,
            generatedAt: generationRaw.generatedAt as string,
            originalImageBytes: imageBytes,
          },
          { referenceInputs: [], processingInputs: [] } as never,
          {
            sourcePath: 'content/batches/F005/public-files/artwork/natsume-zundamon.png',
            publicPath: 'artwork/natsume-zundamon.png',
            credit: typeof raw.credit === 'string' ? raw.credit : '',
            bytes: imageBytes,
          },
        );
        const existingArtwork = await Promise.all(
          catalog.authors
            .filter((item) => item.authorId !== author.authorId)
            .map(async (item) => {
              const existingBytes = new Uint8Array(await readFile(join(staging, ...item.artwork.path.split('/'))));
              return {
                authorId: item.authorId,
                path: item.artwork.path,
                bytes: existingBytes,
                sha256: item.artwork.sha256,
                dHash64: computeDHash64V1(existingBytes),
              };
            }),
        );
        const acceptance = verifyF005ArtworkAgainstCatalog(provenance, imageBytes, existingArtwork);
        if (acceptance.path !== author.artwork.path || acceptance.sha256 !== author.artwork.sha256) {
          throw new Error('f005-artwork-catalog-mismatch');
        }
      } else {
        const decision = author.introducedByBatchId === 'F003'
          ? await validateArtworkProvenance(
              raw as unknown as ArtworkProvenanceV3,
              workspace,
              await loadAndVerifyTrustedArtworkMachineReview(workspace, {
                manifestId: String(raw.manifestId),
                batchId: source.manifest.batchId,
                authorId: source.manifest.author.authorId,
                outputPath: author.artwork.path,
              }),
            )
          : await validateArtworkProvenance(raw as unknown as ArtworkProvenanceV2, workspace);
        if (decision.authorId !== author.authorId || decision.outputPath !== author.artwork.path ||
          decision.outputSha256 !== author.artwork.sha256) {
          throw new Error('artwork-decision-catalog-mismatch');
        }
      }
    } catch (error) {
      throw new PublicIntegrationError(
        'PUBLIC_ARTWORK_PROVENANCE_INVALID',
        `作者画像provenance完全検証に失敗しました: ${author.authorId}`,
        { cause: error },
      );
    }
    const provenanceRef = `content/artwork-provenance/${author.introducedByBatchId}.json` as WorkspaceRelativePath;
    const sourceEntry: ArtworkCreditManifest = {
      authorId: author.authorId,
      batchId: author.introducedByBatchId,
      manifestId: raw.manifestId,
      provenanceRef,
      provenanceSha256: hash(bytes),
      output: { path: author.artwork.path, sha256: author.artwork.sha256 },
    };
    let credit: string | undefined;
    try {
      assertArtworkProvenanceMatches(sourceEntry, raw);
      credit = artworkCreditFromProvenance(sourceEntry, raw);
    } catch (error) {
      throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', `作者画像provenanceがcatalogと一致しません: ${author.authorId}`, { cause: error });
    }
    const publicManifestBytes = new TextEncoder().encode(canonicalJson({
      schemaVersion: '1.0.0',
      authorId: sourceEntry.authorId,
      batchId: sourceEntry.batchId,
      manifestId: sourceEntry.manifestId,
      credit,
      sourceManifestSha256: hash(bytes),
      output: sourceEntry.output,
    }));
    const entry: ArtworkCreditManifest = {
      ...sourceEntry,
      provenanceSha256: hash(publicManifestBytes),
    };
    if (destinations.has(provenanceRef)) {
      throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `作者画像provenance公開pathが重複しています: ${provenanceRef}`);
    }
    destinations.add(provenanceRef);
    await mkdir(dirname(join(staging, ...provenanceRef.split('/'))), { recursive: true });
    await writeFile(join(staging, ...provenanceRef.split('/')), publicManifestBytes);
    entries.push(entry);
  }
  let bundle;
  try {
    bundle = validateArtworkProvenanceBundle({ schemaVersion: '1.0.0', artworks: entries });
  } catch (error) {
    throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', '作者画像provenance集約が不正です', { cause: error });
  }
  const bundlePath = 'content/artwork-provenances.json';
  if (destinations.has(bundlePath)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `${bundlePath}が既に存在します`);
  destinations.add(bundlePath);
  await writeFile(join(staging, ...bundlePath.split('/')), canonicalJson(bundle), 'utf8');
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

interface NormalizedBatchCatalog {
  readonly fragment: BatchCatalogFragment;
  readonly audioAliases: ReadonlyMap<string, string>;
}

interface ReferencedPublicEvidence {
  readonly source: WorkspaceRelativePath;
  readonly publicPath: WorkspaceRelativePath;
  readonly sha256: Sha256;
  readonly bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBatchAudio(batchId: string, fragment: BatchCatalogFragment): NormalizedBatchCatalog {
  const canonicalBySha = new Map<string, CatalogV2['audioAssets'][number]>();
  const aliases = new Map<string, string>();
  for (const asset of [...fragment.audioAssets].sort((left, right) => left.audioId.localeCompare(right.audioId, 'en'))) {
    const canonical = canonicalBySha.get(asset.sha256);
    if (!canonical) {
      canonicalBySha.set(asset.sha256, {
        ...asset,
        ...(asset.candidateIds ? { candidateIds: [...asset.candidateIds].sort((left, right) => left.localeCompare(right, 'en')) } : {}),
      });
      aliases.set(asset.audioId, asset.audioId);
      continue;
    }
    if (asset.batchId !== batchId || canonical.batchId !== batchId || asset.bytes !== canonical.bytes ||
      asset.durationMs !== canonical.durationMs || asset.configHash !== canonical.configHash) {
      throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_HASH_MISMATCH', `同一WAV hashのmetadataが競合しています: ${asset.audioId}`);
    }
    aliases.set(asset.audioId, canonical.audioId);
    if (asset.candidateIds) {
      canonical.candidateIds = [...new Set([...(canonical.candidateIds ?? []), ...asset.candidateIds])]
        .sort((left, right) => left.localeCompare(right, 'en'));
    }
  }
  const works = fragment.works.map((work) => ({
    ...work,
    dialogues: work.dialogues.map((dialogue) => ({
      ...dialogue,
      audioId: aliases.get(dialogue.audioId) ?? dialogue.audioId,
    })),
  }));
  return {
    fragment: {
      ...fragment,
      works,
      audioAssets: [...canonicalBySha.values()],
    },
    audioAliases: aliases,
  };
}

/**
 * 新規作者はbatch順に末尾へ、既存作者への追加作品はその作者の最終作品直後へ統合する。
 * @des DES-F004-007 @fun FUN-F004-022 @ut UT-F004-022
 */
export function mergeCatalogWorksByAuthor(
  baseWorks: CatalogV2['works'],
  fragments: readonly BatchCatalogFragment[],
): CatalogV2['works'] {
  const mergedWorks = [...baseWorks];
  for (const fragment of fragments) {
    const authorIds = new Set(fragment.works.map((work) => work.authorId));
    if (authorIds.size !== 1) {
      throw new PublicIntegrationError('PUBLIC_CROSS_AUTHOR_REFERENCE', 'batch fragmentの作者が単一ではありません');
    }
    const authorId = fragment.works[0]?.authorId;
    const introducesAuthor = fragment.authors.some((author) => author.authorId === authorId);
    if (introducesAuthor) {
      mergedWorks.push(...fragment.works);
      continue;
    }
    let insertionIndex = -1;
    for (let index = 0; index < mergedWorks.length; index += 1) {
      if (mergedWorks[index]?.authorId === authorId) insertionIndex = index + 1;
    }
    if (insertionIndex < 0) {
      throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', `既存作者の作品挿入先がありません: ${authorId ?? 'missing'}`);
    }
    mergedWorks.splice(insertionIndex, 0, ...fragment.works);
  }
  return mergedWorks;
}

async function referencedPublicEvidence(
  workspace: string,
  batchId: string,
  fragment: BatchCatalogFragment,
): Promise<readonly ReferencedPublicEvidence[]> {
  const result: ReferencedPublicEvidence[] = [];
  for (const work of fragment.works) {
    const provenance = fragment.publicFiles?.find((file) => file.publicPath === work.source.provenancePath);
    if (!provenance) continue;
    const source = join(workspace, ...provenance.source.split('/'));
    await assertDescendant(workspace, source);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(source) !== source) {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `provenance source実体が不正です: ${work.workId}`);
    }
    const bytes = await readFile(source);
    if (bytes.byteLength !== provenance.bytes || hash(bytes) !== provenance.sha256 ||
      provenance.sha256 !== work.source.provenanceSha256) {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `provenance source hashが一致しません: ${work.workId}`);
    }
    let document: unknown;
    try {
      document = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `provenance JSONが不正です: ${work.workId}`);
    }
    if (!isRecord(document) || canonicalJson(document) !== bytes.toString('utf8')) {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `provenance JSONがcanonicalではありません: ${work.workId}`);
    }
    const references = [
      ['editorialReview', `content/batches/${batchId}/reviews/${work.workId}.json`],
      ['speechRevisions', `content/batches/${batchId}/speech-revisions/${work.workId}.json`],
    ] as const;
    for (const [key, expectedPath] of references) {
      const value = document[key];
      if (value === undefined) continue;
      if (!isRecord(value) || value.path !== expectedPath || typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.sha256) || !safeRelativePath(expectedPath)) {
        throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `provenance ${key}参照が不正です: ${work.workId}`);
      }
      const evidencePath = join(workspace, ...expectedPath.split('/'));
      await assertDescendant(workspace, evidencePath);
      const evidenceInfo = await lstat(evidencePath);
      if (!evidenceInfo.isFile() || evidenceInfo.isSymbolicLink() || await realpath(evidencePath) !== evidencePath) {
        throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `公開証跡source実体が不正です: ${expectedPath}`);
      }
      const evidenceBytes = await readFile(evidencePath);
      if (hash(evidenceBytes) !== value.sha256) {
        throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `公開証跡source hashが一致しません: ${expectedPath}`);
      }
      result.push({
        source: expectedPath as WorkspaceRelativePath,
        publicPath: expectedPath as WorkspaceRelativePath,
        sha256: value.sha256 as Sha256,
        bytes: evidenceBytes.byteLength,
      });
    }
  }
  return Object.freeze(result);
}

function catalogFor(
  batches: readonly PublishableBatch[],
  f001: F001BaselineBundle,
  fragments: Readonly<Record<string, BatchCatalogFragment>>,
  publishedCatalogBatches: Readonly<Record<string, CatalogV2['batches'][number]>>,
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
  const catalogBatches: CatalogV2['batches'] = batches.map((batch) => {
    const pinned = publishedCatalogBatches[batch.manifest.batchId];
    if (pinned) {
      if (pinned.batchId !== batch.manifest.batchId || pinned.feature !== batch.manifest.feature ||
        pinned.authorId !== batch.manifest.author.authorId ||
        canonicalJson(pinned.workIds) !== canonicalJson(batch.manifest.workIds)) {
        throw new PublicIntegrationError(
          'PUBLIC_BASELINE_FAILED',
          `固定published catalog batchがmanifest identityと一致しません: ${batch.manifest.batchId}`,
        );
      }
      return pinned;
    }
    return {
      batchId: batch.manifest.batchId,
      feature: batch.manifest.feature,
      status: batch.manifest.status === 'published' ? 'published' : 'accepted',
      authorId: batch.manifest.author.authorId,
      workIds: [...batch.manifest.workIds],
      acceptedAt: batch.manifest.acceptedAt as string,
      ...(batch.manifest.publishedAt ? { publishedAt: batch.manifest.publishedAt } : {}),
      evidenceSha256: batch.manifestSha256,
    };
  });
  if (active) catalogBatches.push(active.catalogBatch);
  const mergedWorks = mergeCatalogWorksByAuthor(base.works, added);
  const catalog: CatalogV2 = {
    schemaVersion: '2.0.0',
    authors: mergedAuthors,
    works: mergedWorks,
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
  for (const author of catalog.authors) {
    if (authorIds.has(author.authorId)) throw new PublicIntegrationError('PUBLIC_AUTHOR_IDENTITY_CONFLICT', `author IDが重複しています: ${author.authorId}`);
    authorIds.add(author.authorId);
  }
  for (const work of catalog.works) {
    if (workIds.has(work.workId)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `work IDが重複しています: ${work.workId}`);
    if (!safeRelativePath(work.source.provenancePath)) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `provenancePathが不正です: ${work.workId}`);
    workIds.add(work.workId);
  }
  const audioByPath = new Map<string, CatalogV2['audioAssets'][number]>();
  for (const audio of catalog.audioAssets) {
    // audioId(createVoiceCacheKeyV2)はtext+config"入力"のhashであり出力音声
    // 自体のhashではないため、異なるbatch/authorが独立に生成した同一発話
    // (実例: F008/一人二役の「へええ」とF005の既存台詞)がaudioIdだけ
    // 偶然一致し、実際のWAV実体(sha256)は別セッション生成のため一致しない
    // ことがあり得る(実測確認済み)。path(batch scoped)は既にbatchIdで
    // 名前空間化され一意なため、path自体の衝突だけを実エラーとして拒否し、
    // audioId(入力hash)の一致は許容する。
    if (audioByPath.has(audio.path)) {
      throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `audio pathが重複しています: ${audio.path}`);
    }
    audioByPath.set(audio.path, audio);
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
  const normalizedCatalogs = Object.fromEntries(
    Object.entries(options.batchCatalogs ?? {}).map(([batchId, fragment]) => [batchId, normalizeBatchAudio(batchId, fragment)]),
  );
  const normalizedActiveCatalog = active ? normalizeBatchAudio(active.manifest.batchId, active.catalogFragment) : undefined;
  const effectiveActive = active && normalizedActiveCatalog
    ? { ...active, catalogFragment: normalizedActiveCatalog.fragment }
    : undefined;
  const fragments = Object.fromEntries(
    Object.entries(normalizedCatalogs).map(([batchId, value]) => [batchId, value.fragment]),
  );
  const evidenceByBatch = new Map<string, readonly ReferencedPublicEvidence[]>();
  for (const batch of batches) {
    const fragment = fragments[batch.manifest.batchId];
    if (fragment) evidenceByBatch.set(batch.manifest.batchId, await referencedPublicEvidence(workspace, batch.manifest.batchId, fragment));
  }
  if (effectiveActive) {
    evidenceByBatch.set(
      effectiveActive.manifest.batchId,
      await referencedPublicEvidence(workspace, effectiveActive.manifest.batchId, effectiveActive.catalogFragment),
    );
  }
  if ((await readdir(staging)).length !== 0) throw new PublicIntegrationError('PUBLIC_REPRODUCIBILITY_MISMATCH', 'stagingは空である必要があります');
  if (options.mode === 'work-preview' && (!effectiveActive || preparation || release)) throw new PublicIntegrationError('PUBLIC_UNAPPROVED_BATCH_INCLUDED', 'work-preview contextが不正です');
  if (options.mode === 'prepare-release' && (!preparation || effectiveActive || release)) throw new PublicIntegrationError('PUBLIC_RELEASE_CANDIDATE_MISSING', 'prepare contextが不正です');
  if (options.mode === 'release-verify' && (!release || effectiveActive || preparation || !options.trackedPublicRoot)) {
    throw new PublicIntegrationError('PUBLIC_RELEASE_CANDIDATE_MISSING', 'release contextが不正です');
  }
  let activePriorSources: PublishableBatch['acceptedAudioSources'] = [];
  if (effectiveActive) {
    const activeIndex = effectiveActive.manifest.workIds.indexOf(effectiveActive.workId as BatchManifest['workIds'][number]);
    if (activeIndex < 0 || effectiveActive.manifest.workProgress[activeIndex]?.status !== 'voiced' ||
      effectiveActive.manifest.workProgress.slice(0, activeIndex).some((work) => work.status !== 'accepted')) {
      throw new PublicIntegrationError('PUBLIC_BATCH_NOT_ACCEPTED', 'active workまたは先行accepted順序が不正です');
    }
    const expectedWorkIds = effectiveActive.manifest.workIds.slice(0, activeIndex + 1);
    if (canonicalJson(effectiveActive.catalogBatch.workIds) !== canonicalJson(expectedWorkIds) || effectiveActive.catalogBatch.status !== 'accepted' ||
      effectiveActive.catalogBatch.batchId !== effectiveActive.manifest.batchId || effectiveActive.catalogBatch.feature !== effectiveActive.manifest.feature ||
      effectiveActive.catalogBatch.authorId !== effectiveActive.manifest.author.authorId) {
      throw new PublicIntegrationError('PUBLIC_RELEASE_CANDIDATE_MISMATCH', 'active catalogBatchがmanifest累積範囲と一致しません');
    }
    const fragmentWorkIds = effectiveActive.catalogFragment.works.map((work) => work.workId);
    if (canonicalJson(fragmentWorkIds) !== canonicalJson(expectedWorkIds) ||
      effectiveActive.catalogFragment.works.some((work) => work.batchId !== effectiveActive.manifest.batchId || work.authorId !== effectiveActive.manifest.author.authorId)) {
      throw new PublicIntegrationError('PUBLIC_CROSS_AUTHOR_REFERENCE', 'active fragmentに後続・欠落・作者混線があります');
    }
    activePriorSources = effectiveActive.manifest.workProgress.slice(0, activeIndex)
      .flatMap((work) => work.acceptedAudioSources ?? []);
  }
  if (preparation || release) {
    const tracked = batches.flatMap((batch) => [
      batch.manifestPath,
      batch.manifest.artworkProvenanceRef,
      ...batch.acceptedAudioSources.map((source) => source.path),
      ...(fragments[batch.manifest.batchId]?.publicFiles ?? []).map((file) => file.source),
      ...(evidenceByBatch.get(batch.manifest.batchId) ?? []).map((file) => file.source),
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
    const fragment = fragments[batch.manifest.batchId];
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
    for (const file of evidenceByBatch.get(batch.manifest.batchId) ?? []) {
      if (destinations.has(file.publicPath)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `公開証跡pathが重複しています: ${file.publicPath}`);
      destinations.add(file.publicPath);
      await copyVerified(
        join(workspace, ...file.source.split('/')),
        join(staging, ...file.publicPath.split('/')),
        file.sha256,
        file.bytes,
      );
    }
    const expectedAudio = new Map(fragment.audioAssets.map((asset) => [asset.path, asset]));
    const remainingAudio = new Set(expectedAudio.keys());
    const aliases = normalizedCatalogs[batch.manifest.batchId]?.audioAliases ?? new Map<string, string>();
    const copiedAudio = new Set<string>();
    for (const source of batch.acceptedAudioSources) {
      const audioId = basename(source.path, '.wav');
      const canonicalAudioId = aliases.get(audioId) ?? audioId;
      const publicPath = `audio/${batch.manifest.batchId}/${canonicalAudioId}.wav`;
      const catalogAudio = expectedAudio.get(publicPath);
      const mismatches = !catalogAudio ? ['missing'] : [
        ...(catalogAudio.batchId !== batch.manifest.batchId ? ['batchId'] : []),
        ...(catalogAudio.sha256 !== source.sha256 ? ['sha256'] : []),
        ...(catalogAudio.bytes !== source.bytes ? ['bytes'] : []),
        ...(catalogAudio.configHash !== source.configHash ? ['configHash'] : []),
      ];
      if (mismatches.length > 0) {
        throw new PublicIntegrationError(
          'PUBLIC_REFERENCE_MISSING',
          `accepted audioとcatalog参照が一致しません: ${publicPath} (${mismatches.join(',')})`,
        );
      }
      if (!safeRelativePath(source.path)) throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_MISSING', 'accepted audio pathが不正です');
      const sourcePath = join(workspace, ...source.path.split('/'));
      await assertDescendant(workspace, sourcePath);
      if (copiedAudio.has(publicPath)) {
        const sourceInfo = await lstat(sourcePath);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== source.bytes ||
          hash(await readFile(sourcePath)) !== source.sha256) {
          throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_HASH_MISMATCH', `dedup sourceがmanifestと一致しません: ${source.path}`);
        }
        continue;
      }
      remainingAudio.delete(publicPath);
      if (destinations.has(publicPath)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `public pathが重複しています: ${publicPath}`);
      destinations.add(publicPath);
      copiedAudio.add(publicPath);
      await copyVerified(sourcePath, join(staging, ...publicPath.split('/')), source.sha256, source.bytes);
    }
    if (remainingAudio.size !== 0) throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_MISSING', `catalog音声にaccepted sourceがありません: ${batch.manifest.batchId}`);
  }
  if (effectiveActive && active && normalizedActiveCatalog) {
    const activeStageRoot = await verifiedRoot(effectiveActive.stagingRoot);
    await assertDescendant(workspace, activeStageRoot);
    const priorPublicPaths = new Set<string>();
    for (const source of activePriorSources) {
      const audioId = basename(source.path, '.wav');
      const canonicalAudioId = normalizedActiveCatalog.audioAliases.get(audioId) ?? audioId;
      const publicPath = `audio/${effectiveActive.manifest.batchId}/${canonicalAudioId}.wav`;
      const catalogAudio = effectiveActive.catalogFragment.audioAssets.find((asset) => asset.path === publicPath);
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
      ...effectiveActive.catalogFragment.audioAssets.filter((asset) => !priorPublicPaths.has(asset.path))
        .map((asset) => [asset.path, { sha256: asset.sha256, bytes: asset.bytes }] as const),
      ...(effectiveActive.catalogFragment.publicFiles ?? []).map((file) => [file.publicPath, { sha256: file.sha256, bytes: file.bytes }] as const),
    ]);
    const expectedFileCount = effectiveActive.catalogFragment.audioAssets.filter((asset) => !priorPublicPaths.has(asset.path)).length +
      (effectiveActive.catalogFragment.publicFiles?.length ?? 0);
    if (expectedFiles.size !== expectedFileCount) {
      throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', 'preview expected file集合に重複・欠損があります');
    }
    for (const file of active.stagedFiles) {
      const originalAudio = active.catalogFragment.audioAssets.find((asset) => asset.path === file.publicPath);
      const declaredPublic = active.catalogFragment.publicFiles?.find((item) => item.publicPath === file.publicPath);
      const canonicalAudioId = originalAudio
        ? normalizedActiveCatalog.audioAliases.get(originalAudio.audioId) ?? originalAudio.audioId
        : undefined;
      const targetPath = canonicalAudioId
        ? `audio/${effectiveActive.manifest.batchId}/${canonicalAudioId}.wav`
        : file.publicPath;
      if (!safeRelativePath(file.publicPath) || (!originalAudio && !declaredPublic) || !safeRelativePath(targetPath) || !isAbsolute(file.source)) {
        throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `preview pathが未参照・不正・重複です: ${file.publicPath}`);
      }
      const expected = expectedFiles.get(targetPath);
      if (!expected || expected.sha256 !== file.sha256 || expected.bytes !== file.bytes) {
        throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_HASH_MISMATCH', `preview metadataがcatalogと一致しません: ${file.publicPath}`);
      }
      if (!insidePath(activeStageRoot, resolve(file.source))) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', 'preview sourceがactive staging外です');
      await assertDescendant(workspace, resolve(file.source));
      if (destinations.has(targetPath)) {
        const sourceInfo = await lstat(file.source);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== file.bytes ||
          hash(await readFile(file.source)) !== file.sha256) {
          throw new PublicIntegrationError('PUBLIC_ACCEPTED_AUDIO_HASH_MISMATCH', `preview dedup sourceが不正です: ${file.publicPath}`);
        }
        continue;
      }
      expectedFiles.delete(targetPath);
      destinations.add(targetPath);
      await copyVerified(file.source, join(staging, ...targetPath.split('/')), file.sha256, file.bytes);
    }
    if (expectedFiles.size !== 0) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', 'preview expected fileが欠損しています');
    for (const file of evidenceByBatch.get(effectiveActive.manifest.batchId) ?? []) {
      if (destinations.has(file.publicPath)) throw new PublicIntegrationError('PUBLIC_ID_COLLISION', `公開証跡pathが重複しています: ${file.publicPath}`);
      destinations.add(file.publicPath);
      await copyVerified(
        join(workspace, ...file.source.split('/')),
        join(staging, ...file.publicPath.split('/')),
        file.sha256,
        file.bytes,
      );
    }
  }
  const catalog = catalogFor(batches, f001, fragments, options.publishedCatalogBatches ?? {}, effectiveActive);
  const catalogBytes = canonicalJson(catalog);
  const validation = validateCatalogV2(catalog, Buffer.byteLength(catalogBytes, 'utf8'));
  if (!validation.ok) throw new PublicIntegrationError('PUBLIC_REFERENCE_MISSING', `CatalogV2 validationに失敗しました: ${validation.error.code}`);
  await mkdir(join(staging, 'content'), { recursive: true });
  await integrateArtworkProvenances(catalog, batches, effectiveActive, f001, workspace, staging, destinations);
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

async function renameRetry(
  source: string,
  target: string,
  options: Pick<PublicPromotionOptions, 'rename' | 'delay'> = {},
): Promise<void> {
  const delays = [0, 100, 250, 500];
  const renameOperation = options.rename ?? rename;
  const delayOperation = options.delay ?? ((milliseconds: number) =>
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  let last: unknown;
  for (const delay of delays) {
    if (delay) await delayOperation(delay);
    try {
      await renameOperation(source, target);
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
      await renameRetry(publicRoot, backup, options);
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
      await renameRetry(stage, publicRoot, options);
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
        await renameRetry(backup, publicRoot, options);
        await syncDirectory(root);
        await rm(journalPath, { force: true });
        await syncDirectory(dirname(journalPath));
      } catch {
        throw new PublicIntegrationError('PUBLIC_ROLLBACK_FAILED', '旧publicを復元できません');
      }
    }
    if (error instanceof PublicIntegrationError) throw error;
    throw new PublicIntegrationError(
      'PUBLIC_PROMOTION_FAILED',
      error instanceof Error ? `public昇格に失敗しました: ${error.message}` : 'public昇格に失敗しました',
      { cause: error },
    );
  } finally {
    await lock.handle.close();
    const current = await readFile(lockPath, 'utf8').then((text) => JSON.parse(text) as PublicLockOwner).catch(() => undefined);
    if (current?.token === lock.owner.token) await rm(lockPath, { force: true });
    await syncDirectory(dirname(lockPath));
  }
}
