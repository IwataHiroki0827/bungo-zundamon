import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import {
  validateBatchManifest,
  type BatchManifest,
  type Sha256,
  type WorkId,
  type WorkspaceRelativePath,
} from './batch.ts';
import { F005NativeCapacityError } from './f005-native-guard.ts';
import {
  advanceF005RunnerManifest,
  createF005OfflineBuildArtifactPayloads,
  createF005LoopbackEngine,
  enterF005ProductionSession,
  F005_RUNNER_FAILURE_PREFIX,
  F005_RUNNER_PROGRESS_PREFIX,
  F005_RUNNER_PHASE_ORDER,
  F005_RUNNER_RESULT_PREFIX,
  F005_VOICE_PROGRESS_PREFIX,
  formatF005RunnerProgress,
  formatF005RunnerFailure,
  formatF005RunnerResult,
  formatF005VoiceProgress,
  parseF005RunWorkArguments,
  reportF005RunnerFailureBeforeAbort,
  resolveF005ExternalNativeGuardExecutable,
  runOfflineBuild,
  selectF005CurrentWork,
  verifyF005RunnerCandidateBinding,
  writeCanonicalArtifact,
} from '../../scripts/f005-run-work.ts';

const H = (value: string): Sha256 =>
  createHash('sha256').update(value).digest('hex') as Sha256;

it('hosted native guard overrideをreparse/hardlinkなしのworkspace外pathだけに限定する', async () => {
  const workspace = resolve('.');
  const root = await mkdtemp(join(tmpdir(), 'f005-native-outside-'));
  const external = join(root, 'f005-guard.exe');
  try {
    await writeFile(external, 'pinned');
    await expect(resolveF005ExternalNativeGuardExecutable(workspace, undefined))
      .resolves.toBeUndefined();
    await expect(resolveF005ExternalNativeGuardExecutable(workspace, external))
      .resolves.toBe(external);
    await expect(resolveF005ExternalNativeGuardExecutable(
      workspace,
      resolve(workspace, '.cache', 'dotnet-f005', 'publish', 'f005-guard.exe'),
    )).rejects.toThrow(/workspace外/u);
    await expect(resolveF005ExternalNativeGuardExecutable(workspace, 'f005-guard.exe'))
      .rejects.toThrow(/absolute path/u);
    const hardlink = join(root, 'hardlink.exe');
    await link(external, hardlink);
    await expect(resolveF005ExternalNativeGuardExecutable(workspace, external))
      .rejects.toThrow(/単一regular file/u);
    await rm(hardlink, { force: true });
    const target = join(root, 'target');
    const junction = join(root, 'junction');
    await mkdir(target);
    await writeFile(join(target, 'guard.exe'), 'pinned');
    await symlink(target, junction, 'junction');
    await expect(resolveF005ExternalNativeGuardExecutable(
      workspace,
      join(junction, 'guard.exe'),
    )).rejects.toThrow(/単一regular file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function manifest(): Promise<BatchManifest> {
  const parsed: unknown = JSON.parse(await readFile(
    resolve('content/batches/F005/batch.json'),
    'utf8',
  ));
  const checked = validateBatchManifest(parsed);
  if (!checked.ok) throw new Error(checked.error.message);
  return checked.value;
}

describe('F005 production work runner', () => {
  it('CLI終端はraw例外messageと絶対pathをstderrへ再出力しない', async () => {
    const secret = 'ETW_OBSERVATION_FAILED_80070005_secret';
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveChild) => {
      execFile(
        process.execPath,
        [
          '--no-warnings',
          '--experimental-transform-types',
          resolve('scripts/f005-run-work.ts'),
          '--work',
          secret,
        ],
        { cwd: resolve('.') },
        (error, _stdout, stderr) => {
          resolveChild({
            code: error && typeof error === 'object' && 'code' in error &&
              typeof error.code === 'number' ? error.code : null,
            stderr,
          });
        },
      );
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(resolve('.'));
  });

  it('CLI work IDを必須化しmanifest順の現在workだけを選ぶ', async () => {
    const value = await manifest();
    expect(parseF005RunWorkArguments(['--work', '000799'])).toBe('000799');
    expect(selectF005CurrentWork(value, '000799' as WorkId)).toEqual({
      workId: '000799',
      acceptedWorkIds: [],
    });
    expect(() => parseF005RunWorkArguments(['--work', '001076'])).not.toThrow();
    expect(() => selectF005CurrentWork(value, '001076' as WorkId)).toThrow(/manifest順/u);

    const progressed = {
      ...value,
      workProgress: value.workProgress.map((work, index) =>
        index === 0 ? { ...work, status: 'accepted' as const } : work),
    } as unknown as BatchManifest;
    expect(selectF005CurrentWork(progressed, '001076' as WorkId)).toEqual({
      workId: '001076',
      acceptedWorkIds: ['000799'],
    });
  });

  it('manifest段階証跡を直前outputへ結合してvoicedまで連続遷移する', async () => {
    const workId = '000799' as WorkId;
    let value = await manifest();
    value = advanceF005RunnerManifest(
      value,
      workId,
      'extracted',
      H('source'),
      63,
      {},
      '2026-07-29T00:00:00.000Z',
    );
    value = advanceF005RunnerManifest(
      value,
      workId,
      'reviewed',
      H('review'),
      63,
      { pendingCount: 0 },
      '2026-07-29T00:01:00.000Z',
    );
    value = advanceF005RunnerManifest(
      value,
      workId,
      'budget-approved',
      H('forecast'),
      63,
      {
        forecastRef:
          'content/batches/F005/capacity-forecast/000799.json' as WorkspaceRelativePath,
      },
      '2026-07-29T00:02:00.000Z',
    );
    value = advanceF005RunnerManifest(
      value,
      workId,
      'voiced',
      H('voice'),
      62,
      {
        voiceEvidenceRef:
          'content/batches/F005/work-artifacts/000799/voice-generation.json' as WorkspaceRelativePath,
      },
      '2026-07-29T00:03:00.000Z',
    );
    const progress = value.workProgress[0];
    expect(progress.status).toBe('voiced');
    expect(progress.stageRecords).toHaveLength(4);
    for (let index = 1; index < progress.stageRecords.length; index += 1) {
      const previous = progress.stageRecords[index - 1];
      const current = progress.stageRecords[index];
      expect(current?.inputHashes).toContain(previous?.outputHashes[0]);
    }
    expect(advanceF005RunnerManifest(
      value,
      workId,
      'voiced',
      H('voice'),
      62,
      {
        voiceEvidenceRef:
          'content/batches/F005/work-artifacts/000799/voice-generation.json' as WorkspaceRelativePath,
      },
    )).toBe(value);
    expect(() => advanceF005RunnerManifest(
      value,
      workId,
      'voiced',
      H('different-voice'),
      62,
      {
        voiceEvidenceRef:
          'content/batches/F005/work-artifacts/000799/new-run.json' as WorkspaceRelativePath,
      },
    )).toThrow(/再開証跡/u);
    expect(() => advanceF005RunnerManifest(
      value,
      workId,
      'budget-approved',
      H('forecast'),
      64,
      {
        forecastRef:
          'content/batches/F005/capacity-forecast/000799.json' as WorkspaceRelativePath,
      },
    )).toThrow(/再開証跡/u);
  });

  it('read-only準備→native preflight/session開始→mutationの順を崩さない', async () => {
    const calls: string[] = [];
    await expect(enterF005ProductionSession(
      async () => {
        calls.push('read-only');
        return { candidateSha256: H('candidate'), workId: '000799' };
      },
      async () => {
        calls.push('preflight/start');
        throw new Error('ETW_PRIVILEGE_REQUIRED');
      },
      async () => {
        calls.push('mutation');
      },
    )).rejects.toThrow(/ETW_PRIVILEGE_REQUIRED/u);
    expect(calls).toEqual(['read-only', 'preflight/start']);

    calls.length = 0;
    await enterF005ProductionSession(
      async () => {
        calls.push('read-only');
        return 'verified';
      },
      async () => {
        calls.push('preflight/start');
        return 'native-session';
      },
      async () => {
        calls.push('mutation');
      },
    );
    expect(calls).toEqual(['read-only', 'preflight/start', 'mutation']);
  });

  it('native session開始失敗は固定codeだけをguard停止前にstderrへflushする', async () => {
    const source = await readFile(resolve('scripts/f005-run-work.ts'), 'utf8');
    expect(source).toContain('F005_NATIVE_START_FAILURE=${code}');
    expect(source).toContain('onStartupFailure: (code: F005NativeCapacityErrorCode)');
  });

  it('capacity candidateは候補file SHAではなくApproved Context結合SHAとして照合する', () => {
    const candidateText = canonicalJson([{ candidateId: 'candidate-1' }]);
    const approvedContextSha = H('approved-context');
    expect(H(candidateText)).not.toBe(approvedContextSha);
    expect(verifyF005RunnerCandidateBinding(
      candidateText,
      approvedContextSha,
      approvedContextSha,
    )).toBe(approvedContextSha);
    expect(() => verifyF005RunnerCandidateBinding(
      candidateText,
      H('stale-forecast'),
      approvedContextSha,
    )).toThrow(/Approved Context/u);
    expect(() => verifyF005RunnerCandidateBinding(
      `${candidateText} `,
      approvedContextSha,
      approvedContextSha,
    )).toThrow(/canonical JSON/u);
  });

  it('空distや自己申告値ではなく実測public/dist treeをformal artifactへ結合する', () => {
    const publicTree = H('public-tree');
    const distTree = H('dist-tree');
    const payloads = createF005OfflineBuildArtifactPayloads({
      manifestSha256: H('manifest'),
      baselineDescriptorSha256: H('baseline'),
      expectedPublicTreeSha256: publicTree,
      publicMeasurement: { treeSha256: publicTree, fileCount: 694, totalBytes: 229_844_709 },
      distMeasurement: { treeSha256: distTree, fileCount: 697, totalBytes: 229_936_251 },
    });
    expect(payloads['content-build']).toMatchObject({
      command: 'node scripts/build-offline.mjs',
      public: { treeSha256: publicTree, fileCount: 694 },
      dist: { treeSha256: distTree, fileCount: 697 },
    });
    expect(payloads['f001-content-invariant-report']).toMatchObject({
      result: 'pass',
      expectedPublicTreeSha256: publicTree,
      actualPublicTreeSha256: publicTree,
    });
    expect(() => createF005OfflineBuildArtifactPayloads({
      manifestSha256: H('manifest'),
      baselineDescriptorSha256: H('baseline'),
      expectedPublicTreeSha256: publicTree,
      publicMeasurement: { treeSha256: publicTree, fileCount: 694, totalBytes: 229_844_709 },
      distMeasurement: { treeSha256: H('empty'), fileCount: 0, totalBytes: 0 },
    })).toThrow(/実測tree binding/u);
    expect(() => createF005OfflineBuildArtifactPayloads({
      manifestSha256: H('manifest'),
      baselineDescriptorSha256: H('baseline'),
      expectedPublicTreeSha256: publicTree,
      publicMeasurement: {
        treeSha256: H('mutated-public'),
        fileCount: 694,
        totalBytes: 229_844_709,
      },
      distMeasurement: { treeSha256: distTree, fileCount: 697, totalBytes: 229_936_251 },
    })).toThrow(/実測tree binding/u);
  });

  it('actualが要求する作品単位phase順をrunner定数でも固定する', () => {
    expect(F005_RUNNER_PHASE_ORDER).toEqual([
      'voice',
      'build',
      'preview',
      'build',
      'accept',
    ]);
    expect(new Set(F005_RUNNER_PHASE_ORDER)).toEqual(
      new Set(['voice', 'build', 'preview', 'accept']),
    );
    expect(vi.isMockFunction(enterF005ProductionSession)).toBe(false);
  });

  it('build logと混在しても一意marker付き1行JSONから結果を抽出できる', () => {
    const line = formatF005RunnerResult({
      ok: true,
      workId: '000799',
      status: 'accepted',
      journalId: H('journal'),
    });
    expect(line.split('\n')).toHaveLength(3);
    expect(line.startsWith(`\n${F005_RUNNER_RESULT_PREFIX}`)).toBe(true);
    const markerLine = line.split('\n')[1]!;
    expect(JSON.parse(markerLine.slice(F005_RUNNER_RESULT_PREFIX.length))).toMatchObject({
      ok: true,
      workId: '000799',
      status: 'accepted',
    });
    const mixed = `vite build output without trailing newline${line}`;
    const resultLines = mixed.split(/\r?\n/u)
      .filter((entry) => entry.startsWith(F005_RUNNER_RESULT_PREFIX));
    expect(resultLines).toHaveLength(1);
    expect(JSON.parse(
      resultLines[0]!.slice(F005_RUNNER_RESULT_PREFIX.length),
    )).toMatchObject({ workId: '000799', status: 'accepted' });
    expect(formatF005RunnerProgress('session-close-start'))
      .toBe(`${F005_RUNNER_PROGRESS_PREFIX}session-close-start\n`);
    expect(formatF005VoiceProgress('staging-root-created'))
      .toBe(`${F005_VOICE_PROGRESS_PREFIX}staging-root-created\n`);
    const unsafe = new Error(
      `https://runner:ghp_secret@example.invalid/repo SECRET=value ${'x'.repeat(100_000)}`,
    );
    Object.assign(unsafe, {
      name: 'github_pat_AAAAAAAAAAAAAAAAAAAAAAAA',
      code: 'GITHUB_PAT_SECRET_VALUE',
    });
    unsafe.stack = [
      'Error: ghp_secret SECRET=value',
      `${resolve('src/github_pat_secret.ts')}:123456789:123456789`,
      `    at generate (${resolve('scripts/f005-run-work.ts')}:401:12)`,
      '    at outside (C:\\Users\\owner\\.env:1:1)',
    ].join('\n');
    const failure = formatF005RunnerFailure(unsafe, resolve('.'));
    expect(failure.startsWith(F005_RUNNER_FAILURE_PREFIX)).toBe(true);
    expect(JSON.parse(failure.slice(F005_RUNNER_FAILURE_PREFIX.length))).toMatchObject({
      name: 'Error',
      code: null,
      frames: ['scripts/f005-run-work.ts'],
      cause: null,
    });
    expect(failure).not.toContain('ghp_secret');
    expect(failure).not.toContain('github_pat');
    expect(failure).not.toContain('SECRET=value');
    expect(failure).not.toContain('C:\\Users\\owner');
    expect(failure.length).toBeLessThan(1_024);

    const connection = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED token'), { code: 'ECONNREFUSED' }),
    });
    expect(JSON.parse(
      formatF005RunnerFailure(connection).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      name: 'TypeError',
      code: null,
      cause: { name: 'Error', code: 'ECONNREFUSED' },
    });
    const engine = Object.assign(
      new Error('fixed runner boundary'),
      { name: 'F005RunnerEngineError', code: 'F005_ENGINE_VERSION_REQUEST_FAILED' },
    );
    expect(JSON.parse(
      formatF005RunnerFailure(engine).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      name: 'F005RunnerEngineError',
      code: 'F005_ENGINE_VERSION_REQUEST_FAILED',
    });
    const nativeCleanup = new F005NativeCapacityError(
      'F005_NATIVE_WRITE_THROUGH_CLEANUP_FAILED',
      'native fixed category only',
    );
    const voice = Object.assign(
      new Error('voice boundary', { cause: nativeCleanup }),
      {
        name: 'F005VoiceError',
        code: 'F005_VOICE_NATIVE_OBSERVE_FAILED',
      },
    );
    expect(JSON.parse(
      formatF005RunnerFailure(voice).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      name: 'F005VoiceError',
      code: 'F005_VOICE_NATIVE_OBSERVE_FAILED',
      cause: {
        name: 'F005NativeCapacityError',
        code: 'F005_NATIVE_WRITE_THROUGH_CLEANUP_FAILED',
      },
    });
    const systemSetInfoCode =
      'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_SETINFO_UNKNOWN_PATH_CONTENT_TMP_ABSENT_UNBOUND_LEASE';
    const systemSetInfo = new F005NativeCapacityError(
      systemSetInfoCode,
      'fixed bucket only',
    );
    const systemSetInfoVoice = Object.assign(
      new Error('voice boundary', { cause: systemSetInfo }),
      {
        name: 'F005VoiceError',
        code: 'F005_VOICE_NATIVE_OBSERVE_FAILED',
      },
    );
    expect(JSON.parse(
      formatF005RunnerFailure(systemSetInfoVoice).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      cause: {
        name: 'F005NativeCapacityError',
        code: systemSetInfoCode,
      },
    });
    const correlationCode =
      'F005_ETW_SYSTEM_SETINFO_CORRELATION_DEFERRED_SNAPSHOT_MISSING';
    const correlation = new F005NativeCapacityError(
      correlationCode,
      'fixed correlation stage only',
    );
    expect(JSON.parse(
      formatF005RunnerFailure(
        new Error('voice boundary', { cause: correlation }),
      ).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      cause: {
        name: 'F005NativeCapacityError',
        code: correlationCode,
      },
    });
    const rejoinCode =
      'F005_ETW_COMPLETED_WRITE_REJOIN_AFTER_COMPLETION_WITHIN_100MS';
    const rejoin = new F005NativeCapacityError(
      rejoinCode,
      'fixed completed-write rejoin stage only',
    );
    expect(JSON.parse(
      formatF005RunnerFailure(
        new Error('voice boundary', { cause: rejoin }),
      ).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      cause: {
        name: 'F005NativeCapacityError',
        code: rejoinCode,
      },
    });
    const closedLeaseCode = 'F005_ETW_CLOSED_LEASE_REJOIN_CANDIDATE';
    const closedLease = new F005NativeCapacityError(
      closedLeaseCode,
      'fixed closed-lease rejoin stage only',
    );
    expect(JSON.parse(
      formatF005RunnerFailure(
        new Error('voice boundary', { cause: closedLease }),
      ).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      cause: {
        name: 'F005NativeCapacityError',
        code: closedLeaseCode,
      },
    });
    const unboundWriteCode =
      'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_LEASE_CLOSED_CANDIDATE';
    const unboundWrite = new F005NativeCapacityError(
      unboundWriteCode,
      'fixed System unbound write stage only',
    );
    expect(JSON.parse(
      formatF005RunnerFailure(
        new Error('voice boundary', { cause: unboundWrite }),
      ).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      cause: {
        name: 'F005NativeCapacityError',
        code: unboundWriteCode,
      },
    });
    const privateUnboundWrite = Object.assign(new Error('private'), {
      name: 'F005NativeCapacityError',
      code:
        'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_PROCESS_UNBOUND_FILE_OBJECT_WRITE_KNOWN_PATH_PRIVATE',
    });
    expect(JSON.parse(
      formatF005RunnerFailure(
        new Error('voice boundary', { cause: privateUnboundWrite }),
      ).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      cause: {
        name: 'F005NativeCapacityError',
        code: null,
      },
    });
    const otherKnownPathCode =
      'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_UNBOUND_WRITE_OTHER_KNOWN_PATH_CACHE_OTHER_DIRECTORY_UNBOUND_LEASE';
    const otherKnownPath = new F005NativeCapacityError(
      otherKnownPathCode,
      'fixed other known path bucket only',
    );
    expect(JSON.parse(
      formatF005RunnerFailure(
        new Error('voice boundary', { cause: otherKnownPath }),
      ).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      cause: {
        name: 'F005NativeCapacityError',
        code: otherKnownPathCode,
      },
    });
    const directoryRejoinCode =
      'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_WRITE_REJOIN_CANDIDATE';
    const directoryRejoin = new F005NativeCapacityError(
      directoryRejoinCode,
      'fixed directory rejoin stage only',
    );
    expect(JSON.parse(
      formatF005RunnerFailure(
        new Error('voice boundary', { cause: directoryRejoin }),
      ).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      cause: {
        name: 'F005NativeCapacityError',
        code: directoryRejoinCode,
      },
    });
    const privateDirectoryRejoin = Object.assign(new Error('private'), {
      name: 'F005NativeCapacityError',
      code: 'F005_ETW_PID_NOT_JOB_MEMBER_SYSTEM_DIRECTORY_WRITE_REJOIN_PRIVATE',
    });
    expect(JSON.parse(
      formatF005RunnerFailure(
        new Error('voice boundary', { cause: privateDirectoryRejoin }),
      ).slice(F005_RUNNER_FAILURE_PREFIX.length),
    )).toMatchObject({
      cause: {
        name: 'F005NativeCapacityError',
        code: null,
      },
    });
  });

  it.each([
    ['callback error', (callback: (error?: Error | null) => void) => callback(new Error('closed'))],
    ['writer throw', () => { throw new Error('closed'); }],
    ['no callback', () => undefined],
  ])('診断が%sでもtimeout後までにnative abortを必ず実行する', async (_label, behavior) => {
    const abort = vi.fn(async () => undefined);
    await reportF005RunnerFailureBeforeAbort(
      new Error('do not leak this message'),
      resolve('.'),
      (_value, callback) => behavior(callback),
      abort,
      10,
    );
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('診断flush成功後にnative abortを一度だけ実行する', async () => {
    const abort = vi.fn(async () => undefined);
    await reportF005RunnerFailureBeforeAbort(
      new Error('voice failed'),
      resolve('.'),
      (_value, callback) => callback(),
      abort,
      10,
    );
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('固定上限付きnode:http transportでloopback engineの4 APIを処理する', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/version') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify('0.25.2'));
      } else if (request.url === '/speakers') {
        response.setHeader('content-type', 'application/json');
        response.end('[]');
      } else if (request.url?.startsWith('/audio_query?')) {
        response.setHeader('content-type', 'application/json');
        response.end('{"accent_phrases":[]}');
      } else if (request.url === '/synthesis?speaker=3') {
        response.setHeader('content-type', 'audio/wav');
        response.end(Buffer.from([82, 73, 70, 70]));
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('test server address missing');
      const engine = createF005LoopbackEngine(
        new URL(`http://127.0.0.1:${String(address.port)}/`),
      );
      await expect(engine.getVersion()).resolves.toBe('0.25.2');
      await expect(engine.getSpeakers()).resolves.toEqual([]);
      await expect(engine.createAudioQuery('吾輩')).resolves.toEqual({ accent_phrases: [] });
      await expect(engine.synthesize({ speedScale: 1 })).resolves.toEqual(
        new Uint8Array([82, 73, 70, 70]),
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    }
  });

  it('offline buildはspawn後PID登録を行わず、Job継承worker契約だけで起動する', async () => {
    const calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
    await runOfflineBuild(resolve('.'), async (executable, args, cwd) => {
      calls.push({ executable, args, cwd });
      return { pid: 1234, exitCode: 0 };
    });
    expect(calls).toEqual([{
      executable: process.execPath,
      args: [resolve('scripts/build-offline.mjs')],
      cwd: resolve('.'),
    }]);
    await expect(runOfflineBuild(resolve('.'), async () => ({ pid: 1234, exitCode: 9 })))
      .rejects.toThrow(/offline build failed: 9/u);
  });

  it('manifest参照artifactは同一bytesをdurable再開し、異なる既存bytesを上書きしない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f005-runner-durable-'));
    try {
      const target = join(root, 'evidence', 'voice.json');
      const value = { schemaVersion: '1.0.0', kind: 'voice', workId: '000799' };
      const syncedDirectories: string[] = [];
      const syncDirectory = async (workspace: string, directory: string): Promise<void> => {
        expect(workspace).toBe(root);
        syncedDirectories.push(directory);
      };
      const first = await writeCanonicalArtifact(root, target, value, syncDirectory);
      const second = await writeCanonicalArtifact(root, target, value, syncDirectory);
      expect(second).toBe(first);
      expect(syncedDirectories).toEqual([join(root, 'evidence'), join(root, 'evidence')]);
      await writeFile(target, '{"attacker":true}\n', 'utf8');
      await expect(writeCanonicalArtifact(root, target, value, syncDirectory))
        .rejects.toThrow(/既存artifactが現在のtupleと異なります/u);
      expect(await readFile(target, 'utf8')).toBe('{"attacker":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
