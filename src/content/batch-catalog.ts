import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from './artifacts.ts';
import type {
  BatchId,
  BatchManifest,
  Sha256,
  WorkspaceRelativePath,
} from './batch.ts';
import {
  hashBatchManifest,
  loadAcceptedBatches,
  validateBatchManifest,
} from './batch.ts';
import {
  BATCH_DEFINITION_REFS,
  isMintedVerifiedBatchDefinition,
  type BatchCandidateRegistryWork,
  type VerifiedBatchDefinition,
} from './batch-candidate.ts';
import {
  isMintedPublishedV030Baseline,
  type PublishedV030Baseline,
} from './f004-baseline.ts';
import {
  isMintedPublishedBaselineBundle,
  type PublishedBaselineBundle,
} from './published-baseline.ts';
import { WORK_NOTICE_TEXT } from '../notices/work-notice-text.ts';
import { AudioController } from '../ui/audio-controller.ts';
import type { AudioPort } from '../ui/types.ts';
import {
  buildIntegratedPublicTree,
  type ActiveBatchPreview,
  type BatchCatalogFragment as PublicBatchCatalogFragment,
} from './batch-public.ts';
import { buildPagesPreview } from './pages-preview.ts';
import { loadAndVerifyF001Baseline } from './baseline.ts';
import {
  isKnownPublishedCatalogBatchId,
  loadAcceptedF003CatalogFragment,
  loadKnownPublishedCatalogFragment,
  loadPublishedF002CatalogFragment,
} from './f003-catalog.ts';
import type {
  CatalogAudioAssetV2,
  CatalogCandidateCountV2,
  CatalogV2,
  CatalogWorkV2,
} from './processing.ts';

declare const previewFragmentType: unique symbol;
declare const finalFragmentType: unique symbol;
declare const previewCatalogType: unique symbol;
declare const finalCatalogType: unique symbol;
declare const includedWorkType: unique symbol;

const SAFE_RELATIVE_PATH =
  /^(?!\/)(?!.*\\)(?!.*(?:^|\/)(?:\.{1,2})(?:\/|$))(?![A-Za-z][A-Za-z0-9+.-]*:)[A-Za-z0-9._/-]+$/u;

export class BatchCatalogError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BatchCatalogError';
  }
}

export interface IncludedBatchWork {
  readonly __brand: 'VerifiedIncludedBatchWork';
  readonly [includedWorkType]: true;
  readonly lifecycle: 'accepted' | 'staged';
  readonly work: CatalogWorkV2;
  readonly audioAssets: readonly CatalogAudioAssetV2[];
  readonly candidateCounts: CatalogCandidateCountV2;
  readonly artifactRef: string;
  readonly artifactSha256: Sha256;
  readonly manifestSha256: Sha256;
  readonly workspaceRoot: string;
}

interface CatalogFragmentCore {
  readonly batchId: string;
  readonly feature: string;
  readonly authorContribution: 'introduce' | 'reuse';
  readonly authors: CatalogV2['authors'];
  readonly works: readonly CatalogWorkV2[];
  readonly audioAssets: readonly CatalogAudioAssetV2[];
  readonly candidateCounts: CatalogCandidateCountV2;
  readonly digest: Sha256;
}

export interface WorkPreviewCatalogFragment extends CatalogFragmentCore {
  readonly __brand: 'WorkPreviewCatalogFragment';
  readonly mode: 'work-preview';
  readonly [previewFragmentType]: true;
}

export interface FinalCatalogFragment extends CatalogFragmentCore {
  readonly __brand: 'FinalCatalogFragment';
  readonly mode: 'final';
  readonly [finalFragmentType]: true;
}

export type BatchCatalogFragment = WorkPreviewCatalogFragment | FinalCatalogFragment;

export interface WorkPreviewCatalog extends CatalogV2 {
  readonly __brand: 'WorkPreviewCatalog';
  readonly mode: 'work-preview';
  readonly [previewCatalogType]: true;
}

export interface FinalCatalog extends CatalogV2 {
  readonly __brand: 'FinalCatalog';
  readonly mode: 'final';
  readonly [finalCatalogType]: true;
}

export interface ArtworkReport {
  readonly result: 'pass';
  readonly authorId: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly newEntries: 0;
}

export interface RuntimeContentReport {
  readonly result: 'pass';
  readonly workCount: number;
  readonly noticeCount: number;
  readonly initialOpenPanels: 0;
  readonly audio: Readonly<{
    readonly simultaneousMaximum: 1;
    readonly routeCleanup: true;
    readonly staleEventsIgnored: true;
    readonly isolatedFailure: true;
  }>;
}

export interface RuntimeAudioProbe {
  readonly __brand: 'RuntimeAudioProbe';
  readonly catalogDigest: Sha256;
  readonly definitionSha256: Sha256;
  readonly simultaneousMaximum: 1;
  readonly routeCleanup: true;
  readonly staleEventsIgnored: true;
  readonly isolatedFailure: true;
}

export interface BatchWorkPreview {
  readonly __brand: 'BatchWorkPreview';
  readonly fragment: WorkPreviewCatalogFragment;
  readonly catalog: WorkPreviewCatalog;
  readonly previewTreeSha256: Sha256;
  readonly publicProjectionSha256: Sha256;
  readonly distSha256: Sha256;
  readonly stagingRoot: string;
  readonly distRoot: string;
  readonly baselineInvariant: Readonly<{
    readonly result: 'pass';
    readonly beforeSha256: Sha256;
    readonly afterSha256: Sha256;
  }>;
}

const previewFragments = new WeakSet<object>();
const finalFragments = new WeakSet<object>();
const previewCatalogs = new WeakSet<object>();
const finalCatalogs = new WeakSet<object>();
const includedBatchWorks = new WeakSet<object>();
const verifiedAuthorIntroductions = new WeakSet<object>();
const publishedVerifiedDefinitions = new WeakSet<object>();
const runtimeAudioProbes = new WeakSet<object>();

function isGenericVerifiedDefinition(value: unknown): value is VerifiedBatchDefinition {
  return isMintedVerifiedBatchDefinition(value) ||
    (value !== null && typeof value === 'object' && publishedVerifiedDefinitions.has(value));
}

export type VerifiedCatalogBaseline = PublishedV030Baseline | PublishedBaselineBundle;

export interface VerifiedAuthorIntroduction {
  readonly __brand: 'VerifiedAuthorIntroduction';
  readonly author: CatalogV2['authors'][number];
  readonly provenanceRef: string;
  readonly provenanceSha256: Sha256;
  readonly credit: string;
}

function baselineCatalog(value: VerifiedCatalogBaseline): CatalogV2 {
  if (isMintedPublishedV030Baseline(value) || isMintedPublishedBaselineBundle(value)) {
    return value.catalog;
  }
  throw new BatchCatalogError('BATCH_BASELINE_INVALID', 'mint済みbaselineではありません');
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function hash(value: unknown): Sha256 {
  return createHash('sha256').update(canonicalJson(value)).digest('hex') as Sha256;
}

function authorMatches(
  definition: VerifiedBatchDefinition,
  baseline: VerifiedCatalogBaseline,
): CatalogV2['authors'] {
  return baselineCatalog(baseline).authors.filter(
    (author) => author.authorId === definition.author.authorId,
  );
}

function exactJoinedAuthor(definition: VerifiedBatchDefinition, author: CatalogV2['authors'][number]): boolean {
  return canonicalJson({
      authorId: author.authorId,
      identitySha256: author.identitySha256,
      name: author.name,
      originalName: author.originalName,
      slug: author.slug,
    }) === canonicalJson(definition.author);
}

function safeWorkPaths(work: CatalogWorkV2): boolean {
  return SAFE_RELATIVE_PATH.test(work.source.provenancePath) &&
    work.dialogues.every((dialogue) => dialogue.workId === work.workId);
}

function sumCounts(values: readonly CatalogCandidateCountV2[]): CatalogCandidateCountV2 {
  const sum = (key: keyof CatalogCandidateCountV2): number =>
    values.reduce((total, value) => total + (typeof value[key] === 'number' ? value[key] : 0), 0);
  const mergeReasons = (key: 'editorialReasons' | 'audioFailureReasons'): Record<string, number> => {
    const output: Record<string, number> = {};
    for (const value of values) {
      for (const [reason, count] of Object.entries(value[key] ?? {})) {
        output[reason] = (output[reason] ?? 0) + count;
      }
    }
    return output;
  };
  return {
    total: sum('total'),
    published: sum('published'),
    editorialExcluded: sum('editorialExcluded'),
    audioExcluded: sum('audioExcluded'),
    editorialReasons: mergeReasons('editorialReasons'),
    audioFailureReasons: mergeReasons('audioFailureReasons'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

async function verifiedFile(workspace: string, path: string): Promise<string> {
  if (!isAbsolute(workspace) || !SAFE_RELATIVE_PATH.test(path)) {
    throw new BatchCatalogError('BATCH_WORKSPACE_BOUNDARY', 'workspace相対pathが不正です');
  }
  const root = resolve(workspace);
  const target = join(root, ...path.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new BatchCatalogError('BATCH_WORKSPACE_BOUNDARY', 'workspace外pathです');
  }
  let cursor = root;
  for (const component of relation.split(sep)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new BatchCatalogError('BATCH_WORKSPACE_BOUNDARY', 'reparse pathです');
  }
  const info = await lstat(target);
  if (!info.isFile() || await realpath(target) !== target) {
    throw new BatchCatalogError('BATCH_WORKSPACE_BOUNDARY', 'canonical fileではありません');
  }
  return target;
}

function parseJson(raw: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch (error) {
    throw new BatchCatalogError('BATCH_ARTIFACT_INVALID', `${label} JSONが不正です: ${String(error)}`);
  }
}

/**
 * canonical source-index/fixed sourceとmanifest hash chainへ結合したworkだけをmintする。
 * @des DES-F004-007 @des DES-F004-011 @fun FUN-F004-021 @fun FUN-F004-037 @ut UT-F004-021
 */
export async function loadVerifiedIncludedBatchWork(
  workspace: string,
  definition: VerifiedBatchDefinition,
  manifest: BatchManifest,
  expectedManifestSha: Sha256,
  artifactRef: string,
  expectedArtifactSha: Sha256,
): Promise<IncludedBatchWork> {
  const validatedManifest = validateBatchManifest(manifest);
  if (!isGenericVerifiedDefinition(definition) || !validatedManifest.ok ||
    hashBatchManifest(validatedManifest.value) !== expectedManifestSha ||
    hash(manifest) !== expectedManifestSha ||
    validatedManifest.value.batchId !== definition.batchId ||
    !SAFE_RELATIVE_PATH.test(artifactRef)) {
    throw new BatchCatalogError('BATCH_ARTIFACT_INVALID', 'definition/manifest/artifact refが不正です');
  }
  const canonicalManifest = validatedManifest.value;
  const artifactRaw = await readFile(await verifiedFile(workspace, artifactRef));
  if (hashBytes(artifactRaw) !== expectedArtifactSha) {
    throw new BatchCatalogError('BATCH_ARTIFACT_INVALID', 'artifact SHAが一致しません');
  }
  const artifact = parseJson(artifactRaw, 'included work');
  if (!isRecord(artifact) ||
    !exactKeys(artifact, [
      'schemaVersion', 'batchId', 'workId', 'lifecycle', 'work',
      'audioAssets', 'candidateCounts',
    ]) || artifact.schemaVersion !== '1.0.0' ||
    !Array.isArray(artifact.audioAssets) || !isRecord(artifact.candidateCounts) ||
    !isRecord(artifact.work) || typeof artifact.workId !== 'string' ||
    (artifact.lifecycle !== 'accepted' && artifact.lifecycle !== 'staged') ||
    artifact.batchId !== definition.batchId || artifact.work.workId !== artifact.workId) {
    throw new BatchCatalogError('BATCH_ARTIFACT_INVALID', 'included work schemaが不正です');
  }
  const workIndex = definition.workIds.indexOf(artifact.workId);
  const expectedWork = definition.works[workIndex];
  const progress = canonicalManifest.workProgress[workIndex];
  if (workIndex < 0 || !expectedWork || !progress ||
    !progress.stageRecords.some((record) => record.outputHashes.includes(expectedArtifactSha)) ||
    (artifact.lifecycle === 'accepted' ? progress.status !== 'accepted' : progress.status === 'accepted')) {
    throw new BatchCatalogError('BATCH_ARTIFACT_INVALID', 'manifest hash chain/stateと一致しません');
  }
  const sourceIndexPath = `content/batches/${definition.batchId}/source-index.json`;
  const sourceIndexRaw = await readFile(await verifiedFile(workspace, sourceIndexPath));
  const sourceIndex = parseJson(sourceIndexRaw, 'source index');
  const sourceIndexRecord = isRecord(sourceIndex) ? sourceIndex : null;
  const sourceEntry = sourceIndexRecord && Array.isArray(sourceIndexRecord.works)
    ? sourceIndexRecord.works.find((entry) => isRecord(entry) && entry.workId === artifact.workId)
    : undefined;
  if (!sourceIndexRecord ||
    !exactKeys(sourceIndexRecord, ['batchId', 'bodySelector', 'rightsRef', 'schemaVersion', 'works']) ||
    sourceIndexRecord.batchId !== definition.batchId ||
    sourceIndexRecord.schemaVersion !== '1.0.0' ||
    !Array.isArray(sourceIndexRecord.works) ||
    !isRecord(sourceEntry) ||
    !exactKeys(sourceEntry, [
      'baseEdition', 'bibliographyCharset', 'cardUrl', 'fetchedAt', 'inputter',
      'proofreader', 'rawBytes', 'rawPath', 'rawSha256', 'recordPath',
      'sourceUpdatedAt', 'sourceUrl', 'title', 'workId',
    ]) ||
    sourceEntry.title !== expectedWork.title ||
    sourceEntry.cardUrl !== expectedWork.cardUrl || sourceEntry.sourceUrl !== expectedWork.xhtmlUrl ||
    typeof sourceEntry.rawPath !== 'string' || typeof sourceEntry.recordPath !== 'string' ||
    typeof sourceEntry.rawSha256 !== 'string' || typeof sourceEntry.rawBytes !== 'number' ||
    typeof sourceEntry.baseEdition !== 'string' ||
    typeof sourceEntry.bibliographyCharset !== 'string' ||
    typeof sourceEntry.fetchedAt !== 'string' ||
    typeof sourceEntry.inputter !== 'string' ||
    typeof sourceEntry.proofreader !== 'string' ||
    typeof sourceEntry.sourceUpdatedAt !== 'string' ||
    sourceIndexRecord?.bodySelector !== '.main_text') {
    throw new BatchCatalogError('BATCH_ARTIFACT_INVALID', 'Approved definitionとsource indexが一致しません');
  }
  const rawBytes = await readFile(await verifiedFile(workspace, sourceEntry.rawPath));
  const recordBytes = await readFile(await verifiedFile(workspace, sourceEntry.recordPath));
  const record = parseJson(recordBytes, 'source record');
  const provenancePath =
    `data/batches/${definition.batchId}/fixed-sources/${artifact.workId}/${artifact.workId}/provenance.json`;
  const provenanceBytes = await readFile(await verifiedFile(workspace, provenancePath));
  const provenance = parseJson(provenanceBytes, 'source provenance');
  const work = artifact.work as unknown as CatalogWorkV2;
  const assets = artifact.audioAssets as unknown as CatalogAudioAssetV2[];
  const counts = artifact.candidateCounts as unknown as CatalogCandidateCountV2;
  const audioFiles = await Promise.all(assets.map(async (asset) => {
    if (!SAFE_RELATIVE_PATH.test(asset.path)) {
      throw new BatchCatalogError('BATCH_ARTIFACT_INVALID', 'audio pathが不正です');
    }
    const bytes = await readFile(await verifiedFile(workspace, `public/${asset.path}`));
    return { asset, bytes, durationMs: wavDurationMs(bytes) };
  }));
  const canonicalSourceSha256 = hash({
    work: sourceEntry,
    record,
    bodySelector: sourceIndexRecord.bodySelector,
  });
  if (!isRecord(record) ||
    !exactKeys(record, [
      'bibliographyCharset', 'fetchedAt', 'httpCharset', 'mediaType',
      'rawPath', 'rawSha256', 'sourceUrl', 'workId',
    ]) ||
    record.workId !== artifact.workId ||
    record.sourceUrl !== expectedWork.xhtmlUrl || record.rawSha256 !== sourceEntry.rawSha256 ||
    record.bibliographyCharset !== sourceEntry.bibliographyCharset ||
    record.fetchedAt !== sourceEntry.fetchedAt ||
    record.mediaType !== 'text/html' ||
    !isRecord(provenance) ||
    !exactKeys(provenance, [
      'baseEdition', 'bibliography', 'changeNotice', 'fetchedAt', 'inputter',
      'proofreader', 'sourceSha256', 'sourceUrl', 'stableCardUrl', 'toolVersion',
      'transformation', 'workId',
    ]) ||
    provenance.workId !== artifact.workId ||
    provenance.stableCardUrl !== expectedWork.cardUrl ||
    provenance.sourceUrl !== expectedWork.xhtmlUrl ||
    provenance.sourceSha256 !== sourceEntry.rawSha256 ||
    provenance.baseEdition !== sourceEntry.baseEdition ||
    provenance.inputter !== sourceEntry.inputter ||
    provenance.proofreader !== sourceEntry.proofreader ||
    provenance.fetchedAt !== sourceEntry.fetchedAt ||
    typeof provenance.transformation !== 'string' ||
    hashBytes(rawBytes) !== sourceEntry.rawSha256 || rawBytes.byteLength !== sourceEntry.rawBytes ||
    work.title !== expectedWork.title || work.cardLink !== expectedWork.cardUrl ||
    work.authorId !== definition.author.authorId || work.batchId !== definition.batchId ||
    work.source.cardUrl !== expectedWork.cardUrl || work.source.textUrl !== expectedWork.xhtmlUrl ||
    work.source.attribution !== '青空文庫' ||
    work.source.baseEdition !== sourceEntry.baseEdition ||
    work.source.inputter !== sourceEntry.inputter ||
    work.source.proofreader !== sourceEntry.proofreader ||
    work.source.fetchedAt !== sourceEntry.fetchedAt ||
    work.source.transformation !== provenance.transformation ||
    work.source.sourceSha256 !== sourceEntry.rawSha256 ||
    work.source.provenancePath !== provenancePath ||
    work.source.provenanceSha256 !== hashBytes(provenanceBytes) ||
    work.source.bibliographyCharset !== sourceEntry.bibliographyCharset ||
    work.source.bodySelector !== sourceIndexRecord.bodySelector ||
    work.source.rawBytes !== sourceEntry.rawBytes ||
    work.source.rawSha256 !== sourceEntry.rawSha256 ||
    work.source.canonicalSourceSha256 !== canonicalSourceSha256 ||
    work.source.sourceUpdatedAt !== sourceEntry.sourceUpdatedAt ||
    work.dialogues.length === 0 || assets.length === 0 ||
    assets.some((asset) => asset.batchId !== definition.batchId ||
      !SAFE_RELATIVE_PATH.test(asset.path) ||
      typeof asset.audioId !== 'string' || typeof asset.sha256 !== 'string' ||
      typeof asset.configHash !== 'string' ||
      !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 ||
      !Number.isFinite(asset.durationMs) || asset.durationMs <= 0 ||
      !Array.isArray(asset.candidateIds)) ||
    audioFiles.some(({ asset, bytes, durationMs }) =>
      hashBytes(bytes) !== asset.sha256 || bytes.byteLength !== asset.bytes ||
      durationMs !== asset.durationMs) ||
    work.dialogues.some((dialogue) => dialogue.workId !== artifact.workId ||
      dialogue.review.candidateId !== dialogue.dialogueId ||
      dialogue.review.workId !== artifact.workId ||
      !assets.some((asset) => asset.audioId === dialogue.audioId &&
        asset.candidateIds?.includes(dialogue.dialogueId))) ||
    assets.some((asset) =>
      asset.candidateIds?.some((candidateId) =>
        !work.dialogues.some((dialogue) =>
          dialogue.dialogueId === candidateId && dialogue.audioId === asset.audioId))) ||
    (artifact.lifecycle === 'accepted' && assets.some((asset) =>
      !progress.acceptedAudioSources?.some((source) =>
        source.sha256 === asset.sha256 && source.bytes === asset.bytes &&
        source.configHash === asset.configHash))) ||
    counts.total !== counts.published + counts.editorialExcluded + counts.audioExcluded) {
    throw new BatchCatalogError('BATCH_ARTIFACT_INVALID', 'canonical source/artifact参照が一致しません');
  }
  const verified = freezeDeep({
    __brand: 'VerifiedIncludedBatchWork' as const,
    lifecycle: artifact.lifecycle,
    work: structuredClone(work),
    audioAssets: structuredClone(assets),
    candidateCounts: structuredClone(counts),
    artifactRef,
    artifactSha256: expectedArtifactSha,
    manifestSha256: expectedManifestSha,
    workspaceRoot: resolve(workspace),
  }) as unknown as IncludedBatchWork;
  includedBatchWorks.add(verified);
  return verified;
}

function hashBytes(value: Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number): string =>
    new TextDecoder('ascii').decode(bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return null;
  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + size > bytes.byteLength) return null;
    if (id === 'fmt ' && size >= 16) byteRate = view.getUint32(dataOffset + 8, true);
    if (id === 'data') dataBytes = size;
    offset = dataOffset + size + (size % 2);
  }
  return byteRate && dataBytes !== null
    ? Math.round((dataBytes / byteRate) * 1000)
    : null;
}

/**
 * trusted later releaseの作者画像/provenanceをcanonical fileへ逆照合してintroduce tupleをmintする。
 * @des DES-F004-007 @des DES-F004-011 @fun FUN-F004-021 @ut UT-F004-021
 */
export async function loadVerifiedAuthorIntroduction(
  workspace: string,
  definition: VerifiedBatchDefinition,
  trustedSource: PublishedV030Baseline,
): Promise<VerifiedAuthorIntroduction> {
  if (!isGenericVerifiedDefinition(definition) ||
    !isMintedPublishedV030Baseline(trustedSource) ||
    definition.authorExpectation !== 'introduce') {
    throw new BatchCatalogError('BATCH_AUTHOR_IDENTITY_CONFLICT', 'introduce loader入力が不正です');
  }
  const matches = trustedSource.catalog.authors.filter(
    (author) => author.authorId === definition.author.authorId,
  );
  const author = matches[0];
  if (matches.length !== 1 || !author || !exactJoinedAuthor(definition, author) ||
    author.introducedByBatchId !== definition.batchId) {
    throw new BatchCatalogError('BATCH_AUTHOR_IDENTITY_CONFLICT', 'introduce作者identityが不正です');
  }
  const provenanceRef = `content/artwork-provenance/${definition.batchId}.json`;
  const provenanceFile = trustedSource.publicFiles.find((file) => file.path === provenanceRef);
  const artworkFile = trustedSource.publicFiles.find((file) => file.path === author.artwork.path);
  const registryEntries = trustedSource.artworkRegistry.filter(
    (entry) => entry.authorId === author.authorId,
  );
  const registryEntry = registryEntries[0];
  if (!provenanceFile || !artworkFile || registryEntries.length !== 1 || !registryEntry ||
    registryEntry.batchId !== definition.batchId ||
    registryEntry.provenanceRef !== provenanceRef ||
    registryEntry.output.path !== author.artwork.path ||
    registryEntry.output.sha256 !== author.artwork.sha256) {
    throw new BatchCatalogError('BATCH_ARTWORK_REUSE_MISMATCH', 'introduce assetがtrusted treeにありません');
  }
  const provenanceBytes = await readFile(await verifiedFile(workspace, `public/${provenanceRef}`));
  const artworkBytes = await readFile(await verifiedFile(workspace, `public/${author.artwork.path}`));
  const provenance = parseJson(provenanceBytes, 'author introduction provenance');
  if (!isRecord(provenance) || provenance.authorId !== author.authorId ||
    provenance.batchId !== definition.batchId || !isRecord(provenance.output) ||
    provenance.output.path !== author.artwork.path ||
    provenance.output.sha256 !== author.artwork.sha256 ||
    typeof provenance.credit !== 'string' ||
    hashBytes(provenanceBytes) !== registryEntry.provenanceSha256 ||
    provenanceBytes.byteLength !== provenanceFile.bytes ||
    hashBytes(artworkBytes) !== author.artwork.sha256 ||
    artworkBytes.byteLength !== artworkFile.bytes) {
    throw new BatchCatalogError('BATCH_ARTWORK_REUSE_MISMATCH', 'introduce asset tupleが不正です');
  }
  const verified = freezeDeep({
    __brand: 'VerifiedAuthorIntroduction' as const,
    author: structuredClone(author),
    provenanceRef,
    provenanceSha256: registryEntry.provenanceSha256 as Sha256,
    credit: provenance.credit,
  });
  verifiedAuthorIntroductions.add(verified);
  return verified;
}

/** 公開済みCatalog/batchをproofとして回帰用definitionをmintする。 */
export async function loadPublishedVerifiedBatchDefinition(
  workspace: string,
  definitionRef: string,
  expectedSha256: Sha256,
  published: PublishedV030Baseline,
): Promise<VerifiedBatchDefinition> {
  if (!isMintedPublishedV030Baseline(published) ||
    !Object.values(BATCH_DEFINITION_REFS).some((entry) =>
      entry.ref === definitionRef && entry.sha256 === expectedSha256)) {
    throw new BatchCatalogError('BATCH_BASELINE_INVALID', 'published definition refが不正です');
  }
  const raw = await readFile(await verifiedFile(workspace, definitionRef));
  const value = parseJson(raw, 'published batch definition');
  if (hashBytes(raw) !== expectedSha256 || !isRecord(value) ||
    !exactKeys(value, [
      'authorExpectation', 'batchId', 'candidateRegistryPath',
      'feature', 'schemaVersion', 'works',
    ]) || value.schemaVersion !== '1.0.0' ||
    typeof value.batchId !== 'string' || value.feature !== value.batchId ||
    value.candidateRegistryPath !== 'content/batch-candidates.json' ||
    value.authorExpectation !== 'introduce' || !Array.isArray(value.works) ||
    value.works.length !== 3 ||
    value.works.some((work, index) =>
      !isRecord(work) ||
      !exactKeys(work, ['cardUrl', 'order', 'title', 'workId', 'xhtmlUrl']) ||
      typeof work.cardUrl !== 'string' || typeof work.title !== 'string' ||
      typeof work.workId !== 'string' || typeof work.xhtmlUrl !== 'string' ||
      work.order !== index + 1)) {
    throw new BatchCatalogError('BATCH_BASELINE_INVALID', 'published definitionが不正です');
  }
  const batches = published.catalog.batches.filter((batch) => batch.batchId === value.batchId);
  const author = batches.length === 1
    ? published.catalog.authors.find((entry) => entry.authorId === batches[0]!.authorId)
    : undefined;
  if (!author || author.introducedByBatchId !== value.batchId ||
    canonicalJson(batches[0]!.workIds) !==
      canonicalJson(value.works.map((work) => isRecord(work) ? work.workId : null))) {
    throw new BatchCatalogError('BATCH_BASELINE_INVALID', 'published Catalog proofが一致しません');
  }
  const definition = freezeDeep({
    __brand: 'VerifiedBatchDefinition' as const,
    ref: definitionRef as WorkspaceRelativePath,
    sha256: expectedSha256,
    batchId: value.batchId as BatchId,
    feature: value.feature as BatchId,
    candidateRegistryPath: 'content/batch-candidates.json' as const,
    author: {
      authorId: author.authorId,
      identitySha256: author.identitySha256,
      name: author.name,
      originalName: author.originalName,
      slug: author.slug,
    },
    workIds: value.works.map((work) => (work as BatchCandidateRegistryWork).workId),
    works: structuredClone(value.works) as BatchCandidateRegistryWork[],
    authorExpectation: 'introduce' as const,
  }) as unknown as VerifiedBatchDefinition;
  publishedVerifiedDefinitions.add(definition);
  return definition;
}

/**
 * verified definitionとbaseline joinからreuseを導出し、mode別fragmentをmintする。
 * @des DES-F004-007 @des DES-F004-011 @fun FUN-F004-021 @ut UT-F004-021
 */
export function projectBatchCatalogFragment(
  definition: VerifiedBatchDefinition,
  manifest: BatchManifest,
  includedWorks: readonly IncludedBatchWork[],
  baseline: VerifiedCatalogBaseline,
  mode: 'work-preview',
  introduction?: VerifiedAuthorIntroduction,
): WorkPreviewCatalogFragment;
export function projectBatchCatalogFragment(
  definition: VerifiedBatchDefinition,
  manifest: BatchManifest,
  includedWorks: readonly IncludedBatchWork[],
  baseline: VerifiedCatalogBaseline,
  mode: 'final',
  introduction?: VerifiedAuthorIntroduction,
): FinalCatalogFragment;
export function projectBatchCatalogFragment(
  definition: VerifiedBatchDefinition,
  manifest: BatchManifest,
  includedWorks: readonly IncludedBatchWork[],
  baseline: VerifiedCatalogBaseline,
  mode: 'work-preview' | 'final',
  introduction?: VerifiedAuthorIntroduction,
): BatchCatalogFragment {
  baselineCatalog(baseline);
  const validatedManifest = validateBatchManifest(manifest);
  const manifestSha = validatedManifest.ok ? hashBatchManifest(validatedManifest.value) : null;
  if (!isGenericVerifiedDefinition(definition) || !validatedManifest.ok ||
    manifestSha !== hash(manifest) ||
    manifest.batchId !== definition.batchId || manifest.feature !== definition.feature ||
    canonicalJson(manifest.workIds) !== canonicalJson(definition.workIds) ||
    includedWorks.some((entry) => entry.manifestSha256 !== manifestSha) ||
    includedWorks.length === 0 || includedWorks.length > definition.workIds.length) {
    throw new BatchCatalogError('BATCH_AUTHOR_IDENTITY_CONFLICT', 'definition/manifest/baseline joinが不正です');
  }
  const matches = authorMatches(definition, baseline);
  let authorContribution: 'introduce' | 'reuse';
  let authors: CatalogV2['authors'];
  if (matches.length === 0) {
    if (definition.authorExpectation !== 'introduce' || !introduction ||
      !verifiedAuthorIntroductions.has(introduction) ||
      !exactJoinedAuthor(definition, introduction.author)) {
      throw new BatchCatalogError('BATCH_AUTHOR_IDENTITY_CONFLICT', 'introduce tupleが不正です');
    }
    authorContribution = 'introduce';
    authors = [structuredClone(introduction.author)];
  } else if (matches.length === 1 && matches[0] &&
    exactJoinedAuthor(definition, matches[0]) &&
    definition.authorExpectation === 'reuse' && introduction === undefined) {
    authorContribution = 'reuse';
    authors = [];
  } else {
    throw new BatchCatalogError('BATCH_AUTHOR_IDENTITY_CONFLICT', 'author join/expectationが不正です');
  }
  if (includedWorks.some((entry) => !includedBatchWorks.has(entry))) {
    throw new BatchCatalogError('BATCH_ARTIFACT_INVALID', 'mint済みincluded workではありません');
  }
  const expectedPrefix = definition.workIds.slice(0, includedWorks.length);
  if (canonicalJson(includedWorks.map((entry) => entry.work.workId)) !== canonicalJson(expectedPrefix) ||
    includedWorks.some((entry) =>
      entry.work.authorId !== definition.author.authorId ||
      entry.work.batchId !== definition.batchId ||
      !safeWorkPaths(entry.work) ||
      entry.audioAssets.some((asset) =>
        asset.batchId !== definition.batchId || !SAFE_RELATIVE_PATH.test(asset.path)))) {
    throw new BatchCatalogError('BATCH_CATALOG_FRAGMENT_INVALID', 'work順・作者・pathが不正です');
  }
  const dialogueIds = includedWorks.flatMap((entry) =>
    entry.work.dialogues.map((dialogue) => dialogue.dialogueId));
  const audioIds = includedWorks.flatMap((entry) =>
    entry.audioAssets.map((asset) => asset.audioId));
  const audioPaths = includedWorks.flatMap((entry) =>
    entry.audioAssets.map((asset) => asset.path));
  const artifactRefs = includedWorks.map((entry) => entry.artifactRef);
  if (new Set(dialogueIds).size !== dialogueIds.length ||
    new Set(audioIds).size !== audioIds.length ||
    new Set(audioPaths).size !== audioPaths.length ||
    new Set(artifactRefs).size !== artifactRefs.length) {
    throw new BatchCatalogError('BATCH_CATALOG_ID_CONFLICT', 'fragment内IDが重複しています');
  }
  if (mode === 'work-preview') {
    const staged = includedWorks.filter((entry) => entry.lifecycle === 'staged');
    if (staged.length !== 1 || includedWorks.at(-1)?.lifecycle !== 'staged' ||
      includedWorks.slice(0, -1).some((entry) => entry.lifecycle !== 'accepted') ||
      manifest.workProgress.slice(0, includedWorks.length - 1)
        .some((entry) => entry.status !== 'accepted') ||
      manifest.workProgress[includedWorks.length - 1]?.status === 'accepted' ||
      manifest.workProgress.slice(includedWorks.length).some((entry) => entry.status !== 'pending')) {
      throw new BatchCatalogError('BATCH_PREVIEW_STATE_INVALID', 'previewは先行accepted＋staged 1件が必要です');
    }
  } else if (includedWorks.length !== definition.workIds.length ||
    includedWorks.some((entry) => entry.lifecycle !== 'accepted') ||
    manifest.workProgress.some((entry) => entry.status !== 'accepted')) {
    throw new BatchCatalogError('BATCH_FINAL_STATE_INVALID', 'finalは全work acceptedが必要です');
  }
  const core = {
    batchId: definition.batchId,
    feature: definition.feature,
    authorContribution,
    authors,
    works: includedWorks.map((entry) => structuredClone(entry.work)),
    audioAssets: includedWorks.flatMap((entry) => structuredClone(entry.audioAssets)),
    candidateCounts: sumCounts(includedWorks.map((entry) => entry.candidateCounts)),
  };
  const fragment = freezeDeep({
    ...core,
    __brand: mode === 'work-preview'
      ? 'WorkPreviewCatalogFragment' as const
      : 'FinalCatalogFragment' as const,
    mode,
    digest: hash(core),
  }) as unknown as BatchCatalogFragment;
  (mode === 'work-preview' ? previewFragments : finalFragments).add(fragment);
  return fragment;
}

function assertMintedFragment(fragment: BatchCatalogFragment): void {
  const valid = fragment.mode === 'work-preview'
    ? previewFragments.has(fragment)
    : finalFragments.has(fragment);
  const core = {
    batchId: fragment.batchId,
    feature: fragment.feature,
    authorContribution: fragment.authorContribution,
    authors: fragment.authors,
    works: fragment.works,
    audioAssets: fragment.audioAssets,
    candidateCounts: fragment.candidateCounts,
  };
  if (!valid || fragment.digest !== hash(core)) {
    throw new BatchCatalogError('BATCH_CATALOG_FRAGMENT_FORGED', 'mintされていないfragmentです');
  }
}

function mergedCatalog(
  baseline: VerifiedCatalogBaseline,
  fragment: BatchCatalogFragment,
  mode: 'work-preview' | 'final',
): WorkPreviewCatalog | FinalCatalog {
  assertMintedFragment(fragment);
  if (fragment.mode !== mode) {
    throw new BatchCatalogError('BATCH_CATALOG_FRAGMENT_INVALID', 'fragment modeが不正です');
  }
  const sourceCatalog = baselineCatalog(baseline);
  const authorMatches = sourceCatalog.authors.filter(
    (author) => author.authorId === fragment.works[0]?.authorId,
  );
  const introducedAuthor = fragment.authors[0];
  if ((fragment.authorContribution === 'reuse' &&
      (authorMatches.length !== 1 || fragment.authors.length !== 0)) ||
    (fragment.authorContribution === 'introduce' &&
      (authorMatches.length !== 0 || fragment.authors.length !== 1 || !introducedAuthor ||
       introducedAuthor.authorId !== fragment.works[0]?.authorId))) {
    throw new BatchCatalogError('BATCH_AUTHOR_IDENTITY_CONFLICT', '作者contributionが不正です');
  }
  const targetAuthorId = fragment.works[0]!.authorId;
  const existingWorkIds = new Set(sourceCatalog.works.map((work) => work.workId));
  const existingDialogueIds = new Set(sourceCatalog.works.flatMap((work) =>
    work.dialogues.map((dialogue) => dialogue.dialogueId)));
  const existingAudioIds = new Set(sourceCatalog.audioAssets.map((asset) => asset.audioId));
  const existingAudioPaths = new Set(sourceCatalog.audioAssets.map((asset) => asset.path));
  if (fragment.works.some((work) => existingWorkIds.has(work.workId) ||
    work.dialogues.some((dialogue) => existingDialogueIds.has(dialogue.dialogueId))) ||
    fragment.audioAssets.some((asset) =>
      existingAudioIds.has(asset.audioId) || existingAudioPaths.has(asset.path))) {
    throw new BatchCatalogError('BATCH_CATALOG_ID_CONFLICT', 'Catalog IDが衝突しています');
  }
  const counts = fragment.candidateCounts;
  const baselineWorks = structuredClone(sourceCatalog.works);
  let insertionIndex = baselineWorks.length;
  if (fragment.authorContribution === 'reuse') {
    insertionIndex = -1;
    for (let index = 0; index < baselineWorks.length; index += 1) {
      if (baselineWorks[index]?.authorId === targetAuthorId) insertionIndex = index + 1;
    }
  }
  if (insertionIndex < 0) {
    throw new BatchCatalogError('BATCH_AUTHOR_IDENTITY_CONFLICT', '対象作者の作品がありません');
  }
  baselineWorks.splice(insertionIndex, 0, ...structuredClone(fragment.works));
  const batch = {
    batchId: fragment.batchId,
    feature: fragment.feature,
    status: 'accepted' as const,
    authorId: targetAuthorId,
    workIds: fragment.works.map((work) => work.workId),
    acceptedAt: new Date(0).toISOString(),
    evidenceSha256: fragment.digest,
  };
  const catalog = freezeDeep({
    ...structuredClone(sourceCatalog),
    authors: [...structuredClone(sourceCatalog.authors), ...structuredClone(fragment.authors)],
    works: baselineWorks,
    audioAssets: [...structuredClone(sourceCatalog.audioAssets), ...structuredClone(fragment.audioAssets)],
    batches: [...structuredClone(sourceCatalog.batches), batch],
    candidateCounts: {
      total: sourceCatalog.candidateCounts.total + counts.total,
      published: sourceCatalog.candidateCounts.published + counts.published,
      editorialExcluded: sourceCatalog.candidateCounts.editorialExcluded + counts.editorialExcluded,
      audioExcluded: sourceCatalog.candidateCounts.audioExcluded + counts.audioExcluded,
      editorialReasons: mergeReasonTotals(
        sourceCatalog.candidateCounts.editorialReasons,
        counts.editorialReasons,
      ),
      audioFailureReasons: mergeReasonTotals(
        sourceCatalog.candidateCounts.audioFailureReasons,
        counts.audioFailureReasons,
      ),
      byBatch: { ...sourceCatalog.candidateCounts.byBatch, [fragment.batchId]: structuredClone(counts) },
    },
    __brand: mode === 'work-preview' ? 'WorkPreviewCatalog' as const : 'FinalCatalog' as const,
    mode,
  }) as WorkPreviewCatalog | FinalCatalog;
  (mode === 'work-preview' ? previewCatalogs : finalCatalogs).add(catalog);
  return catalog;
}

function mergeReasonTotals(
  baseline: Readonly<Record<string, number>> | undefined,
  addition: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const result = { ...baseline };
  for (const [reason, count] of Object.entries(addition ?? {})) {
    result[reason] = (result[reason] ?? 0) + count;
  }
  return result;
}

/** @des DES-F004-007 @fun FUN-F004-022 @ut UT-F004-022 */
export function mergeExistingAuthorCatalog(
  baseline: VerifiedCatalogBaseline,
  fragment: WorkPreviewCatalogFragment,
): WorkPreviewCatalog;
export function mergeExistingAuthorCatalog(
  baseline: VerifiedCatalogBaseline,
  fragment: FinalCatalogFragment,
): FinalCatalog;
export function mergeExistingAuthorCatalog(
  baseline: VerifiedCatalogBaseline,
  fragment: BatchCatalogFragment,
): WorkPreviewCatalog | FinalCatalog {
  return mergedCatalog(baseline, fragment, fragment.mode);
}

/**
 * accepted prefix＋staged exactly 1から非破壊previewを構築する。
 * @des DES-F004-006 @des DES-F004-007 @des DES-F004-011
 * @fun FUN-F004-037 @ut UT-F004-037
 */
export async function prepareBatchWorkPreview(
  workspace: string,
  definition: VerifiedBatchDefinition,
  manifest: BatchManifest,
  acceptedWorks: readonly IncludedBatchWork[],
  pendingWork: IncludedBatchWork,
  baseline: PublishedV030Baseline,
): Promise<BatchWorkPreview> {
  if (!isMintedPublishedV030Baseline(baseline) ||
    !isAbsolute(workspace) || !isAbsolute(pendingWork.workspaceRoot) ||
    acceptedWorks.some((work) => work.lifecycle !== 'accepted') ||
    pendingWork.lifecycle !== 'staged') {
    throw new BatchCatalogError('BATCH_PREVIEW_STATE_INVALID', 'preview work stateが不正です');
  }
  const baselineBefore = hash(baseline);
  const included = [...acceptedWorks, pendingWork];
  const fragment = projectBatchCatalogFragment(
    definition,
    manifest,
    included,
    baseline,
    'work-preview',
  );
  const catalog = mergeExistingAuthorCatalog(baseline, fragment);
  const baselineAfter = hash(baseline);
  if (baselineBefore !== baselineAfter) {
    throw new BatchCatalogError('BATCH_BASELINE_MUTATED', 'previewがbaselineを変更しました');
  }

  const root = resolve(workspace);
  const sourceWorkspace = resolve(pendingWork.workspaceRoot);
  if (included.some((work) => resolve(work.workspaceRoot) !== sourceWorkspace)) {
    throw new BatchCatalogError('BATCH_PREVIEW_STATE_INVALID', 'preview source workspaceが一致しません');
  }
  const cache = join(root, '.cache');
  await mkdir(cache, { recursive: true });
  const previewRoot = await mkdtemp(join(cache, 'f004-catalog-preview-'));
  const activeRoot = join(previewRoot, 'active');
  const contentRoot = join(previewRoot, 'content');
  const distRoot = join(previewRoot, 'dist');
  await Promise.all([
    mkdir(activeRoot, { recursive: true }),
    mkdir(contentRoot, { recursive: true }),
    mkdir(distRoot, { recursive: true }),
  ]);

  const baseBundle = await loadAndVerifyF001Baseline(
    join(root, 'public'),
    join(root, 'content', 'baselines', 'F001-v0.1.0.json'),
    join(root, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
  );
  const batches = await loadAcceptedBatches(root, { excludeActiveBatchId: definition.batchId });
  const discoveredBatchIds = new Set(batches.map((batch) => batch.manifest.batchId));
  // baselineが既に把握しているbatchだけを対象にする(baseline.catalog.batchesに
  // 現れないbatchはこのbaseline上でaudio/author alias解決ができないため)。
  const knownToBaseline = new Set(baseline.catalog.batches.map((batch) => batch.batchId));
  const [f002Fragment, f003Fragment, ...laterFragments] = await Promise.all([
    loadPublishedF002CatalogFragment(root, baseline.catalog),
    loadAcceptedF003CatalogFragment(root),
    ...[...discoveredBatchIds]
      .filter((batchId) => knownToBaseline.has(batchId) && isKnownPublishedCatalogBatchId(batchId))
      .map((batchId) => loadKnownPublishedCatalogFragment(root, batchId, baseline.catalog)),
  ]);
  const loadedFragments = [f002Fragment, f003Fragment, ...laterFragments];
  const batchCatalogs = Object.fromEntries(
    loadedFragments.map((batchFragment) => {
      const batchIds = new Set(batchFragment.works.map((work) => work.batchId));
      const batchId = [...batchIds][0];
      if (batchIds.size !== 1 || !batchId) {
        throw new BatchCatalogError('BATCH_PREVIEW_STATE_INVALID', 'published fragmentのbatch identityが不正です');
      }
      return [batchId, batchFragment];
    }),
  );
  const publishedCatalogBatches = Object.fromEntries(
    baseline.catalog.batches
      .filter((batch) => batchCatalogs[batch.batchId] !== undefined)
      .map((batch) => [batch.batchId, batch]),
  );

  const stagedFiles: ActiveBatchPreview['stagedFiles'][number][] = [];
  const publicFiles: NonNullable<PublicBatchCatalogFragment['publicFiles']>[number][] = [];
  const stageFile = async (
    source: string,
    publicPath: string,
    logicalSource: string,
  ): Promise<void> => {
    const target = join(activeRoot, ...publicPath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
    const bytes = await readFile(target);
    const entry = {
      source: target,
      publicPath: publicPath as WorkspaceRelativePath,
      sha256: hashBytes(bytes),
      bytes: bytes.byteLength,
    };
    stagedFiles.push(entry);
    publicFiles.push({
      source: logicalSource as WorkspaceRelativePath,
      publicPath: publicPath as WorkspaceRelativePath,
      sha256: entry.sha256,
      bytes: entry.bytes,
    });
  };
  for (const asset of pendingWork.audioAssets) {
    const source = join(sourceWorkspace, 'public', ...asset.path.split('/'));
    const target = join(activeRoot, ...asset.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
    stagedFiles.push({
      source: target,
      publicPath: asset.path as WorkspaceRelativePath,
      sha256: asset.sha256 as Sha256,
      bytes: asset.bytes,
    });
  }
  const sourceDir = dirname(pendingWork.work.source.provenancePath);
  const rawSource = join(sourceWorkspace, ...sourceDir.split('/'), 'source.raw');
  await stageFile(
    rawSource,
    `content/batches/${definition.batchId}/preview-sources/${pendingWork.work.workId}/source.raw`,
    `${sourceDir}/source.raw`,
  );
  await stageFile(
    join(sourceWorkspace, ...pendingWork.work.source.provenancePath.split('/')),
    `content/batches/${definition.batchId}/preview-sources/${pendingWork.work.workId}/provenance.json`,
    pendingWork.work.source.provenancePath,
  );
  const rightsSource = join(root, 'content', 'batches', definition.batchId, 'rights-selection.json');
  await stageFile(
    rightsSource,
    `content/batches/${definition.batchId}/rights-selection.json`,
    `content/batches/${definition.batchId}/rights-selection.json`,
  );

  const publicFragment: PublicBatchCatalogFragment = {
    authors: structuredClone(fragment.authors),
    works: fragment.works.map((work) => structuredClone(work)),
    audioAssets: fragment.audioAssets.map((asset) => structuredClone(asset)),
    candidateCounts: structuredClone(fragment.candidateCounts),
    publicFiles,
  };
  const active: ActiveBatchPreview = {
    manifest,
    workId: pendingWork.work.workId,
    catalogFragment: publicFragment,
    catalogBatch: {
      batchId: definition.batchId,
      feature: definition.feature,
      status: 'accepted',
      authorId: definition.author.authorId,
      workIds: included.map((work) => work.work.workId),
      acceptedAt: new Date(0).toISOString(),
      evidenceSha256: fragment.digest,
    },
    stagingRoot: activeRoot,
    stagedFiles,
  };
  const integrated = await buildIntegratedPublicTree(
    batches.filter((batch) => batchCatalogs[batch.manifest.batchId] !== undefined),
    baseBundle,
    contentRoot,
    {
      mode: 'work-preview',
      workspaceRoot: root,
      batchCatalogs,
      publishedCatalogBatches,
    },
    active,
  );
  const builtCatalog = JSON.parse(
    await readFile(join(integrated.stagingRoot, 'content', 'catalog.json'), 'utf8'),
  ) as CatalogV2;
  const unchangedPublishedProjection = {
    authors: builtCatalog.authors,
    works: builtCatalog.works.filter((work) => work.batchId !== definition.batchId),
    audioAssets: builtCatalog.audioAssets.filter((asset) => asset.batchId !== definition.batchId),
    batches: builtCatalog.batches.filter((batch) => batch.batchId !== definition.batchId),
  };
  const expectedPublishedProjection = {
    authors: baseline.catalog.authors,
    works: baseline.catalog.works,
    audioAssets: baseline.catalog.audioAssets,
    batches: baseline.catalog.batches,
  };
  if (canonicalJson(unchangedPublishedProjection) !== canonicalJson(expectedPublishedProjection)) {
    throw new BatchCatalogError(
      'BATCH_BASELINE_MUTATED',
      'preview buildのF001〜F003公開projectionがv0.3.0 baselineと一致しません',
    );
  }
  const pages = await buildPagesPreview(integrated, root, distRoot, true);
  const finalBaselineHash = hash(baseline);
  if (baselineBefore !== finalBaselineHash) {
    throw new BatchCatalogError('BATCH_BASELINE_MUTATED', 'preview buildがbaselineを変更しました');
  }
  return freezeDeep({
    __brand: 'BatchWorkPreview' as const,
    fragment,
    catalog,
    previewTreeSha256: integrated.buildSha256,
    publicProjectionSha256: integrated.buildSha256,
    distSha256: pages.distSha256,
    stagingRoot: integrated.stagingRoot,
    distRoot: pages.outputRoot,
    baselineInvariant: {
      result: 'pass' as const,
      beforeSha256: baselineBefore,
      afterSha256: finalBaselineHash,
    },
  });
}

/** @des DES-F004-007 @fun FUN-F004-023 @ut UT-F004-023 */
export function verifyReusedArtwork(
  baseline: PublishedV030Baseline,
  catalog: WorkPreviewCatalog | FinalCatalog,
): ArtworkReport {
  if (!isMintedPublishedV030Baseline(baseline)) {
    throw new BatchCatalogError('BATCH_ARTWORK_REUSE_MISMATCH', 'mint済みbaselineではありません');
  }
  const trusted = baseline.artwork;
  const minted = catalog.mode === 'work-preview'
    ? previewCatalogs.has(catalog)
    : finalCatalogs.has(catalog);
  const author = baseline.catalog.authors.find(
    (entry) => entry.authorId === trusted.authorId,
  );
  const mergedAuthor = catalog.authors.find(
    (entry) => entry.authorId === trusted.authorId,
  );
  if (!minted || !author || !mergedAuthor ||
    catalog.authors.length !== baseline.catalog.authors.length ||
    canonicalJson(author) !== canonicalJson(mergedAuthor) ||
    author.artwork.path !== trusted.path ||
    author.artwork.sha256 !== trusted.sha256 ||
    author.introducedByBatchId !== trusted.introducedByBatchId) {
    throw new BatchCatalogError('BATCH_ARTWORK_REUSE_MISMATCH', '作者画像またはprovenanceがbaselineと一致しません');
  }
  return freezeDeep({
    result: 'pass',
    authorId: author.authorId,
    path: author.artwork.path,
    bytes: trusted.bytes,
    sha256: author.artwork.sha256,
    newEntries: 0,
  });
}

type ProbeEventType = 'ended' | 'error';

class ProbeAudioPort implements AudioPort {
  src = '';
  currentTime = 0;
  preload = '';
  pauseCount = 0;
  loadCount = 0;
  activeCount = 0;
  maximumActive = 0;
  readonly #listeners = new Map<ProbeEventType, Set<EventListener>>([
    ['ended', new Set()],
    ['error', new Set()],
  ]);

  constructor(private readonly outcomes: Array<'resolve' | 'reject'>) {}

  async play(): Promise<void> {
    const outcome = this.outcomes.shift() ?? 'resolve';
    if (outcome === 'reject') throw new Error('HTTP 404');
    this.activeCount = 1;
    this.maximumActive = Math.max(this.maximumActive, this.activeCount);
  }

  pause(): void {
    this.pauseCount += 1;
    this.activeCount = 0;
  }

  load(): void {
    this.loadCount += 1;
  }

  removeAttribute(name: 'src'): void {
    if (name === 'src') this.src = '';
  }

  addEventListener(type: ProbeEventType, listener: EventListener): void {
    this.#listeners.get(type)?.add(listener);
  }

  removeEventListener(type: ProbeEventType, listener: EventListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: ProbeEventType): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener.call(this, new Event(type));
    }
  }
}

function audioButton(document: Document, dialogueId: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.dataset.dialogueId = dialogueId;
  return button;
}

/**
 * productionと同じAudioControllerへ観測可能なportを注入し、音声UX契約を実行検証する。
 * @des DES-F004-008 @fun FUN-F004-024 @ut UT-F004-024
 */
export async function probeRuntimeAudioController(
  catalog: CatalogV2,
  document: Document,
  definition: VerifiedBatchDefinition,
): Promise<RuntimeAudioProbe> {
  if (!isGenericVerifiedDefinition(definition)) {
    throw new BatchCatalogError('BATCH_RUNTIME_CONTENT_INVALID', 'mint済みdefinitionが必要です');
  }
  const targetIds = new Set(definition.workIds);
  const playable = catalog.works.filter((work) => targetIds.has(work.workId))
    .flatMap((work) => work.dialogues).filter((dialogue) =>
    catalog.audioAssets.some((asset) => asset.audioId === dialogue.audioId));
  const first = playable[0];
  const second = playable.find((dialogue) => dialogue.dialogueId !== first?.dialogueId);
  if (!first || !second) {
    throw new BatchCatalogError('BATCH_RUNTIME_CONTENT_INVALID', '音声probeに2件以上の台詞が必要です');
  }

  let primaryFactoryCalls = 0;
  const primaryPort = new ProbeAudioPort(['resolve', 'resolve']);
  const primary = new AudioController(catalog, new URL('https://example.test/app/'), () => {
    primaryFactoryCalls += 1;
    return primaryPort;
  });
  const firstState = await primary.play(first, audioButton(document, first.dialogueId));
  const secondState = await primary.play(second, audioButton(document, second.dialogueId));
  const simultaneousMaximum = primaryFactoryCalls === 1 &&
    firstState.status === 'playing' && secondState.status === 'playing' &&
    secondState.dialogueId === second.dialogueId &&
    primaryPort.maximumActive === 1 && primaryPort.pauseCount >= 2;

  const routeState = primary.onRouteChange({ kind: 'home' });
  const routeCleanup = routeState.status === 'stopped' &&
    primaryPort.activeCount === 0 && primaryPort.currentTime === 0 && primaryPort.src === '';
  const stateAfterRoute = canonicalJson(primary.state);
  primaryPort.emit('ended');
  primaryPort.emit('error');
  const staleEventsIgnored = canonicalJson(primary.state) === stateAfterRoute;
  primary.dispose();

  const failurePort = new ProbeAudioPort(['reject', 'resolve']);
  const failureController = new AudioController(
    catalog,
    new URL('https://example.test/app/'),
    () => failurePort,
  );
  const failedState = await failureController.play(
    first,
    audioButton(document, first.dialogueId),
  );
  const recoveredState = await failureController.play(
    second,
    audioButton(document, second.dialogueId),
  );
  const isolatedFailure = failedState.status === 'error' &&
    failedState.dialogueId === first.dialogueId &&
    recoveredState.status === 'playing' &&
    recoveredState.dialogueId === second.dialogueId;
  failureController.dispose();

  if (!simultaneousMaximum || !routeCleanup || !staleEventsIgnored || !isolatedFailure) {
    throw new BatchCatalogError('BATCH_RUNTIME_CONTENT_INVALID', 'AudioController契約が不正です');
  }
  const probe = freezeDeep({
    __brand: 'RuntimeAudioProbe' as const,
    catalogDigest: hash(catalog),
    definitionSha256: definition.sha256,
    simultaneousMaximum: 1 as const,
    routeCleanup: true as const,
    staleEventsIgnored: true as const,
    isolatedFailure: true as const,
  });
  runtimeAudioProbes.add(probe);
  return probe;
}

/** @des DES-F004-008 @fun FUN-F004-024 @ut UT-F004-024 */
export function validateNoticesAndInitialState(
  catalog: CatalogV2,
  document: Document,
  definition: VerifiedBatchDefinition,
  audioProbe: RuntimeAudioProbe,
): RuntimeContentReport {
  const required = [
    'work-list',
    'work-detail',
    'credits',
  ] as const;
  if (!isGenericVerifiedDefinition(definition)) {
    throw new BatchCatalogError('BATCH_RUNTIME_CONTENT_INVALID', 'mint済みdefinitionが必要です');
  }
  const matchingBatches = catalog.batches.filter((batch) =>
    batch.batchId === definition.batchId &&
    batch.feature === definition.feature &&
    canonicalJson(batch.workIds) === canonicalJson(definition.workIds));
  const batch = matchingBatches[0];
  const works = definition.workIds.map((workId) =>
    catalog.works.find((work) => work.workId === workId));
  const targetWorks = works?.filter((work) => work !== undefined) ?? [];
  const noticeElements = [...document.querySelectorAll<HTMLElement>('[data-notice-key]')];
  const expectedText = WORK_NOTICE_TEXT['dialogue-excerpt-scope'];
  const noticesAreExact = targetWorks.length === 3 && targetWorks.every((work) => {
    const notices = work.notices ?? [];
    return notices.length === 1 &&
      notices[0]?.textKey === 'dialogue-excerpt-scope' &&
      canonicalJson(notices[0].placements) === canonicalJson(required) &&
      required.every((placement) => {
        const matches = noticeElements.filter((element) =>
          element.dataset.workId === work.workId &&
          element.dataset.noticeKey === 'dialogue-excerpt-scope' &&
          element.dataset.noticePlacement === placement);
        const element = matches[0];
        return matches.length === 1 && element !== undefined &&
          element.childNodes.length === 1 &&
          element.firstChild?.nodeType === document.TEXT_NODE &&
          element.textContent === expectedText;
      });
  });
  const openPanels = document.querySelectorAll('details.work-panel[open]').length;
  if (matchingBatches.length !== 1 || !batch ||
    targetWorks.length !== definition.workIds.length ||
    noticeElements.length !== targetWorks.length * required.length ||
    !noticesAreExact || openPanels !== 0 ||
    !runtimeAudioProbes.has(audioProbe) || audioProbe.catalogDigest !== hash(catalog) ||
    audioProbe.definitionSha256 !== definition.sha256) {
    throw new BatchCatalogError('BATCH_RUNTIME_CONTENT_INVALID', 'noticeまたは初期panel状態が不正です');
  }
  return freezeDeep({
    result: 'pass',
    workCount: targetWorks.length,
    noticeCount: noticeElements.length,
    initialOpenPanels: 0,
    audio: {
      simultaneousMaximum: 1,
      routeCleanup: true,
      staleEventsIgnored: true,
      isolatedFailure: true,
    },
  });
}
