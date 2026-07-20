import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { inflateRawSync } from 'node:zlib';
import { validateBatchManifest, type BatchManifest } from './batch.ts';

export const MAX_SOURCE_BYTES = 8_388_608;
export const AOZORA_TIMEOUT_MS = 15_000;
export const AOZORA_ORIGIN = 'https://www.aozora.gr.jp';
export const AOZORA_BIBLIOGRAPHY_URL = `${AOZORA_ORIGIN}/index_pages/list_person_all_extended_utf8.zip`;
export const AOZORA_BIBLIOGRAPHY_ENTRY = 'list_person_all_extended_utf8.csv';
export const AOZORA_USER_AGENT = 'bungo-zundamon/0.1 (ProjectFactory content fetcher)' as const;
export const MAX_BIBLIOGRAPHY_ARCHIVE_BYTES = 8_388_608;
export const MAX_BIBLIOGRAPHY_CSV_BYTES = 33_554_432;
export const MAX_BIBLIOGRAPHY_EXPANSION_RATIO = 20;
export const TARGET_PERSON_ID = '000879';
export const TARGET_TITLES = ['羅生門', '蜘蛛の糸', '杜子春'] as const;
export const INITIAL_WORK_IDS = ['000127', '000092', '043015'] as const;
export const INITIAL_WORK_SOURCE_URLS: Readonly<Record<(typeof INITIAL_WORK_IDS)[number], string>> = Object.freeze({
  '000127': `${AOZORA_ORIGIN}/cards/${TARGET_PERSON_ID}/files/127_15260.html`,
  '000092': `${AOZORA_ORIGIN}/cards/${TARGET_PERSON_ID}/files/92_14545.html`,
  '043015': `${AOZORA_ORIGIN}/cards/${TARGET_PERSON_ID}/files/43015_17432.html`,
});
export const INITIAL_WORK_CARD_URLS: Readonly<Record<(typeof INITIAL_WORK_IDS)[number], string>> = Object.freeze({
  '000127': `${AOZORA_ORIGIN}/cards/${TARGET_PERSON_ID}/card127.html`,
  '000092': `${AOZORA_ORIGIN}/cards/${TARGET_PERSON_ID}/card92.html`,
  '043015': `${AOZORA_ORIGIN}/cards/${TARGET_PERSON_ID}/card43015.html`,
});
export const INITIAL_EDITION_RULES: readonly EditionRule[] = Object.freeze([
  { title: '羅生門', preferredWorkId: '000127', allowedWorkIds: ['000127'], reason: '初期公開の固定版' },
  { title: '蜘蛛の糸', preferredWorkId: '000092', allowedWorkIds: ['000092'], reason: '初期公開の固定版' },
  { title: '杜子春', preferredWorkId: '043015', allowedWorkIds: ['043015'], reason: '新字新仮名版（図書カードNo.43015）' },
]);
export const AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS = Object.freeze([
  '作品ID',
  '作品名',
  '文字遣い種別',
  '作品著作権フラグ',
  '図書カードURL',
  '人物ID',
  '人物著作権フラグ',
  '役割フラグ',
  '底本名1',
  '入力者',
  '校正者',
  'XHTML/HTMLファイルURL',
  'XHTML/HTMLファイル符号化方式',
  'XHTML/HTMLファイル文字集合',
] as const);

export type Charset = 'Shift_JIS' | 'UTF-8';

export interface BibliographyRow {
  workId: string;
  title: string;
  personId: string;
  role: string;
  copyright: string;
  status: string;
  language: string;
  sourceUrl: string;
  charset: Charset | string | null;
  cardUrl?: string;
  baseEdition?: string;
  inputter?: string;
  proofreader?: string;
  edition?: string;
  /** 公式拡充CSVの人物著作権フラグ。F002 batch選定では必須。 */
  personCopyright?: string;
  /** 公式拡充CSVの文字遣い種別。F002 batch選定では新字新仮名だけを許可する。 */
  orthography?: string;
}

export interface SelectionDiagnostic {
  row: number;
  code: 'MISSING_FIELD' | 'UNKNOWN_ROLE' | 'UNKNOWN_COPYRIGHT' | 'UNKNOWN_STATUS' | 'UNKNOWN_LANGUAGE';
  field: keyof BibliographyRow;
  value?: string;
}

export interface WorkCandidate extends BibliographyRow {
  charset: Charset | null;
}

export interface EditionRule {
  title: string;
  preferredWorkId: string;
  fallbackWorkIds?: readonly string[];
  allowedWorkIds: readonly string[];
  reason: string;
}

export interface SelectedWork extends WorkCandidate {
  selectionReason: string;
}

export interface BatchSelectionManifest extends BatchManifest {
  readonly editionRules: readonly EditionRule[];
}

export interface BibliographyObservationInput {
  readonly sha256?: string;
  readonly fetchedAt?: string;
}

export interface WorkRightsEntry {
  readonly workId: string;
  readonly title: string;
  readonly personId: string;
  readonly personCopyright: string;
  readonly workCopyright: string;
  readonly role: string;
  readonly translatorPresent: false;
  readonly status: string;
  readonly orthography: string;
  readonly cardUrl: string;
  readonly sourceUrl: string;
}

export interface WorkRightsObservation {
  readonly phase: 'selection' | 'predeploy';
  readonly bibliographySha256: string;
  readonly observedAt: string;
  readonly releaseCommit?: string;
  readonly runId?: string;
  readonly works: readonly WorkRightsEntry[];
}

export interface SelectedWorkResult {
  readonly works: readonly SelectedWork[];
  readonly observation: WorkRightsObservation;
}

export interface WorkRightsDecision {
  readonly result: 'unchanged' | 'blocked';
  readonly releaseCommit: string;
  readonly runId: string;
  readonly selection: WorkRightsObservation;
  readonly predeploy?: WorkRightsObservation;
  readonly reasons: readonly string[];
}

export interface SourceRecord {
  workId: string;
  rawPath: string;
  rawSha256: string;
  mediaType: string;
  httpCharset: Charset | null;
  bibliographyCharset: Charset | null;
  fetchedAt: string;
  sourceUrl: string;
}

export interface DecodedSource {
  workId: string;
  rawSha256: string;
  httpCharset: Charset | null;
  metaCharset: Charset | null;
  bibliographyCharset: Charset | null;
  adoptedCharset: Charset;
  text: string;
}

export interface AozoraMetadata {
  stableCardUrl: string;
  baseEdition: string;
  inputter: string;
  proofreader: string;
  toolVersion: string;
  transformation: string;
  changeNotice: string;
  sourceSha256: string;
}

export interface Provenance {
  workId: string;
  stableCardUrl: string;
  sourceUrl: string;
  sourceSha256: string;
  fetchedAt: string;
  baseEdition: string;
  inputter: string;
  proofreader: string;
  toolVersion: string;
  transformation: string;
  changeNotice: string;
  bibliography: BibliographyProvenance;
}

export interface BibliographySnapshot {
  sourceUrl: string;
  archivePath: string;
  archiveSha256: string;
  archiveBytes: number;
  csvPath: string;
  csvEntry: string;
  csvSha256: string;
  csvBytes: number;
  mediaType: string;
  fetchedAt: string;
  schemaVersion: string;
}

export interface BibliographyProvenance {
  sourceUrl: string;
  archiveSha256: string;
  archiveBytes: number;
  csvEntry: string;
  csvSha256: string;
  csvBytes: number;
  schemaVersion: string;
}

export interface TransportResponse {
  status: number;
  headers: Headers | Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
  elapsedMs?: number;
  fetchedAt?: string;
}

export interface TransportPolicy {
  pathPrefix: string;
  allowedMediaTypes: readonly string[];
  maxBytes: number;
  timeoutMs: number;
}

export interface AozoraTransport {
  request(url: URL, policy: TransportPolicy): Promise<TransportResponse>;
}

export interface ResolvedAddress {
  address: string;
  family?: 4 | 6;
}

export interface PinnedRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  hostHeader: string;
  serverName: string;
  rejectUnauthorized: true;
  checkServerIdentity: true;
  followRedirects: false;
  useEnvironmentProxy: false;
  signal: AbortSignal;
  maxBytes: number;
  userAgent: typeof AOZORA_USER_AGENT;
}

export interface ProductionAozoraTransportOptions {
  resolver?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  pinnedSocketFactory?: (request: PinnedRequest) => Promise<TransportResponse>;
  clock?: () => number;
}

export interface ArtifactOptions {
  workspaceRoot?: string;
  clock?: () => Date;
}

export interface SourceFetchOptions extends ArtifactOptions {
  transport: ProductionAozoraTransport;
  /** 省略時はF001固定3作品。F002以降は検証済みmanifest/selectionから明示供給する。 */
  allowlist?: WorkSourceAllowlist;
}

export interface WorkSourceAllowlist {
  readonly authorId: string;
  readonly works: Readonly<Record<string, Readonly<{ sourceUrl: string; cardUrl: string }>>>;
}

export interface BibliographyFetchOptions extends ArtifactOptions {
  schemaValidator?: (raw: Uint8Array, mediaType: string) => string;
}

export class SourcePipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SourcePipelineError';
  }
}

const ELIGIBLE_ROLE = new Set(['著者', 'author']);
const KNOWN_ROLES = new Set([...ELIGIBLE_ROLE, '翻訳者', 'translator', '編者', 'editor']);
const ELIGIBLE_COPYRIGHT = new Set(['なし', '著作権なし', 'expired', 'public-domain']);
const KNOWN_COPYRIGHT = new Set([...ELIGIBLE_COPYRIGHT, 'あり', '著作権あり', 'copyrighted', 'afterlife']);
const ELIGIBLE_STATUS = new Set(['公開中', 'published', 'public']);
const KNOWN_STATUS = new Set([...ELIGIBLE_STATUS, '非公開', 'unpublished', 'withdrawn']);
const ELIGIBLE_LANGUAGE = new Set(['日本語原著', 'japanese-original']);
const KNOWN_LANGUAGE = new Set([...ELIGIBLE_LANGUAGE, '翻訳', 'translation']);
const INITIAL_WORK_ID_SET = new Set<string>(INITIAL_WORK_IDS);
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const NON_PUBLIC_IPV6 = new BlockList();

// IPv4-compatible/mapped、変換用、IETF予約、ULA、link-local、multicastを
// DNS pin先として拒否する。A/AAAAのいずれでもprivate addressへの到達を許さない。
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6');
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeEnum(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCharset(value: string | null | undefined): Charset | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  if (normalized === 'utf-8' || normalized === 'utf8') return 'UTF-8';
  if (
    normalized === 'shift-jis' ||
    normalized === 'shiftjis' ||
    normalized === 'sjis' ||
    normalized === 'windows-31j' ||
    normalized === 'cp932'
  ) {
    return 'Shift_JIS';
  }
  throw new SourcePipelineError('CHARSET_NOT_ALLOWED', `許可されていないcharsetです: ${value}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** @des DES-F001-003 @fun FUN-F001-005 */
export function selectEligibleWorks(
  rows: readonly BibliographyRow[],
  diagnostics: SelectionDiagnostic[] = [],
): WorkCandidate[] {
  const candidates: Array<WorkCandidate & { readonly inputOrder: number }> = [];

  rows.forEach((row, inputOrder) => {
    const required: Array<keyof BibliographyRow> = [
      'workId', 'title', 'personId', 'role', 'copyright', 'status', 'language', 'sourceUrl',
    ];
    const missing = required.find((field) => !nonBlank(row[field]));
    if (missing) {
      diagnostics.push({ row: inputOrder, code: 'MISSING_FIELD', field: missing });
      return;
    }

    const role = normalizeEnum(row.role);
    const copyright = normalizeEnum(row.copyright);
    const status = normalizeEnum(row.status);
    const language = normalizeEnum(row.language);
    const enumChecks: Array<[boolean, SelectionDiagnostic['code'], keyof BibliographyRow, string]> = [
      [KNOWN_ROLES.has(role), 'UNKNOWN_ROLE', 'role', row.role],
      [KNOWN_COPYRIGHT.has(copyright), 'UNKNOWN_COPYRIGHT', 'copyright', row.copyright],
      [KNOWN_STATUS.has(status), 'UNKNOWN_STATUS', 'status', row.status],
      [KNOWN_LANGUAGE.has(language), 'UNKNOWN_LANGUAGE', 'language', row.language],
    ];
    const invalid = enumChecks.find(([known]) => !known);
    if (invalid) {
      diagnostics.push({ row: inputOrder, code: invalid[1], field: invalid[2], value: invalid[3] });
      return;
    }

    if (
      row.personId === TARGET_PERSON_ID &&
      ELIGIBLE_ROLE.has(role) &&
      ELIGIBLE_COPYRIGHT.has(copyright) &&
      ELIGIBLE_STATUS.has(status) &&
      ELIGIBLE_LANGUAGE.has(language)
    ) {
      let charset: Charset | null;
      try {
        charset = normalizeCharset(row.charset);
      } catch {
        diagnostics.push({ row: inputOrder, code: 'MISSING_FIELD', field: 'charset', value: String(row.charset) });
        return;
      }
      candidates.push({ ...row, charset, inputOrder });
    }
  });

  candidates.sort((left, right) => left.workId.localeCompare(right.workId, 'ja') || left.inputOrder - right.inputOrder);
  if (candidates.length === 0) {
    throw new SourcePipelineError('NO_ELIGIBLE_WORKS', '適格な青空文庫作品が0件です', diagnostics);
  }
  return candidates.map(({ inputOrder, ...candidate }) => {
    void inputOrder;
    return candidate;
  });
}

/** @des DES-F001-003 @fun FUN-F001-006 */
export function resolveEdition(
  candidates: readonly WorkCandidate[],
  rules: readonly EditionRule[],
): SelectedWork[] {
  if (rules.length !== TARGET_TITLES.length) {
    throw new SourcePipelineError('EDITION_RULE_COUNT', '対象3作品すべての版規則が必要です');
  }
  const candidateById = new Map<string, WorkCandidate>();
  for (const candidate of candidates) {
    if (candidateById.has(candidate.workId)) {
      throw new SourcePipelineError('DUPLICATE_WORK_ID', `候補作品IDが重複しています: ${candidate.workId}`);
    }
    candidateById.set(candidate.workId, candidate);
  }

  const seenTitles = new Set<string>();
  const allRuleIds = new Set<string>();
  const selectedIds = new Set<string>();
  const selected: SelectedWork[] = [];
  for (const expectedTitle of TARGET_TITLES) {
    const rule = rules.find((item) => item.title === expectedTitle);
    if (!rule || seenTitles.has(rule.title) || !nonBlank(rule.reason)) {
      throw new SourcePipelineError('INVALID_EDITION_RULE', `版規則が不正です: ${expectedTitle}`);
    }
    seenTitles.add(rule.title);
    if (!nonBlank(rule.preferredWorkId) || rule.allowedWorkIds.length === 0) {
      throw new SourcePipelineError('TITLE_ONLY_EDITION_RULE', '作品IDを明記しないタイトル一致規則は禁止です');
    }
    const order = [rule.preferredWorkId, ...(rule.fallbackWorkIds ?? [])];
    if (new Set(order).size !== order.length || new Set(rule.allowedWorkIds).size !== rule.allowedWorkIds.length) {
      throw new SourcePipelineError('DUPLICATE_EDITION_ID', `版規則内の作品IDが重複しています: ${rule.title}`);
    }
    for (const id of rule.allowedWorkIds) {
      if (!INITIAL_WORK_ID_SET.has(id)) {
        throw new SourcePipelineError('WORK_NOT_ALLOWED', `初期3作品の固定allowlist外です: ${id}`);
      }
    }
    for (const id of order) {
      if (!INITIAL_WORK_ID_SET.has(id)) {
        throw new SourcePipelineError('WORK_NOT_ALLOWED', `初期3作品の固定allowlist外です: ${id}`);
      }
      if (!rule.allowedWorkIds.includes(id)) {
        throw new SourcePipelineError('WORK_NOT_ALLOWED', `allowlist外の作品IDです: ${id}`);
      }
      if (allRuleIds.has(id)) {
        throw new SourcePipelineError('DUPLICATE_EDITION_ID', `複数規則で作品IDが重複しています: ${id}`);
      }
      allRuleIds.add(id);
    }
    const candidate = order.map((id) => candidateById.get(id)).find((item): item is WorkCandidate => item !== undefined);
    if (!candidate) {
      throw new SourcePipelineError('EDITION_NOT_FOUND', `採用可能な版がありません: ${rule.title}`);
    }
    if (candidate.title !== rule.title) {
      throw new SourcePipelineError('TITLE_ID_MISMATCH', `作品IDと対象タイトルが一致しません: ${candidate.workId}`);
    }
    if (selectedIds.has(candidate.workId)) {
      throw new SourcePipelineError('DUPLICATE_SELECTED_WORK', `同一版が複数作品に採用されました: ${candidate.workId}`);
    }
    selectedIds.add(candidate.workId);
    selected.push({ ...candidate, selectionReason: rule.reason.trim() });
  }
  return selected;
}

function assertRfc3339(value: string, code: string): void {
  if (!nonBlank(value) || !Number.isFinite(Date.parse(value))) {
    throw new SourcePipelineError(code, '観測時刻は有効なRFC 3339日時で指定してください');
  }
}

function assertBatchWorkUrl(row: BibliographyRow, authorId: string): void {
  if (!nonBlank(row.cardUrl)) {
    throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `図書カードURLがありません: ${row.workId}`);
  }
  let source: URL;
  let card: URL;
  try {
    source = new URL(row.sourceUrl);
    card = new URL(row.cardUrl);
  } catch {
    throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `作品URLが不正です: ${row.workId}`);
  }
  validateAozoraUrl(source, `/cards/${authorId}/files/`);
  validateAozoraUrl(card, `/cards/${authorId}/`);
  const numericId = row.workId.replace(/^0+/u, '') || '0';
  const escapedId = numericId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (
    !new RegExp(`^/cards/${authorId}/card0*${escapedId}\\.html$`, 'u').test(card.pathname) ||
    !new RegExp(`^/cards/${authorId}/files/0*${escapedId}(?:_|\\.)`, 'u').test(source.pathname)
  ) {
    throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `作品IDと公式URLが一致しません: ${row.workId}`);
  }
}

function canonicalRightsRows(rows: readonly BibliographyRow[]): Uint8Array {
  const normalized = rows.map((row) => ({
    workId: row.workId,
    title: row.title,
    personId: row.personId,
    personCopyright: row.personCopyright ?? '',
    role: row.role,
    copyright: row.copyright,
    status: row.status,
    language: row.language,
    orthography: row.orthography ?? '',
    sourceUrl: row.sourceUrl,
    cardUrl: row.cardUrl ?? '',
    charset: row.charset,
    edition: row.edition ?? '',
  }));
  return new TextEncoder().encode(JSON.stringify(normalized));
}

/**
 * BatchManifestのauthor/work/edition ruleだけをallowlistとして公式書誌を選定する。
 * 固定titleや暗黙のF001 allowlistへfallbackしない。
 * @des DES-F002-004 DES-F002-009 @fun FUN-F002-006
 */
export function selectBatchWorks(
  rows: readonly BibliographyRow[],
  manifest: BatchSelectionManifest,
  observedAt: Date,
  bibliography: BibliographyObservationInput = {},
): SelectedWorkResult {
  const manifestValidation = validateBatchManifest(manifest);
  if (!manifestValidation.ok) {
    throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `検証済みBatchManifestが必要です: ${manifestValidation.error.code}`);
  }
  const authorId = manifest.author?.authorId;
  if (!nonBlank(authorId) || !/^[0-9]{6}$/u.test(authorId)) {
    throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', 'manifestのauthor IDが不正です');
  }
  if (
    manifest.workIds.length !== 3 ||
    new Set(manifest.workIds).size !== manifest.workIds.length ||
    manifest.workIds.some((id) => !/^[0-9]{6}$/u.test(id))
  ) {
    throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', 'manifestには一意な6桁作品IDを3件指定してください');
  }
  if (manifest.editionRules.length !== manifest.workIds.length) {
    throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', 'manifestの作品と版規則の件数が一致しません');
  }
  if (!Number.isFinite(observedAt.getTime())) {
    throw new SourcePipelineError('WORK_RIGHTS_OBSERVATION_STALE', '観測時刻が不正です');
  }
  const observedAtIso = observedAt.toISOString();
  assertRfc3339(observedAtIso, 'WORK_RIGHTS_OBSERVATION_STALE');

  const allowedIds = new Set<string>(manifest.workIds);
  const ruleIds = new Set<string>();
  for (const rule of manifest.editionRules) {
    const orderedIds = [rule.preferredWorkId, ...(rule.fallbackWorkIds ?? [])];
    if (
      !nonBlank(rule.title) || !nonBlank(rule.reason) || rule.allowedWorkIds.length === 0 ||
      !rule.allowedWorkIds.includes(rule.preferredWorkId) ||
      new Set(rule.allowedWorkIds).size !== rule.allowedWorkIds.length ||
      new Set(orderedIds).size !== orderedIds.length ||
      orderedIds.some((id) => !rule.allowedWorkIds.includes(id)) ||
      rule.allowedWorkIds.some((id) => !allowedIds.has(id))
    ) {
      throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `manifestの版規則が不正です: ${rule.title}`);
    }
    for (const id of rule.allowedWorkIds) {
      if (ruleIds.has(id)) {
        throw new SourcePipelineError('WORK_EDITION_AMBIGUOUS', `作品IDが複数の版規則に含まれます: ${id}`);
      }
      ruleIds.add(id);
    }
  }
  if (ruleIds.size !== allowedIds.size || [...allowedIds].some((id) => !ruleIds.has(id))) {
    throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', 'manifest作品allowlistと版規則が一致しません');
  }

  const selected: SelectedWork[] = [];
  const rights: WorkRightsEntry[] = [];
  for (const workId of manifest.workIds) {
    const rule = manifest.editionRules.find((item) => item.allowedWorkIds.includes(workId));
    if (!rule) throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `版規則がありません: ${workId}`);
    const workRows = rows.filter((row) => row.workId === workId);
    if (workRows.length === 0) {
      throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `公式書誌にmanifest作品がありません: ${workId}`);
    }
    if (workRows.some((row) => ['翻訳者', 'translator'].includes(normalizeEnum(row.role)))) {
      throw new SourcePipelineError('WORK_TRANSLATOR_PRESENT', `翻訳者を持つ作品は選定できません: ${workId}`);
    }
    const authorRows = workRows.filter((row) => row.personId === authorId);
    if (workRows.some((row) => ELIGIBLE_ROLE.has(normalizeEnum(row.role)) && row.personId !== authorId)) {
      throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `同一作品IDにmanifest外作者の著者行があります: ${workId}`);
    }
    if (authorRows.length === 0) {
      throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `manifest作者と書誌人物IDが一致しません: ${workId}`);
    }
    if (authorRows.some((row) => !ELIGIBLE_ROLE.has(normalizeEnum(row.role)))) {
      throw new SourcePipelineError('WORK_ROLE_INVALID', `著者以外の役割を含みます: ${workId}`);
    }
    if (authorRows.length !== 1) {
      throw new SourcePipelineError('WORK_EDITION_AMBIGUOUS', `同順位の版が複数あります: ${workId}`);
    }
    const row = authorRows[0];
    if (!row) throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `書誌行がありません: ${workId}`);
    if (row.title !== rule.title) {
      throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', `作品IDと版規則のtitleが一致しません: ${workId}`);
    }
    if (
      !nonBlank(row.personCopyright) || !ELIGIBLE_COPYRIGHT.has(normalizeEnum(row.personCopyright)) ||
      !ELIGIBLE_COPYRIGHT.has(normalizeEnum(row.copyright)) ||
      !ELIGIBLE_STATUS.has(normalizeEnum(row.status)) ||
      !ELIGIBLE_LANGUAGE.has(normalizeEnum(row.language)) ||
      row.orthography?.trim() !== '新字新仮名'
    ) {
      throw new SourcePipelineError('WORK_RIGHTS_INELIGIBLE', `作品の権利・公開・文字遣い条件を満たしません: ${workId}`);
    }
    assertBatchWorkUrl(row, authorId);
    let charset: Charset | null;
    try {
      charset = normalizeCharset(row.charset);
    } catch {
      throw new SourcePipelineError('WORK_RIGHTS_INELIGIBLE', `作品のcharsetが不正です: ${workId}`);
    }
    const selectedWork: SelectedWork = { ...row, charset, selectionReason: rule.reason.trim() };
    selected.push(selectedWork);
    rights.push(Object.freeze({
      workId,
      title: row.title,
      personId: authorId,
      personCopyright: row.personCopyright.trim(),
      workCopyright: row.copyright.trim(),
      role: row.role.trim(),
      translatorPresent: false,
      status: row.status.trim(),
      orthography: row.orthography.trim(),
      cardUrl: row.cardUrl!.trim(),
      sourceUrl: row.sourceUrl.trim(),
    }));
  }
  const bibliographySha256 = bibliography.sha256 ?? sha256(canonicalRightsRows(rows));
  if (!/^[a-f0-9]{64}$/u.test(bibliographySha256)) {
    throw new SourcePipelineError('WORK_ALLOWLIST_MISMATCH', '公式書誌SHA-256が不正です');
  }
  return Object.freeze({
    works: Object.freeze(selected),
    observation: Object.freeze({
      phase: 'selection' as const,
      bibliographySha256,
      observedAt: observedAtIso,
      works: Object.freeze(rights),
    }),
  });
}

function rightsComparable(observation: WorkRightsObservation): string {
  return JSON.stringify({ bibliographySha256: observation.bibliographySha256, works: observation.works });
}

function validSelectionObservation(selection: WorkRightsObservation, manifest: BatchSelectionManifest): boolean {
  if (
    selection.phase !== 'selection' || selection.releaseCommit !== undefined || selection.runId !== undefined ||
    !SHA256_HEX.test(selection.bibliographySha256) || !Number.isFinite(Date.parse(selection.observedAt)) ||
    selection.works.length !== manifest.workIds.length
  ) return false;
  return selection.works.every((work, index) => {
    const expectedId = manifest.workIds[index];
    if (
      work.workId !== expectedId || work.personId !== manifest.author.authorId || !work.title.trim() ||
      !ELIGIBLE_COPYRIGHT.has(normalizeEnum(work.personCopyright)) ||
      !ELIGIBLE_COPYRIGHT.has(normalizeEnum(work.workCopyright)) ||
      !ELIGIBLE_ROLE.has(normalizeEnum(work.role)) || work.translatorPresent !== false ||
      !ELIGIBLE_STATUS.has(normalizeEnum(work.status)) || work.orthography !== '新字新仮名'
    ) return false;
    try {
      assertBatchWorkUrl({
        workId: work.workId, title: work.title, personId: work.personId, role: work.role,
        copyright: work.workCopyright, personCopyright: work.personCopyright, status: work.status,
        language: '日本語原著', orthography: work.orthography, sourceUrl: work.sourceUrl,
        cardUrl: work.cardUrl, charset: 'UTF-8',
      }, manifest.author.authorId);
      return true;
    } catch {
      return false;
    }
  });
}

/** @des DES-F002-004 DES-F002-009 DES-F002-016 @fun FUN-F002-036 */
export async function revalidateWorkRights(
  manifest: BatchSelectionManifest,
  releaseCommit: string,
  runId: string,
  transport: ProductionAozoraTransport,
  selection: WorkRightsObservation,
): Promise<WorkRightsDecision> {
  if (!/^[a-f0-9]{40}$/u.test(releaseCommit)) {
    throw new SourcePipelineError('WORK_RIGHTS_COMMIT_MISMATCH', 'release commitがありません');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId)) {
    throw new SourcePipelineError('WORK_RIGHTS_OBSERVATION_STALE', 'release判定run IDがありません');
  }
  if (!(transport instanceof ProductionAozoraTransport)) {
    throw new SourcePipelineError('WORK_RIGHTS_PREDEPLOY_MISSING', 'deploy直前再検査にはProductionAozoraTransportが必要です');
  }
  if (!selection || selection.phase !== 'selection') {
    throw new SourcePipelineError('WORK_RIGHTS_SELECTION_MISSING', '選定時の作品権利観測がありません');
  }
  if (selection.releaseCommit !== undefined || selection.runId !== undefined) {
    return Object.freeze({
      result: 'blocked', releaseCommit, runId, selection,
      reasons: Object.freeze(['WORK_RIGHTS_OBSERVATION_STALE']),
    });
  }
  if (!validSelectionObservation(selection, manifest)) {
    return Object.freeze({
      result: 'blocked', releaseCommit, runId, selection,
      reasons: Object.freeze(['WORK_RIGHTS_SELECTION_MISSING']),
    });
  }

  let response: TransportResponse;
  let csv: Uint8Array;
  try {
    const policy: TransportPolicy = {
      pathPrefix: '/index_pages/',
      allowedMediaTypes: ['application/zip'],
      maxBytes: MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
      timeoutMs: AOZORA_TIMEOUT_MS,
    };
    response = await transport.request(new URL(AOZORA_BIBLIOGRAPHY_URL), policy);
    if (response.elapsedMs !== undefined && response.elapsedMs >= AOZORA_TIMEOUT_MS) {
      throw new SourcePipelineError('FETCH_TIMEOUT', '取得がtimeoutしました');
    }
    validateResponse(response, policy);
    csv = extractVerifiedBibliographyCsv(response.body);
  } catch (error) {
    throw new SourcePipelineError('WORK_RIGHTS_PREDEPLOY_MISSING', 'deploy直前の公式書誌を取得・検証できません', {
      causeCode: error instanceof SourcePipelineError ? error.code : 'UNKNOWN',
    });
  }
  const observedAt = response.fetchedAt ? new Date(response.fetchedAt) : new Date();
  if (!Number.isFinite(observedAt.getTime())) {
    throw new SourcePipelineError('WORK_RIGHTS_PREDEPLOY_MISSING', 'deploy直前観測時刻が不正です');
  }
  let selected: SelectedWorkResult;
  try {
    selected = selectBatchWorks(parseAozoraBibliography(csv), manifest, observedAt, { sha256: sha256(csv) });
  } catch (error) {
    if (error instanceof SourcePipelineError) {
      return Object.freeze({
        result: 'blocked', releaseCommit, runId, selection,
        reasons: Object.freeze(['WORK_RIGHTS_CHANGED']),
      });
    }
    throw error;
  }
  const predeploy: WorkRightsObservation = Object.freeze({
    ...selected.observation,
    phase: 'predeploy',
    releaseCommit,
    runId,
  });
  const reasons = rightsComparable(selection) === rightsComparable(predeploy)
    ? []
    : ['WORK_RIGHTS_CHANGED'];
  return Object.freeze({
    result: reasons.length === 0 ? 'unchanged' : 'blocked',
    releaseCommit,
    runId,
    selection,
    predeploy,
    reasons: Object.freeze(reasons),
  });
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0, c = 0] = parts;
  if (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  ) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  return !NON_PUBLIC_IPV6.check(normalized, 'ipv6');
}

function validateAozoraUrl(url: URL, pathPrefix: string): void {
  const pathMatches = pathPrefix.endsWith('/')
    ? url.pathname.startsWith(pathPrefix)
    : url.pathname === pathPrefix || url.pathname.startsWith(`${pathPrefix}/`);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.aozora.gr.jp' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    /%2e|%2f|%5c/iu.test(url.pathname) ||
    url.pathname.includes('\\') ||
    !pathMatches
  ) {
    throw new SourcePipelineError('UNTRUSTED_AOZORA_URL', `許可されていない青空文庫URLです: ${url.href}`);
  }
}

/** @des DES-F001-003 DES-F001-019 @fun FUN-F001-006 FUN-F001-007 */
export function assertInitialWorkId(workId: string): asserts workId is (typeof INITIAL_WORK_IDS)[number] {
  if (!/^[0-9]{6}$/u.test(workId) || !INITIAL_WORK_ID_SET.has(workId)) {
    throw new SourcePipelineError('WORK_NOT_ALLOWED', `初期3作品の固定allowlist外です: ${workId}`);
  }
  if (workId === '.' || workId === '..' || workId.includes('/') || workId.includes('\\')) {
    throw new SourcePipelineError('INVALID_WORK_PATH', '作品IDは単一path componentで指定してください');
  }
}

/** @des DES-F001-003 DES-F001-004 @fun FUN-F001-006 FUN-F001-007 */
export function assertInitialWorkSource(work: Pick<SelectedWork, 'workId' | 'sourceUrl' | 'cardUrl'>): void {
  assertInitialWorkId(work.workId);
  const expectedSource = INITIAL_WORK_SOURCE_URLS[work.workId];
  const expectedCard = INITIAL_WORK_CARD_URLS[work.workId];
  if (work.sourceUrl !== expectedSource) {
    throw new SourcePipelineError('SOURCE_URL_MISMATCH', `作品IDに対応する固定XHTML URLではありません: ${work.workId}`);
  }
  if (work.cardUrl !== expectedCard) {
    throw new SourcePipelineError('CARD_URL_MISMATCH', `作品IDに対応する固定図書カードURLではありません: ${work.workId}`);
  }
}

/** @des DES-F002-004 DES-F002-014 @fun FUN-F002-007 */
export function assertAllowedWorkSource(
  work: Pick<SelectedWork, 'workId' | 'sourceUrl' | 'cardUrl'>,
  allowlist: WorkSourceAllowlist,
): void {
  if (!/^[0-9]{6}$/u.test(work.workId) || !/^[0-9]{6}$/u.test(allowlist.authorId)) {
    throw new SourcePipelineError('WORK_NOT_ALLOWED', 'author/work IDは6桁で指定してください');
  }
  const expected = allowlist.works[work.workId];
  if (!expected || work.sourceUrl !== expected.sourceUrl || work.cardUrl !== expected.cardUrl) {
    throw new SourcePipelineError('WORK_NOT_ALLOWED', `manifest由来allowlistと作品URLが一致しません: ${work.workId}`);
  }
  assertBatchWorkUrl({
    workId: work.workId, title: '', personId: allowlist.authorId, role: '著者', copyright: 'なし',
    status: '公開中', language: '日本語原著', sourceUrl: work.sourceUrl, cardUrl: work.cardUrl, charset: 'UTF-8',
  }, allowlist.authorId);
}

function mediaTypeOf(headers: TransportResponse['headers']): string {
  const value = headers instanceof Headers
    ? headers.get('content-type')
    : Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function charsetOf(headers: TransportResponse['headers']): Charset | null {
  const value = headers instanceof Headers
    ? headers.get('content-type')
    : Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const match = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(value ?? '');
  return match?.[1] ? normalizeCharset(match[1]) : null;
}

function validateResponse(response: TransportResponse, policy: TransportPolicy): string {
  if (response.status !== 200) throw new SourcePipelineError('HTTP_STATUS', `HTTP ${response.status} は受理できません`);
  if (response.elapsedMs !== undefined && response.elapsedMs > policy.timeoutMs) {
    throw new SourcePipelineError('FETCH_TIMEOUT', '取得がtimeoutしました');
  }
  if (response.body.byteLength > policy.maxBytes) {
    throw new SourcePipelineError('SOURCE_TOO_LARGE', `取得物が${policy.maxBytes}byteを超えています`);
  }
  const mediaType = mediaTypeOf(response.headers);
  if (!policy.allowedMediaTypes.includes(mediaType)) {
    throw new SourcePipelineError('UNEXPECTED_MEDIA_TYPE', `許可されていないmedia typeです: ${mediaType}`);
  }
  return mediaType;
}

/**
 * DNS pin、TLS hostname検証、redirect/proxy無効化を低水準socket factoryへ強制する。
 * @des DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-007 FUN-F001-041
 */
export class ProductionAozoraTransport implements AozoraTransport {
  private queue: Promise<void> = Promise.resolve();

  private readonly options: Required<Pick<ProductionAozoraTransportOptions, 'resolver' | 'pinnedSocketFactory'>> &
    Pick<ProductionAozoraTransportOptions, 'clock'>;

  constructor(options: ProductionAozoraTransportOptions = {}) {
    this.options = {
      resolver: options.resolver ?? defaultResolver,
      pinnedSocketFactory: options.pinnedSocketFactory ?? defaultPinnedSocketFactory,
      clock: options.clock,
    };
  }

  request(url: URL, policy: TransportPolicy): Promise<TransportResponse> {
    const operation = this.queue.then(() => this.requestSerial(url, policy));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async requestSerial(url: URL, policy: TransportPolicy): Promise<TransportResponse> {
    validateAozoraUrl(url, policy.pathPrefix);
    const addresses = await this.options.resolver(url.hostname);
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new SourcePipelineError('UNSAFE_RESOLVED_ADDRESS', '名前解決結果に非public addressが含まれます');
    }
    const pinned = addresses[0];
    if (!pinned) throw new SourcePipelineError('DNS_EMPTY', '名前解決結果が空です');
    const family = pinned.family ?? isIP(pinned.address);
    if (family !== 4 && family !== 6) throw new SourcePipelineError('DNS_INVALID', '不正な名前解決結果です');

    const controller = new AbortController();
    const startedAt = this.options.clock?.() ?? Date.now();
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      const response = await this.options.pinnedSocketFactory({
        url,
        address: pinned.address,
        family,
        hostHeader: url.hostname,
        serverName: url.hostname,
        rejectUnauthorized: true,
        checkServerIdentity: true,
        followRedirects: false,
        useEnvironmentProxy: false,
        signal: controller.signal,
        maxBytes: policy.maxBytes,
        userAgent: AOZORA_USER_AGENT,
      });
      const elapsedMs = response.elapsedMs ?? (this.options.clock?.() ?? Date.now()) - startedAt;
      const completed = { ...response, elapsedMs };
      validateResponse(completed, policy);
      return completed;
    } catch (error) {
      if (controller.signal.aborted) throw new SourcePipelineError('FETCH_TIMEOUT', '取得がtimeoutしました');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) throw new SourcePipelineError('DNS_INVALID', '不正な名前解決結果です');
    return { address, family };
  });
}

/**
 * Node標準HTTPSを検証済みIPへ直接pinする。native clientはredirectを追跡せずproxy環境変数も参照しない。
 * @des DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-007 FUN-F001-041
 */
async function defaultPinnedSocketFactory(input: PinnedRequest): Promise<TransportResponse> {
  return new Promise((resolveResponse, reject) => {
    let settled = false;
    const finishError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = httpsRequest(input.url, {
      agent: false,
      family: input.family,
      headers: {
        Host: input.hostHeader,
        Connection: 'close',
        'User-Agent': input.userAgent,
      },
      lookup: (_hostname, _options, callback) => callback(null, input.address, input.family),
      servername: input.serverName,
      rejectUnauthorized: input.rejectUnauthorized,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(input.serverName, certificate),
      signal: input.signal,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > input.maxBytes) {
          request.destroy(new SourcePipelineError('SOURCE_TOO_LARGE', `取得物が${input.maxBytes}byteを超えています`));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once('error', finishError);
      response.once('end', () => {
        if (settled) return;
        settled = true;
        resolveResponse({
          status: response.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(', ') : value,
          ])),
          body: Buffer.concat(chunks),
          fetchedAt: new Date().toISOString(),
        });
      });
    });
    request.once('error', finishError);
    request.end();
  });
}

async function assertSafeOutputDirectory(outputDir: string, workspaceRoot: string): Promise<string> {
  if (!isAbsolute(outputDir)) throw new SourcePipelineError('OUTPUT_NOT_ABSOLUTE', '出力先は絶対pathで指定してください');
  const root = await realpath(workspaceRoot);
  const target = resolve(outputDir);
  const relation = relative(root, target);
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new SourcePipelineError('OUTPUT_OUTSIDE_WORKSPACE', '出力先がworkspace内ではありません');
  }
  let cursor = root;
  for (const segment of relation.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new SourcePipelineError('OUTPUT_REPARSE_POINT', '出力pathにreparse pointがあります');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

async function promoteDirectory(target: string, populate: (staging: string) => Promise<void>): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), '.source-stage-'));
  const backup = `${target}.backup-${process.pid}-${Date.now()}`;
  const rejected = `${target}.rejected-${process.pid}-${Date.now()}`;
  let backedUp = false;
  let promoted = false;
  try {
    await populate(staging);
    try {
      await rename(target, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(staging, target);
    promoted = true;
    if (backedUp) {
      try {
        await rm(backup, { recursive: true, force: true });
      } catch {
        // 新treeはatomicに採用済み。旧backupの掃除は次回保守へ委ねる。
      }
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (backedUp) {
      try {
        if (promoted) await rename(target, rejected);
        await rename(backup, target);
        await rm(rejected, { recursive: true, force: true });
      } catch {
        // 復旧失敗時も元の例外を維持し、backupを証跡として残す。
      }
    }
    throw error;
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** @des DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-007 */
export async function fetchAozoraSources(
  works: readonly SelectedWork[],
  outputDir: string,
  options: SourceFetchOptions,
): Promise<SourceRecord[]> {
  if (!(options.transport instanceof ProductionAozoraTransport)) {
    throw new SourcePipelineError('PRODUCTION_TRANSPORT_REQUIRED', '原典取得にはProductionAozoraTransportが必要です');
  }
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const target = await assertSafeOutputDirectory(outputDir, workspaceRoot);
  const records: SourceRecord[] = [];
  const bodies: Uint8Array[] = [];
  const seen = new Set<string>();
  const allowlist: WorkSourceAllowlist = options.allowlist ?? {
    authorId: TARGET_PERSON_ID,
    works: Object.fromEntries(INITIAL_WORK_IDS.map((workId) => [workId, {
      sourceUrl: INITIAL_WORK_SOURCE_URLS[workId], cardUrl: INITIAL_WORK_CARD_URLS[workId],
    }])),
  };

  for (const work of works) {
    if (options.allowlist) assertAllowedWorkSource(work, options.allowlist);
    else assertInitialWorkSource(work);
    if (seen.has(work.workId)) throw new SourcePipelineError('DUPLICATE_WORK_ID', `作品IDが重複しています: ${work.workId}`);
    seen.add(work.workId);
    const url = new URL(work.sourceUrl);
    validateAozoraUrl(url, `/cards/${allowlist.authorId}/files/`);
    const response = await options.transport.request(url, {
      pathPrefix: `/cards/${allowlist.authorId}/files/`,
      allowedMediaTypes: ['application/xhtml+xml', 'text/html'],
      maxBytes: MAX_SOURCE_BYTES,
      timeoutMs: AOZORA_TIMEOUT_MS,
    });
    const mediaType = validateResponse(response, {
      pathPrefix: `/cards/${allowlist.authorId}/files/`,
      allowedMediaTypes: ['application/xhtml+xml', 'text/html'],
      maxBytes: MAX_SOURCE_BYTES,
      timeoutMs: AOZORA_TIMEOUT_MS,
    });
    const rawPath = `${work.workId}/source.raw`;
    records.push({
      workId: work.workId,
      rawPath,
      rawSha256: sha256(response.body),
      mediaType,
      httpCharset: charsetOf(response.headers),
      bibliographyCharset: normalizeCharset(work.charset),
      fetchedAt: response.fetchedAt ?? (options.clock?.() ?? new Date()).toISOString(),
      sourceUrl: url.href,
    });
    bodies.push(response.body.slice());
  }

  await promoteDirectory(target, async (staging) => {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const body = bodies[index];
      if (!record || !body) throw new SourcePipelineError('INTERNAL_ARTIFACT_MISMATCH', '原典artifact対応が崩れました');
      const workDir = join(staging, record.workId);
      await mkdir(workDir, { recursive: true });
      await writeFile(join(staging, record.rawPath), body);
      await writeFile(join(workDir, 'source.json'), json(record), 'utf8');
    }
  });
  return records;
}

function bibliographyProvenance(snapshot: BibliographySnapshot): BibliographyProvenance {
  const hashes = [snapshot.archiveSha256, snapshot.csvSha256];
  if (
    snapshot.sourceUrl !== AOZORA_BIBLIOGRAPHY_URL ||
    snapshot.mediaType !== 'application/zip' ||
    snapshot.csvEntry !== AOZORA_BIBLIOGRAPHY_ENTRY ||
    !nonBlank(snapshot.schemaVersion) ||
    !hashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)) ||
    !Number.isSafeInteger(snapshot.archiveBytes) || snapshot.archiveBytes <= 0 ||
    !Number.isSafeInteger(snapshot.csvBytes) || snapshot.csvBytes <= 0
  ) {
    throw new SourcePipelineError('PROVENANCE_BIBLIOGRAPHY_INVALID', '書誌snapshotの由来情報が不正です');
  }
  return Object.freeze({
    sourceUrl: snapshot.sourceUrl,
    archiveSha256: snapshot.archiveSha256,
    archiveBytes: snapshot.archiveBytes,
    csvEntry: snapshot.csvEntry,
    csvSha256: snapshot.csvSha256,
    csvBytes: snapshot.csvBytes,
    schemaVersion: snapshot.schemaVersion.trim(),
  });
}

/** @des DES-F001-004 DES-F001-012 DES-F001-017 @fun FUN-F001-008 */
export function buildProvenance(
  source: SourceRecord,
  metadata: AozoraMetadata,
  bibliography: BibliographySnapshot,
): Provenance {
  const required: Array<keyof AozoraMetadata> = [
    'stableCardUrl', 'baseEdition', 'inputter', 'proofreader', 'toolVersion',
    'transformation', 'changeNotice', 'sourceSha256',
  ];
  const missing = required.filter((field) => !nonBlank(metadata[field]));
  if (!nonBlank(source.sourceUrl) || !nonBlank(source.fetchedAt) || !/^[a-f0-9]{64}$/u.test(source.rawSha256)) {
    missing.push('sourceSha256');
  }
  if (missing.length > 0) {
    throw new SourcePipelineError('PROVENANCE_MISSING', '由来情報の必須項目が欠落しています', [...new Set(missing)]);
  }
  if (metadata.sourceSha256 !== source.rawSha256) {
    throw new SourcePipelineError('PROVENANCE_HASH_MISMATCH', '書誌と原典のSHA-256が一致しません');
  }
  const stableCard = new URL(metadata.stableCardUrl);
  validateAozoraUrl(stableCard, `/cards/${TARGET_PERSON_ID}/`);
  if (!new RegExp(`^/cards/${TARGET_PERSON_ID}/card[0-9]+\\.html$`, 'u').test(stableCard.pathname)) {
    throw new SourcePipelineError('UNTRUSTED_AOZORA_URL', '図書カードURLのpathが不正です');
  }
  const sourceUrl = new URL(source.sourceUrl);
  validateAozoraUrl(sourceUrl, `/cards/${TARGET_PERSON_ID}/files/`);
  if (!metadata.changeNotice.toLowerCase().includes('cc by 4.0')) {
    throw new SourcePipelineError('CHANGE_NOTICE_MISSING', 'CC BY 4.0の変更表示がありません');
  }
  return {
    workId: source.workId,
    stableCardUrl: stableCard.href,
    sourceUrl: sourceUrl.href,
    sourceSha256: source.rawSha256,
    fetchedAt: source.fetchedAt,
    baseEdition: metadata.baseEdition.trim(),
    inputter: metadata.inputter.trim(),
    proofreader: metadata.proofreader.trim(),
    toolVersion: metadata.toolVersion.trim(),
    transformation: metadata.transformation.trim(),
    changeNotice: metadata.changeNotice.trim(),
    bibliography: bibliographyProvenance(bibliography),
  };
}

function asciiPrefix(raw: Uint8Array): string {
  return Array.from(raw.subarray(0, Math.min(raw.length, 16_384)), (byte) =>
    byte <= 0x7f ? String.fromCharCode(byte) : ' ').join('');
}

function declarationCharsets(text: string): Charset[] {
  const rawValues: string[] = [];
  const xml = /<\?xml\b[^>]*\bencoding\s*=\s*["']\s*([^"']+)\s*["'][^>]*\?>/giu;
  const directMeta = /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([^\s"'/>;]+)/giu;
  const httpEquiv = /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*?charset\s*=\s*([^\s;"']+)/giu;
  for (const regex of [xml, directMeta, httpEquiv]) {
    for (const match of text.matchAll(regex)) if (match[1]) rawValues.push(match[1]);
  }
  return rawValues.map((value) => normalizeCharset(value)).filter((value): value is Charset => value !== null);
}

/** @des DES-F001-004 DES-F001-005 DES-F001-019 @fun FUN-F001-040 */
export function decodeAozoraSource(record: SourceRecord, raw: Uint8Array): DecodedSource {
  const before = raw.slice();
  if (sha256(raw) !== record.rawSha256) throw new SourcePipelineError('RAW_HASH_MISMATCH', 'raw SHA-256がSourceRecordと一致しません');
  const httpCharset = normalizeCharset(record.httpCharset);
  const bibliographyCharset = normalizeCharset(record.bibliographyCharset);
  const rawDeclarations = declarationCharsets(asciiPrefix(raw));
  const distinctRaw = [...new Set(rawDeclarations)];
  if (distinctRaw.length > 1) throw new SourcePipelineError('CHARSET_CONFLICT', 'XML/meta charset宣言が一致しません');
  const metaCharset = distinctRaw[0] ?? null;
  const declarations = [httpCharset, metaCharset, bibliographyCharset].filter((value): value is Charset => value !== null);
  if (declarations.length === 0) throw new SourcePipelineError('CHARSET_MISSING', 'charset宣言がすべて欠落しています');
  if (new Set(declarations).size !== 1) throw new SourcePipelineError('CHARSET_CONFLICT', 'HTTP/meta/書誌charsetが一致しません');
  const adoptedCharset = httpCharset ?? metaCharset ?? bibliographyCharset;
  if (!adoptedCharset) throw new SourcePipelineError('CHARSET_MISSING', '採用可能なcharsetがありません');

  let text: string;
  try {
    text = new TextDecoder(adoptedCharset === 'Shift_JIS' ? 'shift_jis' : 'utf-8', { fatal: true }).decode(raw);
  } catch (error) {
    throw new SourcePipelineError('DECODE_FAILED', '原典を宣言charsetでdecodeできません', error);
  }
  if (text.includes('\uFFFD')) throw new SourcePipelineError('REPLACEMENT_CHARACTER', 'decode結果にreplacement characterがあります');
  const decodedDeclarations = declarationCharsets(text);
  if (decodedDeclarations.some((value) => value !== adoptedCharset)) {
    throw new SourcePipelineError('DECODED_CHARSET_CONFLICT', 'decode後のXML/meta宣言と採用charsetが矛盾します');
  }
  if (!Buffer.from(before).equals(Buffer.from(raw))) {
    throw new SourcePipelineError('RAW_MUTATED', 'decode中にraw bytesが変更されました');
  }
  return {
    workId: record.workId,
    rawSha256: record.rawSha256,
    httpCharset,
    metaCharset,
    bibliographyCharset,
    adoptedCharset,
    text,
  };
}

function defaultBibliographySchemaValidator(raw: Uint8Array, mediaType: string): string {
  if (!['text/csv', 'application/csv', 'text/plain'].includes(mediaType)) {
    throw new SourcePipelineError('BIBLIOGRAPHY_MEDIA_TYPE', `書誌media typeが不正です: ${mediaType}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch (error) {
    throw new SourcePipelineError('BIBLIOGRAPHY_DECODE', '書誌CSVが正しいUTF-8ではありません', error);
  }
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter((line) => line.trim() !== '');
  const header = lines[0]?.split(',').map((column) => column.trim()) ?? [];
  const missing = AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (lines.length < 2 || header.length < 2 || new Set(header).size !== header.length || missing.length > 0) {
    throw new SourcePipelineError('BIBLIOGRAPHY_SCHEMA', '書誌CSVのschemaが不正です');
  }
  return createHash('sha256').update(header.join('\u0000')).digest('hex').slice(0, 16);
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_FIELD = 0x0001;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zipFailure(code: string, message: string): never {
  throw new SourcePipelineError(code, message);
}

function checkedRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    zipFailure('BIBLIOGRAPHY_ZIP_STRUCTURE', `ZIP ${label}の範囲が不正です`);
  }
}

function zipExtraHasZip64(extra: Uint8Array): boolean {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset < extra.byteLength) {
    if (offset + 4 > extra.byteLength) zipFailure('BIBLIOGRAPHY_ZIP_STRUCTURE', 'ZIP extra fieldが途中で終了しています');
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    offset += 4;
    if (offset + size > extra.byteLength) zipFailure('BIBLIOGRAPHY_ZIP_STRUCTURE', 'ZIP extra field長が不正です');
    if (id === ZIP64_EXTRA_FIELD) return true;
    offset += size;
  }
  return false;
}

function decodeZipName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SourcePipelineError('BIBLIOGRAPHY_ZIP_NAME', 'ZIP entry名が正しいUTF-8ではありません', error);
  }
}

function assertSafeZipName(name: string): void {
  const segments = name.split('/');
  if (
    name.length === 0 || name.includes('\\') || name.startsWith('/') || /^[a-z]:/iu.test(name) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    name !== AOZORA_BIBLIOGRAPHY_ENTRY
  ) {
    zipFailure('BIBLIOGRAPHY_ZIP_ENTRY', 'ZIPは固定名CSV 1 entryだけを受理します');
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  return zipFailure('BIBLIOGRAPHY_ZIP_STRUCTURE', 'ZIP end of central directoryが見つかりません');
}

/** 任意filesystem展開を行わず、固定CSV entryだけをmemory上で検証・展開する。 */
export function extractVerifiedBibliographyCsv(archive: Uint8Array): Uint8Array {
  if (archive.byteLength === 0 || archive.byteLength > MAX_BIBLIOGRAPHY_ARCHIVE_BYTES) {
    zipFailure('BIBLIOGRAPHY_ARCHIVE_SIZE', '書誌ZIPが許容byte数を超えています');
  }
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocdOffset = findEndOfCentralDirectory(archive, view);
  checkedRange(archive, eocdOffset, 22, 'EOCD');
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (
    diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== 1 || entries !== 1 ||
    centralSize === 0xffffffff || centralOffset === 0xffffffff
  ) {
    zipFailure('BIBLIOGRAPHY_ZIP_LAYOUT', 'multi-disk、ZIP64、複数/空entryのZIPは受理しません');
  }
  if (eocdOffset >= 20 && view.getUint32(eocdOffset - 20, true) === ZIP64_END_LOCATOR) {
    zipFailure('BIBLIOGRAPHY_ZIP_LAYOUT', 'ZIP64は受理しません');
  }
  checkedRange(archive, centralOffset, centralSize, 'central directory');
  if (centralOffset + centralSize !== eocdOffset || centralSize < 46 || view.getUint32(centralOffset, true) !== ZIP_CENTRAL_HEADER) {
    zipFailure('BIBLIOGRAPHY_ZIP_STRUCTURE', 'central directoryが不正です');
  }

  const versionMadeBy = view.getUint16(centralOffset + 4, true);
  const versionNeeded = view.getUint16(centralOffset + 6, true);
  const flags = view.getUint16(centralOffset + 8, true);
  const method = view.getUint16(centralOffset + 10, true);
  const expectedCrc = view.getUint32(centralOffset + 16, true);
  const compressedSize = view.getUint32(centralOffset + 20, true);
  const uncompressedSize = view.getUint32(centralOffset + 24, true);
  const nameLength = view.getUint16(centralOffset + 28, true);
  const extraLength = view.getUint16(centralOffset + 30, true);
  const commentLength = view.getUint16(centralOffset + 32, true);
  const diskStart = view.getUint16(centralOffset + 34, true);
  const externalAttributes = view.getUint32(centralOffset + 38, true);
  const localOffset = view.getUint32(centralOffset + 42, true);
  const centralRecordLength = 46 + nameLength + extraLength + commentLength;
  checkedRange(archive, centralOffset, centralRecordLength, 'central entry');
  if (centralRecordLength !== centralSize || diskStart !== 0) zipFailure('BIBLIOGRAPHY_ZIP_LAYOUT', 'central entry数またはdiskが不正です');
  const allowedFlags = 0x0806; // deflate option bitsとUTF-8名だけを許可する。
  if (
    (flags & ~allowedFlags) !== 0 ||
    (flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0 ||
    versionNeeded > 20
  ) {
    zipFailure('BIBLIOGRAPHY_ZIP_FLAGS', '暗号化、data descriptor、未対応flag/versionのZIPは受理しません');
  }
  if (method !== 0 && method !== 8) zipFailure('BIBLIOGRAPHY_ZIP_METHOD', 'store/deflate以外の圧縮方式は受理しません');
  if (method === 0 && (flags & 0x0006) !== 0) zipFailure('BIBLIOGRAPHY_ZIP_FLAGS', 'store entryのdeflate flagは不正です');
  if (
    compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
    uncompressedSize === 0 || uncompressedSize > MAX_BIBLIOGRAPHY_CSV_BYTES ||
    compressedSize === 0 || uncompressedSize / compressedSize > MAX_BIBLIOGRAPHY_EXPANSION_RATIO
  ) {
    zipFailure('BIBLIOGRAPHY_ZIP_BOMB', 'ZIP entryのbyte数または展開率が許容範囲外です');
  }
  const creatorSystem = versionMadeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const unixFileType = unixMode & 0xf000;
  if (
    (creatorSystem !== 0 && creatorSystem !== 3) ||
    (externalAttributes & 0x10) !== 0 ||
    (creatorSystem === 3 && unixFileType !== 0x8000)
  ) {
    zipFailure('BIBLIOGRAPHY_ZIP_FILE_TYPE', '通常ファイル以外のZIP entryは受理しません');
  }
  const centralNameStart = centralOffset + 46;
  const centralName = archive.subarray(centralNameStart, centralNameStart + nameLength);
  const centralExtra = archive.subarray(centralNameStart + nameLength, centralNameStart + nameLength + extraLength);
  if (zipExtraHasZip64(centralExtra)) zipFailure('BIBLIOGRAPHY_ZIP_LAYOUT', 'ZIP64 extra fieldは受理しません');
  const entryName = decodeZipName(centralName);
  assertSafeZipName(entryName);

  if (localOffset !== 0) zipFailure('BIBLIOGRAPHY_ZIP_STRUCTURE', 'ZIP local header前の任意dataは受理しません');
  checkedRange(archive, localOffset, 30, 'local header');
  if (view.getUint32(localOffset, true) !== ZIP_LOCAL_HEADER) zipFailure('BIBLIOGRAPHY_ZIP_STRUCTURE', 'local headerが不正です');
  const localVersionNeeded = view.getUint16(localOffset + 4, true);
  const localFlags = view.getUint16(localOffset + 6, true);
  const localMethod = view.getUint16(localOffset + 8, true);
  const localCrc = view.getUint32(localOffset + 14, true);
  const localCompressedSize = view.getUint32(localOffset + 18, true);
  const localUncompressedSize = view.getUint32(localOffset + 22, true);
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const localHeaderLength = 30 + localNameLength + localExtraLength;
  checkedRange(archive, localOffset, localHeaderLength, 'local entry');
  const localNameStart = localOffset + 30;
  const localName = archive.subarray(localNameStart, localNameStart + localNameLength);
  const localExtra = archive.subarray(localNameStart + localNameLength, localNameStart + localNameLength + localExtraLength);
  if (
    versionNeeded !== localVersionNeeded || flags !== localFlags || method !== localMethod || expectedCrc !== localCrc ||
    compressedSize !== localCompressedSize || uncompressedSize !== localUncompressedSize ||
    !Buffer.from(centralName).equals(Buffer.from(localName)) || zipExtraHasZip64(localExtra)
  ) {
    zipFailure('BIBLIOGRAPHY_ZIP_HEADER_MISMATCH', 'central/local headerが一致しません');
  }
  const dataOffset = localOffset + localHeaderLength;
  checkedRange(archive, dataOffset, compressedSize, 'compressed data');
  if (dataOffset + compressedSize !== centralOffset) zipFailure('BIBLIOGRAPHY_ZIP_STRUCTURE', 'ZIP entry境界が不正です');
  const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
  let csv: Uint8Array;
  try {
    csv = method === 0
      ? compressed.slice()
      : inflateRawSync(compressed, { maxOutputLength: MAX_BIBLIOGRAPHY_CSV_BYTES });
  } catch (error) {
    throw new SourcePipelineError('BIBLIOGRAPHY_ZIP_DEFLATE', '書誌CSVを安全に展開できません', error);
  }
  if (csv.byteLength !== uncompressedSize) zipFailure('BIBLIOGRAPHY_ZIP_SIZE_MISMATCH', '展開後CSV byte数がheaderと一致しません');
  if (csv.byteLength / compressedSize > MAX_BIBLIOGRAPHY_EXPANSION_RATIO) {
    zipFailure('BIBLIOGRAPHY_ZIP_BOMB', '実展開率が許容範囲外です');
  }
  if (crc32(csv) !== expectedCrc) zipFailure('BIBLIOGRAPHY_ZIP_CRC', '書誌CSVのCRC-32が一致しません');
  return csv;
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field);
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new SourcePipelineError('BIBLIOGRAPHY_SCHEMA', '書誌CSVのquoteが閉じていません');
  record.push(field);
  if (record.some((value) => value.length > 0)) records.push(record);
  return records;
}

/** @des DES-F001-003 @fun FUN-F001-005 */
export function parseAozoraBibliography(raw: Uint8Array): BibliographyRow[] {
  defaultBibliographySchemaValidator(raw, 'text/csv');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/u, '');
  const [header, ...records] = parseCsvRecords(text);
  if (!header) throw new SourcePipelineError('BIBLIOGRAPHY_SCHEMA', '書誌CSVのheaderがありません');
  const indexes = new Map(header.map((name, index) => [name.trim(), index]));
  const value = (record: readonly string[], column: string): string => record[indexes.get(column) ?? -1]?.trim() ?? '';
  return records.map((record) => {
    const role = value(record, '役割フラグ');
    const normalizedRole = normalizeEnum(role);
    const language = ELIGIBLE_ROLE.has(normalizedRole)
      ? '日本語原著'
      : normalizedRole === '翻訳者' || normalizedRole === 'translator'
        ? '翻訳'
        : '不明';
    return {
      workId: value(record, '作品ID').padStart(6, '0'),
      title: value(record, '作品名'),
      personId: value(record, '人物ID').padStart(6, '0'),
      role,
      copyright: value(record, '作品著作権フラグ'),
      status: value(record, 'XHTML/HTMLファイルURL') ? '公開中' : '非公開',
      language,
      sourceUrl: value(record, 'XHTML/HTMLファイルURL'),
      charset: value(record, 'XHTML/HTMLファイル符号化方式') || value(record, 'XHTML/HTMLファイル文字集合'),
      cardUrl: value(record, '図書カードURL'),
      baseEdition: value(record, '底本名1'),
      inputter: value(record, '入力者'),
      proofreader: value(record, '校正者'),
      edition: value(record, '底本名1'),
      personCopyright: value(record, '人物著作権フラグ'),
      orthography: value(record, '文字遣い種別'),
    };
  });
}

/** @des DES-F001-003 DES-F001-004 DES-F001-017 DES-F001-019 @fun FUN-F001-041 */
export async function fetchAozoraBibliography(
  url: URL,
  outputDir: string,
  transport: ProductionAozoraTransport,
  options: BibliographyFetchOptions = {},
): Promise<BibliographySnapshot> {
  if (!(transport instanceof ProductionAozoraTransport)) {
    throw new SourcePipelineError('PRODUCTION_TRANSPORT_REQUIRED', '書誌取得にはProductionAozoraTransportが必要です');
  }
  validateAozoraUrl(url, '/index_pages/');
  if (url.href !== AOZORA_BIBLIOGRAPHY_URL) {
    throw new SourcePipelineError('BIBLIOGRAPHY_URL', '公式の固定書誌ZIP URL以外は受理しません');
  }
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const target = await assertSafeOutputDirectory(outputDir, workspaceRoot);
  const policy: TransportPolicy = {
    pathPrefix: '/index_pages/',
    allowedMediaTypes: ['application/zip'],
    maxBytes: MAX_BIBLIOGRAPHY_ARCHIVE_BYTES,
    timeoutMs: AOZORA_TIMEOUT_MS,
  };
  const response = await transport.request(url, policy);
  const mediaType = validateResponse(response, policy);
  const csv = extractVerifiedBibliographyCsv(response.body);
  const schemaVersion = (options.schemaValidator ?? defaultBibliographySchemaValidator)(csv, 'text/csv');
  if (!nonBlank(schemaVersion)) throw new SourcePipelineError('BIBLIOGRAPHY_SCHEMA', 'schema版が空です');
  const snapshot: BibliographySnapshot = {
    sourceUrl: url.href,
    archivePath: 'list_person_all_extended_utf8.zip',
    archiveSha256: sha256(response.body),
    archiveBytes: response.body.byteLength,
    csvPath: AOZORA_BIBLIOGRAPHY_ENTRY,
    csvEntry: AOZORA_BIBLIOGRAPHY_ENTRY,
    csvSha256: sha256(csv),
    csvBytes: csv.byteLength,
    mediaType,
    fetchedAt: response.fetchedAt ?? (options.clock?.() ?? new Date()).toISOString(),
    schemaVersion,
  };
  await promoteDirectory(target, async (staging) => {
    await writeFile(join(staging, snapshot.archivePath), response.body);
    await writeFile(join(staging, snapshot.csvPath), csv);
    await writeFile(join(staging, 'source.json'), json(snapshot), 'utf8');
    const [persistedArchive, persistedCsv] = await Promise.all([
      readFile(join(staging, snapshot.archivePath)),
      readFile(join(staging, snapshot.csvPath)),
    ]);
    if (sha256(persistedArchive) !== snapshot.archiveSha256 || sha256(persistedCsv) !== snapshot.csvSha256) {
      throw new SourcePipelineError('SNAPSHOT_HASH_MISMATCH', '書誌ZIP/CSV snapshotのhashが一致しません');
    }
  });
  return snapshot;
}
