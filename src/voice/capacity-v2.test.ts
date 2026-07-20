import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ADDED_AUDIO_MAX_BYTES,
  DECIMAL_GB_BYTES,
  MAX_GIT_OBJECT_BYTES,
  MIN_CAPACITY_RESERVE_BYTES,
  PAGES_SAFETY_STOP_BYTES,
  PAGES_WARN_BYTES,
  REPOSITORY_WARN_BYTES,
  forecastCapacity,
  requiredFreeBytes,
  verifyActualCapacity,
  type ActualCapacityInput,
  type CapacityDistPreview,
  type CapacityForecastInput,
  type GitObjectMeasurement,
} from './budget.ts';
import { computeVoiceCompletenessDigest, computeVoiceGenerationDigest } from './generation.ts';

const exec = promisify(execFile);
const H = (value: string): string => createHash('sha256').update(value).digest('hex');
const OID = '1'.repeat(40);

function forecastInput(overrides: Partial<CapacityForecastInput> = {}): CapacityForecastInput {
  const plan = {
    batchId: 'F002', workId: '000473', expectedManifestSha: H('manifest'), preTreeDigest: H('tree'),
    planDigest: H('plan'), estimatedMissBytes: 1,
  };
  return {
    plan,
    expectedManifestSha: plan.expectedManifestSha,
    preTreeDigest: plan.preTreeDigest,
    planDigest: plan.planDigest,
    alreadyGeneratedUniqueAudioBytes: 0,
    currentPagesBytes: 0,
    plannedPagesBytes: 0,
    repositoryNonObjectBytes: 0,
    gitObjects: [],
    disk: { liveWriteUpperBounds: 0, rollbackBackupBytes: 0, freeBytes: MIN_CAPACITY_RESERVE_BYTES },
    ...overrides,
  };
}

function object(bytes: number, overrides: Partial<GitObjectMeasurement> = {}): GitObjectMeasurement {
  return { oid: OID, storedBytes: bytes, logicalBytes: bytes, source: 'pack', objectized: true, ...overrides };
}

describe('FUN-F002-032 capacity forecast', () => {
  it.each([
    [ADDED_AUDIO_MAX_BYTES, 'pass'],
    [ADDED_AUDIO_MAX_BYTES + 1, 'blocked'],
  ])('追加音声 %i bytes の境界を判定する', async (bytes, expected) => {
    const report = await forecastCapacity(forecastInput({
      plan: { ...forecastInput().plan, estimatedMissBytes: bytes },
    }));
    expect(report.additionalAudio.status).toBe(expected);
    expect(report.actualCapacitySatisfied).toBe(false);
    expect(report.evidenceKind).toBe('forecast');
  });

  it.each([
    [PAGES_WARN_BYTES - 1, 'pass'],
    [PAGES_WARN_BYTES, 'warning'],
    [PAGES_SAFETY_STOP_BYTES, 'warning'],
    [PAGES_SAFETY_STOP_BYTES + 1, 'blocked'],
    [DECIMAL_GB_BYTES, 'blocked'],
  ])('Pages %i bytes の警告・停止境界を判定する', async (bytes, expected) => {
    const report = await forecastCapacity(forecastInput({ plannedPagesBytes: bytes }));
    expect(report.pagesArtifact.status).toBe(expected);
  });

  it.each([
    [REPOSITORY_WARN_BYTES - 1, 'pass'],
    [REPOSITORY_WARN_BYTES, 'warning'],
    [DECIMAL_GB_BYTES - 1, 'warning'],
    [DECIMAL_GB_BYTES, 'blocked'],
  ])('repository %i bytes の警告・停止境界を判定する', async (bytes, expected) => {
    const report = await forecastCapacity(forecastInput({ repositoryNonObjectBytes: bytes }));
    expect(report.sourceRepository.status).toBe(expected);
  });

  it.each([
    [MAX_GIT_OBJECT_BYTES - 1, 'pass'],
    [MAX_GIT_OBJECT_BYTES, 'blocked'],
  ])('単一object %i bytes の停止境界を判定する', async (bytes, expected) => {
    const report = await forecastCapacity(forecastInput({ gitObjects: [object(bytes)] }));
    expect(report.singleGitObjects.status).toBe(expected);
  });

  it('pack/loose/newの同一OIDを1回だけ数え、未object化blobを保守加算する', async () => {
    const uniqueRaw = object(17, { oid: '2'.repeat(40), source: 'new', objectized: false, path: 'new.bin' });
    const report = await forecastCapacity(forecastInput({
      repositoryNonObjectBytes: 5,
      gitObjects: [
        object(20, { storedBytes: 10, source: 'pack' }),
        object(20, { storedBytes: 12, source: 'loose' }),
        object(20, { source: 'new', objectized: false, path: 'duplicate.bin' }),
        uniqueRaw,
      ],
    }));
    expect(report.sourceRepository.measuredBytes).toBe(5 + 12 + 17);
    expect(report.sourceRepository.deduplicatedHashes).toEqual([OID]);
  });

  it('requiredFree同値を許可し1 byte不足を停止する', async () => {
    const disk = { liveWriteUpperBounds: 10, rollbackBackupBytes: 20 };
    const required = requiredFreeBytes(disk);
    expect(required).toBe(30 + MIN_CAPACITY_RESERVE_BYTES);
    expect((await forecastCapacity(forecastInput({ disk: { ...disk, freeBytes: required } }))).workDrive.status).toBe('pass');
    expect((await forecastCapacity(forecastInput({ disk: { ...disk, freeBytes: required - 1 } }))).workDrive.status).toBe('blocked');
    const percentageBase = MIN_CAPACITY_RESERVE_BYTES * 10 + 1;
    expect(requiredFreeBytes({ liveWriteUpperBounds: percentageBase, rollbackBackupBytes: 0 }))
      .toBe(percentageBase + Math.ceil(percentageBase / 10));
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER])('負値・小数・overflowをfail-closedにする: %s', async (value) => {
    const input = value === Number.MAX_SAFE_INTEGER
      ? forecastInput({ currentPagesBytes: value, plannedPagesBytes: 1 })
      : forecastInput({ currentPagesBytes: value });
    await expect(forecastCapacity(input)).rejects.toMatchObject({ code: expect.stringMatching(/^CAPACITY_INTEGER_/u) });
  });

  it('stale tupleとunsafe pathを拒否する', async () => {
    await expect(forecastCapacity(forecastInput({ planDigest: H('stale') })))
      .rejects.toMatchObject({ code: 'CAPACITY_FORECAST_STALE' });
    await expect(forecastCapacity(forecastInput({
      paths: [{ path: '../outside', boundary: 'workspace', regularFile: true, reparsePoint: false }],
    }))).rejects.toMatchObject({ code: 'CAPACITY_PATH_UNSAFE' });
    await expect(forecastCapacity(forecastInput({
      paths: [{ path: 'safe/%2e%2e/outside', boundary: 'workspace', regularFile: true, reparsePoint: false }],
    }))).rejects.toMatchObject({ code: 'CAPACITY_PATH_UNSAFE' });
  });
});

describe('FUN-F002-017 actual capacity', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('完全work-previewと実Git object/candidateを再計測してtupleへ結合する', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'capacity-v2-'));
    roots.push(workspace);
    const repository = join(workspace, 'repo');
    const dist = join(workspace, 'dist');
    const audioDir = join(workspace, 'audio');
    await Promise.all([mkdir(repository), mkdir(dist), mkdir(audioDir)]);
    await exec('git', ['init', '--quiet'], { cwd: repository });
    await exec('git', ['config', 'user.email', 'test@example.test'], { cwd: repository });
    await exec('git', ['config', 'user.name', 'Capacity Test'], { cwd: repository });
    await writeFile(join(repository, 'tracked.txt'), 'same-content');
    await exec('git', ['add', 'tracked.txt'], { cwd: repository });
    await exec('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository });
    await writeFile(join(repository, 'candidate.txt'), 'same-content');
    await writeFile(join(audioDir, 'voice.wav'), 'voice-bytes');
    await writeFile(join(dist, 'index.html'), '<!doctype html>');

    const fileBytes = Buffer.from('<!doctype html>');
    const tupleBase = {
      batchId: 'F002', workId: '000473', expectedManifestSha: H('manifest'), preTreeDigest: H('tree'),
      planDigest: H('plan'), authorizationDigest: H('authorization'),
    };
    const generationCore = {
      schemaVersion: '2' as const, ...tupleBase, configHash: H('config'), assets: [], failures: [],
      attempted: 0, succeeded: 0, failed: 0, stagedBytes: 0, stagingRoot: audioDir,
    };
    const generation = { ...generationCore, generationDigest: computeVoiceGenerationDigest(generationCore) };
    const completenessCore = {
      ...tupleBase, generationDigest: generation.generationDigest, result: 'pass' as const,
      approvedCount: 0, uniqueAudioCount: 0, candidateAudio: {},
    };
    const completeness = {
      ...completenessCore, completenessDigest: computeVoiceCompletenessDigest(completenessCore),
    };
    const tuple = { ...tupleBase, generationDigest: generation.generationDigest };
    const pages = {
      outputRoot: dist,
      contentBuildSha256: H('build'),
      distSha256: H('dist'),
      files: [{ path: 'index.html', bytes: fileBytes.byteLength, sha256: H(fileBytes.toString()) }],
      inputHashes: {
        contentTreeSha256: H('staging'), appSourceSha256: H('app'), lockfileSha256: H('lock'), toolSha256: H('tool'),
      },
      batchId: tuple.batchId,
      workId: tuple.workId,
    } as unknown as CapacityDistPreview;
    const input: ActualCapacityInput = {
      phase: 'work-preview', batchId: tuple.batchId, workId: tuple.workId,
      workspaceRoot: workspace, repositoryRoot: repository,
      expectedManifestSha: tuple.expectedManifestSha, preTreeDigest: tuple.preTreeDigest,
      contentStagingSha256: pages.inputHashes.contentTreeSha256,
      voiceConfigHash: generation.configHash, planDigest: tuple.planDigest, authorizationDigest: tuple.authorizationDigest,
      generation, completeness,
      additionalAudioFiles: [join(audioDir, 'voice.wav')],
      repositoryCandidateFiles: [join(repository, 'candidate.txt')],
      disk: { liveWriteUpperBounds: 0, rollbackBackupBytes: 0, freeBytes: MIN_CAPACITY_RESERVE_BYTES },
    };

    const report = await verifyActualCapacity(input, pages);
    expect(report.result).toBe('pass');
    expect(report.evidenceKind).toBe('actual');
    expect(report.contentBuildSha256).toBe(pages.contentBuildSha256);
    expect(report.generationDigest).toBe(tuple.generationDigest);
    expect(report.completenessDigest).toBe(completeness.completenessDigest);
    expect(report.sourceRepository.deduplicatedHashes.length).toBeGreaterThanOrEqual(1);
  });

  it('不完全DistPreviewをactual PASSとして受理しない', async () => {
    const pages = {} as CapacityDistPreview;
    await expect(verifyActualCapacity({} as ActualCapacityInput, pages)).rejects.toBeDefined();
  });
});
