import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductionVoicevoxClient, type VoicevoxConnector, type VoicevoxRequest, type VoicevoxResponse } from './client.ts';
import { voiceConfigHashV2 } from './cache.ts';
import {
  F002_VOICE_CONFIG,
  F002_VOICE_CONFIG_SOURCE,
  forecastCapacity,
  generateVoiceDiff,
  measureActualCapacity,
  planVoiceDiff,
  verifyVoiceCompleteness,
  type F003AcceptedAudioSource,
  type F003CapacityForecastInput,
  type F003SafeVoiceItem,
  type F003VoiceCacheIndex,
  type F003VoiceDiffPlan,
  type F003VoiceManifest,
  type F003VoiceReview,
} from './f003.ts';
import {
  ADDED_AUDIO_MAX_BYTES,
  DECIMAL_GB_BYTES,
  MAX_GIT_OBJECT_BYTES,
  MIN_CAPACITY_RESERVE_BYTES,
  PAGES_SAFETY_STOP_BYTES,
  PAGES_WARN_BYTES,
  REPOSITORY_WARN_BYTES,
  requiredFreeBytes,
  type CapacityDistPreview,
  type GitObjectMeasurement,
} from './budget.ts';

const roots: string[] = [];
const H = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const CONFIG_HASH = voiceConfigHashV2(F002_VOICE_CONFIG);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  cache: string;
  stage: string;
  repository: string;
  dist: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'bungo-f003-voice-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const dist = join(root, 'dist');
  await Promise.all([mkdir(repository), mkdir(dist)]);
  return {
    root,
    cache: join(root, '.cache', 'voice'),
    stage: join(root, '.voice-stage-f003'),
    repository,
    dist,
  };
}

function manifest(candidateIds = ['c1'], overrides: Partial<F003VoiceManifest> = {}): F003VoiceManifest {
  return {
    schemaVersion: '1.0.0',
    batchId: 'F003',
    workId: '000275',
    expectedManifestSha: H('manifest'),
    preTreeDigest: H('tree'),
    reconciliationDigest: H('reconciliation'),
    profileSha256: H('profile'),
    approvedCandidateIds: candidateIds,
    ...overrides,
  };
}

function safeItem(
  candidateId: string,
  speechText: string,
  overrides: Partial<F003SafeVoiceItem> = {},
): F003SafeVoiceItem {
  return {
    candidateId,
    workId: '000275',
    speechText,
    speechSha256: H(speechText),
    profileSha256: H('profile'),
    configHash: CONFIG_HASH,
    reconciliationDigest: H('reconciliation'),
    result: 'pass',
    codePoints: Array.from(speechText).length,
    durationMs: 1,
    wavBytes: 46,
    limits: { codePoints: 500, durationMs: 120_000, wavBytes: 5_760_044 },
    ...overrides,
  };
}

function cacheIndex(root: string, overrides: Partial<F003VoiceCacheIndex> = {}): F003VoiceCacheIndex {
  return {
    root,
    sourcePath: F002_VOICE_CONFIG_SOURCE.path,
    sourceSha256: F002_VOICE_CONFIG_SOURCE.sha256,
    sourceReleaseCommit: F002_VOICE_CONFIG_SOURCE.releaseCommit,
    ...overrides,
  };
}

function capacityInput(plan: F003VoiceDiffPlan, overrides: Partial<F003CapacityForecastInput> = {}): F003CapacityForecastInput {
  return {
    plan,
    alreadyGeneratedUniqueAudioBytes: 0,
    currentPagesBytes: 0,
    plannedPagesBytes: 0,
    repositoryNonObjectBytes: 0,
    gitObjects: [],
    disk: { liveWriteUpperBounds: 0, rollbackBackupBytes: 0, freeBytes: MIN_CAPACITY_RESERVE_BYTES },
    ...overrides,
  };
}

function wav(): Uint8Array {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, 2, true);
  return bytes;
}

class Connector implements VoicevoxConnector {
  readonly synthesisOrder: string[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    readonly failAt = Number.POSITIVE_INFINITY,
    readonly engineVersion = '0.25.2',
    readonly styleName = 'ノーマル',
  ) {}

  async request(request: VoicevoxRequest): Promise<VoicevoxResponse> {
    let body: Uint8Array;
    let media = 'application/json';
    if (request.url.pathname === '/version') {
      body = new TextEncoder().encode(JSON.stringify(this.engineVersion));
    } else if (request.url.pathname === '/speakers') {
      body = new TextEncoder().encode(JSON.stringify([{
        name: 'ずんだもん',
        speaker_uuid: F002_VOICE_CONFIG.speakerUuid,
        styles: [{ id: 3, name: this.styleName }],
      }]));
    } else if (request.url.pathname === '/audio_query') {
      this.synthesisOrder.push(request.url.searchParams.get('text') ?? '');
      body = new TextEncoder().encode('{}');
    } else {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        if (this.synthesisOrder.length >= this.failAt) throw new Error('fixture failure');
        await Promise.resolve();
        body = wav();
        media = 'audio/wav';
      } finally {
        this.active -= 1;
      }
    }
    return {
      status: 200,
      headers: { 'content-type': media },
      body,
      finalUrl: request.url.href,
      remoteAddress: '127.0.0.1',
    };
  }
}

function client(connector: Connector): ProductionVoicevoxClient {
  return new ProductionVoicevoxClient({
    baseUrl: 'http://127.0.0.1:50021',
    config: F002_VOICE_CONFIG,
    connector,
  });
}

function review(plan: F003VoiceDiffPlan): F003VoiceReview {
  return {
    batchId: 'F003',
    workId: plan.manifest.workId,
    reconciliationDigest: plan.manifest.reconciliationDigest,
    approved: plan.items.map((item) => ({
      candidateId: item.candidateId,
      speechText: item.speechText,
      speechSha256: item.speechSha256,
      configHash: item.configHash,
    })),
    rejectedCandidateIds: [],
    pendingCandidateIds: [],
  };
}

function sources(
  plan: F003VoiceDiffPlan,
  generation: Awaited<ReturnType<typeof generateVoiceDiff>>,
): F003AcceptedAudioSource[] {
  const item = new Map(plan.items.map((value) => [value.candidateId, value]));
  return generation.generation.assets.flatMap((asset) => asset.candidateIds.map((candidateId) => ({
    candidateId,
    audioId: asset.audioId,
    speechSha256: item.get(candidateId)!.speechSha256,
    configHash: asset.configHash,
    assetSha256: asset.sha256,
    bytes: asset.bytes,
    durationMs: asset.durationMs,
    sourcePath: asset.sourcePath,
  })));
}

describe('F003 音声・容量adapter', () => {
  /** @des DES-F003-007 @fun FUN-F003-014 @test UT-F003-014 */
  it('review/safety/profile/configを結合し、同一speechのaudio IDとplan digestを共有・再現する', async () => {
    const { cache } = await fixture();
    const items = [safeItem('c1', '共有'), safeItem('c2', '共有'), safeItem('c3', '差分')];
    const first = await planVoiceDiff(manifest(['c1', 'c2', 'c3']), items, cacheIndex(cache), F002_VOICE_CONFIG);
    const second = await planVoiceDiff(manifest(['c1', 'c2', 'c3']), items, cacheIndex(cache), F002_VOICE_CONFIG);
    expect(first).toMatchObject({
      candidateCount: 3,
      uniqueAudioCount: 2,
      hitCount: 0,
      missCount: 2,
    });
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.basePlan.entries.find((entry) => entry.text === '共有')?.candidateIds).toEqual(['c1', 'c2']);
  });

  /** @des DES-F003-007 @fun FUN-F003-014 @test UT-F003-014 */
  it.each([
    ['reconciliation', { reconciliationDigest: H('other') }, {}, {}],
    ['profile', {}, { profileSha256: H('other') }, {}],
    ['config digest', {}, { configHash: H('other') }, {}],
    ['config source', {}, {}, { sourceSha256: H('other') }],
  ])('%s差をplan前に拒否する', async (_label, manifestChange, itemChange, cacheChange) => {
    const { cache } = await fixture();
    await expect(planVoiceDiff(
      manifest(['c1'], manifestChange),
      [safeItem('c1', '台詞', itemChange)],
      cacheIndex(cache, cacheChange),
      F002_VOICE_CONFIG,
    )).rejects.toBeTruthy();
  });

  /** @des DES-F003-007 @fun FUN-F003-014 @test UT-F003-014 */
  it('cache実体・metadataが完全一致する場合だけhitにしhash差をinvalidにする', async () => {
    const { cache } = await fixture();
    const item = safeItem('c1', 'cache');
    const initial = await planVoiceDiff(manifest(), [item], cacheIndex(cache), F002_VOICE_CONFIG);
    const entry = initial.basePlan.entries[0]!;
    const bytes = wav();
    await mkdir(join(cache, initial.configHash), { recursive: true });
    await writeFile(entry.wavPath, bytes);
    await writeFile(entry.metadataPath, JSON.stringify({
      schemaVersion: '2',
      audioId: entry.audioId,
      configHash: initial.configHash,
      sha256: H(bytes),
      bytes: bytes.byteLength,
      durationMs: 1,
    }));
    expect(await planVoiceDiff(manifest(), [item], cacheIndex(cache), F002_VOICE_CONFIG))
      .toMatchObject({ hitCount: 1, missCount: 0, invalidCount: 0 });
    await writeFile(entry.wavPath, new Uint8Array(bytes.byteLength));
    expect(await planVoiceDiff(manifest(), [item], cacheIndex(cache), F002_VOICE_CONFIG))
      .toMatchObject({ hitCount: 0, invalidCount: 1 });
  });

  /** @des DES-F003-007 @fun FUN-F003-016 @test UT-F003-016 */
  it.each([
    [PAGES_WARN_BYTES - 1, 'pass'],
    [PAGES_WARN_BYTES, 'pass_with_warning'],
    [PAGES_SAFETY_STOP_BYTES, 'pass_with_warning'],
    [PAGES_SAFETY_STOP_BYTES + 1, 'blocked'],
    [DECIMAL_GB_BYTES, 'blocked'],
  ])('Pages %i bytesの5区分を維持する', async (bytes, expected) => {
    const { cache } = await fixture();
    const plan = await planVoiceDiff(manifest(), [safeItem('c1', '台詞')], cacheIndex(cache), F002_VOICE_CONFIG);
    expect((await forecastCapacity(capacityInput(plan, { plannedPagesBytes: bytes }))).result).toBe(expected);
  });

  /** @des DES-F003-007 @fun FUN-F003-016 @test UT-F003-016 */
  it('追加WAV・repository・object・driveのinclusive境界を維持する', async () => {
    const { cache } = await fixture();
    const exactItems = Array.from({ length: 19 }, (_, index) => {
      const bytes = index === 18 ? ADDED_AUDIO_MAX_BYTES - 5_760_044 * 18 : 5_760_044;
      return safeItem(`c${index}`, `台詞${index}`, { wavBytes: bytes });
    });
    const exact = await planVoiceDiff(
      manifest(exactItems.map((item) => item.candidateId)),
      exactItems,
      cacheIndex(cache),
      F002_VOICE_CONFIG,
    );
    expect((await forecastCapacity(capacityInput(exact))).additionalAudio.status).toBe('pass');
    const overItems = exactItems.map((item, index) => index === 18 ? { ...item, wavBytes: item.wavBytes + 1 } : item);
    const over = await planVoiceDiff(
      manifest(overItems.map((item) => item.candidateId)),
      overItems,
      cacheIndex(cache),
      F002_VOICE_CONFIG,
    );
    expect((await forecastCapacity(capacityInput(over))).additionalAudio.status).toBe('blocked');

    const small = await planVoiceDiff(manifest(), [safeItem('c1', '台詞')], cacheIndex(cache), F002_VOICE_CONFIG);
    expect((await forecastCapacity(capacityInput(small, { repositoryNonObjectBytes: REPOSITORY_WARN_BYTES }))).result)
      .toBe('pass_with_warning');
    expect((await forecastCapacity(capacityInput(small, { repositoryNonObjectBytes: DECIMAL_GB_BYTES }))).result)
      .toBe('blocked');
    expect((await forecastCapacity(capacityInput(small, {
      gitObjects: [{
        oid: '1'.repeat(40), storedBytes: 1, logicalBytes: MAX_GIT_OBJECT_BYTES,
        source: 'pack', objectized: true,
      }],
    }))).singleGitObjects.status).toBe('blocked');
    const disk = { liveWriteUpperBounds: 10, rollbackBackupBytes: 20 };
    const required = requiredFreeBytes(disk);
    expect((await forecastCapacity(capacityInput(small, { disk: { ...disk, freeBytes: required } }))).workDrive.status).toBe('pass');
    expect((await forecastCapacity(capacityInput(small, { disk: { ...disk, freeBytes: required - 1 } }))).workDrive.status).toBe('blocked');
  });

  /** @des DES-F003-007 @fun FUN-F003-015 @test UT-F003-015 */
  it('missだけを要求順に最大同時1で生成し、cacheを変更しない', async () => {
    const { cache, stage } = await fixture();
    const plan = await planVoiceDiff(
      manifest(['c1', 'c2']),
      [safeItem('c1', '一'), safeItem('c2', '二')],
      cacheIndex(cache),
      F002_VOICE_CONFIG,
    );
    const forecast = await forecastCapacity(capacityInput(plan));
    const connector = new Connector();
    const result = await generateVoiceDiff(plan, client(connector), stage, forecast, {
      freeBytes: async () => 1_000_000_000,
    });
    expect(result.generation).toMatchObject({ succeeded: 2, failed: 0, stagedBytes: 92 });
    expect(connector.maxActive).toBe(1);
    expect(connector.synthesisOrder).toHaveLength(2);
    await expect(readFile(plan.basePlan.entries[0]!.wavPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /** @des DES-F003-007 @fun FUN-F003-015 @test UT-F003-015 */
  it('生成失敗時はwork staging全体を破棄しcache/public sentinelを維持する', async () => {
    const { root, cache, stage } = await fixture();
    await mkdir(cache, { recursive: true });
    const sentinel = join(root, 'public-sentinel.txt');
    await writeFile(sentinel, 'unchanged');
    const plan = await planVoiceDiff(
      manifest(['c1', 'c2']),
      [safeItem('c1', '一'), safeItem('c2', '二')],
      cacheIndex(cache),
      F002_VOICE_CONFIG,
    );
    const forecast = await forecastCapacity(capacityInput(plan));
    await expect(generateVoiceDiff(plan, client(new Connector(2)), stage, forecast, {
      freeBytes: async () => 1_000_000_000,
    })).rejects.toMatchObject({ code: 'VOICE_ITEM_FAILED' });
    await expect(readFile(join(stage, 'anything.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
  });

  /** @des DES-F003-007 @fun FUN-F003-018 @test UT-F003-018 */
  it('approved全件をaudioへjoinし、同speech/configの共有audioだけ許可する', async () => {
    const { cache, stage } = await fixture();
    const plan = await planVoiceDiff(
      manifest(['c1', 'c2']),
      [safeItem('c1', '共有'), safeItem('c2', '共有')],
      cacheIndex(cache),
      F002_VOICE_CONFIG,
    );
    const generation = await generateVoiceDiff(
      plan,
      client(new Connector()),
      stage,
      await forecastCapacity(capacityInput(plan)),
      { freeBytes: async () => 1_000_000_000 },
    );
    const completeness = await verifyVoiceCompleteness(plan, review(plan), generation, sources(plan, generation));
    expect(completeness).toMatchObject({ result: 'pass', base: { approvedCount: 2, uniqueAudioCount: 1 } });
  });

  /** @des DES-F003-007 @fun FUN-F003-018 @test UT-F003-018 */
  it('欠損・未承認・owner重複・speech/config/hash差をfail-closedにする', async () => {
    const { cache, stage } = await fixture();
    const plan = await planVoiceDiff(manifest(), [safeItem('c1', '台詞')], cacheIndex(cache), F002_VOICE_CONFIG);
    const generation = await generateVoiceDiff(
      plan,
      client(new Connector()),
      stage,
      await forecastCapacity(capacityInput(plan)),
      { freeBytes: async () => 1_000_000_000 },
    );
    const valid = sources(plan, generation);
    await expect(verifyVoiceCompleteness(plan, review(plan), generation, [])).rejects.toMatchObject({
      code: 'VOICE_APPROVED_MISSING',
    });
    await expect(verifyVoiceCompleteness(plan, review(plan), generation, [
      ...valid,
      { ...valid[0]!, candidateId: 'rejected' },
    ])).rejects.toBeTruthy();
    await expect(verifyVoiceCompleteness(plan, review(plan), generation, [
      { ...valid[0]!, speechSha256: H('changed') },
    ])).rejects.toMatchObject({ code: 'VOICE_ASSET_CORRUPT' });
  });

  /** @des DES-F003-007 @fun FUN-F003-017 @test UT-F003-017 */
  it('実WAV/distとpack/loose/new OIDを再計測し、重複を1回だけ数えてcandidate/commitへ結合する', async () => {
    const { root, cache, stage, repository, dist } = await fixture();
    const plan = await planVoiceDiff(manifest(), [safeItem('c1', '台詞')], cacheIndex(cache), F002_VOICE_CONFIG);
    const generation = await generateVoiceDiff(
      plan,
      client(new Connector()),
      stage,
      await forecastCapacity(capacityInput(plan)),
      { freeBytes: async () => 1_000_000_000 },
    );
    const completeness = await verifyVoiceCompleteness(plan, review(plan), generation, sources(plan, generation));
    const html = new TextEncoder().encode('<!doctype html>');
    await writeFile(join(dist, 'index.html'), html);
    const pages = {
      outputRoot: dist,
      contentBuildSha256: H('build'),
      distSha256: H('dist'),
      files: [{ path: 'index.html', bytes: html.byteLength, sha256: H(html) }],
      inputHashes: {
        contentTreeSha256: H('staging'),
        appSourceSha256: H('app'),
        lockfileSha256: H('lock'),
        toolSha256: H('tool'),
      },
      batchId: 'F003',
      workId: '000275',
    } as unknown as CapacityDistPreview;
    const oid = '1'.repeat(40);
    const objects: GitObjectMeasurement[] = [
      { oid, storedBytes: 10, logicalBytes: 20, source: 'pack', objectized: true },
      { oid, storedBytes: 12, logicalBytes: 20, source: 'loose', objectized: true },
      { oid: '2'.repeat(40), storedBytes: 17, logicalBytes: 17, source: 'new', objectized: false, path: 'candidate.bin' },
    ];
    const adapter = { measure: vi.fn(async () => objects) };
    const report = await measureActualCapacity({
      phase: 'work-preview',
      workspaceRoot: root,
      repositoryRoot: repository,
      candidateDigest: H('candidate'),
      candidateCommit: 'a'.repeat(40),
      contentStagingSha256: pages.inputHashes.contentTreeSha256,
      additionalAudioFiles: generation.generation.assets.map((asset) => asset.sourcePath),
      repositoryCandidateFiles: [join(repository, 'candidate.bin')],
      repositoryNonObjectBytes: 0,
      disk: { liveWriteUpperBounds: 0, rollbackBackupBytes: 0, freeBytes: MIN_CAPACITY_RESERVE_BYTES },
    }, pages, { plan, generation, completeness }, adapter);
    expect(report).toMatchObject({
      result: 'pass',
      planDigest: plan.planDigest,
      candidateDigest: H('candidate'),
      candidateCommit: 'a'.repeat(40),
      base: { sourceRepository: { deduplicatedHashes: [oid] } },
    });
    expect(adapter.measure).toHaveBeenCalledTimes(1);
  });

  /** @des DES-F003-007 @fun FUN-F003-017 @test UT-F003-017 */
  it('release report流用・unsafe tuple・Git計測失敗を拒否する', async () => {
    const { cache } = await fixture();
    const plan = await planVoiceDiff(manifest(), [safeItem('c1', '台詞')], cacheIndex(cache), F002_VOICE_CONFIG);
    await expect(measureActualCapacity(
      { phase: 'release' } as never,
      {} as CapacityDistPreview,
      { plan } as never,
      { measure: async () => { throw new Error('git failed'); } },
    )).rejects.toBeTruthy();
  });
});
