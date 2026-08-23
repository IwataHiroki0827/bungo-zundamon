import { createHash } from 'node:crypto';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import {
  F010_WORKS,
  isVerifiedF010Author,
  type F010VerifiedAuthor,
  type F010WorkId,
} from './f010-source.ts';
import type {
  CatalogAudioAssetV2,
  CatalogCandidateCountV2,
  CatalogV2,
  CatalogWorkNotice,
  CatalogWorkV2,
} from './processing.ts';
import {
  WORK_NOTICE_TEXT,
  type WorkNoticePlacement,
  type WorkNoticeReport,
} from '../notices/work-notices.ts';
import { resolveTrustedExternalLink } from '../notices/trusted-links.ts';

/**
 * F010（梶井基次郎3作品追加）専用のCatalog統合・route導出モジュール。
 *
 * `f009-catalog.ts`の`mergeNewAuthorCatalog009`／`deriveF009RouteSet`と同型の
 * 構造を踏襲する。作者画像実体（PNG）はFUN-F010-014/015（`f010-artwork.ts`の
 * `sealF010ArtworkProvenance`／`verifyF010ArtworkAgainstCatalog`）で生成・
 * provenance検証・既存8作者との非近似重複確認済みであることを前提とする。
 * F009との違いは、baseline（v0.9.0、8作者27作品）と、3作品すべてに
 * `official-content-warning`が0件（DD-F010.md FUN-F010-011）という点である。
 *
 * **注記registryの結線（DD-F010.md FUN-F010-011）**: `work-notices.ts`の
 * `TRUSTED_REGISTRY_BINDINGS`にF010（authorId `000074`）向けのentryは
 * 追加しない（F010は3作品とも`officialContentWarning: true`が1件も存在せず、
 * `TRUSTED_REGISTRY_BINDINGS`が対象とする「公式表現注意」機構自体を必要と
 * しないため）。代わりに`content/batches/F010/work-notices.json`を
 * ローカルの静的経路で直接読み込み、`dialogue-excerpt-scope`の3件だけを
 * Catalog fragmentへjoinする軽量関数`loadF010WorkNotices(workspace)`を
 * 本ファイル内に実装する。これにより新規application分岐は一切追加せず、
 * データ（registry JSON）だけでF010固有の基礎notice表示を実現する。
 * @des DES-F010-010 @fun FUN-F010-011 FUN-F010-012
 */

const SHA256 = /^[0-9a-f]{64}$/u;
const AUTHOR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STATIC_ROUTES = Object.freeze(['#/', '#/favorites', '#/credits'] as const);
const F010_ARTWORK_PATH = 'artwork/kajii-motojiro-zundamon.png';
const F010_WORK_NOTICES_PATH = 'content/batches/F010/work-notices.json';
const SAFE_WORK_ID = /^[0-9]{6}$/u;
const REQUIRED_PLACEMENTS = Object.freeze(['work-list', 'work-detail', 'credits'] as const);

const mergedCatalogs = new WeakSet<object>();

export class F010CatalogError extends Error {
  constructor(
    public readonly code: 'F010_CATALOG_MERGE_CONFLICT' | 'F010_ROUTE_SET_INVALID' | 'F010_WORK_NOTICES_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'F010CatalogError';
  }
}

export interface F010CatalogAuthorArtwork {
  readonly path: typeof F010_ARTWORK_PATH;
  readonly alt: string;
  readonly sha256: string;
}

export interface F010CatalogWorkV2 extends CatalogWorkV2 {
  readonly workId: F010WorkId;
  readonly batchId: 'F010';
  readonly authorId: '000074';
  readonly completionStatus: 'complete';
  readonly notices: CatalogWorkNotice[];
}

export interface F010CatalogFragment {
  readonly batchId: 'F010';
  readonly feature: 'F010';
  readonly authorId: '000074';
  readonly authorArtwork: F010CatalogAuthorArtwork;
  readonly works: readonly F010CatalogWorkV2[];
  readonly audioAssets: readonly CatalogAudioAssetV2[];
  readonly candidateCounts: CatalogCandidateCountV2;
  readonly acceptedAt: string;
  readonly evidenceSha256: Sha256;
}

export interface F010MergedCatalog extends CatalogV2 {
  readonly __brand: 'F010MergedCatalog';
}

export interface F010ExpectedRouteSet {
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

// F010は3作品ともofficial-content-warningが0件で、dialogue-excerpt-scopeのみを持つ
// （DD-F010.md FUN-F010-011）。
const EXPECTED_NOTICE_KEYS: Readonly<Record<F010WorkId, readonly string[]>> = Object.freeze({
  '000424': Object.freeze(['dialogue-excerpt-scope']),
  '000419': Object.freeze(['dialogue-excerpt-scope']),
  '000411': Object.freeze(['dialogue-excerpt-scope']),
});

function assertFragmentWorks(fragment: F010CatalogFragment): void {
  if (fragment.works.length !== F010_WORKS.length) {
    throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', 'fragment worksがexact 3件ではありません');
  }
  const dialogueIds: string[] = [];
  const audioIds = fragment.audioAssets.map((asset) => asset.audioId);
  const referencedAudioIds = new Set<string>();
  fragment.works.forEach((work, index) => {
    const expected = F010_WORKS[index]!;
    const expectedNoticeKeys = EXPECTED_NOTICE_KEYS[expected.workId];
    if (
      work.workId !== expected.workId ||
      work.title !== expected.title ||
      work.cardLink !== expected.cardUrl ||
      work.authorId !== '000074' ||
      work.batchId !== 'F010' ||
      work.completionStatus !== 'complete' ||
      !Array.isArray(work.notices) ||
      new Set(work.notices.map((notice) => notice.textKey)).size !== expectedNoticeKeys.length ||
      !expectedNoticeKeys.every((key) => work.notices.some((notice) => notice.textKey === key)) ||
      work.notices.some((notice) => notice.textKey === 'official-content-warning')
    ) {
      throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', `fragment workがF010_WORKSまたは注記と一致しません: ${expected.workId}`);
    }
    for (const dialogue of work.dialogues) {
      if (dialogue.workId !== work.workId) {
        throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', 'dialogue.workIdがworkと一致しません');
      }
      dialogueIds.push(dialogue.dialogueId);
      referencedAudioIds.add(dialogue.audioId);
    }
  });
  if (new Set(dialogueIds).size !== dialogueIds.length) {
    throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', 'fragment内dialogue IDが重複しています');
  }
  if (new Set(audioIds).size !== audioIds.length) {
    throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', 'fragment内audio IDが重複しています');
  }
  for (const audioId of referencedAudioIds) {
    if (!audioIds.includes(audioId)) {
      throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', `参照audio assetが不足しています: ${audioId}`);
    }
  }
  for (const asset of fragment.audioAssets) {
    if (asset.batchId !== 'F010') {
      throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', 'audio assetのbatchIdがF010ではありません');
    }
  }
}

function assertArtwork(artwork: F010CatalogAuthorArtwork): void {
  if (
    !isRecord(artwork) ||
    artwork.path !== F010_ARTWORK_PATH ||
    !isNonBlank(artwork.alt) ||
    typeof artwork.sha256 !== 'string' ||
    !SHA256.test(artwork.sha256)
  ) {
    throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', '作者画像bindingが不正です');
  }
}

/**
 * baseline(v0.9.0、8作者27作品)のserialized projectionをexact維持したまま
 * 梶井基次郎の作者・3作品・音声assetを末尾追加する。3作品全ての作品固有
 * 注記はfragment.works[].notices（既存CatalogWorkV2 schema）へcaller供給の
 * まま結合し、application分岐は追加しない。3作品全てが`dialogue-excerpt-scope`
 * のみで`official-content-warning`を1件も含まないことを検証する。
 * @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011
 */
export function mergeNewAuthorCatalog010(
  baselineCatalog: CatalogV2,
  fragment: F010CatalogFragment,
  verifiedAuthor: F010VerifiedAuthor,
): F010MergedCatalog {
  if (
    !isVerifiedF010Author(verifiedAuthor) ||
    !isRecord(fragment) ||
    fragment.batchId !== 'F010' ||
    fragment.feature !== 'F010' ||
    fragment.authorId !== verifiedAuthor.authorId ||
    !isNonBlank(fragment.acceptedAt) ||
    !Number.isFinite(Date.parse(fragment.acceptedAt)) ||
    typeof fragment.evidenceSha256 !== 'string' ||
    !SHA256.test(fragment.evidenceSha256)
  ) {
    throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', 'fragment/検証済み作者identityが不正です');
  }
  assertArtwork(fragment.authorArtwork);
  assertFragmentWorks(fragment);
  if (
    !isRecord(baselineCatalog) ||
    !Array.isArray(baselineCatalog.authors) || baselineCatalog.authors.length !== 8 ||
    !Array.isArray(baselineCatalog.works) || baselineCatalog.works.length !== 27 ||
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
    baselineCatalog.batches.some((batch) => batch.batchId === 'F010')
  ) {
    throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', 'baseline joinまたは作者/作品/asset IDが競合しています');
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
      introducedByBatchId: 'F010',
      identitySha256: verifiedAuthor.identitySha256,
    }],
    works: [...clone(baselineCatalog.works), ...clone(fragment.works)],
    audioAssets: [...clone(baselineCatalog.audioAssets), ...clone(fragment.audioAssets)],
    batches: [...clone(baselineCatalog.batches), {
      batchId: 'F010',
      feature: 'F010',
      status: 'accepted',
      authorId: '000074',
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
      byBatch: { ...clone(baselineCatalog.candidateCounts.byBatch), F010: clone(counts) },
    },
    __brand: 'F010MergedCatalog' as const,
  }) as unknown as F010MergedCatalog;
  const preservedProjectionBytes = new TextEncoder().encode(JSON.stringify({
    authors: catalog.authors.slice(0, 8),
    works: catalog.works.slice(0, 27),
    audioAssets: catalog.audioAssets.slice(0, baselineCatalog.audioAssets.length),
    batches: catalog.batches.slice(0, baselineCatalog.batches.length),
    candidateCounts: baselineCatalog.candidateCounts,
    creditsRef: catalog.creditsRef,
  }));
  if (
    Buffer.compare(baselineProjectionBytes, preservedProjectionBytes) !== 0 ||
    catalog.authors.length !== 9 ||
    catalog.works.length !== 27 + fragment.works.length ||
    catalog.authors.at(-1)?.authorId !== '000074'
  ) {
    throw new F010CatalogError('F010_CATALOG_MERGE_CONFLICT', '既存serialized projectionが変化しました');
  }
  mergedCatalogs.add(catalog);
  return catalog;
}

/**
 * @des DES-F010-010 @fun FUN-F010-011
 */
export function isMintedF010MergedCatalog(value: unknown): value is F010MergedCatalog {
  return isRecord(value) && mergedCatalogs.has(value) && value.__brand === 'F010MergedCatalog';
}

/**
 * 9作者slugと固定global routeからexact 12 routeを導出する。
 * @des DES-F010-010 @fun FUN-F010-012 @ut UT-F010-012
 */
export function deriveF010RouteSet(
  catalog: F010MergedCatalog,
  staticRoutes: readonly string[],
): F010ExpectedRouteSet {
  if (!isMintedF010MergedCatalog(catalog) || catalog.authors.length !== 9) {
    throw new F010CatalogError('F010_ROUTE_SET_INVALID', 'mint済みCatalogまたは作者数が不正です');
  }
  const slugs = catalog.authors.map((author) => author.slug);
  if (
    new Set(slugs).size !== 9 ||
    slugs.some((slug) => !AUTHOR_SLUG.test(slug)) ||
    canonicalJson(staticRoutes) !== canonicalJson(STATIC_ROUTES)
  ) {
    throw new F010CatalogError('F010_ROUTE_SET_INVALID', '作者slugまたは固定route集合が不正です');
  }
  const routes = [
    staticRoutes[0]!,
    ...slugs.map((slug) => `#/authors/${slug}`),
    staticRoutes[1]!,
    staticRoutes[2]!,
  ];
  if (routes.length !== 12 || new Set(routes).size !== routes.length) {
    throw new F010CatalogError('F010_ROUTE_SET_INVALID', '公開routeはexact 12件である必要があります');
  }
  return deepFreeze({ routes, digest: hash(routes) });
}

// ---------------------------------------------------------------------------
// loadF010WorkNotices: TRUSTED_REGISTRY_BINDINGSへF010 entryを追加しないため
// （DD-F010.md FUN-F010-011）、content/batches/F010/work-notices.jsonを
// ローカル静的経路から直接読み込み、dialogue-excerpt-scopeの3件をWorkNoticeReport
// 形状で返す軽量関数。既存work-notices.tsのloadAndValidateWorkNotices／
// validateWorkNoticesAndCreditsはTRUSTED_REGISTRY_BINDINGS参照を内部で必須と
// するため呼び出さない（型・WORK_NOTICE_TEXT定数・resolveTrustedExternalLinkは
// そのまま再利用する）。
// ---------------------------------------------------------------------------

const F010_EXPECTED_WORK_NOTICES: Readonly<Record<F010WorkId, { readonly title: string; readonly cardUrl: string }>> =
  Object.freeze(Object.fromEntries(F010_WORKS.map((work) => [
    work.workId,
    { title: work.title, cardUrl: work.cardUrl },
  ]))) as Readonly<Record<F010WorkId, { readonly title: string; readonly cardUrl: string }>>;

function exactPlacements(value: unknown): value is readonly WorkNoticePlacement[] {
  return Array.isArray(value) && value.length === REQUIRED_PLACEMENTS.length &&
    REQUIRED_PLACEMENTS.every((placement) => value.includes(placement)) &&
    new Set(value).size === value.length;
}

/**
 * F010ローカルの`content/batches/F010/work-notices.json`だけを安全に読み、
 * 3作品全てが`dialogue-excerpt-scope`のみを持ち`official-content-warning`を
 * 1件も含まないことを検証したうえでWorkNoticeReport形状のjoin結果を返す。
 * `TRUSTED_REGISTRY_BINDINGS`（`work-notices.ts`）は参照しない。
 * @des DES-F010-010 @fun FUN-F010-011 @ut UT-F010-011
 */
export async function loadF010WorkNotices(workspace: string): Promise<WorkNoticeReport> {
  if (!isAbsolute(workspace)) {
    throw new F010CatalogError('F010_WORK_NOTICES_INVALID', 'workspaceは絶対pathが必要です');
  }
  const root = resolve(workspace);
  const target = resolve(root, ...F010_WORK_NOTICES_PATH.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`)) {
    throw new F010CatalogError('F010_WORK_NOTICES_INVALID', 'notice registry pathがworkspace外です');
  }
  let raw: string;
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error('unsafe workspace');
    }
    let cursor = root;
    for (const part of relation.split(sep)) {
      cursor = `${cursor}${sep}${part}`;
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error('reparse point');
    }
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || await realpath(target) !== target) {
      throw new Error('unsafe registry');
    }
    raw = await readFile(target, 'utf8');
  } catch (error) {
    if (error instanceof F010CatalogError) throw error;
    throw new F010CatalogError('F010_WORK_NOTICES_INVALID', '固定notice registryを安全に読み込めません');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new F010CatalogError('F010_WORK_NOTICES_INVALID', 'notice registryが不正なJSONです');
  }
  if (
    raw !== canonicalJson(parsed) ||
    !isRecord(parsed) ||
    parsed.schemaVersion !== '1.0.0' ||
    parsed.authorId !== '000074' ||
    !Array.isArray(parsed.works) ||
    parsed.works.length !== F010_WORKS.length
  ) {
    throw new F010CatalogError('F010_WORK_NOTICES_INVALID', 'notice registry schemaが不正です');
  }
  const noticeWorks: readonly unknown[] = parsed.works;
  const works = F010_WORKS.map((expected, index) => {
    const entry = noticeWorks[index];
    const expectedMeta = F010_EXPECTED_WORK_NOTICES[expected.workId]!;
    if (
      !isRecord(entry) ||
      entry.workId !== expected.workId ||
      entry.title !== expectedMeta.title ||
      entry.cardUrl !== expectedMeta.cardUrl ||
      entry.completionStatus !== 'complete' ||
      !SAFE_WORK_ID.test(String(entry.workId)) ||
      !Array.isArray(entry.notices) ||
      entry.notices.length !== 1 ||
      !isRecord(entry.notices[0]) ||
      entry.notices[0].textKey !== 'dialogue-excerpt-scope' ||
      !exactPlacements(entry.notices[0].placements)
    ) {
      throw new F010CatalogError('F010_WORK_NOTICES_INVALID', `作品noticeがF010固定値と一致しません: ${expected.workId}`);
    }
    const placements = Object.freeze([...(entry.notices[0].placements as readonly WorkNoticePlacement[])]);
    const link = resolveTrustedExternalLink(expectedMeta.cardUrl, 'aozora-card');
    return Object.freeze({
      workId: expected.workId,
      title: expectedMeta.title,
      completionStatus: 'complete' as const,
      cardUrl: expectedMeta.cardUrl,
      notices: Object.freeze([Object.freeze({
        textKey: 'dialogue-excerpt-scope' as const,
        placements,
      })]),
      links: Object.freeze([link]),
      renderedNotices: Object.freeze([Object.freeze({
        textKey: 'dialogue-excerpt-scope' as const,
        text: WORK_NOTICE_TEXT['dialogue-excerpt-scope'],
        placements,
      })]),
    });
  });
  return Object.freeze({
    result: 'pass' as const,
    authorId: '000074',
    works: Object.freeze(works),
  });
}
