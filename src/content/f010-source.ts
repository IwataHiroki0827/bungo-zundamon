import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from './artifacts.ts';
import {
  isMintedApprovedBatchContext,
  type ApprovedBatchContext,
} from './batch-candidate.ts';
import type { WorkspaceRelativePath } from './batch.ts';
import { writeF005TemporaryFile } from './f005-postcondition-write.ts';
import {
  EXTRACTOR_VERSION,
  extractDialogueCandidates,
  type DecodedSource,
  type ExtractionResult,
} from './processing.ts';
import {
  AOZORA_BIBLIOGRAPHY_URL,
  AOZORA_ORIGIN,
  AOZORA_TIMEOUT_MS,
  MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
  MAX_BIBLIOGRAPHY_CSV_BYTES,
  MAX_SOURCE_BYTES,
  ProductionAozoraTransport,
  extractVerifiedBibliographyCsv,
  parseAozoraBibliography,
  type BibliographyRow,
  type TransportPolicy,
  type TransportResponse,
  type TransportSecurityEvidence,
} from './source.ts';
import type { RawArtifactRef } from './f005-source.ts';
import {
  ProductionPolicyTransport,
  createPolicyDefinitions,
  fetchPolicyObservation,
  type PolicyId,
  type PolicySecurityProof,
} from '../notices/policy-snapshots.ts';

/**
 * F010（梶井基次郎3作品追加）専用の原典・書誌・権利判定モジュール。
 *
 * DD-F010.md §0・FUN-F010-005記載のとおり、`f005-source.ts`〜`f009-source.ts`は
 * authorId/workId定数・module-private`mintedSourceRecords`(WeakSet)の
 * brand検査が各featureへhardcodeされておりfeature非依存ではない。
 * 本モジュールは`f009-source.ts`の構造（型定義・`ProductionAozoraTransport`
 * によるHTTPS取得・権利/規約判定・書誌固定・entity正規化・決定的抽出・
 * gaiji検出）を忠実に踏襲しつつ、authorId `000074`（梶井基次郎）と
 * 檸檬(000424)・Ｋの昇天(000419)・愛撫(000411)へ
 * パラメータ化した新規実装である。
 *
 * `ProductionAozoraTransport`/`ProductionPolicyTransport`（`source.ts`／
 * `policy-snapshots.ts`で定義される、feature引数を取らない非依存export）は
 * そのまま再利用する。F005固有ETW/native guard機構（`resolveSafeWorkspaceFile`等）
 * は使わず、原典の永続化は既存`writeF005TemporaryFile`（`f005-postcondition-write.ts`、
 * 排他作成+fsync+読み戻しSHA照合の汎用atomic write、feature非依存）だけで行う。
 *
 * **F009との2点の構造差分（DD-F010.md §0・§6明記）**:
 *
 * 1. **entity正規化**: DOMAIN-F010.md §5の実測どおり、3作品とも未定義named
 *    entity0件であることを実HTTPS取得で確認した。F007「舞姫」・F009「瓶詰地獄」で
 *    必要になった`&nbsp;`固定context等長置換のような特殊caseはF010には存在しない。
 *    3作品とも常に`variant: 'passthrough'`となる。標準5種
 *    `&amp;&lt;&gt;&quot;&apos;`以外のnamed entityが1件でも出現した場合は
 *    fail-closedで拒否する。
 *
 * 2. **長大候補分割は実装しない**（DES-F010-015）: DOMAIN-F010.md §3.1の実測
 *    最大候補長は133文字（Ｋの昇天）であり、F007/F008/F009確立の600文字閾値・
 *    約1,335文字VOICEVOX失敗境界のいずれにも遠く達しない。F007/F008/F009の
 *    `splitOverlongF00NCandidates`型の分割関数はF010へ複製しない。
 *    `extractF010DialogueCandidates`は最外側全角かぎ括弧候補を分割なしで
 *    決定的に生成するのみである（DD-F010.md FUN-F010-006・FUN-F010-018）。
 *
 * **gaiji要素の候補内非混入検証はF009から踏襲する**（DES-F010-005）。
 * DOMAIN-F010.md §5が指摘するとおり、檸檬の地の文には`<img class="gaiji">`
 * 要素が実在する（1件、「闊」の異体字、`2-79-45.png`）。Ｋの昇天・愛撫は
 * gaiji要素0件である。本モジュールは`detectF010GaijiElements`・
 * `verifyF010NoGaijiWithinCandidates`をDES-F010-005の論点として実装し、
 * 選定時・公開直前の両方の独立snapshotで常時有効に検証する（候補外の地の文に
 * のみ出現することを確認済みだが、検出手順自体は無効化・緩和しない。F008の
 * ような「該当なし」による無効化は行わない）。
 *
 * @des DES-F010-004 DES-F010-005 DES-F010-015
 */

const AUTHOR_ID = '000074';
const AUTHOR_PAGE_URL = `${AOZORA_ORIGIN}/index_pages/person74.html`;
const CANONICAL_XHTML11_DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">';

const F010_POLICY_IDS = Object.freeze([
  'voicevox-terms',
  'zundamon-audio-terms',
  'zundamon-character-guideline',
] as const satisfies readonly PolicyId[]);

export const F010_WORKS = Object.freeze([
  Object.freeze({
    workId: '000424',
    title: '檸檬',
    order: 1,
    cardUrl: `${AOZORA_ORIGIN}/cards/000074/card424.html`,
    sourceUrl: `${AOZORA_ORIGIN}/cards/000074/files/424_19826.html`,
  }),
  Object.freeze({
    workId: '000419',
    title: 'Ｋの昇天',
    order: 2,
    cardUrl: `${AOZORA_ORIGIN}/cards/000074/card419.html`,
    sourceUrl: `${AOZORA_ORIGIN}/cards/000074/files/419_19702.html`,
  }),
  Object.freeze({
    workId: '000411',
    title: '愛撫',
    order: 3,
    cardUrl: `${AOZORA_ORIGIN}/cards/000074/card411.html`,
    sourceUrl: `${AOZORA_ORIGIN}/cards/000074/files/411_19633.html`,
  }),
] as const);

export type F010WorkId = (typeof F010_WORKS)[number]['workId'];
export type F010Phase = 'selection' | 'predeploy';

export type F010SourceErrorCode =
  | 'F010_CONTEXT_INVALID'
  | 'F010_TRANSPORT_REQUIRED'
  | 'F010_SOURCE_RESPONSE_INVALID'
  | 'F010_SOURCE_DRIFT'
  | 'F010_USAGE_NOT_ALLOWED'
  | 'F010_BIBLIOGRAPHY_INVALID'
  | 'F010_ENTITY_NORMALIZATION_INVALID'
  | 'F010_XHTML_PREFLIGHT_REJECTED'
  | 'F010_EXTRACTION_FAILED'
  | 'F010_PATH_UNSAFE'
  | 'F010_REGISTRY_MISMATCH'
  | 'F010_GAIJI_WITHIN_CANDIDATE';

export class F010SourceError extends Error {
  constructor(
    public readonly code: F010SourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'F010SourceError';
  }
}

export interface F010PolicyClauseResult {
  readonly clauseId: string;
  readonly status: 'satisfied' | 'missing' | 'prohibited' | 'unknown';
}

export interface F010PolicyClauseDecision {
  readonly __brand: 'F010PolicyClauseDecision';
  readonly policyId: (typeof F010_POLICY_IDS)[number];
  readonly contentSha256: string;
  readonly classification: 'free-no-ads-no-payments-no-sponsorship-unofficial';
  readonly requiredCredit: 'VOICEVOX:ずんだもん';
  readonly decision: 'allow' | 'blocked';
  readonly clauses: readonly F010PolicyClauseResult[];
}

export interface F010PolicySnapshot {
  readonly policyId: (typeof F010_POLICY_IDS)[number];
  readonly versionOrLabel: string;
  readonly artifact: RawArtifactRef;
  readonly decision: F010PolicyClauseDecision;
}

export interface F010WorkSnapshot {
  readonly workId: F010WorkId;
  readonly title: string;
  readonly bibliography: Readonly<BibliographyRow>;
  readonly card: RawArtifactRef;
  readonly xhtml: RawArtifactRef;
}

export interface F010SourceSnapshot {
  readonly schemaVersion: '1.0.0';
  readonly authorId: '000074';
  readonly phase: F010Phase;
  readonly observedAt: string;
  readonly bibliographyArchive: RawArtifactRef;
  readonly bibliographyCsv: RawArtifactRef;
  readonly authorPage: RawArtifactRef;
  readonly policies: readonly F010PolicySnapshot[];
  readonly works: readonly F010WorkSnapshot[];
}

export interface F010CollectionOptions {
  readonly policyTransport: ProductionPolicyTransport;
  readonly trustedProjectRoot: string;
  readonly workspace: string;
  readonly selectionSnapshot?: F010SourceSnapshot;
}

export interface F010UsageProfile {
  readonly free: boolean;
  readonly advertising: boolean;
  readonly payments: boolean;
  readonly sponsorship: boolean;
  readonly unofficial: boolean;
  readonly voiceCredit: string;
}

export interface F010RightsUsageDecision {
  readonly decision: 'allow' | 'blocked';
  readonly reasons: readonly string[];
  readonly phase: F010Phase;
  readonly observedAt: string;
}

export interface F010BibliographyV2 {
  readonly baseEdition: string;
  readonly inputter: string;
  readonly proofreader: string;
}

export interface F010SourceRecordV2 {
  readonly schemaVersion: '1.0.0';
  readonly workId: F010WorkId;
  readonly title: string;
  readonly cardUrl: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly updatedAt: string;
  readonly raw: RawArtifactRef;
  readonly card: RawArtifactRef;
  readonly cardRawSha256: string;
  readonly cardRawBytes: number;
  readonly bibliographyCharset: 'Shift_JIS';
  readonly bodySelector: '.main_text';
  readonly bibliography: F010BibliographyV2;
}

export interface F010EntityReplacement {
  readonly offset: number;
  readonly from: '&nbsp;';
  readonly to: '&#160;';
}

export interface F010EntityNormalizationResult {
  readonly schemaVersion: '1.0.0';
  readonly workId: F010WorkId;
  readonly variant: 'passthrough' | 'entity';
  readonly rawSha256: string;
  readonly processedBytes: Uint8Array;
  readonly processedSha256: string;
  readonly replacements: readonly F010EntityReplacement[];
}

export interface F010CandidateSet {
  readonly schemaVersion: '1.0.0';
  readonly workId: F010WorkId;
  readonly sourceSha256: string;
  readonly extractorVersion: typeof EXTRACTOR_VERSION;
  readonly result: ExtractionResult;
}

export interface F010GaijiRange {
  readonly start: number;
  readonly end: number;
}

const mintedSnapshots = new WeakSet<object>();
const mintedWorkSnapshots = new WeakSet<object>();
const mintedSourceRecords = new WeakSet<object>();
const mintedNormalizations = new WeakSet<object>();
const mintedPolicyDecisions = new WeakSet<object>();
const mintedCandidateSets = new WeakSet<object>();
// gaiji検出（DES-F010-005新規論点）は候補抽出に使ったraw XHTML本文（タグ込み、
// DOM parse前のdecoded text）と同一inputを参照する必要があるため、mint時の
// rawTextをWeakMapで保持する（`verifyF010NoGaijiWithinCandidates(candidateSet, gaijiRanges)`
// のDD-F010.md記載2引数シグネチャを維持しつつ、内部で同一rawTextを再利用するため）。
const candidateSetRawText = new WeakMap<object, string>();

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

// ---------------------------------------------------------------------------
// 梶井基次郎author identity・work順registry（FUN-F010-004）
// ---------------------------------------------------------------------------

const EXPECTED_REGISTRY_WORKS = Object.freeze([
  { workId: '000424', title: '檸檬', order: 1 },
  { workId: '000419', title: 'Ｋの昇天', order: 2 },
  { workId: '000411', title: '愛撫', order: 3 },
] as const);

export interface F010AuthorAndWorkRegistryWork {
  readonly workId: F010WorkId;
  readonly title: string;
  readonly order: 1 | 2 | 3;
}

export interface F010WorkRegistry {
  readonly __brand: 'F010WorkRegistry';
  readonly authorId: '000074';
  readonly name: 'かじいもとじろう';
  readonly originalName: '梶井基次郎';
  readonly slug: 'kajii-motojiro';
  readonly identitySha256: string;
  readonly authorMode: 'introduce';
  readonly works: readonly F010AuthorAndWorkRegistryWork[];
}

export interface F010VerifiedAuthor {
  readonly __brand: 'F010VerifiedAuthor';
  readonly authorId: '000074';
  readonly name: 'かじいもとじろう';
  readonly originalName: '梶井基次郎';
  readonly slug: 'kajii-motojiro';
  readonly identitySha256: string;
}

const mintedRegistries = new WeakSet<object>();
const verifiedF010Authors = new WeakSet<object>();

/**
 * `authorId=000074`（梶井基次郎）・`name=かじいもとじろう`・`slug=kajii-motojiro`と
 * 檸檬(000424,order1)→Ｋの昇天(000419,order2)→愛撫(000411,order3)のexact
 * work tupleを固定registryとしてmintする。`F010_WORKS`（本ファイル定義）を
 * 別に保持したexpected定数と突き合わせ、tamperを検出する。
 * @des DES-F010-003 @fun FUN-F010-004 @ut UT-F010-004
 */
export function defineF010AuthorAndWorkRegistry(): F010WorkRegistry {
  if (
    F010_WORKS.length !== EXPECTED_REGISTRY_WORKS.length ||
    F010_WORKS.some((work, index) => {
      const expected = EXPECTED_REGISTRY_WORKS[index];
      return !expected || work.workId !== expected.workId ||
        work.title !== expected.title || work.order !== expected.order;
    }) ||
    new Set(F010_WORKS.map((work) => work.workId)).size !== F010_WORKS.length ||
    AUTHOR_ID !== '000074'
  ) {
    throw new F010SourceError('F010_REGISTRY_MISMATCH', 'F010作者・作品registryが固定値と一致しません');
  }
  const identityCore = {
    authorId: '000074' as const,
    name: 'かじいもとじろう' as const,
    originalName: '梶井基次郎' as const,
    slug: 'kajii-motojiro' as const,
  };
  const identitySha256 = sha256(new TextEncoder().encode(canonicalJson(identityCore)));
  const registry = deepFreeze({
    __brand: 'F010WorkRegistry' as const,
    ...identityCore,
    identitySha256,
    authorMode: 'introduce' as const,
    works: F010_WORKS.map((work) => ({ workId: work.workId, title: work.title, order: work.order })),
  });
  mintedRegistries.add(registry);
  return registry;
}

/**
 * registryのidentityを既存Catalogの作者・作品との非衝突込みで再確認する。
 *
 * DD-F010.md（FUN-F010-004）は既存`verifyExistingAuthorIdentity`
 * （`batch-candidate.ts`）の再利用を記載するが、F007実装で確認済みの通り、
 * 同関数は`context.definition.authorExpectation === 'reuse'`のApprovedBatchContext
 * だけを受理し、F010の`introduce`（新規作者）シナリオでは常に
 * `CANDIDATE_REGISTRY_INVALID`で例外になる（reuse専用関数のため）。
 * 本関数は`f006-source.ts`/`f007-source.ts`の同型関数と同じ構造を踏襲する。
 * @des DES-F010-003 @fun FUN-F010-004 @ut UT-F010-004
 */
export function verifyF010AuthorIdentity(
  registry: F010WorkRegistry,
  baselineCatalog: {
    readonly authors: readonly { readonly authorId: string; readonly name: string; readonly originalName: string; readonly slug: string }[];
    readonly works: readonly { readonly authorId: string }[];
  },
): F010VerifiedAuthor {
  if (!isRecord(registry) || !mintedRegistries.has(registry) || registry.__brand !== 'F010WorkRegistry') {
    throw new F010SourceError('F010_REGISTRY_MISMATCH', 'mint済みregistryが必要です');
  }
  if (
    !isRecord(baselineCatalog) ||
    !Array.isArray(baselineCatalog.authors) ||
    !Array.isArray(baselineCatalog.works) ||
    baselineCatalog.authors.some((existing) =>
      existing.authorId === registry.authorId || existing.name === registry.name ||
      existing.originalName === registry.originalName || existing.slug === registry.slug) ||
    baselineCatalog.works.some((work) => work.authorId === registry.authorId)
  ) {
    throw new F010SourceError('F010_REGISTRY_MISMATCH', 'baseline作者・作品との衝突を検出しました');
  }
  const verified = deepFreeze({
    __brand: 'F010VerifiedAuthor' as const,
    authorId: registry.authorId,
    name: registry.name,
    originalName: registry.originalName,
    slug: registry.slug,
    identitySha256: registry.identitySha256,
  });
  verifiedF010Authors.add(verified);
  return verified;
}

/**
 * @des DES-F010-003 @fun FUN-F010-004
 */
export function isVerifiedF010Author(value: unknown): value is F010VerifiedAuthor {
  return isRecord(value) && verifiedF010Authors.has(value) && value.__brand === 'F010VerifiedAuthor';
}

/**
 * @des DES-F010-004 DES-F010-005 @fun FUN-F010-005 FUN-F010-006
 */
function requireExactF010Context(context: unknown): asserts context is ApprovedBatchContext {
  if (!isMintedApprovedBatchContext(context)) {
    throw new F010SourceError('F010_CONTEXT_INVALID', 'F010のmint済み承認contextが必要です');
  }
  const rawWorks = context.candidate.works;
  if (
    context.definition.feature !== 'F010' ||
    context.definition.batchId !== 'F010' ||
    context.candidate.feature !== 'F010' ||
    context.candidate.author.authorId !== AUTHOR_ID ||
    rawWorks.length !== F010_WORKS.length
  ) {
    throw new F010SourceError('F010_CONTEXT_INVALID', 'F010 contextの固定tupleが一致しません');
  }
  rawWorks.forEach((item, index) => {
    const expected = F010_WORKS[index]!;
    if (
      item.workId !== expected.workId ||
      item.title !== expected.title ||
      item.cardUrl !== expected.cardUrl ||
      item.xhtmlUrl !== expected.sourceUrl
    ) {
      throw new F010SourceError('F010_CONTEXT_INVALID', 'F010 contextの作品順が一致しません');
    }
  });
}

function assertTrustedTime(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new F010SourceError('F010_CONTEXT_INVALID', 'trusted clockが不正です');
  }
  return value.toISOString();
}

function mediaTypeAndCharset(response: TransportResponse): { mediaType: string; charset: string | null } {
  const headers = response.headers instanceof Headers
    ? response.headers
    : new Headers(Object.entries(response.headers).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const raw = headers.get('content-type') ?? '';
  const [media = '', ...parameters] = raw.split(';');
  const charsetParameter = parameters
    .map((item) => item.trim())
    .find((item) => /^charset\s*=/iu.test(item));
  return {
    mediaType: media.trim().toLowerCase(),
    charset: charsetParameter?.replace(/^charset\s*=\s*["']?|["']$/giu, '') ?? null,
  };
}

function normalizeHttpCharset(value: string | null): 'UTF-8' | 'Shift_JIS' | null {
  if (value === null) return null;
  const normalized = value.replace(/[_-]/gu, '').toLowerCase();
  if (normalized === 'utf8') return 'UTF-8';
  if (normalized === 'shiftjis' || normalized === 'sjis') return 'Shift_JIS';
  return null;
}

function declaredDocumentCharsets(bytes: Uint8Array): readonly ('UTF-8' | 'Shift_JIS')[] {
  const ascii = new TextDecoder('windows-1252').decode(bytes.subarray(0, Math.min(bytes.byteLength, 16_384)));
  const declarations = [
    ...ascii.matchAll(/\bcharset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/giu),
    ...ascii.matchAll(/<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/giu),
  ]
    .map((match) => normalizeHttpCharset(match[1] ?? null))
    .filter((value): value is 'UTF-8' | 'Shift_JIS' => value !== null);
  return [...new Set(declarations)];
}

function policyPlainText(raw: Uint8Array): string | null {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
  const text = decoded
    .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:nbsp|#160);/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .trim()
    .normalize('NFC');
  const meaningful = [...text].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  return text.length >= 48 && meaningful / Math.max(text.length, 1) >= 0.25 ? text : null;
}

function clause(
  clauseId: string,
  text: string | null,
  required: readonly RegExp[],
  prohibited?: RegExp,
): F010PolicyClauseResult {
  if (text === null) return { clauseId, status: 'unknown' };
  if (prohibited?.test(text)) return { clauseId, status: 'prohibited' };
  return {
    clauseId,
    status: required.every((pattern) => pattern.test(text)) ? 'satisfied' : 'missing',
  };
}

/**
 * 3規約ごとに固定clauseを解析し、意味なし・欠落・禁止・未知本文をallowへ昇格させない。
 * `f007-source.ts`の`evaluateF007PolicyClauses`と同一ロジック（policy IDはfeature非依存の
 * VOICEVOX/ずんだもん3規約で共通）をF010向けbrandとして複製する。
 * @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005
 */
export function evaluateF010PolicyClauses(
  policyId: (typeof F010_POLICY_IDS)[number],
  raw: Uint8Array,
): F010PolicyClauseDecision {
  if (!F010_POLICY_IDS.includes(policyId)) {
    throw new F010SourceError('F010_USAGE_NOT_ALLOWED', '未承認policy IDです');
  }
  const text = policyPlainText(raw);
  const usageForbidden = /(?:無料|非商用|個人利用|広告なし)[^。]{0,80}(?:禁止|認め(?:ない|ません))/u;
  let clauses: F010PolicyClauseResult[];
  if (policyId === 'voicevox-terms') {
    clauses = [
      clause('voicevox-document', text, [/VOICEVOX/u, /利用規約/u]),
      clause('voicevox-credit', text, [/VOICEVOX/u, /クレジット表記が必要/u]),
      clause('voicevox-use', text, [
        /(?:商用・非商用問わず|無料)/u,
        /(?:利用することができます|無料利用できます)/u,
      ], usageForbidden),
    ];
  } else if (policyId === 'zundamon-audio-terms') {
    clauses = [
      clause('audio-document', text, [/音源利用規約/u, /ずんだもん/u]),
      clause('audio-credit', text, [/(?:クレジット|表記|名前)/u, /ずんだもん/u]),
      clause('audio-use', text, [
        /(?:商用、非商用ともにご利用いただけます|非商用利用できます)/u,
      ], usageForbidden),
    ];
  } else {
    clauses = [
      clause('character-document', text, [/キャラクター利用(?:の)?ガイドライン/u, /ずんだもん/u]),
      clause('character-unofficial', text, [/(?:二次創作|非公式)/u]),
      clause('character-use', text, [
        /(?:非商用(?:の場合)?[^。]{0,40}(?:自由に)?ご?利用(?:いただけ|でき)|個人利用はできます)/u,
      ], usageForbidden),
    ];
  }
  const decision = deepFreeze({
    __brand: 'F010PolicyClauseDecision' as const,
    policyId,
    contentSha256: sha256(raw),
    classification: 'free-no-ads-no-payments-no-sponsorship-unofficial' as const,
    requiredCredit: 'VOICEVOX:ずんだもん' as const,
    decision: clauses.every((item) => item.status === 'satisfied') ? 'allow' as const : 'blocked' as const,
    clauses: clauses.map((item) => Object.freeze(item)),
  });
  mintedPolicyDecisions.add(decision);
  return decision;
}

function artifact(
  sourceUrl: string,
  response: TransportResponse,
  expectedMediaType: string,
  expectedCharset: 'UTF-8' | 'Shift_JIS' | null,
  maxBytes: number,
  fallbackFetchedAt: string,
): RawArtifactRef {
  const observed = mediaTypeAndCharset(response);
  const httpCharset = normalizeHttpCharset(observed.charset);
  const declaredCharsets = declaredDocumentCharsets(response.body);
  const charsetMatches = expectedCharset === null
    ? httpCharset === null
    : (
      (httpCharset === expectedCharset ||
        (httpCharset === null &&
          declaredCharsets.length === 1 &&
          declaredCharsets[0] === expectedCharset)) &&
      declaredCharsets.every((value) => value === expectedCharset)
    );
  if (
    response.status !== 200 ||
    response.elapsedMs === undefined ||
    response.elapsedMs < 0 ||
    response.elapsedMs >= AOZORA_TIMEOUT_MS ||
    response.body.byteLength > maxBytes ||
    observed.mediaType !== expectedMediaType ||
    !charsetMatches
  ) {
    throw new F010SourceError('F010_SOURCE_RESPONSE_INVALID', '公式取得responseが固定条件を満たしません');
  }
  const fetchedAt = response.fetchedAt ?? fallbackFetchedAt;
  if (!Number.isFinite(Date.parse(fetchedAt))) {
    throw new F010SourceError('F010_SOURCE_RESPONSE_INVALID', '公式取得時刻が不正です');
  }
  if (
    !response.security ||
    response.security.dnsAddresses.length === 0 ||
    !response.security.dnsAddresses.includes(response.security.connectedAddress) ||
    response.security.hostHeader !== new URL(sourceUrl).hostname ||
    response.security.serverName !== new URL(sourceUrl).hostname ||
    response.security.tlsAuthorized !== true ||
    response.security.hostnameVerified !== true ||
    response.security.redirectsFollowed !== 0 ||
    response.security.proxyUsed !== false ||
    response.security.attempts !== 1
  ) {
    throw new F010SourceError('F010_SOURCE_RESPONSE_INVALID', 'transport security evidenceが不正です');
  }
  const bytes = cloneBytes(response.body);
  return deepFreeze({
    storage: 'inline',
    sourceUrl,
    fetchedAt,
    mediaType: observed.mediaType,
    charset: expectedCharset,
    bytes,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    transport: structuredClone(response.security),
  });
}

async function requestArtifact(
  transport: ProductionAozoraTransport,
  sourceUrl: string,
  pathPrefix: string,
  mediaType: string,
  charset: 'UTF-8' | 'Shift_JIS' | null,
  maxBytes: number,
  fallbackFetchedAt: string,
): Promise<RawArtifactRef> {
  const policy: TransportPolicy = {
    pathPrefix,
    allowedMediaTypes: [mediaType],
    maxBytes,
    timeoutMs: AOZORA_TIMEOUT_MS,
  };
  const response = await transport.request(new URL(sourceUrl), policy);
  return artifact(sourceUrl, response, mediaType, charset, maxBytes, fallbackFetchedAt);
}

function assertExpectedRow(row: BibliographyRow, expected: (typeof F010_WORKS)[number]): void {
  if (
    row.workId !== expected.workId ||
    row.title !== expected.title ||
    row.personId !== AUTHOR_ID ||
    row.personCopyright !== 'なし' ||
    row.copyright !== 'なし' ||
    row.role !== '著者' ||
    row.status !== '公開中' ||
    row.language !== '日本語原著' ||
    row.orthography !== '新字新仮名' ||
    row.cardUrl !== expected.cardUrl ||
    row.sourceUrl !== expected.sourceUrl ||
    normalizeHttpCharset(row.charset) !== 'Shift_JIS'
  ) {
    throw new F010SourceError('F010_SOURCE_DRIFT', `公式書誌が固定条件と一致しません: ${expected.workId}`);
  }
}

const F010_POLICY_ADJUDICATION_PATH = 'content/batches/F010/rights-adjudications.json';
const F010_ADJUDICATION_SHA256 = /^[a-f0-9]{64}$/u;

export interface F010PolicyAdjudication {
  readonly policyId: string;
  readonly previousSha256: string;
  readonly currentSha256: string;
  readonly decision: 'no-material-change';
  readonly reviewedAt: string;
  readonly reviewer: string;
  readonly note: string;
}

async function readF010PolicyAdjudications(
  workspace: string,
): Promise<readonly F010PolicyAdjudication[]> {
  let text: string;
  try {
    text = await readFile(resolve(workspace, ...F010_POLICY_ADJUDICATION_PATH.split('/')), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new F010SourceError('F010_SOURCE_DRIFT', '裁定記録が不正なJSONです', { cause: error });
  }
  if (canonicalJson(parsed) !== text || !Array.isArray(parsed)) {
    throw new F010SourceError('F010_SOURCE_DRIFT', '裁定記録がcanonical JSON配列ではありません');
  }
  for (const item of parsed) {
    if (!isRecord(item) ||
      !hasExactKeys(item, ['currentSha256', 'decision', 'note', 'policyId', 'previousSha256', 'reviewedAt', 'reviewer']) ||
      !nonBlank(item.policyId) || !F010_ADJUDICATION_SHA256.test(String(item.previousSha256)) ||
      !F010_ADJUDICATION_SHA256.test(String(item.currentSha256)) ||
      item.decision !== 'no-material-change' ||
      !nonBlank(item.reviewer) || !nonBlank(item.note) ||
      !Number.isFinite(Date.parse(String(item.reviewedAt)))) {
      throw new F010SourceError('F010_SOURCE_DRIFT', '裁定記録の項目が不正です');
    }
  }
  return parsed as readonly F010PolicyAdjudication[];
}

/**
 * F010の公式書誌・作家ページ・図書カード・XHTML・VOICEVOX/ずんだもん3規約を
 * productionのHTTPS transportだけで取得し、raw snapshotへ固定する。
 * `f007-source.ts`の`collectF007SourceSnapshot`と同一構造をauthorId `000074`・
 * 檸檬/Ｋの昇天/愛撫へパラメータ化した複製。
 * @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005
 */
export async function collectF010SourceSnapshot(
  transport: ProductionAozoraTransport,
  context: ApprovedBatchContext,
  phase: F010Phase,
  trustedClock: () => Date,
  options: F010CollectionOptions,
): Promise<F010SourceSnapshot> {
  if (
    !(transport instanceof ProductionAozoraTransport) ||
    transport.request !== ProductionAozoraTransport.prototype.request
  ) {
    throw new F010SourceError('F010_TRANSPORT_REQUIRED', 'production transportが必要です');
  }
  requireExactF010Context(context);
  if (
    !isRecord(options) ||
    !(options.policyTransport instanceof ProductionPolicyTransport) ||
    options.policyTransport.request !== ProductionPolicyTransport.prototype.request ||
    !isAbsolute(options.trustedProjectRoot) ||
    !isAbsolute(options.workspace)
  ) {
    throw new F010SourceError('F010_TRANSPORT_REQUIRED', 'production規約transportとtrusted workspaceが必要です');
  }
  if (phase !== 'selection' && phase !== 'predeploy') {
    throw new F010SourceError('F010_CONTEXT_INVALID', '観測phaseが不正です');
  }
  const observedAt = assertTrustedTime(trustedClock());
  const bibliographyArchive = await requestArtifact(
    transport,
    AOZORA_BIBLIOGRAPHY_URL,
    '/index_pages/',
    'application/zip',
    null,
    MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
    observedAt,
  );
  let csvBytes: Uint8Array;
  try {
    csvBytes = extractVerifiedBibliographyCsv(bibliographyArchive.bytes);
  } catch (error) {
    throw new F010SourceError('F010_SOURCE_RESPONSE_INVALID', '公式書誌ZIPを安全に展開できません', { cause: error });
  }
  const bibliographyCsv = deepFreeze({
    storage: 'inline' as const,
    sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
    fetchedAt: bibliographyArchive.fetchedAt,
    mediaType: 'text/csv',
    charset: 'UTF-8' as const,
    bytes: cloneBytes(csvBytes),
    byteLength: csvBytes.byteLength,
    sha256: sha256(csvBytes),
    transport: bibliographyArchive.transport,
  });
  let rows: BibliographyRow[];
  try {
    rows = parseAozoraBibliography(csvBytes);
  } catch (error) {
    throw new F010SourceError('F010_BIBLIOGRAPHY_INVALID', '公式書誌CSVが不正です', { cause: error });
  }
  const selectedRows = F010_WORKS.map((expected) => {
    const matches = rows.filter((row) =>
      row.workId === expected.workId && row.personId === AUTHOR_ID && row.role === '著者',
    );
    if (matches.length !== 1) {
      throw new F010SourceError('F010_SOURCE_DRIFT', `公式書誌の対象行が一意ではありません: ${expected.workId}`);
    }
    const row = matches[0]!;
    assertExpectedRow(row, expected);
    return deepFreeze(structuredClone(row));
  });
  const authorPage = await requestArtifact(
    transport,
    AUTHOR_PAGE_URL,
    '/index_pages/',
    'text/html',
    'UTF-8',
    MAX_SOURCE_BYTES,
    observedAt,
  );
  const definitions = createPolicyDefinitions(
    options.trustedProjectRoot,
    options.workspace,
    'F010',
  ).filter((definition): definition is typeof definition & {
    readonly policyId: (typeof F010_POLICY_IDS)[number];
  } => F010_POLICY_IDS.includes(definition.policyId as (typeof F010_POLICY_IDS)[number]));
  const policies: F010PolicySnapshot[] = [];
  for (const policyId of F010_POLICY_IDS) {
    const definition = definitions.find((item) => item.policyId === policyId);
    if (!definition) {
      throw new F010SourceError('F010_SOURCE_DRIFT', `規約定義がありません: ${policyId}`);
    }
    let fetched;
    try {
      fetched = await fetchPolicyObservation(definition, options.policyTransport);
    } catch (error) {
      throw new F010SourceError('F010_SOURCE_RESPONSE_INVALID', `規約取得に失敗しました: ${policyId}`, { cause: error });
    }
    const bytes = cloneBytes(fetched.body);
    const decision = evaluateF010PolicyClauses(policyId, bytes);
    policies.push(deepFreeze({
      policyId,
      versionOrLabel: definition.versionOrLabel,
      artifact: {
        storage: 'inline' as const,
        sourceUrl: definition.url,
        fetchedAt: fetched.fetchedAt,
        mediaType: fetched.mediaType,
        charset: null,
        bytes,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        transport: structuredClone(fetched.security),
      },
      decision,
    }));
  }
  const works: F010WorkSnapshot[] = [];
  for (const [index, expected] of F010_WORKS.entries()) {
    const card = await requestArtifact(
      transport,
      expected.cardUrl,
      '/cards/000074/',
      'text/html',
      'UTF-8',
      MAX_SOURCE_BYTES,
      observedAt,
    );
    const xhtml = await requestArtifact(
      transport,
      expected.sourceUrl,
      '/cards/000074/',
      'text/html',
      'Shift_JIS',
      MAX_SOURCE_BYTES,
      observedAt,
    );
    const work = deepFreeze({
      workId: expected.workId,
      title: expected.title,
      bibliography: selectedRows[index]!,
      card,
      xhtml,
    });
    mintedWorkSnapshots.add(work);
    works.push(work);
  }
  const snapshot = deepFreeze({
    schemaVersion: '1.0.0' as const,
    authorId: '000074' as const,
    phase,
    observedAt,
    bibliographyArchive,
    bibliographyCsv,
    authorPage,
    policies,
    works,
  });
  mintedSnapshots.add(snapshot);
  if (phase === 'selection') {
    if (options.selectionSnapshot !== undefined) {
      throw new F010SourceError('F010_CONTEXT_INVALID', 'selection観測へ旧snapshotは指定できません');
    }
  } else {
    const selection = options.selectionSnapshot;
    if (!selection || !mintedSnapshots.has(selection) || selection.phase !== 'selection') {
      throw new F010SourceError('F010_SOURCE_DRIFT', 'predeployにはmint済みselection snapshotが必要です');
    }
    const worksBefore = selection.works.flatMap((work) => [work.card.sha256, work.xhtml.sha256]);
    const worksAfter = snapshot.works.flatMap((work) => [work.card.sha256, work.xhtml.sha256]);
    if (JSON.stringify(worksBefore) !== JSON.stringify(worksAfter)) {
      throw new F010SourceError('F010_SOURCE_DRIFT', 'selection/predeployの原典SHAが変化しました');
    }
    const rowsBefore = selection.works.map((work) => canonicalJson(work.bibliography));
    const rowsAfter = snapshot.works.map((work) => canonicalJson(work.bibliography));
    if (JSON.stringify(rowsBefore) !== JSON.stringify(rowsAfter)) {
      throw new F010SourceError('F010_SOURCE_DRIFT', 'selection/predeployの対象作品の書誌が変化しました');
    }
    const drifted = snapshot.policies.filter((policy) => {
      const previous = selection.policies.find((item) => item.policyId === policy.policyId);
      return !previous || previous.artifact.sha256 !== policy.artifact.sha256;
    });
    if (drifted.length !== 0) {
      const adjudications = await readF010PolicyAdjudications(options.workspace);
      for (const policy of drifted) {
        const previous = selection.policies.find((item) => item.policyId === policy.policyId);
        const decided = adjudications.find((item) =>
          item.policyId === policy.policyId &&
          item.previousSha256 === previous?.artifact.sha256 &&
          item.currentSha256 === policy.artifact.sha256 &&
          item.decision === 'no-material-change');
        if (!decided) {
          throw new F010SourceError('F010_SOURCE_DRIFT', `規約が変化し裁定記録がありません: ${policy.policyId}`);
        }
      }
    }
  }
  return snapshot;
}

/**
 * 取得済みsnapshotと固定用途profileから、権利・規約条件をfail-closed評価する。
 * @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005
 */
export function evaluateF010RightsAndUsage(
  snapshot: F010SourceSnapshot,
  usageProfile: F010UsageProfile,
): F010RightsUsageDecision {
  if (!isRecord(snapshot) || !mintedSnapshots.has(snapshot)) {
    throw new F010SourceError('F010_USAGE_NOT_ALLOWED', '検証済みsnapshotが必要です');
  }
  const reasons: string[] = [];
  if (
    snapshot.policies.length !== F010_POLICY_IDS.length ||
    snapshot.policies.some((policy, index) =>
      policy.policyId !== F010_POLICY_IDS[index] ||
      policy.artifact.sha256 !== sha256(policy.artifact.bytes) ||
      policy.artifact.byteLength !== policy.artifact.bytes.byteLength ||
      policy.artifact.byteLength > MAX_SOURCE_BYTES ||
      !mintedPolicyDecisions.has(policy.decision) ||
      policy.decision.policyId !== policy.policyId ||
      policy.decision.contentSha256 !== policy.artifact.sha256 ||
      policy.decision.decision !== 'allow'
    )
  ) {
    reasons.push('POLICY_SNAPSHOT_INVALID');
  }
  if (
    !isRecord(usageProfile) ||
    Object.keys(usageProfile).sort().join(',') !== 'advertising,free,payments,sponsorship,unofficial,voiceCredit' ||
    usageProfile.free !== true ||
    usageProfile.advertising !== false ||
    usageProfile.payments !== false ||
    usageProfile.sponsorship !== false ||
    usageProfile.unofficial !== true ||
    usageProfile.voiceCredit !== 'VOICEVOX:ずんだもん'
  ) {
    reasons.push('USAGE_PROFILE_MISMATCH');
  }
  snapshot.works.forEach((work, index) => {
    try {
      assertExpectedRow(work.bibliography, F010_WORKS[index]!);
    } catch {
      reasons.push(`RIGHTS_DRIFT:${work.workId}`);
    }
  });
  return deepFreeze({
    decision: reasons.length === 0 ? 'allow' as const : 'blocked' as const,
    reasons,
    phase: snapshot.phase,
    observedAt: snapshot.observedAt,
  });
}

/**
 * 校正者は3作品とも記載ありのため非nullを必須とする（`f005-source.ts`の
 * `parseBibliographyV2`が持つ夢十夜専用null許可分岐はF010では不要）。
 * @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005
 */
export function parseF010BibliographyV2(value: unknown, workId: F010WorkId): F010BibliographyV2 {
  if (!F010_WORKS.some((work) => work.workId === workId)) {
    throw new F010SourceError('F010_BIBLIOGRAPHY_INVALID', '未承認work IDです');
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'baseEdition') ||
    !Object.hasOwn(value, 'inputter') ||
    !Object.hasOwn(value, 'proofreader') ||
    !nonBlank(value.baseEdition) ||
    !nonBlank(value.inputter) ||
    !nonBlank(value.proofreader)
  ) {
    throw new F010SourceError('F010_BIBLIOGRAPHY_INVALID', '書誌V2 schemaが不正です（proofreaderは非null必須）');
  }
  return deepFreeze({
    baseEdition: value.baseEdition,
    inputter: value.inputter,
    proofreader: value.proofreader,
  });
}

function extractCardUpdatedAt(card: RawArtifactRef, sourceUrl: string): string {
  if (
    card.charset !== 'UTF-8' ||
    card.sha256 !== sha256(card.bytes) ||
    card.byteLength !== card.bytes.byteLength
  ) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'card raw/SHA bindingが一致しません');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(card.bytes);
  } catch (error) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'card UTF-8 decodeに失敗しました', { cause: error });
  }
  const all = [...text.matchAll(/最終更新日/gu)];
  if (all.length !== 1) throw new F010SourceError('F010_SOURCE_DRIFT', 'card最終更新日headerが一意ではありません');
  const sourceFile = new URL(sourceUrl).pathname.split('/').at(-1);
  const sourceRows = sourceFile
    ? [...text.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/giu)]
      .filter((match) => match[0].includes(`./files/${sourceFile}`))
    : [];
  if (sourceRows.length > 1) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'cardの対象XHTML行が一意ではありません');
  }
  const rowDates = sourceRows[0]?.[0].match(/\d{4}-\d{2}-\d{2}/gu) ?? [];
  const iso = rowDates.length === 2
    ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(rowDates[1]!)
    : /最終更新日[^0-9]{0,40}(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/u.exec(text);
  if (!iso) throw new F010SourceError('F010_SOURCE_DRIFT', 'card最終更新日が一意に取得できません');
  const year = iso[1]!;
  const month = iso[2]!.padStart(2, '0');
  const day = iso[3]!.padStart(2, '0');
  const value = `${year}-${month}-${day}`;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const date = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  if (
    !Number.isInteger(yearNumber) ||
    year.length !== 4 ||
    monthNumber < 1 || monthNumber > 12 ||
    dayNumber < 1 || dayNumber > 31 ||
    date.getUTCFullYear() !== yearNumber ||
    date.getUTCMonth() !== monthNumber - 1 ||
    date.getUTCDate() !== dayNumber
  ) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'card最終更新日が不正です');
  }
  return value;
}

function assertSourceRecordArtifacts(sourceRecord: F010SourceRecordV2): void {
  if (
    sourceRecord.raw.sha256 !== sha256(sourceRecord.raw.bytes) ||
    sourceRecord.raw.byteLength !== sourceRecord.raw.bytes.byteLength ||
    sourceRecord.card.sha256 !== sha256(sourceRecord.card.bytes) ||
    sourceRecord.card.byteLength !== sourceRecord.card.bytes.byteLength ||
    sourceRecord.cardRawSha256 !== sourceRecord.card.sha256 ||
    sourceRecord.cardRawBytes !== sourceRecord.card.byteLength
  ) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'SourceRecordV2 raw/cardが境界前に改変されました');
  }
}

/**
 * minted work snapshotからraw参照を失わないSourceRecordV2を構築する。
 * @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005
 */
export function parseF010SourceRecord(
  snapshot: F010WorkSnapshot,
  expectedWorkId: F010WorkId,
): F010SourceRecordV2 {
  if (!isRecord(snapshot) || !mintedWorkSnapshots.has(snapshot)) {
    throw new F010SourceError('F010_SOURCE_DRIFT', '検証済みwork snapshotが必要です');
  }
  const expected = F010_WORKS.find((work) => work.workId === expectedWorkId);
  if (
    !expected ||
    snapshot.workId !== expected.workId ||
    snapshot.title !== expected.title ||
    snapshot.card.sourceUrl !== expected.cardUrl ||
    snapshot.xhtml.sourceUrl !== expected.sourceUrl ||
    snapshot.xhtml.charset !== 'Shift_JIS' ||
    snapshot.xhtml.sha256 !== sha256(snapshot.xhtml.bytes)
  ) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'source snapshotが固定作品と一致しません');
  }
  const bibliography = parseF010BibliographyV2({
    baseEdition: snapshot.bibliography.baseEdition,
    inputter: snapshot.bibliography.inputter,
    proofreader: snapshot.bibliography.proofreader,
  }, expected.workId);
  const updatedAt = extractCardUpdatedAt(snapshot.card, expected.sourceUrl);
  const record = deepFreeze({
    schemaVersion: '1.0.0' as const,
    workId: expected.workId,
    title: expected.title,
    cardUrl: expected.cardUrl,
    sourceUrl: expected.sourceUrl,
    fetchedAt: snapshot.xhtml.fetchedAt,
    updatedAt,
    raw: snapshot.xhtml,
    card: snapshot.card,
    cardRawSha256: snapshot.card.sha256,
    cardRawBytes: snapshot.card.byteLength,
    bibliographyCharset: 'Shift_JIS' as const,
    bodySelector: '.main_text' as const,
    bibliography,
  });
  mintedSourceRecords.add(record);
  assertSourceRecordArtifacts(record);
  return record;
}

/**
 * 公開provenanceは封緘済み選定snapshotと原典記録だけから決定的に組み立てる。
 * `f007-source.ts`の`buildF007SourceProvenance`と同一構造の複製。
 * @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005
 */
export function buildF010SourceProvenance(
  source: F010SourceRecordV2,
  snapshot: F010SourceSnapshot,
): Record<string, unknown> {
  return {
    baseEdition: source.bibliography.baseEdition,
    bibliography: {
      archiveBytes: snapshot.bibliographyArchive.byteLength,
      archiveSha256: snapshot.bibliographyArchive.sha256,
      csvBytes: snapshot.bibliographyCsv.byteLength,
      csvEntry: 'list_person_all_extended_utf8.csv',
      csvSha256: snapshot.bibliographyCsv.sha256,
      sourceUrl: snapshot.bibliographyArchive.sourceUrl,
    },
    changeNotice: '原文抽出・台詞選定・ずんだもん音声化を実施。加工部分はCC BY 4.0。',
    fetchedAt: source.fetchedAt,
    inputter: source.bibliography.inputter,
    proofreader: source.bibliography.proofreader,
    sourceSha256: source.raw.sha256,
    sourceUrl: source.sourceUrl,
    stableCardUrl: source.cardUrl,
    toolVersion: 'bungo-zundamon-source-v1',
    transformation:
      '公式XHTMLの実体参照正規化・本文抽出・台詞候補抽出・独立2名レビュー・音声合成',
  };
}

/**
 * DOMAIN-F010.md §5の実測（未定義entity0件、3作品とも）どおり、F010は
 * passthroughのみを許容する。F007「舞姫」・F009「瓶詰地獄」で必要になった
 * `&nbsp;`固定context等長置換のような特殊caseはF010の実データには存在しない
 * （実HTTPS取得で確認済み。本関数実装時に再確認する）。標準5種
 * （`&amp;&lt;&gt;&quot;&apos;`）以外のnamed entityが1件でも出現した場合は
 * fail-closedで拒否し、当該作品を`pending`に留める。
 * @des DES-F010-005 @fun FUN-F010-006 @ut UT-F010-006
 */
export function normalizeF010AozoraXhtmlEntities(
  rawBytes: Uint8Array,
  sourceRecord: F010SourceRecordV2,
): F010EntityNormalizationResult {
  if (!isRecord(sourceRecord) || !mintedSourceRecords.has(sourceRecord)) {
    throw new F010SourceError('F010_ENTITY_NORMALIZATION_INVALID', 'mint済みSourceRecordV2が必要です');
  }
  assertSourceRecordArtifacts(sourceRecord);
  if (
    sourceRecord.raw.byteLength !== rawBytes.byteLength ||
    sourceRecord.raw.sha256 !== sha256(rawBytes)
  ) {
    throw new F010SourceError('F010_ENTITY_NORMALIZATION_INVALID', 'raw source bindingが一致しません');
  }
  let text: string;
  try {
    text = new TextDecoder('shift_jis', { fatal: true }).decode(rawBytes);
  } catch (error) {
    throw new F010SourceError('F010_ENTITY_NORMALIZATION_INVALID', 'Shift_JIS fatal decodeに失敗しました', { cause: error });
  }
  const namedEntities = text.match(/&([A-Za-z][A-Za-z0-9._:-]*);/gu) ?? [];
  const allowedNamedEntities = ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'];
  const unexpected = namedEntities.filter((entity) => !allowedNamedEntities.includes(entity));
  if (unexpected.length > 0) {
    throw new F010SourceError(
      'F010_ENTITY_NORMALIZATION_INVALID',
      `未定義entityを検出しました（${sourceRecord.workId}）: ${[...new Set(unexpected)].join(',')}`,
    );
  }
  const processedBytes: Uint8Array = cloneBytes(rawBytes);
  const variant: F010EntityNormalizationResult['variant'] = 'passthrough';
  const replacements: readonly F010EntityReplacement[] = [];
  const processedSha256 = sha256(processedBytes);
  const result = deepFreeze({
    schemaVersion: '1.0.0' as const,
    workId: sourceRecord.workId,
    variant,
    rawSha256: sha256(rawBytes),
    processedBytes,
    processedSha256,
    replacements,
  });
  mintedNormalizations.add(result);
  return result;
}

function canonicalizeDoctype(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/\s*>\s*$/u, '>').trim();
}

function preflightF010Xhtml(text: string): void {
  const doctypes = text.match(/<!DOCTYPE\b[\s\S]*?>/giu) ?? [];
  if (doctypes.length !== 1 || canonicalizeDoctype(doctypes[0]!) !== CANONICAL_XHTML11_DOCTYPE) {
    throw new F010SourceError('F010_XHTML_PREFLIGHT_REJECTED', 'XHTML 1.1の固定DOCTYPEではありません');
  }
  const doctypeStart = text.search(/<!DOCTYPE\b/iu);
  const doctypeEnd = text.indexOf('>', doctypeStart);
  if (text.slice(doctypeStart, doctypeEnd + 1).includes('[')) {
    throw new F010SourceError('F010_XHTML_PREFLIGHT_REJECTED', 'DOCTYPE internal subsetは禁止です');
  }
  if (
    /<!ENTITY\b/iu.test(text) ||
    /<!ENTITY\s+%/iu.test(text) ||
    /<\s*(?:xi:include|xinclude)\b/iu.test(text) ||
    /\bxsi:(?:schemaLocation|noNamespaceSchemaLocation)\s*=/iu.test(text) ||
    /<\?xml-stylesheet\b/iu.test(text) ||
    /<link\b(?=[^>]*\brel\s*=\s*["']stylesheet["'])[^>]*\bhref\s*=\s*["'](?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/iu.test(text) ||
    /@import\s+(?:url\s*\(\s*)?["']?(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/iu.test(text)
  ) {
    throw new F010SourceError('F010_XHTML_PREFLIGHT_REJECTED', '外部resource/entity構文は禁止です');
  }
  const namedEntities = text.match(/&([A-Za-z][A-Za-z0-9._:-]*);/gu) ?? [];
  if (namedEntities.some((entity) => !['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'].includes(entity))) {
    throw new F010SourceError('F010_XHTML_PREFLIGHT_REJECTED', '標準5種以外のnamed entityは禁止です');
  }
  let depth = 0;
  let nodes = 0;
  for (const match of text.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9:._-]*)\b[^>]*>/gu)) {
    const tag = match[0];
    if (match[1] === '/') {
      depth -= 1;
      if (depth < 0) throw new F010SourceError('F010_XHTML_PREFLIGHT_REJECTED', 'XML depthが不正です');
    } else {
      nodes += 1;
      if (!/\/\s*>$/u.test(tag)) depth += 1;
      if (depth > 256 || nodes > 500_000) {
        throw new F010SourceError('F010_XHTML_PREFLIGHT_REJECTED', 'XML depth/node上限を超えています');
      }
    }
  }
  const textScalars = [...text.replace(/<[^>]*>/gu, '')].length;
  if (text.length > MAX_SOURCE_BYTES || textScalars > 4_000_000 || nodes === 0) {
    throw new F010SourceError('F010_XHTML_PREFLIGHT_REJECTED', 'XHTML resource上限を超えています');
  }
}

/**
 * DES-F010-015・DD-F010.md §6明記のとおり、F010は長大候補分割ロジックを実装しない。
 * DOMAIN-F010.md §3.1の実測最大候補長は133文字（Ｋの昇天）であり、F007/F008/F009
 * 確立の600文字閾値・約1,335文字VOICEVOX失敗境界のいずれにも遠く達しない。
 * `extractF010DialogueCandidates`は分割ロジックを一切保持せず、最外側全角かぎ括弧
 * 候補をそのまま単一candidateとして決定的に生成する（合成600/601文字境界fixtureを
 * 与えても分割されず単一candidateのまま生成されることをUT-F010-006で確認する）。
 * 将来600文字超の実候補が確認された場合は、`splitOverlongF009Candidates`と同一
 * アルゴリズムを変更管理（pf-change）を経て追加実装する。
 * @des DES-F010-015 @fun FUN-F010-018
 */

// ---------------------------------------------------------------------------
// gaiji要素の候補内非混入検証（DES-F010-005の新規論点）
// ---------------------------------------------------------------------------

const GAIJI_IMG_TAG = /<img\b[^>]*>/gu;
const GAIJI_CLASS_EXACT = /\bclass\s*=\s*(?:"gaiji"|'gaiji')/u;
const MAIN_TEXT_OPEN_TAG = /<div\b[^>]*\bclass=["'][^"']*\bmain_text\b[^"']*["'][^>]*>/iu;
const BIBLIOGRAPHICAL_INFO_OPEN_TAG = /<div\b[^>]*\bclass=["'][^"']*\bbibliographical_information\b[^"']*["'][^>]*>/iu;

/**
 * raw XHTML text中の`<img class="gaiji">`要素（属性順序に依存しない、class属性値の
 * 完全一致だけを条件とする）のbyte offset範囲を全件収集する。
 * @des DES-F010-005 @fun FUN-F010-006 @ut UT-F010-006
 */
export function detectF010GaijiElements(rawText: string): readonly F010GaijiRange[] {
  if (typeof rawText !== 'string') {
    throw new F010SourceError('F010_XHTML_PREFLIGHT_REJECTED', 'gaiji検出対象のrawTextが不正です');
  }
  const ranges: F010GaijiRange[] = [];
  for (const match of rawText.matchAll(GAIJI_IMG_TAG)) {
    const tag = match[0];
    if (GAIJI_CLASS_EXACT.test(tag) && match.index !== undefined) {
      ranges.push(Object.freeze({ start: match.index, end: match.index + tag.length }));
    }
  }
  return Object.freeze(ranges);
}

/**
 * `.main_text`本文範囲（DOM抽出器が候補抽出に用いるbodyContainerと同一selector）
 * を出現順に切り出す。`.main_text`開始タグが見つからない場合はfail-safe側
 * （全文を対象）にとどめる。
 */
function mainTextRegion(rawText: string): { readonly slice: string; readonly offset: number } {
  const startMatch = MAIN_TEXT_OPEN_TAG.exec(rawText);
  if (!startMatch) return { slice: rawText, offset: 0 };
  const offset = startMatch.index;
  const rest = rawText.slice(offset);
  const endMatch = BIBLIOGRAPHICAL_INFO_OPEN_TAG.exec(rest);
  const end = endMatch ? endMatch.index : rest.length;
  return { slice: rest.slice(0, end), offset };
}

/**
 * タグ span（属性値を含む）を同じ長さの空白へ置換し、offsetを一切変えずに
 * 「タグ外の実text」だけを対象にした投影を作る。F009実装（瓶詰地獄）で判明した
 * とおり、`<img alt="※（「…」、第N水準M-NN-NN)" class="gaiji" />`のように
 * gaiji画像自身の`alt`属性値の中に「」で囲われた字形注記が埋め込まれる場合が
 * ある（DOMAIN-F010.md §5が実測する檸檬の`2-79-45.png`（「闊」の異体字）にも
 * 同様の字形注記alt属性が付与される想定）。この属性値内の「」はDOM抽出器の
 * textContentには一切現れない（img要素はtext nodeを持たない）ため、タグを
 * maskせずに生文字列をそのままbracket走査すると、gaiji自身の注記が誤って
 * 「候補」として検出されfail-closedが誤発火しうる。タグ・属性を空白maskして
 * から走査することでこの誤検出を除去する。
 */
function maskTagSpans(text: string): string {
  return text.replace(/<[^>]*>/gu, (match) => ' '.repeat(match.length));
}

/**
 * rawText中の最外側「...」区間（候補抽出時のbracket depth走査と同一アルゴリズムを
 * raw文字位置ベースで再現したもの）を出現順に列挙する。DOM抽出器は`h4`等の
 * 未知要素の内容を候補生成前に丸ごと除外するため、この生raw文字scanは実際に
 * 抽出される候補の**superset**（除外要素内の見出し等由来の余分な区間を含み得る）
 * となる。gaiji非混入検証は「実候補との重なりが0件」を厳密に保証する必要が
 * あるため、supersetとの重なりが0件であることを確認すれば十分（supersetに
 * 含まれない実候補が存在することはない）であり、fail-closedの安全側に働く。
 */
function outermostBracketRangesInRawText(rawText: string): readonly F010GaijiRange[] {
  const ranges: F010GaijiRange[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < rawText.length; index += 1) {
    const character = rawText[index];
    if (character === '「') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '」') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          ranges.push({ start, end: index + 1 });
          start = -1;
        }
      }
    }
  }
  return ranges;
}

/**
 * 抽出済み候補集合`candidateSet`のmint時rawTextから`.main_text`範囲の
 * 最外側「...」区間（実候補のsuperset、上記参照）を求め、`gaijiRanges`
 * （`detectF010GaijiElements`の結果）との区間重なりを線形走査で判定する。
 * 1件でも重なりがあれば`F010_GAIJI_WITHIN_CANDIDATE`をfail-closedで投げる。
 * @des DES-F010-005 @fun FUN-F010-006 @ut UT-F010-006
 */
export function verifyF010NoGaijiWithinCandidates(
  candidateSet: F010CandidateSet,
  gaijiRanges: readonly F010GaijiRange[],
): void {
  if (!isRecord(candidateSet) || !mintedCandidateSets.has(candidateSet)) {
    throw new F010SourceError('F010_EXTRACTION_FAILED', 'mint済みcandidate setが必要です');
  }
  const rawText = candidateSetRawText.get(candidateSet);
  if (typeof rawText !== 'string') {
    throw new F010SourceError('F010_EXTRACTION_FAILED', 'candidate setに対応するraw textがありません');
  }
  if (
    !Array.isArray(gaijiRanges) ||
    gaijiRanges.some((range: F010GaijiRange) =>
      !isRecord(range as unknown) ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start)
  ) {
    throw new F010SourceError('F010_EXTRACTION_FAILED', 'gaijiRangesが不正です');
  }
  const { slice, offset } = mainTextRegion(rawText);
  const candidateRanges = outermostBracketRangesInRawText(maskTagSpans(slice))
    .map((range) => ({ start: range.start + offset, end: range.end + offset }));
  const overlap = candidateRanges.some((candidateRange) =>
    gaijiRanges.some((gaijiRange) =>
      gaijiRange.start < candidateRange.end && candidateRange.start < gaijiRange.end));
  if (overlap) {
    throw new F010SourceError('F010_GAIJI_WITHIN_CANDIDATE', 'gaiji要素が候補範囲内に検出されました');
  }
}

/**
 * resource preflight後だけ既存inert DOM抽出器へ渡し、二重実行で決定性を確認する。
 * 抽出直後にgaiji検出（`detectF010GaijiElements`）と候補内非混入検証
 * （`verifyF010NoGaijiWithinCandidates`）を常時実行し、選定時・公開直前いずれの
 * phaseで呼ばれても省略しない（DES-F010-005）。
 * @des DES-F010-005 @fun FUN-F010-006 @ut UT-F010-006
 */
export function extractF010DialogueCandidates(
  normalization: F010EntityNormalizationResult,
  source: F010SourceRecordV2,
  extractorVersion: string,
): F010CandidateSet {
  if (!isRecord(source) || !mintedSourceRecords.has(source)) {
    throw new F010SourceError('F010_EXTRACTION_FAILED', 'mint済みSourceRecordV2が必要です');
  }
  assertSourceRecordArtifacts(source);
  if (
    !isRecord(normalization) ||
    !mintedNormalizations.has(normalization) ||
    normalization.workId !== source.workId ||
    extractorVersion !== EXTRACTOR_VERSION
  ) {
    throw new F010SourceError('F010_EXTRACTION_FAILED', '抽出input bindingが不正です');
  }
  if (sha256(normalization.processedBytes) !== normalization.processedSha256) {
    throw new F010SourceError('F010_EXTRACTION_FAILED', 'processed artifactのSHAが一致しません');
  }
  let text: string;
  try {
    text = new TextDecoder('shift_jis', { fatal: true }).decode(normalization.processedBytes);
  } catch (error) {
    throw new F010SourceError('F010_XHTML_PREFLIGHT_REJECTED', 'Shift_JIS fatal decodeに失敗しました', { cause: error });
  }
  preflightF010Xhtml(text);
  const decoded: DecodedSource = {
    workId: source.workId,
    rawSha256: normalization.processedSha256,
    httpCharset: 'Shift_JIS',
    metaCharset: 'Shift_JIS',
    bibliographyCharset: 'Shift_JIS',
    adoptedCharset: 'Shift_JIS',
    text,
  };
  const allowed = new Set<string>([source.workId]);
  const first = extractDialogueCandidates(decoded, source.workId, allowed);
  const second = extractDialogueCandidates(decoded, source.workId, allowed);
  if (JSON.stringify(first) !== JSON.stringify(second) || !first.ok) {
    throw new F010SourceError('F010_EXTRACTION_FAILED', '台詞抽出が失敗または非決定的です');
  }
  // DES-F010-015・DD-F010.md §6のとおりF010は長大候補分割を実装しない。
  // extractDialogueCandidatesの決定的出力（first.candidates）をそのまま
  // 単一candidate集合として使う（分割ステップなし）。
  const result: ExtractionResult = { ok: true, success: true, candidates: first.candidates, diagnostics: first.diagnostics };
  const candidateSet: F010CandidateSet = deepFreeze({
    schemaVersion: '1.0.0',
    workId: source.workId,
    sourceSha256: normalization.processedSha256,
    extractorVersion: EXTRACTOR_VERSION,
    result,
  });
  mintedCandidateSets.add(candidateSet);
  candidateSetRawText.set(candidateSet, text);
  const gaijiRanges = detectF010GaijiElements(text);
  verifyF010NoGaijiWithinCandidates(candidateSet, gaijiRanges);
  return candidateSet;
}

// ---------------------------------------------------------------------------
// 永続化（native guard/ETWを使わない、writeF005TemporaryFileだけによるDES-041準拠atomic書込み）
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const PERCENT_SEPARATOR = /%(?:2f|5c)/iu;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function safePathSegments(relativePosixPath: string): string[] {
  if (
    !nonBlank(relativePosixPath) ||
    isAbsolute(relativePosixPath) ||
    /^[A-Za-z]:/u.test(relativePosixPath) ||
    relativePosixPath.startsWith('//') ||
    relativePosixPath.startsWith('\\\\') ||
    relativePosixPath.includes('\\') ||
    relativePosixPath.includes(':') ||
    hasControlCharacter(relativePosixPath) ||
    PERCENT_SEPARATOR.test(relativePosixPath)
  ) {
    throw new F010SourceError('F010_PATH_UNSAFE', 'Windows pathの字句条件に違反しています');
  }
  const segments = relativePosixPath.split('/');
  if (segments.some((segment) =>
    segment === '' || segment === '.' || segment === '..' ||
    segment.endsWith('.') || segment.endsWith(' ') ||
    WINDOWS_RESERVED.test(segment) || segment.normalize('NFC') !== segment
  )) {
    throw new F010SourceError('F010_PATH_UNSAFE', 'Windows path segmentが不正です');
  }
  return segments;
}

async function safeReadFile(workspace: string, relativePosixPath: string): Promise<Uint8Array> {
  if (!isAbsolute(workspace)) {
    throw new F010SourceError('F010_PATH_UNSAFE', 'workspaceは絶対pathが必要です');
  }
  safePathSegments(relativePosixPath);
  const root = resolve(workspace);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new F010SourceError('F010_PATH_UNSAFE', 'workspace実体が不正です');
  }
  const target = join(root, ...relativePosixPath.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new F010SourceError('F010_PATH_UNSAFE', 'source pathがworkspace外です');
  }
  let cursor = root;
  for (const component of relation.split(sep)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new F010SourceError('F010_PATH_UNSAFE', 'source pathにreparseがあります');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) {
    throw new F010SourceError('F010_PATH_UNSAFE', 'source実体が通常fileではありません');
  }
  return new Uint8Array(await readFile(target));
}

/**
 * 排他作成+fsync+読み戻しSHA照合の既存`writeF005TemporaryFile`だけを使って
 * 対象pathへatomicに書き込む（DES-041準拠。native guardは使わない）。
 */
async function atomicWriteFile(workspace: string, relativePosixPath: string, bytes: Uint8Array): Promise<void> {
  safePathSegments(relativePosixPath);
  const root = resolve(workspace);
  const target = join(root, ...relativePosixPath.split('/'));
  const expectedSha256 = sha256(bytes);
  try {
    const existing = await readFile(target);
    if (sha256(new Uint8Array(existing)) === expectedSha256) return;
    throw new F010SourceError('F010_PATH_UNSAFE', `既存artifactが不一致です: ${relativePosixPath}`);
  } catch (error) {
    if (error instanceof F010SourceError) throw error;
  }
  const parent = join(root, ...relativePosixPath.split('/').slice(0, -1));
  await mkdir(parent, { recursive: true });
  const stagingDirectory = await mkdtemp(join(parent, '.f010-write-'));
  const stagingPath = join(stagingDirectory, 'artifact.tmp');
  try {
    const lease = await writeF005TemporaryFile(stagingPath, bytes, expectedSha256);
    await lease.rename(target);
    await lease.commit();
  } finally {
    await rm(stagingPath, { force: true });
    try {
      await rm(stagingDirectory);
    } catch {
      // 非空・差替えの可能性があるdirectoryは再帰削除せずfail-closedで残す。
    }
  }
}

function persistedArtifactMetadata(path: string, artifactRef: RawArtifactRef): Record<string, unknown> {
  return {
    storage: 'sealed',
    path,
    sourceUrl: artifactRef.sourceUrl,
    fetchedAt: artifactRef.fetchedAt,
    mediaType: artifactRef.mediaType,
    charset: artifactRef.charset,
    byteLength: artifactRef.byteLength,
    sha256: artifactRef.sha256,
    transport: artifactRef.transport,
  };
}

function selectionDataDirectory(): string {
  return 'data/batches/F010/source-snapshots/selection';
}

function predeployDataPath(run: string, leaf: string): string {
  return `data/batches/F010/source-snapshots/selection/predeploy-${run}-${leaf.replaceAll('/', '-')}`;
}

/**
 * 取得済みF010 snapshotを`content/batches/F010/source-snapshots/`配下の
 * canonical JSONと、raw byte実体（`data/batches/F010/source-snapshots/...`）へ
 * atomicに固定する。CSVはZIPから再導出可能なため`storage: 'derived'`として
 * 別ファイルを持たない（`f005-source.ts`の`rehydrateDerivedArtifact`と同じ最適化）。
 * @des DES-F010-004 DES-F010-005 @fun FUN-F010-005 FUN-F010-006
 */
export async function persistF010SourceSnapshot(
  workspace: string,
  snapshot: F010SourceSnapshot,
  run?: string,
): Promise<WorkspaceRelativePath> {
  if (!isRecord(snapshot) || !mintedSnapshots.has(snapshot)) {
    throw new F010SourceError('F010_SOURCE_DRIFT', '検証済みsnapshotが必要です');
  }
  if (snapshot.phase === 'predeploy' && !nonBlank(run)) {
    throw new F010SourceError('F010_PATH_UNSAFE', 'predeploy永続化にはrun識別子が必要です');
  }
  const directory = selectionDataDirectory();
  const dataPath = snapshot.phase === 'selection'
    ? (leaf: string): string => `${directory}/${leaf}`
    : (leaf: string): string => predeployDataPath(run!, leaf);

  await atomicWriteFile(workspace, dataPath('bibliography.zip'), snapshot.bibliographyArchive.bytes);
  await atomicWriteFile(workspace, dataPath('author-page.html'), snapshot.authorPage.bytes);
  for (const policy of snapshot.policies) {
    await atomicWriteFile(workspace, dataPath(`policies/${policy.policyId}.raw`), policy.artifact.bytes);
  }
  for (const work of snapshot.works) {
    await atomicWriteFile(workspace, dataPath(`works/${work.workId}/card.html`), work.card.bytes);
    await atomicWriteFile(workspace, dataPath(`works/${work.workId}/source.raw`), work.xhtml.bytes);
  }

  const rights = evaluateF010RightsAndUsage(snapshot, {
    free: true,
    advertising: false,
    payments: false,
    sponsorship: false,
    unofficial: true,
    voiceCredit: 'VOICEVOX:ずんだもん',
  });
  const document = {
    schemaVersion: '1.0.0',
    kind: snapshot.phase === 'selection'
      ? 'f010-source-selection-snapshot'
      : 'f010-source-predeploy-snapshot',
    batchId: 'F010',
    authorId: '000074',
    phase: snapshot.phase,
    observedAt: snapshot.observedAt,
    rights,
    bibliographyArchive: persistedArtifactMetadata(dataPath('bibliography.zip'), snapshot.bibliographyArchive),
    bibliographyCsv: {
      storage: 'derived',
      path: dataPath('bibliography.zip'),
      derivedFromSha256: snapshot.bibliographyArchive.sha256,
      sourceUrl: snapshot.bibliographyCsv.sourceUrl,
      fetchedAt: snapshot.bibliographyCsv.fetchedAt,
      mediaType: snapshot.bibliographyCsv.mediaType,
      charset: snapshot.bibliographyCsv.charset,
      byteLength: snapshot.bibliographyCsv.byteLength,
      sha256: snapshot.bibliographyCsv.sha256,
      transport: snapshot.bibliographyCsv.transport,
    },
    authorPage: persistedArtifactMetadata(dataPath('author-page.html'), snapshot.authorPage),
    policies: snapshot.policies.map((policy) => ({
      policyId: policy.policyId,
      versionOrLabel: policy.versionOrLabel,
      artifact: persistedArtifactMetadata(dataPath(`policies/${policy.policyId}.raw`), policy.artifact),
      decision: policy.decision,
    })),
    works: snapshot.works.map((work) => ({
      workId: work.workId,
      title: work.title,
      bibliography: work.bibliography,
      card: persistedArtifactMetadata(dataPath(`works/${work.workId}/card.html`), work.card),
      xhtml: persistedArtifactMetadata(dataPath(`works/${work.workId}/source.raw`), work.xhtml),
    })),
  };
  const targetRelative = snapshot.phase === 'selection'
    ? 'content/batches/F010/source-snapshots/selection.json'
    : `content/batches/F010/source-snapshots/predeploy-${run}.json`;
  await atomicWriteFile(workspace, targetRelative, new TextEncoder().encode(canonicalJson(document)));
  return targetRelative as WorkspaceRelativePath;
}

async function rehydrateArtifact(
  workspace: string,
  value: unknown,
  expected: {
    readonly path: string;
    readonly sourceUrl: string;
    readonly mediaType: string;
    readonly charset: 'UTF-8' | 'Shift_JIS' | null;
    readonly maxBytes: number;
  },
): Promise<RawArtifactRef> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'storage', 'path', 'sourceUrl', 'fetchedAt', 'mediaType', 'charset', 'byteLength', 'sha256', 'transport',
  ]) ||
    value.storage !== 'sealed' ||
    value.path !== expected.path ||
    value.sourceUrl !== expected.sourceUrl ||
    value.mediaType !== expected.mediaType ||
    value.charset !== expected.charset ||
    !nonBlank(value.fetchedAt) ||
    !Number.isFinite(Date.parse(value.fetchedAt)) ||
    !Number.isSafeInteger(value.byteLength) ||
    Number(value.byteLength) <= 0 ||
    Number(value.byteLength) > expected.maxBytes ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.sha256)
  ) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'persisted artifact metadataが固定tupleと一致しません');
  }
  const bytes = await safeReadFile(workspace, expected.path);
  if (bytes.byteLength !== value.byteLength || sha256(bytes) !== value.sha256) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'persisted artifact実体のSHAまたはbyte数が一致しません');
  }
  return deepFreeze({
    storage: 'inline' as const,
    sourceUrl: expected.sourceUrl,
    fetchedAt: value.fetchedAt,
    mediaType: expected.mediaType,
    charset: expected.charset,
    bytes,
    byteLength: bytes.byteLength,
    sha256: value.sha256,
    transport: deepFreeze(structuredClone(value.transport)) as Readonly<TransportSecurityEvidence | PolicySecurityProof>,
  });
}

async function rehydrateSnapshotDocument(
  workspace: string,
  context: ApprovedBatchContext,
  documentText: string,
  expectedPhase: F010Phase,
  dataPath: (leaf: string) => string,
): Promise<F010SourceSnapshot> {
  requireExactF010Context(context);
  let persisted: unknown;
  try {
    persisted = JSON.parse(documentText);
  } catch (error) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'snapshot JSONが不正です', { cause: error });
  }
  if (documentText !== canonicalJson(persisted) || !isRecord(persisted) ||
    !hasExactKeys(persisted, [
      'schemaVersion', 'kind', 'batchId', 'authorId', 'phase', 'observedAt', 'rights',
      'bibliographyArchive', 'bibliographyCsv', 'authorPage', 'policies', 'works',
    ]) ||
    persisted.schemaVersion !== '1.0.0' ||
    persisted.kind !== (expectedPhase === 'selection'
      ? 'f010-source-selection-snapshot'
      : 'f010-source-predeploy-snapshot') ||
    persisted.batchId !== 'F010' ||
    persisted.authorId !== AUTHOR_ID ||
    persisted.phase !== expectedPhase ||
    !nonBlank(persisted.observedAt) ||
    !Number.isFinite(Date.parse(persisted.observedAt)) ||
    !Array.isArray(persisted.policies) ||
    persisted.policies.length !== F010_POLICY_IDS.length ||
    !Array.isArray(persisted.works) ||
    persisted.works.length !== F010_WORKS.length
  ) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'snapshotのcanonical schemaが一致しません');
  }

  const bibliographyArchive = await rehydrateArtifact(workspace, persisted.bibliographyArchive, {
    path: dataPath('bibliography.zip'),
    sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
    mediaType: 'application/zip',
    charset: null,
    maxBytes: MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
  });
  let extractedCsv: Uint8Array;
  let rows: BibliographyRow[];
  try {
    extractedCsv = extractVerifiedBibliographyCsv(bibliographyArchive.bytes);
  } catch (error) {
    throw new F010SourceError('F010_BIBLIOGRAPHY_INVALID', 'persisted公式書誌を再検証できません', { cause: error });
  }
  const rawCsvMeta = persisted.bibliographyCsv;
  if (!isRecord(rawCsvMeta) || !hasExactKeys(rawCsvMeta, [
    'storage', 'path', 'derivedFromSha256', 'sourceUrl', 'fetchedAt', 'mediaType', 'charset', 'byteLength', 'sha256', 'transport',
  ]) ||
    rawCsvMeta.storage !== 'derived' ||
    rawCsvMeta.path !== dataPath('bibliography.zip') ||
    rawCsvMeta.derivedFromSha256 !== bibliographyArchive.sha256 ||
    rawCsvMeta.sourceUrl !== AOZORA_BIBLIOGRAPHY_URL ||
    rawCsvMeta.mediaType !== 'text/csv' ||
    rawCsvMeta.charset !== 'UTF-8' ||
    rawCsvMeta.byteLength !== extractedCsv.byteLength ||
    rawCsvMeta.byteLength > MAX_BIBLIOGRAPHY_CSV_BYTES ||
    rawCsvMeta.sha256 !== sha256(extractedCsv) ||
    canonicalJson(rawCsvMeta.transport) !== canonicalJson(bibliographyArchive.transport)
  ) {
    throw new F010SourceError('F010_SOURCE_DRIFT', 'persisted ZIP/CSV bindingが一致しません');
  }
  const bibliographyCsv = deepFreeze({
    storage: 'inline' as const,
    sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
    fetchedAt: bibliographyArchive.fetchedAt,
    mediaType: 'text/csv',
    charset: 'UTF-8' as const,
    bytes: cloneBytes(extractedCsv),
    byteLength: extractedCsv.byteLength,
    sha256: sha256(extractedCsv),
    transport: bibliographyArchive.transport,
  });
  try {
    rows = parseAozoraBibliography(extractedCsv);
  } catch (error) {
    throw new F010SourceError('F010_BIBLIOGRAPHY_INVALID', 'persisted公式書誌CSVを解析できません', { cause: error });
  }
  const selectedRows = F010_WORKS.map((expected) => {
    const matches = rows.filter((row) =>
      row.workId === expected.workId && row.personId === AUTHOR_ID && row.role === '著者');
    if (matches.length !== 1) {
      throw new F010SourceError('F010_SOURCE_DRIFT', `persisted書誌の対象行が一意ではありません: ${expected.workId}`);
    }
    assertExpectedRow(matches[0]!, expected);
    return deepFreeze(structuredClone(matches[0]!));
  });

  const authorPage = await rehydrateArtifact(workspace, persisted.authorPage, {
    path: dataPath('author-page.html'),
    sourceUrl: AUTHOR_PAGE_URL,
    mediaType: 'text/html',
    charset: 'UTF-8',
    maxBytes: MAX_SOURCE_BYTES,
  });

  const definitions = createPolicyDefinitions(workspace, workspace, 'F010')
    .filter((definition): definition is typeof definition & {
      readonly policyId: (typeof F010_POLICY_IDS)[number];
    } => F010_POLICY_IDS.includes(definition.policyId as (typeof F010_POLICY_IDS)[number]));
  const policies: F010PolicySnapshot[] = [];
  for (const [index, policyId] of F010_POLICY_IDS.entries()) {
    const rawPolicy = persisted.policies[index];
    const definition = definitions.find((item) => item.policyId === policyId);
    if (!definition || !isRecord(rawPolicy) || !hasExactKeys(rawPolicy, ['policyId', 'versionOrLabel', 'artifact', 'decision']) ||
      rawPolicy.policyId !== policyId || rawPolicy.versionOrLabel !== definition.versionOrLabel
    ) {
      throw new F010SourceError('F010_SOURCE_DRIFT', `persisted規約tupleが一致しません: ${policyId}`);
    }
    const policyArtifact = await rehydrateArtifact(workspace, rawPolicy.artifact, {
      path: dataPath(`policies/${policyId}.raw`),
      sourceUrl: definition.url,
      mediaType: 'text/html',
      charset: null,
      maxBytes: MAX_SOURCE_BYTES,
    });
    const decision = evaluateF010PolicyClauses(policyId, policyArtifact.bytes);
    if (canonicalJson(rawPolicy.decision) !== canonicalJson(decision)) {
      throw new F010SourceError('F010_SOURCE_DRIFT', `persisted規約decisionが本文と一致しません: ${policyId}`);
    }
    policies.push(deepFreeze({ policyId, versionOrLabel: definition.versionOrLabel, artifact: policyArtifact, decision }));
  }

  const works: F010WorkSnapshot[] = [];
  for (const [index, expected] of F010_WORKS.entries()) {
    const rawWork = persisted.works[index];
    const contextWork = context.candidate.works[index];
    if (!isRecord(rawWork) || !hasExactKeys(rawWork, ['workId', 'title', 'bibliography', 'card', 'xhtml']) ||
      rawWork.workId !== expected.workId || rawWork.title !== expected.title ||
      contextWork?.workId !== expected.workId || contextWork.title !== expected.title ||
      contextWork.cardUrl !== expected.cardUrl || contextWork.xhtmlUrl !== expected.sourceUrl ||
      canonicalJson(rawWork.bibliography) !== canonicalJson(selectedRows[index])
    ) {
      throw new F010SourceError('F010_SOURCE_DRIFT', `persisted作品とapproved contextが一致しません: ${expected.workId}`);
    }
    const card = await rehydrateArtifact(workspace, rawWork.card, {
      path: dataPath(`works/${expected.workId}/card.html`),
      sourceUrl: expected.cardUrl,
      mediaType: 'text/html',
      charset: 'UTF-8',
      maxBytes: MAX_SOURCE_BYTES,
    });
    const xhtml = await rehydrateArtifact(workspace, rawWork.xhtml, {
      path: dataPath(`works/${expected.workId}/source.raw`),
      sourceUrl: expected.sourceUrl,
      mediaType: 'text/html',
      charset: 'Shift_JIS',
      maxBytes: MAX_SOURCE_BYTES,
    });
    const work = deepFreeze({ workId: expected.workId, title: expected.title, bibliography: selectedRows[index]!, card, xhtml });
    mintedWorkSnapshots.add(work);
    works.push(work);
  }

  const snapshot = deepFreeze({
    schemaVersion: '1.0.0' as const,
    authorId: '000074' as const,
    phase: expectedPhase,
    observedAt: persisted.observedAt,
    bibliographyArchive,
    bibliographyCsv,
    authorPage,
    policies,
    works,
  });
  mintedSnapshots.add(snapshot);
  const rights = evaluateF010RightsAndUsage(snapshot, {
    free: true,
    advertising: false,
    payments: false,
    sponsorship: false,
    unofficial: true,
    voiceCredit: 'VOICEVOX:ずんだもん',
  });
  if (rights.decision !== 'allow' || canonicalJson(persisted.rights) !== canonicalJson(rights)) {
    throw new F010SourceError('F010_USAGE_NOT_ALLOWED', 'persisted rights decisionを再現できません');
  }
  return snapshot;
}

/**
 * 永続化済みselection snapshotを実ファイル・承認context・公式固定tupleへ再結合して再mintする。
 * @des DES-F010-004 @fun FUN-F010-005 @ut UT-F010-005
 */
export async function rehydrateF010SelectionSnapshot(
  workspace: string,
  context: ApprovedBatchContext,
): Promise<F010SourceSnapshot> {
  const documentBytes = await safeReadFile(
    workspace,
    'content/batches/F010/source-snapshots/selection.json',
  );
  const documentText = new TextDecoder('utf-8', { fatal: true }).decode(documentBytes);
  return rehydrateSnapshotDocument(
    workspace,
    context,
    documentText,
    'selection',
    (leaf) => `${selectionDataDirectory()}/${leaf}`,
  );
}

const F010_PREDEPLOY_SNAPSHOT_PATH_PATTERN =
  /^content\/batches\/F010\/source-snapshots\/predeploy-([0-9A-Za-z-]+)\.json$/u;

/**
 * process再起動後にpredeploy runを実ファイル・承認contextへ再結合して再mintする。
 * @des DES-F010-004 DES-F010-005 @fun FUN-F010-005 FUN-F010-006 @ut UT-F010-006
 */
export async function rehydrateF010PredeploySnapshot(
  workspace: string,
  context: ApprovedBatchContext,
  snapshotRelativePath: string,
): Promise<F010SourceSnapshot> {
  const match = typeof snapshotRelativePath === 'string'
    ? F010_PREDEPLOY_SNAPSHOT_PATH_PATTERN.exec(snapshotRelativePath)
    : null;
  if (!match) {
    throw new F010SourceError('F010_PATH_UNSAFE', 'predeploy snapshot pathが固定形式ではありません');
  }
  const run = match[1]!;
  const documentBytes = await safeReadFile(workspace, snapshotRelativePath);
  const documentText = new TextDecoder('utf-8', { fatal: true }).decode(documentBytes);
  return rehydrateSnapshotDocument(
    workspace,
    context,
    documentText,
    'predeploy',
    (leaf) => predeployDataPath(run, leaf),
  );
}
