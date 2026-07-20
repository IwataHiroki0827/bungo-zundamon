import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from './artifacts.ts';
import {
  hashBatchManifest,
  transitionWorkState,
  type BatchManifest,
  type Sha256,
  type StageEvidence,
  type WorkId,
  type WorkspaceRelativePath,
} from './batch.ts';
import {
  SUPPORTED_SPEECH_RULE_VERSION,
  createCandidateId,
  normalizeDisplayText,
  normalizeSpeechText,
  type Candidate,
  type DecodedSource,
  type RawCandidate,
  type SpeechRules,
} from './processing.ts';
import {
  MAX_SOURCE_BYTES,
  AOZORA_BIBLIOGRAPHY_ENTRY,
  AOZORA_BIBLIOGRAPHY_URL,
  parseAozoraBibliography,
  type BibliographyRow,
  type BibliographySnapshot,
  type SelectedWork,
  type SelectedWorkResult,
  type SourceRecord,
} from './source.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const WORK_ID = /^[0-9]{6}$/u;

export class BatchProductionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BatchProductionError';
  }
}

export interface SpeechRevision {
  readonly candidateId: string;
  readonly revision: number;
  readonly before: string;
  readonly after: string;
  readonly reason: string;
  readonly reviewer: string;
  readonly reviewedAt: string;
}

export interface CandidateWithRevisions extends Candidate {
  readonly revisions: readonly SpeechRevision[];
  readonly sha256: Sha256;
}

export interface BatchBibliography {
  readonly snapshot: BibliographySnapshot;
  readonly csv: Uint8Array;
  readonly archive?: Uint8Array;
  readonly rows: readonly BibliographyRow[];
}

export interface FetchedBatchSource {
  readonly record: SourceRecord;
  readonly raw: Uint8Array;
}

export interface BatchSourceScratch {
  /** runner所有のrandom cache。dependencyはcanonical data/contentへ書き込まない。 */
  readonly root: string;
}

export interface BatchSourceDependencies {
  readonly loadBibliography: (context: BatchContext, scratch: BatchSourceScratch) => Promise<BatchBibliography>;
  readonly selectWorks: (bibliography: BatchBibliography, context: BatchContext, scratch: BatchSourceScratch) => Promise<SelectedWorkResult>;
  readonly fetchSource: (work: SelectedWork, context: BatchContext, scratch: BatchSourceScratch) => Promise<FetchedBatchSource>;
  readonly decodeSource: (record: SourceRecord, raw: Uint8Array, context: BatchContext, scratch: BatchSourceScratch) => Promise<DecodedSource> | DecodedSource;
  readonly extractCandidates: (source: DecodedSource, workId: string, context: BatchContext, scratch: BatchSourceScratch) => Promise<readonly RawCandidate[]> | readonly RawCandidate[];
  readonly beforePromotion?: (staging: string, target: string) => Promise<void> | void;
}

export interface BatchContext {
  readonly workspace: string;
  readonly manifest: BatchManifest;
  readonly workId: WorkId;
  readonly speechRules: SpeechRules;
  readonly toolVersion: string;
  readonly clock: () => Date;
  readonly dependencies: BatchSourceDependencies;
}

export interface BatchSourceResult {
  readonly manifest: BatchManifest;
  readonly evidence: StageEvidence;
  readonly candidates: readonly CandidateWithRevisions[];
  readonly artifactRoot: WorkspaceRelativePath;
  readonly artifactSha256: Sha256;
  readonly artifactPaths: Readonly<{
    bibliography: WorkspaceRelativePath;
    bibliographyCsv: WorkspaceRelativePath;
    selectedWorks: WorkspaceRelativePath;
    sourceRecord: WorkspaceRelativePath;
    sourceRaw: WorkspaceRelativePath;
    decoded: WorkspaceRelativePath;
    rawCandidates: WorkspaceRelativePath;
    candidates: WorkspaceRelativePath;
  }>;
}

export interface BatchSourceTreeEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type PromotionPhase = 'prepared' | 'old-moved' | 'new-moved' | 'verified';

export interface PromotionHooks {
  readonly afterPhase?: (phase: PromotionPhase) => Promise<void> | void;
}

interface PromotionJournal {
  readonly version: 1;
  readonly phase: PromotionPhase;
  readonly targetName: string;
  readonly stagingName: string;
  readonly backupName: string;
  readonly expectedOldSha256: Sha256 | null;
  readonly expectedNewSha256: Sha256;
}

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function normalizedTextHash(displayText: string, speechText: string): string {
  return createHash('sha256').update(JSON.stringify([displayText, speechText]), 'utf8').digest('hex');
}

function genericCandidateId(raw: RawCandidate, normalizerVersion: string, textHash: string): string {
  if (
    !SHA256.test(raw.rawSourceSha256) || !SHA256.test(textHash) ||
    !Number.isSafeInteger(raw.rawTokenRange.start) || !Number.isSafeInteger(raw.rawTokenRange.end) ||
    raw.rawTokenRange.start < 0 || raw.rawTokenRange.end <= raw.rawTokenRange.start ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(raw.extractorVersion) ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(normalizerVersion)
  ) {
    throw new BatchProductionError('BATCH_CANDIDATE_MISMATCH', 'candidate ID tupleが不正です');
  }
  try {
    return createCandidateId(
      raw.workId,
      raw.rawSourceSha256,
      raw.rawTokenRange,
      raw.extractorVersion,
      normalizerVersion,
      textHash,
      new Set([raw.workId]),
    );
  } catch (error) {
    // F001 APIは固定allowlistを維持する。F002以降だけ同じcanonical tupleを汎用IDへ展開する。
    if (!(error instanceof Error) || !WORK_ID.test(raw.workId)) throw error;
    const tuple = JSON.stringify([
      raw.workId,
      raw.rawSourceSha256.toLowerCase(),
      raw.rawTokenRange.start,
      raw.rawTokenRange.end,
      raw.extractorVersion,
      normalizerVersion,
      textHash.toLowerCase(),
    ]);
    return createHash('sha256').update(tuple, 'utf8').digest('base64url');
  }
}

function assertRevisionText(value: string, field: string): void {
  const hasControl = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
  if (!value.trim() || [...value].length > 32_768 || hasControl || /[\uD800-\uDFFF]/u.test(value)) {
    throw new BatchProductionError('SPEECH_REVISION_MISMATCH', `${field}が不正です`);
  }
}

/** @des DES-F002-004 @fun FUN-F002-008 */
export function normalizeBatchCandidate(
  raw: RawCandidate,
  rules: SpeechRules,
  prior: readonly SpeechRevision[] = [],
): CandidateWithRevisions {
  const displayText = normalizeDisplayText(raw.tokens);
  const baseSpeech = normalizeSpeechText(raw.tokens, rules);
  let speechText = baseSpeech;
  let previous = baseSpeech;
  for (let index = 0; index < prior.length; index += 1) {
    const revision = prior[index];
    if (!revision || revision.revision !== index + 1) {
      throw new BatchProductionError('SPEECH_REVISION_GAP', 'speech revisionは1から連続させてください');
    }
    if (revision.before !== previous) {
      throw new BatchProductionError('SPEECH_REVISION_MISMATCH', 'speech revisionのbefore/after chainが一致しません');
    }
    assertRevisionText(revision.after, 'revision.after');
    if (
      !revision.reason.trim() || !revision.reviewer.trim() ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(revision.reviewedAt) ||
      !Number.isFinite(Date.parse(revision.reviewedAt))
    ) {
      throw new BatchProductionError('SPEECH_REVISION_MISMATCH', 'speech revisionの根拠・判定者・日時が不正です');
    }
    previous = revision.after.normalize('NFC');
    speechText = previous;
  }
  const textHash = normalizedTextHash(displayText, speechText);
  const candidateId = genericCandidateId(raw, rules.version, textHash);
  if (prior.some((revision) => revision.candidateId !== candidateId)) {
    throw new BatchProductionError('SPEECH_REVISION_MISMATCH', '旧candidate IDのrevisionは自動転用できません');
  }
  const candidate: Candidate = {
    candidateId,
    workId: raw.workId,
    rawSourceSha256: raw.rawSourceSha256,
    order: raw.order,
    rawTokenRange: { ...raw.rawTokenRange },
    displayText,
    speechText,
    contextBefore: raw.contextBefore,
    contextAfter: raw.contextAfter,
    sourceAnchor: { ...raw.sourceAnchor },
    extractorVersion: raw.extractorVersion,
    normalizerVersion: rules.version,
  };
  return Object.freeze({
    ...candidate,
    revisions: Object.freeze(prior.map((revision) => Object.freeze({ ...revision }))),
    sha256: sha256(canonicalJson(candidate)),
  });
}

function posix(...parts: string[]): WorkspaceRelativePath {
  return parts.join('/') as WorkspaceRelativePath;
}

async function verifiedWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new BatchProductionError('BATCH_WORKSPACE_MISMATCH', 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    throw new BatchProductionError('BATCH_WORKSPACE_MISMATCH', 'workspace実体が不正です');
  }
  return root;
}

function descendant(root: string, target: string): void {
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new BatchProductionError('BATCH_WORKSPACE_MISMATCH', 'artifact pathがworkspace外です');
  }
}

async function assertNoLinks(root: string, target: string): Promise<void> {
  let cursor = root;
  for (const part of relative(root, target).split(sep)) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new BatchProductionError('BATCH_WORKSPACE_MISMATCH', 'artifact pathにreparse pointがあります');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function treeDigest(entries: readonly BatchSourceTreeEntry[]): Sha256 {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    hash.update(entry.path, 'utf8').update('\0').update(String(entry.bytes.byteLength), 'ascii').update('\0').update(entry.bytes);
  }
  return hash.digest('hex') as Sha256;
}

async function directoryContentDigest(path: string): Promise<Sha256 | null> {
  try {
    const entries: BatchSourceTreeEntry[] = [];
    const walk = async (current: string, logical: string): Promise<void> => {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new BatchProductionError('BATCH_WORKSPACE_MISMATCH', '既存artifactにreparse pointがあります');
      if (info.isFile()) {
        entries.push({ path: logical, bytes: await readFile(current) });
        return;
      }
      if (!info.isDirectory()) throw new BatchProductionError('BATCH_WORKSPACE_MISMATCH', 'artifactはregular fileだけを許可します');
      for (const name of (await readdir(current)).sort((a, b) => a.localeCompare(b, 'en'))) {
        await walk(join(current, name), logical ? `${logical}/${name}` : name);
      }
    };
    await walk(path, '');
    return treeDigest(entries);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'EISDIR', 'EPERM'].includes(code ?? '')) throw error;
    // Windowsでdirectory fsyncが未提供の場合も、全entryを再open可能なことを確認する。
    for (const name of await readdir(path)) await lstat(join(path, name));
  }
}

async function writeSyncedFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncTreeDirectories(root: string): Promise<void> {
  const directories: string[] = [];
  const walk = async (path: string): Promise<void> => {
    directories.push(path);
    for (const name of await readdir(path)) {
      const child = join(path, name);
      if ((await lstat(child)).isDirectory()) await walk(child);
    }
  };
  await walk(root);
  for (const path of directories.toReversed()) await syncDirectory(path);
}

function journalPath(target: string): string {
  return join(dirname(target), `.${target.split(sep).at(-1)}.promotion-journal.json`);
}

async function writeJournal(path: string, journal: PromotionJournal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeSyncedFile(temporary, jsonBytes(journal));
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function readJournal(path: string): Promise<PromotionJournal | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as PromotionJournal;
    if (
      value.version !== 1 || !['prepared', 'old-moved', 'new-moved', 'verified'].includes(value.phase) ||
      !safeBasename(value.targetName) || !safeBasename(value.stagingName) || !safeBasename(value.backupName) ||
      !SHA256.test(value.expectedNewSha256) ||
      (value.expectedOldSha256 !== null && !SHA256.test(value.expectedOldSha256))
    ) throw new Error('invalid journal');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new BatchProductionError('BATCH_ARTIFACT_JOURNAL_INVALID', 'promotion journalが不正です');
  }
}

function safeBasename(value: string): boolean {
  const hasControl = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
  return value !== '.' && value !== '..' && value.length > 0 && value.length <= 255 &&
    !value.includes('\\') && !value.includes('/') && !value.includes(':') && !hasControl && !/[. ]$/u.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function safeEntryPath(value: string): boolean {
  if (isAbsolute(value) || value.includes('\\') || value.includes(':')) return false;
  const components = value.split('/');
  return components.length > 0 && components.every((part) => {
    const hasControl = [...part].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    });
    return safeBasename(part) && !hasControl;
  });
}

async function quarantine(path: string): Promise<string> {
  const destination = `${path}.quarantine-${randomUUID()}`;
  await rename(path, destination);
  await syncDirectory(dirname(path));
  return destination;
}

async function phase(
  path: string,
  journal: PromotionJournal,
  next: PromotionPhase,
  hooks?: PromotionHooks,
): Promise<PromotionJournal> {
  const updated = Object.freeze({ ...journal, phase: next });
  await writeJournal(path, updated);
  await hooks?.afterPhase?.(next);
  return updated;
}

/** @internal FUN-F002-007 crash recovery entrypoint. */
export async function recoverBatchSourceArtifactPromotion(
  workspace: string,
  artifactRoot: WorkspaceRelativePath,
  hooks?: PromotionHooks,
): Promise<void> {
  const root = await verifiedWorkspace(workspace);
  const target = join(root, ...artifactRoot.split('/'));
  descendant(root, target);
  await assertNoLinks(root, target);
  const jPath = journalPath(target);
  let journal = await readJournal(jPath);
  if (!journal) return;
  const targetName = target.split(sep).at(-1) ?? '';
  const stagePattern = new RegExp(`^\\.${escapeRegex(targetName)}\\.stage-[A-Za-z0-9_-]+$`, 'u');
  const backupPattern = new RegExp(`^\\.${escapeRegex(targetName)}\\.backup-[a-f0-9-]{36}$`, 'u');
  if (
    journal.targetName !== targetName || !stagePattern.test(journal.stagingName) ||
    !backupPattern.test(journal.backupName)
  ) {
    throw new BatchProductionError('BATCH_ARTIFACT_JOURNAL_INVALID', 'journal targetが一致しません');
  }
  const parent = dirname(target);
  const staging = resolve(parent, journal.stagingName);
  const backup = resolve(parent, journal.backupName);
  if (dirname(staging) !== parent || dirname(backup) !== parent) {
    throw new BatchProductionError('BATCH_ARTIFACT_JOURNAL_INVALID', 'journal pathがtarget directory外です');
  }
  descendant(root, staging);
  descendant(root, backup);
  await assertNoLinks(root, target);
  await assertNoLinks(root, staging);
  await assertNoLinks(root, backup);
  const targetSha = await directoryContentDigest(target);
  const stagingSha = await directoryContentDigest(staging);
  const backupSha = await directoryContentDigest(backup);
  const unknown: string[] = [];
  if (targetSha !== null && targetSha !== journal.expectedOldSha256 && targetSha !== journal.expectedNewSha256) unknown.push(target);
  if (stagingSha !== null && stagingSha !== journal.expectedNewSha256) unknown.push(staging);
  if (backupSha !== null && backupSha !== journal.expectedOldSha256) unknown.push(backup);
  if (unknown.length > 0) {
    for (const path of unknown) await quarantine(path);
    if (
      await directoryContentDigest(target) === null && journal.expectedOldSha256 !== null &&
      await directoryContentDigest(backup) === journal.expectedOldSha256
    ) {
      await rename(backup, target);
      await syncDirectory(parent);
    }
    throw new BatchProductionError('BATCH_ARTIFACT_QUARANTINED', '第三者値を隔離したためpromotionを停止しました');
  }
  if (targetSha !== journal.expectedNewSha256) {
    if (targetSha === journal.expectedOldSha256 && targetSha !== null) {
      if (backupSha === null) await rename(target, backup);
      else await quarantine(target);
      await syncDirectory(parent);
      journal = await phase(jPath, journal, 'old-moved', hooks);
    }
    if (await directoryContentDigest(staging) === journal.expectedNewSha256) {
      await rename(staging, target);
      await syncDirectory(parent);
      journal = await phase(jPath, journal, 'new-moved', hooks);
    } else if (await directoryContentDigest(target) !== journal.expectedNewSha256) {
      if (await directoryContentDigest(backup) === journal.expectedOldSha256 && journal.expectedOldSha256 !== null) {
        await rename(backup, target);
        await syncDirectory(parent);
      }
      throw new BatchProductionError('BATCH_ARTIFACT_RECOVERY_INCOMPLETE', '新版を回復できないため旧版へrollbackしました');
    }
  }
  if (await directoryContentDigest(target) !== journal.expectedNewSha256) {
    throw new BatchProductionError('BATCH_ARTIFACT_POSTVERIFY_FAILED', '昇格後artifactの全file hashが一致しません');
  }
  await phase(jPath, journal, 'verified', hooks);
  await rm(backup, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
  await rm(jPath, { force: true });
  await syncDirectory(parent);
}

/** @internal FUN-F002-007 journaled atomic promotion. */
export async function promoteBatchSourceArtifactTree(
  workspace: string,
  artifactRoot: WorkspaceRelativePath,
  entries: readonly BatchSourceTreeEntry[],
  hooks?: PromotionHooks,
  beforePromotion?: BatchSourceDependencies['beforePromotion'],
): Promise<void> {
  const root = await verifiedWorkspace(workspace);
  const target = join(root, ...artifactRoot.split('/'));
  descendant(root, target);
  await mkdir(dirname(target), { recursive: true });
  await recoverBatchSourceArtifactPromotion(workspace, artifactRoot);
  const expectedNewSha256 = treeDigest(entries);
  const expectedOldSha256 = await directoryContentDigest(target);
  if (expectedOldSha256 === expectedNewSha256) return;
  const targetName = target.split(sep).at(-1) ?? '';
  const staging = await mkdtemp(join(dirname(target), `.${targetName}.stage-`));
  const backup = join(dirname(target), `.${targetName}.backup-${randomUUID()}`);
  const paths = new Set<string>();
  try {
    for (const entry of entries) {
      if (!safeEntryPath(entry.path) || paths.has(entry.path)) {
        throw new BatchProductionError('BATCH_ARTIFACT_PATH_INVALID', 'artifact tree内pathが不正です');
      }
      paths.add(entry.path);
      const output = join(staging, ...entry.path.split('/'));
      await mkdir(dirname(output), { recursive: true });
      await writeSyncedFile(output, entry.bytes);
    }
    await syncTreeDirectories(staging);
    if (await directoryContentDigest(staging) !== expectedNewSha256) {
      throw new BatchProductionError('BATCH_ARTIFACT_POSTVERIFY_FAILED', 'stagingの全file hashが一致しません');
    }
    await beforePromotion?.(staging, target);
    if (await directoryContentDigest(target) !== expectedOldSha256) {
      throw new BatchProductionError('BATCH_ARTIFACT_CONFLICT', '既存artifactが処理中に変更されました');
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await syncDirectory(dirname(target));
    throw error;
  }
  let journal: PromotionJournal = Object.freeze({
      version: 1, phase: 'prepared', targetName,
      stagingName: staging.split(sep).at(-1) ?? '', backupName: backup.split(sep).at(-1) ?? '',
      expectedOldSha256, expectedNewSha256,
    });
  const jPath = journalPath(target);
  try {
    await writeJournal(jPath, journal);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await syncDirectory(dirname(target));
    throw error;
  }
  await hooks?.afterPhase?.('prepared');
  if (expectedOldSha256 !== null) {
    await rename(target, backup);
    await syncDirectory(dirname(target));
  }
  journal = await phase(jPath, journal, 'old-moved', hooks);
  await rename(staging, target);
  await syncDirectory(dirname(target));
  journal = await phase(jPath, journal, 'new-moved', hooks);
  if (await directoryContentDigest(target) !== expectedNewSha256) {
    throw new BatchProductionError('BATCH_ARTIFACT_POSTVERIFY_FAILED', '昇格後artifactの全file hashが一致しません');
  }
  await phase(jPath, journal, 'verified', hooks);
  await rm(backup, { recursive: true, force: true });
  await rm(jPath, { force: true });
  await syncDirectory(dirname(target));
}

function validateRawCandidates(items: readonly RawCandidate[], workId: string, rawSha: string): void {
  if (items.some((item, index) => item.workId !== workId || item.rawSourceSha256 !== rawSha || item.order !== index)) {
    throw new BatchProductionError('BATCH_CANDIDATE_MISMATCH', 'raw candidateのwork/hash/orderが一致しません');
  }
}

function assertBibliographyContract(bibliography: BatchBibliography): void {
  const snapshot = bibliography.snapshot;
  if (
    snapshot.sourceUrl !== AOZORA_BIBLIOGRAPHY_URL || snapshot.csvEntry !== AOZORA_BIBLIOGRAPHY_ENTRY ||
    snapshot.csvPath !== AOZORA_BIBLIOGRAPHY_ENTRY || snapshot.csvBytes !== bibliography.csv.byteLength ||
    snapshot.csvSha256 !== sha256(bibliography.csv) || !SHA256.test(snapshot.archiveSha256) ||
    (bibliography.archive !== undefined && (
      snapshot.archiveBytes !== bibliography.archive.byteLength || snapshot.archiveSha256 !== sha256(bibliography.archive)
    )) ||
    !Number.isFinite(Date.parse(snapshot.fetchedAt))
  ) throw new BatchProductionError('BATCH_BIBLIOGRAPHY_MISMATCH', '書誌rowsとsnapshot bytes/hash/entryが一致しません');
  let parsed: BibliographyRow[];
  try {
    parsed = parseAozoraBibliography(bibliography.csv);
  } catch {
    throw new BatchProductionError('BATCH_BIBLIOGRAPHY_MISMATCH', '書誌CSVをschemaどおり再解析できません');
  }
  if (canonicalJson(parsed) !== canonicalJson(bibliography.rows)) {
    throw new BatchProductionError('BATCH_BIBLIOGRAPHY_MISMATCH', '書誌rowsがsnapshot CSVの再解析結果と一致しません');
  }
}

function assertSelectedUrl(work: SelectedWork, authorId: string): void {
  try {
    const source = new URL(work.sourceUrl);
    const card = new URL(work.cardUrl ?? '');
    const numericId = work.workId.replace(/^0+/u, '') || '0';
    if (
      source.origin !== 'https://www.aozora.gr.jp' || card.origin !== source.origin ||
      !source.pathname.startsWith(`/cards/${authorId}/files/`) ||
      !new RegExp(`^/cards/${authorId}/files/0*${numericId}(?:_|\\.)`, 'u').test(source.pathname) ||
      card.pathname !== `/cards/${authorId}/card${numericId}.html` || source.search || source.hash || card.search || card.hash
    ) throw new Error('url mismatch');
  } catch {
    throw new BatchProductionError('BATCH_SELECTION_MISMATCH', `selected workの公式URLが不正です: ${work.workId}`);
  }
}

function assertSelectionContract(
  selection: SelectedWorkResult,
  bibliography: BatchBibliography,
  manifest: BatchManifest,
): void {
  const observation = selection.observation;
  if (
    selection.works.length !== manifest.workIds.length || observation.phase !== 'selection' ||
    observation.releaseCommit !== undefined || observation.runId !== undefined ||
    observation.bibliographySha256 !== bibliography.snapshot.csvSha256 ||
    observation.observedAt !== bibliography.snapshot.fetchedAt || observation.works.length !== manifest.workIds.length
  ) throw new BatchProductionError('BATCH_SELECTION_MISMATCH', 'selection observationが書誌snapshot/manifestと一致しません');
  for (let index = 0; index < manifest.workIds.length; index += 1) {
    const workId = manifest.workIds[index];
    const selected = selection.works[index];
    const observed = observation.works[index];
    const workRows = bibliography.rows.filter((row) => row.workId === workId);
    const authorRows = workRows.filter((row) => row.personId === manifest.author.authorId && ['著者', 'author'].includes(row.role.trim().toLowerCase()));
    if (
      !selected || !observed || selected.workId !== workId || observed.workId !== workId || authorRows.length !== 1 ||
      workRows.some((row) => ['翻訳者', 'translator'].includes(row.role.trim().toLowerCase())) ||
      workRows.some((row) => ['著者', 'author'].includes(row.role.trim().toLowerCase()) && row.personId !== manifest.author.authorId)
    ) throw new BatchProductionError('BATCH_SELECTION_MISMATCH', `書誌rowの作者・版が一意ではありません: ${workId}`);
    const row = authorRows[0]!;
    const eligibleCopyright = (value: string | undefined): boolean => ['なし', '著作権なし', 'expired', 'public-domain'].includes(value?.trim().toLowerCase() ?? '');
    if (
      !eligibleCopyright(row.personCopyright) || !eligibleCopyright(row.copyright) || row.status !== '公開中' ||
      row.language !== '日本語原著' || row.orthography !== '新字新仮名' ||
      selected.title !== row.title || selected.personId !== row.personId || selected.role !== row.role ||
      selected.copyright !== row.copyright || selected.personCopyright !== row.personCopyright ||
      selected.status !== row.status || selected.language !== row.language || selected.orthography !== row.orthography ||
      selected.sourceUrl !== row.sourceUrl || selected.cardUrl !== row.cardUrl || selected.charset !== row.charset ||
      selected.baseEdition !== row.baseEdition || selected.inputter !== row.inputter || selected.proofreader !== row.proofreader ||
      observed.title !== row.title || observed.personId !== row.personId || observed.personCopyright !== row.personCopyright ||
      observed.workCopyright !== row.copyright || observed.role !== row.role || observed.translatorPresent !== false ||
      observed.status !== row.status || observed.orthography !== row.orthography ||
      observed.sourceUrl !== row.sourceUrl || observed.cardUrl !== row.cardUrl
    ) throw new BatchProductionError('BATCH_SELECTION_MISMATCH', `selection/source provenanceが書誌rowと一致しません: ${workId}`);
    if (!selected.baseEdition?.trim() || !selected.inputter?.trim() || !selected.proofreader?.trim()) {
      throw new BatchProductionError('BATCH_PROVENANCE_MISMATCH', `selected workのprovenance metadataが不足しています: ${workId}`);
    }
    assertSelectedUrl(selected, manifest.author.authorId);
  }
}

/** @des DES-F002-004 DES-F002-014 DES-F002-015 @fun FUN-F002-007 */
export async function runBatchSourceStages(context: BatchContext, through: 'normalize'): Promise<BatchSourceResult> {
  if (through !== 'normalize') throw new BatchProductionError('BATCH_STAGE_MISMATCH', 'source runnerはnormalizeまでだけを処理します');
  const root = await verifiedWorkspace(context.workspace);
  const scratchParent = join(root, '.cache', 'batch-source');
  await mkdir(scratchParent, { recursive: true });
  await assertNoLinks(root, scratchParent);
  const scratchPath = await mkdtemp(join(scratchParent, `.${context.manifest.batchId}-${context.workId}-stage-`));
  const scratch: BatchSourceScratch = Object.freeze({ root: scratchPath });
  try {
  const index = context.manifest.workIds.indexOf(context.workId);
  if (index < 0 || context.manifest.workProgress[index]?.status !== 'pending') {
    throw new BatchProductionError('BATCH_WORK_MISMATCH', '対象workはmanifest内のpending作品である必要があります');
  }
  if (context.manifest.workProgress.slice(0, index).some((work) => work.status !== 'accepted')) {
    throw new BatchProductionError('BATCH_STAGE_ORDER_MISMATCH', '先行workがacceptedになるまで後続workを開始できません');
  }
  const completedDate = context.clock();
  if (!context.toolVersion.trim() || !Number.isFinite(completedDate.getTime())) {
    throw new BatchProductionError('BATCH_STAGE_MISMATCH', 'tool版またはclockが不正です');
  }
  const bibliography = await context.dependencies.loadBibliography(context, scratch);
  assertBibliographyContract(bibliography);
  const selection = await context.dependencies.selectWorks(bibliography, context, scratch);
  assertSelectionContract(selection, bibliography, context.manifest);
  const work = selection.works.find((item) => item.workId === context.workId);
  if (!work || selection.works.filter((item) => item.workId === context.workId).length !== 1) {
    throw new BatchProductionError('BATCH_SELECTION_MISMATCH', 'manifest workの選定結果が一意ではありません');
  }
  const fetched = await context.dependencies.fetchSource(work, context, scratch);
  if (
    fetched.record.workId !== context.workId || fetched.raw.byteLength === 0 || fetched.raw.byteLength > MAX_SOURCE_BYTES ||
    sha256(fetched.raw) !== fetched.record.rawSha256 || fetched.record.sourceUrl !== work.sourceUrl ||
    fetched.record.bibliographyCharset !== work.charset || !Number.isFinite(Date.parse(fetched.record.fetchedAt))
  ) {
    throw new BatchProductionError('BATCH_SOURCE_MISMATCH', 'source record/raw/work hashが一致しません');
  }
  const decoded = await context.dependencies.decodeSource(fetched.record, fetched.raw, context, scratch);
  if (decoded.workId !== context.workId || decoded.rawSha256 !== fetched.record.rawSha256) {
    throw new BatchProductionError('BATCH_DECODE_MISMATCH', 'decoded sourceのwork/hashが一致しません');
  }
  const rawCandidates = await context.dependencies.extractCandidates(decoded, context.workId, context, scratch);
  validateRawCandidates(rawCandidates, context.workId, fetched.record.rawSha256);
  const candidates = rawCandidates.map((raw) => normalizeBatchCandidate(raw, context.speechRules));
  const base = `data/batches/${context.manifest.batchId}/work-artifacts/${context.workId}`;
  const paths = Object.freeze({
    bibliography: posix(base, 'bibliography', 'source.json'),
    bibliographyCsv: posix(base, 'bibliography', bibliography.snapshot.csvEntry),
    selectedWorks: posix(base, 'selected-works.json'),
    sourceRecord: posix(base, 'sources', context.workId, 'source.json'),
    sourceRaw: posix(base, 'sources', context.workId, 'source.raw'),
    decoded: posix(base, 'intermediate', context.workId, 'decoded.json'),
    rawCandidates: posix(base, 'intermediate', context.workId, 'raw-candidates.json'),
    candidates: posix(base, 'intermediate', context.workId, 'candidates.json'),
  });
  const entries: BatchSourceTreeEntry[] = [
    { path: 'bibliography/source.json', bytes: jsonBytes(bibliography.snapshot) },
    { path: `bibliography/${bibliography.snapshot.csvEntry}`, bytes: bibliography.csv.slice() },
    { path: 'selected-works.json', bytes: jsonBytes(selection) },
    { path: `sources/${context.workId}/source.json`, bytes: jsonBytes(fetched.record) },
    { path: `sources/${context.workId}/source.raw`, bytes: fetched.raw.slice() },
    { path: `intermediate/${context.workId}/decoded.json`, bytes: jsonBytes(decoded) },
    { path: `intermediate/${context.workId}/raw-candidates.json`, bytes: jsonBytes(rawCandidates) },
    { path: `intermediate/${context.workId}/candidates.json`, bytes: jsonBytes(candidates) },
  ];
  if (bibliography.archive !== undefined) {
    entries.push({ path: `bibliography/${bibliography.snapshot.archivePath}`, bytes: bibliography.archive.slice() });
  }
  const artifactSha256 = treeDigest(entries);
  const completedAt = completedDate.toISOString();
  const evidence: StageEvidence = Object.freeze({
    kind: 'stage',
    expectedManifestSha: hashBatchManifest(context.manifest),
    workId: context.workId,
    stage: 'extracted',
    inputHashes: [hashBatchManifest(context.manifest), bibliography.snapshot.csvSha256 as Sha256, fetched.record.rawSha256 as Sha256],
    toolVersion: context.toolVersion,
    outputHashes: [artifactSha256, ...candidates.map((candidate) => candidate.sha256)],
    count: candidates.length,
    completedAt,
  });
  const manifest = transitionWorkState(context.manifest, context.workId, 'extracted', evidence);
  await promoteBatchSourceArtifactTree(
    root,
    base as WorkspaceRelativePath,
    entries,
    undefined,
    context.dependencies.beforePromotion,
  );
  return Object.freeze({
    manifest,
    evidence,
    candidates: Object.freeze(candidates),
    artifactRoot: base as WorkspaceRelativePath,
    artifactSha256,
    artifactPaths: paths,
  });
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}

export const DEFAULT_BATCH_SPEECH_RULES: SpeechRules = Object.freeze({
  version: SUPPORTED_SPEECH_RULE_VERSION,
  gaiji: Object.freeze({}),
  lineBreak: 'space',
  collapseWhitespace: true,
});
