import { createHash } from 'node:crypto';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import {
  F008_WORKS,
  isVerifiedF008Author,
  type F008VerifiedAuthor,
  type F008WorkId,
} from './f008-source.ts';
import type {
  CatalogAudioAssetV2,
  CatalogCandidateCountV2,
  CatalogV2,
  CatalogWorkNotice,
  CatalogWorkV2,
} from './processing.ts';

/**
 * F008（江戸川乱歩3作品追加）専用のCatalog統合・route導出モジュール。
 *
 * `f007-catalog.ts`の`mergeNewAuthorCatalog007`／`deriveF007RouteSet`と同型の
 * 構造を踏襲する。作者画像実体（PNG）はFUN-F008-014/015（`f008-artwork.ts`の
 * `sealF008ArtworkProvenance`／`verifyF008ArtworkAgainstCatalog`）で生成・
 * provenance検証・既存6作者との非近似重複確認済みであることを前提とする。
 * F007との違いは、baseline（v0.7.0、6作者21作品）と江戸川乱歩の2作品分の
 * 作品固有注記（人間椅子・Ｄ坂の殺人事件の`official-content-warning`、
 * QA-F008 No.4）をDES-F008-010どおりデータ駆動（`works[].notices`／
 * `.completionStatus`、既存`CatalogWorkV2`schemaがF003/F007で既に使用済みの
 * feature非依存field）で結線する点のみで、`mergeNewAuthorCatalog008`自体に
 * 新規application分岐は追加しない。
 * @des DES-F008-010 @fun FUN-F008-011 FUN-F008-012
 */

const SHA256 = /^[0-9a-f]{64}$/u;
const AUTHOR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STATIC_ROUTES = Object.freeze(['#/', '#/favorites', '#/credits'] as const);
const F008_ARTWORK_PATH = 'artwork/edogawa-ranpo-zundamon.png';

const mergedCatalogs = new WeakSet<object>();

export class F008CatalogError extends Error {
  constructor(
    public readonly code: 'F008_CATALOG_MERGE_CONFLICT' | 'F008_ROUTE_SET_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'F008CatalogError';
  }
}

export interface F008CatalogAuthorArtwork {
  readonly path: typeof F008_ARTWORK_PATH;
  readonly alt: string;
  readonly sha256: string;
}

export interface F008CatalogWorkV2 extends CatalogWorkV2 {
  readonly workId: F008WorkId;
  readonly batchId: 'F008';
  readonly authorId: '001779';
  readonly completionStatus: 'complete';
  readonly notices: CatalogWorkNotice[];
}

export interface F008CatalogFragment {
  readonly batchId: 'F008';
  readonly feature: 'F008';
  readonly authorId: '001779';
  readonly authorArtwork: F008CatalogAuthorArtwork;
  readonly works: readonly F008CatalogWorkV2[];
  readonly audioAssets: readonly CatalogAudioAssetV2[];
  readonly candidateCounts: CatalogCandidateCountV2;
  readonly acceptedAt: string;
  readonly evidenceSha256: Sha256;
}

export interface F008MergedCatalog extends CatalogV2 {
  readonly __brand: 'F008MergedCatalog';
}

export interface F008ExpectedRouteSet {
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

const EXPECTED_NOTICE_KEYS: Readonly<Record<F008WorkId, readonly string[]>> = Object.freeze({
  '056648': Object.freeze(['official-content-warning', 'dialogue-excerpt-scope']),
  '056650': Object.freeze(['official-content-warning', 'dialogue-excerpt-scope']),
  '057193': Object.freeze(['dialogue-excerpt-scope']),
});

function assertFragmentWorks(fragment: F008CatalogFragment): void {
  if (fragment.works.length !== F008_WORKS.length) {
    throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', 'fragment worksがexact 3件ではありません');
  }
  const dialogueIds: string[] = [];
  const audioIds = fragment.audioAssets.map((asset) => asset.audioId);
  const referencedAudioIds = new Set<string>();
  fragment.works.forEach((work, index) => {
    const expected = F008_WORKS[index]!;
    const expectedNoticeKeys = EXPECTED_NOTICE_KEYS[expected.workId];
    if (
      work.workId !== expected.workId ||
      work.title !== expected.title ||
      work.cardLink !== expected.cardUrl ||
      work.authorId !== '001779' ||
      work.batchId !== 'F008' ||
      work.completionStatus !== 'complete' ||
      !Array.isArray(work.notices) ||
      new Set(work.notices.map((notice) => notice.textKey)).size !== expectedNoticeKeys.length ||
      !expectedNoticeKeys.every((key) => work.notices.some((notice) => notice.textKey === key))
    ) {
      throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', `fragment workがF008_WORKSまたは注記と一致しません: ${expected.workId}`);
    }
    for (const dialogue of work.dialogues) {
      if (dialogue.workId !== work.workId) {
        throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', 'dialogue.workIdがworkと一致しません');
      }
      dialogueIds.push(dialogue.dialogueId);
      referencedAudioIds.add(dialogue.audioId);
    }
  });
  if (new Set(dialogueIds).size !== dialogueIds.length) {
    throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', 'fragment内dialogue IDが重複しています');
  }
  if (new Set(audioIds).size !== audioIds.length) {
    throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', 'fragment内audio IDが重複しています');
  }
  for (const audioId of referencedAudioIds) {
    if (!audioIds.includes(audioId)) {
      throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', `参照audio assetが不足しています: ${audioId}`);
    }
  }
  for (const asset of fragment.audioAssets) {
    if (asset.batchId !== 'F008') {
      throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', 'audio assetのbatchIdがF008ではありません');
    }
  }
}

function assertArtwork(artwork: F008CatalogAuthorArtwork): void {
  if (
    !isRecord(artwork) ||
    artwork.path !== F008_ARTWORK_PATH ||
    !isNonBlank(artwork.alt) ||
    typeof artwork.sha256 !== 'string' ||
    !SHA256.test(artwork.sha256)
  ) {
    throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', '作者画像bindingが不正です');
  }
}

/**
 * baseline(v0.7.0、6作者21作品)のserialized projectionをexact維持したまま
 * 江戸川乱歩の作者・3作品・音声assetを末尾追加する。人間椅子・Ｄ坂の殺人事件の
 * 作品固有注記はfragment.works[].notices（既存CatalogWorkV2 schema、
 * DD-F008.md FUN-F008-011）へcaller供給のまま結合し、application分岐は
 * 追加しない。
 * @des DES-F008-010 @fun FUN-F008-011 @ut UT-F008-011
 */
export function mergeNewAuthorCatalog008(
  baselineCatalog: CatalogV2,
  fragment: F008CatalogFragment,
  verifiedAuthor: F008VerifiedAuthor,
): F008MergedCatalog {
  if (
    !isVerifiedF008Author(verifiedAuthor) ||
    !isRecord(fragment) ||
    fragment.batchId !== 'F008' ||
    fragment.feature !== 'F008' ||
    fragment.authorId !== verifiedAuthor.authorId ||
    !isNonBlank(fragment.acceptedAt) ||
    !Number.isFinite(Date.parse(fragment.acceptedAt)) ||
    typeof fragment.evidenceSha256 !== 'string' ||
    !SHA256.test(fragment.evidenceSha256)
  ) {
    throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', 'fragment/検証済み作者identityが不正です');
  }
  assertArtwork(fragment.authorArtwork);
  assertFragmentWorks(fragment);
  if (
    !isRecord(baselineCatalog) ||
    !Array.isArray(baselineCatalog.authors) || baselineCatalog.authors.length !== 6 ||
    !Array.isArray(baselineCatalog.works) || baselineCatalog.works.length !== 21 ||
    baselineCatalog.authors.some((author) =>
      author.authorId === verifiedAuthor.authorId ||
      author.name === verifiedAuthor.name ||
      author.originalName === verifiedAuthor.originalName ||
      author.slug === verifiedAuthor.slug) ||
    baselineCatalog.works.some((work) =>
      work.authorId === verifiedAuthor.authorId ||
      fragment.works.some((added) => added.workId === work.workId)) ||
    // CHG-F008-004: audioId(createVoiceCacheKeyV2)はtext+config"入力"のhashで
    // あり出力音声自体のhashではないため、既存の公開済み台詞と偶然同一入力の
    // 短い発話が起こり得る(実例: 一人二役057193の「へええ」がF005/001104と
    // audioId一致)。実測ではWAV実体(sha256)が別セッション生成のため一致しない
    // ことも確認済みであり、実体一致を条件にすると本件を弾いてしまう。
    // path(batchId scoped)は既に一意な名前空間のため、path自体の衝突だけを
    // 実エラーとして拒否する。
    baselineCatalog.audioAssets.some((asset) =>
      fragment.audioAssets.some((added) => added.path === asset.path)) ||
    baselineCatalog.batches.some((batch) => batch.batchId === 'F008')
  ) {
    throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', 'baseline joinまたは作者/作品/asset IDが競合しています');
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
      introducedByBatchId: 'F008',
      identitySha256: verifiedAuthor.identitySha256,
    }],
    works: [...clone(baselineCatalog.works), ...clone(fragment.works)],
    audioAssets: [...clone(baselineCatalog.audioAssets), ...clone(fragment.audioAssets)],
    batches: [...clone(baselineCatalog.batches), {
      batchId: 'F008',
      feature: 'F008',
      status: 'accepted',
      authorId: '001779',
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
      byBatch: { ...clone(baselineCatalog.candidateCounts.byBatch), F008: clone(counts) },
    },
    __brand: 'F008MergedCatalog' as const,
  }) as unknown as F008MergedCatalog;
  const preservedProjectionBytes = new TextEncoder().encode(JSON.stringify({
    authors: catalog.authors.slice(0, 6),
    works: catalog.works.slice(0, 21),
    audioAssets: catalog.audioAssets.slice(0, baselineCatalog.audioAssets.length),
    batches: catalog.batches.slice(0, baselineCatalog.batches.length),
    candidateCounts: baselineCatalog.candidateCounts,
    creditsRef: catalog.creditsRef,
  }));
  if (
    Buffer.compare(baselineProjectionBytes, preservedProjectionBytes) !== 0 ||
    catalog.authors.length !== 7 ||
    catalog.works.length !== 21 + fragment.works.length ||
    catalog.authors.at(-1)?.authorId !== '001779'
  ) {
    throw new F008CatalogError('F008_CATALOG_MERGE_CONFLICT', '既存serialized projectionが変化しました');
  }
  mergedCatalogs.add(catalog);
  return catalog;
}

/**
 * @des DES-F008-010 @fun FUN-F008-011
 */
export function isMintedF008MergedCatalog(value: unknown): value is F008MergedCatalog {
  return isRecord(value) && mergedCatalogs.has(value) && value.__brand === 'F008MergedCatalog';
}

/**
 * 7作者slugと固定global routeからexact 10 routeを導出する。
 * @des DES-F008-010 @fun FUN-F008-012 @ut UT-F008-012
 */
export function deriveF008RouteSet(
  catalog: F008MergedCatalog,
  staticRoutes: readonly string[],
): F008ExpectedRouteSet {
  if (!isMintedF008MergedCatalog(catalog) || catalog.authors.length !== 7) {
    throw new F008CatalogError('F008_ROUTE_SET_INVALID', 'mint済みCatalogまたは作者数が不正です');
  }
  const slugs = catalog.authors.map((author) => author.slug);
  if (
    new Set(slugs).size !== 7 ||
    slugs.some((slug) => !AUTHOR_SLUG.test(slug)) ||
    canonicalJson(staticRoutes) !== canonicalJson(STATIC_ROUTES)
  ) {
    throw new F008CatalogError('F008_ROUTE_SET_INVALID', '作者slugまたは固定route集合が不正です');
  }
  const routes = [
    staticRoutes[0]!,
    ...slugs.map((slug) => `#/authors/${slug}`),
    staticRoutes[1]!,
    staticRoutes[2]!,
  ];
  if (routes.length !== 10 || new Set(routes).size !== routes.length) {
    throw new F008CatalogError('F008_ROUTE_SET_INVALID', '公開routeはexact 10件である必要があります');
  }
  return deepFreeze({ routes, digest: hash(routes) });
}
