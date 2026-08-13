import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  constants as fsConstants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { canonicalJson } from './artifacts.ts';
import {
  EXTRACTOR_VERSION,
  extractDialogueCandidates,
  type ExtractionResult,
} from './processing.ts';
import {
  AOZORA_BIBLIOGRAPHY_URL,
  AOZORA_TIMEOUT_MS,
  MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
  MAX_BIBLIOGRAPHY_CSV_BYTES,
  MAX_SOURCE_BYTES,
  ProductionAozoraTransport,
  extractVerifiedBibliographyCsv,
  isPublicAddress,
  parseAozoraBibliography,
  type BibliographyRow,
  type TransportPolicy,
  type TransportResponse,
  type TransportSecurityEvidence,
} from './source.ts';
import {
  isMintedF005ApprovedBatchContext,
  type F005ApprovedBatchContext,
} from './f005-context.ts';
import {
  ProductionPolicyTransport,
  createPolicyDefinitions,
  fetchPolicyObservation,
  type PolicyId,
  type PolicySecurityProof,
} from '../notices/policy-snapshots.ts';

const AOZORA_ORIGIN = 'https://www.aozora.gr.jp';
const AUTHOR_ID = '000148';
const AUTHOR_PAGE_URL = `${AOZORA_ORIGIN}/index_pages/person148.html`;
const CANONICAL_XHTML11_DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">';
const SHUMI_RAW_BYTES = 161_913;
const SHUMI_RAW_SHA256 = '91209534d37abf5fc66a4720eb167b0315aefbd5ea8842cccd731d4155e982ef';
const SHUMI_PROCESSED_SHA256 = 'c1e2f27fe6acc91bdb8b66115f21a3efd64fadbc9112e7365f574e94ff69696b';
const SHUMI_ENTITY_CONTEXT = '<td>&nbsp;&nbsp;</td>';
const SHUMI_NORMALIZED_CONTEXT = '<td>&#160;&#160;</td>';
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const PERCENT_SEPARATOR = /%(?:2f|5c)/iu;
const NATIVE_FILE_IDENTITY = /^[0-9a-f]{8}:[0-9a-f]{16}$/u;
const F005_POLICY_IDS = Object.freeze([
  'voicevox-terms',
  'zundamon-audio-terms',
  'zundamon-character-guideline',
] as const satisfies readonly PolicyId[]);

export const F005_SELECTION_SNAPSHOT_PATH =
  'content/batches/F005/source-snapshots/selection.json';

export const F005_NATIVE_GUARD_PINS = Object.freeze({
  abi: 'f005-guard-jsonl-v1',
  capacityAbi: 'f005-capacity-pipe-v3',
  rid: 'win-x64',
  sdkVersion: '9.0.316',
  runtimeVersion: '9.0.18',
  sdkZipSha512:
    '871d655b07f05aa5844a27a0dc742ccb6ca1e6df11be1c1251d6e967505595f455fd1160165048e3348f8dd2412ca82d414d0402c8acab30f997e30897a9040f',
  runtimeZipSha512:
    '38dd0b646bcf8e593d86456b97f75566a902358c437f84ab8b2b21c8f54cc0272910a91330936f02c8eec6e45c1157b716b21d15b91d55187daf19831c32b8a8',
  outputBinarySha256:
    '05cdacf3d4e83683118be1835838548d20091ae411a6497ca840178068390b56',
} as const);

export const F005_WORKS = Object.freeze([
  Object.freeze({
    workId: '000799',
    title: '夢十夜',
    cardUrl: `${AOZORA_ORIGIN}/cards/000148/card799.html`,
    sourceUrl: `${AOZORA_ORIGIN}/cards/000148/files/799_14972.html`,
  }),
  Object.freeze({
    workId: '001076',
    title: '倫敦塔',
    cardUrl: `${AOZORA_ORIGIN}/cards/000148/card1076.html`,
    sourceUrl: `${AOZORA_ORIGIN}/cards/000148/files/1076_14974.html`,
  }),
  Object.freeze({
    workId: '001104',
    title: '趣味の遺伝',
    cardUrl: `${AOZORA_ORIGIN}/cards/000148/card1104.html`,
    sourceUrl: `${AOZORA_ORIGIN}/cards/000148/files/1104_14948.html`,
  }),
] as const);

export type F005WorkId = (typeof F005_WORKS)[number]['workId'];
export type F005Phase = 'selection' | 'predeploy';

export type F005SourceErrorCode =
  | 'F005_CONTEXT_INVALID'
  | 'F005_TRANSPORT_REQUIRED'
  | 'F005_SOURCE_RESPONSE_INVALID'
  | 'F005_SOURCE_DRIFT'
  | 'F005_USAGE_NOT_ALLOWED'
  | 'F005_BIBLIOGRAPHY_INVALID'
  | 'F005_ENTITY_NORMALIZATION_INVALID'
  | 'F005_XHTML_PREFLIGHT_REJECTED'
  | 'F005_EXTRACTION_FAILED'
  | 'F005_PATH_UNSAFE';

export class F005SourceError extends Error {
  constructor(
    public readonly code: F005SourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'F005SourceError';
  }
}

export interface RawArtifactRef {
  readonly storage: 'inline';
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly mediaType: string;
  readonly charset: 'UTF-8' | 'Shift_JIS' | null;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
  readonly transport: Readonly<TransportSecurityEvidence | PolicySecurityProof>;
}

export interface F005PolicySnapshot {
  readonly policyId: (typeof F005_POLICY_IDS)[number];
  readonly versionOrLabel: string;
  readonly artifact: RawArtifactRef;
  readonly decision: PolicyClauseDecision;
}

export interface PolicyClauseResult {
  readonly clauseId: string;
  readonly status: 'satisfied' | 'missing' | 'prohibited' | 'unknown';
}

export interface PolicyClauseDecision {
  readonly __brand: 'F005PolicyClauseDecision';
  readonly policyId: (typeof F005_POLICY_IDS)[number];
  readonly contentSha256: string;
  readonly classification: 'free-no-ads-no-payments-no-sponsorship-unofficial';
  readonly requiredCredit: 'VOICEVOX:ずんだもん';
  readonly decision: 'allow' | 'blocked';
  readonly clauses: readonly PolicyClauseResult[];
}

export interface F005WorkSnapshot {
  readonly workId: F005WorkId;
  readonly title: string;
  readonly bibliography: Readonly<BibliographyRow>;
  readonly card: RawArtifactRef;
  readonly xhtml: RawArtifactRef;
}

export interface F005SourceSnapshot {
  readonly schemaVersion: '2.0.0';
  readonly authorId: '000148';
  readonly phase: F005Phase;
  readonly observedAt: string;
  readonly bibliographyArchive: RawArtifactRef;
  readonly bibliographyCsv: RawArtifactRef;
  readonly authorPage: RawArtifactRef;
  readonly policies: readonly F005PolicySnapshot[];
  readonly works: readonly F005WorkSnapshot[];
}

export interface F005CollectionOptions {
  readonly policyTransport: ProductionPolicyTransport;
  readonly trustedProjectRoot: string;
  readonly workspace: string;
  readonly selectionSnapshot?: F005SourceSnapshot;
}

export interface F005UsageProfile {
  readonly free: boolean;
  readonly advertising: boolean;
  readonly payments: boolean;
  readonly sponsorship: boolean;
  readonly unofficial: boolean;
  readonly voiceCredit: string;
}

export interface RightsUsageDecision {
  readonly decision: 'allow' | 'blocked';
  readonly reasons: readonly string[];
  readonly phase: F005Phase;
  readonly observedAt: string;
}

export interface BibliographyV2 {
  readonly baseEdition: string;
  readonly inputter: string;
  readonly proofreader: string | null;
}

export interface SourceRecordV2 {
  readonly schemaVersion: '2.0.0';
  readonly workId: F005WorkId;
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
  readonly bibliography: BibliographyV2;
}

export interface EntityReplacement {
  readonly offset: number;
  readonly from: '&nbsp;';
  readonly to: '&#160;';
}

export interface EntityNormalizationResult {
  readonly schemaVersion: '1.0.0';
  readonly policyVersion: string;
  readonly workId: F005WorkId;
  readonly variant: 'passthrough' | 'entity';
  readonly rawSha256: string;
  readonly processed: SealedArtifactRef;
  readonly replacements: readonly EntityReplacement[];
}

export interface SealedArtifactRef {
  readonly storage: 'sealed';
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly mediaType: 'text/html';
  readonly charset: 'Shift_JIS';
  readonly byteLength: number;
  readonly sha256: string;
  readonly capability: SafeFileHandle;
}

export interface F005CandidateSet {
  readonly schemaVersion: '1.0.0';
  readonly workId: F005WorkId;
  readonly sourceSha256: string;
  readonly extractorVersion: typeof EXTRACTOR_VERSION;
  readonly result: ExtractionResult;
}

export interface SafeFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export type F005NativeFileIdentity = `${string}:${string}`;

export interface SafeWorkspaceFileSnapshot {
  readonly relativePosixPath: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly nativeIdentity: F005NativeFileIdentity;
}

export interface SafeFileHandle {
  readonly __brand: 'SafeFileCapability';
  readonly relativePosixPath: string;
  readonly operation: 'read' | 'rename-source' | 'delete-source';
  readonly exists: boolean;
  readonly contentSha256: string;
  readonly nativeIdentity: F005NativeFileIdentity;
  readonly identity: SafeFileIdentity | null;
  readonly parentIdentity: SafeFileIdentity;
}

export interface F005NativeGuardBuildEvidence {
  readonly schemaVersion: '1.0.0';
  readonly abi: typeof F005_NATIVE_GUARD_PINS.abi;
  readonly capacityAbi: typeof F005_NATIVE_GUARD_PINS.capacityAbi;
  readonly rid: typeof F005_NATIVE_GUARD_PINS.rid;
  readonly sdkVersion: typeof F005_NATIVE_GUARD_PINS.sdkVersion;
  readonly runtimeVersion: typeof F005_NATIVE_GUARD_PINS.runtimeVersion;
  readonly sdkZipSha512: typeof F005_NATIVE_GUARD_PINS.sdkZipSha512;
  readonly runtimeZipSha512: typeof F005_NATIVE_GUARD_PINS.runtimeZipSha512;
  readonly programSha256: string;
  readonly projectSha256: string;
  readonly globalJsonSha256: string;
  readonly apphostSha256: string;
  readonly outputBinarySha256: string;
  readonly outputBytes: number;
}

export interface F005NativeGuardBuildInputs {
  readonly program: Uint8Array;
  readonly project: Uint8Array;
  readonly globalJson: Uint8Array;
  readonly apphost: Uint8Array;
  readonly outputBinary: Uint8Array;
}

const mintedSnapshots = new WeakSet<object>();
const mintedWorkSnapshots = new WeakSet<object>();
const mintedSourceRecords = new WeakSet<object>();
const mintedNormalizations = new WeakSet<object>();
const mintedPolicyDecisions = new WeakSet<object>();
const safeCapabilityState = new WeakMap<object, {
  readonly client: F005NativeGuardClient;
  readonly capabilityId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly nativeIdentity: F005NativeFileIdentity;
  active: boolean;
}>();

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

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export async function resolveF005NativeGuardExecutable(
  workspace: string,
  configured: string | undefined = process.env.F005_NATIVE_GUARD_PATH,
): Promise<string> {
  const fallback = join(workspace, '.cache', 'dotnet-f005', 'publish', 'f005-guard.exe');
  if (configured === undefined) return fallback;
  if (configured.length === 0 || !isAbsolute(configured) || resolve(configured) !== configured) {
    throw new F005SourceError(
      'F005_PATH_UNSAFE',
      'F005_NATIVE_GUARD_PATHは正規化済みabsolute pathが必要です',
    );
  }
  const [workspaceReal, executableReal, executableInfo] = await Promise.all([
    realpath(workspace),
    realpath(configured),
    lstat(configured),
  ]);
  const relation = relative(workspaceReal, executableReal);
  if (
    relation === ''
    || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
    || executableReal !== configured
    || executableInfo.isSymbolicLink()
    || !executableInfo.isFile()
    || executableInfo.nlink !== 1
  ) {
    throw new F005SourceError('F005_PATH_UNSAFE', 'native guard実体はworkspace外の単一regular fileが必要です');
  }
  const root = parse(executableReal).root;
  for (let cursor = dirname(executableReal); cursor !== root; cursor = dirname(cursor)) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new F005SourceError('F005_PATH_UNSAFE', 'native guard ancestorにreparseを使用できません');
    }
  }
  return executableReal;
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
): PolicyClauseResult {
  if (text === null) return { clauseId, status: 'unknown' };
  if (prohibited?.test(text)) return { clauseId, status: 'prohibited' };
  return {
    clauseId,
    status: required.every((pattern) => pattern.test(text)) ? 'satisfied' : 'missing',
  };
}

/**
 * 3規約ごとに固定clauseを解析し、意味なし・欠落・禁止・未知本文をallowへ昇格させない。
 * @des DES-F005-003 @fun FUN-F005-007 @ut UT-F005-007
 */
export function evaluateF005PolicyClauses(
  policyId: (typeof F005_POLICY_IDS)[number],
  raw: Uint8Array,
): PolicyClauseDecision {
  if (!F005_POLICY_IDS.includes(policyId)) {
    throw new F005SourceError('F005_USAGE_NOT_ALLOWED', '未承認policy IDです');
  }
  const text = policyPlainText(raw);
  const usageForbidden = /(?:無料|非商用|個人利用|広告なし)[^。]{0,80}(?:禁止|認め(?:ない|ません))/u;
  let clauses: PolicyClauseResult[];
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
    __brand: 'F005PolicyClauseDecision' as const,
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

function requireExactContext(context: unknown): asserts context is F005ApprovedBatchContext {
  if (!isMintedF005ApprovedBatchContext(context)) {
    throw new F005SourceError('F005_CONTEXT_INVALID', 'F005のmint済み承認contextが必要です');
  }
  const rawWorks = context.candidate.works;
  if (
    context.definition.feature !== 'F005' ||
    context.definition.batchId !== 'F005' ||
    context.candidate.feature !== 'F005' ||
    context.candidate.author.authorId !== AUTHOR_ID ||
    rawWorks.length !== F005_WORKS.length
  ) {
    throw new F005SourceError('F005_CONTEXT_INVALID', 'F005 contextの固定tupleが一致しません');
  }
  rawWorks.forEach((item, index) => {
    const expected = F005_WORKS[index]!;
    if (
      item.workId !== expected.workId ||
      item.title !== expected.title ||
      item.cardUrl !== expected.cardUrl ||
      item.xhtmlUrl !== expected.sourceUrl
    ) {
      throw new F005SourceError('F005_CONTEXT_INVALID', 'F005 contextの作品順が一致しません');
    }
  });
}

function assertTrustedTime(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new F005SourceError('F005_CONTEXT_INVALID', 'trusted clockが不正です');
  }
  return value.toISOString();
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
    throw new F005SourceError('F005_SOURCE_RESPONSE_INVALID', '公式取得responseが固定条件を満たしません');
  }
  const fetchedAt = response.fetchedAt ?? fallbackFetchedAt;
  if (!Number.isFinite(Date.parse(fetchedAt))) {
    throw new F005SourceError('F005_SOURCE_RESPONSE_INVALID', '公式取得時刻が不正です');
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
    throw new F005SourceError('F005_SOURCE_RESPONSE_INVALID', 'transport security evidenceが不正です');
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

async function readStablePersistedFile(
  workspace: string,
  relativePosixPath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!isAbsolute(workspace)) {
    throw new F005SourceError('F005_PATH_UNSAFE', 'snapshot workspaceは絶対pathが必要です');
  }
  safePathSegments(relativePosixPath);
  if (maxBytes > MAX_SOURCE_BYTES) {
    const root = resolve(workspace);
    const target = join(root, ...relativePosixPath.split('/'));
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const [rootInfo, rootReal] = await Promise.all([lstat(root), realpath(root)]);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootReal !== root) {
        throw new F005SourceError('F005_PATH_UNSAFE', 'snapshot workspace実体が不正です');
      }
      handle = await open(target, fsConstants.O_RDONLY);
      const before = await handle.stat();
      const [pathInfo, targetReal] = await Promise.all([lstat(target), realpath(target)]);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size <= 0 ||
        before.size > maxBytes ||
        !pathInfo.isFile() ||
        pathInfo.isSymbolicLink() ||
        pathInfo.nlink !== 1 ||
        targetReal !== target ||
        before.dev !== pathInfo.dev ||
        before.ino !== pathInfo.ino ||
        before.size !== pathInfo.size ||
        before.mtimeMs !== pathInfo.mtimeMs
      ) {
        throw new F005SourceError('F005_PATH_UNSAFE', 'large snapshot artifactのhandle/path identityが一致しません');
      }
      const bytes = new Uint8Array(await handle.readFile());
      const after = await handle.stat();
      const [current, currentReal] = await Promise.all([lstat(target), realpath(target)]);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        after.nlink !== 1 ||
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        before.size !== current.size ||
        before.mtimeMs !== current.mtimeMs ||
        current.nlink !== 1 ||
        currentReal !== target ||
        bytes.byteLength !== before.size
      ) {
        throw new F005SourceError('F005_SOURCE_DRIFT', 'large snapshot artifactが読込中に変化しました');
      }
      return bytes;
    } catch (error) {
      if (error instanceof F005SourceError) throw error;
      throw new F005SourceError('F005_PATH_UNSAFE', 'large snapshot artifactを安全に読み込めません', { cause: error });
    } finally {
      await handle?.close();
    }
  }
  let capability: SafeFileHandle | undefined;
  try {
    capability = await resolveSafeWorkspaceFile(resolve(workspace), relativePosixPath, 'read');
    const bytes = await readSafeWorkspaceFile(capability);
    if (bytes.byteLength <= 0 || bytes.byteLength > maxBytes) {
      throw new F005SourceError('F005_SOURCE_DRIFT', 'snapshot artifactのbyte数が上限外です');
    }
    return bytes;
  } catch (error) {
    if (error instanceof F005SourceError) throw error;
    throw new F005SourceError('F005_PATH_UNSAFE', 'snapshot artifactを安全に読み込めません', { cause: error });
  } finally {
    if (capability) await closeSafeWorkspaceFile(capability);
  }
}

function assertPersistedTransport(
  value: unknown,
  sourceUrl: string,
  policy: boolean,
): asserts value is TransportSecurityEvidence | PolicySecurityProof {
  if (!isRecord(value)) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'persisted transport証跡がobjectではありません');
  }
  const commonKeys = [
    'dnsAddresses',
    'connectedAddress',
    'tlsAuthorized',
    'hostnameVerified',
    'redirectsFollowed',
    'proxyUsed',
    'attempts',
  ];
  const expectedKeys = policy ? commonKeys : [...commonKeys, 'hostHeader', 'serverName'];
  const addresses = value.dnsAddresses;
  if (
    !hasExactKeys(value, expectedKeys) ||
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some((address) => !nonBlank(address) || !isPublicAddress(address)) ||
    new Set(addresses).size !== addresses.length ||
    !nonBlank(value.connectedAddress) ||
    !isPublicAddress(value.connectedAddress) ||
    !addresses.includes(value.connectedAddress) ||
    value.tlsAuthorized !== true ||
    value.hostnameVerified !== true ||
    value.redirectsFollowed !== 0 ||
    value.proxyUsed !== false ||
    value.attempts !== 1
  ) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'persisted transport証跡が固定条件と一致しません');
  }
  if (!policy) {
    const hostname = new URL(sourceUrl).hostname;
    if (value.hostHeader !== hostname || value.serverName !== hostname) {
      throw new F005SourceError('F005_SOURCE_DRIFT', 'persisted transportのhost bindingが一致しません');
    }
  }
}

async function rehydratePersistedArtifact(
  workspace: string,
  value: unknown,
  expected: {
    readonly path: string;
    readonly sourceUrl: string;
    readonly mediaType: string;
    readonly charset: 'UTF-8' | 'Shift_JIS' | null;
    readonly maxBytes: number;
    readonly policy: boolean;
  },
): Promise<RawArtifactRef> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'storage',
    'path',
    'sourceUrl',
    'fetchedAt',
    'mediaType',
    'charset',
    'byteLength',
    'sha256',
    'transport',
  ])) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'persisted artifact metadata schemaが一致しません');
  }
  if (
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
    throw new F005SourceError('F005_SOURCE_DRIFT', 'persisted artifact metadataが固定tupleと一致しません');
  }
  assertPersistedTransport(value.transport, expected.sourceUrl, expected.policy);
  const bytes = await readStablePersistedFile(workspace, expected.path, expected.maxBytes);
  if (bytes.byteLength !== value.byteLength || sha256(bytes) !== value.sha256) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'persisted artifact実体のSHAまたはbyte数が一致しません');
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
    transport: deepFreeze(structuredClone(value.transport)),
  });
}

function rehydrateDerivedArtifact(
  value: unknown,
  bytes: Uint8Array,
  expected: {
    readonly path: string;
    readonly derivedFromSha256: string;
    readonly sourceUrl: string;
    readonly mediaType: string;
    readonly charset: 'UTF-8' | 'Shift_JIS' | null;
    readonly maxBytes: number;
    readonly fetchedAt: string;
    readonly transport: Readonly<TransportSecurityEvidence | PolicySecurityProof>;
  },
): RawArtifactRef {
  if (!isRecord(value) || !hasExactKeys(value, [
    'storage',
    'path',
    'derivedFromSha256',
    'sourceUrl',
    'fetchedAt',
    'mediaType',
    'charset',
    'byteLength',
    'sha256',
    'transport',
  ]) ||
    value.storage !== 'derived' ||
    value.path !== expected.path ||
    value.derivedFromSha256 !== expected.derivedFromSha256 ||
    value.sourceUrl !== expected.sourceUrl ||
    value.fetchedAt !== expected.fetchedAt ||
    value.mediaType !== expected.mediaType ||
    value.charset !== expected.charset ||
    value.byteLength !== bytes.byteLength ||
    value.byteLength > expected.maxBytes ||
    value.sha256 !== sha256(bytes) ||
    canonicalJson(value.transport) !== canonicalJson(expected.transport)
  ) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'derived artifact metadataが親実体と一致しません');
  }
  return deepFreeze({
    storage: 'inline' as const,
    sourceUrl: expected.sourceUrl,
    fetchedAt: expected.fetchedAt,
    mediaType: expected.mediaType,
    charset: expected.charset,
    bytes: cloneBytes(bytes),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    transport: deepFreeze(structuredClone(expected.transport)),
  });
}

function assertExpectedRow(row: BibliographyRow, expected: (typeof F005_WORKS)[number], allRows: readonly BibliographyRow[]): void {
  const translatorCount = allRows.filter((candidate) =>
    candidate.workId === expected.workId && /翻訳|translator/iu.test(candidate.role),
  ).length;
  if (
    row.workId !== expected.workId ||
    row.title !== expected.title ||
    row.personId !== AUTHOR_ID ||
    row.personCopyright !== 'なし' ||
    row.copyright !== 'なし' ||
    row.role !== '著者' ||
    translatorCount !== 0 ||
    row.status !== '公開中' ||
    row.language !== '日本語原著' ||
    row.orthography !== '新字新仮名' ||
    row.cardUrl !== expected.cardUrl ||
    row.sourceUrl !== expected.sourceUrl ||
    normalizeHttpCharset(row.charset) !== 'Shift_JIS'
  ) {
    throw new F005SourceError('F005_SOURCE_DRIFT', `公式書誌が固定条件と一致しません: ${expected.workId}`);
  }
}

/**
 * F005の公式書誌・図書カード・XHTMLをproduction transportだけで取得し、raw snapshotへ固定する。
 * @des DES-F005-003 @fun FUN-F005-006 @ut UT-F005-006
 */
export async function collectF005SourceSnapshot(
  transport: ProductionAozoraTransport,
  context: F005ApprovedBatchContext,
  phase: F005Phase,
  trustedClock: () => Date,
  options: F005CollectionOptions,
): Promise<F005SourceSnapshot> {
  if (
    !(transport instanceof ProductionAozoraTransport) ||
    transport.request !== ProductionAozoraTransport.prototype.request
  ) {
    throw new F005SourceError('F005_TRANSPORT_REQUIRED', 'production transportが必要です');
  }
  requireExactContext(context);
  if (
    !isRecord(options) ||
    !(options.policyTransport instanceof ProductionPolicyTransport) ||
    options.policyTransport.request !== ProductionPolicyTransport.prototype.request ||
    !isAbsolute(options.trustedProjectRoot) ||
    !isAbsolute(options.workspace)
  ) {
    throw new F005SourceError('F005_TRANSPORT_REQUIRED', 'production規約transportとtrusted workspaceが必要です');
  }
  if (phase !== 'selection' && phase !== 'predeploy') {
    throw new F005SourceError('F005_CONTEXT_INVALID', '観測phaseが不正です');
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
    throw new F005SourceError('F005_SOURCE_RESPONSE_INVALID', '公式書誌ZIPを安全に展開できません', { cause: error });
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
    throw new F005SourceError('F005_BIBLIOGRAPHY_INVALID', '公式書誌CSVが不正です', { cause: error });
  }
  const selectedRows = F005_WORKS.map((expected) => {
    const matches = rows.filter((row) =>
      row.workId === expected.workId && row.personId === AUTHOR_ID && row.role === '著者',
    );
    if (matches.length !== 1) {
      throw new F005SourceError('F005_SOURCE_DRIFT', `公式書誌の対象行が一意ではありません: ${expected.workId}`);
    }
    const row = matches[0]!;
    assertExpectedRow(row, expected, rows);
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
    'F005',
  ).filter((definition): definition is typeof definition & {
    readonly policyId: (typeof F005_POLICY_IDS)[number];
  } => F005_POLICY_IDS.includes(definition.policyId as (typeof F005_POLICY_IDS)[number]));
  const policies: F005PolicySnapshot[] = [];
  for (const policyId of F005_POLICY_IDS) {
    const definition = definitions.find((item) => item.policyId === policyId);
    if (!definition) {
      throw new F005SourceError('F005_SOURCE_DRIFT', `規約定義がありません: ${policyId}`);
    }
    let fetched;
    try {
      fetched = await fetchPolicyObservation(definition, options.policyTransport);
    } catch (error) {
      throw new F005SourceError('F005_SOURCE_RESPONSE_INVALID', `規約取得に失敗しました: ${policyId}`, { cause: error });
    }
    const bytes = cloneBytes(fetched.body);
    const decision = evaluateF005PolicyClauses(policyId, bytes);
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
  const works: F005WorkSnapshot[] = [];
  for (const [index, expected] of F005_WORKS.entries()) {
    const card = await requestArtifact(
      transport,
      expected.cardUrl,
      '/cards/000148/',
      'text/html',
      'UTF-8',
      MAX_SOURCE_BYTES,
      observedAt,
    );
    const xhtml = await requestArtifact(
      transport,
      expected.sourceUrl,
      '/cards/000148/',
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
    schemaVersion: '2.0.0' as const,
    authorId: '000148' as const,
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
      throw new F005SourceError('F005_CONTEXT_INVALID', 'selection観測へ旧snapshotは指定できません');
    }
  } else {
    const selection = options.selectionSnapshot;
    if (!selection || !mintedSnapshots.has(selection) || selection.phase !== 'selection') {
      throw new F005SourceError('F005_SOURCE_DRIFT', 'predeployにはmint済みselection snapshotが必要です');
    }
    const before = [
      selection.bibliographyCsv.sha256,
      ...selection.works.flatMap((work) => [work.card.sha256, work.xhtml.sha256]),
      ...selection.policies.map((policy) => policy.artifact.sha256),
    ];
    const after = [
      snapshot.bibliographyCsv.sha256,
      ...snapshot.works.flatMap((work) => [work.card.sha256, work.xhtml.sha256]),
      ...snapshot.policies.map((policy) => policy.artifact.sha256),
    ];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new F005SourceError('F005_SOURCE_DRIFT', 'selection/predeployの原典または規約SHAが変化しました');
    }
  }
  return snapshot;
}

/**
 * 永続化済みselection snapshotを実ファイル・承認context・公式固定tupleへ再結合して再mintする。
 * process再起動後のpredeployで、保存JSONだけをbrandとして信用しない。
 * @des DES-F005-003 @fun FUN-F005-006 @ut UT-F005-006
 */
export async function rehydrateF005SelectionSnapshot(
  workspace: string,
  context: F005ApprovedBatchContext,
): Promise<F005SourceSnapshot> {
  requireExactContext(context);
  const documentBytes = await readStablePersistedFile(
    workspace,
    F005_SELECTION_SNAPSHOT_PATH,
    MAX_SOURCE_BYTES,
  );
  let documentText: string;
  let persisted: unknown;
  try {
    documentText = new TextDecoder('utf-8', { fatal: true }).decode(documentBytes);
    persisted = JSON.parse(documentText);
  } catch (error) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'selection snapshot JSONが不正です', { cause: error });
  }
  if (documentText !== canonicalJson(persisted) || !isRecord(persisted) ||
    !hasExactKeys(persisted, [
      'schemaVersion',
      'kind',
      'batchId',
      'authorId',
      'phase',
      'observedAt',
      'rights',
      'bibliographyArchive',
      'bibliographyCsv',
      'authorPage',
      'policies',
      'works',
    ]) ||
    persisted.schemaVersion !== '2.0.0' ||
    persisted.kind !== 'f005-source-selection-snapshot' ||
    persisted.batchId !== 'F005' ||
    persisted.authorId !== AUTHOR_ID ||
    persisted.phase !== 'selection' ||
    !nonBlank(persisted.observedAt) ||
    !Number.isFinite(Date.parse(persisted.observedAt)) ||
    !Array.isArray(persisted.policies) ||
    persisted.policies.length !== F005_POLICY_IDS.length ||
    !Array.isArray(persisted.works) ||
    persisted.works.length !== F005_WORKS.length
  ) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'selection snapshotのcanonical schemaが一致しません');
  }

  const bibliographyArchive = await rehydratePersistedArtifact(
    workspace,
    persisted.bibliographyArchive,
    {
      path: 'data/batches/F005/source-snapshots/selection/bibliography.zip',
      sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
      mediaType: 'application/zip',
      charset: null,
      maxBytes: MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
      policy: false,
    },
  );
  let extractedCsv: Uint8Array;
  let rows: BibliographyRow[];
  try {
    extractedCsv = extractVerifiedBibliographyCsv(bibliographyArchive.bytes);
  } catch (error) {
    throw new F005SourceError('F005_BIBLIOGRAPHY_INVALID', 'persisted公式書誌を再検証できません', { cause: error });
  }
  const bibliographyCsv = isRecord(persisted.bibliographyCsv) &&
    persisted.bibliographyCsv.storage === 'derived'
    ? rehydrateDerivedArtifact(persisted.bibliographyCsv, extractedCsv, {
      path: 'data/batches/F005/source-snapshots/selection/bibliography.zip',
      derivedFromSha256: bibliographyArchive.sha256,
      sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
      mediaType: 'text/csv',
      charset: 'UTF-8',
      maxBytes: MAX_BIBLIOGRAPHY_CSV_BYTES,
      fetchedAt: bibliographyArchive.fetchedAt,
      transport: bibliographyArchive.transport,
    })
    : await rehydratePersistedArtifact(
      workspace,
      persisted.bibliographyCsv,
      {
        path: 'data/batches/F005/source-snapshots/selection/bibliography.csv',
        sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
        mediaType: 'text/csv',
        charset: 'UTF-8',
        maxBytes: MAX_BIBLIOGRAPHY_CSV_BYTES,
        policy: false,
      },
    );
  try {
    rows = parseAozoraBibliography(bibliographyCsv.bytes);
  } catch (error) {
    throw new F005SourceError('F005_BIBLIOGRAPHY_INVALID', 'persisted公式書誌CSVを解析できません', { cause: error });
  }
  if (
    extractedCsv.byteLength !== bibliographyCsv.bytes.byteLength ||
    sha256(extractedCsv) !== bibliographyCsv.sha256 ||
    bibliographyCsv.fetchedAt !== bibliographyArchive.fetchedAt ||
    canonicalJson(bibliographyCsv.transport) !== canonicalJson(bibliographyArchive.transport)
  ) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'persisted ZIP/CSV bindingが一致しません');
  }
  const selectedRows = F005_WORKS.map((expected) => {
    const matches = rows.filter((row) =>
      row.workId === expected.workId && row.personId === AUTHOR_ID && row.role === '著者',
    );
    if (matches.length !== 1) {
      throw new F005SourceError('F005_SOURCE_DRIFT', `persisted書誌の対象行が一意ではありません: ${expected.workId}`);
    }
    assertExpectedRow(matches[0]!, expected, rows);
    return deepFreeze(structuredClone(matches[0]!));
  });
  const authorPage = await rehydratePersistedArtifact(
    workspace,
    persisted.authorPage,
    {
      path: 'data/batches/F005/source-snapshots/selection/author-page.html',
      sourceUrl: AUTHOR_PAGE_URL,
      mediaType: 'text/html',
      charset: 'UTF-8',
      maxBytes: MAX_SOURCE_BYTES,
      policy: false,
    },
  );

  const definitions = createPolicyDefinitions(workspace, workspace, 'F005')
    .filter((definition): definition is typeof definition & {
      readonly policyId: (typeof F005_POLICY_IDS)[number];
    } => F005_POLICY_IDS.includes(definition.policyId as (typeof F005_POLICY_IDS)[number]));
  const policies: F005PolicySnapshot[] = [];
  for (const [index, policyId] of F005_POLICY_IDS.entries()) {
    const rawPolicy = persisted.policies[index];
    const definition = definitions.find((item) => item.policyId === policyId);
    if (!definition || !isRecord(rawPolicy) || !hasExactKeys(rawPolicy, [
      'policyId',
      'versionOrLabel',
      'artifact',
      'decision',
    ]) ||
      rawPolicy.policyId !== policyId ||
      rawPolicy.versionOrLabel !== definition.versionOrLabel
    ) {
      throw new F005SourceError('F005_SOURCE_DRIFT', `persisted規約tupleが一致しません: ${policyId}`);
    }
    const policyArtifact = await rehydratePersistedArtifact(
      workspace,
      rawPolicy.artifact,
      {
        path: `data/batches/F005/source-snapshots/selection/policies/${policyId}.raw`,
        sourceUrl: definition.url,
        mediaType: 'text/html',
        charset: null,
        maxBytes: MAX_SOURCE_BYTES,
        policy: true,
      },
    );
    const decision = evaluateF005PolicyClauses(policyId, policyArtifact.bytes);
    if (canonicalJson(rawPolicy.decision) !== canonicalJson(decision)) {
      throw new F005SourceError('F005_SOURCE_DRIFT', `persisted規約decisionが本文と一致しません: ${policyId}`);
    }
    policies.push(deepFreeze({
      policyId,
      versionOrLabel: definition.versionOrLabel,
      artifact: policyArtifact,
      decision,
    }));
  }

  const works: F005WorkSnapshot[] = [];
  for (const [index, expected] of F005_WORKS.entries()) {
    const rawWork = persisted.works[index];
    const contextWork = context.candidate.works[index];
    if (!isRecord(rawWork) || !hasExactKeys(rawWork, [
      'workId',
      'title',
      'bibliography',
      'card',
      'xhtml',
    ]) ||
      rawWork.workId !== expected.workId ||
      rawWork.title !== expected.title ||
      contextWork?.workId !== expected.workId ||
      contextWork.title !== expected.title ||
      contextWork.cardUrl !== expected.cardUrl ||
      contextWork.xhtmlUrl !== expected.sourceUrl ||
      canonicalJson(rawWork.bibliography) !== canonicalJson(selectedRows[index])
    ) {
      throw new F005SourceError('F005_SOURCE_DRIFT', `persisted作品とapproved contextが一致しません: ${expected.workId}`);
    }
    const card = await rehydratePersistedArtifact(workspace, rawWork.card, {
      path: `data/batches/F005/source-snapshots/selection/works/${expected.workId}/card.html`,
      sourceUrl: expected.cardUrl,
      mediaType: 'text/html',
      charset: 'UTF-8',
      maxBytes: MAX_SOURCE_BYTES,
      policy: false,
    });
    const xhtml = await rehydratePersistedArtifact(workspace, rawWork.xhtml, {
      path: `data/batches/F005/source-snapshots/selection/works/${expected.workId}/source.raw`,
      sourceUrl: expected.sourceUrl,
      mediaType: 'text/html',
      charset: 'Shift_JIS',
      maxBytes: MAX_SOURCE_BYTES,
      policy: false,
    });
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
    schemaVersion: '2.0.0' as const,
    authorId: '000148' as const,
    phase: 'selection' as const,
    observedAt: persisted.observedAt,
    bibliographyArchive,
    bibliographyCsv,
    authorPage,
    policies,
    works,
  });
  mintedSnapshots.add(snapshot);
  const rights = evaluateF005RightsAndUsage(snapshot, {
    free: true,
    advertising: false,
    payments: false,
    sponsorship: false,
    unofficial: true,
    voiceCredit: 'VOICEVOX:ずんだもん',
  });
  if (rights.decision !== 'allow' || canonicalJson(persisted.rights) !== canonicalJson(rights)) {
    throw new F005SourceError('F005_USAGE_NOT_ALLOWED', 'persisted rights decisionを再現できません');
  }
  return snapshot;
}

/**
 * 取得済みsnapshotと固定用途profileから、権利・規約条件をfail-closed評価する。
 * @des DES-F005-003 @fun FUN-F005-007 @ut UT-F005-007
 */
export function evaluateF005RightsAndUsage(
  snapshot: F005SourceSnapshot,
  usageProfile: F005UsageProfile,
): RightsUsageDecision {
  if (!isRecord(snapshot) || !mintedSnapshots.has(snapshot)) {
    throw new F005SourceError('F005_USAGE_NOT_ALLOWED', '検証済みsnapshotが必要です');
  }
  const reasons: string[] = [];
  if (
    snapshot.policies.length !== F005_POLICY_IDS.length ||
    snapshot.policies.some((policy, index) =>
      policy.policyId !== F005_POLICY_IDS[index] ||
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
    Object.keys(usageProfile).sort().join(',') !==
      'advertising,free,payments,sponsorship,unofficial,voiceCredit' ||
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
      assertExpectedRow(work.bibliography, F005_WORKS[index]!, snapshot.works.map((item) => item.bibliography));
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

function bibliographyModeWorkId(mode: F005WorkId | { readonly workId: F005WorkId }): F005WorkId {
  const workId = typeof mode === 'string' ? mode : mode.workId;
  if (!F005_WORKS.some((work) => work.workId === workId)) {
    throw new F005SourceError('F005_BIBLIOGRAPHY_INVALID', '未承認work IDです');
  }
  return workId;
}

/**
 * nullable校正者規則を全層共通のexact schemaとして検証する。
 * @des DES-F005-003 DES-F005-007 @fun FUN-F005-024 @ut UT-F005-024
 */
export function parseBibliographyV2(
  value: unknown,
  mode: F005WorkId | { readonly workId: F005WorkId },
): BibliographyV2 {
  const workId = bibliographyModeWorkId(mode);
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'baseEdition') ||
    !Object.hasOwn(value, 'inputter') ||
    !Object.hasOwn(value, 'proofreader') ||
    !nonBlank(value.baseEdition) ||
    !nonBlank(value.inputter)
  ) {
    throw new F005SourceError('F005_BIBLIOGRAPHY_INVALID', '書誌V2 schemaが不正です');
  }
  if (workId === '000799') {
    if (value.proofreader !== null) {
      throw new F005SourceError('F005_BIBLIOGRAPHY_INVALID', '夢十夜の校正者はcanonical nullだけを許可します');
    }
  } else if (!nonBlank(value.proofreader)) {
    throw new F005SourceError('F005_BIBLIOGRAPHY_INVALID', '校正者は非空文字列である必要があります');
  }
  return deepFreeze({
    baseEdition: value.baseEdition,
    inputter: value.inputter,
    proofreader: value.proofreader as string | null,
  });
}

export function formatProofreader(value: string | null): string {
  return value === null ? '記載なし' : value;
}

function extractCardUpdatedAt(card: RawArtifactRef, sourceUrl: string): string {
  if (
    card.charset !== 'UTF-8' ||
    card.sha256 !== sha256(card.bytes) ||
    card.byteLength !== card.bytes.byteLength
  ) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'card raw/SHA bindingが一致しません');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(card.bytes);
  } catch (error) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'card UTF-8 decodeに失敗しました', { cause: error });
  }
  const all = [...text.matchAll(/最終更新日/gu)];
  if (all.length !== 1) throw new F005SourceError('F005_SOURCE_DRIFT', 'card最終更新日headerが一意ではありません');
  const sourceFile = new URL(sourceUrl).pathname.split('/').at(-1);
  const sourceRows = sourceFile
    ? [...text.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/giu)]
      .filter((match) => match[0].includes(`./files/${sourceFile}`))
    : [];
  if (sourceRows.length > 1) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'cardの対象XHTML行が一意ではありません');
  }
  const rowDates = sourceRows[0]?.[0].match(/\d{4}-\d{2}-\d{2}/gu) ?? [];
  const iso = rowDates.length === 2
    ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(rowDates[1]!)
    : /最終更新日[^0-9]{0,40}(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/u.exec(text);
  if (!iso) throw new F005SourceError('F005_SOURCE_DRIFT', 'card最終更新日が一意に取得できません');
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
    monthNumber < 1 ||
    monthNumber > 12 ||
    dayNumber < 1 ||
    dayNumber > 31 ||
    date.getUTCFullYear() !== yearNumber ||
    date.getUTCMonth() !== monthNumber - 1 ||
    date.getUTCDate() !== dayNumber
  ) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'card最終更新日が不正です');
  }
  return value;
}

function assertSourceRecordArtifacts(sourceRecord: SourceRecordV2): void {
  if (
    sourceRecord.raw.sha256 !== sha256(sourceRecord.raw.bytes) ||
    sourceRecord.raw.byteLength !== sourceRecord.raw.bytes.byteLength ||
    sourceRecord.card.sha256 !== sha256(sourceRecord.card.bytes) ||
    sourceRecord.card.byteLength !== sourceRecord.card.bytes.byteLength ||
    sourceRecord.cardRawSha256 !== sourceRecord.card.sha256 ||
    sourceRecord.cardRawBytes !== sourceRecord.card.byteLength
  ) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'SourceRecordV2 raw/cardが境界前に改変されました');
  }
}

/**
 * minted work snapshotからraw参照を失わないSourceRecordV2を構築する。
 * @des DES-F005-003 @fun FUN-F005-008 @ut UT-F005-008
 */
export function parseF005SourceRecord(
  snapshot: F005WorkSnapshot,
  expectedWork: F005WorkId | (typeof F005_WORKS)[number],
): SourceRecordV2 {
  if (!isRecord(snapshot) || !mintedWorkSnapshots.has(snapshot)) {
    throw new F005SourceError('F005_SOURCE_DRIFT', '検証済みwork snapshotが必要です');
  }
  const expectedId = typeof expectedWork === 'string' ? expectedWork : expectedWork.workId;
  const expected = F005_WORKS.find((work) => work.workId === expectedId);
  if (
    !expected ||
    snapshot.workId !== expected.workId ||
    snapshot.title !== expected.title ||
    snapshot.card.sourceUrl !== expected.cardUrl ||
    snapshot.xhtml.sourceUrl !== expected.sourceUrl ||
    snapshot.xhtml.charset !== 'Shift_JIS' ||
    snapshot.xhtml.sha256 !== sha256(snapshot.xhtml.bytes)
  ) {
    throw new F005SourceError('F005_SOURCE_DRIFT', 'source snapshotが固定作品と一致しません');
  }
  const bibliography = parseBibliographyV2({
    baseEdition: snapshot.bibliography.baseEdition,
    inputter: snapshot.bibliography.inputter,
    proofreader: snapshot.bibliography.proofreader || null,
  }, expected.workId);
  const updatedAt = extractCardUpdatedAt(snapshot.card, expected.sourceUrl);
  const record = deepFreeze({
    schemaVersion: '2.0.0' as const,
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
 * 趣味の遺伝で承認されたnotation_notes内の2 entityだけを機械置換する。
 * 固定hash検査はnormalizeAozoraXhtmlEntitiesが担う。
 */
export function normalizeApprovedF005EntityContext(rawBytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly replacements: readonly EntityReplacement[];
} {
  const text = new TextDecoder('shift_jis', { fatal: true }).decode(rawBytes);
  const notationMatch = /<div\b[^>]*class=["'][^"']*\bnotation_notes\b[^"']*["'][^>]*>[\s\S]*?<\/div>/iu.exec(text);
  if (
    !notationMatch ||
    notationMatch[0].split(SHUMI_ENTITY_CONTEXT).length - 1 !== 1 ||
    text.split('&nbsp;').length - 1 !== 2
  ) {
    throw new F005SourceError(
      'F005_ENTITY_NORMALIZATION_INVALID',
      '承認済みentityの件数・位置・contextが一致しません',
    );
  }
  const contextOffset = text.indexOf(SHUMI_ENTITY_CONTEXT, notationMatch.index);
  const rawContext = new TextEncoder().encode(SHUMI_ENTITY_CONTEXT);
  const normalizedContext = new TextEncoder().encode(SHUMI_NORMALIZED_CONTEXT);
  const byteOffset = Buffer.from(rawBytes).indexOf(rawContext);
  if (byteOffset < 0 || Buffer.from(rawBytes).indexOf(rawContext, byteOffset + 1) >= 0) {
    throw new F005SourceError('F005_ENTITY_NORMALIZATION_INVALID', '承認済みentityのbyte位置が一意ではありません');
  }
  const entityOffset = byteOffset + '<td>'.length;
  // 承認対象はASCIIだけの等長置換なので、Shift_JISの非ASCII byte列は変化しない。
  const rawCopy = cloneBytes(rawBytes);
  rawCopy.set(normalizedContext, byteOffset);
  if (rawContext.byteLength !== normalizedContext.byteLength || contextOffset < 0) {
    throw new F005SourceError('F005_ENTITY_NORMALIZATION_INVALID', 'entity置換が等長ではありません');
  }
  return deepFreeze({
    bytes: rawCopy,
    replacements: [
      { offset: entityOffset, from: '&nbsp;' as const, to: '&#160;' as const },
      { offset: entityOffset + '&nbsp;'.length, from: '&nbsp;' as const, to: '&#160;' as const },
    ],
  });
}

/**
 * 固定raw hashに対してだけXHTML entity正規化結果をmintする。
 * @des DES-F005-004 @fun FUN-F005-009 @ut UT-F005-009
 */
export async function normalizeAozoraXhtmlEntities(
  rawBytes: Uint8Array,
  sourceRecord: SourceRecordV2,
  policyVersion: string,
  artifactRoot: string,
): Promise<EntityNormalizationResult> {
  if (!isRecord(sourceRecord) || !mintedSourceRecords.has(sourceRecord)) {
    throw new F005SourceError('F005_ENTITY_NORMALIZATION_INVALID', 'mint済みSourceRecordV2が必要です');
  }
  assertSourceRecordArtifacts(sourceRecord);
  if (
    !nonBlank(policyVersion) ||
    sourceRecord.raw.byteLength !== rawBytes.byteLength ||
    sourceRecord.raw.sha256 !== sha256(rawBytes)
  ) {
    throw new F005SourceError('F005_ENTITY_NORMALIZATION_INVALID', 'raw source bindingが一致しません');
  }
  let processedBytes = cloneBytes(rawBytes);
  let variant: EntityNormalizationResult['variant'] = 'passthrough';
  let replacements: readonly EntityReplacement[] = [];
  if (sourceRecord.workId === '001104') {
    if (rawBytes.byteLength !== SHUMI_RAW_BYTES || sha256(rawBytes) !== SHUMI_RAW_SHA256) {
      throw new F005SourceError('F005_ENTITY_NORMALIZATION_INVALID', '趣味の遺伝rawの承認hashが一致しません');
    }
    const normalized = normalizeApprovedF005EntityContext(rawBytes);
    processedBytes = cloneBytes(normalized.bytes);
    replacements = normalized.replacements;
    variant = 'entity';
    if (sha256(processedBytes) !== SHUMI_PROCESSED_SHA256) {
      throw new F005SourceError('F005_ENTITY_NORMALIZATION_INVALID', '趣味の遺伝processed hashが一致しません');
    }
  }
  if (!isAbsolute(artifactRoot)) {
    throw new F005SourceError('F005_ENTITY_NORMALIZATION_INVALID', 'sealed artifact rootが不正です');
  }
  const processedSha256 = sha256(processedBytes);
  const relativeDirectory = 'content/batches/F005/sealed/xhtml';
  const relativePath = `${relativeDirectory}/${sourceRecord.workId}-${processedSha256}.xhtml`;
  await ensureSafeDirectoryTree(artifactRoot, relativeDirectory);
  let capability: SafeFileHandle;
  try {
    capability = await resolveSafeWorkspaceFile(artifactRoot, relativePath, 'read');
    const existing = await readSafeWorkspaceFile(capability);
    if (existing.byteLength !== processedBytes.byteLength || sha256(existing) !== processedSha256) {
      throw new F005SourceError('F005_ENTITY_NORMALIZATION_INVALID', '既存sealed artifactが不一致です');
    }
    // 検証readはone-shot capabilityをcloseするため、後続抽出用handleを改めて保持する。
    capability = await resolveSafeWorkspaceFile(artifactRoot, relativePath, 'read');
  } catch (error) {
    if (!(error instanceof F005SourceError) || error.code !== 'F005_PATH_UNSAFE') throw error;
    const stagingParent = join(resolve(artifactRoot), relativeDirectory.replaceAll('/', sep));
    const stagingDirectory = await mkdtemp(join(stagingParent, '.f005-seal-'));
    const stagingPath = join(stagingDirectory, 'artifact.tmp');
    try {
      const staging = await open(
        stagingPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await staging.writeFile(processedBytes);
        await staging.sync();
      } finally {
        await staging.close();
      }
      const stagingRelativePath = relative(resolve(artifactRoot), stagingPath).split(sep).join('/');
      const stagingCapability = await resolveSafeWorkspaceFile(
        artifactRoot,
        stagingRelativePath,
        'rename-source',
      );
      await renameSafeWorkspaceFile(
        stagingCapability,
        relativePath,
        stagingCapability.nativeIdentity,
      );
    } finally {
      await rm(stagingPath, { force: true });
      try {
        await rm(stagingDirectory);
      } catch {
        // 非空・差替えの可能性があるdirectoryは再帰削除せずfail-closedで残す。
      }
    }
    capability = await resolveSafeWorkspaceFile(artifactRoot, relativePath, 'read');
    const persisted = await readSafeWorkspaceFile(capability);
    if (persisted.byteLength !== processedBytes.byteLength || sha256(persisted) !== processedSha256) {
      throw new F005SourceError('F005_ENTITY_NORMALIZATION_INVALID', 'sealed artifact再読込SHAが一致しません');
    }
    capability = await resolveSafeWorkspaceFile(artifactRoot, relativePath, 'read');
  }
  const processed = deepFreeze({
    storage: 'sealed' as const,
    sourceUrl: sourceRecord.sourceUrl,
    fetchedAt: sourceRecord.fetchedAt,
    mediaType: 'text/html' as const,
    charset: 'Shift_JIS' as const,
    byteLength: processedBytes.byteLength,
    sha256: processedSha256,
    capability,
  });
  const result = deepFreeze({
    schemaVersion: '1.0.0' as const,
    policyVersion,
    workId: sourceRecord.workId,
    variant,
    rawSha256: sha256(rawBytes),
    processed,
    replacements,
  });
  mintedNormalizations.add(result);
  return result;
}

function canonicalizeDoctype(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/\s*>\s*$/u, '>').trim();
}

function preflightF005Xhtml(text: string): void {
  const doctypes = text.match(/<!DOCTYPE\b[\s\S]*?>/giu) ?? [];
  if (doctypes.length !== 1 || canonicalizeDoctype(doctypes[0]!) !== CANONICAL_XHTML11_DOCTYPE) {
    throw new F005SourceError('F005_XHTML_PREFLIGHT_REJECTED', 'XHTML 1.1の固定DOCTYPEではありません');
  }
  const doctypeStart = text.search(/<!DOCTYPE\b/iu);
  const doctypeEnd = text.indexOf('>', doctypeStart);
  if (text.slice(doctypeStart, doctypeEnd + 1).includes('[')) {
    throw new F005SourceError('F005_XHTML_PREFLIGHT_REJECTED', 'DOCTYPE internal subsetは禁止です');
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
    throw new F005SourceError('F005_XHTML_PREFLIGHT_REJECTED', '外部resource/entity構文は禁止です');
  }
  const namedEntities = text.match(/&([A-Za-z][A-Za-z0-9._:-]*);/gu) ?? [];
  if (namedEntities.some((entity) => !['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'].includes(entity))) {
    throw new F005SourceError('F005_XHTML_PREFLIGHT_REJECTED', '標準5種以外のnamed entityは禁止です');
  }
  let depth = 0;
  let nodes = 0;
  for (const match of text.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9:._-]*)\b[^>]*>/gu)) {
    const tag = match[0];
    if (match[1] === '/') {
      depth -= 1;
      if (depth < 0) throw new F005SourceError('F005_XHTML_PREFLIGHT_REJECTED', 'XML depthが不正です');
    } else {
      nodes += 1;
      if (!/\/\s*>$/u.test(tag)) depth += 1;
      if (depth > 256 || nodes > 500_000) {
        throw new F005SourceError('F005_XHTML_PREFLIGHT_REJECTED', 'XML depth/node上限を超えています');
      }
    }
  }
  const textScalars = [...text.replace(/<[^>]*>/gu, '')].length;
  if (text.length > MAX_SOURCE_BYTES || textScalars > 4_000_000 || nodes === 0) {
    throw new F005SourceError('F005_XHTML_PREFLIGHT_REJECTED', 'XHTML resource上限を超えています');
  }
}

/**
 * resource preflight後だけ既存inert DOM抽出器へ渡し、二重実行で決定性を確認する。
 * @des DES-F005-004 @fun FUN-F005-010 @ut UT-F005-010
 */
export async function extractF005DialogueCandidates(
  normalization: EntityNormalizationResult,
  source: SourceRecordV2,
  extractorVersion: string,
): Promise<F005CandidateSet> {
  if (!isRecord(source) || !mintedSourceRecords.has(source)) {
    throw new F005SourceError('F005_EXTRACTION_FAILED', 'mint済みSourceRecordV2が必要です');
  }
  assertSourceRecordArtifacts(source);
  if (
    !isRecord(normalization) ||
    !mintedNormalizations.has(normalization) ||
    normalization.workId !== source.workId ||
    extractorVersion !== EXTRACTOR_VERSION
  ) {
    throw new F005SourceError('F005_EXTRACTION_FAILED', '抽出input bindingが不正です');
  }
  const processedBytes = await readSafeWorkspaceFile(normalization.processed.capability);
  if (
    processedBytes.byteLength !== normalization.processed.byteLength ||
    sha256(processedBytes) !== normalization.processed.sha256
  ) {
    throw new F005SourceError('F005_EXTRACTION_FAILED', 'sealed processed artifactのSHAが一致しません');
  }
  let text: string;
  try {
    text = new TextDecoder('shift_jis', { fatal: true }).decode(processedBytes);
  } catch (error) {
    throw new F005SourceError('F005_XHTML_PREFLIGHT_REJECTED', 'Shift_JIS fatal decodeに失敗しました', { cause: error });
  }
  preflightF005Xhtml(text);
  const decoded = {
    workId: source.workId,
    rawSha256: normalization.processed.sha256,
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
    throw new F005SourceError('F005_EXTRACTION_FAILED', '台詞抽出が失敗または非決定的です');
  }
  return deepFreeze({
    schemaVersion: '1.0.0',
    workId: source.workId,
    sourceSha256: normalization.processed.sha256,
    extractorVersion: EXTRACTOR_VERSION,
    result: first,
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
    throw new F005SourceError('F005_PATH_UNSAFE', 'Windows pathの字句条件に違反しています');
  }
  const segments = relativePosixPath.split('/');
  if (segments.some((segment) =>
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    segment.endsWith('.') ||
    segment.endsWith(' ') ||
    WINDOWS_RESERVED.test(segment) ||
    segment.normalize('NFC') !== segment
  )) {
    throw new F005SourceError('F005_PATH_UNSAFE', 'Windows path segmentが不正です');
  }
  return segments;
}

interface NativeGuardReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

let nativeCapabilitySequence = 0;
const activeNativeGuardPids = new Set<number>();

class F005NativeGuardClient {
  private output = '';
  private pending: {
    readonly resolve: (reply: NativeGuardReply) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  } | null = null;
  private exited = false;
  private readonly exitPromise: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    if (child.pid !== undefined) activeNativeGuardPids.add(child.pid);
    this.exitPromise = new Promise((resolveExit) => {
      let settled = false;
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        this.exited = true;
        if (child.pid !== undefined) activeNativeGuardPids.delete(child.pid);
        resolveExit({ code, signal });
      };
      child.once('error', (error) => {
        this.fail(error);
        // spawn前失敗にはexit eventがない。起動済みprocessのerrorはterminate後のexitを待つ。
        if (child.pid === undefined) settle(null, null);
      });
      child.once('exit', (code, signal) => {
        this.fail(new Error(`guard exited during protocol: code=${String(code)} signal=${String(signal)}`));
        settle(code, signal);
      });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.output += chunk;
      // native読込上限64MiBのbase64とJSON metadataを有界受信する。
      if (this.output.length > 91_000_000) {
        this.fail(new Error('guard stdout overflow'));
        this.terminate();
        return;
      }
      for (;;) {
        const newline = this.output.indexOf('\n');
        if (newline < 0) break;
        const line = this.output.slice(0, newline).trimEnd();
        this.output = this.output.slice(newline + 1);
        const pending = this.pending;
        if (!pending) {
          this.fail(new Error('guard unsolicited reply'));
          this.terminate();
          return;
        }
        this.pending = null;
        clearTimeout(pending.timer);
        try {
          const value: unknown = JSON.parse(line);
          if (!isRecord(value) || typeof value.ok !== 'boolean') {
            throw new Error('guard reply schema');
          }
          pending.resolve(value as unknown as NativeGuardReply);
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error('guard reply invalid'));
          this.terminate();
        }
      }
    });
    child.stderr.resume();
  }

  static async start(): Promise<F005NativeGuardClient> {
    if (process.platform !== 'win32') {
      throw new F005SourceError('F005_PATH_UNSAFE', 'native guardはWindowsでのみ利用できます');
    }
    const executable = await resolveF005NativeGuardExecutable(process.cwd());
    let binary: Uint8Array;
    try {
      binary = new Uint8Array(await readFile(executable));
    } catch (error) {
      throw new F005SourceError('F005_PATH_UNSAFE', 'native guard executableを読み込めません', { cause: error });
    }
    if (sha256(binary) !== F005_NATIVE_GUARD_PINS.outputBinarySha256) {
      throw new F005SourceError('F005_PATH_UNSAFE', 'native guard executableの固定SHAが一致しません');
    }
    const child = spawn(executable, [], {
      cwd: dirname(executable),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new F005NativeGuardClient(child);
    try {
      const hello = await client.command({ op: 'hello' });
      if (
        hello.ok !== true ||
        hello.abi !== F005_NATIVE_GUARD_PINS.abi ||
        hello.capacityAbi !== F005_NATIVE_GUARD_PINS.capacityAbi ||
        hello.rid !== F005_NATIVE_GUARD_PINS.rid ||
        hello.runtimeVersion !== F005_NATIVE_GUARD_PINS.runtimeVersion ||
        hello.binarySha256 !== F005_NATIVE_GUARD_PINS.outputBinarySha256 ||
        hello.workingDirectoryIsExecutableDirectory !== true
      ) {
        throw new Error('guard hello pin mismatch');
      }
      return client;
    } catch (error) {
      await client.abortAndWait();
      throw new F005SourceError('F005_PATH_UNSAFE', 'native guard hello検証に失敗しました', { cause: error });
    }
  }

  get alive(): boolean {
    return !this.exited && this.child.exitCode === null && !this.child.killed;
  }

  command(value: Readonly<Record<string, unknown>>): Promise<NativeGuardReply> {
    if (!this.alive || this.pending) return Promise.reject(new Error('guard unavailable'));
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('guard IPC timeout'));
        this.terminate();
      }, 15_000);
      this.pending = { resolve: resolveReply, reject, timer };
      this.child.stdin.write(`${JSON.stringify(value)}\n`, 'utf8', (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async closeCapability(capabilityId: string): Promise<void> {
    const reply = await this.command({ op: 'close', capabilityId });
    if (!reply.ok) throw new Error(`guard close rejected: ${String(reply.error)}`);
    await this.finishAfterCapabilityConsumed();
  }

  async finishAfterCapabilityConsumed(): Promise<void> {
    this.child.stdin.end();
    const exit = await this.waitForExit();
    if (exit.code !== 0) throw new Error(`guard exit ${String(exit.code)} signal=${String(exit.signal)}`);
  }

  async abortAndWait(): Promise<void> {
    this.terminate();
    await this.waitForExit();
  }

  private terminate(): void {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (this.child.exitCode === null) this.child.kill();
  }

  private async waitForExit(): Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('guard exit timeout')), 5_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private fail(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

function guardFailure(message: string, cause?: unknown): F005SourceError {
  return new F005SourceError('F005_PATH_UNSAFE', message, cause === undefined ? undefined : { cause });
}

/**
 * 固定SHAのnative helperを起動し、hello ABI検証後にWindows handle capabilityを保持する。
 * production実装にNode fs read/rename fallbackはない。
 * @des DES-F005-001 DES-F005-006 DES-F005-011 @fun FUN-F005-043 @ut UT-F005-043
 */
export async function resolveSafeWorkspaceFile(
  rootHandle: string,
  relativePosixPath: string,
  operation: SafeFileHandle['operation'],
  expectedNativeIdentity?: F005NativeFileIdentity,
): Promise<SafeFileHandle> {
  if (!isAbsolute(rootHandle) ||
    !['read', 'rename-source', 'delete-source'].includes(operation) ||
    (expectedNativeIdentity !== undefined &&
      !NATIVE_FILE_IDENTITY.test(expectedNativeIdentity))) {
    throw guardFailure('rootまたはoperationが不正です');
  }
  safePathSegments(relativePosixPath);
  const client = await F005NativeGuardClient.start();
  const capabilityId = `cap-${process.pid}-${++nativeCapabilitySequence}`;
  try {
    const reply = await client.command({
      op: 'open',
      capabilityId,
      root: resolve(rootHandle),
      relativePath: relativePosixPath,
    });
    if (
      !reply.ok ||
      !hasExactKeys(reply, [
        'bytes',
        'capabilityId',
        'nativeIdentity',
        'ok',
        'sha256',
      ]) ||
      reply.capabilityId !== capabilityId ||
      !Number.isSafeInteger(reply.bytes) ||
      (reply.bytes as number) < 0 ||
      typeof reply.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(reply.sha256) ||
      typeof reply.nativeIdentity !== 'string' ||
      !NATIVE_FILE_IDENTITY.test(reply.nativeIdentity) ||
      (expectedNativeIdentity !== undefined &&
        reply.nativeIdentity !== expectedNativeIdentity)
    ) {
      throw new Error(`guard open rejected: ${String(reply.error)}`);
    }
    const nativeIdentity = reply.nativeIdentity as F005NativeFileIdentity;
    const [volumeSerial, fileIndex] = nativeIdentity.split(':') as [string, string];
    const fileIdentity = deepFreeze({
      dev: volumeSerial,
      ino: fileIndex,
      size: reply.bytes as number,
      mtimeMs: 0,
    });
    const capability = deepFreeze({
      __brand: 'SafeFileCapability' as const,
      relativePosixPath,
      operation,
      exists: true,
      contentSha256: reply.sha256,
      nativeIdentity,
      identity: fileIdentity,
      parentIdentity: deepFreeze({
        dev: 'native-guard',
        ino: `held-parent-${capabilityId}`,
        size: 0,
        mtimeMs: 0,
      }),
    });
    safeCapabilityState.set(capability, {
      client,
      capabilityId,
      bytes: reply.bytes as number,
      sha256: reply.sha256,
      nativeIdentity,
      active: true,
    });
    return capability;
  } catch (error) {
    await client.abortAndWait();
    throw guardFailure('native guard openに失敗しました', error);
  }
}

/** capabilityがhelper process内で保持中であることだけを確認する。 */
export async function assertSafeWorkspaceFileCapability(capability: SafeFileHandle): Promise<void> {
  const state = isRecord(capability) ? safeCapabilityState.get(capability) : undefined;
  if (!state || capability.__brand !== 'SafeFileCapability' || !state.active || !state.client.alive) {
    throw guardFailure('有効なnative SafeFile capabilityが必要です');
  }
}

/** pre-scanと後続CASをcontent SHAとnative file identityへ別々に結合する。 */
export function snapshotSafeWorkspaceFileCapability(
  capability: SafeFileHandle,
): Readonly<SafeWorkspaceFileSnapshot> {
  const state = isRecord(capability) ? safeCapabilityState.get(capability) : undefined;
  if (!state || capability.__brand !== 'SafeFileCapability' ||
    !state.active || !state.client.alive ||
    capability.contentSha256 !== state.sha256 ||
    capability.nativeIdentity !== state.nativeIdentity) {
    throw guardFailure('有効なnative SafeFile capability snapshotが必要です');
  }
  return deepFreeze({
    relativePosixPath: capability.relativePosixPath,
    byteLength: state.bytes,
    contentSha256: state.sha256,
    nativeIdentity: state.nativeIdentity,
  });
}

/** 同一native handleから一度だけreadし、SHA/bytes検証後にcloseする。 */
export async function readSafeWorkspaceFile(capability: SafeFileHandle): Promise<Uint8Array> {
  await assertSafeWorkspaceFileCapability(capability);
  const state = safeCapabilityState.get(capability)!;
  try {
    if (capability.operation !== 'read') throw guardFailure('read capabilityではありません');
    const reply = await state.client.command({ op: 'read', capabilityId: state.capabilityId });
    if (
      !reply.ok ||
      typeof reply.bodyBase64 !== 'string' ||
      reply.sha256 !== state.sha256 ||
      reply.bytes !== state.bytes
    ) {
      throw new Error(`guard read rejected: ${String(reply.error)}`);
    }
    const bytes = new Uint8Array(Buffer.from(reply.bodyBase64, 'base64'));
    if (bytes.byteLength !== state.bytes || sha256(bytes) !== state.sha256) {
      throw new Error('guard read payload mismatch');
    }
    await state.client.closeCapability(state.capabilityId);
    state.active = false;
    return bytes;
  } catch (error) {
    state.active = false;
    await state.client.abortAndWait();
    throw guardFailure('native guard read/closeに失敗しました', error);
  }
}

/** 同一native handleへSetFileInformationByHandle renameを実行してcloseする。 */
export async function renameSafeWorkspaceFile(
  capability: SafeFileHandle,
  relativeTarget: string,
  expectedNativeIdentity: F005NativeFileIdentity,
): Promise<void> {
  await assertSafeWorkspaceFileCapability(capability);
  const state = safeCapabilityState.get(capability)!;
  try {
    safePathSegments(relativeTarget);
    if (capability.operation !== 'rename-source' ||
      !NATIVE_FILE_IDENTITY.test(expectedNativeIdentity) ||
      capability.nativeIdentity !== expectedNativeIdentity ||
      state.nativeIdentity !== expectedNativeIdentity) {
      throw guardFailure('rename-source native identityが一致しません');
    }
    const reply = await state.client.command({
      op: 'rename',
      capabilityId: state.capabilityId,
      relativeTarget,
    });
    if (!reply.ok || reply.relativePath !== relativeTarget || reply.sha256 !== state.sha256) {
      throw new Error(`guard rename rejected: ${String(reply.error)}`);
    }
    await state.client.closeCapability(state.capabilityId);
    state.active = false;
  } catch (error) {
    state.active = false;
    await state.client.abortAndWait();
    throw guardFailure('native guard rename/closeに失敗しました', error);
  }
}

/**
 * open時からwrite/delete共有を拒否した同一native handleのidentityとSHAを再検証し、
 * FileDispositionInfoでそのidentityだけをdelete-pendingにしてhandleをcloseする。
 * path名へのunlink fallbackは持たない。
 * @des DES-F005-006 DES-F005-011 @fun FUN-F005-043 @ut UT-F005-043
 */
export async function deleteSafeWorkspaceFile(
  capability: SafeFileHandle,
  expectedNativeIdentity: F005NativeFileIdentity,
): Promise<void> {
  await assertSafeWorkspaceFileCapability(capability);
  const state = safeCapabilityState.get(capability)!;
  try {
    if (capability.operation !== 'delete-source' ||
      !NATIVE_FILE_IDENTITY.test(expectedNativeIdentity) ||
      capability.nativeIdentity !== expectedNativeIdentity ||
      state.nativeIdentity !== expectedNativeIdentity) {
      throw guardFailure('delete-source native identityが一致しません');
    }
    const reply = await state.client.command({
      op: 'delete',
      capabilityId: state.capabilityId,
    });
    if (!reply.ok ||
      !hasExactKeys(reply, ['capabilityId', 'ok', 'relativePath', 'sha256']) ||
      reply.capabilityId !== state.capabilityId ||
      reply.relativePath !== capability.relativePosixPath ||
      reply.sha256 !== state.sha256) {
      throw new Error(`guard delete rejected: ${String(reply.error)}`);
    }
    state.active = false;
    await state.client.finishAfterCapabilityConsumed();
  } catch (error) {
    state.active = false;
    await state.client.abortAndWait();
    throw guardFailure('native guard identity deleteに失敗しました', error);
  }
}

/** caller側finally用。未使用capabilityもnative closeとhelper exit完了まで待つ。 */
export async function closeSafeWorkspaceFile(capability: SafeFileHandle): Promise<void> {
  const state = isRecord(capability) ? safeCapabilityState.get(capability) : undefined;
  if (!state || capability.__brand !== 'SafeFileCapability') {
    throw guardFailure('mint済みSafeFile capabilityが必要です');
  }
  if (!state.active) return;
  state.active = false;
  try {
    await state.client.closeCapability(state.capabilityId);
  } catch (error) {
    await state.client.abortAndWait();
    throw guardFailure('native guard cleanupに失敗しました', error);
  }
}

/** native helperのexit待機を検証するtest専用oracle。 */
export function getF005NativeGuardProcessCountForTest(): number {
  if (process.env.NODE_ENV !== 'test') {
    throw guardFailure('native guard process oracleはtest専用です');
  }
  return activeNativeGuardPids.size;
}

async function ensureSafeDirectoryTree(rootHandle: string, relativePosixDirectory: string): Promise<void> {
  const root = resolve(rootHandle);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new F005SourceError('F005_PATH_UNSAFE', 'artifact rootが不正です');
  }
  let cursor = root;
  for (const segment of safePathSegments(relativePosixDirectory)) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(cursor) !== cursor) {
        throw new F005SourceError('F005_PATH_UNSAFE', 'artifact directoryにreparseがあります');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(cursor);
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink() || await realpath(cursor) !== cursor) {
        throw new F005SourceError('F005_PATH_UNSAFE', 'artifact directory作成後検査に失敗しました');
      }
    }
  }
}

/** DD-F005のABI/toolchain pinと実binary bytesを自己申告hashに依存せず検証する。 */
export function verifyF005NativeGuardBuildEvidence(
  evidence: F005NativeGuardBuildEvidence,
  inputs: F005NativeGuardBuildInputs,
): Readonly<F005NativeGuardBuildEvidence> {
  if (
    !isRecord(evidence) ||
    Object.keys(evidence).sort().join(',') !==
      'abi,apphostSha256,capacityAbi,globalJsonSha256,outputBinarySha256,outputBytes,programSha256,projectSha256,rid,runtimeVersion,runtimeZipSha512,schemaVersion,sdkVersion,sdkZipSha512' ||
    evidence.schemaVersion !== '1.0.0' ||
    inputs.apphost.byteLength === 0 ||
    inputs.outputBinary.byteLength === 0 ||
    evidence.abi !== F005_NATIVE_GUARD_PINS.abi ||
    evidence.capacityAbi !== F005_NATIVE_GUARD_PINS.capacityAbi ||
    evidence.rid !== F005_NATIVE_GUARD_PINS.rid ||
    evidence.sdkVersion !== F005_NATIVE_GUARD_PINS.sdkVersion ||
    evidence.runtimeVersion !== F005_NATIVE_GUARD_PINS.runtimeVersion ||
    evidence.sdkZipSha512 !== F005_NATIVE_GUARD_PINS.sdkZipSha512 ||
    evidence.runtimeZipSha512 !== F005_NATIVE_GUARD_PINS.runtimeZipSha512 ||
    evidence.programSha256 !== sha256(inputs.program) ||
    evidence.projectSha256 !== sha256(inputs.project) ||
    evidence.globalJsonSha256 !== sha256(inputs.globalJson) ||
    evidence.apphostSha256 !== sha256(inputs.apphost) ||
    evidence.outputBinarySha256 !== sha256(inputs.outputBinary) ||
    evidence.outputBytes !== inputs.outputBinary.byteLength
  ) {
    throw new F005SourceError('F005_PATH_UNSAFE', 'native guard ABI/toolchain/binary pinが一致しません');
  }
  return deepFreeze(structuredClone(evidence));
}
