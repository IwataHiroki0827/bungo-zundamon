import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

export const MAX_CATALOG_BYTES = 8_388_608;
export const MAX_STRING_SCALARS = 32_768;
export const SUPPORTED_SPEECH_RULE_VERSION = '1.0.0';
export const EXTRACTOR_VERSION = '1.0.0';

const INITIAL_WORKS: ReadonlyMap<string, string> = new Map([
  ['000127', '羅生門'],
  ['000092', '蜘蛛の糸'],
  ['043015', '杜子春'],
] as const);
const INITIAL_TEXT_PATHS: ReadonlyMap<string, string> = new Map([
  ['000127', '/cards/000879/files/127_15260.html'],
  ['000092', '/cards/000879/files/92_14545.html'],
  ['043015', '/cards/000879/files/43015_17432.html'],
] as const);
const INITIAL_CARD_PATHS: ReadonlyMap<string, string> = new Map([
  ['000127', '/cards/000879/card127.html'],
  ['000092', '/cards/000879/card92.html'],
  ['043015', '/cards/000879/card43015.html'],
] as const);
const INITIAL_SOURCE_METADATA: ReadonlyMap<string, Readonly<{
  baseEdition: string;
  inputter: string;
  proofreader: string;
}>> = new Map([
  ['000127', { baseEdition: '芥川龍之介全集1', inputter: '野口英司、平山誠', proofreader: 'もりみつじゅんじ' }],
  ['000092', { baseEdition: '芥川龍之介全集2', inputter: '野口英司、平山誠', proofreader: 'もりみつじゅんじ' }],
  ['043015', { baseEdition: '蜘蛛の糸・杜子春', inputter: '蒋龍', proofreader: 'noriko saito' }],
] as const);
export const PUBLIC_AUTHOR = Object.freeze({
  authorId: '000879',
  name: 'あくたがわずんのすけ',
  originalName: '芥川龍之介',
  slug: 'akutagawa-zunnosuke',
  artwork: Object.freeze({
    path: 'artwork/akutagawa-zundamon.png',
    alt: '文豪風の装いで本を持つ、あくたがわずんのすけのイラスト',
  }),
});
export const SOURCE_TRANSFORMATION = '公式XHTMLを宣言charsetでdecodeし、「」候補を抽出して表示文・読み上げ文へ決定的に正規化';
const ALLOWED_WORK_IDS = new Set<string>(INITIAL_WORKS.keys());
const AOZORA_ORIGIN = 'https://www.aozora.gr.jp';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[a-f\d]{64}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type DiagnosticCode =
  | 'dom-parser-error'
  | 'dom-parser-unavailable'
  | 'body-missing'
  | 'invalid-ruby'
  | 'invalid-source-hash'
  | 'work-id-mismatch'
  | 'work-id-not-allowed'
  | 'unknown-body-element'
  | 'unmatched-opening-bracket'
  | 'unmatched-closing-bracket';

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  element?: string;
}

export interface TokenRange {
  start: number;
  end: number;
}

export type TextToken =
  | { type: 'text'; value: string }
  | { type: 'ruby'; base: string; reading: string }
  | { type: 'lineBreak' };

export type TextTokenList = TextToken[] & { readonly diagnostics: readonly Diagnostic[] };

export interface DecodedSource {
  workId: string;
  rawSha256: string;
  httpCharset?: string | null;
  metaCharset?: string | null;
  bibliographyCharset?: string | null;
  adoptedCharset: string;
  text: string;
}

export interface SourceAnchor {
  bodySelector: string;
  startToken: number;
  endToken: number;
}

export interface RawCandidate {
  workId: string;
  rawSourceSha256: string;
  order: number;
  rawTokenRange: TokenRange;
  tokens: TextToken[];
  contextBefore: string;
  contextAfter: string;
  sourceAnchor: SourceAnchor;
  extractorVersion: string;
}

export type ExtractionResult =
  | { ok: true; success: true; candidates: RawCandidate[]; diagnostics: Diagnostic[] }
  | { ok: false; success: false; candidates: []; diagnostics: Diagnostic[] };

export interface SpeechRules {
  version: string;
  gaiji?: Readonly<Record<string, string>>;
  gaijiReplacements?: Readonly<Record<string, string>>;
  lineBreak?: 'space' | 'remove';
  collapseWhitespace?: boolean;
}

export interface Candidate {
  candidateId: string;
  workId: string;
  rawSourceSha256: string;
  order: number;
  rawTokenRange: TokenRange;
  displayText: string;
  speechText: string;
  contextBefore: string;
  contextAfter: string;
  sourceAnchor: SourceAnchor;
  extractorVersion: string;
  normalizerVersion: string;
}

export type ReviewStatus = 'approved' | 'rejected' | 'pending';

export const APPROVED_REVIEW_REASON = 'SPOKEN_DIALOGUE' as const;
export const APPROVED_REVIEW_REASONS = Object.freeze([
  APPROVED_REVIEW_REASON,
  'INNER_MONOLOGUE',
] as const);
const APPROVED_REVIEW_REASON_SET = new Set<string>(APPROVED_REVIEW_REASONS);
export const REJECTED_REVIEW_REASONS = Object.freeze([
  'QUOTED_MATERIAL',
  'EXPRESSION_EXAMPLE',
  'NON_SPEECH',
  'EXTRACTION_ARTIFACT',
  'POLICY_EXCLUDED',
] as const);
const REJECTED_REVIEW_REASON_SET = new Set<string>(REJECTED_REVIEW_REASONS);

export interface ReviewRecord {
  candidateId: string;
  revision: number;
  status: ReviewStatus;
  reasonCode: string;
  note?: string;
  reviewer: string;
  reviewedAt: string;
  policyCheckedAt: string;
}

export interface ReviewedCandidate {
  candidate: Candidate;
  review: ReviewRecord;
}

export interface ReviewResult {
  approved: ReviewedCandidate[];
  rejected: ReviewedCandidate[];
  pending: ReviewedCandidate[];
  all: ReviewedCandidate[];
  counts: Record<ReviewStatus, number>;
  reasonCounts: Record<string, number>;
}

export interface CatalogAuthor {
  authorId: string;
  name: string;
  originalName: string;
  slug: string;
  artwork: {
    path: string;
    alt: string;
  };
}

export interface CatalogSource {
  cardUrl: string;
  textUrl: string;
  attribution: string;
  baseEdition: string;
  inputter: string;
  proofreader: string;
  fetchedAt: string;
  transformation: string;
  sourceSha256: string;
}

export interface ReviewedWork {
  workId: string;
  title: string;
  cardLink: string;
  source: CatalogSource;
  candidateIds: string[];
}

export interface FutureExpansionPolicy {
  eligibilityCriteria: string;
  rightsRecheck: string;
  stagedAddition: string;
}

export interface ReviewedContent {
  schemaVersion: string;
  author: CatalogAuthor;
  works: ReviewedWork[];
  review: ReviewResult;
  creditsRef: string;
  futureExpansionPolicy: FutureExpansionPolicy;
}

export interface AudioAsset {
  audioId: string;
  path: string;
  sha256: string;
  bytes: number;
  durationMs: number;
  configHash: string;
  candidateIds?: string[];
}

export interface VoiceFailure {
  audioId: string;
  candidateIds: string[];
  reasonCode: string;
}

export interface VoiceGenerationResult {
  assets: AudioAsset[];
  failures: VoiceFailure[];
  attempted: number;
  succeeded: number;
  failed: number;
  configHash: string;
}

export interface AssetManifest {
  assets: AudioAsset[];
  candidateAudio?: Readonly<Record<string, string>>;
}

export interface CatalogDialogue {
  dialogueId: string;
  order: number;
  displayText: string;
  speechText: string;
  audioId: string;
  sourceAnchor: SourceAnchor;
  review: ReviewRecord;
}

export interface CatalogWork {
  workId: string;
  title: string;
  cardLink: string;
  source: CatalogSource;
  dialogues: CatalogDialogue[];
}

export interface CandidateCounts {
  total: number;
  published: number;
  editorialExcluded: number;
  audioExcluded: number;
  editorialReasons: Record<string, number>;
  audioFailureReasons: Record<string, number>;
}

export interface Catalog {
  schemaVersion: string;
  author: CatalogAuthor;
  works: CatalogWork[];
  audioAssets: AudioAsset[];
  candidateCounts: CandidateCounts;
  creditsRef: string;
  futureExpansionPolicy: FutureExpansionPolicy;
}

export class ProcessingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessingError';
  }
}

export class NormalizationError extends ProcessingError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'NormalizationError';
  }
}

export class ReviewError extends ProcessingError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ReviewError';
  }
}

export class CatalogBuildError extends ProcessingError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'CatalogBuildError';
  }
}

function assertAllowedWorkId(workId: string): void {
  if (!ALLOWED_WORK_IDS.has(workId)) {
    throw new ProcessingError('work-id-not-allowed', `allowlist外の作品IDです: ${workId}`);
  }
}

function scalarLength(value: string): number {
  return Array.from(value).length;
}

function assertSafeString(value: string, label: string, allowEmpty = true): void {
  if (!allowEmpty && value.length === 0) {
    throw new NormalizationError('empty-text', `${label}は空にできません`);
  }
  if (value.includes('\0')) {
    throw new NormalizationError('nul-character', `${label}にNULが含まれます`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new NormalizationError('isolated-surrogate', `${label}に孤立high surrogateが含まれます`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new NormalizationError('isolated-surrogate', `${label}に孤立low surrogateが含まれます`);
    }
  }
  if (scalarLength(value) > MAX_STRING_SCALARS) {
    throw new NormalizationError('text-too-long', `${label}が${MAX_STRING_SCALARS}文字を超えています`);
  }
}

function bodyContainer(document: Document): Element | null {
  return document.querySelector('[data-aozora-body], .main_text, #main_text, .main-text');
}

function isExcluded(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (['script', 'style', 'nav', 'aside', 'template', 'noscript', 'iframe', 'object', 'embed'].includes(tag)) {
    return true;
  }
  const classes = Array.from(element.classList).map((name) => name.toLowerCase());
  return classes.some((name) =>
    ['bibliographical_information', 'navigation', 'notation_notes', 'footnote', 'notes'].some(
      (excluded) => name === excluded || name.includes(excluded),
    ),
  );
}

function rubyToken(element: Element): TextToken {
  const reading = Array.from(element.querySelectorAll('rt'))
    .map((item) => item.textContent ?? '')
    .join('');
  const baseParts: string[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3) baseParts.push(child.nodeValue ?? '');
    if (child.nodeType === 1) {
      const childElement = child as Element;
      if (childElement.tagName.toLowerCase() === 'rb') baseParts.push(childElement.textContent ?? '');
    }
  }
  const base = baseParts.join('') || (element.textContent ?? '').replace(reading, '');
  if (!base || !reading) {
    throw new ProcessingError('invalid-ruby', 'rubyには表示本文と読みが必要です');
  }
  return { type: 'ruby', base, reading };
}

/** @des DES-F001-005 @fun FUN-F001-010 */
export function tokenizeAozoraBody(document: Document): TextTokenList {
  const body = bodyContainer(document);
  if (!body) throw new ProcessingError('body-missing', '青空文庫の本文コンテナがありません');

  const tokens: TextToken[] = [];
  const diagnostics: Diagnostic[] = [];
  const knownElements = new Set([
    'div',
    'p',
    'span',
    'br',
    'ruby',
    'rb',
    'rt',
    'rp',
    'em',
    'strong',
    'b',
    'i',
    'u',
    'a',
    'section',
  ]);

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      if (node.nodeValue) tokens.push({ type: 'text', value: node.nodeValue });
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (isExcluded(element)) return;
    const tag = element.tagName.toLowerCase();
    if (!knownElements.has(tag)) {
      diagnostics.push({
        code: 'unknown-body-element',
        message: `未知の本文要素を除外しました: ${tag}`,
        element: tag,
      });
      return;
    }
    if (tag === 'br') {
      tokens.push({ type: 'lineBreak' });
      return;
    }
    if (tag === 'ruby') {
      tokens.push(rubyToken(element));
      return;
    }
    for (const child of Array.from(element.childNodes)) visit(child);
    if (tag === 'p' || tag === 'div' || tag === 'section') {
      const last = tokens.at(-1);
      if (last && last.type !== 'lineBreak') tokens.push({ type: 'lineBreak' });
    }
  };

  for (const child of Array.from(body.childNodes)) visit(child);
  Object.defineProperty(tokens, 'diagnostics', {
    value: Object.freeze(diagnostics.slice()),
    enumerable: false,
    writable: false,
  });
  return tokens as TextTokenList;
}

interface AtomicToken {
  token: TextToken;
  display: string;
}

function atomize(tokens: TextToken[]): AtomicToken[] {
  return tokens.flatMap((token): AtomicToken[] => {
    if (token.type === 'text') {
      return Array.from(token.value, (value) => ({ token: { type: 'text', value }, display: value }));
    }
    if (token.type === 'ruby') return [{ token, display: token.base }];
    return [{ token, display: '\n' }];
  });
}

function parseInertXhtml(text: string): Document {
  let document: Document;
  if (typeof DOMParser !== 'undefined') {
    document = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  } else {
    interface JsdomModule {
      JSDOM: new (html: string, options: { contentType: string }) => { window: { document: Document } };
    }
    let Jsdom: JsdomModule['JSDOM'];
    try {
      const nodeRequire = createRequire(import.meta.url);
      Jsdom = (nodeRequire('jsdom') as JsdomModule).JSDOM;
    } catch {
      throw new ProcessingError('dom-parser-unavailable', 'inert DOMParserを利用できません');
    }
    try {
      document = new Jsdom(text, { contentType: 'application/xhtml+xml' }).window.document;
    } catch {
      throw new ProcessingError('dom-parser-error', 'XHTMLを安全に解析できません');
    }
  }
  if (document.querySelector('parsererror')) {
    throw new ProcessingError('dom-parser-error', 'XHTMLを安全に解析できません');
  }
  return document;
}

/** @des DES-F001-005,DES-F001-019 @fun FUN-F001-009 */
export function extractDialogueCandidates(source: DecodedSource, workId: string): ExtractionResult {
  try {
    assertAllowedWorkId(workId);
    if (source.workId !== workId) throw new ProcessingError('work-id-mismatch', 'sourceと引数の作品IDが一致しません');
    if (!SHA256.test(source.rawSha256)) throw new ProcessingError('invalid-source-hash', 'raw source hashが不正です');
    const document = parseInertXhtml(source.text);
    const tokens = tokenizeAozoraBody(document);
    const atoms = atomize(tokens);
    const candidates: RawCandidate[] = [];
    const diagnostics = [...tokens.diagnostics];
    let depth = 0;
    let start = -1;

    for (let index = 0; index < atoms.length; index += 1) {
      const display = atoms[index]?.display;
      if (display === '「') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (display === '」') {
        if (depth === 0) {
          diagnostics.push({ code: 'unmatched-closing-bracket', message: '対応しない閉じ括弧があります' });
          return { ok: false, success: false, candidates: [], diagnostics };
        }
        depth -= 1;
        if (depth === 0) {
          const end = index + 1;
          const candidateAtoms = atoms.slice(start, end);
          candidates.push({
            workId,
            rawSourceSha256: source.rawSha256.toLowerCase(),
            order: candidates.length,
            rawTokenRange: { start, end },
            tokens: candidateAtoms.map((item) => item.token),
            contextBefore: atoms.slice(Math.max(0, start - 64), start).map((item) => item.display).join(''),
            contextAfter: atoms.slice(end, end + 64).map((item) => item.display).join(''),
            sourceAnchor: { bodySelector: '.main_text', startToken: start, endToken: end },
            extractorVersion: EXTRACTOR_VERSION,
          });
          start = -1;
        }
      }
    }
    if (depth !== 0) {
      diagnostics.push({ code: 'unmatched-opening-bracket', message: '対応しない開き括弧があります' });
      return { ok: false, success: false, candidates: [], diagnostics };
    }
    return { ok: true, success: true, candidates, diagnostics };
  } catch (error) {
    const code = error instanceof ProcessingError ? error.code : 'dom-parser-error';
    const knownCodes: readonly DiagnosticCode[] = [
      'dom-parser-error',
      'dom-parser-unavailable',
      'body-missing',
      'invalid-ruby',
      'invalid-source-hash',
      'work-id-mismatch',
      'work-id-not-allowed',
    ];
    const diagnosticCode: DiagnosticCode = knownCodes.includes(code as DiagnosticCode)
      ? (code as DiagnosticCode)
      : 'dom-parser-error';
    return {
      ok: false,
      success: false,
      candidates: [],
      diagnostics: [{ code: diagnosticCode, message: error instanceof Error ? error.message : '抽出に失敗しました' }],
    };
  }
}

/** @des DES-F001-006 @fun FUN-F001-011 */
export function normalizeDisplayText(tokens: TextToken[]): string {
  const value = tokens
    .map((token) => (token.type === 'text' ? token.value : token.type === 'ruby' ? token.base : '\n'))
    .join('')
    .normalize('NFC');
  assertSafeString(value, 'displayText');
  return value;
}

function replaceAllLiteral(value: string, replacements: Readonly<Record<string, string>>): string {
  return Object.entries(replacements)
    .sort(([left], [right]) => right.length - left.length)
    .reduce((result, [from, to]) => {
      if (!from) throw new NormalizationError('invalid-gaiji-rule', '空文字の外字規則は使用できません');
      assertSafeString(to, '外字置換値');
      return result.split(from).join(to);
    }, value);
}

/** @des DES-F001-006 @fun FUN-F001-012 */
export function normalizeSpeechText(tokens: TextToken[], rules: SpeechRules): string {
  if (rules.version !== SUPPORTED_SPEECH_RULE_VERSION) {
    throw new NormalizationError('unknown-rules-version', `未対応の読み上げ規則版です: ${rules.version}`);
  }
  const lineBreak = rules.lineBreak === 'remove' ? '' : ' ';
  let value = tokens
    .map((token) => (token.type === 'text' ? token.value : token.type === 'ruby' ? token.reading : lineBreak))
    .join('');
  value = replaceAllLiteral(value, rules.gaiji ?? rules.gaijiReplacements ?? {});
  if (/[〓※�]/u.test(value)) {
    throw new NormalizationError('unknown-gaiji', '読みが不明な外字が残っています');
  }
  if (rules.collapseWhitespace !== false) value = value.replace(/\s+/gu, ' ').trim();
  value = value.normalize('NFC');
  if (value.trim().length === 0) {
    throw new NormalizationError('empty-text', 'speechTextは空白だけにできません');
  }
  assertSafeString(value, 'speechText', false);
  return value;
}

/** @des DES-F001-002,DES-F001-006 @fun FUN-F001-013 */
export function createCandidateId(
  workId: string,
  rawSourceSha256: string,
  rawTokenRange: TokenRange,
  extractorVersion: string,
  normalizerVersion: string,
  normalizedTextHash: string,
): string {
  assertAllowedWorkId(workId);
  if (!SHA256.test(rawSourceSha256) || !SHA256.test(normalizedTextHash)) {
    throw new ProcessingError('invalid-sha256', 'SHA-256は64桁hexで指定してください');
  }
  if (
    !Number.isSafeInteger(rawTokenRange.start) ||
    !Number.isSafeInteger(rawTokenRange.end) ||
    rawTokenRange.start < 0 ||
    rawTokenRange.end <= rawTokenRange.start
  ) {
    throw new ProcessingError('invalid-token-range', 'token rangeが不正です');
  }
  if (!SEMVER.test(extractorVersion) || !SEMVER.test(normalizerVersion)) {
    throw new ProcessingError('invalid-version', '抽出器と正規化器の版はsemverで指定してください');
  }
  const canonicalTuple = JSON.stringify([
    workId,
    rawSourceSha256.toLowerCase(),
    rawTokenRange.start,
    rawTokenRange.end,
    extractorVersion,
    normalizerVersion,
    normalizedTextHash.toLowerCase(),
  ]);
  return createHash('sha256').update(canonicalTuple, 'utf8').digest('base64url');
}

export function validateReview(review: ReviewRecord): void {
  if (!Number.isSafeInteger(review.revision) || review.revision < 1) {
    throw new ReviewError('invalid-revision', 'review revisionは1以上の整数が必要です');
  }
  if (!['approved', 'rejected', 'pending'].includes(review.status)) {
    throw new ReviewError('invalid-review-status', 'review statusが不正です');
  }
  if (!review.reasonCode.trim()) throw new ReviewError('review-reason-missing', 'review理由が必要です');
  if (
    (review.status === 'approved' && !APPROVED_REVIEW_REASON_SET.has(review.reasonCode)) ||
    (review.status === 'rejected' && !REJECTED_REVIEW_REASON_SET.has(review.reasonCode)) ||
    (review.status === 'pending' && review.reasonCode !== 'PENDING_EDITORIAL_REVIEW')
  ) {
    throw new ReviewError('review-reason-not-allowed', 'review statusとreasonCodeの組合せがallowlist外です');
  }
  if (!review.reviewer.trim()) throw new ReviewError('reviewer-missing', 'reviewerが必要です');
  if (!RFC3339.test(review.reviewedAt) || Number.isNaN(Date.parse(review.reviewedAt))) {
    throw new ReviewError('invalid-reviewed-at', 'reviewedAtはRFC 3339 instantが必要です');
  }
  if (!RFC3339.test(review.policyCheckedAt) || Number.isNaN(Date.parse(review.policyCheckedAt))) {
    throw new ReviewError('invalid-policy-checked-at', 'policyCheckedAtはRFC 3339 instantが必要です');
  }
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** @des DES-F001-007 @fun FUN-F001-014 */
export function applyEditorialReview(candidates: Candidate[], reviews: ReviewRecord[]): ReviewResult {
  const candidateById = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (candidateById.has(candidate.candidateId)) {
      throw new ReviewError('duplicate-candidate-id', `候補IDが重複しています: ${candidate.candidateId}`);
    }
    candidateById.set(candidate.candidateId, candidate);
  }

  const histories = new Map<string, Map<number, ReviewRecord>>();
  for (const review of reviews) {
    validateReview(review);
    if (!candidateById.has(review.candidateId)) {
      throw new ReviewError('orphan-review', `未知または旧候補IDのレビューです: ${review.candidateId}`);
    }
    const revisions = histories.get(review.candidateId) ?? new Map<number, ReviewRecord>();
    if (revisions.has(review.revision)) {
      throw new ReviewError('review-revision-conflict', `同じrevisionのレビューが競合しています: ${review.candidateId}`);
    }
    revisions.set(review.revision, review);
    histories.set(review.candidateId, revisions);
  }

  const result: ReviewResult = {
    approved: [],
    rejected: [],
    pending: [],
    all: [],
    counts: { approved: 0, rejected: 0, pending: 0 },
    reasonCounts: {},
  };
  for (const candidate of candidates) {
    const revisions = histories.get(candidate.candidateId);
    if (!revisions?.size) throw new ReviewError('review-missing', `候補にレビューがありません: ${candidate.candidateId}`);
    const latestRevision = Math.max(...revisions.keys());
    const review = revisions.get(latestRevision);
    if (!review) throw new ReviewError('review-missing', `候補に最新レビューがありません: ${candidate.candidateId}`);
    const reviewed = { candidate, review };
    result[review.status].push(reviewed);
    result.all.push(reviewed);
    result.counts[review.status] += 1;
    increment(result.reasonCounts, review.reasonCode);
  }
  if (result.pending.length > 0) {
    throw new ReviewError('pending-review', `${result.pending.length}件のpendingレビューが残っています`);
  }
  return result;
}

function assertRelativePath(value: string, label: string): void {
  if (
    !value ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(value) ||
    value.split('/').some((segment) => segment === '..' || segment === '.') ||
    /[?#]/u.test(value)
  ) {
    throw new CatalogBuildError('absolute-or-unsafe-path', `${label}は公開root相対pathである必要があります`);
  }
}

function parseStrictHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CatalogBuildError('invalid-source-url', `${label}がURLではありません`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    /%2e|%2f|%5c/iu.test(url.pathname) ||
    url.pathname.includes('\\')
  ) {
    throw new CatalogBuildError('invalid-source-url', `${label}は認証情報なしHTTPS URLである必要があります`);
  }
  return url;
}

function assertAozoraSourceUrl(value: string, label: string, workId: string, kind: 'card' | 'text'): void {
  const url = parseStrictHttpsUrl(value, label);
  if (url.origin !== AOZORA_ORIGIN) {
    throw new CatalogBuildError('untrusted-source-url', `${label}は青空文庫の固定originである必要があります`);
  }
  const validPath = kind === 'card'
    ? url.pathname === INITIAL_CARD_PATHS.get(workId)
    : url.pathname === INITIAL_TEXT_PATHS.get(workId);
  if (!validPath) {
    throw new CatalogBuildError('untrusted-source-url', `${label}の青空文庫pathが不正です`);
  }
}

function assertInitialCatalogSource(source: CatalogSource, work: ReviewedWork): void {
  assertAozoraSourceUrl(source.cardUrl, 'source.cardUrl', work.workId, 'card');
  assertAozoraSourceUrl(source.textUrl, 'source.textUrl', work.workId, 'text');
  if (work.cardLink !== source.cardUrl) {
    throw new CatalogBuildError('source-card-mismatch', 'cardLinkとsource.cardUrlが一致しません');
  }
  const expectedMetadata = INITIAL_SOURCE_METADATA.get(work.workId);
  const expectedAttribution = `青空文庫『${work.title}』（芥川龍之介）`;
  if (
    !expectedMetadata || source.attribution !== expectedAttribution ||
    source.baseEdition !== expectedMetadata.baseEdition || source.inputter !== expectedMetadata.inputter ||
    source.proofreader !== expectedMetadata.proofreader || source.transformation !== SOURCE_TRANSFORMATION
  ) {
    throw new CatalogBuildError('source-metadata-mismatch', '原典の固定metadataが一致しません');
  }
  if (!RFC3339.test(source.fetchedAt) || !Number.isFinite(Date.parse(source.fetchedAt))) {
    throw new CatalogBuildError('source-fetched-at-invalid', '原典取得日時がRFC 3339 instantではありません');
  }
  if (!SHA256.test(source.sourceSha256)) {
    throw new CatalogBuildError('invalid-source-hash', '原典SHA-256が不正です');
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalCatalogJson(catalog: Catalog): string {
  return JSON.stringify(canonicalize(catalog));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function validateExpansionPolicy(policy: FutureExpansionPolicy): void {
  if (!policy.eligibilityCriteria?.trim() || !policy.rightsRecheck?.trim() || !policy.stagedAddition?.trim()) {
    throw new CatalogBuildError('future-expansion-policy-incomplete', '将来拡張方針の3項目が必要です');
  }
}

function validateCatalogCandidate(candidate: Candidate): void {
  assertAllowedWorkId(candidate.workId);
  if (!candidate.candidateId.trim()) throw new CatalogBuildError('invalid-candidate-id', '候補IDが空です');
  if (!SHA256.test(candidate.rawSourceSha256)) {
    throw new CatalogBuildError('invalid-source-hash', '候補の原典SHA-256が不正です');
  }
  if (!Number.isSafeInteger(candidate.order) || candidate.order < 0) {
    throw new CatalogBuildError('invalid-candidate-order', '候補順序は0以上の整数が必要です');
  }
  if (
    !Number.isSafeInteger(candidate.rawTokenRange.start) ||
    !Number.isSafeInteger(candidate.rawTokenRange.end) ||
    candidate.rawTokenRange.start < 0 ||
    candidate.rawTokenRange.end <= candidate.rawTokenRange.start ||
    candidate.sourceAnchor.startToken !== candidate.rawTokenRange.start ||
    candidate.sourceAnchor.endToken !== candidate.rawTokenRange.end
  ) {
    throw new CatalogBuildError('invalid-token-range', '候補のtoken rangeとsource anchorが不正です');
  }
  if (!SEMVER.test(candidate.extractorVersion) || !SEMVER.test(candidate.normalizerVersion)) {
    throw new CatalogBuildError('invalid-version', '候補の抽出器・正規化器版が不正です');
  }
  assertSafeString(candidate.displayText, 'displayText', false);
  assertSafeString(candidate.speechText, 'speechText', false);
}

function validateReviewPartition(review: ReviewResult): void {
  const partitions = [
    ['approved', review.approved],
    ['rejected', review.rejected],
    ['pending', review.pending],
  ] as const;
  const reasonCounts: Record<string, number> = {};
  for (const [status, items] of partitions) {
    for (const item of items) {
      validateCatalogCandidate(item.candidate);
      validateReview(item.review);
      if (item.review.status !== status || item.review.candidateId !== item.candidate.candidateId) {
        throw new CatalogBuildError('review-partition-mismatch', 'レビューのstatusまたはcandidateId対応が不正です');
      }
      increment(reasonCounts, item.review.reasonCode);
    }
  }
  if (canonicalJson(reasonCounts) !== canonicalJson(review.reasonCounts)) {
    throw new CatalogBuildError('review-reason-count-mismatch', 'レビューの理由別集計が一致しません');
  }
}

/** @des DES-F001-002,DES-F001-007,DES-F001-013 @fun FUN-F001-015 */
export function buildPublicCatalog(
  input: ReviewedContent,
  voice: VoiceGenerationResult,
  assets: AssetManifest,
): Catalog {
  if (!SEMVER.test(input.schemaVersion)) {
    throw new CatalogBuildError('invalid-schema-version', 'catalog schemaVersionはsemverで指定してください');
  }
  if (
    input.author.authorId !== PUBLIC_AUTHOR.authorId || input.author.name !== PUBLIC_AUTHOR.name ||
    input.author.originalName !== PUBLIC_AUTHOR.originalName || input.author.slug !== PUBLIC_AUTHOR.slug ||
    input.author.artwork?.path !== PUBLIC_AUTHOR.artwork.path || input.author.artwork?.alt !== PUBLIC_AUTHOR.artwork.alt
  ) {
    throw new CatalogBuildError('invalid-author', '初期公開の作者識別情報が不正です');
  }
  if (input.review.pending.length > 0 || input.review.counts.pending !== 0) {
    throw new CatalogBuildError('pending-review', 'pendingレビューを公開できません');
  }
  if (
    input.review.all.length !==
      input.review.approved.length + input.review.rejected.length + input.review.pending.length ||
    input.review.counts.approved !== input.review.approved.length ||
    input.review.counts.rejected !== input.review.rejected.length ||
    input.review.counts.pending !== input.review.pending.length
  ) {
    throw new CatalogBuildError('review-count-mismatch', 'レビューのstatus別集計が一致しません');
  }
  validateReviewPartition(input.review);
  const partitionedReviews = [...input.review.approved, ...input.review.rejected, ...input.review.pending];
  const partitionByKey = new Map(
    partitionedReviews.map((item) => [
      `${item.candidate.candidateId}:${item.review.revision}:${item.review.status}`,
      canonicalJson(item),
    ]),
  );
  if (
    partitionByKey.size !== partitionedReviews.length ||
    input.review.all.some(
      (item) => partitionByKey.get(`${item.candidate.candidateId}:${item.review.revision}:${item.review.status}`) !== canonicalJson(item),
    )
  ) {
    throw new CatalogBuildError('review-partition-mismatch', 'レビューのallとstatus別配列が一致しません');
  }
  if (input.works.length !== 3) throw new CatalogBuildError('work-count-invalid', '初期公開作品は3件必要です');
  validateExpansionPolicy(input.futureExpansionPolicy);
  assertRelativePath(input.creditsRef, 'creditsRef');

  const reviewedById = new Map(input.review.all.map((item) => [item.candidate.candidateId, item]));
  if (reviewedById.size !== input.review.all.length) {
    throw new CatalogBuildError('duplicate-candidate-id', '候補IDが重複しています');
  }
  const assignedCandidates = new Set<string>();
  const workByCandidate = new Map<string, ReviewedWork>();
  const workIds = new Set<string>();
  for (const work of input.works) {
    assertAllowedWorkId(work.workId);
    if (workIds.has(work.workId)) throw new CatalogBuildError('duplicate-work-id', '作品IDが重複しています');
    workIds.add(work.workId);
    if (work.title !== INITIAL_WORKS.get(work.workId)) {
      throw new CatalogBuildError('work-title-mismatch', '作品IDと固定作品名が一致しません');
    }
    assertAozoraSourceUrl(work.cardLink, 'cardLink', work.workId, 'card');
    assertInitialCatalogSource(work.source, work);
    const orders = new Set<number>();
    for (const candidateId of work.candidateIds) {
      if (!reviewedById.has(candidateId)) throw new CatalogBuildError('unknown-candidate-id', '作品に未知の候補IDがあります');
      if (assignedCandidates.has(candidateId)) throw new CatalogBuildError('duplicate-candidate-assignment', '候補が複数作品に属しています');
      const reviewed = reviewedById.get(candidateId);
      if (reviewed?.candidate.workId !== work.workId) {
        throw new CatalogBuildError('candidate-work-mismatch', '候補と作品のworkIdが一致しません');
      }
      if (reviewed.candidate.rawSourceSha256.toLowerCase() !== work.source.sourceSha256.toLowerCase()) {
        throw new CatalogBuildError('source-hash-mismatch', '候補と作品sourceのSHA-256が一致しません');
      }
      if (orders.has(reviewed.candidate.order)) {
        throw new CatalogBuildError('duplicate-candidate-order', '同一作品内の候補順序が重複しています');
      }
      orders.add(reviewed.candidate.order);
      assignedCandidates.add(candidateId);
      workByCandidate.set(candidateId, work);
    }
  }
  if (assignedCandidates.size !== reviewedById.size) {
    throw new CatalogBuildError('candidate-count-mismatch', '作品へ割り当てられていない候補があります');
  }

  if (
    voice.attempted !== voice.succeeded + voice.failed ||
    voice.succeeded !== voice.assets.length ||
    voice.failed !== voice.failures.length
  ) {
    throw new CatalogBuildError('voice-count-mismatch', '音声生成件数が一致しません');
  }
  if (!SHA256.test(voice.configHash)) {
    throw new CatalogBuildError('invalid-voice-config-hash', '音声設定hashが不正です');
  }
  const manifestAssets = new Map<string, AudioAsset>();
  for (const asset of assets.assets) {
    if (manifestAssets.has(asset.audioId)) throw new CatalogBuildError('duplicate-audio-id', 'audioIdが重複しています');
    assertRelativePath(asset.path, 'audio path');
    if (!SHA256.test(asset.sha256) || !SHA256.test(asset.configHash)) {
      throw new CatalogBuildError('invalid-asset-hash', '音声asset hashが不正です');
    }
    if (asset.configHash !== voice.configHash) {
      throw new CatalogBuildError('asset-config-mismatch', '音声assetと生成結果の設定hashが一致しません');
    }
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !Number.isFinite(asset.durationMs) || asset.durationMs <= 0) {
      throw new CatalogBuildError('invalid-audio-metadata', '音声assetのbytes/durationが不正です');
    }
    manifestAssets.set(asset.audioId, asset);
  }
  for (const generated of voice.assets) {
    const manifest = manifestAssets.get(generated.audioId);
    const generatedCore = { ...generated, candidateIds: undefined };
    const manifestCore = { ...manifest, candidateIds: undefined };
    if (!manifest || canonicalJson(generatedCore) !== canonicalJson(manifestCore)) {
      throw new CatalogBuildError('asset-manifest-mismatch', '音声生成結果とasset manifestが一致しません');
    }
  }

  const failureByCandidate = new Map<string, VoiceFailure>();
  for (const failure of voice.failures) {
    if (!failure.reasonCode.trim() || failure.candidateIds.length === 0) {
      throw new CatalogBuildError('voice-failure-reason-missing', '音声失敗にはcandidateIdと理由が必要です');
    }
    for (const candidateId of failure.candidateIds) {
      const reviewed = reviewedById.get(candidateId);
      if (!reviewed || reviewed.review.status !== 'approved') {
        throw new CatalogBuildError('orphan-voice-failure', '音声失敗がapproved候補を参照していません');
      }
      if (failureByCandidate.has(candidateId)) throw new CatalogBuildError('duplicate-voice-failure', '音声失敗候補が重複しています');
      failureByCandidate.set(candidateId, failure);
    }
  }

  const candidateAudio = new Map<string, string>(Object.entries(assets.candidateAudio ?? {}));
  for (const asset of voice.assets) {
    for (const candidateId of asset.candidateIds ?? []) {
      const existing = candidateAudio.get(candidateId);
      if (existing && existing !== asset.audioId) throw new CatalogBuildError('candidate-audio-conflict', '候補のaudioIdが競合しています');
      candidateAudio.set(candidateId, asset.audioId);
    }
  }
  for (const [candidateId, audioId] of candidateAudio) {
    const reviewed = reviewedById.get(candidateId);
    if (!reviewed || reviewed.review.status !== 'approved' || !manifestAssets.has(audioId)) {
      throw new CatalogBuildError('orphan-candidate-audio', 'candidate-audio対応に孤立参照があります');
    }
  }

  const editorialReasons: Record<string, number> = {};
  for (const item of input.review.rejected) increment(editorialReasons, item.review.reasonCode);
  const audioFailureReasons: Record<string, number> = {};
  for (const failure of failureByCandidate.values()) increment(audioFailureReasons, failure.reasonCode);

  const dialoguesByWork = new Map<string, CatalogDialogue[]>();
  const referencedAudio = new Set<string>();
  for (const item of input.review.approved) {
    const candidateId = item.candidate.candidateId;
    if (failureByCandidate.has(candidateId)) continue;
    const audioId = candidateAudio.get(candidateId);
    if (!audioId || !manifestAssets.has(audioId)) {
      throw new CatalogBuildError('candidate-audio-missing', `approved候補の音声がありません: ${candidateId}`);
    }
    const work = workByCandidate.get(candidateId);
    if (!work) throw new CatalogBuildError('candidate-work-missing', '候補の作品がありません');
    const dialogues = dialoguesByWork.get(work.workId) ?? [];
    dialogues.push({
      dialogueId: candidateId,
      order: item.candidate.order,
      displayText: item.candidate.displayText,
      speechText: item.candidate.speechText,
      audioId,
      sourceAnchor: item.candidate.sourceAnchor,
      review: item.review,
    });
    dialoguesByWork.set(work.workId, dialogues);
    referencedAudio.add(audioId);
  }
  if (Array.from(manifestAssets.keys()).some((audioId) => !referencedAudio.has(audioId))) {
    throw new CatalogBuildError('orphan-asset', '公開台詞から参照されない音声assetがあります');
  }

  const catalog: Catalog = {
    schemaVersion: input.schemaVersion,
    author: input.author,
    works: input.works.map((work) => ({
      workId: work.workId,
      title: work.title,
      cardLink: work.cardLink,
      source: work.source,
      dialogues: (dialoguesByWork.get(work.workId) ?? []).sort((left, right) => left.order - right.order),
    })),
    audioAssets: Array.from(referencedAudio, (audioId) => manifestAssets.get(audioId) as AudioAsset),
    candidateCounts: {
      total: input.review.all.length,
      published: input.review.approved.length - failureByCandidate.size,
      editorialExcluded: input.review.rejected.length,
      audioExcluded: failureByCandidate.size,
      editorialReasons,
      audioFailureReasons,
    },
    creditsRef: input.creditsRef,
    futureExpansionPolicy: input.futureExpansionPolicy,
  };
  const counts = catalog.candidateCounts;
  if (counts.total !== counts.published + counts.editorialExcluded + counts.audioExcluded) {
    throw new CatalogBuildError('candidate-count-mismatch', '候補の3区分集計が一致しません');
  }
  if (new TextEncoder().encode(canonicalCatalogJson(catalog)).byteLength > MAX_CATALOG_BYTES) {
    throw new CatalogBuildError('catalog-too-large', `catalogが${MAX_CATALOG_BYTES} byteを超えています`);
  }
  return catalog;
}
