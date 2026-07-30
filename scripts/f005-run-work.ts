import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  ensureJsonArtifactDurable,
  fingerprintArtifact,
  type ArtifactDirectorySync,
  writeJsonArtifactAtomic,
} from '../src/content/artifacts.ts';
import { resolveF005NativeGuardExecutable } from '../src/content/f005-source.ts';
import {
  hashBatchManifest,
  transitionWorkState,
  validateBatchManifest,
  writeBatchManifestAtomic,
  type BatchManifest,
  type Sha256,
  type StageEvidence,
  type WorkId,
  type WorkStatus,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  createF005AcceptanceCapacityRecorder,
  finalizeF005WorkAcceptance,
  prepareF005WorkAcceptance,
  prepareF005WorkPreview,
  stageF005WorkAcceptance,
  type F005ArtifactRef,
  type F005AcceptedWork,
  type F005EvidenceKind,
  type F005EvidenceRef,
  type F005PreviewArtifactKind,
  type F005PreviewArtifacts,
  type F005StagedWork,
} from '../src/content/f005-acceptance.ts';
import { loadVerifiedF005Definition } from '../src/content/f005-context.ts';
import {
  f005CapacityCandidateSha256,
  loadV040Baseline,
  type CapacityEntry,
  type CapacityForecastV3,
} from '../src/content/f005-foundation.ts';
import {
  flushF005ArtifactDirectory,
  isF005SystemSetInfoDiagnosticCode,
  startF005NativeCapacitySession,
  type F005NativeCapacityErrorCode,
} from '../src/content/f005-native-guard.ts';
import {
  createF005CapacityRecorder,
  createF005NativeCapacityJournalReader,
  F005_VOICE_LIMITS,
  generateF005Voice,
  measureF005ActualCapacity,
  planF005VoiceDiff,
  type F005LoopbackEngine,
  type F005SpeechItem,
  type F005VoiceGenerationProgress,
} from '../src/content/f005-voice.ts';
import { F002_VOICE_CONFIG } from '../src/voice/f003.ts';
import type { VoicevoxSpeaker } from '../src/voice/types.ts';

const WORK_IDS = ['000799', '001076', '001104'] as const;
const MANIFEST_PATH = 'content/batches/F005/batch.json';
const OWNER = 'f005-production-runner';
export const F005_RUNNER_RESULT_PREFIX = 'F005_RESULT_JSON=';
export const F005_RUNNER_PROGRESS_PREFIX = 'F005_PROGRESS=';
export const F005_RUNNER_FAILURE_PREFIX = 'F005_FAILURE_JSON=';
export const F005_VOICE_PROGRESS_PREFIX = 'F005_VOICE_PROGRESS=';

type F005RunnerProgress =
  | 'context-loaded'
  | 'voice-generated'
  | 'offline-build-complete'
  | 'preview-prepared'
  | 'acceptance-staged'
  | 'session-close-start'
  | 'session-closed'
  | 'actual-measured'
  | 'acceptance-finalized'
  | 'result-writing';

function sha(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function inside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || (value !== '..' && !value.startsWith(`..\\`) && !value.startsWith('../'));
}

async function canonicalArtifact<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function treeDigest(root: string): Promise<Sha256> {
  const rows: Array<{ path: string; bytes: number; sha256: Sha256 }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`public tree内にlinkがあります: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(path));
        rows.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: bytes.byteLength,
          sha256: sha(bytes),
        });
      }
    }
  };
  await walk(root);
  return sha(canonicalJson(rows));
}

interface F005TreeMeasurement {
  readonly treeSha256: Sha256;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export const F005_RUNNER_PHASE_ORDER =
  ['voice', 'build', 'preview', 'build', 'accept'] as const;

export function createF005OfflineBuildArtifactPayloads(input: {
  readonly manifestSha256: Sha256;
  readonly baselineDescriptorSha256: Sha256;
  readonly expectedPublicTreeSha256: Sha256;
  readonly publicMeasurement: F005TreeMeasurement;
  readonly distMeasurement: F005TreeMeasurement;
}): Readonly<Record<F005PreviewArtifactKind, unknown>> {
  if (input.publicMeasurement.treeSha256 !== input.expectedPublicTreeSha256 ||
    input.publicMeasurement.fileCount <= 0 || input.publicMeasurement.totalBytes <= 0 ||
    input.distMeasurement.fileCount <= 0 || input.distMeasurement.totalBytes <= 0) {
    throw new Error('offline buildの実測tree bindingが不正です');
  }
  return Object.freeze({
    'content-build': {
      command: 'node scripts/build-offline.mjs',
      manifestSha256: input.manifestSha256,
      public: input.publicMeasurement,
      dist: input.distMeasurement,
    },
    'content-staging': {
      root: 'public',
      manifestSha256: input.manifestSha256,
      measurement: input.publicMeasurement,
    },
    dist: {
      root: 'dist',
      manifestSha256: input.manifestSha256,
      measurement: input.distMeasurement,
    },
    'f001-content-invariant-report': {
      result: 'pass',
      baselineDescriptorSha256: input.baselineDescriptorSha256,
      expectedPublicTreeSha256: input.expectedPublicTreeSha256,
      actualPublicTreeSha256: input.publicMeasurement.treeSha256,
    },
    'f001-dist-invariant-report': {
      result: 'pass',
      baselineDescriptorSha256: input.baselineDescriptorSha256,
      contentBuildSha256: input.publicMeasurement.treeSha256,
      distSha256: input.distMeasurement.treeSha256,
    },
  });
}

export async function writeCanonicalArtifact(
  workspace: string,
  path: string,
  value: unknown,
  directorySync: ArtifactDirectorySync = flushF005ArtifactDirectory,
): Promise<Sha256> {
  const expectedText = canonicalJson(value);
  const initial = await fingerprintArtifact(path);
  if (initial !== null) {
    const current = await readFile(path, 'utf8');
    if (current !== expectedText) {
      throw new Error(`既存artifactが現在のtupleと異なります: ${path}`);
    }
    await ensureJsonArtifactDurable(workspace, path, expectedText, directorySync);
    return sha(current);
  }
  await writeJsonArtifactAtomic(workspace, path, value, {
    directorySync,
    expectedFingerprint: null,
  });
  const actual = await readFile(path, 'utf8');
  if (actual !== expectedText) throw new Error(`artifact post-readが一致しません: ${path}`);
  return sha(actual);
}

async function measureTree(root: string): Promise<F005TreeMeasurement> {
  const rows: Array<{ path: string; bytes: number; sha256: Sha256 }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`build tree内にlinkがあります: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(path));
        rows.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: bytes.byteLength,
          sha256: sha(bytes),
        });
      }
    }
  };
  await walk(root);
  return {
    treeSha256: sha(canonicalJson(rows)),
    fileCount: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  };
}

export function parseF005RunWorkArguments(argv: readonly string[]): WorkId {
  const flag = argv.indexOf('--work');
  const value = flag >= 0 ? argv[flag + 1] : argv[0];
  if (!value || !WORK_IDS.includes(value as typeof WORK_IDS[number])) {
    throw new Error(`usage: f005-run-work.ts --work ${WORK_IDS.join('|')}`);
  }
  return value as WorkId;
}

export function selectF005CurrentWork(
  manifest: BatchManifest,
  requestedWorkId: WorkId,
): { readonly workId: WorkId; readonly acceptedWorkIds: readonly WorkId[] } {
  const currentIndex = manifest.workProgress.findIndex((work) => work.status !== 'accepted');
  if (currentIndex < 0) throw new Error('F005の全作品はaccepted済みです');
  const current = manifest.workProgress[currentIndex];
  if (!current || current.workId !== requestedWorkId ||
    manifest.workProgress.slice(0, currentIndex).some((work) => work.status !== 'accepted') ||
    manifest.workProgress.slice(currentIndex + 1).some((work) => work.status !== 'pending')) {
    throw new Error('requested workはmanifest順の現在workではありません');
  }
  return {
    workId: requestedWorkId,
    acceptedWorkIds: manifest.workProgress.slice(0, currentIndex).map((work) => work.workId),
  };
}

export async function enterF005ProductionSession<Prepared, Session, Result>(
  readOnly: () => Promise<Prepared>,
  startSession: (prepared: Prepared) => Promise<Session>,
  mutate: (prepared: Prepared, session: Session) => Promise<Result>,
): Promise<Result> {
  const prepared = await readOnly();
  const session = await startSession(prepared);
  return mutate(prepared, session);
}

export function verifyF005RunnerCandidateBinding(
  candidateText: string,
  forecastCandidateSha256: Sha256,
  approvedContextCandidateSha256: string,
): Sha256 {
  let candidateValue: unknown;
  try {
    candidateValue = JSON.parse(candidateText) as unknown;
  } catch {
    throw new Error('candidate artifact JSONが不正です');
  }
  if (canonicalJson(candidateValue) !== candidateText) {
    throw new Error('candidate artifactがcanonical JSONではありません');
  }
  if (forecastCandidateSha256 !== approvedContextCandidateSha256) {
    throw new Error('capacity forecastのcandidate SHAがApproved Contextと一致しません');
  }
  return forecastCandidateSha256;
}

export function formatF005RunnerResult(value: Readonly<Record<string, unknown>>): string {
  return `\n${F005_RUNNER_RESULT_PREFIX}${JSON.stringify(value)}\n`;
}

export function formatF005RunnerProgress(stage: F005RunnerProgress): string {
  return `${F005_RUNNER_PROGRESS_PREFIX}${stage}\n`;
}

export function formatF005VoiceProgress(stage: F005VoiceGenerationProgress): string {
  return `${F005_VOICE_PROGRESS_PREFIX}${stage}\n`;
}

export async function resolveF005ExternalNativeGuardExecutable(
  workspace: string,
  configured: string | undefined,
): Promise<string | undefined> {
  if (configured === undefined) return undefined;
  return resolveF005NativeGuardExecutable(workspace, configured);
}

type F005RunnerStageExtra = Pick<
  StageEvidence,
  'pendingCount' | 'forecastRef' | 'voiceEvidenceRef'
>;

export function advanceF005RunnerManifest(
  manifest: BatchManifest,
  workId: WorkId,
  stage: 'extracted' | 'reviewed' | 'budget-approved' | 'voiced',
  output: Sha256,
  count: number,
  extra: F005RunnerStageExtra = {},
  completedAt: string = new Date().toISOString(),
): BatchManifest {
  const stageOrder = ['pending', 'extracted', 'reviewed', 'budget-approved', 'voiced'] as const;
  const current = manifest.workProgress[manifest.workIds.indexOf(workId)];
  if (!current) throw new Error('current workがmanifestにありません');
  const currentRank = stageOrder.indexOf(current.status as typeof stageOrder[number]);
  const nextRank = stageOrder.indexOf(stage);
  if (currentRank >= nextRank) {
    const existing = current.stageRecords.find((record) => record.stage === stage);
    const sameOutput = existing?.outputHashes.length === 1 && existing.outputHashes[0] === output;
    const sameStageBinding =
      existing?.count === count &&
      existing.toolVersion === 'f005-production-runner-v1' &&
      (stage !== 'reviewed' || extra.pendingCount === 0) &&
      (stage !== 'budget-approved' || current.forecastRef === extra.forecastRef) &&
      (stage !== 'voiced' || current.voiceEvidenceRef === extra.voiceEvidenceRef);
    if (!sameOutput || !sameStageBinding) {
      throw new Error('runner stage再開証跡が今回入力と一致しません');
    }
    return manifest;
  }
  if (nextRank !== currentRank + 1) throw new Error('runner stage順が不正です');
  const expectedManifestSha = hashBatchManifest(manifest);
  const previousOutputs = current.stageRecords.at(-1)?.outputHashes ?? [];
  return transitionWorkState(manifest, workId, stage, {
    ...extra,
    kind: 'stage',
    stage,
    expectedManifestSha,
    workId,
    result: 'pass',
    inputHashes: [expectedManifestSha, ...previousOutputs],
    outputHashes: [output],
    count,
    toolVersion: 'f005-production-runner-v1',
    completedAt,
  });
}

function readErrorField(error: Error, field: 'name' | 'stack' | 'cause' | 'code'): unknown {
  try {
    return (error as unknown as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

const F005_FAILURE_NAMES = new Set([
  'AbortError',
  'AggregateError',
  'Error',
  'F005NativeCapacityError',
  'F005RunnerEngineError',
  'F005VoiceError',
  'RangeError',
  'SyntaxError',
  'TypeError',
]);
const F005_FAILURE_CODES = new Set([
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EIO',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_INVALID_ARG_TYPE',
  'F005_CANDIDATE_UNSAFE',
  'F005_CAPACITY_ACTUAL_INVALID',
  'F005_CAPACITY_ETW_OBSERVATION_FAILED',
  'F005_CAPACITY_GUARD_REJECTED',
  'F005_CAPACITY_IPC_FAILED',
  'F005_CAPACITY_IPC_CONNECT_FAILED',
  'F005_CAPACITY_REGISTER_SELF_FAILED',
  'F005_CAPACITY_PROCESS_IDENTITY_PROBE_ARM_FAILED',
  'F005_CAPACITY_PROCESS_IDENTITY_PROBE_WRITE_FAILED',
  'F005_CAPACITY_PROCESS_IDENTITY_PROBE_VERIFY_FAILED',
  'F005_CAPACITY_JOURNAL_INVALID',
  'F005_CAPACITY_NOTICE_UNMATCHED',
  'F005_DIRECTORY_SYNC_FAILED',
  'F005_ENGINE_AUDIO_QUERY_PARSE_FAILED',
  'F005_ENGINE_AUDIO_QUERY_REQUEST_FAILED',
  'F005_ENGINE_SPEAKERS_PARSE_FAILED',
  'F005_ENGINE_SPEAKERS_REQUEST_FAILED',
  'F005_ENGINE_SYNTHESIS_BODY_FAILED',
  'F005_ENGINE_SYNTHESIS_REQUEST_FAILED',
  'F005_ENGINE_VERSION_PARSE_FAILED',
  'F005_ENGINE_VERSION_REQUEST_FAILED',
  'F005_VOICE_GENERATION_INVALID',
  'F005_VOICE_NATIVE_BEGIN_FAILED',
  'F005_VOICE_NATIVE_END_FAILED',
  'F005_VOICE_NATIVE_OBSERVE_FAILED',
  'F005_VOICE_PLAN_INVALID',
  'F005_ETW_PRIVILEGE_REQUIRED',
  'F005_ETW_PROCESS_START_KEY_MISSING',
  'F005_ETW_PROCESS_START_KEY_PROBE_FAILED',
  'F005_ETW_PROCESS_START_KEY_PROBE_IDENTITY_MISMATCH',
  'F005_ETW_PROCESS_START_KEY_PROBE_REQUIRED',
  'F005_ETW_PROCESS_START_KEY_PROBE_TIMEOUT',
  'F005_ETW_ALLOCATED_LENGTH_MISSING',
  'F005_ETW_BUFFER_LOSS',
  'F005_ETW_CALLBACK_FAILED',
  'F005_ETW_CALLBACK_ACCESS_FAILED',
  'F005_ETW_CALLBACK_ARGUMENT_FAILED',
  'F005_ETW_CALLBACK_AUTHORIZATION_FAILED',
  'F005_ETW_CALLBACK_CAPACITY_FAILED',
  'F005_ETW_CALLBACK_CORRELATION_FAILED',
  'F005_ETW_CALLBACK_DISPOSED',
  'F005_ETW_CALLBACK_IDENTITY_FAILED',
  'F005_ETW_CALLBACK_IO_FAILED',
  'F005_ETW_CALLBACK_JOURNAL_FAILED',
  'F005_ETW_CALLBACK_LOCK_STATE_FAILED',
  'F005_ETW_CALLBACK_NORMALIZE_FAILED',
  'F005_ETW_CALLBACK_OVERFLOW',
  'F005_ETW_CALLBACK_PHASE_FAILED',
  'F005_ETW_CALLBACK_RECORD_FAILED',
  'F005_ETW_CALLBACK_STATE_FAILED',
  'F005_ETW_CONSUMER_FAILED',
  'F005_ETW_CONSUMER_DRAIN_FAILED',
  'F005_ETW_CONSUMER_DRAIN_TIMEOUT',
  'F005_ETW_CONSUMER_STOP_TIMEOUT',
  'F005_ETW_EVENT_OUTSIDE_PHASE',
  'F005_ETW_EVENT_PHASE_TIMESTAMP_MISMATCH',
  'F005_ETW_FILE_IDENTITY_MISSING',
  'F005_ETW_FILE_IDENTITY_MISSING_CREATE_CORRELATION',
  'F005_ETW_FILE_IDENTITY_MISSING_CREATE_IDENTITY',
  'F005_ETW_FILE_IDENTITY_MISSING_DELETE_CORRELATION',
  'F005_ETW_FILE_IDENTITY_MISSING_DELETE_IDENTITY',
  'F005_ETW_FILE_IDENTITY_MISSING_RENAME_CORRELATION',
  'F005_ETW_FILE_IDENTITY_MISSING_RENAME_IDENTITY',
  'F005_ETW_FILE_IDENTITY_MISSING_SETINFO_CORRELATION',
  'F005_ETW_FILE_IDENTITY_MISSING_SETINFO_IDENTITY',
  'F005_ETW_FILE_IDENTITY_MISSING_WRITE_CORRELATION',
  'F005_ETW_FILE_IDENTITY_MISSING_WRITE_IDENTITY',
  'F005_ETW_FILE_IDENTITY_UNSAFE',
  'F005_ETW_OBSERVATION_MISSING',
  'F005_ETW_PID_NOT_JOB_MEMBER',
  'F005_ETW_PID_NOT_JOB_MEMBER_BIRTH_MISSING',
  'F005_ETW_PID_NOT_JOB_MEMBER_BIRTH_MISSING_BOUND_FILE_OBJECT',
  'F005_ETW_PID_NOT_JOB_MEMBER_EVENT_BEFORE_BIRTH',
  'F005_ETW_PID_NOT_JOB_MEMBER_EVENT_KEY_MISMATCH',
  'F005_ETW_PID_NOT_JOB_MEMBER_PROCESS_IDENTITY_UNAVAILABLE',
  'F005_ETW_PID_NOT_JOB_MEMBER_PROCESS_UNAVAILABLE',
  'F005_ETW_PID_NOT_JOB_MEMBER_RETAINED_OUTSIDE_JOB',
  'F005_ETW_PID_NOT_JOB_MEMBER_ROOT_INACTIVE',
  'F005_ETW_PID_NOT_JOB_MEMBER_SEQUENCE_MISMATCH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_BOUND_FILE_OBJECT',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_CREATE_KNOWN_PATH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_CREATE_UNKNOWN_PATH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_DELETE_KNOWN_PATH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_DELETE_UNKNOWN_PATH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_RENAME_KNOWN_PATH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_RENAME_UNKNOWN_PATH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_SETINFO_KNOWN_PATH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_SETINFO_UNKNOWN_PATH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH',
  'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_UNKNOWN_PATH',
  'F005_ETW_RENAME_IDENTITY_MISMATCH',
  'F005_ETW_SEQUENCE_GAP',
  'F005_ETW_SYSTEM_SETINFO_CORRELATION_MISMATCH',
  'F005_ETW_SESSION_STOP_FAILED',
  'F005_ETW_UNKNOWN_EVENT',
  'F005_NATIVE_GUARD_INVALID',
  'F005_NATIVE_GUARD_CHANNEL_FAILED',
  'F005_NATIVE_WRITE_THROUGH_OPEN_FAILED',
  'F005_NATIVE_WRITE_THROUGH_FLUSH_FAILED',
  'F005_NATIVE_WRITE_THROUGH_IDENTITY_FAILED',
  'F005_NATIVE_WRITE_THROUGH_VERIFY_FAILED',
  'F005_NATIVE_WRITE_THROUGH_CLEANUP_FAILED',
  'F005_NATIVE_WRITE_THROUGH_PROTOCOL_FAILED',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const F005_FAILURE_FRAME_PATHS = new Set([
  'scripts/f005-run-work.ts',
  'src/content/artifacts.ts',
  'src/content/batch.ts',
  'src/content/f005-acceptance.ts',
  'src/content/f005-context.ts',
  'src/content/f005-foundation.ts',
  'src/content/f005-native-guard.ts',
  'src/content/f005-voice.ts',
  'src/voice/f003.ts',
]);

function safeFailureName(value: unknown, fallback: 'Error' | 'NonError'): string {
  return typeof value === 'string' && F005_FAILURE_NAMES.has(value)
    ? value
    : fallback;
}

function safeFailureCode(value: unknown): string | null {
  return typeof value === 'string' && (
    F005_FAILURE_CODES.has(value) ||
    isF005SystemSetInfoDiagnosticCode(value)
  )
    ? value
    : null;
}

function safeWorkspaceFrames(stack: unknown, workspace: string): readonly string[] {
  if (typeof stack !== 'string') return [];
  const root = resolve(workspace).replaceAll('\\', '/').replace(/\/+$/u, '');
  const rootKey = root.toLocaleLowerCase('en-US');
  const frames: string[] = [];
  for (const rawLine of stack.slice(0, 65_536).split(/\r?\n/u)) {
    const line = rawLine.replaceAll('\\', '/');
    const start = line.toLocaleLowerCase('en-US').indexOf(`${rootKey}/`);
    if (start < 0) continue;
    const relativeFrame = line.slice(start + root.length + 1);
    const match = /^([A-Za-z0-9_./-]+\.[cm]?[jt]sx?):([1-9][0-9]*):([1-9][0-9]*)/u
      .exec(relativeFrame);
    if (!match) continue;
    const path = match[1]!;
    if (
      path.length > 512
      || path.split('/').some((segment) => segment === '..' || segment === '')
    ) continue;
    if (!F005_FAILURE_FRAME_PATHS.has(path) || frames.includes(path)) continue;
    frames.push(path);
    if (frames.length === 8) break;
  }
  return frames;
}

function safeFailure(error: Error, workspace: string): Readonly<Record<string, unknown>> {
  const cause = readErrorField(error, 'cause');
  return {
    name: safeFailureName(readErrorField(error, 'name'), 'Error'),
    code: safeFailureCode(readErrorField(error, 'code')),
    frames: safeWorkspaceFrames(readErrorField(error, 'stack'), workspace),
    cause: cause instanceof Error
      ? {
          name: safeFailureName(readErrorField(cause, 'name'), 'Error'),
          code: safeFailureCode(readErrorField(cause, 'code')),
          frames: safeWorkspaceFrames(readErrorField(cause, 'stack'), workspace),
        }
      : null,
  };
}

export function formatF005RunnerFailure(error: unknown, workspace = resolve('.')): string {
  const payload = error instanceof Error
    ? safeFailure(error, workspace)
    : {
        name: 'NonError',
        code: null,
        frames: [],
        cause: null,
      };
  return `${F005_RUNNER_FAILURE_PREFIX}${JSON.stringify(payload)}\n`;
}

type F005DiagnosticWriter = (
  value: string,
  callback: (error?: Error | null) => void,
) => unknown;

export async function reportF005RunnerFailureBeforeAbort(
  error: unknown,
  workspace: string,
  writeDiagnostic: F005DiagnosticWriter,
  abort: () => Promise<void>,
  timeoutMs = 1_000,
): Promise<void> {
  try {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      let settled = false;
      const finish = (writeError?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (writeError === undefined || writeError === null) resolveWrite();
        else rejectWrite(writeError);
      };
      const timer = setTimeout(
        () => finish(new Error('F005 failure diagnostic write timed out')),
        Math.max(1, Math.min(timeoutMs, 5_000)),
      );
      try {
        writeDiagnostic(
          formatF005RunnerFailure(error, workspace),
          (writeError) => finish(writeError),
        );
      } catch (writeError) {
        finish(writeError);
      }
    });
  } catch {
    // 診断失敗時もcontainmentを優先し、finallyで必ずJobを停止する。
  } finally {
    await abort();
  }
}

export async function runOfflineBuild(
  workspace: string,
  runInheritedWorker: (
    executable: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ readonly pid: number; readonly exitCode: number }>,
): Promise<void> {
  const entry = join(workspace, 'scripts', 'build-offline.mjs');
  const result = await runInheritedWorker(process.execPath, [entry], workspace);
  if (result.exitCode !== 0) {
    throw new Error(`offline build failed: ${String(result.exitCode)}`);
  }
}

export function createF005LoopbackEngine(
  baseUrl = new URL(process.env.VOICEVOX_URL ?? 'http://127.0.0.1:50021/'),
): F005LoopbackEngine {
  type EngineFailureCode =
    | 'F005_ENGINE_VERSION_REQUEST_FAILED'
    | 'F005_ENGINE_VERSION_PARSE_FAILED'
    | 'F005_ENGINE_SPEAKERS_REQUEST_FAILED'
    | 'F005_ENGINE_SPEAKERS_PARSE_FAILED'
    | 'F005_ENGINE_AUDIO_QUERY_REQUEST_FAILED'
    | 'F005_ENGINE_AUDIO_QUERY_PARSE_FAILED'
    | 'F005_ENGINE_SYNTHESIS_REQUEST_FAILED'
    | 'F005_ENGINE_SYNTHESIS_BODY_FAILED';
  const engineFailure = (
    code: EngineFailureCode,
    cause: unknown,
  ): never => {
    const failure = new Error('F005 runner engine operation failed', { cause });
    failure.name = 'F005RunnerEngineError';
    Object.assign(failure, { code });
    throw failure;
  };
  const request = async (
    path: string,
    code: EngineFailureCode,
    options: {
      readonly method?: 'GET' | 'POST';
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
      readonly maxBytes: number;
    },
  ): Promise<Uint8Array> => {
    try {
      return await new Promise<Uint8Array>((resolveRequest, rejectRequest) => {
        let settled = false;
        const finish = (error: Error | null, value?: Uint8Array): void => {
          if (settled) return;
          settled = true;
          if (error) rejectRequest(error);
          else resolveRequest(value ?? new Uint8Array());
        };
        const target = new URL(path, baseUrl);
        const outgoing = requestHttp(target, {
          method: options.method ?? 'GET',
          headers: options.headers,
        }, (incoming) => {
          if (
            incoming.statusCode === undefined
            || incoming.statusCode < 200
            || incoming.statusCode >= 300
          ) {
            incoming.resume();
            finish(new Error('VOICEVOX HTTP response was not successful'));
            return;
          }
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          incoming.on('data', (chunk: Buffer) => {
            if (settled) return;
            totalBytes += chunk.byteLength;
            if (totalBytes > options.maxBytes) {
              finish(new Error('VOICEVOX HTTP response exceeded its fixed limit'));
              incoming.destroy();
              return;
            }
            chunks.push(chunk);
          });
          incoming.once('error', (error) => finish(error));
          incoming.once('end', () => finish(null, new Uint8Array(Buffer.concat(chunks))));
        });
        outgoing.once('error', (error) => finish(error));
        outgoing.setTimeout(120_000, () => {
          outgoing.destroy(new Error('VOICEVOX HTTP request timed out'));
        });
        if (options.body === undefined) outgoing.end();
        else outgoing.end(options.body, 'utf8');
      });
    } catch (error) {
      return engineFailure(code, error);
    }
  };
  const parseJson = (bytes: Uint8Array): unknown =>
    JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  return Object.freeze({
    baseUrl,
    config: F002_VOICE_CONFIG,
    getVersion: async () => {
      const bytes = await request('version', 'F005_ENGINE_VERSION_REQUEST_FAILED', {
        maxBytes: 1_024,
      });
      try {
        const value = parseJson(bytes);
        if (typeof value !== 'string') throw new TypeError('version response is not a string');
        return value;
      } catch (error) {
        return engineFailure('F005_ENGINE_VERSION_PARSE_FAILED', error);
      }
    },
    getSpeakers: async () => {
      const bytes = await request('speakers', 'F005_ENGINE_SPEAKERS_REQUEST_FAILED', {
        maxBytes: 1_048_576,
      });
      try {
        const value = parseJson(bytes);
        if (!Array.isArray(value)) throw new TypeError('speakers response is not an array');
        return value as readonly VoicevoxSpeaker[];
      } catch (error) {
        return engineFailure('F005_ENGINE_SPEAKERS_PARSE_FAILED', error);
      }
    },
    createAudioQuery: async (text: string) => {
      const bytes = await request(
        `audio_query?text=${encodeURIComponent(text)}&speaker=3`,
        'F005_ENGINE_AUDIO_QUERY_REQUEST_FAILED',
        { method: 'POST', maxBytes: 1_048_576 },
      );
      try {
        return parseJson(bytes);
      } catch (error) {
        return engineFailure('F005_ENGINE_AUDIO_QUERY_PARSE_FAILED', error);
      }
    },
    synthesize: async (query: unknown) => {
      let body: string;
      try {
        body = JSON.stringify(query);
      } catch (error) {
        return engineFailure('F005_ENGINE_SYNTHESIS_BODY_FAILED', error);
      }
      return request(
        'synthesis?speaker=3',
        'F005_ENGINE_SYNTHESIS_REQUEST_FAILED',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          maxBytes: F005_VOICE_LIMITS.wavBytes,
        },
      );
    },
  });
}

async function main(): Promise<void> {
  const workId = parseF005RunWorkArguments(process.argv.slice(2));
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const publicRoot = join(workspace, 'public');
  const publicBefore = await treeDigest(publicRoot);
  const context = await loadVerifiedF005Definition(workspace);
  const baseline = await loadV040Baseline(workspace, context);
  process.stderr.write(formatF005RunnerProgress('context-loaded'));
  const [speech, forecastArtifact, candidateText, manifestText] = await Promise.all([
    canonicalArtifact<readonly (F005SpeechItem & Record<string, unknown>)[]>(
      workspace,
      `content/batches/F005/work-artifacts/${workId}/speech-items.json`,
    ),
    canonicalArtifact<{ forecast: CapacityForecastV3 }>(
      workspace,
      `content/batches/F005/capacity-forecast/${workId}.json`,
    ),
    readFile(join(
      workspace,
      'content',
      'batches',
      'F005',
      'work-artifacts',
      workId,
      'candidates.json',
    ), 'utf8'),
    readFile(join(workspace, ...MANIFEST_PATH.split('/')), 'utf8'),
  ]);
  const checkedManifest = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checkedManifest.ok || canonicalJson(checkedManifest.value) !== manifestText) {
    throw new Error('F005 manifestがcanonicalではありません');
  }
  const selected = selectF005CurrentWork(checkedManifest.value, workId);
  const speechItems = speech.value.map((item): F005SpeechItem => ({
    candidateId: item.candidateId,
    speechText: item.speechText,
    speechSha256: item.speechSha256,
    approved: true,
  }));
  const plan = planF005VoiceDiff(speechItems, F002_VOICE_CONFIG, { entries: [] });

  // この呼出しがproductionの最初のmutation境界。ETW権限がなければ何も変更せず停止する。
  const candidateSha256 = verifyF005RunnerCandidateBinding(
    candidateText,
    forecastArtifact.value.forecast.candidateSha256 as Sha256,
    f005CapacityCandidateSha256(context),
  );
  const session = await enterF005ProductionSession(
    async () => ({
      workspace,
      owner: OWNER,
      workId,
      candidateSha256,
      executable: await resolveF005ExternalNativeGuardExecutable(
        workspace,
        process.env.F005_NATIVE_GUARD_PATH,
      ),
      onStartupFailure: (code: F005NativeCapacityErrorCode) =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          process.stderr.write(
            `F005_NATIVE_START_FAILURE=${code}\n`,
            (error) => error ? rejectWrite(error) : resolveWrite(),
          );
        }),
    }),
    (tuple) => startF005NativeCapacitySession(tuple),
    async (_tuple, startedSession) => startedSession,
  );
  const identity = {
    journalId: session.journalId as Sha256,
    owner: session.owner,
    sessionNonce: session.sessionNonce as Sha256,
    workerPid: session.workerPid,
  };
  const voiceRecorder = createF005CapacityRecorder(identity, session.voiceBackend);
  const acceptanceRecorder = createF005AcceptanceCapacityRecorder(identity, session.acceptanceBackend);
  const runRoot = join(workspace, '.cache', 'f005-run', session.journalId, workId);
  const voiceRoot = join(workspace, '.cache', `f005-voice-${workId}-${session.journalId}`);
  let buildSequence = 0;
  try {
    const voice = await generateF005Voice(
      plan,
      createF005LoopbackEngine(),
      voiceRoot,
      voiceRecorder,
      workId,
      1,
      120_000,
      (stage) => process.stderr.write(formatF005VoiceProgress(stage)),
    );
    process.stderr.write(formatF005RunnerProgress('voice-generated'));

    const formalPhase = sha(`${session.journalId}\0${workId}\0formal-build`);
    buildSequence = 0;
    const formalNotice = async (
      kind: 'create' | 'rename' | 'delete',
      path: string,
      targetPath: string | null,
      bytes: number,
      digest: Sha256 | null,
    ): Promise<void> => {
      if (!inside(workspace, path) || path.startsWith(publicRoot) ||
        (targetPath !== null && (!inside(workspace, targetPath) || targetPath.startsWith(publicRoot)))) {
        throw new Error('runner build mutation pathがallowlist外です');
      }
      buildSequence += 1;
      await session.observeMutation({
        noticeId: sha(`${formalPhase}\0${buildSequence}\0${kind}\0${path}\0${targetPath ?? ''}`),
        sequence: buildSequence,
        phase: 'build',
        phaseInstanceId: formalPhase,
        kind,
        path,
        targetPath,
        sha256: digest,
        bytes,
      });
    };
    await session.beginPhase('build', workId, formalPhase);
    await mkdir(runRoot, { recursive: true });
    await formalNotice('create', runRoot, null, 0, null);
    const writeCanonical = async (path: string, value: unknown): Promise<Sha256> => {
      if (!inside(workspace, path) || path.startsWith(publicRoot)) throw new Error('publicへのwriteは拒否します');
      return writeCanonicalArtifact(workspace, path, value);
    };
    const voiceEvidencePath =
      `content/batches/F005/work-artifacts/${workId}/runs/${session.journalId}/voice-generation.json`;
    const voiceEvidenceSha = await writeCanonical(join(workspace, ...voiceEvidencePath.split('/')), {
      schemaVersion: '1.0.0',
      kind: 'f005-voice-generation',
      workId,
      journalId: session.journalId,
      payload: voice,
    });
    const sourceSha = candidateSha256;
    const reviewSha = sha(await readFile(join(
      workspace,
      'content',
      'batches',
      'F005',
      'work-artifacts',
      workId,
      'review-agreement.json',
    )));
    const forecastSha = sha(forecastArtifact.text);
    let manifest: BatchManifest = checkedManifest.value;
    const advance = (stage: 'extracted' | 'reviewed' | 'budget-approved' | 'voiced',
      output: Sha256, extra: F005RunnerStageExtra = {}): void => {
      manifest = advanceF005RunnerManifest(
        manifest,
        workId,
        stage,
        output,
        stage === 'voiced' ? voice.assets.length : speechItems.length,
        extra,
      );
    };
    advance('extracted', sourceSha);
    advance('reviewed', reviewSha, { pendingCount: 0 });
    advance('budget-approved', forecastSha, {
      forecastRef:
        `content/batches/F005/capacity-forecast/${workId}.json` as StageEvidence['forecastRef'],
    });
    advance('voiced', voiceEvidenceSha, {
      voiceEvidenceRef: voiceEvidencePath as StageEvidence['voiceEvidenceRef'],
    });
    let persisted = checkedManifest.value;
    for (const next of manifest.workProgress[manifest.workIds.indexOf(workId)]?.stageRecords ?? []) {
      const current = persisted.workProgress[manifest.workIds.indexOf(workId)];
      if (current?.stageRecords.some((record) =>
        record.stage === next.stage && canonicalJson(record) === canonicalJson(next))) continue;
      const stage = next.stage as WorkStatus;
      const target = transitionWorkState(persisted, workId, stage, {
        kind: 'stage',
        stage,
        expectedManifestSha: hashBatchManifest(persisted),
        workId,
        result: 'pass',
        inputHashes: next.inputHashes,
        outputHashes: next.outputHashes,
        count: next.count,
        toolVersion: next.toolVersion,
        completedAt: next.completedAt,
        ...(stage === 'reviewed' ? { pendingCount: 0 } : {}),
        ...(stage === 'budget-approved' ? {
          forecastRef:
            `content/batches/F005/capacity-forecast/${workId}.json` as StageEvidence['forecastRef'],
        } : {}),
        ...(stage === 'voiced' ? {
          voiceEvidenceRef: voiceEvidencePath as StageEvidence['voiceEvidenceRef'],
        } : {}),
      });
      await writeBatchManifestAtomic(
        workspace,
        MANIFEST_PATH as WorkspaceRelativePath,
        target,
        hashBatchManifest(persisted),
      );
      persisted = target;
    }
    manifest = persisted;
    const voicedManifestSha = hashBatchManifest(manifest);

    await runOfflineBuild(
      workspace,
      (executable, args, cwd) => session.runInheritedWorker(executable, args, cwd),
    );
    process.stderr.write(formatF005RunnerProgress('offline-build-complete'));
    const distRoot = join(workspace, 'dist');
    const [publicMeasurement, distMeasurement] = await Promise.all([
      measureTree(publicRoot),
      measureTree(distRoot),
    ]);
    if (publicMeasurement.treeSha256 !== publicBefore) {
      throw new Error('offline buildがpublic treeを変更しました');
    }
    const previewRoot = join(workspace, '.cache', 'f005-preview', `${workId}-${session.journalId}`);
    const artifactDirectory = join(runRoot, 'preview-artifacts');
    await mkdir(artifactDirectory, { recursive: true });
    await formalNotice('create', artifactDirectory, null, 0, null);
    const previewKinds: readonly F005PreviewArtifactKind[] = [
      'content-build',
      'content-staging',
      'dist',
      'f001-content-invariant-report',
      'f001-dist-invariant-report',
    ];
    const previewRefs = new Map<F005PreviewArtifactKind, F005ArtifactRef<F005PreviewArtifactKind>>();
    const buildPayloads = createF005OfflineBuildArtifactPayloads({
      manifestSha256: voicedManifestSha,
      baselineDescriptorSha256: baseline.descriptorSha256 as Sha256,
      expectedPublicTreeSha256: publicBefore,
      publicMeasurement,
      distMeasurement,
    });
    for (const kind of previewKinds) {
      const path = join(artifactDirectory, `${kind}.json`);
      const logical = relative(workspace, path).replaceAll('\\', '/');
      const digest = await writeCanonical(path, {
        schemaVersion: '1.0.0',
        kind,
        workId,
        payload: buildPayloads[kind],
      });
      previewRefs.set(kind, { kind, path: logical, sha256: digest });
    }
    await session.endPhase('build', formalPhase);
    const artifacts: F005PreviewArtifacts = {
      workspaceRoot: workspace,
      previewRoot,
      contentBuild: previewRefs.get('content-build') as F005ArtifactRef<'content-build'>,
      contentStaging: previewRefs.get('content-staging') as F005ArtifactRef<'content-staging'>,
      dist: previewRefs.get('dist') as F005ArtifactRef<'dist'>,
      f001ContentInvariantReport:
        previewRefs.get('f001-content-invariant-report') as F005ArtifactRef<'f001-content-invariant-report'>,
      f001DistInvariantReport:
        previewRefs.get('f001-dist-invariant-report') as F005ArtifactRef<'f001-dist-invariant-report'>,
    };
    const staged: F005StagedWork = {
      mode: 'staged',
      workId,
      files: voice.assets.map((asset) => ({
        sourcePath: asset.path,
        targetPath: `content/batches/F005/accepted-audio/${workId}/${asset.audioId}.wav`,
        sha256: asset.sha256 as Sha256,
        bytes: asset.bytes,
        configHash: plan.configHash as Sha256,
      })),
    };
    const acceptedWorks: F005AcceptedWork[] = selected.acceptedWorkIds.map((acceptedWorkId) => {
      const progress = manifest.workProgress[manifest.workIds.indexOf(acceptedWorkId)];
      if (!progress?.acceptedAudioSources?.length) {
        throw new Error(`先行accepted workのaudio sourceがありません: ${acceptedWorkId}`);
      }
      return {
        mode: 'accepted',
        workId: acceptedWorkId,
        files: progress.acceptedAudioSources.map((source) => ({
          sourcePath: join(workspace, ...source.path.split('/')),
          targetPath: source.path,
          sha256: source.sha256,
          bytes: source.bytes,
          configHash: source.configHash,
        })),
      };
    });
    const preview = await prepareF005WorkPreview(
      context,
      baseline,
      acceptedWorks,
      staged,
      artifacts,
      acceptanceRecorder,
    );
    process.stderr.write(formatF005RunnerProgress('preview-prepared'));

    const evidencePhase = sha(`${session.journalId}\0${workId}\0evidence-build`);
    buildSequence = 0;
    await session.beginPhase('build', workId, evidencePhase);
    const evidenceRefs: F005EvidenceRef[] = [];
    const evidenceKinds: readonly F005EvidenceKind[] =
      ['source', 'review', 'audio', 'license', 'notice', 'artwork'];
    for (const kind of evidenceKinds) {
      const logical =
        `content/batches/F005/work-artifacts/${workId}/runs/${session.journalId}/acceptance-${kind}.json`;
      const path = join(workspace, ...logical.split('/'));
      const value = {
        schemaVersion: '1.0.0',
        kind,
        workId,
        previewSha256: preview.previewSha256,
        payload: {
          sourceSha256: sourceSha,
          reviewSha256: reviewSha,
          voiceEvidenceSha256: voice.evidenceSha256,
          forecastSha256: forecastSha,
          baselineDescriptorSha256: baseline.descriptorSha256,
        },
      };
      const evidenceSha = await writeCanonicalArtifact(workspace, path, value);
      evidenceRefs.push({ kind, path: logical, sha256: evidenceSha });
    }
    await session.endPhase('build', evidencePhase);
    const prepared = await prepareF005WorkAcceptance(
      workspace,
      context,
      workId,
      evidenceRefs,
      preview,
      acceptanceRecorder,
    );
    const promoted = await stageF005WorkAcceptance(
      workspace,
      prepared,
      voicedManifestSha,
      acceptanceRecorder,
      forecastArtifact.value.forecast.candidateSha256 as Sha256,
    );
    process.stderr.write(formatF005RunnerProgress('acceptance-staged'));
    process.stderr.write(formatF005RunnerProgress('session-close-start'));
    const closed = await session.close();
    process.stderr.write(formatF005RunnerProgress('session-closed'));
    const actualAudioEntries = voice.assets.map((asset) => ({
      kind: 'path' as const,
      bucket: 'audio' as const,
      path: `content/batches/F005/accepted-audio/${workId}/${asset.audioId}.wav`,
      bytes: asset.bytes,
      sha256: asset.sha256,
    }));
    const inventory: Array<CapacityEntry & {
      bucket: 'artifact' | 'repository' | 'object';
    }> = [];
    for (const bucket of forecastArtifact.value.forecast.buckets) {
      if (bucket.kind === 'artifact' || bucket.kind === 'repository' || bucket.kind === 'object') {
        const kind = bucket.kind;
        inventory.push(...bucket.entries.map((entry) => ({ ...entry, bucket: kind })));
      }
    }
    const reader = createF005NativeCapacityJournalReader({
      journalId: closed.journalId,
      journalPath: closed.journalPath,
      journalSha256: closed.journalSha256,
      workId,
      candidateSha256: forecastArtifact.value.forecast.candidateSha256,
      workspaceRoot: workspace,
      distRoot,
      entries: [
        ...actualAudioEntries,
        ...inventory,
        ...actualAudioEntries.map((entry) => ({ ...entry, bucket: 'workspace-peak' as const })),
      ],
    });
    const actual = await measureF005ActualCapacity(
      workspace,
      distRoot,
      actualAudioEntries.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
      reader,
      workId,
    );
    process.stderr.write(formatF005RunnerProgress('actual-measured'));
    if (actual.journalId !== session.journalId || actual.journalSha256 !== closed.journalSha256) {
      throw new Error('actual capacityとclosed native journalが一致しません');
    }
    const actualLogical = `content/batches/F005/capacity-actual/${workId}/${session.journalId}.json`;
    const actualPath = join(workspace, ...actualLogical.split('/'));
    const actualValue = {
      schemaVersion: '1.0.0',
      kind: 'actual-capacity-report',
      workId,
      journalId: session.journalId,
      payload: actual,
    };
    const actualArtifactSha = await writeCanonicalArtifact(workspace, actualPath, actualValue);
    const accepted = await finalizeF005WorkAcceptance(
      workspace,
      promoted,
      {
        kind: 'actual-capacity-report',
        path: actualLogical,
        sha256: actualArtifactSha,
        candidateSha256: actual.candidateSha256 as Sha256,
        journalId: actual.journalId as Sha256,
        journalSha256: actual.journalSha256 as Sha256,
      },
      voicedManifestSha,
    );
    process.stderr.write(formatF005RunnerProgress('acceptance-finalized'));
    const publicAfter = await treeDigest(publicRoot);
    if (publicAfter !== publicBefore) throw new Error('runnerがpublic treeを変更しました');
    process.stderr.write(formatF005RunnerProgress('result-writing'));
    process.stdout.write(formatF005RunnerResult({
      ok: true,
      workId,
      status: accepted.workProgress[accepted.workIds.indexOf(workId)]?.status,
      journalId: actual.journalId,
      actualCapacityReport: actualLogical,
      publicTreeSha256: publicAfter,
    }));
  } catch (error) {
    await reportF005RunnerFailureBeforeAbort(
      error,
      workspace,
      (value, callback) => process.stderr.write(value, callback),
      () => session.abort(),
    );
    if (await treeDigest(publicRoot) !== publicBefore) {
      throw new Error('失敗経路でpublic treeが変化しました', { cause: error });
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main().catch(() => {
    // main内でallowlist済み診断をflushする。未処理例外のraw message/絶対pathはstderrへ再出力しない。
    process.exitCode = 1;
  });
}
