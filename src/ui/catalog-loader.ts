import type { AudioAsset, CatalogDialogue, DisplayWork, UICatalog, UICatalogV2 } from './types';
import { hasAnyControlCharacter, hasUnsafeTextControl } from './text-safety.ts';

export const MAX_CATALOG_BYTES = 8_388_608;
export const MAX_JSON_DEPTH = 64;
const MAX_STRING_SCALARS = 32_768;
const SAFE_ID = /^[A-Za-z0-9._~-]{1,256}$/u;
const SAFE_ASSET = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*:).+$/u;
const SHA256 = /^[a-f\d]{64}$/iu;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const INITIAL_WORKS = new Map([
  ['000127', '羅生門'],
  ['000092', '蜘蛛の糸'],
  ['043015', '杜子春'],
]);
const INITIAL_WORK_CARD_PATHS = new Map([
  ['000127', '/cards/000879/card127.html'],
  ['000092', '/cards/000879/card92.html'],
  ['043015', '/cards/000879/card43015.html'],
]);
const INITIAL_WORK_TEXT_PATHS = new Map([
  ['000127', '/cards/000879/files/127_15260.html'],
  ['000092', '/cards/000879/files/92_14545.html'],
  ['043015', '/cards/000879/files/43015_17432.html'],
]);
const INITIAL_SOURCE_METADATA = new Map([
  ['000127', { baseEdition: '芥川龍之介全集1', inputter: '野口英司、平山誠', proofreader: 'もりみつじゅんじ' }],
  ['000092', { baseEdition: '芥川龍之介全集2', inputter: '野口英司、平山誠', proofreader: 'もりみつじゅんじ' }],
  ['043015', { baseEdition: '蜘蛛の糸・杜子春', inputter: '蒋龍', proofreader: 'noriko saito' }],
]);
const SOURCE_TRANSFORMATION = '公式XHTMLを宣言charsetでdecodeし、「」候補を抽出して表示文・読み上げ文へ決定的に正規化';
const AUTHOR_ARTWORK_PATH = 'artwork/akutagawa-zundamon.png';
const AUTHOR_ARTWORK_ALT = '文豪風の装いで本を持つ、あくたがわずんのすけのイラスト';

export class CatalogLoadError extends Error {
  constructor(public readonly code: string) {
    super(`catalog-load-failed:${code}`);
    this.name = 'CatalogLoadError';
  }
}

/** @des DES-F001-015 @fun FUN-F001-030 */
export function publicBaseUrl(currentLocation: Pick<Location, 'origin'>, viteBase: string): URL {
  if (viteBase !== '/bungo-zundamon/') throw new CatalogLoadError('public-base-invalid');
  let origin: URL;
  try {
    origin = new URL(currentLocation.origin);
  } catch {
    throw new CatalogLoadError('public-origin-invalid');
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    throw new CatalogLoadError('public-origin-invalid');
  }
  const base = new URL(viteBase, origin);
  if (base.origin !== origin.origin || base.pathname !== viteBase || !base.href.endsWith('/')) {
    throw new CatalogLoadError('public-base-invalid');
  }
  return base;
}

/** @des DES-F001-013 @fun FUN-F001-028 */
export function resolvePublicAsset(base: URL, relativePath: string): URL {
  if (!SAFE_ASSET.test(relativePath) || hasAnyControlCharacter(relativePath)) {
    throw new CatalogLoadError('unsafe-asset-path');
  }
  const normalizedBase = new URL(base.href.endsWith('/') ? base.href : `${base.href}/`);
  const resolved = new URL(relativePath, normalizedBase);
  if (resolved.origin !== normalizedBase.origin || !resolved.pathname.startsWith(normalizedBase.pathname)) {
    throw new CatalogLoadError('asset-outside-base');
  }
  return resolved;
}

function assertRecord(value: unknown, code: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CatalogLoadError(code);
  }
}

function requiredString(value: unknown, code: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    Array.from(value).length > MAX_STRING_SCALARS ||
    hasUnsafeTextControl(value)
  ) {
    throw new CatalogLoadError(code);
  }
  return value;
}

function requiredId(value: unknown, code: string): string {
  const id = requiredString(value, code);
  if (!SAFE_ID.test(id)) throw new CatalogLoadError(code);
  return id;
}

function requiredInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CatalogLoadError(code);
  return value as number;
}

function requiredPositiveInteger(value: unknown, code: string): number {
  const result = requiredInteger(value, code);
  if (result === 0) throw new CatalogLoadError(code);
  return result;
}

function requiredHash(value: unknown, code: string): string {
  const hash = requiredString(value, code);
  if (!SHA256.test(hash)) throw new CatalogLoadError(code);
  return hash;
}

function requiredInstant(value: unknown, code: string): string {
  const instant = requiredString(value, code);
  if (!RFC3339.test(instant) || !Number.isFinite(Date.parse(instant))) throw new CatalogLoadError(code);
  return instant;
}

function validateJsonResourceLimits(value: unknown): void {
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new CatalogLoadError('catalog-depth-invalid');
    if (typeof current === 'string') {
      if (Array.from(current).length > MAX_STRING_SCALARS || hasUnsafeTextControl(current)) {
        throw new CatalogLoadError('catalog-string-invalid');
      }
      return;
    }
    if (typeof current === 'number' && !Number.isFinite(current)) {
      throw new CatalogLoadError('catalog-number-invalid');
    }
    if (current === null || typeof current !== 'object') return;
    if (ancestors.has(current)) throw new CatalogLoadError('catalog-cycle-invalid');
    ancestors.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else {
      for (const [key, nested] of Object.entries(current)) {
        if (Array.from(key).length > MAX_STRING_SCALARS || hasAnyControlCharacter(key)) {
          throw new CatalogLoadError('catalog-key-invalid');
        }
        visit(nested, depth + 1);
      }
    }
    ancestors.delete(current);
  };
  visit(value, 1);
}

function validateAozoraLink(value: unknown, code: string): string {
  const raw = requiredString(value, code);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CatalogLoadError(code);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.aozora.gr.jp' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.startsWith('/cards/000879/')
  ) {
    throw new CatalogLoadError(code);
  }
  return url.href;
}

function validateAozoraCardLink(value: unknown, workId: string, code: string): string {
  const raw = requiredString(value, code);
  const href = validateAozoraLink(value, code);
  const expectedPath = INITIAL_WORK_CARD_PATHS.get(workId);
  const expectedUrl = expectedPath ? `https://www.aozora.gr.jp${expectedPath}` : null;
  if (!expectedUrl || raw !== expectedUrl || href !== expectedUrl) throw new CatalogLoadError(code);
  return href;
}

function validateAozoraTextLink(value: unknown, workId: string, code: string): string {
  const raw = requiredString(value, code);
  const href = validateAozoraLink(value, code);
  const expectedPath = INITIAL_WORK_TEXT_PATHS.get(workId);
  const expectedUrl = expectedPath ? `https://www.aozora.gr.jp${expectedPath}` : null;
  if (!expectedUrl || raw !== expectedUrl || href !== expectedUrl) throw new CatalogLoadError(code);
  return href;
}

function validateDialogue(value: unknown, ids: Set<string>, audioIds: Set<string>): CatalogDialogue {
  assertRecord(value, 'dialogue-invalid');
  const dialogueId = requiredId(value.dialogueId, 'dialogue-id-invalid');
  if (ids.has(dialogueId)) throw new CatalogLoadError('dialogue-id-duplicate');
  ids.add(dialogueId);
  requiredInteger(value.order, 'dialogue-order-invalid');
  requiredString(value.displayText, 'dialogue-display-text-invalid');
  requiredString(value.speechText, 'dialogue-speech-text-invalid');
  const audioId = requiredId(value.audioId, 'dialogue-audio-id-invalid');
  if (!audioIds.has(audioId)) throw new CatalogLoadError('dialogue-audio-missing');
  assertRecord(value.sourceAnchor, 'source-anchor-invalid');
  requiredString(value.sourceAnchor.bodySelector, 'source-anchor-selector-invalid');
  const startToken = requiredInteger(value.sourceAnchor.startToken, 'source-anchor-start-invalid');
  const endToken = requiredInteger(value.sourceAnchor.endToken, 'source-anchor-end-invalid');
  if (endToken <= startToken) throw new CatalogLoadError('source-anchor-range-invalid');
  assertRecord(value.review, 'review-invalid');
  if (requiredId(value.review.candidateId, 'review-candidate-id-invalid') !== dialogueId) {
    throw new CatalogLoadError('review-candidate-mismatch');
  }
  requiredPositiveInteger(value.review.revision, 'review-revision-invalid');
  if (value.review.status !== 'approved') throw new CatalogLoadError('review-status-invalid');
  requiredString(value.review.reasonCode, 'review-reason-invalid');
  if (value.review.note !== undefined) requiredString(value.review.note, 'review-note-invalid');
  requiredString(value.review.reviewer, 'review-reviewer-invalid');
  requiredInstant(value.review.reviewedAt, 'review-reviewed-at-invalid');
  requiredInstant(value.review.policyCheckedAt, 'review-policy-checked-at-invalid');
  return value as unknown as CatalogDialogue;
}

function validateWork(value: unknown, ids: Set<string>, dialogueIds: Set<string>, audioIds: Set<string>): DisplayWork {
  assertRecord(value, 'work-invalid');
  const workId = requiredId(value.workId, 'work-id-invalid');
  if (ids.has(workId)) throw new CatalogLoadError('work-id-duplicate');
  ids.add(workId);
  const title = requiredString(value.title, 'work-title-invalid');
  if (INITIAL_WORKS.get(workId) !== title) throw new CatalogLoadError('work-title-or-id-invalid');
  const workCardUrl = validateAozoraCardLink(value.cardLink, workId, 'work-card-link-invalid');
  assertRecord(value.source, 'work-source-invalid');
  const cardUrl = validateAozoraCardLink(value.source.cardUrl, workId, 'work-source-link-invalid');
  if (cardUrl !== workCardUrl) throw new CatalogLoadError('work-source-card-mismatch');
  validateAozoraTextLink(value.source.textUrl, workId, 'work-source-text-link-invalid');
  const metadata = INITIAL_SOURCE_METADATA.get(workId);
  if (!metadata || value.source.attribution !== `青空文庫『${title}』（芥川龍之介）`) {
    throw new CatalogLoadError('work-source-attribution-invalid');
  }
  if (value.source.baseEdition !== metadata.baseEdition) throw new CatalogLoadError('work-source-base-edition-invalid');
  if (value.source.inputter !== metadata.inputter) throw new CatalogLoadError('work-source-inputter-invalid');
  if (value.source.proofreader !== metadata.proofreader) throw new CatalogLoadError('work-source-proofreader-invalid');
  requiredInstant(value.source.fetchedAt, 'work-source-fetched-at-invalid');
  if (value.source.transformation !== SOURCE_TRANSFORMATION) throw new CatalogLoadError('work-source-transformation-invalid');
  requiredHash(value.source.sourceSha256, 'work-source-sha256-invalid');
  if (!Array.isArray(value.dialogues)) throw new CatalogLoadError('dialogues-invalid');
  value.dialogues.forEach((dialogue) => validateDialogue(dialogue, dialogueIds, audioIds));
  return value as unknown as DisplayWork;
}

function validateAudio(value: unknown, ids: Set<string>): AudioAsset {
  assertRecord(value, 'audio-invalid');
  const audioId = requiredId(value.audioId, 'audio-id-invalid');
  if (ids.has(audioId)) throw new CatalogLoadError('audio-id-duplicate');
  ids.add(audioId);
  resolvePublicAsset(new URL('https://catalog.invalid/bungo-zundamon/'), requiredString(value.path, 'audio-path-invalid'));
  requiredHash(value.sha256, 'audio-sha256-invalid');
  requiredHash(value.configHash, 'audio-config-hash-invalid');
  if (!Number.isFinite(value.durationMs) || (value.durationMs as number) <= 0) {
    throw new CatalogLoadError('audio-duration-invalid');
  }
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) {
    throw new CatalogLoadError('audio-bytes-invalid');
  }
  return value as unknown as AudioAsset;
}

function validateReasonCounts(value: unknown, expected: number, code: string): void {
  assertRecord(value, code);
  let total = 0;
  for (const [reason, count] of Object.entries(value)) {
    requiredString(reason, code);
    total += requiredPositiveInteger(count, code);
  }
  if (total !== expected) throw new CatalogLoadError(code);
}

export type CatalogV2ErrorCode =
  | 'CATALOG_RESOURCE_LIMIT'
  | 'CATALOG_DUPLICATE_ID'
  | 'CATALOG_ORPHAN_REFERENCE'
  | 'CATALOG_AUTHOR_MIXED'
  | 'CATALOG_PATH_UNSAFE'
  | 'CATALOG_COUNT_MISMATCH';

export type CatalogV2ValidationResult =
  | { readonly ok: true; readonly success: true; readonly value: UICatalogV2; readonly issues: readonly [] }
  | { readonly ok: false; readonly success: false; readonly error: Readonly<{ code: CatalogV2ErrorCode }>; readonly issues: readonly [{ code: CatalogV2ErrorCode }] };

function failV2(code: CatalogV2ErrorCode): never {
  throw new CatalogLoadError(code);
}

function v2Record(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) failV2('CATALOG_ORPHAN_REFERENCE');
}

function v2String(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || Array.from(value).length > MAX_STRING_SCALARS || hasUnsafeTextControl(value)) {
    failV2('CATALOG_ORPHAN_REFERENCE');
  }
  return value;
}

function v2Id(value: unknown): string {
  const id = v2String(value);
  if (!SAFE_ID.test(id)) failV2('CATALOG_ORPHAN_REFERENCE');
  return id;
}

function v2Hash(value: unknown): string {
  const hash = v2String(value);
  if (!SHA256.test(hash)) failV2('CATALOG_ORPHAN_REFERENCE');
  return hash;
}

function v2Integer(value: unknown, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) failV2('CATALOG_COUNT_MISMATCH');
  return value as number;
}

function v2Instant(value: unknown): string {
  const instant = v2String(value);
  if (!RFC3339.test(instant) || !Number.isFinite(Date.parse(instant))) failV2('CATALOG_ORPHAN_REFERENCE');
  return instant;
}

function v2Path(value: unknown): string {
  const path = v2String(value);
  if (
    path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || path.includes('?') || path.includes('#') ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(path) || /%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(path) ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    failV2('CATALOG_PATH_UNSAFE');
  }
  try {
    resolvePublicAsset(new URL('https://catalog.invalid/bungo-zundamon/'), path);
  } catch {
    failV2('CATALOG_PATH_UNSAFE');
  }
  return path;
}

function v2AozoraUrl(value: unknown, authorId: string, workId: string, kind: 'card' | 'text'): string {
  const raw = v2String(value);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return failV2('CATALOG_PATH_UNSAFE');
  }
  const numericWorkId = workId.replace(/^0+/u, '') || '0';
  const cardPattern = new RegExp(`^/cards/${authorId}/card0*${numericWorkId}\\.html$`, 'u');
  const textPattern = new RegExp(`^/cards/${authorId}/files/0*${numericWorkId}(?:_|\\.)[^/]*\\.html$`, 'u');
  if (
    raw !== url.href || url.protocol !== 'https:' || url.hostname !== 'www.aozora.gr.jp' || url.username || url.password ||
    url.port || url.search || url.hash || /%2e|%2f|%5c/iu.test(url.pathname) || url.pathname.includes('\\') ||
    (kind === 'card' ? !cardPattern.test(url.pathname) : !textPattern.test(url.pathname))
  ) {
    failV2('CATALOG_PATH_UNSAFE');
  }
  return url.href;
}

interface ParsedCounts {
  readonly total: number;
  readonly published: number;
  readonly editorialExcluded: number;
  readonly audioExcluded: number;
}

function v2Counts(value: unknown): ParsedCounts {
  v2Record(value);
  const result = {
    total: v2Integer(value.total),
    published: v2Integer(value.published),
    editorialExcluded: v2Integer(value.editorialExcluded),
    audioExcluded: v2Integer(value.audioExcluded),
  };
  if (result.total !== result.published + result.editorialExcluded + result.audioExcluded) {
    failV2('CATALOG_COUNT_MISMATCH');
  }
  if (value.editorialReasons !== undefined) validateReasonCounts(value.editorialReasons, result.editorialExcluded, 'CATALOG_COUNT_MISMATCH');
  if (value.audioFailureReasons !== undefined) validateReasonCounts(value.audioFailureReasons, result.audioExcluded, 'CATALOG_COUNT_MISMATCH');
  return result;
}

function parseCatalogV2(value: unknown): UICatalogV2 {
  v2Record(value);
  if (value.schemaVersion !== '2.0.0' || !Array.isArray(value.batches) || value.batches.length === 0) {
    failV2('CATALOG_ORPHAN_REFERENCE');
  }

  const batchIds = new Set<string>();
  const listedWorkIds = new Set<string>();
  const batchAuthors = new Map<string, string>();
  const expectedWorksByBatch = new Map<string, Set<string>>();
  for (const batch of value.batches) {
    v2Record(batch);
    const batchId = v2Id(batch.batchId);
    if (!/^F[0-9]{3}$/u.test(batchId) || batchIds.has(batchId)) failV2('CATALOG_DUPLICATE_ID');
    batchIds.add(batchId);
    v2Id(batch.feature);
    if (batch.status !== 'accepted' && batch.status !== 'published') failV2('CATALOG_ORPHAN_REFERENCE');
    const authorId = v2Id(batch.authorId);
    if (!/^[0-9]{6}$/u.test(authorId)) failV2('CATALOG_ORPHAN_REFERENCE');
    batchAuthors.set(batchId, authorId);
    if (!Array.isArray(batch.workIds) || batch.workIds.length === 0) failV2('CATALOG_ORPHAN_REFERENCE');
    const workIds = new Set<string>();
    for (const workIdValue of batch.workIds) {
      const workId = v2Id(workIdValue);
      if (!/^[0-9]{6}$/u.test(workId)) failV2('CATALOG_ORPHAN_REFERENCE');
      if (workIds.has(workId) || listedWorkIds.has(workId)) failV2('CATALOG_DUPLICATE_ID');
      workIds.add(workId);
      listedWorkIds.add(workId);
    }
    expectedWorksByBatch.set(batchId, workIds);
    v2Instant(batch.acceptedAt);
    if (batch.status === 'published') v2Instant(batch.publishedAt);
    else if (batch.publishedAt !== undefined) failV2('CATALOG_ORPHAN_REFERENCE');
    v2Hash(batch.evidenceSha256);
  }

  if (!Array.isArray(value.authors) || value.authors.length === 0) failV2('CATALOG_ORPHAN_REFERENCE');
  const authorIds = new Set<string>();
  const authorSlugs = new Set<string>();
  for (const author of value.authors) {
    v2Record(author);
    const authorId = v2Id(author.authorId);
    if (!/^[0-9]{6}$/u.test(authorId)) failV2('CATALOG_ORPHAN_REFERENCE');
    const slug = v2String(author.slug);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) failV2('CATALOG_ORPHAN_REFERENCE');
    if (authorIds.has(authorId) || authorSlugs.has(slug)) failV2('CATALOG_DUPLICATE_ID');
    authorIds.add(authorId);
    authorSlugs.add(slug);
    v2String(author.name);
    v2String(author.originalName);
    v2Hash(author.identitySha256);
    const introducedBy = v2Id(author.introducedByBatchId);
    if (!batchIds.has(introducedBy)) failV2('CATALOG_ORPHAN_REFERENCE');
    if (batchAuthors.get(introducedBy) !== authorId) failV2('CATALOG_AUTHOR_MIXED');
    v2Record(author.artwork);
    v2Path(author.artwork.path);
    v2String(author.artwork.alt);
    v2Hash(author.artwork.sha256);
  }
  for (const authorId of batchAuthors.values()) if (!authorIds.has(authorId)) failV2('CATALOG_ORPHAN_REFERENCE');

  if (!Array.isArray(value.audioAssets)) failV2('CATALOG_ORPHAN_REFERENCE');
  const audioIds = new Set<string>();
  for (const audio of value.audioAssets) {
    v2Record(audio);
    const audioId = v2Id(audio.audioId);
    if (audioIds.has(audioId)) failV2('CATALOG_DUPLICATE_ID');
    audioIds.add(audioId);
    if (!batchIds.has(v2Id(audio.batchId))) failV2('CATALOG_ORPHAN_REFERENCE');
    v2Path(audio.path);
    v2Hash(audio.sha256);
    v2Hash(audio.configHash);
    v2Integer(audio.bytes, true);
    if (typeof audio.durationMs !== 'number' || !Number.isFinite(audio.durationMs) || audio.durationMs <= 0) {
      failV2('CATALOG_COUNT_MISMATCH');
    }
  }

  if (!Array.isArray(value.works) || value.works.length === 0) failV2('CATALOG_ORPHAN_REFERENCE');
  const workIds = new Set<string>();
  const dialogueIds = new Set<string>();
  const referencedAudio = new Set<string>();
  const actualWorksByBatch = new Map<string, Set<string>>();
  const workCountsByAuthor = new Map<string, number>();
  const dialogueCountsByBatch = new Map<string, number>();
  for (const work of value.works) {
    v2Record(work);
    const workId = v2Id(work.workId);
    if (!/^[0-9]{6}$/u.test(workId)) failV2('CATALOG_ORPHAN_REFERENCE');
    if (workIds.has(workId)) failV2('CATALOG_DUPLICATE_ID');
    workIds.add(workId);
    const authorId = v2Id(work.authorId);
    const batchId = v2Id(work.batchId);
    if (!authorIds.has(authorId) || !batchIds.has(batchId)) failV2('CATALOG_ORPHAN_REFERENCE');
    if (batchAuthors.get(batchId) !== authorId) failV2('CATALOG_AUTHOR_MIXED');
    if (!expectedWorksByBatch.get(batchId)?.has(workId)) failV2('CATALOG_ORPHAN_REFERENCE');
    const actualBatchWorks = actualWorksByBatch.get(batchId) ?? new Set<string>();
    actualBatchWorks.add(workId);
    actualWorksByBatch.set(batchId, actualBatchWorks);
    workCountsByAuthor.set(authorId, (workCountsByAuthor.get(authorId) ?? 0) + 1);
    v2String(work.title);
    const cardLink = v2AozoraUrl(work.cardLink, authorId, workId, 'card');
    v2Record(work.source);
    if (v2AozoraUrl(work.source.cardUrl, authorId, workId, 'card') !== cardLink) failV2('CATALOG_PATH_UNSAFE');
    v2AozoraUrl(work.source.textUrl, authorId, workId, 'text');
    for (const field of ['attribution', 'baseEdition', 'inputter', 'proofreader', 'transformation'] as const) v2String(work.source[field]);
    v2Instant(work.source.fetchedAt);
    v2Hash(work.source.sourceSha256);
    v2Path(work.source.provenancePath);
    v2Hash(work.source.provenanceSha256);
    if (!Array.isArray(work.dialogues)) failV2('CATALOG_ORPHAN_REFERENCE');
    const orders = new Set<number>();
    for (const dialogue of work.dialogues) {
      v2Record(dialogue);
      const dialogueId = v2Id(dialogue.dialogueId);
      if (dialogueIds.has(dialogueId)) failV2('CATALOG_DUPLICATE_ID');
      dialogueIds.add(dialogueId);
      if (v2Id(dialogue.workId) !== workId) failV2('CATALOG_AUTHOR_MIXED');
      const order = v2Integer(dialogue.order);
      if (orders.has(order)) failV2('CATALOG_DUPLICATE_ID');
      orders.add(order);
      v2String(dialogue.displayText);
      v2String(dialogue.speechText);
      const audioId = v2Id(dialogue.audioId);
      if (!audioIds.has(audioId)) failV2('CATALOG_ORPHAN_REFERENCE');
      referencedAudio.add(audioId);
      v2Record(dialogue.sourceAnchor);
      v2String(dialogue.sourceAnchor.bodySelector);
      const start = v2Integer(dialogue.sourceAnchor.startToken);
      const end = v2Integer(dialogue.sourceAnchor.endToken);
      if (end <= start) failV2('CATALOG_ORPHAN_REFERENCE');
      v2Record(dialogue.review);
      if (v2Id(dialogue.review.candidateId) !== dialogueId || dialogue.review.status !== 'approved') failV2('CATALOG_ORPHAN_REFERENCE');
      if (dialogue.review.workId !== undefined && v2Id(dialogue.review.workId) !== workId) failV2('CATALOG_AUTHOR_MIXED');
      if (dialogue.review.policyDecision !== undefined && dialogue.review.policyDecision !== 'allowed') failV2('CATALOG_ORPHAN_REFERENCE');
      v2Integer(dialogue.review.revision, true);
      v2String(dialogue.review.reasonCode);
      v2String(dialogue.review.reviewer);
      v2Instant(dialogue.review.reviewedAt);
      v2Instant(dialogue.review.policyCheckedAt);
      dialogueCountsByBatch.set(batchId, (dialogueCountsByBatch.get(batchId) ?? 0) + 1);
    }
  }
  for (const authorId of authorIds) if ((workCountsByAuthor.get(authorId) ?? 0) === 0) failV2('CATALOG_AUTHOR_MIXED');
  for (const batchId of batchIds) {
    const expected = expectedWorksByBatch.get(batchId) as Set<string>;
    const actual = actualWorksByBatch.get(batchId) ?? new Set<string>();
    if (expected.size !== actual.size || [...expected].some((workId) => !actual.has(workId))) failV2('CATALOG_ORPHAN_REFERENCE');
  }
  if (audioIds.size !== referencedAudio.size) failV2('CATALOG_ORPHAN_REFERENCE');

  v2Record(value.candidateCounts);
  const totalCounts = v2Counts(value.candidateCounts);
  if (totalCounts.published !== dialogueIds.size) failV2('CATALOG_COUNT_MISMATCH');
  v2Record(value.candidateCounts.byBatch);
  const byBatchEntries = Object.entries(value.candidateCounts.byBatch);
  if (byBatchEntries.length !== batchIds.size) failV2('CATALOG_COUNT_MISMATCH');
  const summed = { total: 0, published: 0, editorialExcluded: 0, audioExcluded: 0 };
  for (const [batchId, countsValue] of byBatchEntries) {
    if (!batchIds.has(batchId)) failV2('CATALOG_COUNT_MISMATCH');
    const counts = v2Counts(countsValue);
    if (counts.published !== (dialogueCountsByBatch.get(batchId) ?? 0)) failV2('CATALOG_COUNT_MISMATCH');
    for (const key of Object.keys(summed) as Array<keyof ParsedCounts>) summed[key] += counts[key];
  }
  if ((Object.keys(summed) as Array<keyof ParsedCounts>).some((key) => summed[key] !== totalCounts[key])) {
    failV2('CATALOG_COUNT_MISMATCH');
  }
  v2Path(value.creditsRef);
  return value as unknown as UICatalogV2;
}

/** @des DES-F002-001,DES-F002-006,DES-F002-012 @fun FUN-F002-004 */
export function validateCatalogV2(value: unknown, sourceByteLength: number): CatalogV2ValidationResult {
  try {
    if (!Number.isSafeInteger(sourceByteLength) || sourceByteLength < 0 || sourceByteLength > MAX_CATALOG_BYTES) {
      failV2('CATALOG_RESOURCE_LIMIT');
    }
    try {
      validateJsonResourceLimits(value);
    } catch {
      failV2('CATALOG_RESOURCE_LIMIT');
    }
    return { ok: true, success: true, value: parseCatalogV2(value), issues: [] };
  } catch (error) {
    const code = error instanceof CatalogLoadError && (error.code as CatalogV2ErrorCode).startsWith('CATALOG_')
      ? error.code as CatalogV2ErrorCode
      : 'CATALOG_ORPHAN_REFERENCE';
    return { ok: false, success: false, error: { code }, issues: [{ code }] };
  }
}

/** @des DES-F001-002 DES-F001-013 @fun FUN-F001-004 */
function validateCatalogV1(value: unknown, sourceByteLength: number): UICatalog {
  if (!Number.isSafeInteger(sourceByteLength) || sourceByteLength < 0) {
    throw new CatalogLoadError('catalog-byte-length-invalid');
  }
  if (sourceByteLength > MAX_CATALOG_BYTES) throw new CatalogLoadError('catalog-too-large');
  validateJsonResourceLimits(value);
  assertRecord(value, 'catalog-invalid');
  requiredString(value.schemaVersion, 'schema-version-invalid');
  assertRecord(value.author, 'author-invalid');
  if (requiredId(value.author.authorId, 'author-id-invalid') !== '000879') {
    throw new CatalogLoadError('author-id-invalid');
  }
  if (value.author.name !== 'あくたがわずんのすけ') throw new CatalogLoadError('author-name-invalid');
  if (value.author.slug !== 'akutagawa-zunnosuke') throw new CatalogLoadError('author-slug-invalid');
  if (value.author.originalName !== '芥川龍之介') throw new CatalogLoadError('author-original-name-invalid');
  assertRecord(value.author.artwork, 'author-artwork-invalid');
  if (value.author.artwork.path !== AUTHOR_ARTWORK_PATH) throw new CatalogLoadError('author-artwork-path-invalid');
  resolvePublicAsset(new URL('https://catalog.invalid/bungo-zundamon/'), AUTHOR_ARTWORK_PATH);
  if (value.author.artwork.alt !== AUTHOR_ARTWORK_ALT) throw new CatalogLoadError('author-artwork-alt-invalid');

  if (!Array.isArray(value.audioAssets)) throw new CatalogLoadError('audio-assets-invalid');
  const audioIds = new Set<string>();
  value.audioAssets.forEach((audio) => validateAudio(audio, audioIds));

  if (!Array.isArray(value.works) || value.works.length !== 3) {
    throw new CatalogLoadError('work-count-invalid');
  }
  const workIds = new Set<string>();
  const dialogueIds = new Set<string>();
  const works = value.works.map((work) => validateWork(work, workIds, dialogueIds, audioIds));
  if (workIds.size !== INITIAL_WORKS.size || Array.from(INITIAL_WORKS.keys()).some((workId) => !workIds.has(workId))) {
    throw new CatalogLoadError('work-allowlist-invalid');
  }
  const referencedAudio = new Set(value.works.flatMap((work) => {
    assertRecord(work, 'work-invalid');
    if (!Array.isArray(work.dialogues)) throw new CatalogLoadError('dialogues-invalid');
    return work.dialogues.map((dialogue) => {
      assertRecord(dialogue, 'dialogue-invalid');
      return requiredId(dialogue.audioId, 'dialogue-audio-id-invalid');
    });
  }));
  if (audioIds.size !== referencedAudio.size) throw new CatalogLoadError('orphan-audio-asset');

  assertRecord(value.candidateCounts, 'candidate-counts-invalid');
  const total = requiredInteger(value.candidateCounts.total, 'candidate-total-invalid');
  const published = requiredInteger(value.candidateCounts.published, 'candidate-published-invalid');
  const editorial = requiredInteger(value.candidateCounts.editorialExcluded, 'candidate-editorial-invalid');
  const audio = requiredInteger(value.candidateCounts.audioExcluded, 'candidate-audio-invalid');
  if (total !== published + editorial + audio || published !== dialogueIds.size) {
    throw new CatalogLoadError('candidate-count-mismatch');
  }
  validateReasonCounts(value.candidateCounts.editorialReasons, editorial, 'candidate-editorial-reasons-invalid');
  validateReasonCounts(value.candidateCounts.audioFailureReasons, audio, 'candidate-audio-reasons-invalid');
  requiredString(value.creditsRef, 'credits-ref-invalid');
  resolvePublicAsset(new URL('https://catalog.invalid/bungo-zundamon/'), value.creditsRef as string);
  assertRecord(value.futureExpansionPolicy, 'future-expansion-invalid');
  requiredString(value.futureExpansionPolicy.eligibilityCriteria, 'future-eligibility-invalid');
  requiredString(value.futureExpansionPolicy.rightsRecheck, 'future-rights-invalid');
  requiredString(value.futureExpansionPolicy.stagedAddition, 'future-staged-invalid');
  return { ...(value as unknown as UICatalog), works };
}

/** @des DES-F001-002,DES-F001-013,DES-F002-001,DES-F002-006,DES-F002-012 @fun FUN-F001-004,FUN-F002-004 */
export function validateCatalog(value: unknown, sourceByteLength: number): UICatalog {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === '2.0.0') {
    const result = validateCatalogV2(value, sourceByteLength);
    if (!result.ok) throw new CatalogLoadError(result.error.code);
    // FUN-F002-020〜023の複数作者UI移行までは、既存F001 renderer向けに先頭作者の読み取り専用aliasを返す。
    return { ...result.value, author: result.value.authors[0] } as unknown as UICatalog;
  }
  return validateCatalogV1(value, sourceByteLength);
}

async function readResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_CATALOG_BYTES) throw new CatalogLoadError('catalog-too-large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new CatalogLoadError('catalog-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** @des DES-F001-002 DES-F001-013 DES-F001-015 @fun FUN-F001-003 */
export async function loadCatalog(
  baseUrl: URL,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<UICatalog> {
  const normalizedBase = new URL(baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`);
  if (typeof location !== 'undefined' && normalizedBase.origin !== location.origin) {
    throw new CatalogLoadError('base-origin-invalid');
  }
  let response: Response;
  try {
    response = await fetcher(new URL('content/catalog.json', normalizedBase), {
      signal,
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (error instanceof CatalogLoadError) throw error;
    throw new CatalogLoadError(signal?.aborted ? 'aborted' : 'network');
  }
  if (!response.ok) throw new CatalogLoadError('http');
  const bytes = await readResponse(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CatalogLoadError('decode-or-json');
  }
  return validateCatalog(parsed, bytes.byteLength);
}
