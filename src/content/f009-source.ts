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
  NormalizationError,
  SUPPORTED_SPEECH_RULE_VERSION,
  extractDialogueCandidates,
  normalizeSpeechText,
  type DecodedSource,
  type ExtractionResult,
  type RawCandidate,
  type SpeechRules,
  type TextToken,
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
 * F009（夢野久作3作品追加）専用の原典・書誌・権利判定モジュール。
 *
 * DD-F009.md記載のとおり、`f005-source.ts`〜`f008-source.ts`は
 * authorId/workId定数・module-private`mintedSourceRecords`(WeakSet)の
 * brand検査が各featureへhardcodeされておりfeature非依存ではない。
 * 本モジュールは`f008-source.ts`の構造（型定義・`ProductionAozoraTransport`
 * によるHTTPS取得・権利/規約判定・書誌固定・entity正規化・決定的抽出・
 * 長大候補分割）を忠実に踏襲しつつ、authorId `000096`（夢野久作）と
 * 瓶詰地獄(002381)・きのこ会議(046694)・死後の恋(002380)へ
 * パラメータ化した新規実装である。
 *
 * `ProductionAozoraTransport`/`ProductionPolicyTransport`（`source.ts`／
 * `policy-snapshots.ts`で定義される、feature引数を取らない非依存export）は
 * そのまま再利用する。F005固有ETW/native guard機構（`resolveSafeWorkspaceFile`等）
 * は使わず、原典の永続化は既存`writeF005TemporaryFile`（`f005-postcondition-write.ts`、
 * 排他作成+fsync+読み戻しSHA照合の汎用atomic write、feature非依存）だけで行う。
 *
 * 実HTTPS取得の結果、DOMAIN-F009.md §5の実測記載（3作品とも未定義named entity0件）
 * には訂正が必要であることが判明した。瓶詰地獄(002381)には本文外（`gaiji_list`
 * 外字注記表）の固定context`<td>&nbsp;&nbsp;</td>`に`&nbsp;`が2件存在する
 * （F007の舞姫(058126)と同型のパターン）。この`&nbsp;`はXML厳格parserにとって
 * 未解決entityとなりdocument全体のinert DOM解析を失敗させるため、`f007-source.ts`
 * の`normalizeF007AozoraXhtmlEntities`と同一の等長置換（`&nbsp;`→`&#160;`、
 * 6byte→6byteでbyte offsetを変えない数値文字参照への置換）をF009向けに複製する。
 * きのこ会議(046694)・死後の恋(002380)は未定義named entity0件で実測どおり
 * passthroughのみを許容する。標準5種`&amp;&lt;&gt;&quot;&apos;`・上記固定
 * `&nbsp;`context以外のnamed entityが1件でも出現した場合はfail-closedで拒否する。
 *
 * DOMAIN-F009.md §5が指摘するとおり、瓶詰地獄・死後の恋の地の文には
 * `<img class="gaiji">`要素が実在する（瓶詰地獄4件・死後の恋2件）。F005〜F008の
 * 採用9作品では一度も検出されなかった新規パターンであり、本モジュールは
 * `detectF009GaijiElements`・`verifyNoGaijiWithinCandidates`をDES-F009-005の
 * 新規論点として実装し、選定時・公開直前の両方の独立snapshotで常時有効に検証する
 * （候補外の地の文にのみ出現することを確認済みだが、検出手順自体は無効化・
 * 緩和しない）。
 *
 * DOMAIN-F009.md §3.1が実測した死後の恋の1候補（正規化前1,748文字）向けに、
 * F007/F008で確立した長大候補分割（`splitOverlongF009Candidates`と同一アルゴリズム：
 * 600文字閾値・句点「。」の文境界でのみ分割・分割後order 0..N-1再採番・
 * `sourceAnchor`/`rawTokenRange`/`rawSourceSha256`は分割元と同一を維持）を
 * 実装当初から組み込む。F007・F008では実candidateに対して発動しなかったのに対し、
 * F009はこの分割ロジックが初めて実データに対して発動するケースである。
 *
 * @des DES-F009-004 DES-F009-005 DES-F009-015
 */

const AUTHOR_ID = '000096';
const AUTHOR_PAGE_URL = `${AOZORA_ORIGIN}/index_pages/person96.html`;
const CANONICAL_XHTML11_DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">';

const F009_POLICY_IDS = Object.freeze([
  'voicevox-terms',
  'zundamon-audio-terms',
  'zundamon-character-guideline',
] as const satisfies readonly PolicyId[]);

export const F009_WORKS = Object.freeze([
  Object.freeze({
    workId: '002381',
    title: '瓶詰地獄',
    order: 1,
    cardUrl: `${AOZORA_ORIGIN}/cards/000096/card2381.html`,
    sourceUrl: `${AOZORA_ORIGIN}/cards/000096/files/2381_13352.html`,
  }),
  Object.freeze({
    workId: '046694',
    title: 'きのこ会議',
    order: 2,
    cardUrl: `${AOZORA_ORIGIN}/cards/000096/card46694.html`,
    sourceUrl: `${AOZORA_ORIGIN}/cards/000096/files/46694_27682.html`,
  }),
  Object.freeze({
    workId: '002380',
    title: '死後の恋',
    order: 3,
    cardUrl: `${AOZORA_ORIGIN}/cards/000096/card2380.html`,
    sourceUrl: `${AOZORA_ORIGIN}/cards/000096/files/2380_13349.html`,
  }),
] as const);

export type F009WorkId = (typeof F009_WORKS)[number]['workId'];
export type F009Phase = 'selection' | 'predeploy';

export type F009SourceErrorCode =
  | 'F009_CONTEXT_INVALID'
  | 'F009_TRANSPORT_REQUIRED'
  | 'F009_SOURCE_RESPONSE_INVALID'
  | 'F009_SOURCE_DRIFT'
  | 'F009_USAGE_NOT_ALLOWED'
  | 'F009_BIBLIOGRAPHY_INVALID'
  | 'F009_ENTITY_NORMALIZATION_INVALID'
  | 'F009_XHTML_PREFLIGHT_REJECTED'
  | 'F009_EXTRACTION_FAILED'
  | 'F009_PATH_UNSAFE'
  | 'F009_REGISTRY_MISMATCH'
  | 'F009_CANDIDATE_SPLIT_IMPOSSIBLE'
  | 'F009_GAIJI_WITHIN_CANDIDATE';

export class F009SourceError extends Error {
  constructor(
    public readonly code: F009SourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'F009SourceError';
  }
}

export interface F009PolicyClauseResult {
  readonly clauseId: string;
  readonly status: 'satisfied' | 'missing' | 'prohibited' | 'unknown';
}

export interface F009PolicyClauseDecision {
  readonly __brand: 'F009PolicyClauseDecision';
  readonly policyId: (typeof F009_POLICY_IDS)[number];
  readonly contentSha256: string;
  readonly classification: 'free-no-ads-no-payments-no-sponsorship-unofficial';
  readonly requiredCredit: 'VOICEVOX:ずんだもん';
  readonly decision: 'allow' | 'blocked';
  readonly clauses: readonly F009PolicyClauseResult[];
}

export interface F009PolicySnapshot {
  readonly policyId: (typeof F009_POLICY_IDS)[number];
  readonly versionOrLabel: string;
  readonly artifact: RawArtifactRef;
  readonly decision: F009PolicyClauseDecision;
}

export interface F009WorkSnapshot {
  readonly workId: F009WorkId;
  readonly title: string;
  readonly bibliography: Readonly<BibliographyRow>;
  readonly card: RawArtifactRef;
  readonly xhtml: RawArtifactRef;
}

export interface F009SourceSnapshot {
  readonly schemaVersion: '1.0.0';
  readonly authorId: '000096';
  readonly phase: F009Phase;
  readonly observedAt: string;
  readonly bibliographyArchive: RawArtifactRef;
  readonly bibliographyCsv: RawArtifactRef;
  readonly authorPage: RawArtifactRef;
  readonly policies: readonly F009PolicySnapshot[];
  readonly works: readonly F009WorkSnapshot[];
}

export interface F009CollectionOptions {
  readonly policyTransport: ProductionPolicyTransport;
  readonly trustedProjectRoot: string;
  readonly workspace: string;
  readonly selectionSnapshot?: F009SourceSnapshot;
}

export interface F009UsageProfile {
  readonly free: boolean;
  readonly advertising: boolean;
  readonly payments: boolean;
  readonly sponsorship: boolean;
  readonly unofficial: boolean;
  readonly voiceCredit: string;
}

export interface F009RightsUsageDecision {
  readonly decision: 'allow' | 'blocked';
  readonly reasons: readonly string[];
  readonly phase: F009Phase;
  readonly observedAt: string;
}

export interface F009BibliographyV2 {
  readonly baseEdition: string;
  readonly inputter: string;
  readonly proofreader: string;
}

export interface F009SourceRecordV2 {
  readonly schemaVersion: '1.0.0';
  readonly workId: F009WorkId;
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
  readonly bibliography: F009BibliographyV2;
}

export interface F009EntityReplacement {
  readonly offset: number;
  readonly from: '&nbsp;';
  readonly to: '&#160;';
}

export interface F009EntityNormalizationResult {
  readonly schemaVersion: '1.0.0';
  readonly workId: F009WorkId;
  readonly variant: 'passthrough' | 'entity';
  readonly rawSha256: string;
  readonly processedBytes: Uint8Array;
  readonly processedSha256: string;
  readonly replacements: readonly F009EntityReplacement[];
}

export interface F009CandidateSet {
  readonly schemaVersion: '1.0.0';
  readonly workId: F009WorkId;
  readonly sourceSha256: string;
  readonly extractorVersion: typeof EXTRACTOR_VERSION;
  readonly result: ExtractionResult;
}

export interface F009GaijiRange {
  readonly start: number;
  readonly end: number;
}

const mintedSnapshots = new WeakSet<object>();
const mintedWorkSnapshots = new WeakSet<object>();
const mintedSourceRecords = new WeakSet<object>();
const mintedNormalizations = new WeakSet<object>();
const mintedPolicyDecisions = new WeakSet<object>();
const mintedCandidateSets = new WeakSet<object>();
// gaiji検出（DES-F009-005新規論点）は候補抽出に使ったraw XHTML本文（タグ込み、
// DOM parse前のdecoded text）と同一inputを参照する必要があるため、mint時の
// rawTextをWeakMapで保持する（`verifyNoGaijiWithinCandidates(candidateSet, gaijiRanges)`
// のDD-F009.md記載2引数シグネチャを維持しつつ、内部で同一rawTextを再利用するため）。
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
// 夢野久作author identity・work順registry（FUN-F009-004）
// ---------------------------------------------------------------------------

const EXPECTED_REGISTRY_WORKS = Object.freeze([
  { workId: '002381', title: '瓶詰地獄', order: 1 },
  { workId: '046694', title: 'きのこ会議', order: 2 },
  { workId: '002380', title: '死後の恋', order: 3 },
] as const);

export interface F009AuthorAndWorkRegistryWork {
  readonly workId: F009WorkId;
  readonly title: string;
  readonly order: 1 | 2 | 3;
}

export interface F009WorkRegistry {
  readonly __brand: 'F009WorkRegistry';
  readonly authorId: '000096';
  readonly name: 'ゆめのきゅうさく';
  readonly originalName: '夢野久作';
  readonly slug: 'yumeno-kyusaku';
  readonly identitySha256: string;
  readonly authorMode: 'introduce';
  readonly works: readonly F009AuthorAndWorkRegistryWork[];
}

export interface F009VerifiedAuthor {
  readonly __brand: 'F009VerifiedAuthor';
  readonly authorId: '000096';
  readonly name: 'ゆめのきゅうさく';
  readonly originalName: '夢野久作';
  readonly slug: 'yumeno-kyusaku';
  readonly identitySha256: string;
}

const mintedRegistries = new WeakSet<object>();
const verifiedF009Authors = new WeakSet<object>();

/**
 * `authorId=000096`（夢野久作）・`name=ゆめのきゅうさく`・`slug=yumeno-kyusaku`と
 * 瓶詰地獄(002381,order1)→きのこ会議(046694,order2)→死後の恋(002380,order3)のexact
 * work tupleを固定registryとしてmintする。`F009_WORKS`（本ファイル定義）を
 * 別に保持したexpected定数と突き合わせ、tamperを検出する。
 * @des DES-F009-003 @fun FUN-F009-004 @ut UT-F009-004
 */
export function defineF009AuthorAndWorkRegistry(): F009WorkRegistry {
  if (
    F009_WORKS.length !== EXPECTED_REGISTRY_WORKS.length ||
    F009_WORKS.some((work, index) => {
      const expected = EXPECTED_REGISTRY_WORKS[index];
      return !expected || work.workId !== expected.workId ||
        work.title !== expected.title || work.order !== expected.order;
    }) ||
    new Set(F009_WORKS.map((work) => work.workId)).size !== F009_WORKS.length ||
    AUTHOR_ID !== '000096'
  ) {
    throw new F009SourceError('F009_REGISTRY_MISMATCH', 'F009作者・作品registryが固定値と一致しません');
  }
  const identityCore = {
    authorId: '000096' as const,
    name: 'ゆめのきゅうさく' as const,
    originalName: '夢野久作' as const,
    slug: 'yumeno-kyusaku' as const,
  };
  const identitySha256 = sha256(new TextEncoder().encode(canonicalJson(identityCore)));
  const registry = deepFreeze({
    __brand: 'F009WorkRegistry' as const,
    ...identityCore,
    identitySha256,
    authorMode: 'introduce' as const,
    works: F009_WORKS.map((work) => ({ workId: work.workId, title: work.title, order: work.order })),
  });
  mintedRegistries.add(registry);
  return registry;
}

/**
 * registryのidentityを既存Catalogの作者・作品との非衝突込みで再確認する。
 *
 * DD-F009.md（FUN-F009-004）は既存`verifyExistingAuthorIdentity`
 * （`batch-candidate.ts`）の再利用を記載するが、F007実装で確認済みの通り、
 * 同関数は`context.definition.authorExpectation === 'reuse'`のApprovedBatchContext
 * だけを受理し、F009の`introduce`（新規作者）シナリオでは常に
 * `CANDIDATE_REGISTRY_INVALID`で例外になる（reuse専用関数のため）。
 * 本関数は`f006-source.ts`/`f007-source.ts`の同型関数と同じ構造を踏襲する。
 * @des DES-F009-003 @fun FUN-F009-004 @ut UT-F009-004
 */
export function verifyF009AuthorIdentity(
  registry: F009WorkRegistry,
  baselineCatalog: {
    readonly authors: readonly { readonly authorId: string; readonly name: string; readonly originalName: string; readonly slug: string }[];
    readonly works: readonly { readonly authorId: string }[];
  },
): F009VerifiedAuthor {
  if (!isRecord(registry) || !mintedRegistries.has(registry) || registry.__brand !== 'F009WorkRegistry') {
    throw new F009SourceError('F009_REGISTRY_MISMATCH', 'mint済みregistryが必要です');
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
    throw new F009SourceError('F009_REGISTRY_MISMATCH', 'baseline作者・作品との衝突を検出しました');
  }
  const verified = deepFreeze({
    __brand: 'F009VerifiedAuthor' as const,
    authorId: registry.authorId,
    name: registry.name,
    originalName: registry.originalName,
    slug: registry.slug,
    identitySha256: registry.identitySha256,
  });
  verifiedF009Authors.add(verified);
  return verified;
}

/**
 * @des DES-F009-003 @fun FUN-F009-004
 */
export function isVerifiedF009Author(value: unknown): value is F009VerifiedAuthor {
  return isRecord(value) && verifiedF009Authors.has(value) && value.__brand === 'F009VerifiedAuthor';
}

/**
 * @des DES-F009-004 DES-F009-005 @fun FUN-F009-005 FUN-F009-006
 */
function requireExactF009Context(context: unknown): asserts context is ApprovedBatchContext {
  if (!isMintedApprovedBatchContext(context)) {
    throw new F009SourceError('F009_CONTEXT_INVALID', 'F009のmint済み承認contextが必要です');
  }
  const rawWorks = context.candidate.works;
  if (
    context.definition.feature !== 'F009' ||
    context.definition.batchId !== 'F009' ||
    context.candidate.feature !== 'F009' ||
    context.candidate.author.authorId !== AUTHOR_ID ||
    rawWorks.length !== F009_WORKS.length
  ) {
    throw new F009SourceError('F009_CONTEXT_INVALID', 'F009 contextの固定tupleが一致しません');
  }
  rawWorks.forEach((item, index) => {
    const expected = F009_WORKS[index]!;
    if (
      item.workId !== expected.workId ||
      item.title !== expected.title ||
      item.cardUrl !== expected.cardUrl ||
      item.xhtmlUrl !== expected.sourceUrl
    ) {
      throw new F009SourceError('F009_CONTEXT_INVALID', 'F009 contextの作品順が一致しません');
    }
  });
}

function assertTrustedTime(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new F009SourceError('F009_CONTEXT_INVALID', 'trusted clockが不正です');
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
): F009PolicyClauseResult {
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
 * VOICEVOX/ずんだもん3規約で共通）をF009向けbrandとして複製する。
 * @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005
 */
export function evaluateF009PolicyClauses(
  policyId: (typeof F009_POLICY_IDS)[number],
  raw: Uint8Array,
): F009PolicyClauseDecision {
  if (!F009_POLICY_IDS.includes(policyId)) {
    throw new F009SourceError('F009_USAGE_NOT_ALLOWED', '未承認policy IDです');
  }
  const text = policyPlainText(raw);
  const usageForbidden = /(?:無料|非商用|個人利用|広告なし)[^。]{0,80}(?:禁止|認め(?:ない|ません))/u;
  let clauses: F009PolicyClauseResult[];
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
    __brand: 'F009PolicyClauseDecision' as const,
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
    throw new F009SourceError('F009_SOURCE_RESPONSE_INVALID', '公式取得responseが固定条件を満たしません');
  }
  const fetchedAt = response.fetchedAt ?? fallbackFetchedAt;
  if (!Number.isFinite(Date.parse(fetchedAt))) {
    throw new F009SourceError('F009_SOURCE_RESPONSE_INVALID', '公式取得時刻が不正です');
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
    throw new F009SourceError('F009_SOURCE_RESPONSE_INVALID', 'transport security evidenceが不正です');
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

function assertExpectedRow(row: BibliographyRow, expected: (typeof F009_WORKS)[number]): void {
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
    throw new F009SourceError('F009_SOURCE_DRIFT', `公式書誌が固定条件と一致しません: ${expected.workId}`);
  }
}

const F009_POLICY_ADJUDICATION_PATH = 'content/batches/F009/rights-adjudications.json';
const F009_ADJUDICATION_SHA256 = /^[a-f0-9]{64}$/u;

export interface F009PolicyAdjudication {
  readonly policyId: string;
  readonly previousSha256: string;
  readonly currentSha256: string;
  readonly decision: 'no-material-change';
  readonly reviewedAt: string;
  readonly reviewer: string;
  readonly note: string;
}

async function readF009PolicyAdjudications(
  workspace: string,
): Promise<readonly F009PolicyAdjudication[]> {
  let text: string;
  try {
    text = await readFile(resolve(workspace, ...F009_POLICY_ADJUDICATION_PATH.split('/')), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new F009SourceError('F009_SOURCE_DRIFT', '裁定記録が不正なJSONです', { cause: error });
  }
  if (canonicalJson(parsed) !== text || !Array.isArray(parsed)) {
    throw new F009SourceError('F009_SOURCE_DRIFT', '裁定記録がcanonical JSON配列ではありません');
  }
  for (const item of parsed) {
    if (!isRecord(item) ||
      !hasExactKeys(item, ['currentSha256', 'decision', 'note', 'policyId', 'previousSha256', 'reviewedAt', 'reviewer']) ||
      !nonBlank(item.policyId) || !F009_ADJUDICATION_SHA256.test(String(item.previousSha256)) ||
      !F009_ADJUDICATION_SHA256.test(String(item.currentSha256)) ||
      item.decision !== 'no-material-change' ||
      !nonBlank(item.reviewer) || !nonBlank(item.note) ||
      !Number.isFinite(Date.parse(String(item.reviewedAt)))) {
      throw new F009SourceError('F009_SOURCE_DRIFT', '裁定記録の項目が不正です');
    }
  }
  return parsed as readonly F009PolicyAdjudication[];
}

/**
 * F009の公式書誌・作家ページ・図書カード・XHTML・VOICEVOX/ずんだもん3規約を
 * productionのHTTPS transportだけで取得し、raw snapshotへ固定する。
 * `f007-source.ts`の`collectF007SourceSnapshot`と同一構造をauthorId `000096`・
 * 瓶詰地獄/きのこ会議/死後の恋へパラメータ化した複製。
 * @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005
 */
export async function collectF009SourceSnapshot(
  transport: ProductionAozoraTransport,
  context: ApprovedBatchContext,
  phase: F009Phase,
  trustedClock: () => Date,
  options: F009CollectionOptions,
): Promise<F009SourceSnapshot> {
  if (
    !(transport instanceof ProductionAozoraTransport) ||
    transport.request !== ProductionAozoraTransport.prototype.request
  ) {
    throw new F009SourceError('F009_TRANSPORT_REQUIRED', 'production transportが必要です');
  }
  requireExactF009Context(context);
  if (
    !isRecord(options) ||
    !(options.policyTransport instanceof ProductionPolicyTransport) ||
    options.policyTransport.request !== ProductionPolicyTransport.prototype.request ||
    !isAbsolute(options.trustedProjectRoot) ||
    !isAbsolute(options.workspace)
  ) {
    throw new F009SourceError('F009_TRANSPORT_REQUIRED', 'production規約transportとtrusted workspaceが必要です');
  }
  if (phase !== 'selection' && phase !== 'predeploy') {
    throw new F009SourceError('F009_CONTEXT_INVALID', '観測phaseが不正です');
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
    throw new F009SourceError('F009_SOURCE_RESPONSE_INVALID', '公式書誌ZIPを安全に展開できません', { cause: error });
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
    throw new F009SourceError('F009_BIBLIOGRAPHY_INVALID', '公式書誌CSVが不正です', { cause: error });
  }
  const selectedRows = F009_WORKS.map((expected) => {
    const matches = rows.filter((row) =>
      row.workId === expected.workId && row.personId === AUTHOR_ID && row.role === '著者',
    );
    if (matches.length !== 1) {
      throw new F009SourceError('F009_SOURCE_DRIFT', `公式書誌の対象行が一意ではありません: ${expected.workId}`);
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
    'F009',
  ).filter((definition): definition is typeof definition & {
    readonly policyId: (typeof F009_POLICY_IDS)[number];
  } => F009_POLICY_IDS.includes(definition.policyId as (typeof F009_POLICY_IDS)[number]));
  const policies: F009PolicySnapshot[] = [];
  for (const policyId of F009_POLICY_IDS) {
    const definition = definitions.find((item) => item.policyId === policyId);
    if (!definition) {
      throw new F009SourceError('F009_SOURCE_DRIFT', `規約定義がありません: ${policyId}`);
    }
    let fetched;
    try {
      fetched = await fetchPolicyObservation(definition, options.policyTransport);
    } catch (error) {
      throw new F009SourceError('F009_SOURCE_RESPONSE_INVALID', `規約取得に失敗しました: ${policyId}`, { cause: error });
    }
    const bytes = cloneBytes(fetched.body);
    const decision = evaluateF009PolicyClauses(policyId, bytes);
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
  const works: F009WorkSnapshot[] = [];
  for (const [index, expected] of F009_WORKS.entries()) {
    const card = await requestArtifact(
      transport,
      expected.cardUrl,
      '/cards/000096/',
      'text/html',
      'UTF-8',
      MAX_SOURCE_BYTES,
      observedAt,
    );
    const xhtml = await requestArtifact(
      transport,
      expected.sourceUrl,
      '/cards/000096/',
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
    authorId: '000096' as const,
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
      throw new F009SourceError('F009_CONTEXT_INVALID', 'selection観測へ旧snapshotは指定できません');
    }
  } else {
    const selection = options.selectionSnapshot;
    if (!selection || !mintedSnapshots.has(selection) || selection.phase !== 'selection') {
      throw new F009SourceError('F009_SOURCE_DRIFT', 'predeployにはmint済みselection snapshotが必要です');
    }
    const worksBefore = selection.works.flatMap((work) => [work.card.sha256, work.xhtml.sha256]);
    const worksAfter = snapshot.works.flatMap((work) => [work.card.sha256, work.xhtml.sha256]);
    if (JSON.stringify(worksBefore) !== JSON.stringify(worksAfter)) {
      throw new F009SourceError('F009_SOURCE_DRIFT', 'selection/predeployの原典SHAが変化しました');
    }
    const rowsBefore = selection.works.map((work) => canonicalJson(work.bibliography));
    const rowsAfter = snapshot.works.map((work) => canonicalJson(work.bibliography));
    if (JSON.stringify(rowsBefore) !== JSON.stringify(rowsAfter)) {
      throw new F009SourceError('F009_SOURCE_DRIFT', 'selection/predeployの対象作品の書誌が変化しました');
    }
    const drifted = snapshot.policies.filter((policy) => {
      const previous = selection.policies.find((item) => item.policyId === policy.policyId);
      return !previous || previous.artifact.sha256 !== policy.artifact.sha256;
    });
    if (drifted.length !== 0) {
      const adjudications = await readF009PolicyAdjudications(options.workspace);
      for (const policy of drifted) {
        const previous = selection.policies.find((item) => item.policyId === policy.policyId);
        const decided = adjudications.find((item) =>
          item.policyId === policy.policyId &&
          item.previousSha256 === previous?.artifact.sha256 &&
          item.currentSha256 === policy.artifact.sha256 &&
          item.decision === 'no-material-change');
        if (!decided) {
          throw new F009SourceError('F009_SOURCE_DRIFT', `規約が変化し裁定記録がありません: ${policy.policyId}`);
        }
      }
    }
  }
  return snapshot;
}

/**
 * 取得済みsnapshotと固定用途profileから、権利・規約条件をfail-closed評価する。
 * @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005
 */
export function evaluateF009RightsAndUsage(
  snapshot: F009SourceSnapshot,
  usageProfile: F009UsageProfile,
): F009RightsUsageDecision {
  if (!isRecord(snapshot) || !mintedSnapshots.has(snapshot)) {
    throw new F009SourceError('F009_USAGE_NOT_ALLOWED', '検証済みsnapshotが必要です');
  }
  const reasons: string[] = [];
  if (
    snapshot.policies.length !== F009_POLICY_IDS.length ||
    snapshot.policies.some((policy, index) =>
      policy.policyId !== F009_POLICY_IDS[index] ||
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
      assertExpectedRow(work.bibliography, F009_WORKS[index]!);
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
 * `parseBibliographyV2`が持つ夢十夜専用null許可分岐はF009では不要）。
 * @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005
 */
export function parseF009BibliographyV2(value: unknown, workId: F009WorkId): F009BibliographyV2 {
  if (!F009_WORKS.some((work) => work.workId === workId)) {
    throw new F009SourceError('F009_BIBLIOGRAPHY_INVALID', '未承認work IDです');
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
    throw new F009SourceError('F009_BIBLIOGRAPHY_INVALID', '書誌V2 schemaが不正です（proofreaderは非null必須）');
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
    throw new F009SourceError('F009_SOURCE_DRIFT', 'card raw/SHA bindingが一致しません');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(card.bytes);
  } catch (error) {
    throw new F009SourceError('F009_SOURCE_DRIFT', 'card UTF-8 decodeに失敗しました', { cause: error });
  }
  const all = [...text.matchAll(/最終更新日/gu)];
  if (all.length !== 1) throw new F009SourceError('F009_SOURCE_DRIFT', 'card最終更新日headerが一意ではありません');
  const sourceFile = new URL(sourceUrl).pathname.split('/').at(-1);
  const sourceRows = sourceFile
    ? [...text.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/giu)]
      .filter((match) => match[0].includes(`./files/${sourceFile}`))
    : [];
  if (sourceRows.length > 1) {
    throw new F009SourceError('F009_SOURCE_DRIFT', 'cardの対象XHTML行が一意ではありません');
  }
  const rowDates = sourceRows[0]?.[0].match(/\d{4}-\d{2}-\d{2}/gu) ?? [];
  const iso = rowDates.length === 2
    ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(rowDates[1]!)
    : /最終更新日[^0-9]{0,40}(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/u.exec(text);
  if (!iso) throw new F009SourceError('F009_SOURCE_DRIFT', 'card最終更新日が一意に取得できません');
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
    throw new F009SourceError('F009_SOURCE_DRIFT', 'card最終更新日が不正です');
  }
  return value;
}

function assertSourceRecordArtifacts(sourceRecord: F009SourceRecordV2): void {
  if (
    sourceRecord.raw.sha256 !== sha256(sourceRecord.raw.bytes) ||
    sourceRecord.raw.byteLength !== sourceRecord.raw.bytes.byteLength ||
    sourceRecord.card.sha256 !== sha256(sourceRecord.card.bytes) ||
    sourceRecord.card.byteLength !== sourceRecord.card.bytes.byteLength ||
    sourceRecord.cardRawSha256 !== sourceRecord.card.sha256 ||
    sourceRecord.cardRawBytes !== sourceRecord.card.byteLength
  ) {
    throw new F009SourceError('F009_SOURCE_DRIFT', 'SourceRecordV2 raw/cardが境界前に改変されました');
  }
}

/**
 * minted work snapshotからraw参照を失わないSourceRecordV2を構築する。
 * @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005
 */
export function parseF009SourceRecord(
  snapshot: F009WorkSnapshot,
  expectedWorkId: F009WorkId,
): F009SourceRecordV2 {
  if (!isRecord(snapshot) || !mintedWorkSnapshots.has(snapshot)) {
    throw new F009SourceError('F009_SOURCE_DRIFT', '検証済みwork snapshotが必要です');
  }
  const expected = F009_WORKS.find((work) => work.workId === expectedWorkId);
  if (
    !expected ||
    snapshot.workId !== expected.workId ||
    snapshot.title !== expected.title ||
    snapshot.card.sourceUrl !== expected.cardUrl ||
    snapshot.xhtml.sourceUrl !== expected.sourceUrl ||
    snapshot.xhtml.charset !== 'Shift_JIS' ||
    snapshot.xhtml.sha256 !== sha256(snapshot.xhtml.bytes)
  ) {
    throw new F009SourceError('F009_SOURCE_DRIFT', 'source snapshotが固定作品と一致しません');
  }
  const bibliography = parseF009BibliographyV2({
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
 * @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005
 */
export function buildF009SourceProvenance(
  source: F009SourceRecordV2,
  snapshot: F009SourceSnapshot,
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
 * DD-F009.md初版はDOMAIN-F009.mdの実測（未定義entity0件）に基づきpassthroughのみを
 * 想定していたが、実HTTPS取得の結果、瓶詰地獄（002381）の`gaiji_list`注記表
 * （本文外、外字の字形注記）内に`<td>&nbsp;&nbsp;</td>`という固定contextで
 * `&nbsp;`が2件存在することが判明した（DOMAIN-F009.md §5の実測記載を本実装で
 * 訂正。この`&nbsp;`はXML厳格parserにとって未解決entityとなり、`.main_text`の
 * 外側にあるにもかかわらずdocument全体のinert DOM解析自体を失敗させるため、
 * 単純な範囲限定チェックでは救済できない）。`f007-source.ts`の舞姫（058126）向け
 * `normalizeF007AozoraXhtmlEntities`と同一の等長置換方式（`&nbsp;`→`&#160;`、
 * 6byte→6byteでbyte offsetを変えない数値文字参照への置換）をF009向けに複製する。
 * きのこ会議・死後の恋は引き続きpassthroughのみ。未知の名前付きentity（標準5種・
 * 上記の固定`&nbsp;`context以外）が1件でも出現した場合はfail-closedで拒否し、
 * 当該作品を`pending`に留める。
 * @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006
 */
export function normalizeF009AozoraXhtmlEntities(
  rawBytes: Uint8Array,
  sourceRecord: F009SourceRecordV2,
): F009EntityNormalizationResult {
  if (!isRecord(sourceRecord) || !mintedSourceRecords.has(sourceRecord)) {
    throw new F009SourceError('F009_ENTITY_NORMALIZATION_INVALID', 'mint済みSourceRecordV2が必要です');
  }
  assertSourceRecordArtifacts(sourceRecord);
  if (
    sourceRecord.raw.byteLength !== rawBytes.byteLength ||
    sourceRecord.raw.sha256 !== sha256(rawBytes)
  ) {
    throw new F009SourceError('F009_ENTITY_NORMALIZATION_INVALID', 'raw source bindingが一致しません');
  }
  let text: string;
  try {
    text = new TextDecoder('shift_jis', { fatal: true }).decode(rawBytes);
  } catch (error) {
    throw new F009SourceError('F009_ENTITY_NORMALIZATION_INVALID', 'Shift_JIS fatal decodeに失敗しました', { cause: error });
  }
  const namedEntities = text.match(/&([A-Za-z][A-Za-z0-9._:-]*);/gu) ?? [];
  const allowedNamedEntities = ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'];
  const isBinzumeNbspContext = sourceRecord.workId === '002381' &&
    namedEntities.every((entity) => allowedNamedEntities.includes(entity) || entity === '&nbsp;') &&
    namedEntities.filter((entity) => entity === '&nbsp;').length === 2;
  const unexpected = namedEntities.filter((entity) =>
    !allowedNamedEntities.includes(entity) && !(isBinzumeNbspContext && entity === '&nbsp;'));
  if (unexpected.length > 0) {
    throw new F009SourceError(
      'F009_ENTITY_NORMALIZATION_INVALID',
      `未定義entityを検出しました（${sourceRecord.workId}）: ${[...new Set(unexpected)].join(',')}`,
    );
  }
  let processedBytes: Uint8Array;
  let variant: F009EntityNormalizationResult['variant'];
  let replacements: readonly F009EntityReplacement[];
  if (isBinzumeNbspContext) {
    const fixedContext = '<td>&nbsp;&nbsp;</td>';
    if (text.split(fixedContext).length - 1 !== 1) {
      throw new F009SourceError('F009_ENTITY_NORMALIZATION_INVALID', '承認済みentityの件数・位置・contextが一致しません');
    }
    const contextBytes = new TextEncoder().encode(fixedContext);
    const normalizedContextBytes = new TextEncoder().encode('<td>&#160;&#160;</td>');
    const rawBuffer = Buffer.from(rawBytes);
    const contextByteOffset = rawBuffer.indexOf(contextBytes);
    if (contextByteOffset < 0 || rawBuffer.indexOf(contextBytes, contextByteOffset + 1) >= 0) {
      throw new F009SourceError('F009_ENTITY_NORMALIZATION_INVALID', '承認済みentityのbyte位置が一意ではありません');
    }
    if (contextBytes.byteLength !== normalizedContextBytes.byteLength) {
      throw new F009SourceError('F009_ENTITY_NORMALIZATION_INVALID', 'entity置換が等長ではありません');
    }
    const rawCopy = cloneBytes(rawBytes);
    rawCopy.set(normalizedContextBytes, contextByteOffset);
    processedBytes = rawCopy;
    variant = 'entity';
    const entityOffset = contextByteOffset + '<td>'.length;
    replacements = [
      { offset: entityOffset, from: '&nbsp;' as const, to: '&#160;' as const },
      { offset: entityOffset + '&nbsp;'.length, from: '&nbsp;' as const, to: '&#160;' as const },
    ];
  } else {
    processedBytes = cloneBytes(rawBytes);
    variant = 'passthrough';
    replacements = [];
  }
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

function preflightF009Xhtml(text: string): void {
  const doctypes = text.match(/<!DOCTYPE\b[\s\S]*?>/giu) ?? [];
  if (doctypes.length !== 1 || canonicalizeDoctype(doctypes[0]!) !== CANONICAL_XHTML11_DOCTYPE) {
    throw new F009SourceError('F009_XHTML_PREFLIGHT_REJECTED', 'XHTML 1.1の固定DOCTYPEではありません');
  }
  const doctypeStart = text.search(/<!DOCTYPE\b/iu);
  const doctypeEnd = text.indexOf('>', doctypeStart);
  if (text.slice(doctypeStart, doctypeEnd + 1).includes('[')) {
    throw new F009SourceError('F009_XHTML_PREFLIGHT_REJECTED', 'DOCTYPE internal subsetは禁止です');
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
    throw new F009SourceError('F009_XHTML_PREFLIGHT_REJECTED', '外部resource/entity構文は禁止です');
  }
  const namedEntities = text.match(/&([A-Za-z][A-Za-z0-9._:-]*);/gu) ?? [];
  if (namedEntities.some((entity) => !['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'].includes(entity))) {
    throw new F009SourceError('F009_XHTML_PREFLIGHT_REJECTED', '標準5種以外のnamed entityは禁止です');
  }
  let depth = 0;
  let nodes = 0;
  for (const match of text.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9:._-]*)\b[^>]*>/gu)) {
    const tag = match[0];
    if (match[1] === '/') {
      depth -= 1;
      if (depth < 0) throw new F009SourceError('F009_XHTML_PREFLIGHT_REJECTED', 'XML depthが不正です');
    } else {
      nodes += 1;
      if (!/\/\s*>$/u.test(tag)) depth += 1;
      if (depth > 256 || nodes > 500_000) {
        throw new F009SourceError('F009_XHTML_PREFLIGHT_REJECTED', 'XML depth/node上限を超えています');
      }
    }
  }
  const textScalars = [...text.replace(/<[^>]*>/gu, '')].length;
  if (text.length > MAX_SOURCE_BYTES || textScalars > 4_000_000 || nodes === 0) {
    throw new F009SourceError('F009_XHTML_PREFLIGHT_REJECTED', 'XHTML resource上限を超えています');
  }
}

/**
 * VOICEVOX(0.25.2)実測により、単一candidateのspeechTextが約1330〜1340文字を
 * 超えるとsynthesis呼出しがHTTP 500（engine内部エラー）を返すことをF007実装で
 * 確認済みである（境界: prefix 1334文字は成功、1335文字はtimeout、1354文字以降は
 * HTTP 500即時失敗）。REQ-F009-019はこの制約とF007ローカル分割対応（600文字閾値、
 * 句点分割）の再利用を非機能要件として明記しており、F009では設計時点から
 * 本ロジックを組み込む。他フィーチャー（F001〜F007）が依存する共有汎用モジュール
 * （src/voice/generation.ts・src/voice/client.ts・src/content/processing.ts・
 * src/content/batch-production.ts）は変更せず、F009ローカルの抽出層だけで、
 * 閾値を超える候補を句点「。」の文境界で複数の連続candidateへ安全に分割する。
 * 実測失敗境界(1335文字)に対し2倍以上の安全マージンを確保した600文字を閾値とする。
 *
 * 分割後は各pieceが独立したRawCandidateとなり、抽出済み全candidateへ
 * order 0..N-1を再採番する（sourceAnchor/rawTokenRange/rawSourceSha256は
 * 分割元と同一を維持し、分割元の引用範囲全体を指し続ける。candidateIdは
 * displayText/speechTextのhashから導出されるため分割後の各pieceで自動的に
 * ユニークになる）。contextBefore/contextAfterは分割元のまま維持するため、
 * 2piece目以降のcontextBeforeは厳密な直前文脈ではない（表示補助用途のみで
 * 正確性を要求されないため許容する）。
 *
 * 分割は必ず句点直後で行い、文の途中では絶対に切らない。1文だけで閾値を
 * 超える場合（実際の日本語散文では極めて稀）は分割できないため単独piece
 * として通す（この場合でもVOICEVOX側で失敗する可能性は残るが、少なくとも
 * 決定的な分割ロジック自体が壊れることはない）。
 * @des DES-F009-005 DES-F009-015 @fun FUN-F009-006
 */
const F009_SPLIT_LENGTH_THRESHOLD = 600;

const F009_SPLIT_MEASUREMENT_RULES: SpeechRules = Object.freeze({
  version: SUPPORTED_SPEECH_RULE_VERSION,
  gaiji: Object.freeze({}),
  lineBreak: 'space',
  collapseWhitespace: true,
});

function explodeTextTokenAtSentenceBoundaries(token: TextToken): TextToken[] {
  if (token.type !== 'text' || !token.value.includes('。')) return [token];
  const pieces: TextToken[] = [];
  let rest = token.value;
  while (rest.includes('。')) {
    const cut = rest.indexOf('。') + 1;
    pieces.push({ type: 'text', value: rest.slice(0, cut) });
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push({ type: 'text', value: rest });
  return pieces;
}

function endsAtSentenceBoundary(group: readonly TextToken[]): boolean {
  const last = group[group.length - 1];
  return last !== undefined && last.type === 'text' && last.value.endsWith('。');
}

/**
 * 死後の恋の実長大候補（分割前1,630〜1,748文字）には`lineBreak`token連続部分が
 * 含まれ、accumulation途中の`prospective`が一時的に空白のみ（lineBreakだけ）に
 * なりうることが実データで判明した。`normalizeSpeechText`は最終speechTextの
 * 空白専用化を`empty-text`で拒否する仕様のままだが、本関数はあくまで
 * accumulation途中の長さ測定に使うため、空白専用の中間状態は単に「短い
 * （長さ0）」とみなして蓄積を継続する（最終的に確定するgroupが空白専用になる
 * ことはない。原文候補自体が非空白であることは既に`extractDialogueCandidates`
 * の決定的抽出で保証済みのため）。
 */
function measureProspectiveSpeechLength(tokens: TextToken[]): number {
  try {
    return normalizeSpeechText(tokens, F009_SPLIT_MEASUREMENT_RULES).length;
  } catch (error) {
    if (error instanceof NormalizationError && error.code === 'empty-text') return 0;
    throw error;
  }
}

function groupTokensByThreshold(tokens: readonly TextToken[], threshold: number): TextToken[][] {
  const atomicPieces = tokens.flatMap((token) => explodeTextTokenAtSentenceBoundaries(token));
  const groups: TextToken[][] = [];
  let current: TextToken[] = [];
  for (const piece of atomicPieces) {
    const prospective = [...current, piece];
    const prospectiveLength = measureProspectiveSpeechLength(prospective);
    if (current.length > 0 && prospectiveLength > threshold && endsAtSentenceBoundary(current)) {
      groups.push(current);
      current = [piece];
    } else {
      current = prospective;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 0 ? groups : [[...atomicPieces]];
}

function splitOverlongF009Candidates(candidates: readonly RawCandidate[]): RawCandidate[] {
  const expanded = candidates.flatMap((raw) => {
    const speechLength = normalizeSpeechText(raw.tokens, F009_SPLIT_MEASUREMENT_RULES).length;
    if (speechLength <= F009_SPLIT_LENGTH_THRESHOLD) return [raw];
    const groups = groupTokensByThreshold(raw.tokens, F009_SPLIT_LENGTH_THRESHOLD);
    return groups.map((tokens) => ({ ...raw, tokens }));
  });
  return expanded.map((raw, index) => ({ ...raw, order: index }));
}

// ---------------------------------------------------------------------------
// gaiji要素の候補内非混入検証（DES-F009-005の新規論点）
// ---------------------------------------------------------------------------

const GAIJI_IMG_TAG = /<img\b[^>]*>/gu;
const GAIJI_CLASS_EXACT = /\bclass\s*=\s*(?:"gaiji"|'gaiji')/u;
const MAIN_TEXT_OPEN_TAG = /<div\b[^>]*\bclass=["'][^"']*\bmain_text\b[^"']*["'][^>]*>/iu;
const BIBLIOGRAPHICAL_INFO_OPEN_TAG = /<div\b[^>]*\bclass=["'][^"']*\bbibliographical_information\b[^"']*["'][^>]*>/iu;

/**
 * raw XHTML text中の`<img class="gaiji">`要素（属性順序に依存しない、class属性値の
 * 完全一致だけを条件とする）のbyte offset範囲を全件収集する。
 * @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006
 */
export function detectF009GaijiElements(rawText: string): readonly F009GaijiRange[] {
  if (typeof rawText !== 'string') {
    throw new F009SourceError('F009_XHTML_PREFLIGHT_REJECTED', 'gaiji検出対象のrawTextが不正です');
  }
  const ranges: F009GaijiRange[] = [];
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
 * 「タグ外の実text」だけを対象にした投影を作る。実測の結果、瓶詰地獄の
 * `<ruby><rb><img alt="※（「竹かんむり／孤」、第4水準2-83-54)" class="gaiji" /></rb>...`
 * のようにgaiji画像自身の`alt`属性値の中に「」で囲われた字形注記が埋め込まれて
 * いることが判明した。この属性値内の「」はDOM抽出器のtextContentには一切
 * 現れない（img要素はtext nodeを持たない）ため、タグをmaskせずに生文字列を
 * そのままbracket走査すると、gaiji自身の注記が誤って「候補」として検出され
 * fail-closedが常に誤発火する。タグ・属性を空白maskしてから走査することで
 * この誤検出を除去する。
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
function outermostBracketRangesInRawText(rawText: string): readonly F009GaijiRange[] {
  const ranges: F009GaijiRange[] = [];
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
 * （`detectF009GaijiElements`の結果）との区間重なりを線形走査で判定する。
 * 1件でも重なりがあれば`F009_GAIJI_WITHIN_CANDIDATE`をfail-closedで投げる。
 * @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006
 */
export function verifyNoGaijiWithinCandidates(
  candidateSet: F009CandidateSet,
  gaijiRanges: readonly F009GaijiRange[],
): void {
  if (!isRecord(candidateSet) || !mintedCandidateSets.has(candidateSet)) {
    throw new F009SourceError('F009_EXTRACTION_FAILED', 'mint済みcandidate setが必要です');
  }
  const rawText = candidateSetRawText.get(candidateSet);
  if (typeof rawText !== 'string') {
    throw new F009SourceError('F009_EXTRACTION_FAILED', 'candidate setに対応するraw textがありません');
  }
  if (
    !Array.isArray(gaijiRanges) ||
    gaijiRanges.some((range: F009GaijiRange) =>
      !isRecord(range as unknown) ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start)
  ) {
    throw new F009SourceError('F009_EXTRACTION_FAILED', 'gaijiRangesが不正です');
  }
  const { slice, offset } = mainTextRegion(rawText);
  const candidateRanges = outermostBracketRangesInRawText(maskTagSpans(slice))
    .map((range) => ({ start: range.start + offset, end: range.end + offset }));
  const overlap = candidateRanges.some((candidateRange) =>
    gaijiRanges.some((gaijiRange) =>
      gaijiRange.start < candidateRange.end && candidateRange.start < gaijiRange.end));
  if (overlap) {
    throw new F009SourceError('F009_GAIJI_WITHIN_CANDIDATE', 'gaiji要素が候補範囲内に検出されました');
  }
}

/**
 * resource preflight後だけ既存inert DOM抽出器へ渡し、二重実行で決定性を確認する。
 * 抽出直後にgaiji検出（`detectF009GaijiElements`）と候補内非混入検証
 * （`verifyNoGaijiWithinCandidates`）を常時実行し、選定時・公開直前いずれの
 * phaseで呼ばれても省略しない（DES-F009-005）。
 * @des DES-F009-005 @fun FUN-F009-006 @ut UT-F009-006
 */
export function extractF009DialogueCandidates(
  normalization: F009EntityNormalizationResult,
  source: F009SourceRecordV2,
  extractorVersion: string,
): F009CandidateSet {
  if (!isRecord(source) || !mintedSourceRecords.has(source)) {
    throw new F009SourceError('F009_EXTRACTION_FAILED', 'mint済みSourceRecordV2が必要です');
  }
  assertSourceRecordArtifacts(source);
  if (
    !isRecord(normalization) ||
    !mintedNormalizations.has(normalization) ||
    normalization.workId !== source.workId ||
    extractorVersion !== EXTRACTOR_VERSION
  ) {
    throw new F009SourceError('F009_EXTRACTION_FAILED', '抽出input bindingが不正です');
  }
  if (sha256(normalization.processedBytes) !== normalization.processedSha256) {
    throw new F009SourceError('F009_EXTRACTION_FAILED', 'processed artifactのSHAが一致しません');
  }
  let text: string;
  try {
    text = new TextDecoder('shift_jis', { fatal: true }).decode(normalization.processedBytes);
  } catch (error) {
    throw new F009SourceError('F009_XHTML_PREFLIGHT_REJECTED', 'Shift_JIS fatal decodeに失敗しました', { cause: error });
  }
  preflightF009Xhtml(text);
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
    throw new F009SourceError('F009_EXTRACTION_FAILED', '台詞抽出が失敗または非決定的です');
  }
  // 決定性検証(DOM抽出器の素の出力同士の比較)が終わった後だけ分割する。
  // splitOverlongF009Candidates自体は入力に対し決定的なため、この順序でも
  // 「二重実行して一致を確認する」という決定性保証の意味は保たれる。
  const splitCandidates = splitOverlongF009Candidates(first.candidates);
  const resplit = splitOverlongF009Candidates(second.candidates);
  if (JSON.stringify(splitCandidates) !== JSON.stringify(resplit)) {
    throw new F009SourceError('F009_EXTRACTION_FAILED', '長大候補の分割処理が非決定的です');
  }
  const result: ExtractionResult = { ok: true, success: true, candidates: splitCandidates, diagnostics: first.diagnostics };
  const candidateSet: F009CandidateSet = deepFreeze({
    schemaVersion: '1.0.0',
    workId: source.workId,
    sourceSha256: normalization.processedSha256,
    extractorVersion: EXTRACTOR_VERSION,
    result,
  });
  mintedCandidateSets.add(candidateSet);
  candidateSetRawText.set(candidateSet, text);
  const gaijiRanges = detectF009GaijiElements(text);
  verifyNoGaijiWithinCandidates(candidateSet, gaijiRanges);
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
    throw new F009SourceError('F009_PATH_UNSAFE', 'Windows pathの字句条件に違反しています');
  }
  const segments = relativePosixPath.split('/');
  if (segments.some((segment) =>
    segment === '' || segment === '.' || segment === '..' ||
    segment.endsWith('.') || segment.endsWith(' ') ||
    WINDOWS_RESERVED.test(segment) || segment.normalize('NFC') !== segment
  )) {
    throw new F009SourceError('F009_PATH_UNSAFE', 'Windows path segmentが不正です');
  }
  return segments;
}

async function safeReadFile(workspace: string, relativePosixPath: string): Promise<Uint8Array> {
  if (!isAbsolute(workspace)) {
    throw new F009SourceError('F009_PATH_UNSAFE', 'workspaceは絶対pathが必要です');
  }
  safePathSegments(relativePosixPath);
  const root = resolve(workspace);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new F009SourceError('F009_PATH_UNSAFE', 'workspace実体が不正です');
  }
  const target = join(root, ...relativePosixPath.split('/'));
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new F009SourceError('F009_PATH_UNSAFE', 'source pathがworkspace外です');
  }
  let cursor = root;
  for (const component of relation.split(sep)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new F009SourceError('F009_PATH_UNSAFE', 'source pathにreparseがあります');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) {
    throw new F009SourceError('F009_PATH_UNSAFE', 'source実体が通常fileではありません');
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
    throw new F009SourceError('F009_PATH_UNSAFE', `既存artifactが不一致です: ${relativePosixPath}`);
  } catch (error) {
    if (error instanceof F009SourceError) throw error;
  }
  const parent = join(root, ...relativePosixPath.split('/').slice(0, -1));
  await mkdir(parent, { recursive: true });
  const stagingDirectory = await mkdtemp(join(parent, '.f008-write-'));
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
  return 'data/batches/F009/source-snapshots/selection';
}

function predeployDataPath(run: string, leaf: string): string {
  return `data/batches/F009/source-snapshots/selection/predeploy-${run}-${leaf.replaceAll('/', '-')}`;
}

/**
 * 取得済みF009 snapshotを`content/batches/F009/source-snapshots/`配下の
 * canonical JSONと、raw byte実体（`data/batches/F009/source-snapshots/...`）へ
 * atomicに固定する。CSVはZIPから再導出可能なため`storage: 'derived'`として
 * 別ファイルを持たない（`f005-source.ts`の`rehydrateDerivedArtifact`と同じ最適化）。
 * @des DES-F009-004 DES-F009-005 @fun FUN-F009-005 FUN-F009-006
 */
export async function persistF009SourceSnapshot(
  workspace: string,
  snapshot: F009SourceSnapshot,
  run?: string,
): Promise<WorkspaceRelativePath> {
  if (!isRecord(snapshot) || !mintedSnapshots.has(snapshot)) {
    throw new F009SourceError('F009_SOURCE_DRIFT', '検証済みsnapshotが必要です');
  }
  if (snapshot.phase === 'predeploy' && !nonBlank(run)) {
    throw new F009SourceError('F009_PATH_UNSAFE', 'predeploy永続化にはrun識別子が必要です');
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

  const rights = evaluateF009RightsAndUsage(snapshot, {
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
      ? 'f008-source-selection-snapshot'
      : 'f008-source-predeploy-snapshot',
    batchId: 'F009',
    authorId: '000096',
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
    ? 'content/batches/F009/source-snapshots/selection.json'
    : `content/batches/F009/source-snapshots/predeploy-${run}.json`;
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
    throw new F009SourceError('F009_SOURCE_DRIFT', 'persisted artifact metadataが固定tupleと一致しません');
  }
  const bytes = await safeReadFile(workspace, expected.path);
  if (bytes.byteLength !== value.byteLength || sha256(bytes) !== value.sha256) {
    throw new F009SourceError('F009_SOURCE_DRIFT', 'persisted artifact実体のSHAまたはbyte数が一致しません');
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
  expectedPhase: F009Phase,
  dataPath: (leaf: string) => string,
): Promise<F009SourceSnapshot> {
  requireExactF009Context(context);
  let persisted: unknown;
  try {
    persisted = JSON.parse(documentText);
  } catch (error) {
    throw new F009SourceError('F009_SOURCE_DRIFT', 'snapshot JSONが不正です', { cause: error });
  }
  if (documentText !== canonicalJson(persisted) || !isRecord(persisted) ||
    !hasExactKeys(persisted, [
      'schemaVersion', 'kind', 'batchId', 'authorId', 'phase', 'observedAt', 'rights',
      'bibliographyArchive', 'bibliographyCsv', 'authorPage', 'policies', 'works',
    ]) ||
    persisted.schemaVersion !== '1.0.0' ||
    persisted.kind !== (expectedPhase === 'selection'
      ? 'f008-source-selection-snapshot'
      : 'f008-source-predeploy-snapshot') ||
    persisted.batchId !== 'F009' ||
    persisted.authorId !== AUTHOR_ID ||
    persisted.phase !== expectedPhase ||
    !nonBlank(persisted.observedAt) ||
    !Number.isFinite(Date.parse(persisted.observedAt)) ||
    !Array.isArray(persisted.policies) ||
    persisted.policies.length !== F009_POLICY_IDS.length ||
    !Array.isArray(persisted.works) ||
    persisted.works.length !== F009_WORKS.length
  ) {
    throw new F009SourceError('F009_SOURCE_DRIFT', 'snapshotのcanonical schemaが一致しません');
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
    throw new F009SourceError('F009_BIBLIOGRAPHY_INVALID', 'persisted公式書誌を再検証できません', { cause: error });
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
    throw new F009SourceError('F009_SOURCE_DRIFT', 'persisted ZIP/CSV bindingが一致しません');
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
    throw new F009SourceError('F009_BIBLIOGRAPHY_INVALID', 'persisted公式書誌CSVを解析できません', { cause: error });
  }
  const selectedRows = F009_WORKS.map((expected) => {
    const matches = rows.filter((row) =>
      row.workId === expected.workId && row.personId === AUTHOR_ID && row.role === '著者');
    if (matches.length !== 1) {
      throw new F009SourceError('F009_SOURCE_DRIFT', `persisted書誌の対象行が一意ではありません: ${expected.workId}`);
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

  const definitions = createPolicyDefinitions(workspace, workspace, 'F009')
    .filter((definition): definition is typeof definition & {
      readonly policyId: (typeof F009_POLICY_IDS)[number];
    } => F009_POLICY_IDS.includes(definition.policyId as (typeof F009_POLICY_IDS)[number]));
  const policies: F009PolicySnapshot[] = [];
  for (const [index, policyId] of F009_POLICY_IDS.entries()) {
    const rawPolicy = persisted.policies[index];
    const definition = definitions.find((item) => item.policyId === policyId);
    if (!definition || !isRecord(rawPolicy) || !hasExactKeys(rawPolicy, ['policyId', 'versionOrLabel', 'artifact', 'decision']) ||
      rawPolicy.policyId !== policyId || rawPolicy.versionOrLabel !== definition.versionOrLabel
    ) {
      throw new F009SourceError('F009_SOURCE_DRIFT', `persisted規約tupleが一致しません: ${policyId}`);
    }
    const policyArtifact = await rehydrateArtifact(workspace, rawPolicy.artifact, {
      path: dataPath(`policies/${policyId}.raw`),
      sourceUrl: definition.url,
      mediaType: 'text/html',
      charset: null,
      maxBytes: MAX_SOURCE_BYTES,
    });
    const decision = evaluateF009PolicyClauses(policyId, policyArtifact.bytes);
    if (canonicalJson(rawPolicy.decision) !== canonicalJson(decision)) {
      throw new F009SourceError('F009_SOURCE_DRIFT', `persisted規約decisionが本文と一致しません: ${policyId}`);
    }
    policies.push(deepFreeze({ policyId, versionOrLabel: definition.versionOrLabel, artifact: policyArtifact, decision }));
  }

  const works: F009WorkSnapshot[] = [];
  for (const [index, expected] of F009_WORKS.entries()) {
    const rawWork = persisted.works[index];
    const contextWork = context.candidate.works[index];
    if (!isRecord(rawWork) || !hasExactKeys(rawWork, ['workId', 'title', 'bibliography', 'card', 'xhtml']) ||
      rawWork.workId !== expected.workId || rawWork.title !== expected.title ||
      contextWork?.workId !== expected.workId || contextWork.title !== expected.title ||
      contextWork.cardUrl !== expected.cardUrl || contextWork.xhtmlUrl !== expected.sourceUrl ||
      canonicalJson(rawWork.bibliography) !== canonicalJson(selectedRows[index])
    ) {
      throw new F009SourceError('F009_SOURCE_DRIFT', `persisted作品とapproved contextが一致しません: ${expected.workId}`);
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
    authorId: '000096' as const,
    phase: expectedPhase,
    observedAt: persisted.observedAt,
    bibliographyArchive,
    bibliographyCsv,
    authorPage,
    policies,
    works,
  });
  mintedSnapshots.add(snapshot);
  const rights = evaluateF009RightsAndUsage(snapshot, {
    free: true,
    advertising: false,
    payments: false,
    sponsorship: false,
    unofficial: true,
    voiceCredit: 'VOICEVOX:ずんだもん',
  });
  if (rights.decision !== 'allow' || canonicalJson(persisted.rights) !== canonicalJson(rights)) {
    throw new F009SourceError('F009_USAGE_NOT_ALLOWED', 'persisted rights decisionを再現できません');
  }
  return snapshot;
}

/**
 * 永続化済みselection snapshotを実ファイル・承認context・公式固定tupleへ再結合して再mintする。
 * @des DES-F009-004 @fun FUN-F009-005 @ut UT-F009-005
 */
export async function rehydrateF009SelectionSnapshot(
  workspace: string,
  context: ApprovedBatchContext,
): Promise<F009SourceSnapshot> {
  const documentBytes = await safeReadFile(
    workspace,
    'content/batches/F009/source-snapshots/selection.json',
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

const F009_PREDEPLOY_SNAPSHOT_PATH_PATTERN =
  /^content\/batches\/F009\/source-snapshots\/predeploy-([0-9A-Za-z-]+)\.json$/u;

/**
 * process再起動後にpredeploy runを実ファイル・承認contextへ再結合して再mintする。
 * @des DES-F009-004 DES-F009-005 @fun FUN-F009-005 FUN-F009-006 @ut UT-F009-006
 */
export async function rehydrateF009PredeploySnapshot(
  workspace: string,
  context: ApprovedBatchContext,
  snapshotRelativePath: string,
): Promise<F009SourceSnapshot> {
  const match = typeof snapshotRelativePath === 'string'
    ? F009_PREDEPLOY_SNAPSHOT_PATH_PATTERN.exec(snapshotRelativePath)
    : null;
  if (!match) {
    throw new F009SourceError('F009_PATH_UNSAFE', 'predeploy snapshot pathが固定形式ではありません');
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
