import { createHash } from 'node:crypto';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import {
  F006_WORKS,
  isVerifiedF006Author,
  type F006VerifiedAuthor,
  type F006WorkId,
} from './f006-source.ts';
import type {
  CatalogAudioAssetV2,
  CatalogCandidateCountV2,
  CatalogV2,
  CatalogWorkV2,
} from './processing.ts';

/**
 * F006（中島敦3作品追加）専用のCatalog統合・route導出モジュール。
 *
 * `f005-catalog.ts`の`mergeNewAuthorCatalog`／`deriveF005RouteSet`と同型の
 * 構造を踏襲する。作者画像実体（PNG）はFUN-F006-014/015（`f006-artwork.ts`の
 * `sealF006ArtworkProvenance`／`verifyF006ArtworkAgainstCatalog`）で生成・
 * provenance検証・既存4作者との非近似重複確認まで完了済みであり（実SHA-256
 * `F006_ARTWORK_SHA256`、dHash64 `383820881363322b`、既存4作者との最小Hamming
 * 距離24）、`content/batches/F006/public-files/artwork/nakajima-zundamon.png`
 * ／`content/batches/F006/artwork-provenance.json`として永続化済みである。
 * `mergeNewAuthorCatalog006`自体はCatalog統合ロジックの単体テスト容易性を
 * 保つため、`authorArtwork`bindingをcaller供給のオブジェクトとして受け取り
 * schema/format検証だけを行う（PNG decode・provenance実体検証は呼び出し前に
 * `f006-artwork.ts`側で完了している前提）。実運用のcallerは`F006_ARTWORK_PATH`
 * ／`F006_ARTWORK_SHA256`をそのまま`fragment.authorArtwork`へ結線する。
 *
 * @des DES-F006-010 @fun FUN-F006-011 FUN-F006-012
 */

const SHA256 = /^[0-9a-f]{64}$/u;
const AUTHOR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STATIC_ROUTES = Object.freeze(['#/', '#/favorites', '#/credits'] as const);
const F006_ARTWORK_PATH = 'artwork/nakajima-zundamon.png';
/** `f006-artwork.ts`の`sealF006ArtworkProvenance`が実測したexact SHA-256（捏造しない実値）。 */
export const F006_ARTWORK_SHA256 =
  '9686d567837c60baaa611aa1779cb1052d3a37e046160c8cce77f26cc5328e4a';

const mergedCatalogs = new WeakSet<object>();

export class F006CatalogError extends Error {
  constructor(
    public readonly code: 'F006_CATALOG_MERGE_CONFLICT' | 'F006_ROUTE_SET_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'F006CatalogError';
  }
}

export interface F006CatalogAuthorArtwork {
  readonly path: typeof F006_ARTWORK_PATH;
  readonly alt: string;
  readonly sha256: string;
}

export interface F006CatalogWorkV2 extends CatalogWorkV2 {
  readonly workId: F006WorkId;
  readonly batchId: 'F006';
  readonly authorId: '000119';
}

export interface F006CatalogFragment {
  readonly batchId: 'F006';
  readonly feature: 'F006';
  readonly authorId: '000119';
  readonly authorArtwork: F006CatalogAuthorArtwork;
  readonly works: readonly F006CatalogWorkV2[];
  readonly audioAssets: readonly CatalogAudioAssetV2[];
  readonly candidateCounts: CatalogCandidateCountV2;
  /** QA-F006 No.4の確定回答により、F006の3作品fragmentは常に空配列。 */
  readonly notices: readonly [];
  readonly acceptedAt: string;
  readonly evidenceSha256: Sha256;
}

export interface F006MergedCatalog extends CatalogV2 {
  readonly __brand: 'F006MergedCatalog';
}

export interface F006ExpectedRouteSet {
  readonly routes: readonly string[];
  readonly digest: Sha256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hash(value: unknown): Sha256 {
  return createHash('sha256').update(canonicalJson(value)).digest('hex') as Sha256;
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

function assertFragmentWorks(fragment: F006CatalogFragment): void {
  if (fragment.works.length !== F006_WORKS.length) {
    throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', 'fragment worksがexact 3件ではありません');
  }
  const dialogueIds: string[] = [];
  const audioIds = fragment.audioAssets.map((asset) => asset.audioId);
  const referencedAudioIds = new Set<string>();
  fragment.works.forEach((work, index) => {
    const expected = F006_WORKS[index]!;
    if (
      work.workId !== expected.workId ||
      work.title !== expected.title ||
      work.cardLink !== expected.cardUrl ||
      work.authorId !== '000119' ||
      work.batchId !== 'F006'
    ) {
      throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', `fragment workがF006_WORKSと一致しません: ${expected.workId}`);
    }
    for (const dialogue of work.dialogues) {
      if (dialogue.workId !== work.workId) {
        throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', 'dialogue.workIdがworkと一致しません');
      }
      dialogueIds.push(dialogue.dialogueId);
      referencedAudioIds.add(dialogue.audioId);
    }
  });
  if (new Set(dialogueIds).size !== dialogueIds.length) {
    throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', 'fragment内dialogue IDが重複しています');
  }
  if (new Set(audioIds).size !== audioIds.length) {
    throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', 'fragment内audio IDが重複しています');
  }
  for (const audioId of referencedAudioIds) {
    if (!audioIds.includes(audioId)) {
      throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', `参照audio assetが不足しています: ${audioId}`);
    }
  }
  for (const asset of fragment.audioAssets) {
    if (asset.batchId !== 'F006') {
      throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', 'audio assetのbatchIdがF006ではありません');
    }
  }
}

function assertArtwork(artwork: F006CatalogAuthorArtwork): void {
  if (
    !isRecord(artwork) ||
    artwork.path !== F006_ARTWORK_PATH ||
    !isNonBlank(artwork.alt) ||
    typeof artwork.sha256 !== 'string' ||
    !SHA256.test(artwork.sha256)
  ) {
    throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', '作者画像bindingが不正です');
  }
}

/**
 * baseline(v0.5.0、4作者15作品)のserialized projectionをexact維持したまま
 * 中島敦の作者・3作品・音声assetを末尾追加する。作者画像は未生成のため、
 * `fragment.authorArtwork`はcaller供給のbindingをそのまま結合し、PNG実体の
 * 検証は行わない（FUN-F006-014/015のスコープ）。
 * @des DES-F006-010 @fun FUN-F006-011 @ut UT-F006-011
 */
export function mergeNewAuthorCatalog006(
  baselineCatalog: CatalogV2,
  fragment: F006CatalogFragment,
  verifiedAuthor: F006VerifiedAuthor,
): F006MergedCatalog {
  if (
    !isVerifiedF006Author(verifiedAuthor) ||
    !isRecord(fragment) ||
    fragment.batchId !== 'F006' ||
    fragment.feature !== 'F006' ||
    fragment.authorId !== verifiedAuthor.authorId ||
    !Array.isArray(fragment.notices) ||
    fragment.notices.length !== 0 ||
    !isNonBlank(fragment.acceptedAt) ||
    !Number.isFinite(Date.parse(fragment.acceptedAt)) ||
    typeof fragment.evidenceSha256 !== 'string' ||
    !SHA256.test(fragment.evidenceSha256)
  ) {
    throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', 'fragment/検証済み作者identityが不正です');
  }
  assertArtwork(fragment.authorArtwork);
  assertFragmentWorks(fragment);
  if (
    !isRecord(baselineCatalog) ||
    !Array.isArray(baselineCatalog.authors) || baselineCatalog.authors.length !== 4 ||
    !Array.isArray(baselineCatalog.works) || baselineCatalog.works.length !== 15 ||
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
    baselineCatalog.batches.some((batch) => batch.batchId === 'F006')
  ) {
    throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', 'baseline joinまたは作者/作品/asset IDが競合しています');
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
    authors: [...clone(baselineCatalog.authors), {
      authorId: verifiedAuthor.authorId,
      name: verifiedAuthor.name,
      originalName: verifiedAuthor.originalName,
      slug: verifiedAuthor.slug,
      artwork: clone(fragment.authorArtwork),
      introducedByBatchId: 'F006',
      identitySha256: verifiedAuthor.identitySha256,
    }],
    works: [...clone(baselineCatalog.works), ...clone(fragment.works)],
    audioAssets: [...clone(baselineCatalog.audioAssets), ...clone(fragment.audioAssets)],
    batches: [...clone(baselineCatalog.batches), {
      batchId: 'F006',
      feature: 'F006',
      status: 'accepted',
      authorId: '000119',
      workIds: fragment.works.map((work) => work.workId),
      acceptedAt: fragment.acceptedAt,
      evidenceSha256: fragment.evidenceSha256,
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
      byBatch: { ...clone(baselineCatalog.candidateCounts.byBatch), F006: clone(counts) },
    },
    __brand: 'F006MergedCatalog' as const,
  }) as unknown as F006MergedCatalog;
  const preservedProjectionBytes = new TextEncoder().encode(JSON.stringify({
    authors: catalog.authors.slice(0, 4),
    works: catalog.works.slice(0, 15),
    audioAssets: catalog.audioAssets.slice(0, baselineCatalog.audioAssets.length),
    batches: catalog.batches.slice(0, baselineCatalog.batches.length),
    candidateCounts: baselineCatalog.candidateCounts,
    creditsRef: catalog.creditsRef,
  }));
  if (
    Buffer.compare(baselineProjectionBytes, preservedProjectionBytes) !== 0 ||
    catalog.authors.length !== 5 ||
    catalog.works.length !== 15 + fragment.works.length ||
    catalog.authors.at(-1)?.authorId !== '000119'
  ) {
    throw new F006CatalogError('F006_CATALOG_MERGE_CONFLICT', '既存serialized projectionが変化しました');
  }
  mergedCatalogs.add(catalog);
  return catalog;
}

/**
 * @des DES-F006-010 @fun FUN-F006-011
 */
export function isMintedF006MergedCatalog(value: unknown): value is F006MergedCatalog {
  return isRecord(value) && mergedCatalogs.has(value) && value.__brand === 'F006MergedCatalog';
}

/**
 * 5作者slugと固定global routeからexact 8 routeを導出する。
 * @des DES-F006-010 @fun FUN-F006-012 @ut UT-F006-012
 */
export function deriveF006RouteSet(
  catalog: F006MergedCatalog,
  staticRoutes: readonly string[],
): F006ExpectedRouteSet {
  if (!isMintedF006MergedCatalog(catalog) || catalog.authors.length !== 5) {
    throw new F006CatalogError('F006_ROUTE_SET_INVALID', 'mint済みCatalogまたは作者数が不正です');
  }
  const slugs = catalog.authors.map((author) => author.slug);
  if (
    new Set(slugs).size !== 5 ||
    slugs.some((slug) => !AUTHOR_SLUG.test(slug)) ||
    canonicalJson(staticRoutes) !== canonicalJson(STATIC_ROUTES)
  ) {
    throw new F006CatalogError('F006_ROUTE_SET_INVALID', '作者slugまたは固定route集合が不正です');
  }
  const routes = [
    staticRoutes[0]!,
    ...slugs.map((slug) => `#/authors/${slug}`),
    staticRoutes[1]!,
    staticRoutes[2]!,
  ];
  if (routes.length !== 8 || new Set(routes).size !== routes.length) {
    throw new F006CatalogError('F006_ROUTE_SET_INVALID', '公開routeはexact 8件である必要があります');
  }
  return deepFreeze({ routes, digest: hash(routes) });
}
