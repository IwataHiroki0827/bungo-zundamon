import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { canonicalJson } from './artifacts.ts';
import type { Sha256 } from './batch.ts';
import { F005_NATIVE_GUARD_PINS } from './f005-source.ts';
import type {
  F005CapacityRecorderBackend,
  F005CapacityPhase,
  F005MutationNotice,
  F005MutationObservation,
} from './f005-voice.ts';
import type {
  F005AcceptanceCapacityBackend,
  F005AcceptanceMutationNotice,
  F005AcceptanceMutationObservation,
} from './f005-acceptance.ts';

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*[\\:\0])[\p{L}\p{N}._/-]+$/u;
const PHASES = new Set(['voice', 'preview', 'accept', 'build']);
const WORK_IDS = new Set(['000799', '001076', '001104']);
const mintedNativeBackends = new WeakSet<object>();

export type F005NativeCapacityErrorCode =
  | 'F005_NATIVE_GUARD_INVALID'
  | 'F005_ETW_PRIVILEGE_REQUIRED'
  | 'F005_CAPACITY_IPC_FAILED'
  | 'F005_CAPACITY_GUARD_REJECTED'
  | 'F005_CAPACITY_ETW_OBSERVATION_FAILED'
  | 'F005_CAPACITY_NOTICE_UNMATCHED'
  | 'F005_ETW_ALLOCATED_LENGTH_MISSING'
  | 'F005_ETW_BUFFER_LOSS'
  | 'F005_ETW_CALLBACK_FAILED'
  | 'F005_ETW_CALLBACK_ACCESS_FAILED'
  | 'F005_ETW_CALLBACK_ARGUMENT_FAILED'
  | 'F005_ETW_CALLBACK_AUTHORIZATION_FAILED'
  | 'F005_ETW_CALLBACK_CAPACITY_FAILED'
  | 'F005_ETW_CALLBACK_CORRELATION_FAILED'
  | 'F005_ETW_CALLBACK_DISPOSED'
  | 'F005_ETW_CALLBACK_IDENTITY_FAILED'
  | 'F005_ETW_CALLBACK_IO_FAILED'
  | 'F005_ETW_CALLBACK_JOURNAL_FAILED'
  | 'F005_ETW_CALLBACK_LOCK_STATE_FAILED'
  | 'F005_ETW_CALLBACK_NORMALIZE_FAILED'
  | 'F005_ETW_CALLBACK_OVERFLOW'
  | 'F005_ETW_CALLBACK_PHASE_FAILED'
  | 'F005_ETW_CALLBACK_RECORD_FAILED'
  | 'F005_ETW_CALLBACK_STATE_FAILED'
  | 'F005_ETW_CONSUMER_FAILED'
  | 'F005_ETW_CONSUMER_DRAIN_FAILED'
  | 'F005_ETW_CONSUMER_DRAIN_TIMEOUT'
  | 'F005_ETW_CONSUMER_STOP_TIMEOUT'
  | 'F005_ETW_EVENT_OUTSIDE_PHASE'
  | 'F005_ETW_EVENT_PHASE_TIMESTAMP_MISMATCH'
  | 'F005_ETW_FILE_IDENTITY_MISSING'
  | 'F005_ETW_FILE_IDENTITY_MISSING_CREATE_CORRELATION'
  | 'F005_ETW_FILE_IDENTITY_MISSING_CREATE_IDENTITY'
  | 'F005_ETW_FILE_IDENTITY_MISSING_DELETE_CORRELATION'
  | 'F005_ETW_FILE_IDENTITY_MISSING_DELETE_IDENTITY'
  | 'F005_ETW_FILE_IDENTITY_MISSING_RENAME_CORRELATION'
  | 'F005_ETW_FILE_IDENTITY_MISSING_RENAME_IDENTITY'
  | 'F005_ETW_FILE_IDENTITY_MISSING_SETINFO_CORRELATION'
  | 'F005_ETW_FILE_IDENTITY_MISSING_SETINFO_IDENTITY'
  | 'F005_ETW_FILE_IDENTITY_MISSING_WRITE_CORRELATION'
  | 'F005_ETW_FILE_IDENTITY_MISSING_WRITE_IDENTITY'
  | 'F005_ETW_FILE_IDENTITY_UNSAFE'
  | 'F005_ETW_OBSERVATION_MISSING'
  | 'F005_ETW_PID_NOT_JOB_MEMBER'
  | 'F005_ETW_RENAME_IDENTITY_MISMATCH'
  | 'F005_ETW_SEQUENCE_GAP'
  | 'F005_ETW_SESSION_STOP_FAILED'
  | 'F005_ETW_UNKNOWN_EVENT'
  | 'F005_CAPACITY_JOURNAL_INVALID'
  | 'F005_DIRECTORY_SYNC_FAILED';

export class F005NativeCapacityError extends Error {
  constructor(
    readonly code: F005NativeCapacityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'F005NativeCapacityError';
  }
}

function fail(
  code: F005NativeCapacityErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new F005NativeCapacityError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

const FIXED_F005_ETW_REPLY_CODES: ReadonlyMap<string, F005NativeCapacityErrorCode> = new Map([
  ['ETW_ALLOCATED_LENGTH_MISSING', 'F005_ETW_ALLOCATED_LENGTH_MISSING'],
  ['ETW_BUFFER_LOSS', 'F005_ETW_BUFFER_LOSS'],
  ['ETW_CALLBACK_ACCESS_FAILED', 'F005_ETW_CALLBACK_ACCESS_FAILED'],
  ['ETW_CALLBACK_ARGUMENT_FAILED', 'F005_ETW_CALLBACK_ARGUMENT_FAILED'],
  ['ETW_CALLBACK_AUTHORIZATION_FAILED', 'F005_ETW_CALLBACK_AUTHORIZATION_FAILED'],
  ['ETW_CALLBACK_CAPACITY_FAILED', 'F005_ETW_CALLBACK_CAPACITY_FAILED'],
  ['ETW_CALLBACK_CORRELATION_FAILED', 'F005_ETW_CALLBACK_CORRELATION_FAILED'],
  ['ETW_CALLBACK_DISPOSED', 'F005_ETW_CALLBACK_DISPOSED'],
  ['ETW_CALLBACK_IDENTITY_FAILED', 'F005_ETW_CALLBACK_IDENTITY_FAILED'],
  ['ETW_CALLBACK_FAILED', 'F005_ETW_CALLBACK_FAILED'],
  ['ETW_CALLBACK_IO_FAILED', 'F005_ETW_CALLBACK_IO_FAILED'],
  ['ETW_CALLBACK_JOURNAL_FAILED', 'F005_ETW_CALLBACK_JOURNAL_FAILED'],
  ['ETW_CALLBACK_LOCK_STATE_FAILED', 'F005_ETW_CALLBACK_LOCK_STATE_FAILED'],
  ['ETW_CALLBACK_NORMALIZE_FAILED', 'F005_ETW_CALLBACK_NORMALIZE_FAILED'],
  ['ETW_CALLBACK_OVERFLOW', 'F005_ETW_CALLBACK_OVERFLOW'],
  ['ETW_CALLBACK_PHASE_FAILED', 'F005_ETW_CALLBACK_PHASE_FAILED'],
  ['ETW_CALLBACK_RECORD_FAILED', 'F005_ETW_CALLBACK_RECORD_FAILED'],
  ['ETW_CALLBACK_STATE_FAILED', 'F005_ETW_CALLBACK_STATE_FAILED'],
  ['ETW_CONSUMER_DRAIN_FAILED', 'F005_ETW_CONSUMER_DRAIN_FAILED'],
  ['ETW_CONSUMER_DRAIN_TIMEOUT', 'F005_ETW_CONSUMER_DRAIN_TIMEOUT'],
  ['ETW_CONSUMER_STOP_TIMEOUT', 'F005_ETW_CONSUMER_STOP_TIMEOUT'],
  ['ETW_EVENT_OUTSIDE_PHASE', 'F005_ETW_EVENT_OUTSIDE_PHASE'],
  ['ETW_EVENT_PHASE_TIMESTAMP_MISMATCH', 'F005_ETW_EVENT_PHASE_TIMESTAMP_MISMATCH'],
  ['ETW_FILE_IDENTITY_MISSING', 'F005_ETW_FILE_IDENTITY_MISSING'],
  ['ETW_FILE_IDENTITY_MISSING_CREATE_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_CREATE_CORRELATION'],
  ['ETW_FILE_IDENTITY_MISSING_CREATE_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_CREATE_IDENTITY'],
  ['ETW_FILE_IDENTITY_MISSING_DELETE_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_DELETE_CORRELATION'],
  ['ETW_FILE_IDENTITY_MISSING_DELETE_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_DELETE_IDENTITY'],
  ['ETW_FILE_IDENTITY_MISSING_RENAME_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_RENAME_CORRELATION'],
  ['ETW_FILE_IDENTITY_MISSING_RENAME_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_RENAME_IDENTITY'],
  ['ETW_FILE_IDENTITY_MISSING_SETINFO_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_SETINFO_CORRELATION'],
  ['ETW_FILE_IDENTITY_MISSING_SETINFO_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_SETINFO_IDENTITY'],
  ['ETW_FILE_IDENTITY_MISSING_WRITE_CORRELATION', 'F005_ETW_FILE_IDENTITY_MISSING_WRITE_CORRELATION'],
  ['ETW_FILE_IDENTITY_MISSING_WRITE_IDENTITY', 'F005_ETW_FILE_IDENTITY_MISSING_WRITE_IDENTITY'],
  ['ETW_FILE_IDENTITY_UNSAFE', 'F005_ETW_FILE_IDENTITY_UNSAFE'],
  ['ETW_OBSERVATION_MISSING', 'F005_ETW_OBSERVATION_MISSING'],
  ['ETW_PID_NOT_JOB_MEMBER', 'F005_ETW_PID_NOT_JOB_MEMBER'],
  ['ETW_RENAME_IDENTITY_MISMATCH', 'F005_ETW_RENAME_IDENTITY_MISMATCH'],
  ['ETW_SEQUENCE_GAP', 'F005_ETW_SEQUENCE_GAP'],
  ['ETW_UNKNOWN_EVENT', 'F005_ETW_UNKNOWN_EVENT'],
]);

export function classifyF005NativeCapacityReplyError(value: unknown): F005NativeCapacityErrorCode {
  if (value === 'F005_CAPACITY_NOTICE_UNMATCHED') return 'F005_CAPACITY_NOTICE_UNMATCHED';
  if (typeof value === 'string' && value.startsWith('ETW_PRIVILEGE_REQUIRED')) {
    return 'F005_ETW_PRIVILEGE_REQUIRED';
  }
  const fixedCode = typeof value === 'string'
    ? FIXED_F005_ETW_REPLY_CODES.get(value)
    : undefined;
  if (fixedCode !== undefined) return fixedCode;
  if (typeof value === 'string' && value.startsWith('ETW_CONSUMER_FAILED_')) {
    return 'F005_ETW_CONSUMER_FAILED';
  }
  if (typeof value === 'string' && value.startsWith('ETW_OBSERVATION_FAILED_')) {
    return 'F005_ETW_CALLBACK_FAILED';
  }
  if (typeof value === 'string' && value.startsWith('ETW_SESSION_STOP_FAILED_')) {
    return 'F005_ETW_SESSION_STOP_FAILED';
  }
  if (typeof value === 'string' && value.startsWith('ETW_')) {
    return 'F005_CAPACITY_ETW_OBSERVATION_FAILED';
  }
  return 'F005_CAPACITY_GUARD_REJECTED';
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safeString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && SAFE_PATH.test(value) &&
    !value.split('/').some((segment) =>
      segment === '' || segment === '.' || segment === '..' ||
      segment.endsWith('.') || segment.endsWith(' ') ||
      segment.normalize('NFC') !== segment);
}

/**
 * application層の絶対pathをnative journal ABIのworkspace相対pathへ変換する。
 * workspace外・workspace自体・非正規pathはfail-closedとする。
 */
export function normalizeF005CapacityNoticePath(workspace: string, value: unknown): string {
  if (!isAbsolute(workspace) || resolve(workspace) !== workspace || typeof value !== 'string') {
    return fail('F005_CAPACITY_IPC_FAILED', 'mutation notice pathが不正です');
  }
  const target = isAbsolute(value) ? resolve(value) : resolve(workspace, value);
  const normalized = relative(workspace, target).split(sep).join('/');
  if (!normalized || normalized === '..' || normalized.startsWith('../') ||
    isAbsolute(normalized) || !safeRelativePath(normalized)) {
    return fail('F005_CAPACITY_IPC_FAILED', 'mutation notice pathがworkspace外です');
  }
  return normalized;
}

/**
 * WindowsでNodeから開けないdirectory write handleを固定native guardで開き、
 * accepted manifest参照artifactのrenameをFlushFileBuffersで永続化する。
 * @des DES-F005-006 @fun FUN-F005-022 @ut UT-F005-022
 */
export async function flushF005ArtifactDirectory(
  workspace: string,
  directory: string,
  options: { readonly executable?: string } = {},
): Promise<void> {
  if (!isAbsolute(workspace) || resolve(workspace) !== workspace ||
    !isAbsolute(directory) || resolve(directory) !== directory) {
    return fail('F005_DIRECTORY_SYNC_FAILED', 'directory sync pathが非canonicalです');
  }
  const relativeDirectory = relative(workspace, directory).split(sep).join('/');
  if (!relativeDirectory || relativeDirectory === '..' ||
    relativeDirectory.startsWith('../') || isAbsolute(relativeDirectory) ||
    !safeRelativePath(relativeDirectory)) {
    return fail('F005_DIRECTORY_SYNC_FAILED', 'directory sync pathがworkspace外です');
  }
  const [workspaceInfo, directoryInfo, workspaceReal, directoryReal] = await Promise.all([
    lstat(workspace),
    lstat(directory),
    realpath(workspace),
    realpath(directory),
  ]).catch((error) =>
    fail('F005_DIRECTORY_SYNC_FAILED', 'directory sync対象を検証できません', error));
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() ||
    !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
    workspaceReal !== workspace || directoryReal !== directory) {
    return fail('F005_DIRECTORY_SYNC_FAILED', 'directory sync対象の実体が不正です');
  }

  const executable = options.executable ??
    join(workspace, '.cache', 'dotnet-f005', 'publish', 'f005-guard.exe');
  if (!isAbsolute(executable) || resolve(executable) !== executable) {
    return fail('F005_NATIVE_GUARD_INVALID', 'native guard pathが非canonicalです');
  }
  const binary = await readFile(executable).catch((error) =>
    fail('F005_NATIVE_GUARD_INVALID', 'native guard binaryを読めません', error));
  if (sha256(binary) !== F005_NATIVE_GUARD_PINS.outputBinarySha256) {
    return fail('F005_NATIVE_GUARD_INVALID', 'native guard binary pinが一致しません');
  }

  const guard = new NativeGuardProcess(executable, workspace);
  let closed = false;
  try {
    const hello = await guard.channel.command({ op: 'hello' });
    if (!hello.ok ||
      hello.abi !== F005_NATIVE_GUARD_PINS.abi ||
      hello.capacityAbi !== F005_NATIVE_GUARD_PINS.capacityAbi ||
      hello.rid !== F005_NATIVE_GUARD_PINS.rid ||
      hello.runtimeVersion !== F005_NATIVE_GUARD_PINS.runtimeVersion) {
      return fail('F005_NATIVE_GUARD_INVALID', 'native guard ABI/toolchainが一致しません');
    }
    const synced = await guard.channel.command({
      op: 'sync-directory',
      root: workspace,
      relativePath: relativeDirectory,
    });
    if (!synced.ok || !exactKeys(synced, ['durability', 'ok']) ||
      synced.durability !== 'directory-flush-file-buffers') {
      const nativeCode = typeof synced.error === 'string'
        ? synced.error
        : 'DIRECTORY_SYNC_INVALID_REPLY';
      return fail(
        'F005_DIRECTORY_SYNC_FAILED',
        `native directory syncが${nativeCode}で停止しました`,
      );
    }
    await guard.close();
    closed = true;
  } catch (error) {
    if (error instanceof F005NativeCapacityError) throw error;
    return fail(
      'F005_DIRECTORY_SYNC_FAILED',
      'native directory syncを完了できません',
      error,
    );
  } finally {
    if (!closed) guard.terminate();
  }
}

interface GuardReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

interface NativeNotice {
  readonly noticeId: string;
  readonly sequence: number;
  readonly phase: F005CapacityPhase;
  readonly phaseInstanceId: string;
  readonly kind: 'create' | 'write' | 'rename' | 'delete';
  readonly path: string;
  readonly targetPath: string | null;
}

class JsonLineChannel {
  private readonly pending: Array<{
    readonly resolve: (value: GuardReply) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private ended = false;

  constructor(
    private readonly writeLine: (line: string) => void,
    onLine: (listener: (line: string) => void) => void,
    onFailure: (listener: (error: Error) => void) => void,
  ) {
    onLine((line) => {
      const current = this.pending.shift();
      if (!current) return;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!record(parsed) || typeof parsed.ok !== 'boolean') {
          current.reject(new Error('guard response schema mismatch'));
        } else {
          current.resolve(parsed as GuardReply);
        }
      } catch (error) {
        current.reject(error as Error);
      }
    });
    onFailure((error) => {
      this.ended = true;
      for (const item of this.pending.splice(0)) item.reject(error);
    });
  }

  command(value: Readonly<Record<string, unknown>>): Promise<GuardReply> {
    if (this.ended) return Promise.reject(new Error('guard channel ended'));
    return new Promise<GuardReply>((resolveReply, reject) => {
      this.pending.push({ resolve: resolveReply, reject });
      try {
        this.writeLine(`${JSON.stringify(value)}\n`);
      } catch (error) {
        this.pending.pop();
        reject(error as Error);
      }
    });
  }

  end(error = new Error('guard channel ended')): void {
    this.ended = true;
    for (const item of this.pending.splice(0)) item.reject(error);
  }
}

class NativeGuardProcess {
  readonly process: ChildProcessWithoutNullStreams;
  readonly channel: JsonLineChannel;

  constructor(executable: string, workspace: string) {
    this.process = spawn(executable, [], {
      cwd: workspace,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: this.process.stdout });
    this.channel = new JsonLineChannel(
      (line) => this.process.stdin.write(line),
      (listener) => lines.on('line', listener),
      (listener) => {
        this.process.once('error', listener);
        this.process.stderr.once('error', listener);
        this.process.once('exit', (code) => {
          if (code !== 0) listener(new Error(`native guard exited: ${String(code)}`));
        });
      },
    );
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) {
      if (this.process.exitCode !== 0) {
        throw new Error(`native guard exited: ${String(this.process.exitCode)}`);
      }
      this.channel.end();
      return;
    }
    await new Promise<void>((resolveExit, reject) => {
      let settled = false;
      const cleanup = (): void => {
        this.process.off('exit', onExit);
        this.process.off('error', onError);
      };
      const onExit = (code: number | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code === 0) resolveExit();
        else reject(new Error(`native guard exited: ${String(code)}`));
      };
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      this.process.once('exit', onExit);
      this.process.once('error', onError);
      const observedExitCode = this.process.exitCode;
      if (observedExitCode !== null) {
        onExit(observedExitCode);
        return;
      }
      this.process.stdin.end();
    });
    this.channel.end();
  }

  terminate(): void {
    this.channel.end();
    this.process.kill();
  }
}

class NativePipeClient {
  readonly channel: JsonLineChannel;
  private readonly socket: Socket;
  private readonly lines: ReturnType<typeof createInterface>;

  private constructor(
    socket: Socket,
    readonly authToken: string,
    readonly sessionNonce: string,
  ) {
    this.socket = socket;
    this.lines = createInterface({ input: socket });
    this.channel = new JsonLineChannel(
      (line) => socket.write(line),
      (listener) => this.lines.on('line', listener),
      (listener) => {
        socket.once('error', listener);
        socket.once('close', () => listener(new Error('native pipe closed')));
      },
    );
  }

  static async connect(
    pipeName: string,
    authToken: string,
    sessionNonce: string,
  ): Promise<NativePipeClient> {
    if (!/^[a-z0-9-]{1,128}$/u.test(pipeName) ||
      !SHA256.test(authToken) || !SHA256.test(sessionNonce)) {
      return fail('F005_NATIVE_GUARD_INVALID', 'native pipe endpointが不正です');
    }
    const socket = createConnection(`\\\\.\\pipe\\${pipeName}`);
    await new Promise<void>((resolveConnect, reject) => {
      socket.once('connect', resolveConnect);
      socket.once('error', reject);
    });
    return new NativePipeClient(socket, authToken, sessionNonce);
  }

  async command(value: Readonly<Record<string, unknown>>): Promise<GuardReply> {
    const reply = await this.channel.command({
      ...value,
      authToken: this.authToken,
      sessionNonce: this.sessionNonce,
    });
    if (!reply.ok) {
      const code = typeof reply.error === 'string' ? reply.error : 'CAPACITY_GUARD_FAILURE';
      return fail(
        classifyF005NativeCapacityReplyError(code),
        `native capacity guardが${code}で停止しました`,
      );
    }
    return reply;
  }

  close(): void {
    this.lines.close();
    this.channel.end();
    this.socket.end();
  }
}

export interface F005NativeCapacitySessionOptions {
  readonly workspace: string;
  readonly owner: string;
  readonly workId: string;
  readonly candidateSha256: string;
  readonly executable?: string;
  readonly sessionNonce?: string;
}

export interface F005NativeCapacityCloseResult {
  readonly journalId: string;
  readonly journalPath: string;
  readonly journalSha256: string;
  readonly journal: CapacityJournalV3;
}

export interface F005NativeCapacitySession {
  readonly journalId: string;
  readonly journalPath: string;
  readonly owner: string;
  readonly workId: string;
  readonly candidateSha256: string;
  readonly sessionNonce: string;
  readonly workerPid: number;
  readonly voiceBackend: F005CapacityRecorderBackend;
  readonly acceptanceBackend: F005AcceptanceCapacityBackend;
  runInheritedWorker(
    executable: string,
    args: readonly string[],
    cwd: string,
  ): Promise<{ readonly pid: number; readonly exitCode: number }>;
  beginPhase(phase: F005CapacityPhase, workId: string | null, phaseInstanceId: string): Promise<void>;
  observeMutation(notice: {
    readonly noticeId: string;
    readonly sequence: number;
    readonly phase: F005CapacityPhase;
    readonly phaseInstanceId: string;
    readonly kind: 'create' | 'rename' | 'delete';
    readonly path: string;
    readonly targetPath: string | null;
    readonly sha256: string | null;
    readonly bytes: number;
  }): Promise<void>;
  endPhase(phase: F005CapacityPhase, phaseInstanceId: string): Promise<void>;
  close(): Promise<F005NativeCapacityCloseResult>;
  abort(): Promise<void>;
}

/**
 * production recorder factoryがtest fakeを解禁せず、実native sessionからmintされた
 * backendだけを識別するためのread-only判定。
 */
export function isMintedF005NativeCapacityBackend(value: unknown): boolean {
  return value !== null && typeof value === 'object' && mintedNativeBackends.has(value);
}

/**
 * 固定binaryを起動し、ETW権限確認後にJob・kernel FileIO・認証pipeを一体で開始する。
 * production fakeやfilesystem watcherへのfallbackは持たない。
 * @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @ut UT-F005-047
 */
export async function startF005NativeCapacitySession(
  options: F005NativeCapacitySessionOptions,
): Promise<F005NativeCapacitySession> {
  if (!isAbsolute(options.workspace) || resolve(options.workspace) !== options.workspace ||
    !safeString(options.owner) || options.owner.length > 256 ||
    !WORK_IDS.has(options.workId) || !SHA256.test(options.candidateSha256)) {
    return fail('F005_NATIVE_GUARD_INVALID', 'workspace/owner/work/candidateが不正です');
  }
  const sessionNonce = options.sessionNonce ?? randomBytes(32).toString('hex');
  if (!SHA256.test(sessionNonce)) {
    return fail('F005_NATIVE_GUARD_INVALID', 'session nonceが不正です');
  }
  const journalId = sha256(
    `${sessionNonce}\0${options.owner}\0${options.workId}\0${options.candidateSha256}\0f005-capacity-v3`,
  );
  const journalPath = `.cache/f005-capacity/${journalId}.json`;
  const executable = options.executable ??
    join(options.workspace, '.cache', 'dotnet-f005', 'publish', 'f005-guard.exe');
  const binary = await readFile(executable).catch((error) =>
    fail('F005_NATIVE_GUARD_INVALID', 'native guard binaryを読めません', error));
  if (sha256(binary) !== F005_NATIVE_GUARD_PINS.outputBinarySha256) {
    return fail('F005_NATIVE_GUARD_INVALID', 'native guard binary pinが一致しません');
  }

  const guard = new NativeGuardProcess(executable, options.workspace);
  let pipe: NativePipeClient | undefined;
  try {
    const hello = await guard.channel.command({ op: 'hello' });
    if (!hello.ok ||
      hello.abi !== F005_NATIVE_GUARD_PINS.abi ||
      hello.capacityAbi !== F005_NATIVE_GUARD_PINS.capacityAbi ||
      hello.rid !== F005_NATIVE_GUARD_PINS.rid ||
      hello.runtimeVersion !== F005_NATIVE_GUARD_PINS.runtimeVersion) {
      return fail('F005_NATIVE_GUARD_INVALID', 'native guard ABI/toolchainが一致しません');
    }
    const preflight = await guard.channel.command({ op: 'capacity-preflight' });
    if (!preflight.ok) {
      const nativeCode = typeof preflight.error === 'string' ? preflight.error : 'ETW_PREFLIGHT_FAILED';
      return fail(
        nativeCode.startsWith('ETW_PRIVILEGE_REQUIRED')
          ? 'F005_ETW_PRIVILEGE_REQUIRED'
          : 'F005_NATIVE_GUARD_INVALID',
        `ETW preflightが${nativeCode}で停止しました`,
      );
    }
    const started = await guard.channel.command({
      op: 'capacity-start',
      root: options.workspace,
      journalRelativePath: journalPath,
      owner: options.owner,
      sessionNonce,
      workId: options.workId,
      candidateSha256: options.candidateSha256,
    });
    if (!started.ok ||
      started.capacityAbi !== F005_NATIVE_GUARD_PINS.capacityAbi ||
      typeof started.pipeName !== 'string' ||
      typeof started.authToken !== 'string') {
      const nativeCode = typeof started.error === 'string' ? started.error : 'CAPACITY_START_FAILED';
      return fail(
        nativeCode.startsWith('ETW_PRIVILEGE_REQUIRED')
          ? 'F005_ETW_PRIVILEGE_REQUIRED'
          : 'F005_NATIVE_GUARD_INVALID',
        `native capacity sessionが${nativeCode}で停止しました`,
      );
    }
    pipe = await NativePipeClient.connect(started.pipeName, started.authToken, sessionNonce);
    const registered = await pipe.command({ op: 'registerSelf' });
    if (registered.pid !== process.pid || registered.jobIdentity !== started.jobIdentity) {
      return fail('F005_CAPACITY_IPC_FAILED', 'root workerのJob結合が不正です');
    }

    let activePhase: {
      readonly phase: F005CapacityPhase;
      readonly workId: string | null;
      readonly phaseInstanceId: string;
    } | null = null;
    let nextApplicationNoticeSequence = 1;
    let lastNativeNoticeSequence = 0;
    let closed = false;
    const runInheritedWorker = async (
      executable: string,
      args: readonly string[],
      cwd: string,
    ): Promise<{ readonly pid: number; readonly exitCode: number }> => {
      const expectedEntry = join(options.workspace, 'scripts', 'build-offline.mjs');
      if (closed || activePhase?.phase !== 'build' ||
        activePhase.workId !== options.workId ||
        executable !== process.execPath || cwd !== options.workspace ||
        !Array.isArray(args) || args.length !== 1 || args[0] !== expectedEntry) {
        return fail('F005_CAPACITY_IPC_FAILED', 'inherited worker起動tupleが不正です');
      }
      const child = spawn(executable, [...args], {
        cwd,
        env: {
          ...process.env,
          npm_config_offline: 'true',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
        },
        windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      if (!child.pid) return fail('F005_CAPACITY_IPC_FAILED', 'inherited worker PIDを取得できません');
      const pid = child.pid;
      const exitCode = await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          code === null ? reject(new Error('inherited worker exit codeがありません')) : resolveExit(code));
      }).catch((error) =>
        fail('F005_CAPACITY_IPC_FAILED', 'inherited workerを完了できません', error));
      return Object.freeze({ pid, exitCode });
    };
    const beginPhase = async (
      phase: F005CapacityPhase,
      workId: string | null,
      phaseInstanceId: string,
    ): Promise<void> => {
      if (!PHASES.has(phase) || !SHA256.test(phaseInstanceId) ||
        workId !== options.workId) {
        return fail('F005_CAPACITY_IPC_FAILED', 'phase tupleが不正です');
      }
      await pipe?.command({ op: 'beginPhase', phase, workId, phaseInstanceId });
      activePhase = { phase, workId, phaseInstanceId };
      nextApplicationNoticeSequence = 1;
    };
    const endPhase = async (
      phase: F005CapacityPhase,
      phaseInstanceId: string,
    ): Promise<void> => {
      await pipe?.command({ op: 'endPhase', phase, phaseInstanceId });
      activePhase = null;
    };
    const observe = async (notice: NativeNotice): Promise<{
      readonly noticeId: string;
      readonly sessionNonce: string;
      readonly sequence: number;
      readonly workerPid: number;
      readonly matchedEtw: true;
    }> => {
      if (!SHA256.test(notice.noticeId) || !SHA256.test(notice.phaseInstanceId) ||
        !Number.isSafeInteger(notice.sequence) ||
        notice.sequence !== nextApplicationNoticeSequence ||
        (notice.kind === 'rename' ? typeof notice.targetPath !== 'string' : notice.targetPath !== null)) {
        return fail('F005_CAPACITY_IPC_FAILED', 'mutation noticeが不正です');
      }
      if (!activePhase ||
        activePhase.phase !== notice.phase ||
        activePhase.phaseInstanceId !== notice.phaseInstanceId) {
        return fail('F005_CAPACITY_IPC_FAILED', 'active phaseとnoticeが一致しません');
      }
      const path = normalizeF005CapacityNoticePath(options.workspace, notice.path);
      const targetPath = notice.kind === 'rename'
        ? normalizeF005CapacityNoticePath(options.workspace, notice.targetPath)
        : null;
      const command = notice.kind === 'rename'
        ? {
            op: 'notice',
            noticeId: notice.noticeId,
            phase: notice.phase,
            workId: activePhase.workId,
            phaseInstanceId: notice.phaseInstanceId,
            event: 'rename',
            from: path,
            to: targetPath,
          }
        : {
            op: 'notice',
            noticeId: notice.noticeId,
            phase: notice.phase,
            workId: activePhase.workId,
            phaseInstanceId: notice.phaseInstanceId,
            event: notice.kind,
            path,
          };
      const reply = await pipe?.command(command);
      if (!reply || reply.state !== 'matched' ||
        reply.noticeSequence !== lastNativeNoticeSequence + 1 ||
        !Array.isArray(reply.observationSequences) ||
        reply.observationSequences.length === 0) {
        return fail('F005_CAPACITY_IPC_FAILED', 'noticeに対応するETW観測がありません');
      }
      lastNativeNoticeSequence = Number(reply.noticeSequence);
      nextApplicationNoticeSequence += 1;
      return Object.freeze({
        noticeId: notice.noticeId,
        sessionNonce,
        sequence: notice.sequence,
        workerPid: process.pid,
        matchedEtw: true as const,
      });
    };

    const voiceBackend: F005CapacityRecorderBackend = Object.freeze({
      beginPhase,
      observeMutation: (notice: F005MutationNotice): Promise<F005MutationObservation> =>
        observe(notice),
      endPhase,
    });
    const acceptanceBackend: F005AcceptanceCapacityBackend = Object.freeze({
      beginPhase,
      observeMutation: (
        notice: F005AcceptanceMutationNotice,
      ): Promise<F005AcceptanceMutationObservation> =>
        observe({
          noticeId: notice.noticeId,
          sequence: notice.sequence,
          phase: notice.phase,
          phaseInstanceId: notice.phaseInstanceId,
          kind: notice.kind === 'rename' ? 'rename' : notice.kind,
          path: notice.path,
          targetPath: notice.targetPath,
        }).then((observation) => Object.freeze({
          noticeId: notice.noticeId,
          sessionNonce: observation.sessionNonce as Sha256,
          sequence: observation.sequence,
          workerPid: observation.workerPid,
          matchedEtw: observation.matchedEtw,
        })),
      endPhase,
    });
    mintedNativeBackends.add(voiceBackend);
    mintedNativeBackends.add(acceptanceBackend);
    const close = async (): Promise<F005NativeCapacityCloseResult> => {
      if (closed) return fail('F005_CAPACITY_IPC_FAILED', 'capacity sessionは既に終了しています');
      const reply = await pipe?.command({ op: 'close' });
      if (!reply || typeof reply.journalSha256 !== 'string' ||
        !SHA256.test(reply.journalSha256)) {
        return fail('F005_CAPACITY_IPC_FAILED', 'closed journal応答が不正です');
      }
      const raw = await readFile(join(options.workspace, ...journalPath.split('/')), 'utf8');
      if (sha256(raw) !== reply.journalSha256) {
        return fail('F005_CAPACITY_JOURNAL_INVALID', 'journal実体SHAが応答と一致しません');
      }
      const journal = validateF005CapacityJournalV3(JSON.parse(raw) as unknown, true);
      if (journal.workId !== options.workId ||
        journal.candidateSha256 !== options.candidateSha256 ||
        journal.owner !== options.owner ||
        journal.sessionNonce !== sessionNonce) {
        return fail('F005_CAPACITY_JOURNAL_INVALID', 'journal開始tupleがsessionと一致しません');
      }
      closed = true;
      pipe?.close();
      await guard.close();
      return Object.freeze({
        journalId,
        journalPath,
        journalSha256: reply.journalSha256,
        journal,
      });
    };
    const abort = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      pipe?.close();
      guard.terminate();
    };
    return Object.freeze({
      journalId,
      journalPath,
      owner: options.owner,
      workId: options.workId,
      candidateSha256: options.candidateSha256,
      sessionNonce,
      workerPid: process.pid,
      voiceBackend,
      acceptanceBackend,
      runInheritedWorker,
      beginPhase,
      observeMutation: async (
        notice: Parameters<F005NativeCapacitySession['observeMutation']>[0],
      ): Promise<void> => {
        await observe(notice);
      },
      endPhase,
      close,
      abort,
    });
  } catch (error) {
    pipe?.close();
    guard.terminate();
    if (error instanceof F005NativeCapacityError) throw error;
    return fail('F005_CAPACITY_IPC_FAILED', 'native capacity sessionの開始に失敗しました', error);
  }
}

export interface CapacityJournalV3 {
  readonly schemaVersion: 3;
  readonly owner: string;
  readonly workId: string;
  readonly candidateSha256: string;
  readonly initialFreeBytes: number;
  readonly minimumObservedFreeBytes: number;
  readonly sessionNonce: string;
  readonly jobIdentity: string;
  readonly etwSessionIdentity: string;
  readonly peakLiveBytes: number;
  readonly registeredWorkerPids: readonly number[];
  readonly phases: readonly Record<string, unknown>[];
  readonly notices: readonly Record<string, unknown>[];
  readonly observations: readonly Record<string, unknown>[];
  readonly state: 'open' | 'closed';
  readonly closedSeal: Record<string, unknown> | null;
}

/**
 * nativeがdurable closeしたjournalをworkspace境界内から再読込し、canonical bytesと
 * 固定producer pinを検証する。actual容量へのbridgeはこの関数だけを入口にする。
 */
export async function readF005NativeCapacityJournalFile(
  workspace: string,
  journalPath: string,
): Promise<CapacityJournalV3> {
  if (!isAbsolute(workspace) || resolve(workspace) !== workspace ||
    !/^\.cache\/f005-capacity\/[0-9a-f]{64}\.json$/u.test(journalPath)) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'native journal pathが不正です');
  }
  const lexicalPath = join(workspace, ...journalPath.split('/'));
  const [workspaceReal, journalReal, journalStat] = await Promise.all([
    realpath(workspace),
    realpath(lexicalPath),
    lstat(lexicalPath),
  ]).catch((error) => fail(
    'F005_CAPACITY_JOURNAL_INVALID',
    'native journal実体を検証できません',
    error,
  ));
  if (workspaceReal !== workspace || journalReal !== lexicalPath ||
    journalStat.isSymbolicLink() || !journalStat.isFile()) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'native journal実体またはworkspace境界が不正です');
  }
  const raw = await readFile(lexicalPath, 'utf8')
    .catch((error) => fail(
      'F005_CAPACITY_JOURNAL_INVALID',
      'native closed journalを再読込できません',
      error,
    ));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'native journal JSONが不正です', error);
  }
  if (raw !== canonicalJson(parsed)) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'native journalがcanonical bytesではありません');
  }
  return validateF005CapacityJournalV3(parsed, true);
}

/**
 * native journalを自己申告sealに依存せず再計算する。open journalは診断用にだけ
 * 読めるが、CapacityActualV3へ進める呼出しではrequireClosed=trueを必須とする。
 * @des DES-F005-006 DES-F005-012 @fun FUN-F005-019 FUN-F005-047 @ut UT-F005-019 UT-F005-047
 */
export function validateF005CapacityJournalV3(
  value: unknown,
  requireClosed = true,
): CapacityJournalV3 {
  if (!record(value) || !exactKeys(value, [
    'candidateSha256',
    'closedSeal',
    'etwSessionIdentity',
    'initialFreeBytes',
    'jobIdentity',
    'minimumObservedFreeBytes',
    'notices',
    'observations',
    'owner',
    'peakLiveBytes',
    'phases',
    'registeredWorkerPids',
    'schemaVersion',
    'sessionNonce',
    'state',
    'workId',
  ]) ||
    value.schemaVersion !== 3 ||
    !safeString(value.owner) ||
    !WORK_IDS.has(String(value.workId)) ||
    !SHA256.test(String(value.candidateSha256)) ||
    !safeInteger(value.initialFreeBytes) ||
    !safeInteger(value.minimumObservedFreeBytes) ||
    !safeInteger(value.peakLiveBytes) ||
    value.minimumObservedFreeBytes > value.initialFreeBytes ||
    !SHA256.test(String(value.sessionNonce)) ||
    !safeString(value.jobIdentity) ||
    !safeString(value.etwSessionIdentity) ||
    !Array.isArray(value.phases) ||
    !Array.isArray(value.registeredWorkerPids) ||
    value.registeredWorkerPids.some((pid) => !safeInteger(pid) || Number(pid) <= 0) ||
    value.registeredWorkerPids.some((pid, index, values) =>
      index > 0 && Number(values[index - 1]) >= Number(pid)) ||
    !Array.isArray(value.notices) ||
    !Array.isArray(value.observations) ||
    !['open', 'closed'].includes(String(value.state))) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'CapacityJournalV3 schemaが不正です');
  }
  if (value.state === 'open') {
    if (value.closedSeal !== null || requireClosed) {
      return fail('F005_CAPACITY_JOURNAL_INVALID', 'open journalはactualへ使用できません');
    }
    return Object.freeze(value) as unknown as CapacityJournalV3;
  }
  if (!record(value.closedSeal) || !exactKeys(value.closedSeal, [
    'etwSequenceGapCount',
    'firstEtwSequence',
    'journalBodySha256',
    'lastEtwSequence',
    'producerBinarySha256',
  ]) ||
    value.closedSeal.etwSequenceGapCount !== 0 ||
    !safeInteger(value.closedSeal.firstEtwSequence) ||
    !safeInteger(value.closedSeal.lastEtwSequence) ||
    !SHA256.test(String(value.closedSeal.journalBodySha256)) ||
    value.closedSeal.producerBinarySha256 !== F005_NATIVE_GUARD_PINS.outputBinarySha256 ||
    value.registeredWorkerPids.length === 0) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'closed sealが不正です');
  }

  const phaseInstances = new Map<string, { phase: string; workId: string | null; finished: boolean }>();
  for (const phaseRow of value.phases) {
    if (!record(phaseRow) || !exactKeys(phaseRow, [
      'freeBytes',
      'liveBytes',
      'observedAt',
      'phase',
      'phaseInstanceId',
      'state',
      'workId',
    ]) ||
      !PHASES.has(String(phaseRow.phase)) ||
      !SHA256.test(String(phaseRow.phaseInstanceId)) ||
      !['started', 'finished'].includes(String(phaseRow.state)) ||
      typeof phaseRow.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(phaseRow.observedAt)) ||
      !safeInteger(phaseRow.liveBytes) ||
      !safeInteger(phaseRow.freeBytes) ||
      (phaseRow.workId !== null && !WORK_IDS.has(String(phaseRow.workId)))) {
      return fail('F005_CAPACITY_JOURNAL_INVALID', 'phase record列が不正です');
    }
    const id = String(phaseRow.phaseInstanceId);
    const existing = phaseInstances.get(id);
    if (phaseRow.state === 'started') {
      if (existing) return fail('F005_CAPACITY_JOURNAL_INVALID', 'phase instanceが再利用されています');
      phaseInstances.set(id, {
        phase: String(phaseRow.phase),
        workId: phaseRow.workId === null ? null : String(phaseRow.workId),
        finished: false,
      });
    } else {
      if (!existing || existing.finished ||
        existing.phase !== phaseRow.phase || existing.workId !== phaseRow.workId) {
        return fail('F005_CAPACITY_JOURNAL_INVALID', 'phase start/finish pairが不正です');
      }
      existing.finished = true;
    }
  }
  if (phaseInstances.size === 0 ||
    [...phaseInstances.values()].some((phase) => !phase.finished)) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'phase recordが閉じていません');
  }

  const observationBySequence = new Map<number, Record<string, unknown>>();
  let expectedEtwSequence = 1;
  let recomputedPeak = 0;
  let recomputedMinimum = Number(value.initialFreeBytes);
  for (const observation of value.observations) {
    if (!record(observation)) {
      return fail('F005_CAPACITY_JOURNAL_INVALID', 'ETW observation列が不正です');
    }
    const event = String(observation.event);
    const expectedObservationKeys = event === 'rename'
      ? [
          'allocatedDeltaBytes', 'allocatedLengthBytes', 'etwSequence', 'event',
          'fileId128', 'freeBytesAvailable', 'freeBytesTotal', 'from', 'liveBytes',
          'logicalLengthBytes', 'noticeSequence', 'observedAt', 'phase',
          'phaseInstanceId', 'producer', 'producerBinarySha256', 'sha256', 'to',
          'volumeId', 'workId', 'workerPid',
        ]
      : [
          'allocatedDeltaBytes', 'allocatedLengthBytes', 'etwSequence', 'event',
          'fileId128', 'freeBytesAvailable', 'freeBytesTotal', 'liveBytes',
          'logicalLengthBytes', 'noticeSequence', 'observedAt', 'path', 'phase',
          'phaseInstanceId', 'producer', 'producerBinarySha256', 'sha256',
          'volumeId', 'workId', 'workerPid',
        ];
    const phaseBinding = phaseInstances.get(String(observation.phaseInstanceId));
    if (!exactKeys(observation, expectedObservationKeys) ||
      !safeInteger(observation.etwSequence) ||
      observation.etwSequence !== expectedEtwSequence++ ||
      !safeInteger(observation.workerPid) ||
      Number(observation.workerPid) <= 0 ||
      !value.registeredWorkerPids.includes(observation.workerPid) ||
      !PHASES.has(String(observation.phase)) ||
      !SHA256.test(String(observation.phaseInstanceId)) ||
      !safeInteger(observation.logicalLengthBytes) ||
      !safeInteger(observation.allocatedLengthBytes) ||
      !Number.isSafeInteger(observation.allocatedDeltaBytes) ||
      !safeInteger(observation.liveBytes) ||
      !safeInteger(observation.freeBytesAvailable) ||
      !safeInteger(observation.freeBytesTotal) ||
      Number(observation.freeBytesAvailable) > Number(observation.freeBytesTotal) ||
      !safeString(observation.volumeId) ||
      !safeString(observation.fileId128) ||
      typeof observation.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(observation.observedAt)) ||
      (observation.noticeSequence !== null &&
        (!safeInteger(observation.noticeSequence) || Number(observation.noticeSequence) <= 0)) ||
      (observation.sha256 !== null && !SHA256.test(String(observation.sha256))) ||
      (observation.workId !== null && !WORK_IDS.has(String(observation.workId))) ||
      !phaseBinding ||
      phaseBinding.phase !== observation.phase ||
      phaseBinding.workId !== observation.workId ||
      observation.producer !== 'f005-native-guard' ||
      observation.producerBinarySha256 !== value.closedSeal.producerBinarySha256 ||
      !['create', 'write', 'setinfo', 'rename', 'delete'].includes(event) ||
      (event === 'rename'
        ? !safeRelativePath(observation.from) || !safeRelativePath(observation.to)
        : !safeRelativePath(observation.path))) {
      return fail('F005_CAPACITY_JOURNAL_INVALID', 'ETW observation列が不正です');
    }
    const sequence = Number(observation.etwSequence);
    observationBySequence.set(sequence, observation);
    recomputedPeak = Math.max(recomputedPeak, Number(observation.liveBytes));
    recomputedMinimum = Math.min(recomputedMinimum, Number(observation.freeBytesAvailable));
  }
  if (observationBySequence.size === 0 ||
    value.closedSeal.firstEtwSequence !== 1 ||
    value.closedSeal.lastEtwSequence !== observationBySequence.size ||
    value.peakLiveBytes !== recomputedPeak ||
    value.minimumObservedFreeBytes !== recomputedMinimum) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'ETW sequenceまたは容量集計が不正です');
  }

  let expectedNoticeSequence = 1;
  const noticeIds = new Set<string>();
  const matchedObservationSequences = new Set<number>();
  for (const envelope of value.notices) {
    if (!record(envelope) || !exactKeys(envelope, [
      'notice',
      'noticeSequence',
      'observationSequences',
      'sessionNonce',
      'state',
      'workerPid',
    ]) ||
      envelope.sessionNonce !== value.sessionNonce ||
      envelope.noticeSequence !== expectedNoticeSequence++ ||
      envelope.state !== 'matched' ||
      !safeInteger(envelope.workerPid) ||
      !Array.isArray(envelope.observationSequences) ||
      envelope.observationSequences.length === 0 ||
      !record(envelope.notice) ||
      !SHA256.test(String(envelope.notice.noticeId)) ||
      noticeIds.has(String(envelope.notice.noticeId))) {
      return fail('F005_CAPACITY_JOURNAL_INVALID', 'notice envelope列が不正です');
    }
    const noticeEvent = String(envelope.notice.event);
    const expectedNoticeKeys = noticeEvent === 'rename'
      ? ['event', 'from', 'noticeId', 'phase', 'phaseInstanceId', 'to', 'workId']
      : ['event', 'noticeId', 'path', 'phase', 'phaseInstanceId', 'workId'];
    const phaseBinding = phaseInstances.get(String(envelope.notice.phaseInstanceId));
    if (!exactKeys(envelope.notice, expectedNoticeKeys) ||
      !['create', 'write', 'setinfo', 'rename', 'delete'].includes(noticeEvent) ||
      !PHASES.has(String(envelope.notice.phase)) ||
      !SHA256.test(String(envelope.notice.phaseInstanceId)) ||
      (envelope.notice.workId !== null && !WORK_IDS.has(String(envelope.notice.workId))) ||
      !phaseBinding ||
      phaseBinding.phase !== envelope.notice.phase ||
      phaseBinding.workId !== envelope.notice.workId ||
      (noticeEvent === 'rename'
        ? !safeRelativePath(envelope.notice.from) || !safeRelativePath(envelope.notice.to)
        : !safeRelativePath(envelope.notice.path))) {
      return fail('F005_CAPACITY_JOURNAL_INVALID', 'notice payload列が不正です');
    }
    noticeIds.add(String(envelope.notice.noticeId));
    for (const sequence of envelope.observationSequences) {
      const observation = observationBySequence.get(Number(sequence));
      if (!observation || matchedObservationSequences.has(Number(sequence)) ||
        observation.noticeSequence !== envelope.noticeSequence ||
        observation.workerPid !== envelope.workerPid ||
        observation.phase !== envelope.notice.phase ||
        observation.phaseInstanceId !== envelope.notice.phaseInstanceId ||
        observation.event !== envelope.notice.event ||
        (noticeEvent === 'rename'
          ? observation.from !== envelope.notice.from ||
            observation.to !== envelope.notice.to
          : observation.path !== envelope.notice.path)) {
        return fail('F005_CAPACITY_JOURNAL_INVALID', 'noticeとETW observationの結合が不正です');
      }
      matchedObservationSequences.add(Number(sequence));
    }
  }
  if ([...observationBySequence.values()].some((observation) =>
    observation.noticeSequence !== null &&
    !matchedObservationSequences.has(Number(observation.etwSequence)))) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'notice付きETW observationが未結合です');
  }

  const body = Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'state' && key !== 'closedSeal'));
  if (sha256(canonicalJson(body)) !== value.closedSeal.journalBodySha256) {
    return fail('F005_CAPACITY_JOURNAL_INVALID', 'journal body sealが一致しません');
  }
  return Object.freeze(value) as unknown as CapacityJournalV3;
}
