import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import {
  F005NativeCapacityError,
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
    schemaVersion: 3,
    sessionNonce: SHA,
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
    await writeFile(join(workspace, ...journalPath.split('/')), canonicalJson(validJournal()), 'utf8');
    const reader = createF005NativeCapacityJournalReader({
      journalId,
      journalPath,
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
            capacityAbi: 'f005-capacity-pipe-v1',
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
});
