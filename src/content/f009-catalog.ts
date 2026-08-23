import { createHash } from 'node:crypto';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import {
  F009_WORKS,
  isVerifiedF009Author,
  type F009VerifiedAuthor,
  type F009WorkId,
} from './f009-source.ts';
import type {
  CatalogAudioAssetV2,
  CatalogCandidateCountV2,
  CatalogV2,
  CatalogWorkNotice,
  CatalogWorkV2,
} from './processing.ts';

/**
 * F009（夢野久作3作品追加）専用のCatalog統合・route導出モジュール。
 *
 * `f008-catalog.ts`の`mergeNewAuthorCatalog008`／`deriveF008RouteSet`と同型の
 * 構造を踏襲する。作者画像実体（PNG）はFUN-F009-014/015（`f009-artwork.ts`の
 * `sealF009ArtworkProvenance`／`verifyF009ArtworkAgainstCatalog`）で生成・
 * provenance検証・既存7作者との非近似重複確認済みであることを前提とする。
 * F008との違いは、baseline（v0.8.0、7作者24作品）と夢野久作の2作品分の
 * 作品固有注記（瓶詰地獄・死後の恋の`official-content-warning`、
 * QA-F009 No.4）をDES-F009-010どおりデータ駆動（`works[].notices`／
 * `.completionStatus`、既存`CatalogWorkV2`schemaがF003/F007/F008で既に使用済みの
 * feature非依存field）で結線する点のみで、`mergeNewAuthorCatalog009`自体に
 * 新規application分岐は追加しない。
 * @des DES-F009-010 @fun FUN-F009-011 FUN-F009-012
 */

const SHA256 = /^[0-9a-f]{64}$/u;
const AUTHOR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STATIC_ROUTES = Object.freeze(['#/', '#/favorites', '#/credits'] as const);
const F009_ARTWORK_PATH = 'artwork/yumeno-kyusaku-zundamon.png';

const mergedCatalogs = new WeakSet<object>();

export class F009CatalogError extends Error {
  constructor(
    public readonly code: 'F009_CATALOG_MERGE_CONFLICT' | 'F009_ROUTE_SET_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'F009CatalogError';
  }
}

export interface F009CatalogAuthorArtwork {
  readonly path: typeof F009_ARTWORK_PATH;
  readonly alt: string;
  readonly sha256: string;
}

export interface F009CatalogWorkV2 extends CatalogWorkV2 {
  readonly workId: F009WorkId;
  readonly batchId: 'F009';
  readonly authorId: '000096';
  readonly completionStatus: 'complete';
  readonly notices: CatalogWorkNotice[];
}

export interface F009CatalogFragment {
  readonly batchId: 'F009';
  readonly feature: 'F009';
  readonly authorId: '000096';
  readonly authorArtwork: F009CatalogAuthorArtwork;
  readonly works: readonly F009CatalogWorkV2[];
  readonly audioAssets: readonly CatalogAudioAssetV2[];
  readonly candidateCounts: CatalogCandidateCountV2;
  readonly acceptedAt: string;
  readonly evidenceSha256: Sha256;
}

export interface F009MergedCatalog extends CatalogV2 {
  readonly __brand: 'F009MergedCatalog';
}

export interface F009ExpectedRouteSet {
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

const EXPECTED_NOTICE_KEYS: Readonly<Record<F009WorkId, readonly string[]>> = Object.freeze({
  '002381': Object.freeze(['official-content-warning', 'dialogue-excerpt-scope']),
  '046694': Object.freeze(['dialogue-excerpt-scope']),
  '002380': Object.freeze(['official-content-warning', 'dialogue-excerpt-scope']),
});

function assertFragmentWorks(fragment: F009CatalogFragment): void {
  if (fragment.works.length !== F009_WORKS.length) {
    throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', 'fragment worksがexact 3件ではありません');
  }
  const dialogueIds: string[] = [];
  const audioIds = fragment.audioAssets.map((asset) => asset.audioId);
  const referencedAudioIds = new Set<string>();
  fragment.works.forEach((work, index) => {
    const expected = F009_WORKS[index]!;
    const expectedNoticeKeys = EXPECTED_NOTICE_KEYS[expected.workId];
    if (
      work.workId !== expected.workId ||
      work.title !== expected.title ||
      work.cardLink !== expected.cardUrl ||
      work.authorId !== '000096' ||
      work.batchId !== 'F009' ||
      work.completionStatus !== 'complete' ||
      !Array.isArray(work.notices) ||
      new Set(work.notices.map((notice) => notice.textKey)).size !== expectedNoticeKeys.length ||
      !expectedNoticeKeys.every((key) => work.notices.some((notice) => notice.textKey === key))
    ) {
      throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', `fragment workがF009_WORKSまたは注記と一致しません: ${expected.workId}`);
    }
    for (const dialogue of work.dialogues) {
      if (dialogue.workId !== work.workId) {
        throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', 'dialogue.workIdがworkと一致しません');
      }
      dialogueIds.push(dialogue.dialogueId);
      referencedAudioIds.add(dialogue.audioId);
    }
  });
  if (new Set(dialogueIds).size !== dialogueIds.length) {
    throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', 'fragment内dialogue IDが重複しています');
  }
  if (new Set(audioIds).size !== audioIds.length) {
    throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', 'fragment内audio IDが重複しています');
  }
  for (const audioId of referencedAudioIds) {
    if (!audioIds.includes(audioId)) {
      throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', `参照audio assetが不足しています: ${audioId}`);
    }
  }
  for (const asset of fragment.audioAssets) {
    if (asset.batchId !== 'F009') {
      throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', 'audio assetのbatchIdがF009ではありません');
    }
  }
}

function assertArtwork(artwork: F009CatalogAuthorArtwork): void {
  if (
    !isRecord(artwork) ||
    artwork.path !== F009_ARTWORK_PATH ||
    !isNonBlank(artwork.alt) ||
    typeof artwork.sha256 !== 'string' ||
    !SHA256.test(artwork.sha256)
  ) {
    throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', '作者画像bindingが不正です');
  }
}

/**
 * baseline(v0.8.0、7作者24作品)のserialized projectionをexact維持したまま
 * 夢野久作の作者・3作品・音声assetを末尾追加する。瓶詰地獄・死後の恋の作品固有
 * 注記はfragment.works[].notices（既存CatalogWorkV2 schema、
 * DD-F009.md FUN-F009-011）へcaller供給のまま結合し、application分岐は
 * 追加しない。
 * @des DES-F009-010 @fun FUN-F009-011 @ut UT-F009-011
 */
export function mergeNewAuthorCatalog009(
  baselineCatalog: CatalogV2,
  fragment: F009CatalogFragment,
  verifiedAuthor: F009VerifiedAuthor,
): F009MergedCatalog {
  if (
    !isVerifiedF009Author(verifiedAuthor) ||
    !isRecord(fragment) ||
    fragment.batchId !== 'F009' ||
    fragment.feature !== 'F009' ||
    fragment.authorId !== verifiedAuthor.authorId ||
    !isNonBlank(fragment.acceptedAt) ||
    !Number.isFinite(Date.parse(fragment.acceptedAt)) ||
    typeof fragment.evidenceSha256 !== 'string' ||
    !SHA256.test(fragment.evidenceSha256)
  ) {
    throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', 'fragment/検証済み作者identityが不正です');
  }
  assertArtwork(fragment.authorArtwork);
  assertFragmentWorks(fragment);
  if (
    !isRecord(baselineCatalog) ||
    !Array.isArray(baselineCatalog.authors) || baselineCatalog.authors.length !== 7 ||
    !Array.isArray(baselineCatalog.works) || baselineCatalog.works.length !== 24 ||
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
    baselineCatalog.batches.some((batch) => batch.batchId === 'F009')
  ) {
    throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', 'baseline joinまたは作者/作品/asset IDが競合しています');
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
      introducedByBatchId: 'F009',
      identitySha256: verifiedAuthor.identitySha256,
    }],
    works: [...clone(baselineCatalog.works), ...clone(fragment.works)],
    audioAssets: [...clone(baselineCatalog.audioAssets), ...clone(fragment.audioAssets)],
    batches: [...clone(baselineCatalog.batches), {
      batchId: 'F009',
      feature: 'F009',
      status: 'accepted',
      authorId: '000096',
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
      byBatch: { ...clone(baselineCatalog.candidateCounts.byBatch), F009: clone(counts) },
    },
    __brand: 'F009MergedCatalog' as const,
  }) as unknown as F009MergedCatalog;
  const preservedProjectionBytes = new TextEncoder().encode(JSON.stringify({
    authors: catalog.authors.slice(0, 7),
    works: catalog.works.slice(0, 24),
    audioAssets: catalog.audioAssets.slice(0, baselineCatalog.audioAssets.length),
    batches: catalog.batches.slice(0, baselineCatalog.batches.length),
    candidateCounts: baselineCatalog.candidateCounts,
    creditsRef: catalog.creditsRef,
  }));
  if (
    Buffer.compare(baselineProjectionBytes, preservedProjectionBytes) !== 0 ||
    catalog.authors.length !== 8 ||
    catalog.works.length !== 24 + fragment.works.length ||
    catalog.authors.at(-1)?.authorId !== '000096'
  ) {
    throw new F009CatalogError('F009_CATALOG_MERGE_CONFLICT', '既存serialized projectionが変化しました');
  }
  mergedCatalogs.add(catalog);
  return catalog;
}

/**
 * @des DES-F009-010 @fun FUN-F009-011
 */
export function isMintedF009MergedCatalog(value: unknown): value is F009MergedCatalog {
  return isRecord(value) && mergedCatalogs.has(value) && value.__brand === 'F009MergedCatalog';
}

/**
 * 8作者slugと固定global routeからexact 11 routeを導出する。
 * @des DES-F009-010 @fun FUN-F009-012 @ut UT-F009-012
 */
export function deriveF009RouteSet(
  catalog: F009MergedCatalog,
  staticRoutes: readonly string[],
): F009ExpectedRouteSet {
  if (!isMintedF009MergedCatalog(catalog) || catalog.authors.length !== 8) {
    throw new F009CatalogError('F009_ROUTE_SET_INVALID', 'mint済みCatalogまたは作者数が不正です');
  }
  const slugs = catalog.authors.map((author) => author.slug);
  if (
    new Set(slugs).size !== 8 ||
    slugs.some((slug) => !AUTHOR_SLUG.test(slug)) ||
    canonicalJson(staticRoutes) !== canonicalJson(STATIC_ROUTES)
  ) {
    throw new F009CatalogError('F009_ROUTE_SET_INVALID', '作者slugまたは固定route集合が不正です');
  }
  const routes = [
    staticRoutes[0]!,
    ...slugs.map((slug) => `#/authors/${slug}`),
    staticRoutes[1]!,
    staticRoutes[2]!,
  ];
  if (routes.length !== 11 || new Set(routes).size !== routes.length) {
    throw new F009CatalogError('F009_ROUTE_SET_INVALID', '公開routeはexact 11件である必要があります');
  }
  return deepFreeze({ routes, digest: hash(routes) });
}
