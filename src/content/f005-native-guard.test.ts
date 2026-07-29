import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import {
  classifyF005NativeCapacityReplyError,
  F005NativeCapacityError,
  flushF005ArtifactDirectory,
  normalizeF005CapacityNoticePath,
  validateF005CapacityJournalV3,
} from './f005-native-guard.ts';
import { F005_NATIVE_GUARD_PINS } from './f005-source.ts';
import { createF005NativeCapacityJournalReader } from './f005-voice.ts';

const PROJECT_ROOT = resolve('.');
const GUARD_EXE = resolve('.cache/dotnet-f005/publish/f005-guard.exe');
const SHA = '1'.repeat(64);
const PRODUCER_SHA = F005_NATIVE_GUARD_PINS.outputBinarySha256;
const temporaryRoots: string[] = [];

it('native reply自由文字列を固定capacity error codeへ分類する', () => {
  for (const [value, expected] of [
    ['ETW_ALLOCATED_LENGTH_MISSING', 'F005_ETW_ALLOCATED_LENGTH_MISSING'],
    ['ETW_BUFFER_LOSS', 'F005_ETW_BUFFER_LOSS'],
    ['ETW_CALLBACK_ACCESS_FAILED', 'F005_ETW_CALLBACK_ACCESS_FAILED'],
    ['ETW_CALLBACK_ARGUMENT_FAILED', 'F005_ETW_CALLBACK_ARGUMENT_FAILED'],
    ['ETW_CALLBACK_DISPOSED', 'F005_ETW_CALLBACK_DISPOSED'],
    ['ETW_CALLBACK_FAILED', 'F005_ETW_CALLBACK_FAILED'],
    ['ETW_CALLBACK_IO_FAILED', 'F005_ETW_CALLBACK_IO_FAILED'],
    ['ETW_CALLBACK_OVERFLOW', 'F005_ETW_CALLBACK_OVERFLOW'],
    ['ETW_CALLBACK_STATE_FAILED', 'F005_ETW_CALLBACK_STATE_FAILED'],
    ['ETW_CONSUMER_STOP_TIMEOUT', 'F005_ETW_CONSUMER_STOP_TIMEOUT'],
    ['ETW_EVENT_OUTSIDE_PHASE', 'F005_ETW_EVENT_OUTSIDE_PHASE'],
    ['ETW_FILE_IDENTITY_MISSING', 'F005_ETW_FILE_IDENTITY_MISSING'],
    ['ETW_FILE_IDENTITY_UNSAFE', 'F005_ETW_FILE_IDENTITY_UNSAFE'],
    ['ETW_OBSERVATION_MISSING', 'F005_ETW_OBSERVATION_MISSING'],
    ['ETW_PID_NOT_JOB_MEMBER', 'F005_ETW_PID_NOT_JOB_MEMBER'],
    ['ETW_RENAME_IDENTITY_MISMATCH', 'F005_ETW_RENAME_IDENTITY_MISMATCH'],
    ['ETW_SEQUENCE_GAP', 'F005_ETW_SEQUENCE_GAP'],
    ['ETW_UNKNOWN_EVENT', 'F005_ETW_UNKNOWN_EVENT'],
  ] as const) {
    expect(classifyF005NativeCapacityReplyError(value)).toBe(expected);
  }
  expect(classifyF005NativeCapacityReplyError('F005_CAPACITY_NOTICE_UNMATCHED'))
    .toBe('F005_CAPACITY_NOTICE_UNMATCHED');
  expect(classifyF005NativeCapacityReplyError('ETW_OBSERVATION_FAILED_secret'))
    .toBe('F005_ETW_CALLBACK_FAILED');
  expect(classifyF005NativeCapacityReplyError('ETW_CONSUMER_FAILED_secret'))
    .toBe('F005_ETW_CONSUMER_FAILED');
  expect(classifyF005NativeCapacityReplyError('ETW_SESSION_STOP_FAILED_secret'))
    .toBe('F005_ETW_SESSION_STOP_FAILED');
  expect(classifyF005NativeCapacityReplyError('ETW_PRIVILEGE_REQUIRED_5'))
    .toBe('F005_ETW_PRIVILEGE_REQUIRED');
  expect(classifyF005NativeCapacityReplyError('NOTICE_PHASE_MISMATCH_secret'))
    .toBe('F005_CAPACITY_GUARD_REJECTED');
  expect(classifyF005NativeCapacityReplyError(null))
    .toBe('F005_CAPACITY_GUARD_REJECTED');
  for (const prototypeKey of ['toString', 'constructor', '__proto__']) {
    expect(classifyF005NativeCapacityReplyError(prototypeKey))
      .toBe('F005_CAPACITY_GUARD_REJECTED');
  }
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validJournal(): Record<string, unknown> {
  const observation = {
    allocatedDeltaBytes: 4096,
    allocatedLengthBytes: 4096,
    etwSequence: 1,
    event: 'create',
    fileId128: '0123456789abcdef0123456789abcdef',
    freeBytesAvailable: 90_000,
    freeBytesTotal: 200_000,
    liveBytes: 4096,
    logicalLengthBytes: 8,
    noticeSequence: 1,
    observedAt: '2026-07-29T00:00:00.0000000+00:00',
    path: 'data/batches/F005/sample.wav',
    phase: 'voice',
    phaseInstanceId: SHA,
    producer: 'f005-native-guard',
    producerBinarySha256: PRODUCER_SHA,
    sha256: null,
    volumeId: '0011223344556677',
    workId: '000799',
    workerPid: 1234,
  };
  const notice = {
    notice: {
      event: 'create',
      noticeId: '3'.repeat(64),
      path: 'data/batches/F005/sample.wav',
      phase: 'voice',
      phaseInstanceId: SHA,
      workId: '000799',
    },
    noticeSequence: 1,
    observationSequences: [1],
    sessionNonce: SHA,
    state: 'matched',
    workerPid: 1234,
  };
  const body = {
    candidateSha256: 'b'.repeat(64),
    etwSessionIdentity: 'F005Capacity-fixture',
    initialFreeBytes: 100_000,
    jobIdentity: 'f005-job-fixture',
    minimumObservedFreeBytes: 90_000,
    notices: [notice],
    observations: [observation],
    owner: 'UT-F005-047',
    peakLiveBytes: 4096,
    phases: [
      {
        freeBytes: 100_000,
        liveBytes: 0,
        observedAt: '2026-07-29T00:00:00.0000000+00:00',
        phase: 'voice',
        phaseInstanceId: SHA,
        state: 'started',
        workId: '000799',
      },
      {
        freeBytes: 90_000,
        liveBytes: 4096,
        observedAt: '2026-07-29T00:00:01.0000000+00:00',
        phase: 'voice',
        phaseInstanceId: SHA,
        state: 'finished',
        workId: '000799',
      },
    ],
    registeredWorkerPids: [1234],
    schemaVersion: 3,
    sessionNonce: SHA,
    workId: '000799',
  };
  return {
    ...body,
    closedSeal: {
      etwSequenceGapCount: 0,
      firstEtwSequence: 1,
      journalBodySha256: hash(canonicalJson(body)),
      lastEtwSequence: 1,
      producerBinarySha256: PRODUCER_SHA,
    },
    state: 'closed',
  };
}

describe('F005 native ETW capacity guard', () => {
  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-019 FUN-F005-047 @test UT-F005-019 UT-F005-047 */
  it('closed CapacityJournalV3のETW・notice・容量・body sealを再計算する', () => {
    expect(validateF005CapacityJournalV3(validJournal())).toMatchObject({
      schemaVersion: 3,
      state: 'closed',
      peakLiveBytes: 4096,
      minimumObservedFreeBytes: 90_000,
    });
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 SC-F005-U047-A SC-F005-U047-B */
  it.each([
    ['sequence gap', (journal: Record<string, unknown>) => {
      ((journal.observations as Record<string, unknown>[])[0]!).etwSequence = 2;
    }],
    ['notice replay/gap', (journal: Record<string, unknown>) => {
      ((journal.notices as Record<string, unknown>[])[0]!).noticeSequence = 2;
    }],
    ['unknown event', (journal: Record<string, unknown>) => {
      ((journal.observations as Record<string, unknown>[])[0]!).event = 'unknown';
    }],
    ['producer mismatch', (journal: Record<string, unknown>) => {
      ((journal.observations as Record<string, unknown>[])[0]!).producerBinarySha256 = '4'.repeat(64);
    }],
    ['notice mismatch', (journal: Record<string, unknown>) => {
      (((journal.notices as Record<string, unknown>[])[0]!).notice as Record<string, unknown>).event = 'delete';
    }],
    ['notice path mismatch', (journal: Record<string, unknown>) => {
      (((journal.notices as Record<string, unknown>[])[0]!).notice as Record<string, unknown>).path =
        'data/batches/F005/other.wav';
    }],
  ])('%sではclosed journalを受理しない', (_label, mutate) => {
    const journal = structuredClone(validJournal());
    mutate(journal);
    expect(() => validateF005CapacityJournalV3(journal))
      .toThrowError(F005NativeCapacityError);
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 IT-F005-005 */
  it('open journalは診断読込だけ許しactualへの昇格を拒否する', () => {
    const journal = validJournal();
    journal.state = 'open';
    journal.closedSeal = null;
    expect(validateF005CapacityJournalV3(journal, false)).toMatchObject({ state: 'open' });
    expect(() => validateF005CapacityJournalV3(journal, true))
      .toThrowError(/open journal/u);
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 */
  it('application絶対pathをworkspace相対pathへ変換しescapeを拒否する', () => {
    const workspace = resolve('C:/f005-workspace');
    expect(normalizeF005CapacityNoticePath(
      workspace,
      resolve(workspace, 'data/batches/F005/sample.wav'),
    )).toBe('data/batches/F005/sample.wav');
    expect(() => normalizeF005CapacityNoticePath(
      workspace,
      resolve(workspace, '../escape.wav'),
    )).toThrowError(F005NativeCapacityError);
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-019 FUN-F005-047 @test UT-F005-019 UT-F005-047 */
  it('canonical native journalを既存actual journal readerへbridgeする', async () => {
    const workspace = resolve(await mkdtemp(join(tmpdir(), 'f005-native-journal-')));
    temporaryRoots.push(workspace);
    const journalId = 'a'.repeat(64);
    const journalPath = `.cache/f005-capacity/${journalId}.json`;
    await mkdir(join(workspace, '.cache', 'f005-capacity'), { recursive: true });
    const journalText = canonicalJson(validJournal());
    await writeFile(join(workspace, ...journalPath.split('/')), journalText, 'utf8');
    const reader = createF005NativeCapacityJournalReader({
      journalId,
      journalPath,
      journalSha256: createHash('sha256').update(journalText).digest('hex'),
      workId: '000799',
      candidateSha256: 'b'.repeat(64),
      workspaceRoot: workspace,
      distRoot: join(workspace, 'dist'),
      entries: [],
    });
    await expect(reader.readClosedCapacityJournal(workspace)).resolves.toMatchObject({
      schemaVersion: 3,
      state: 'closed',
      journalId,
      allowedWorkerPids: [1234],
      phases: [{ phase: 'voice', phaseInstanceId: SHA }],
      events: [{
        sequence: 1,
        path: 'data/batches/F005/sample.wav',
        noticeId: '3'.repeat(64),
      }],
    });
    const mismatchedReader = createF005NativeCapacityJournalReader({
      journalId,
      journalPath,
      journalSha256: createHash('sha256').update(journalText).digest('hex'),
      workId: '000799',
      candidateSha256: 'c'.repeat(64),
      workspaceRoot: workspace,
      distRoot: join(workspace, 'dist'),
      entries: [],
    });
    await expect(mismatchedReader.readClosedCapacityJournal(workspace))
      .rejects.toMatchObject({ code: 'F005_CAPACITY_ACTUAL_INVALID' });
  });

  /** @des DES-F005-006 DES-F005-012 @fun FUN-F005-047 @test UT-F005-047 IT-F005-005 */
  it.runIf(process.platform === 'win32')(
    '実binaryはkernel ETW権限不足を明示しfallbackしない',
    async () => {
      await expect(readFile(GUARD_EXE)).resolves.not.toHaveLength(0);
      const child = spawn(GUARD_EXE, [], {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = createInterface({ input: child.stdout });
      const replyPromise = new Promise<Record<string, unknown>>((resolveReply, reject) => {
        lines.once('line', (line) => {
          try {
            resolveReply(JSON.parse(line) as Record<string, unknown>);
          } catch (error) {
            reject(error);
          }
        });
        child.once('error', reject);
      });
      child.stdin.write('{"op":"capacity-preflight"}\n');
      const reply = await replyPromise;
      expect(
        reply.ok === true
          ? reply
          : { ok: reply.ok, error: String(reply.error).split('_').slice(0, 3).join('_') },
      ).toEqual(reply.ok === true
        ? expect.objectContaining({
            ok: true,
            capacityAbi: 'f005-capacity-pipe-v3',
            etw: 'kernel-fileio',
          })
        : { ok: false, error: 'ETW_PRIVILEGE_REQUIRED' });
      child.stdin.end();
      await new Promise<void>((resolveExit, reject) => {
        child.once('exit', (code) => code === 0
          ? resolveExit()
          : reject(new Error(`guard exit ${String(code)}`)));
        child.once('error', reject);
      });
    },
  );

  /** @des DES-F005-006 @fun FUN-F005-022 @test UT-F005-022 IT-F005-006 */
  it.runIf(process.platform === 'win32')(
    '固定native sync-directory opでworkspace配下directoryを実flushする',
    async () => {
      const workspace = resolve(await mkdtemp(join(tmpdir(), 'f005-native-directory-sync-')));
      temporaryRoots.push(workspace);
      const directory = join(workspace, 'evidence', 'voice');
      await mkdir(directory, { recursive: true });
      await expect(flushF005ArtifactDirectory(workspace, directory, {
        executable: GUARD_EXE,
      })).resolves.toBeUndefined();
      await expect(flushF005ArtifactDirectory(
        workspace,
        resolve(workspace, '..', 'escape'),
        { executable: GUARD_EXE },
      )).rejects.toMatchObject({ code: 'F005_DIRECTORY_SYNC_FAILED' });
    },
  );

  it.runIf(process.platform === 'win32')(
    '高速native guard終了でもexit listenerを取り逃がさない',
    async () => {
      const workspace = resolve(await mkdtemp(join(tmpdir(), 'f005-native-fast-exit-')));
      temporaryRoots.push(workspace);
      const directory = join(workspace, 'evidence');
      await mkdir(directory, { recursive: true });
      for (let attempt = 0; attempt < 16; attempt += 1) {
        await expect(flushF005ArtifactDirectory(workspace, directory, {
          executable: GUARD_EXE,
        })).resolves.toBeUndefined();
      }
      const source = await readFile(resolve('src/content/f005-native-guard.ts'), 'utf8');
      const closeBody = source.slice(
        source.indexOf('async close(): Promise<void>'),
        source.indexOf('terminate(): void'),
      );
      expect(closeBody.indexOf("this.process.once('exit', onExit)"))
        .toBeLessThan(closeBody.indexOf('this.process.stdin.end()'));
      expect(closeBody.indexOf('const observedExitCode = this.process.exitCode'))
        .toBeLessThan(closeBody.indexOf('this.process.stdin.end()'));
    },
  );

  it('rootだけを明示Job登録し、子workerはbreakaway禁止Job継承でETW認可する', async () => {
    const source = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    expect(source).toContain('case "registerSelf":');
    expect(source).not.toContain('case "registerPid":');
    expect(source).toContain('AuthorizeJobMemberLocked(data.ProcessID)');
    expect(source).toContain('AuthorizeJobMemberLocked(pid)');
    expect(source).toContain('foreach (var pid in job.MemberPids())');
    expect(source).toContain('QueryInformationJobObject(');
    expect(source).toContain('LimitFlags = JobObjectLimitKillOnJobClose');
    expect(source).not.toContain('JobObjectLimitBreakawayOk');
    expect(source).not.toContain('JobObjectLimitSilentBreakawayOk');
    expect(source).toContain('case "sync-directory":');
    expect(source).toContain('GetFinalPathNameByHandleW(');
    expect(source).toContain('FileFlagOpenReparsePoint');
    expect(source).toContain('ShareRead | ShareWrite');
    expect(source).toMatch(/CreateFileW\(\s*absolute,\s*0,\s*0x00000001 \| 0x00000002 \| 0x00000004/u);
    expect(source).toContain('FlushFileBuffers(heldDirectories[^1])');
  });

  it('rename ETWの旧名とnoticeの新名を同一FileIdで相関し、未照合renameを閉じない', async () => {
    const source = await readFile(resolve('native/f005-guard/Program.cs'), 'utf8');
    expect(source).toContain('private readonly Dictionary<string, FileSnapshot> filesByPath');
    expect(source).toContain('private readonly List<DeferredRenameRecord> deferredRenames');
    expect(source).toContain('kernel.FileIOCleanup += data => ForgetFileObject(data.FileObject)');
    expect(source).toContain('var source = filesByPath.GetValueOrDefault(normalized) ?? prior');
    expect(source).toContain(
      'var effective = current ?? filesByPath.GetValueOrDefault(normalized) ?? prior',
    );
    expect(source).not.toContain('filesByObject[deferred.FileObject] = target');
    expect(source).toContain('item.Source.RelativePath == from');
    expect(source).toContain('var target = TryInspect(notice.To)');
    expect(source).toContain('if (target.Identity != deferred.Source.Identity)');
    expect(source).toContain('deferredRenames.Any(item => item.PhaseInstanceId == phaseInstanceId)');
    expect(source).toMatch(/DeferredRenameRecord\(\s*pid,\s*checked\(\+\+etwSequence\)/u);
    expect(source).toContain('var sequence = deferred.EtwSequence');
    expect(source).toMatch(
      /if \(deferredRenames\.Count != 0\)\s*\{\s*PoisonLocked\("ETW_RENAME_IDENTITY_MISMATCH"\)/u,
    );
    expect(source).toContain('filesByPath.Remove(deferred.Source.RelativePath)');
    expect(source).toContain('filesByPath[target.RelativePath] = target');
  });
});
