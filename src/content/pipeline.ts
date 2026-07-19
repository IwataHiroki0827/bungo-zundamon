import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** @des DES-F001-017 @fun FUN-F001-033 */
export const UPDATE_STAGES = [
  'bibliography',
  'select',
  'sources',
  'provenance',
  'decode',
  'extract',
  'normalize',
  'review',
  'voice-preflight',
  'voice',
  'build',
] as const;

export type UpdateStage = (typeof UPDATE_STAGES)[number];

export const PIPELINE_REASON_CODES = [
  'PIPELINE_INVALID_INPUT',
  'PIPELINE_WORKSPACE_BOUNDARY',
  'PIPELINE_UNSUPPORTED_STAGE',
  'PIPELINE_HASH_MISMATCH',
  'PIPELINE_REFERENCE_MISSING',
  'PIPELINE_NETWORK_TIMEOUT',
  'PIPELINE_NETWORK_FAILURE',
  'PIPELINE_FILESYSTEM_BUSY',
  'PIPELINE_STAGE_FAILED',
  'PIPELINE_UNKNOWN',
] as const;

export type PipelineReasonCode = (typeof PIPELINE_REASON_CODES)[number];

export interface Diagnostic {
  readonly reasonCode: PipelineReasonCode;
  readonly stage: UpdateStage;
  readonly retryable: boolean;
}

export interface VoiceItemFailure {
  readonly audioId: string;
  readonly candidateIds: readonly string[];
  readonly reasonCode: string;
}

export interface PublicTreePromotion {
  readonly stagingPath: string;
  readonly targetPath: string;
}

export interface StageResult {
  readonly hash: string;
  readonly count: number;
  readonly voiceFailures?: readonly VoiceItemFailure[];
  readonly publicTree?: PublicTreePromotion;
}

export interface StageSummary {
  readonly stage: UpdateStage;
  readonly hash: string;
  readonly count: number;
}

export interface StageContext {
  readonly workspace: string;
  readonly completed: readonly StageSummary[];
  readonly voiceFailures: readonly VoiceItemFailure[];
  readonly registerTemporaryPath?: (path: string) => void;
}

export type StageRunner = (
  stage: UpdateStage,
  context: StageContext,
) => Promise<StageResult> | StageResult;

export interface PipelineFileSystem {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface UpdateOptions {
  readonly workspace: string;
  readonly runner: StageRunner;
  readonly stages?: readonly UpdateStage[];
  readonly stage?: UpdateStage;
  readonly inputPaths?: readonly string[];
  readonly outputPaths?: readonly string[];
  readonly fileSystem?: PipelineFileSystem;
}

export interface UpdateSummary {
  readonly stages: readonly StageSummary[];
  readonly hashes: Readonly<Partial<Record<UpdateStage, string>>>;
  readonly counts: Readonly<Partial<Record<UpdateStage, number>>>;
  readonly voiceFailures: readonly VoiceItemFailure[];
}

type ErrorWithCode = { readonly code?: unknown; readonly reasonCode?: unknown };

const defaultPipelineFileSystem: PipelineFileSystem = {
  lstat,
  realpath,
  rename,
  rm: (path) => rm(path, { recursive: true, force: true }),
};

const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EBUSY']);
const RETRYABLE_REASONS = new Set<PipelineReasonCode>([
  'PIPELINE_NETWORK_TIMEOUT',
  'PIPELINE_NETWORK_FAILURE',
  'PIPELINE_FILESYSTEM_BUSY',
]);
const REASON_CODE_SET = new Set<string>(PIPELINE_REASON_CODES);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** @des DES-F001-019 @fun FUN-F001-036 */
export function mapPipelineError(error: unknown, stage: UpdateStage): Diagnostic {
  const code = isErrorWithCode(error) ? error.code : undefined;
  const suppliedReason = isErrorWithCode(error) ? error.reasonCode : undefined;

  let reasonCode: PipelineReasonCode = 'PIPELINE_UNKNOWN';
  let retryable = false;

  if (typeof suppliedReason === 'string' && REASON_CODE_SET.has(suppliedReason)) {
    reasonCode = suppliedReason as PipelineReasonCode;
    retryable = RETRYABLE_REASONS.has(reasonCode);
  } else if (typeof code === 'string') {
    if (code === 'ETIMEDOUT') reasonCode = 'PIPELINE_NETWORK_TIMEOUT';
    else if (code === 'ECONNRESET' || code === 'EAI_AGAIN') reasonCode = 'PIPELINE_NETWORK_FAILURE';
    else if (code === 'EBUSY') reasonCode = 'PIPELINE_FILESYSTEM_BUSY';
    else if (code === 'ENOENT') reasonCode = 'PIPELINE_REFERENCE_MISSING';
    retryable = RETRYABLE_CODES.has(code);
  }

  return Object.freeze({ reasonCode, stage, retryable });
}

export class PipelineRunError extends Error {
  readonly diagnostic: Diagnostic;
  readonly completed: readonly StageSummary[];

  constructor(diagnostic: Diagnostic, completed: readonly StageSummary[]) {
    super(`content-update-failed:${diagnostic.stage}:${diagnostic.reasonCode}`);
    this.name = 'PipelineRunError';
    this.diagnostic = diagnostic;
    this.completed = Object.freeze([...completed]);
  }
}

/** @des DES-F001-004 @des DES-F001-017 @des DES-F001-019 @fun FUN-F001-033 */
export async function runContentUpdate(options: UpdateOptions): Promise<UpdateSummary> {
  const fileSystem = options.fileSystem ?? defaultPipelineFileSystem;
  const completed: StageSummary[] = [];
  const temporaryPaths = new Set<string>();
  let currentStage: UpdateStage = 'bibliography';

  try {
    const workspace = await resolveSafeWorkspace(options.workspace, fileSystem);
    await validateDeclaredPaths(workspace, options.inputPaths ?? [], false, fileSystem);
    await validateDeclaredPaths(workspace, options.outputPaths ?? [], true, fileSystem);
    const stages = resolveStages(options);
    const failures: VoiceItemFailure[] = [];

    for (const stage of stages) {
      currentStage = stage;
      const result = await options.runner(stage, {
        workspace,
        completed: Object.freeze([...completed]),
        voiceFailures: Object.freeze([...failures]),
        registerTemporaryPath: (path) => {
          const temporary = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
          assertDescendant(workspace, temporary);
          temporaryPaths.add(temporary);
        },
      });
      assertStageResult(result);

      if (result.voiceFailures !== undefined) {
        if (stage !== 'voice') throw pipelineError('PIPELINE_INVALID_INPUT');
        failures.push(...validateVoiceFailures(result.voiceFailures));
      }

      if (result.publicTree !== undefined) {
        if (stage !== 'build') throw pipelineError('PIPELINE_INVALID_INPUT');
        await promotePublicTree(workspace, result.publicTree, fileSystem);
      }

      completed.push(Object.freeze({ stage, hash: result.hash, count: result.count }));
    }

    return buildSummary(completed, failures);
  } catch (error) {
    if (error instanceof PipelineRunError) throw error;
    throw new PipelineRunError(mapPipelineError(error, currentStage), completed);
  } finally {
    await Promise.all([...temporaryPaths].map(async (path) => {
      try {
        await fileSystem.rm(path);
      } catch {
        // 登録済み一時pathは公開先ではない。cleanup失敗は元のstage診断を上書きしない。
      }
    }));
  }
}

export interface ProvenanceManifest {
  readonly schemaVersion: string | number;
  readonly bibliography: ProvenanceBibliography;
  readonly works: readonly ProvenanceWork[];
  readonly sourceHashes: unknown;
  readonly toolVersions: unknown;
  readonly generatedAt: string;
  readonly transformations: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface ProvenanceBibliography {
  readonly sourceUrl: string;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly csvEntry: string;
  readonly csvSha256: string;
  readonly csvBytes: number;
  readonly schemaVersion: string;
}

export interface ProvenanceWork {
  readonly workId: string;
  readonly bibliography: ProvenanceBibliography;
  readonly [key: string]: unknown;
}

export interface ProvenanceWriteOptions {
  readonly workspace?: string;
  readonly expectedMtimeMs?: number | null;
  readonly beforeCommit?: () => void;
  readonly rename?: (from: string, to: string) => void;
}

/** @des DES-F001-004 @des DES-F001-017 @fun FUN-F001-034 */
export function writeProvenanceAtomic(
  path: string,
  record: ProvenanceManifest,
  options: ProvenanceWriteOptions = {},
): void {
  const target = resolveProvenanceTarget(path, options.workspace);
  validateProvenanceManifest(record);
  const initialFingerprint = fileFingerprint(target);

  if (
    options.expectedMtimeMs !== undefined &&
    options.expectedMtimeMs !== initialFingerprint?.mtimeMs
  ) {
    throw pipelineError('PIPELINE_FILESYSTEM_BUSY');
  }

  const workspace = resolve(options.workspace ?? join(dirname(target), '..'));
  assertNoSymbolicLink(workspace, target);
  mkdirSync(dirname(target), { recursive: true });
  assertNoSymbolicLink(workspace, target);
  const temporary = join(dirname(target), `.${randomUUID()}.provenance.tmp`);

  try {
    writeFileSync(temporary, `${stableStringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
    options.beforeCommit?.();
    if (!sameFingerprint(initialFingerprint, fileFingerprint(target))) {
      throw pipelineError('PIPELINE_FILESYSTEM_BUSY');
    }
    (options.rename ?? renameSync)(temporary, target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function resolveStages(options: UpdateOptions): readonly UpdateStage[] {
  if (options.stage !== undefined && options.stages !== undefined) {
    throw pipelineError('PIPELINE_INVALID_INPUT');
  }
  const requested: readonly unknown[] = options.stage !== undefined
    ? [options.stage]
    : (options.stages ?? UPDATE_STAGES);
  if (requested.length === 0) throw pipelineError('PIPELINE_INVALID_INPUT');

  let lastIndex = -1;
  const result: UpdateStage[] = [];
  for (const value of requested) {
    const index = UPDATE_STAGES.indexOf(value as UpdateStage);
    if (index < 0) throw pipelineError('PIPELINE_UNSUPPORTED_STAGE');
    if (index <= lastIndex) throw pipelineError('PIPELINE_INVALID_INPUT');
    result.push(UPDATE_STAGES[index] as UpdateStage);
    lastIndex = index;
  }
  return Object.freeze(result);
}

async function resolveSafeWorkspace(
  workspace: string,
  fileSystem: PipelineFileSystem,
): Promise<string> {
  if (!isAbsolute(workspace)) throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  const lexical = resolve(workspace);
  const info = await fileSystem.lstat(lexical);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  }
  const physical = await fileSystem.realpath(lexical);
  if (resolve(physical) !== lexical) throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  return physical;
}

async function validateDeclaredPaths(
  workspace: string,
  paths: readonly string[],
  allowMissing: boolean,
  fileSystem: PipelineFileSystem,
): Promise<void> {
  for (const path of paths) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
    assertDescendant(workspace, absolute);
    const existing = await nearestExistingPath(absolute, fileSystem);
    const info = await fileSystem.lstat(existing);
    if (info.isSymbolicLink()) throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
    const physical = await fileSystem.realpath(existing);
    assertDescendant(workspace, physical, true);
    if (!allowMissing && existing !== absolute) throw pipelineError('PIPELINE_REFERENCE_MISSING');
  }
}

async function nearestExistingPath(path: string, fileSystem: PipelineFileSystem): Promise<string> {
  let cursor = path;
  for (;;) {
    try {
      await fileSystem.lstat(cursor);
      return cursor;
    } catch (error) {
      if (!isErrorWithCode(error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

async function promotePublicTree(
  workspace: string,
  promotion: PublicTreePromotion,
  fileSystem: PipelineFileSystem,
): Promise<void> {
  const staging = resolve(workspace, promotion.stagingPath);
  const target = resolve(workspace, promotion.targetPath);
  assertDescendant(workspace, staging);
  assertDescendant(workspace, target);
  if (staging === target) throw pipelineError('PIPELINE_INVALID_INPUT');
  await validateDeclaredPaths(workspace, [staging, target], true, fileSystem);
  const stagingInfo = await fileSystem.lstat(staging);
  if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) {
    throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  }

  const backup = `${target}.previous-${randomUUID()}`;
  const rejected = `${target}.rejected-${randomUUID()}`;
  let oldMoved = false;
  let newMoved = false;
  try {
    try {
      await fileSystem.lstat(target);
      await fileSystem.rename(target, backup);
      oldMoved = true;
    } catch (error) {
      if (!isErrorWithCode(error) || error.code !== 'ENOENT') throw error;
    }
    await fileSystem.rename(staging, target);
    newMoved = true;
    if (oldMoved) {
      try {
        await fileSystem.rm(backup);
      } catch {
        // The public tree is already committed; stale backup cleanup is retryable maintenance.
      }
    }
  } catch (error) {
    oldMoved ||= await pathExists(backup, fileSystem);
    newMoved ||= await pathExists(target, fileSystem) && !(await pathExists(staging, fileSystem));
    if (newMoved) {
      try {
        await fileSystem.rename(target, rejected);
      } catch {
        // The restoration below is still attempted; its failure remains fatal and sanitized.
      }
    }
    if (oldMoved) {
      try {
        await fileSystem.rename(backup, target);
      } catch {
        throw pipelineError('PIPELINE_STAGE_FAILED');
      }
    }
    try {
      await fileSystem.rm(rejected);
    } catch {
      // Best-effort removal of an uncommitted tree; no published path points to it.
    }
    try {
      await fileSystem.rm(staging);
    } catch {
      // Best-effort cleanup. A staging path is never used as the published path.
    }
    throw error;
  }
}

async function pathExists(path: string, fileSystem: PipelineFileSystem): Promise<boolean> {
  try {
    await fileSystem.lstat(path);
    return true;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertStageResult(value: StageResult): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    !SHA256_PATTERN.test(value.hash) ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  ) {
    throw pipelineError('PIPELINE_INVALID_INPUT');
  }
}

function validateVoiceFailures(values: readonly VoiceItemFailure[]): VoiceItemFailure[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.audioId !== 'string' ||
      value.audioId.length === 0 ||
      !Array.isArray(value.candidateIds) ||
      value.candidateIds.some((id) => typeof id !== 'string' || id.length === 0) ||
      typeof value.reasonCode !== 'string' ||
      !/^[A-Z][A-Z0-9_]{1,63}$/u.test(value.reasonCode)
    ) {
      throw pipelineError('PIPELINE_INVALID_INPUT');
    }
    return Object.freeze({
      audioId: value.audioId,
      candidateIds: Object.freeze([...value.candidateIds]),
      reasonCode: value.reasonCode,
    });
  });
}

function buildSummary(
  stages: readonly StageSummary[],
  voiceFailures: readonly VoiceItemFailure[],
): UpdateSummary {
  const hashes: Partial<Record<UpdateStage, string>> = {};
  const counts: Partial<Record<UpdateStage, number>> = {};
  for (const result of stages) {
    hashes[result.stage] = result.hash;
    counts[result.stage] = result.count;
  }
  return Object.freeze({
    stages: Object.freeze([...stages]),
    hashes: Object.freeze(hashes),
    counts: Object.freeze(counts),
    voiceFailures: Object.freeze([...voiceFailures]),
  });
}

function resolveProvenanceTarget(path: string, workspace?: string): string {
  if (!isAbsolute(path)) throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  const target = resolve(path);
  if (workspace !== undefined && !isAbsolute(workspace)) throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  const inferredWorkspace = resolve(workspace ?? join(dirname(target), '..'));
  if (target !== join(inferredWorkspace, 'content', 'provenance.json')) {
    throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  }
  assertDescendant(inferredWorkspace, target);
  if (!existsSync(inferredWorkspace)) throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  const info = lstatSync(inferredWorkspace);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  }
  if (realpathSync(inferredWorkspace) !== inferredWorkspace) {
    throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  }
  return target;
}

function validateProvenanceManifest(record: ProvenanceManifest): void {
  if (
    record === null ||
    typeof record !== 'object' ||
    (typeof record.schemaVersion !== 'string' && typeof record.schemaVersion !== 'number') ||
    !Array.isArray(record.works) ||
    record.works.length !== 3 ||
    record.sourceHashes === null ||
    typeof record.sourceHashes !== 'object' ||
    record.toolVersions === null ||
    typeof record.toolVersions !== 'object' ||
    typeof record.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.generatedAt)) ||
    !Array.isArray(record.transformations) ||
    record.transformations.length === 0
  ) {
    throw pipelineError('PIPELINE_INVALID_INPUT');
  }
  const bibliography = validateManifestBibliography(record.bibliography);
  const expectedWorkIds = new Set(['000127', '000092', '043015']);
  const seen = new Set<string>();
  for (const work of record.works) {
    if (work === null || typeof work !== 'object' || typeof work.workId !== 'string' || !expectedWorkIds.has(work.workId) || seen.has(work.workId)) {
      throw pipelineError('PIPELINE_INVALID_INPUT');
    }
    seen.add(work.workId);
    const workBibliography = validateManifestBibliography(work.bibliography);
    if (!sameBibliography(bibliography, workBibliography)) throw pipelineError('PIPELINE_HASH_MISMATCH');
  }
  if (seen.size !== expectedWorkIds.size) throw pipelineError('PIPELINE_INVALID_INPUT');
}

function validateManifestBibliography(value: unknown): ProvenanceBibliography {
  if (value === null || typeof value !== 'object') throw pipelineError('PIPELINE_INVALID_INPUT');
  const candidate = value as Partial<ProvenanceBibliography>;
  if (
    candidate.sourceUrl !== 'https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip' ||
    candidate.csvEntry !== 'list_person_all_extended_utf8.csv' ||
    typeof candidate.archiveSha256 !== 'string' || !SHA256_PATTERN.test(candidate.archiveSha256) ||
    typeof candidate.csvSha256 !== 'string' || !SHA256_PATTERN.test(candidate.csvSha256) ||
    !Number.isSafeInteger(candidate.archiveBytes) || (candidate.archiveBytes ?? 0) <= 0 ||
    !Number.isSafeInteger(candidate.csvBytes) || (candidate.csvBytes ?? 0) <= 0 ||
    typeof candidate.schemaVersion !== 'string' || candidate.schemaVersion.trim().length === 0
  ) {
    throw pipelineError('PIPELINE_INVALID_INPUT');
  }
  return candidate as ProvenanceBibliography;
}

function sameBibliography(left: ProvenanceBibliography, right: ProvenanceBibliography): boolean {
  return (
    left.sourceUrl === right.sourceUrl &&
    left.archiveSha256 === right.archiveSha256 &&
    left.archiveBytes === right.archiveBytes &&
    left.csvEntry === right.csvEntry &&
    left.csvSha256 === right.csvSha256 &&
    left.csvBytes === right.csvBytes &&
    left.schemaVersion === right.schemaVersion
  );
}

function assertNoSymbolicLink(workspace: string, target: string): void {
  assertDescendant(workspace, target);
  if (!existsSync(workspace)) throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  const workspaceInfo = lstatSync(workspace);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() || realpathSync(workspace) !== resolve(workspace)) {
    throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  }
  let cursor = workspace;
  const parts = relative(workspace, target).split(sep);
  for (const part of parts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) continue;
    if (lstatSync(cursor).isSymbolicLink()) throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  }
}

function assertDescendant(workspace: string, path: string, allowRoot = false): void {
  const child = relative(resolve(workspace), resolve(path));
  if ((!allowRoot && child === '') || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw pipelineError('PIPELINE_WORKSPACE_BOUNDARY');
  }
}

interface FileFingerprint {
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
}

function fileFingerprint(path: string): FileFingerprint | null {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFingerprint(left: FileFingerprint | null, right: FileFingerprint | null): boolean {
  if (left === null || right === null) return left === right;
  return left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino;
}

function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw pipelineError('PIPELINE_INVALID_INPUT');
      return current;
    }
    if (typeof current !== 'object') throw pipelineError('PIPELINE_INVALID_INPUT');
    if (seen.has(current)) throw pipelineError('PIPELINE_INVALID_INPUT');
    seen.add(current);
    try {
      if (Array.isArray(current)) return current.map(normalize);
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw pipelineError('PIPELINE_INVALID_INPUT');
      }
      return Object.fromEntries(
        Object.entries(current)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    } finally {
      seen.delete(current);
    }
  };
  return JSON.stringify(normalize(value));
}

function pipelineError(reasonCode: PipelineReasonCode): ErrorWithCode {
  return Object.freeze({ reasonCode });
}

function isErrorWithCode(value: unknown): value is ErrorWithCode {
  return value !== null && typeof value === 'object';
}
