import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import { validateBatchManifest, type BatchManifest, type Sha256, type WorkId } from './batch.ts';
import {
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
  runOfflineBuild,
  selectF005CurrentWork,
  verifyF005RunnerCandidateBinding,
  writeCanonicalArtifact,
} from '../../scripts/f005-run-work.ts';

const H = (value: string): Sha256 =>
  createHash('sha256').update(value).digest('hex') as Sha256;

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
