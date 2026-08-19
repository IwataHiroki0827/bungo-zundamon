import { createHash } from 'node:crypto';

import { canonicalJson } from './artifacts.ts';
import {
  hashBatchManifest,
  validateBatchManifest,
  type BatchManifest,
  type Sha256,
} from './batch.ts';
import {
  isMintedF005ArtworkAcceptance,
  type ArtworkAcceptance,
} from './f005-artwork.ts';
import {
  isMintedF005ApprovedBatchContext,
  type F005ApprovedBatchContext,
} from './f005-context.ts';
import {
  isVerifiedNewAuthor,
  type VerifiedNewAuthor,
} from './f005-foundation.ts';
import {
  F005_WORKS,
  formatProofreader,
  parseBibliographyV2,
  type BibliographyV2,
  type F005WorkId,
  type RightsUsageDecision,
  type SourceRecordV2,
} from './f005-source.ts';
import type {
  CatalogAudioAssetV2,
  CatalogAuthorV2,
  CatalogCandidateCountV2,
  CatalogSourceV2,
  CatalogV2,
  CatalogWorkV2,
} from './processing.ts';

declare const previewFragmentType: unique symbol;
declare const finalFragmentType: unique symbol;
declare const previewCatalogType: unique symbol;
declare const finalCatalogType: unique symbol;

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_PATH =
  /^(?!\/)(?!.*\\)(?!.*(?:^|\/)(?:\.{1,2})(?:\/|$))(?![A-Za-z][A-Za-z0-9+.-]*:)[A-Za-z0-9._/-]+$/u;
const AUTHOR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STATIC_ROUTES = Object.freeze(['#/', '#/favorites', '#/credits'] as const);
const PREVIEW_FRAGMENT_BRAND = 'F005WorkPreviewCatalogFragment';
const FINAL_FRAGMENT_BRAND = 'F005FinalCatalogFragment';
const PREVIEW_CATALOG_BRAND = 'F005WorkPreviewCatalog';
const FINAL_CATALOG_BRAND = 'F005FinalCatalog';

const previewFragments = new WeakSet<object>();
const finalFragments = new WeakSet<object>();
const previewCatalogs = new WeakSet<object>();
const finalCatalogs = new WeakSet<object>();

export class F005CatalogError extends Error {
  constructor(
    public readonly code:
      | 'F005_CATALOG_FRAGMENT_INVALID'
      | 'F005_CATALOG_MERGE_CONFLICT'
      | 'F005_ROUTE_SET_INVALID'
      | 'F005_CREDIT_PROJECTION_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'F005CatalogError';
  }
}

export interface F005CatalogSourceV2 extends Omit<CatalogSourceV2, 'proofreader'> {
  readonly proofreader: string | null;
}

export interface F005CatalogWorkV2 extends Omit<CatalogWorkV2, 'source'> {
  readonly workId: F005WorkId;
  readonly batchId: 'F005';
  readonly authorId: '000148';
  readonly source: F005CatalogSourceV2;
}

export type CompatibleCatalogWorkV2 = CatalogWorkV2 | F005CatalogWorkV2;

export interface F005CatalogV2 extends Omit<CatalogV2, 'works'> {
  readonly works: CompatibleCatalogWorkV2[];
}

export type F005ArtworkCatalogBinding = ArtworkAcceptance;

export interface F005SourceProvenanceBinding {
  readonly path: `content/provenance/F005/${F005WorkId}.json`;
  readonly sha256: Sha256;
}

export interface F005IncludedCatalogWork {
  readonly lifecycle: 'accepted' | 'staged';
  readonly work: F005CatalogWorkV2;
  readonly sourceRecord: SourceRecordV2;
  readonly sourceProvenance: F005SourceProvenanceBinding;
  readonly audioAssets: readonly CatalogAudioAssetV2[];
  readonly candidateCounts: CatalogCandidateCountV2;
  readonly artifactSha256: Sha256;
}

interface F005CatalogFragmentCore {
  readonly batchId: 'F005';
  readonly feature: 'F005';
  readonly authorContribution: 'introduce';
  readonly author: CatalogAuthorV2;
  readonly artwork: F005ArtworkCatalogBinding;
  readonly works: readonly F005CatalogWorkV2[];
  readonly audioAssets: readonly CatalogAudioAssetV2[];
  readonly candidateCounts: CatalogCandidateCountV2;
  readonly manifestSha256: Sha256;
  readonly manifestStatus: BatchManifest['status'];
  readonly manifestObservedAt: string;
  readonly acceptedAt: string | null;
  readonly digest: Sha256;
}

export interface F005WorkPreviewCatalogFragment extends F005CatalogFragmentCore {
  readonly __brand: typeof PREVIEW_FRAGMENT_BRAND;
  readonly mode: 'work-preview';
  readonly [previewFragmentType]: true;
}

export interface F005FinalCatalogFragment extends F005CatalogFragmentCore {
  readonly __brand: typeof FINAL_FRAGMENT_BRAND;
  readonly mode: 'final';
  readonly [finalFragmentType]: true;
}

export type F005CatalogFragment = F005WorkPreviewCatalogFragment | F005FinalCatalogFragment;

export interface F005WorkPreviewCatalog extends F005CatalogV2 {
  readonly __brand: typeof PREVIEW_CATALOG_BRAND;
  readonly mode: 'work-preview';
  readonly [previewCatalogType]: true;
}

export interface F005FinalCatalog extends F005CatalogV2 {
  readonly __brand: typeof FINAL_CATALOG_BRAND;
  readonly mode: 'final';
  readonly [finalCatalogType]: true;
}

export interface F005ExpectedRouteSet {
  readonly routes: readonly string[];
  readonly digest: Sha256;
}

export interface DataDrivenWorkNoticeV1 {
  readonly schemaVersion: 1;
  readonly workId: '001104';
  readonly text: string;
  readonly sourceUrl: string;
  readonly sourceRawSha256: Sha256;
  readonly textSha256: Sha256;
  readonly placements: readonly ['author', 'work', 'credits'];
}

export interface F005CreditTextNode {
  readonly kind: 'text';
  readonly text: string;
}

export interface F005CreditAnchor {
  readonly kind: 'anchor';
  readonly text: string;
  readonly href: string;
  readonly target: '_blank';
  readonly rel: 'noopener noreferrer';
}

export type F005CreditNode = F005CreditTextNode | F005CreditAnchor;

export interface F005CreditPlacement {
  readonly placement: 'author' | 'work' | 'credits';
  readonly workId: F005WorkId | null;
  readonly nodes: readonly F005CreditNode[];
}

export interface F005CreditProjection {
  readonly author: readonly F005CreditPlacement[];
  readonly works: Readonly<Record<F005WorkId, F005CreditPlacement>>;
  readonly credits: readonly F005CreditPlacement[];
  readonly digest: Sha256;
}

function hash(value: unknown): Sha256 {
  return createHash('sha256').update(canonicalJson(value)).digest('hex') as Sha256;
}

function hashText(value: string): Sha256 {
  return createHash('sha256').update(value, 'utf8').digest('hex') as Sha256;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function hasMarkup(value: string): boolean {
  return /[<>]/u.test(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sumCounts(values: readonly CatalogCandidateCountV2[]): CatalogCandidateCountV2 {
  const sumReasons = (key: 'editorialReasons' | 'audioFailureReasons'): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const value of values) {
      for (const [reason, count] of Object.entries(value[key] ?? {})) {
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new F005CatalogError('F005_CATALOG_FRAGMENT_INVALID', '候補理由件数が不正です');
        }
        result[reason] = (result[reason] ?? 0) + count;
      }
    }
    return result;
  };
  const result = {
    total: values.reduce((sum, value) => sum + value.total, 0),
    published: values.reduce((sum, value) => sum + value.published, 0),
    editorialExcluded: values.reduce((sum, value) => sum + value.editorialExcluded, 0),
    audioExcluded: values.reduce((sum, value) => sum + value.audioExcluded, 0),
    editorialReasons: sumReasons('editorialReasons'),
    audioFailureReasons: sumReasons('audioFailureReasons'),
  };
  const numericTotals = [
    result.total,
    result.published,
    result.editorialExcluded,
    result.audioExcluded,
  ];
  if (numericTotals.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    result.total !== result.published + result.editorialExcluded + result.audioExcluded) {
    throw new F005CatalogError('F005_CATALOG_FRAGMENT_INVALID', '候補件数の集計が不正です');
  }
  return result;
}

function assertArtwork(
  artwork: ArtworkAcceptance,
  verifiedAuthor: VerifiedNewAuthor,
  manifest: BatchManifest,
): void {
  if (
    !isMintedF005ArtworkAcceptance(artwork) ||
    artwork.path !== 'artwork/natsume-zundamon.png' ||
    !isNonBlank(artwork.alt) ||
    !SHA256.test(artwork.sha256) ||
    artwork.sourceProvenancePath !== manifest.artworkProvenanceRef ||
    artwork.publicProvenancePath !== 'content/artwork-provenance/F005.json' ||
    artwork.provenancePath !== artwork.publicProvenancePath ||
    !SHA256.test(artwork.provenanceSha256) ||
    !isNonBlank(artwork.credit) ||
    hasMarkup(artwork.credit) ||
    artwork.authorIdentitySha256 !== verifiedAuthor.identitySha256
  ) {
    throw new F005CatalogError('F005_CATALOG_FRAGMENT_INVALID', '作者画像Catalog bindingが不正です');
  }
}

function assertManifest(
  context: F005ApprovedBatchContext,
  manifest: BatchManifest,
  includedWorks: readonly F005IncludedCatalogWork[],
  mode: 'work-preview' | 'final',
): {
  readonly manifestStatus: BatchManifest['status'];
  readonly manifestObservedAt: string;
  readonly acceptedAt: string | null;
} {
  const checked = validateBatchManifest(manifest);
  const expectedIds = context.definition.workIds;
  if (
    !checked.ok ||
    manifest.batchId !== 'F005' ||
    manifest.feature !== 'F005' ||
    manifest.author.authorId !== '000148' ||
    canonicalJson(manifest.workIds) !== canonicalJson(expectedIds) ||
    canonicalJson(manifest.workProgress.map((entry) => entry.workId)) !== canonicalJson(expectedIds) ||
    includedWorks.length < 1 ||
    includedWorks.length > 3 ||
    canonicalJson(includedWorks.map((entry) => entry.work.workId)) !==
      canonicalJson(expectedIds.slice(0, includedWorks.length))
  ) {
    throw new F005CatalogError('F005_CATALOG_FRAGMENT_INVALID', 'context/manifest/work順が一致しません');
  }
  if (mode === 'work-preview') {
    const last = includedWorks.length - 1;
    if (
      includedWorks[last]?.lifecycle !== 'staged' ||
      includedWorks.slice(0, last).some((entry) => entry.lifecycle !== 'accepted') ||
      manifest.workProgress.slice(0, last).some((entry) => entry.status !== 'accepted') ||
      manifest.workProgress[last]?.status === 'accepted' ||
      manifest.workProgress.slice(last + 1).some((entry) => entry.status !== 'pending')
    ) {
      throw new F005CatalogError(
        'F005_CATALOG_FRAGMENT_INVALID',
        'previewは先行acceptedと現在staged 1件だけを許可します',
      );
    }
    const observedAt = manifest.workProgress[last]?.stageRecords.at(-1)?.completedAt;
    if (!observedAt || manifest.acceptedAt !== undefined || manifest.acceptedBy !== undefined) {
      throw new F005CatalogError(
        'F005_CATALOG_FRAGMENT_INVALID',
        'preview時刻はstaged workの実stage recordから導出する必要があります',
      );
    }
    return {
      manifestStatus: manifest.status,
      manifestObservedAt: observedAt,
      acceptedAt: null,
    };
  } else if (
    includedWorks.length !== 3 ||
    includedWorks.some((entry) => entry.lifecycle !== 'accepted') ||
    manifest.workProgress.some((entry) => entry.status !== 'accepted') ||
    manifest.status !== 'accepted'
  ) {
    throw new F005CatalogError('F005_CATALOG_FRAGMENT_INVALID', 'finalは3作品acceptedが必要です');
  }
  // CHG-F005-075: F005は作品単位でatomicに受理するため、batch単位のstage record
  // を書かない(FUN-F005-022/023はworkProgress[].stageRecordsだけを進める)。
  // acceptedAtの裏付けは各作品のaccepted stage recordであり、batchのacceptedAtは
  // 最後に受理された作品の完了時刻と一致していなければならない。
  const acceptedCompletions = manifest.workProgress.map((work) => {
    const record = work.stageRecords.at(-1);
    return record?.stage === 'accepted' ? record.completedAt : null;
  });
  const lastAcceptedAt = acceptedCompletions.includes(null)
    ? null
    : acceptedCompletions.reduce<string>(
      (latest, item) => (item! > latest ? item! : latest), acceptedCompletions[0]!);
  if (
    !manifest.acceptedAt ||
    !manifest.acceptedBy ||
    lastAcceptedAt === null ||
    lastAcceptedAt !== manifest.acceptedAt
  ) {
    throw new F005CatalogError(
      'F005_CATALOG_FRAGMENT_INVALID',
      'final accepted時刻が各作品のaccepted stage recordと一致しません',
    );
  }
  return {
    manifestStatus: manifest.status,
    manifestObservedAt: lastAcceptedAt,
    acceptedAt: manifest.acceptedAt,
  };
}

function sourceFromRecord(
  record: SourceRecordV2,
  provenance: F005SourceProvenanceBinding,
): F005CatalogSourceV2 {
  const bibliography = parseBibliographyV2(record.bibliography, record.workId);
  return {
    cardUrl: record.cardUrl,
    textUrl: record.sourceUrl,
    attribution: '青空文庫',
    baseEdition: bibliography.baseEdition,
    inputter: bibliography.inputter,
    proofreader: bibliography.proofreader,
    fetchedAt: record.fetchedAt,
    transformation: '青空文庫XHTMLを正規化し、外側の全角かぎ括弧発話を抽出',
    sourceSha256: record.raw.sha256,
    provenancePath: provenance.path,
    provenanceSha256: provenance.sha256,
    bibliographyCharset: record.bibliographyCharset,
    bodySelector: record.bodySelector,
    rawBytes: record.raw.byteLength,
    rawSha256: record.raw.sha256,
    canonicalSourceSha256: record.raw.sha256,
    sourceUpdatedAt: record.updatedAt,
  };
}

/**
 * SourceRecordV2をnullable対応CatalogSourceへ一意に投影する。
 * @des DES-F005-003 @des DES-F005-007 @fun FUN-F005-024 @ut UT-F005-024
 */
export function projectF005CatalogSource(
  record: SourceRecordV2,
  provenance: F005SourceProvenanceBinding,
): F005CatalogSourceV2 {
  if (
    provenance.path !== `content/provenance/F005/${record.workId}.json` ||
    !SHA256.test(provenance.sha256) ||
    provenance.sha256 === record.raw.sha256
  ) {
    throw new F005CatalogError(
      'F005_CATALOG_FRAGMENT_INVALID',
      'source provenance path/artifact SHAが不正です',
    );
  }
  return deepFreeze(sourceFromRecord(record, provenance));
}

function assertIncludedWork(entry: F005IncludedCatalogWork): void {
  const expected = F005_WORKS.find((work) => work.workId === entry.work.workId);
  if (
    !expected ||
    entry.sourceRecord.workId !== expected.workId ||
    entry.work.title !== expected.title ||
    entry.work.cardLink !== expected.cardUrl ||
    entry.work.authorId !== '000148' ||
    entry.work.batchId !== 'F005' ||
    !SHA256.test(entry.artifactSha256) ||
    canonicalJson(entry.work.source) !==
      canonicalJson(sourceFromRecord(entry.sourceRecord, entry.sourceProvenance)) ||
    entry.sourceProvenance.path !== `content/provenance/F005/${entry.work.workId}.json` ||
    !SHA256.test(entry.sourceProvenance.sha256) ||
    entry.sourceProvenance.sha256 === entry.sourceRecord.raw.sha256
  ) {
    throw new F005CatalogError('F005_CATALOG_FRAGMENT_INVALID', 'source/Catalog/work identityが一致しません');
  }
  const dialogueIds = entry.work.dialogues.map((dialogue) => dialogue.dialogueId);
  const audioIds = entry.audioAssets.map((asset) => asset.audioId);
  const referencedAudioIds = new Set(entry.work.dialogues.map((dialogue) => dialogue.audioId));
  const candidateIds = entry.audioAssets.flatMap((asset) => asset.candidateIds ?? []);
  if (
    entry.sourceRecord.schemaVersion !== '2.0.0' ||
    entry.sourceRecord.raw.sha256 !== createHash('sha256').update(entry.sourceRecord.raw.bytes).digest('hex') ||
    entry.sourceRecord.raw.byteLength !== entry.sourceRecord.raw.bytes.byteLength ||
    entry.sourceRecord.card.sha256 !== createHash('sha256').update(entry.sourceRecord.card.bytes).digest('hex') ||
    entry.sourceRecord.card.byteLength !== entry.sourceRecord.card.bytes.byteLength ||
    entry.sourceRecord.cardRawSha256 !== entry.sourceRecord.card.sha256 ||
    entry.sourceRecord.cardRawBytes !== entry.sourceRecord.card.byteLength ||
    new Set(dialogueIds).size !== dialogueIds.length ||
    new Set(audioIds).size !== audioIds.length ||
    new Set(candidateIds).size !== candidateIds.length ||
    canonicalJson([...candidateIds].sort()) !== canonicalJson([...dialogueIds].sort()) ||
    entry.work.dialogues.some((dialogue) =>
      dialogue.workId !== entry.work.workId ||
      !entry.audioAssets.some((asset) =>
        asset.audioId === dialogue.audioId && asset.candidateIds?.includes(dialogue.dialogueId))) ||
    entry.audioAssets.some((asset) =>
      asset.batchId !== 'F005' || !SAFE_PATH.test(asset.path) || !SHA256.test(asset.sha256) ||
      !referencedAudioIds.has(asset.audioId)) ||
    [...referencedAudioIds].some((audioId) => !entry.audioAssets.some((asset) => asset.audioId === audioId))
  ) {
    throw new F005CatalogError('F005_CATALOG_FRAGMENT_INVALID', 'dialogue/audio参照または孤立assetが不正です');
  }
  sumCounts([entry.candidateCounts]);
}

/**
 * F005 source validatorをCatalog境界でも再利用し、nullable書誌を投影する。
 * @des DES-F005-003 @des DES-F005-007 @fun FUN-F005-024 @ut UT-F005-024
 */
export function projectF005Bibliography(
  value: unknown,
  workId: F005WorkId,
): BibliographyV2 & { readonly proofreaderLabel: string } {
  const bibliography = parseBibliographyV2(value, workId);
  return deepFreeze({
    ...bibliography,
    proofreaderLabel: `校正者: ${formatProofreader(bibliography.proofreader)}`,
  });
}

/**
 * accepted prefix＋staged 1件または全accepted 3件からmode別fragmentをmintする。
 * @des DES-F005-007 @fun FUN-F005-025 @ut UT-F005-025
 */
export function projectF005CatalogFragment(
  context: F005ApprovedBatchContext,
  manifest: BatchManifest,
  includedWorks: readonly F005IncludedCatalogWork[],
  author: VerifiedNewAuthor,
  artwork: F005ArtworkCatalogBinding,
  mode: 'work-preview',
): F005WorkPreviewCatalogFragment;
export function projectF005CatalogFragment(
  context: F005ApprovedBatchContext,
  manifest: BatchManifest,
  includedWorks: readonly F005IncludedCatalogWork[],
  author: VerifiedNewAuthor,
  artwork: F005ArtworkCatalogBinding,
  mode: 'final',
): F005FinalCatalogFragment;
export function projectF005CatalogFragment(
  context: F005ApprovedBatchContext,
  manifest: BatchManifest,
  includedWorks: readonly F005IncludedCatalogWork[],
  author: VerifiedNewAuthor,
  artwork: F005ArtworkCatalogBinding,
  mode: 'work-preview' | 'final',
): F005CatalogFragment {
  if (!isMintedF005ApprovedBatchContext(context) || !isVerifiedNewAuthor(author)) {
    throw new F005CatalogError('F005_CATALOG_FRAGMENT_INVALID', 'mint済みcontext/作者identityが必要です');
  }
  assertArtwork(artwork, author, manifest);
  const manifestBinding = assertManifest(context, manifest, includedWorks, mode);
  includedWorks.forEach(assertIncludedWork);
  const dialogueIds = includedWorks.flatMap((entry) =>
    entry.work.dialogues.map((dialogue) => dialogue.dialogueId));
  // CHG-F005-076: audio IDは台詞文とvoice configの内容アドレスであり、
  // 別作品に同一台詞があれば同じ音声を共有する(倫敦塔の「なぜ」は夢十夜と同一)。
  // 公開Catalogのaudio assetsは元から作品横断でグローバルに一意化されるため、
  // fragmentでも重複を許し、実体が一致することだけを要求する。
  const assetsById = new Map<string, CatalogAudioAssetV2>();
  for (const entry of includedWorks) {
    for (const asset of entry.audioAssets) {
      const known = assetsById.get(asset.audioId);
      if (!known) {
        assetsById.set(asset.audioId, asset);
        continue;
      }
      if (known.path !== asset.path || known.sha256 !== asset.sha256 ||
        known.bytes !== asset.bytes || known.durationMs !== asset.durationMs ||
        known.configHash !== asset.configHash) {
        throw new F005CatalogError(
          'F005_CATALOG_FRAGMENT_INVALID',
          '同一audio IDで実体が一致しません',
        );
      }
      assetsById.set(asset.audioId, {
        ...known,
        candidateIds: [...new Set([
          ...(known.candidateIds ?? []),
          ...(asset.candidateIds ?? []),
        ])].sort((left, right) => left.localeCompare(right, 'en')),
      });
    }
  }
  const provenancePaths = includedWorks.map((entry) => entry.sourceProvenance.path);
  const provenanceHashes = includedWorks.map((entry) => entry.sourceProvenance.sha256);
  if (
    new Set(dialogueIds).size !== dialogueIds.length ||
    new Set(provenancePaths).size !== provenancePaths.length ||
    new Set(provenanceHashes).size !== provenanceHashes.length
  ) {
    throw new F005CatalogError(
      'F005_CATALOG_FRAGMENT_INVALID',
      'fragment内IDまたはsource provenanceが重複しています',
    );
  }
  const catalogAuthor: CatalogAuthorV2 = {
    authorId: author.authorId,
    name: author.name,
    originalName: author.originalName,
    slug: author.slug,
    artwork: {
      path: artwork.path,
      alt: artwork.alt,
      sha256: artwork.sha256,
    },
    introducedByBatchId: 'F005',
    identitySha256: author.identitySha256,
  };
  const core = {
    batchId: 'F005' as const,
    feature: 'F005' as const,
    authorContribution: 'introduce' as const,
    author: catalogAuthor,
    artwork: clone(artwork),
    works: includedWorks.map((entry) => clone(entry.work)),
    audioAssets: clone([...assetsById.values()]),
    candidateCounts: sumCounts(includedWorks.map((entry) => entry.candidateCounts)),
    manifestSha256: hashBatchManifest(manifest),
    ...manifestBinding,
  };
  const fragment = deepFreeze({
    ...core,
    __brand: mode === 'work-preview' ? PREVIEW_FRAGMENT_BRAND : FINAL_FRAGMENT_BRAND,
    mode,
    digest: hash(core),
  }) as unknown as F005CatalogFragment;
  (mode === 'work-preview' ? previewFragments : finalFragments).add(fragment);
  return fragment;
}

function assertMintedFragment(fragment: F005CatalogFragment): void {
  const core = {
    batchId: fragment.batchId,
    feature: fragment.feature,
    authorContribution: fragment.authorContribution,
    author: fragment.author,
    artwork: fragment.artwork,
    works: fragment.works,
    audioAssets: fragment.audioAssets,
    candidateCounts: fragment.candidateCounts,
    manifestSha256: fragment.manifestSha256,
    manifestStatus: fragment.manifestStatus,
    manifestObservedAt: fragment.manifestObservedAt,
    acceptedAt: fragment.acceptedAt,
  };
  const minted = fragment.mode === 'work-preview'
    ? previewFragments.has(fragment)
    : finalFragments.has(fragment);
  if (!minted || fragment.digest !== hash(core)) {
    throw new F005CatalogError('F005_CATALOG_MERGE_CONFLICT', 'mintされていないCatalog fragmentです');
  }
}

/**
 * runtimeへpreview/finalのmint済みbrandを公開する。
 * @des DES-F005-007 @des DES-F005-009 @fun FUN-F005-025 @fun FUN-F005-031
 */
export function isMintedF005Catalog(
  value: unknown,
): value is F005WorkPreviewCatalog | F005FinalCatalog {
  return !!value && typeof value === 'object' &&
    (previewCatalogs.has(value) || finalCatalogs.has(value));
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

/**
 * v0.4.0の3作者・12作品projectionを変えず、夏目作者と作品を末尾追加する。
 * @des DES-F005-007 @fun FUN-F005-026 @ut UT-F005-026
 */
export function mergeNewAuthorCatalog(
  baselineCatalog: CatalogV2,
  fragment: F005WorkPreviewCatalogFragment,
  verifiedAuthor: VerifiedNewAuthor,
): F005WorkPreviewCatalog;
export function mergeNewAuthorCatalog(
  baselineCatalog: CatalogV2,
  fragment: F005FinalCatalogFragment,
  verifiedAuthor: VerifiedNewAuthor,
): F005FinalCatalog;
export function mergeNewAuthorCatalog(
  baselineCatalog: CatalogV2,
  fragment: F005CatalogFragment,
  verifiedAuthor: VerifiedNewAuthor,
): F005WorkPreviewCatalog | F005FinalCatalog {
  assertMintedFragment(fragment);
  if (
    !isVerifiedNewAuthor(verifiedAuthor) ||
    fragment.author.authorId !== verifiedAuthor.authorId ||
    fragment.author.identitySha256 !== verifiedAuthor.identitySha256 ||
    baselineCatalog.authors.length !== 3 ||
    baselineCatalog.works.length !== 12 ||
    baselineCatalog.authors.some((author) =>
      author.authorId === verifiedAuthor.authorId ||
      author.name === verifiedAuthor.name ||
      author.originalName === verifiedAuthor.originalName ||
      author.slug === verifiedAuthor.slug) ||
    baselineCatalog.works.some((work) =>
      work.authorId === verifiedAuthor.authorId ||
      fragment.works.some((added) => added.workId === work.workId)) ||
    baselineCatalog.audioAssets.some((asset) =>
      fragment.audioAssets.some((added) => added.audioId === asset.audioId || added.path === asset.path)) ||
    baselineCatalog.batches.some((batch) => batch.batchId === 'F005')
  ) {
    throw new F005CatalogError('F005_CATALOG_MERGE_CONFLICT', 'baseline joinまたは作者/作品/asset IDが競合しています');
  }
  const baselineProjectionBytes = new TextEncoder().encode(JSON.stringify({
    authors: baselineCatalog.authors,
    works: baselineCatalog.works,
    audioAssets: baselineCatalog.audioAssets,
    batches: baselineCatalog.batches,
    candidateCounts: baselineCatalog.candidateCounts,
    creditsRef: baselineCatalog.creditsRef,
  }));
  const counts = fragment.candidateCounts;
  const catalog = deepFreeze({
    ...clone(baselineCatalog),
    authors: [...clone(baselineCatalog.authors), clone(fragment.author)],
    works: [...clone(baselineCatalog.works), ...clone(fragment.works)],
    audioAssets: [...clone(baselineCatalog.audioAssets), ...clone(fragment.audioAssets)],
    batches: [...clone(baselineCatalog.batches), {
      batchId: 'F005',
      feature: 'F005',
      status: 'accepted',
      authorId: '000148',
      workIds: fragment.works.map((work) => work.workId),
      acceptedAt: fragment.acceptedAt ?? fragment.manifestObservedAt,
      evidenceSha256: fragment.digest,
      manifestStatus: fragment.manifestStatus,
      manifestObservedAt: fragment.manifestObservedAt,
    }],
    candidateCounts: {
      total: baselineCatalog.candidateCounts.total + counts.total,
      published: baselineCatalog.candidateCounts.published + counts.published,
      editorialExcluded: baselineCatalog.candidateCounts.editorialExcluded + counts.editorialExcluded,
      audioExcluded: baselineCatalog.candidateCounts.audioExcluded + counts.audioExcluded,
      editorialReasons: mergeReasonTotals(
        baselineCatalog.candidateCounts.editorialReasons,
        counts.editorialReasons,
      ),
      audioFailureReasons: mergeReasonTotals(
        baselineCatalog.candidateCounts.audioFailureReasons,
        counts.audioFailureReasons,
      ),
      byBatch: { ...clone(baselineCatalog.candidateCounts.byBatch), F005: clone(counts) },
    },
    __brand: fragment.mode === 'work-preview' ? PREVIEW_CATALOG_BRAND : FINAL_CATALOG_BRAND,
    mode: fragment.mode,
  }) as unknown as F005WorkPreviewCatalog | F005FinalCatalog;
  const preservedProjectionBytes = new TextEncoder().encode(JSON.stringify({
    authors: catalog.authors.slice(0, 3),
    works: catalog.works.slice(0, 12),
    audioAssets: catalog.audioAssets.slice(0, baselineCatalog.audioAssets.length),
    batches: catalog.batches.slice(0, baselineCatalog.batches.length),
    candidateCounts: baselineCatalog.candidateCounts,
    creditsRef: catalog.creditsRef,
  }));
  if (
    Buffer.compare(baselineProjectionBytes, preservedProjectionBytes) !== 0 ||
    catalog.authors.length !== 4 ||
    catalog.works.length !== 12 + fragment.works.length ||
    catalog.authors.at(-1)?.authorId !== '000148'
  ) {
    throw new F005CatalogError('F005_CATALOG_MERGE_CONFLICT', '既存serialized projectionが変化しました');
  }
  (fragment.mode === 'work-preview' ? previewCatalogs : finalCatalogs).add(catalog);
  return catalog;
}

/**
 * 4作者slugと固定global routeからexact 7 routeを導出する。
 * @des DES-F005-007 @des DES-F005-009 @fun FUN-F005-027 @ut UT-F005-027
 */
export function deriveF005RouteSet(
  catalog: F005WorkPreviewCatalog | F005FinalCatalog,
  staticRoutes: readonly string[],
): F005ExpectedRouteSet {
  const minted = catalog.mode === 'work-preview'
    ? previewCatalogs.has(catalog)
    : finalCatalogs.has(catalog);
  const slugs = catalog.authors.map((author) => author.slug);
  if (
    !minted ||
    catalog.authors.length !== 4 ||
    new Set(slugs).size !== 4 ||
    slugs.some((slug) => !AUTHOR_SLUG.test(slug)) ||
    canonicalJson(staticRoutes) !== canonicalJson(STATIC_ROUTES)
  ) {
    throw new F005CatalogError('F005_ROUTE_SET_INVALID', '作者slugまたは固定route集合が不正です');
  }
  const routes = [
    staticRoutes[0]!,
    ...slugs.map((slug) => `#/authors/${slug}`),
    staticRoutes[1]!,
    staticRoutes[2]!,
  ];
  if (routes.length !== 7 || new Set(routes).size !== routes.length) {
    throw new F005CatalogError('F005_ROUTE_SET_INVALID', '公開routeはexact 7件である必要があります');
  }
  return deepFreeze({ routes, digest: hash(routes) });
}

function assertSafeAozoraUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new F005CatalogError('F005_CREDIT_PROJECTION_INVALID', 'credit URLが不正です');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.aozora.gr.jp' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== ''
  ) {
    throw new F005CatalogError('F005_CREDIT_PROJECTION_INVALID', '未検証credit URLです');
  }
}

function text(textValue: string): F005CreditTextNode {
  if (!isNonBlank(textValue) || hasMarkup(textValue)) {
    throw new F005CatalogError('F005_CREDIT_PROJECTION_INVALID', 'credit textへHTMLを使用できません');
  }
  return { kind: 'text', text: textValue };
}

function anchor(label: string, href: string): F005CreditAnchor {
  if (!isNonBlank(label) || hasMarkup(label)) {
    throw new F005CatalogError('F005_CREDIT_PROJECTION_INVALID', 'credit anchor labelが不正です');
  }
  assertSafeAozoraUrl(href);
  return {
    kind: 'anchor',
    text: label,
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
  };
}

function workCreditNodes(
  work: F005CatalogWorkV2,
  source: SourceRecordV2,
  notice: DataDrivenWorkNoticeV1 | undefined,
): readonly F005CreditNode[] {
  const bibliography = projectF005Bibliography(source.bibliography, source.workId);
  const nodes: F005CreditNode[] = [
    text(`${work.title}: 括弧発話の抜粋であり、全文朗読・要約ではありません。題材・表現は原作由来です。`),
    anchor('青空文庫 作品カード', source.cardUrl),
    text(`底本: ${bibliography.baseEdition}`),
    text(`入力者: ${bibliography.inputter}`),
    text(bibliography.proofreaderLabel),
  ];
  if (notice) {
    nodes.push(text(notice.text), anchor('公式表現注意の出典', notice.sourceUrl));
  }
  return nodes;
}

/**
 * Catalog/source/license/notice/artworkの同一joinから3配置のtext/anchor dataを作る。
 * @des DES-F005-010 @fun FUN-F005-032 @ut UT-F005-032 @it IT-F005-007
 */
export function projectF005Credits(
  catalog: F005WorkPreviewCatalog | F005FinalCatalog,
  sources: readonly SourceRecordV2[],
  decisions: readonly RightsUsageDecision[],
  notices: readonly DataDrivenWorkNoticeV1[],
  artwork: F005ArtworkCatalogBinding,
): F005CreditProjection {
  const minted = catalog.mode === 'work-preview'
    ? previewCatalogs.has(catalog)
    : finalCatalogs.has(catalog);
  const targetWorks = catalog.works.filter(
    (work): work is F005CatalogWorkV2 => work.batchId === 'F005',
  );
  const sourceById = new Map(sources.map((source) => [source.workId, source]));
  const noticeById = new Map(notices.map((notice) => [notice.workId, notice]));
  if (
    !minted ||
    !isMintedF005ArtworkAcceptance(artwork) ||
    targetWorks.length !== sources.length ||
    new Set(sources.map((source) => source.workId)).size !== sources.length ||
    decisions.length !== 2 ||
    decisions.some((decision) => decision.decision !== 'allow') ||
    new Set(decisions.map((decision) => decision.phase)).size !== 2 ||
    canonicalJson([...decisions.map((decision) => decision.phase)].sort()) !==
      canonicalJson(['predeploy', 'selection']) ||
    notices.length !== 1 ||
    noticeById.size !== 1 ||
    catalog.authors.find((author) => author.authorId === '000148')?.artwork.path !== artwork.path ||
    catalog.authors.find((author) => author.authorId === '000148')?.artwork.sha256 !== artwork.sha256 ||
    !isNonBlank(artwork.credit) ||
    hasMarkup(artwork.credit) ||
    artwork.path !== 'artwork/natsume-zundamon.png' ||
    artwork.publicProvenancePath !== 'content/artwork-provenance/F005.json' ||
    artwork.provenancePath !== artwork.publicProvenancePath ||
    !SHA256.test(artwork.provenanceSha256) ||
    artwork.authorIdentitySha256 !==
      '8eadb891d1440952f33b0bae4fccae91db8cf48a1688df607ee6a80c65870f4f'
  ) {
    throw new F005CatalogError('F005_CREDIT_PROJECTION_INVALID', 'credit joinの参照または権利decisionが不正です');
  }
  const notice = notices[0]!;
  const noticeSource = sourceById.get('001104');
  if (
    notice.schemaVersion !== 1 ||
    notice.workId !== '001104' ||
    !isNonBlank(notice.text) ||
    hasMarkup(notice.text) ||
    notice.textSha256 !== hashText(notice.text) ||
    !SHA256.test(notice.sourceRawSha256) ||
    !noticeSource ||
    notice.sourceUrl !== noticeSource.cardUrl ||
    notice.sourceRawSha256 !== noticeSource.cardRawSha256 ||
    canonicalJson(notice.placements) !== canonicalJson(['author', 'work', 'credits'])
  ) {
    throw new F005CatalogError('F005_CREDIT_PROJECTION_INVALID', 'verified noticeが不正です');
  }
  assertSafeAozoraUrl(notice.sourceUrl);
  const workPlacements = {} as Record<F005WorkId, F005CreditPlacement>;
  const authorPlacements: F005CreditPlacement[] = [];
  const creditsPlacements: F005CreditPlacement[] = [];
  for (const work of targetWorks) {
    const source = sourceById.get(work.workId);
    if (
      !source ||
      source.cardUrl !== work.source.cardUrl ||
      source.sourceUrl !== work.source.textUrl ||
      source.raw.sha256 !== work.source.sourceSha256 ||
      canonicalJson(parseBibliographyV2(source.bibliography, source.workId)) !==
        canonicalJson({
          baseEdition: work.source.baseEdition,
          inputter: work.source.inputter,
          proofreader: work.source.proofreader,
        })
    ) {
      throw new F005CatalogError('F005_CREDIT_PROJECTION_INVALID', 'source/Catalog/hash joinが一致しません');
    }
    const workNotice = work.workId === '001104' ? notice : undefined;
    const nodes = workCreditNodes(work, source, workNotice);
    authorPlacements.push({ placement: 'author', workId: work.workId, nodes: clone(nodes) });
    workPlacements[work.workId] = { placement: 'work', workId: work.workId, nodes: clone(nodes) };
    creditsPlacements.push({ placement: 'credits', workId: work.workId, nodes: clone(nodes) });
  }
  const sharedNodes: readonly F005CreditNode[] = [
    text('音声: VOICEVOX:ずんだもん'),
    text('本サイトは非公式の二次創作です。'),
    text(`作者画像: ${artwork.credit}`),
  ];
  authorPlacements.push({ placement: 'author', workId: null, nodes: clone(sharedNodes) });
  creditsPlacements.push({ placement: 'credits', workId: null, nodes: clone(sharedNodes) });
  const core = {
    author: authorPlacements,
    works: workPlacements,
    credits: creditsPlacements,
  };
  return deepFreeze({ ...core, digest: hash(core) });
}
