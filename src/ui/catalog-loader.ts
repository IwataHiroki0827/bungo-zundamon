import type { AudioAsset, CatalogDialogue, DisplayWork, UICatalog } from './types';
import { hasAnyControlCharacter, hasUnsafeTextControl } from './text-safety';

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

/** @des DES-F001-002 DES-F001-013 @fun FUN-F001-004 */
export function validateCatalog(value: unknown, sourceByteLength: number): UICatalog {
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
