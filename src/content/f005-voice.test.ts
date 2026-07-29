import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VoiceEstimateProfileV2 } from './f003-reuse.ts';
import {
  createF005CapacityRecorder,
  F005VoiceError,
  generateF005Voice,
  measureF005ActualCapacity,
  planF005VoiceDiff,
  sealF005CapacityJournal,
  validateF005CandidateSafety,
  type F005CapacityJournalEvent,
  type F005CapacityRecorderBackend,
  type F005ClosedCapacityJournal,
  type F005LoopbackEngine,
} from './f005-voice.ts';
import { F002_VOICE_CONFIG } from '../voice/f003.ts';
import { createVoiceCacheKeyV2, voiceConfigHashV2 } from '../voice/cache.ts';

const H = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const temporaryDirectories: string[] = [];

const PROFILE = Object.freeze({
  artifactSha256: 'f3d23c29a03d140e9203360923caaacb5a42c805990c81fe7593850559b298b0',
  bitDepth: 16,
  calibratedAt: '2026-07-26T02:59:39.000+09:00',
  channels: 1,
  configHash: '0c42dc249190ce75ad6f7dee06aeae099abcef4bbd7c23411c966c9389d14691',
  maxRelativeError: 0.2,
  observedActualBytes: 47741940,
  observedEstimatedBytes: 57293300,
  observedRelativeError: 0.1667098945251888,
  outputSamplingRate: 24000,
  safetyFactor: 1.2,
  sampleCount: 151,
  schemaVersion: '2.0.0',
  secondsPerCharacter: 0.1624195655724318,
  sourceReleaseCommit: '84c985f382910216e381a96901f6fd569165a27e',
  sourceSetSha256: '0951c2da012c91d646b2a435b96ea6c7d9fa18809e84419245191114cf2605ff',
  wavHeaderBytes: 44,
} as unknown as VoiceEstimateProfileV2);

function speech(text: string, candidateId = 'candidate') {
  return { candidateId, speechText: text, speechSha256: H(text), approved: true as const };
}

function wav(durationMs: number): Uint8Array {
  const dataBytes = durationMs * 48;
  const value = new Uint8Array(44 + dataBytes);
  const view = new DataView(value.buffer);
  value.set(Buffer.from('RIFF'), 0);
  view.setUint32(4, value.byteLength - 8, true);
  value.set(Buffer.from('WAVE'), 8);
  value.set(Buffer.from('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  value.set(Buffer.from('data'), 36);
  view.setUint32(40, dataBytes, true);
  return value;
}

function engine(bytes: Uint8Array): F005LoopbackEngine {
  return {
    baseUrl: new URL('http://127.0.0.1:50021'),
    config: F002_VOICE_CONFIG,
    getVersion: vi.fn(async () => '0.25.2'),
    getSpeakers: vi.fn(async () => [{
      name: 'ずんだもん',
      speaker_uuid: '388f246b-8c41-4ac1-8e2d-5d79f3ff56d9',
      styles: [{ id: 3, name: 'ノーマル' }],
    }]),
    createAudioQuery: vi.fn(async (text: string) => ({ text })),
    synthesize: vi.fn(async () => bytes),
  };
}

function recorderBackend(sessionNonce: string, calls?: string[]) {
  return {
    beginPhase: async () => { calls?.push('begin'); },
    writeTemporary: async (path: string, bytes: Uint8Array, sha256: string) => {
      expect(H(bytes)).toBe(sha256);
      await writeFile(path, bytes, { flag: 'wx' });
      let currentPath = path;
      return {
        producerPid: process.pid,
        nativeIdentity: '00000001:0000000000000001' as const,
        rename: async (targetPath: string) => {
          calls?.push('write-rename');
          await rename(currentPath, targetPath);
          currentPath = targetPath;
        },
        commit: async () => { calls?.push('write-commit'); },
        abort: async () => {
          calls?.push('write-abort');
          await rm(currentPath, { force: true });
        },
      };
    },
    observeMutation: async (notice: {
      noticeId: string;
      sequence: number;
      kind: string;
      producerPid: number;
    }) => {
      calls?.push(notice.kind);
      return {
        noticeId: notice.noticeId,
        sessionNonce,
        sequence: notice.sequence,
        workerPid: notice.producerPid,
        matchedEtw: true as const,
      };
    },
    endPhase: async () => { calls?.push('end'); },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('UT-F005-015 candidate safety [DES-F005-006][FUN-F005-015]', () => {
  it('500 Unicode code pointを許し501をblockedにする', () => {
    const exact = validateF005CandidateSafety([speech('あ'.repeat(500))], PROFILE, F002_VOICE_CONFIG);
    const over = validateF005CandidateSafety([speech('あ'.repeat(501))], PROFILE, F002_VOICE_CONFIG);
    expect(exact).toMatchObject({ result: 'pass', items: [{ codePoints: 500 }] });
    expect(over).toMatchObject({
      result: 'blocked',
      items: [{ codePoints: 501, reasons: expect.arrayContaining(['CANDIDATE_CODE_POINT_LIMIT']) }],
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('非有限profile %sをfail-closedにする', (secondsPerCharacter) => {
    const report = validateF005CandidateSafety(
      [speech('台詞')],
      { ...PROFILE, secondsPerCharacter } as VoiceEstimateProfileV2,
      F002_VOICE_CONFIG,
    );
    expect(report.result).toBe('blocked');
    expect(report.items[0]?.reasons).toContain('VOICE_PROFILE_VALUE_INVALID');
  });

  it('getter/prototypeを入力境界で拒否する', () => {
    const getter = Object.defineProperty({}, 'artifactSha256', { get: () => PROFILE.artifactSha256 });
    expect(() => validateF005CandidateSafety([speech('台詞')], getter as VoiceEstimateProfileV2, F002_VOICE_CONFIG))
      .toThrowError(F005VoiceError);
    const inherited = Object.create(PROFILE) as VoiceEstimateProfileV2;
    expect(() => validateF005CandidateSafety([speech('台詞')], inherited, F002_VOICE_CONFIG))
      .toThrowError(F005VoiceError);
  });
});

describe('UT-F005-016 exact cache plan [DES-F005-006][FUN-F005-016]', () => {
  it('SHA/bytes/duration/configと物理WAVが全一致するものだけreuseする', () => {
    const item = speech('再利用');
    const audioId = createVoiceCacheKeyV2(item.speechText, F002_VOICE_CONFIG);
    const bytes = wav(10);
    const plan = planF005VoiceDiff([item], F002_VOICE_CONFIG, {
      entries: [{
        audioId,
        path: `audio/F005/${audioId}.wav`,
        sha256: H(bytes),
        bytes: bytes.byteLength,
        durationMs: 10,
        configHash: voiceConfigHashV2(F002_VOICE_CONFIG),
        wav: bytes,
      }],
    });
    expect(plan).toMatchObject({ reuseCount: 1, generateCount: 0, entries: [{ action: 'reuse', audioId }] });
  });

  it('missをgenerateへ分け、孤立・欠損・hash不一致を拒否する', () => {
    const item = speech('生成');
    expect(planF005VoiceDiff([item], F002_VOICE_CONFIG, { entries: [] }))
      .toMatchObject({ reuseCount: 0, generateCount: 1, entries: [{ action: 'generate' }] });
    const bytes = wav(1);
    const orphanId = H('orphan');
    const orphan = {
      audioId: orphanId,
      path: `audio/F005/${orphanId}.wav`,
      sha256: H(bytes),
      bytes: bytes.byteLength,
      durationMs: 1,
      configHash: voiceConfigHashV2(F002_VOICE_CONFIG),
      wav: bytes,
    };
    expect(() => planF005VoiceDiff([item], F002_VOICE_CONFIG, { entries: [orphan] }))
      .toThrowError(F005VoiceError);
    expect(() => planF005VoiceDiff([item], F002_VOICE_CONFIG, {
      entries: [{ ...orphan, audioId: createVoiceCacheKeyV2(item.speechText, F002_VOICE_CONFIG), sha256: H('bad') }],
    })).toThrowError(F005VoiceError);
  });
});

describe('UT-F005-017 generation/native recorder [DES-F005-006][FUN-F005-017]', () => {
  it('concurrency 1でbegin→create notice→rename notice→endをawaitする', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'f005-voice-'));
    temporaryDirectories.push(parent);
    const stage = join(parent, 'stage');
    const calls: string[] = [];
    const nonce = H('nonce');
    const recorder = createF005CapacityRecorder({
      journalId: H('journal'),
      owner: 'worker',
      sessionNonce: nonce,
      workerPid: process.pid,
    }, recorderBackend(nonce, calls));
    const plan = planF005VoiceDiff([speech('生成')], F002_VOICE_CONFIG, { entries: [] });
    const progress: string[] = [];
    const evidence = await generateF005Voice(
      plan,
      engine(wav(1)),
      stage,
      recorder,
      '000799',
      1,
      120_000,
      (stageName) => progress.push(stageName),
    );
    expect(calls).toEqual([
      'begin',
      'create',
      'create',
      'write-rename',
      'rename',
      'write-commit',
      'end',
    ]);
    expect(progress).toEqual([
      'engine-verified',
      'native-phase-begun',
      'staging-root-created',
      'staging-root-observed',
      'audio-query-created',
      'synthesis-complete',
      'wav-validated',
      'temporary-written',
      'temporary-observed',
      'audio-renamed',
      'rename-observed',
      'native-phase-ended',
    ]);
    expect(evidence.assets).toMatchObject([{ source: 'staging', durationMs: 1 }]);
    await expect(readFile(evidence.assets[0]!.path)).resolves.toHaveLength(92);
    const source = await readFile(join(process.cwd(), 'src/content/f005-voice.ts'), 'utf8');
    const written = source.indexOf('capacityRecorder.writeTemporary(temporary, wav, digest)');
    const noticed = source.indexOf("await notice(\n          'create',\n          temporary", written);
    const renamed = source.indexOf('temporaryWrite.rename(destination)', noticed);
    const registered = source.indexOf('created.push(Object.freeze', renamed);
    const renameNoticed = source.indexOf("await notice(\n          'rename'", registered);
    const committed = source.indexOf('temporaryWrite.commit()', renameNoticed);
    expect([written, noticed, renamed, registered, renameNoticed, committed])
      .toEqual([...new Set([written, noticed, renamed, registered, renameNoticed, committed])]
        .sort((left, right) => left - right));
    expect(written).toBeGreaterThanOrEqual(0);
    expect(source).not.toContain('rm(root, { recursive: true');
    expect(source).not.toContain('rename(temporary, destination)');
  });

  it('voice phaseを対象work IDへ結合し、nullや別workへ落とさない', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'f005-voice-work-binding-'));
    temporaryDirectories.push(parent);
    const nonce = H('work-binding-nonce');
    const begun: Array<{ phase: string; workId: string | null }> = [];
    const backend = recorderBackend(nonce);
    const recorder = createF005CapacityRecorder({
      journalId: H('work-binding-journal'),
      owner: 'worker',
      sessionNonce: nonce,
      workerPid: process.pid,
    }, {
      ...backend,
      beginPhase: async (phase: 'voice', workId: string | null) => {
        begun.push({ phase, workId });
      },
    });
    const plan = planF005VoiceDiff([speech('作品結合')], F002_VOICE_CONFIG, { entries: [] });
    await generateF005Voice(plan, engine(wav(1)), join(parent, 'stage'), recorder, '001076');
    expect(begun).toEqual([{ phase: 'voice', workId: '001076' }]);
  });

  it('temporaryのETW認証失敗時はcommitせずnative leaseをabortする', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'f005-voice-write-abort-'));
    temporaryDirectories.push(parent);
    const calls: string[] = [];
    const nonce = H('write-abort-nonce');
    const backend = recorderBackend(nonce, calls);
    let observations = 0;
    const recorder = createF005CapacityRecorder({
      journalId: H('write-abort-journal'),
      owner: 'worker',
      sessionNonce: nonce,
      workerPid: process.pid,
    }, {
      ...backend,
      observeMutation: async (notice) => {
        observations += 1;
        if (observations === 2) throw new Error('temporary ETW match missing');
        return backend.observeMutation(notice);
      },
    });
    const plan = planF005VoiceDiff([speech('中断')], F002_VOICE_CONFIG, { entries: [] });
    await expect(generateF005Voice(
      plan,
      engine(wav(1)),
      join(parent, 'stage'),
      recorder,
      '000799',
    )).rejects.toMatchObject({ code: 'F005_VOICE_NATIVE_OBSERVE_FAILED' });
    expect(calls).toContain('write-abort');
    expect(calls).not.toContain('write-commit');
  });

  it('clone plan、concurrency>1、engine差、非WAV、notice欠落をfail-closedにする', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'f005-voice-negative-'));
    temporaryDirectories.push(parent);
    const basePlan = planF005VoiceDiff([speech('生成')], F002_VOICE_CONFIG, { entries: [] });
    const nonce = H('nonce');
    const recorder = createF005CapacityRecorder({
      journalId: H('journal'), owner: 'worker', sessionNonce: nonce, workerPid: process.pid,
    }, recorderBackend(nonce));
    await expect(generateF005Voice({ ...basePlan }, engine(wav(1)), join(parent, 'clone'), recorder, '000799'))
      .rejects.toMatchObject({ code: 'F005_VOICE_GENERATION_INVALID' });
    await expect(generateF005Voice(basePlan, engine(wav(1)), join(parent, 'parallel'), recorder, '000799', 2))
      .rejects.toMatchObject({ code: 'F005_VOICE_GENERATION_INVALID' });
    const wrongEngine = engine(wav(1));
    wrongEngine.getVersion = async () => '0.25.3';
    await expect(generateF005Voice(basePlan, wrongEngine, join(parent, 'engine'), recorder, '000799'))
      .rejects.toMatchObject({ code: 'F005_VOICE_GENERATION_INVALID' });
    await expect(generateF005Voice(
      basePlan,
      engine(new Uint8Array([1, 2])),
      join(parent, 'wav'),
      recorder,
      '000799',
    ))
      .rejects.toMatchObject({ code: 'F005_VOICE_GENERATION_INVALID' });
    const lostRecorder = createF005CapacityRecorder({
      journalId: H('lost'), owner: 'worker', sessionNonce: H('lost-nonce'), workerPid: process.pid,
    }, {
      ...recorderBackend(H('lost-nonce')),
      observeMutation: async () => { throw new Error('ETW match missing'); },
    });
    await expect(generateF005Voice(basePlan, engine(wav(1)), join(parent, 'lost'), lostRecorder, '000799'))
      .rejects.toMatchObject({ code: 'F005_VOICE_NATIVE_OBSERVE_FAILED' });
  });

  it('native recorderのbegin/observe/end失敗を固定境界codeへ分類する', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'f005-voice-native-boundary-'));
    temporaryDirectories.push(parent);
    const plan = planF005VoiceDiff([speech('境界分類')], F002_VOICE_CONFIG, { entries: [] });
    const createRecorder = (
      label: string,
      overrides: Partial<F005CapacityRecorderBackend>,
    ) => {
      const nonce = H(`${label}-nonce`);
      return createF005CapacityRecorder({
        journalId: H(`${label}-journal`),
        owner: 'worker',
        sessionNonce: nonce,
        workerPid: process.pid,
      }, { ...recorderBackend(nonce), ...overrides });
    };
    await expect(generateF005Voice(
      plan,
      engine(wav(1)),
      join(parent, 'begin'),
      createRecorder('begin', {
        beginPhase: async () => { throw new Error('native begin detail'); },
      }),
      '000799',
    )).rejects.toMatchObject({ code: 'F005_VOICE_NATIVE_BEGIN_FAILED' });
    const writeFailureStage = join(parent, 'write-through');
    await expect(generateF005Voice(
      plan,
      engine(wav(1)),
      writeFailureStage,
      createRecorder('write-through', {
        writeTemporary: async (path) => {
          await writeFile(path, 'orphan-before-reply', { flag: 'wx' });
          throw new Error('native write-through detail');
        },
      }),
      '000799',
    )).rejects.toMatchObject({ code: 'F005_VOICE_NATIVE_OBSERVE_FAILED' });
    await expect(stat(writeFailureStage)).resolves.toMatchObject({});
    const untrustedOrphans = await readdir(writeFailureStage);
    expect(untrustedOrphans).toHaveLength(1);
    await expect(readFile(join(writeFailureStage, untrustedOrphans[0]!), 'utf8'))
      .resolves.toBe('orphan-before-reply');
    const replacementStage = join(parent, 'replacement-stage');
    const movedOriginalStage = join(parent, 'replacement-stage-original');
    await expect(generateF005Voice(
      plan,
      engine(wav(1)),
      replacementStage,
      createRecorder('replacement-stage', {
        writeTemporary: async () => {
          await rename(replacementStage, movedOriginalStage);
          await mkdir(replacementStage);
          await writeFile(join(replacementStage, 'replacement.txt'), 'preserve-me', { flag: 'wx' });
          throw new Error('native helper terminated before reply');
        },
      }),
      '000799',
    )).rejects.toMatchObject({ code: 'F005_VOICE_NATIVE_OBSERVE_FAILED' });
    await expect(readFile(join(replacementStage, 'replacement.txt'), 'utf8'))
      .resolves.toBe('preserve-me');
    await expect(stat(movedOriginalStage)).resolves.toMatchObject({});
    await expect(generateF005Voice(
      plan,
      engine(wav(1)),
      join(parent, 'observe'),
      createRecorder('observe', {
        observeMutation: async () => { throw new Error('native observe detail'); },
      }),
      '000799',
    )).rejects.toMatchObject({ code: 'F005_VOICE_NATIVE_OBSERVE_FAILED' });
    await expect(generateF005Voice(
      plan,
      engine(wav(1)),
      join(parent, 'end'),
      createRecorder('end', {
        endPhase: async () => { throw new Error('native end detail'); },
      }),
      '000799',
    )).rejects.toMatchObject({ code: 'F005_VOICE_NATIVE_END_FAILED' });
  });

  it('120000 ms/5760044 bytesを許し、1 ms超過を拒否する', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'f005-voice-boundary-'));
    temporaryDirectories.push(parent);
    const boundaryNonce = H('boundary-nonce');
    const recorder = createF005CapacityRecorder({
      journalId: H('boundary-journal'),
      owner: 'worker',
      sessionNonce: boundaryNonce,
      workerPid: process.pid,
    }, recorderBackend(boundaryNonce));
    const plan = planF005VoiceDiff([speech('境界')], F002_VOICE_CONFIG, { entries: [] });
    const exact = await generateF005Voice(
      plan,
      engine(wav(120_000)),
      join(parent, 'exact'),
      recorder,
      '000799',
    );
    expect(exact.assets[0]).toMatchObject({ bytes: 5_760_044, durationMs: 120_000 });

    const overNonce = H('over-nonce');
    const secondRecorder = createF005CapacityRecorder({
      journalId: H('over-journal'),
      owner: 'worker',
      sessionNonce: overNonce,
      workerPid: process.pid,
    }, recorderBackend(overNonce));
    await expect(generateF005Voice(
      plan,
      engine(wav(120_001)),
      join(parent, 'over'),
      secondRecorder,
      '000799',
    ))
      .rejects.toMatchObject({ code: 'F005_VOICE_GENERATION_INVALID' });
  });
});

describe('UT-F005-019 closed actual capacity [DES-F005-006][FUN-F005-019]', () => {
  function event(sequence: number, phase: F005CapacityJournalEvent['phase']): F005CapacityJournalEvent {
    return {
      sequence,
      phase,
      phaseInstanceId: H(phase),
      source: 'etw-only',
      noticeId: null,
      workerPid: process.pid,
      path: `stage/${phase}.bin`,
      sha256: H(`${phase}-bytes`),
      timestamp: `2026-07-29T00:00:0${sequence}.000Z`,
      freeBytes: 5 * 1024 ** 3 - sequence,
      liveBytes: sequence * 100,
    };
  }

  function journal(workspace: string, dist: string): F005ClosedCapacityJournal {
    const phases = (['voice', 'build', 'preview', 'build', 'accept'] as const).map((phase, index) => ({
      phase,
      workId: '000799',
      phaseInstanceId: H(`${phase}-${index}`),
      beganAt: `2026-07-29T00:00:0${index}.000Z`,
      endedAt: `2026-07-29T00:00:1${index}.000Z`,
    }));
    return sealF005CapacityJournal({
      schemaVersion: 3,
      state: 'closed',
      journalId: H('journal'),
      nativeJournalSha256: H('native-journal'),
      workId: '000799',
      candidateSha256: H('candidate'),
      workspaceRoot: workspace,
      distRoot: dist,
      allowedWorkerPids: [process.pid],
      phases,
      events: phases.map((phase, index) => ({
        ...event(index + 1, phase.phase),
        phaseInstanceId: phase.phaseInstanceId,
      })),
      entries: [{
        bucket: 'audio',
        kind: 'path',
        path: 'public/audio/F005/a.wav',
        bytes: 92,
        sha256: H('audio'),
      }],
      initialFreeBytes: 5 * 1024 ** 3,
    });
  }

  it('作品結合済みexact 5 phaseとETW-only eventからpeak/minimum/6区分を導く', async () => {
    const workspace = resolve('C:/f005-workspace');
    const dist = resolve(workspace, 'dist');
    const sealed = journal(workspace, dist);
    const actual = await measureF005ActualCapacity(
      workspace,
      dist,
      [{ path: 'public/audio/F005/a.wav', sha256: H('audio') }],
      { readClosedCapacityJournal: async () => sealed },
    );
    expect(actual).toMatchObject({
      schemaVersion: 3,
      state: 'closed',
      peakLiveBytes: 500,
      minimumObservedFreeBytes: 5 * 1024 ** 3 - 5,
    });
    expect(actual.buckets.map((bucket) => bucket.kind)).toEqual([
      'audio', 'artifact', 'repository', 'object', 'workspace-peak', 'free-after-peak',
    ]);
  });

  it('clone、sequence gap、PID逸脱、seal tamper、phase欠落を拒否する', async () => {
    const workspace = resolve('C:/f005-workspace');
    const dist = resolve(workspace, 'dist');
    const sealed = journal(workspace, dist);
    const accepted = [{ path: 'public/audio/F005/a.wav', sha256: H('audio') }];
    for (const invalid of [
      { ...sealed },
      { ...sealed, events: sealed.events.map((item, index) => index === 1 ? { ...item, sequence: 9 } : item) },
      { ...sealed, events: sealed.events.map((item, index) => index === 1 ? { ...item, workerPid: process.pid + 1 } : item) },
      { ...sealed, sealSha256: H('tampered') },
      { ...sealed, phases: sealed.phases.slice(0, 3) },
    ]) {
      await expect(measureF005ActualCapacity(
        workspace,
        dist,
        accepted,
        { readClosedCapacityJournal: async () => invalid as F005ClosedCapacityJournal },
      )).rejects.toMatchObject({ code: 'F005_CAPACITY_ACTUAL_INVALID' });
    }
  });

  it('phaseの順序差・余分・別workをすべて拒否する', async () => {
    const workspace = resolve('C:/f005-workspace');
    const dist = resolve(workspace, 'dist');
    const valid = journal(workspace, dist);
    const accepted = [{ path: 'public/audio/F005/a.wav', sha256: H('audio') }];
    const reseal = (
      phases: F005ClosedCapacityJournal['phases'],
    ): F005ClosedCapacityJournal => sealF005CapacityJournal({
      schemaVersion: valid.schemaVersion,
      state: valid.state,
      journalId: valid.journalId,
      nativeJournalSha256: valid.nativeJournalSha256,
      workId: valid.workId,
      candidateSha256: valid.candidateSha256,
      workspaceRoot: valid.workspaceRoot,
      distRoot: valid.distRoot,
      allowedWorkerPids: valid.allowedWorkerPids,
      phases,
      events: valid.events,
      entries: valid.entries,
      initialFreeBytes: valid.initialFreeBytes,
    });
    const reversed = reseal([valid.phases[1]!, valid.phases[0]!, ...valid.phases.slice(2)]);
    const extra = reseal([...valid.phases, {
      ...valid.phases[4]!,
      phaseInstanceId: H('extra'),
    }]);
    const otherWork = reseal(valid.phases.map((phase, index) =>
      index === 2 ? { ...phase, workId: '001076' } : phase));
    for (const invalid of [reversed, extra, otherWork]) {
      await expect(measureF005ActualCapacity(
        workspace,
        dist,
        accepted,
        { readClosedCapacityJournal: async () => invalid },
        '000799',
      )).rejects.toMatchObject({ code: 'F005_CAPACITY_ACTUAL_INVALID' });
    }
  });
});
