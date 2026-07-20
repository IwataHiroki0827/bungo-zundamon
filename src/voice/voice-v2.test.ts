import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createVoiceCacheKeyV2, type VoiceConfigV2 } from './cache.ts';
import { ProductionVoicevoxClient, type VoicevoxConnector, type VoicevoxRequest, type VoicevoxResponse } from './client.ts';
import {
  assertVoiceAcceptanceTuple,
  authorizeVoiceDiffPlan,
  generateVoiceDiff,
  planVoiceDiff,
  verifyVoiceCompleteness,
} from './generation.ts';

const config: VoiceConfigV2 = {
  engineVersion: '0.25.2',
  speakerUuid: '388f246b-8c41-4ac1-8e2d-5d79f3ff56d9',
  speakerName: 'ずんだもん',
  styleId: 3,
  styleName: 'ノーマル',
  speedScale: 1,
  pitchScale: 0,
  intonationScale: 1,
  volumeScale: 1,
  outputSamplingRate: 24_000,
  presetVersion: '2.0.0',
};

const binding = Object.freeze({
  batchId: 'F002',
  workId: 'w1',
  expectedManifestSha: 'a'.repeat(64),
  preTreeDigest: 'b'.repeat(64),
});

function authorized<T extends Awaited<ReturnType<typeof planVoiceDiff>>>(plan: T, remainingResponseBytes = 46, minimumFreeBytesAfterWrite = 0): T {
  return authorizeVoiceDiffPlan(plan, {
    result: 'pass', planDigest: plan.planDigest, remainingResponseBytes, minimumFreeBytesAfterWrite,
  }) as T;
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
  syntheses = 0;
  constructor(
    readonly synthesis = wav(),
    readonly engineVersion = '0.25.2',
    readonly styleName = 'ノーマル',
  ) {}

  async request(request: VoicevoxRequest): Promise<VoicevoxResponse> {
    let body: Uint8Array;
    let media = 'application/json';
    if (request.url.pathname === '/version') body = new TextEncoder().encode(JSON.stringify(this.engineVersion));
    else if (request.url.pathname === '/speakers') {
      body = new TextEncoder().encode(JSON.stringify([{
        name: 'ずんだもん',
        speaker_uuid: config.speakerUuid,
        styles: [{ id: 3, name: this.styleName }],
      }]));
    } else if (request.url.pathname === '/audio_query') body = new TextEncoder().encode('{}');
    else {
      this.syntheses += 1;
      body = this.synthesis;
      media = 'audio/wav';
    }
    return { status: 200, headers: { 'content-type': media }, body, finalUrl: request.url.href, remoteAddress: '127.0.0.1' };
  }
}

const roots: string[] = [];

async function fixture(): Promise<{ root: string; cache: string; stage: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-v2-'));
  roots.push(root);
  return { root, cache: path.join(root, '.cache', 'voice'), stage: path.join(root, '.voice-stage-test') };
}

function client(connector: Connector): ProductionVoicevoxClient {
  return new ProductionVoicevoxClient({ baseUrl: 'http://127.0.0.1:50021', config, connector });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FUN-F002-013 voice cache key v2', () => {
  it('batch/candidateに依存せず、canonical configと本文だけで共有keyを作る', () => {
    const reordered = Object.fromEntries(Object.entries(config).reverse()) as unknown as VoiceConfigV2;
    expect(createVoiceCacheKeyV2('同じ台詞', reordered)).toBe(createVoiceCacheKeyV2('同じ台詞', config));
    expect(createVoiceCacheKeyV2('同じ台詞', config)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('全数値境界を包含する', () => {
    expect(() => createVoiceCacheKeyV2('最小', {
      ...config, speedScale: 0.5, pitchScale: -0.15, intonationScale: 0, volumeScale: 0, outputSamplingRate: 24_000,
    })).not.toThrow();
    expect(() => createVoiceCacheKeyV2('最大', {
      ...config, speedScale: 2, pitchScale: 0.15, intonationScale: 2, volumeScale: 2, outputSamplingRate: 48_000,
    })).not.toThrow();
  });

  it.each([
    ['speedScale', 0.4999],
    ['pitchScale', 0.1501],
    ['intonationScale', Number.NaN],
    ['volumeScale', Number.POSITIVE_INFINITY],
    ['outputSamplingRate', 44_100],
  ] as const)('%sの範囲外を拒否する', (field, value) => {
    expect(() => createVoiceCacheKeyV2('台詞', { ...config, [field]: value })).toThrowError(
      expect.objectContaining({ code: 'VOICE_CONFIG_RANGE_INVALID' }),
    );
  });

  it('空本文・欠損config・未対応schemaを区別する', () => {
    expect(() => createVoiceCacheKeyV2('', config)).toThrowError(expect.objectContaining({ code: 'VOICE_TEXT_INVALID' }));
    expect(() => createVoiceCacheKeyV2('台詞', { ...config, speakerName: '' })).toThrowError(
      expect.objectContaining({ code: 'VOICE_CONFIG_INCOMPLETE' }),
    );
    expect(() => createVoiceCacheKeyV2('台詞', { ...config, cacheSchemaVersion: '3' })).toThrowError(
      expect.objectContaining({ code: 'VOICE_CACHE_SCHEMA_UNSUPPORTED' }),
    );
  });
});

describe('FUN-F002-014 voice diff', () => {
  it('manifest/tree tupleをplan digestへ結合し、別work候補を拒否する', async () => {
    const { cache } = await fixture();
    const item = [{ workId: 'w1', candidateId: 'c1', speechText: '台詞', approved: true }];
    const first = await planVoiceDiff(item, config, cache, binding);
    const changed = await planVoiceDiff(item, config, cache, {
      ...binding, expectedManifestSha: 'c'.repeat(64),
    });
    expect(first.planDigest).not.toBe(changed.planDigest);
    expect(Object.isFrozen(first)).toBe(true);
    await expect(planVoiceDiff([{ ...item[0]!, workId: 'w2' }], config, cache, binding)).rejects.toMatchObject({
      code: 'VOICE_TUPLE_MISMATCH',
    });
  });

  it.each(['../F003', 'F03', 'F003?x', 'https:F003'])('公開pathに使用できないbatch ID %sを拒否する', async (batchId) => {
    const { cache } = await fixture();
    await expect(planVoiceDiff([], config, cache, { ...binding, batchId })).rejects.toMatchObject({
      code: 'VOICE_TUPLE_INVALID',
    });
  });

  it('unique本文を共有し、metadataと実体が一致する場合だけhitにする', async () => {
    const { cache } = await fixture();
    const items = [
      { workId: 'w1', candidateId: 'c1', speechText: '共有', approved: true, estimatedBytes: 100 },
      { workId: 'w1', candidateId: 'c2', speechText: '共有', approved: true, estimatedBytes: 100 },
      { workId: 'w1', candidateId: 'c3', speechText: '差分', approved: true, estimatedBytes: 200 },
    ];
    const first = await planVoiceDiff(items, config, cache, binding);
    expect(first).toMatchObject({ candidateCount: 3, uniqueAudioCount: 2, hitCount: 0, missCount: 2, estimatedMissBytes: 300 });
    const entry = first.entries.find((value) => value.text === '共有')!;
    const bytes = wav();
    await mkdir(path.dirname(entry.wavPath), { recursive: true });
    await writeFile(entry.wavPath, bytes);
    await writeFile(entry.metadataPath, JSON.stringify({
      schemaVersion: '2',
      audioId: entry.audioId,
      configHash: first.configHash,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      durationMs: 1,
    }));
    const second = await planVoiceDiff(items, config, cache, binding);
    expect(second).toMatchObject({ hitCount: 1, missCount: 1, invalidCount: 0, estimatedMissBytes: 200, existingUniqueBytes: 46 });
    expect(second.entries.find((value) => value.text === '共有')?.candidateIds).toEqual(['c1', 'c2']);
  });

  it('孤立metadataとhash改ざんをinvalidにし、再利用しない', async () => {
    const { cache } = await fixture();
    const item = [{ candidateId: 'c1', speechText: '台詞', approved: true }];
    const first = await planVoiceDiff(item, config, cache, binding);
    const entry = first.entries[0]!;
    await mkdir(path.dirname(entry.metadataPath), { recursive: true });
    await writeFile(entry.metadataPath, '{}');
    const orphan = await planVoiceDiff(item, config, cache, binding);
    expect(orphan.entries[0]).toMatchObject({ status: 'invalid', invalidReason: 'VOICE_CACHE_ORPHAN_METADATA' });
  });

  it('WAV hash改ざんをinvalidにする', async () => {
    const { cache } = await fixture();
    const item = [{ candidateId: 'c1', speechText: '台詞', approved: true }];
    const first = await planVoiceDiff(item, config, cache, binding);
    const entry = first.entries[0]!;
    const bytes = wav();
    await mkdir(path.dirname(entry.wavPath), { recursive: true });
    await writeFile(entry.wavPath, bytes);
    await writeFile(entry.metadataPath, JSON.stringify({
      schemaVersion: '2', audioId: entry.audioId, configHash: first.configHash,
      sha256: '0'.repeat(64), bytes: bytes.byteLength, durationMs: 1,
    }));
    const changed = await planVoiceDiff(item, config, cache, binding);
    expect(changed.entries[0]).toMatchObject({ status: 'invalid', invalidReason: 'VOICE_CACHE_HASH_MISMATCH' });
  });
});

describe('FUN-F002-015 voice generation diff', () => {
  it('missだけを1回ずつ生成してstagingへ置き、cacheは更新しない', async () => {
    const { cache, stage } = await fixture();
    const plan = authorized(await planVoiceDiff([{ workId: 'w1', candidateId: 'c1', speechText: '生成', approved: true }], config, cache, binding));
    const connector = new Connector();
    const result = await generateVoiceDiff(plan, client(connector), stage, { freeBytes: async () => 46 });
    expect(connector.syntheses).toBe(1);
    expect(result).toMatchObject({ succeeded: 1, failed: 0, stagedBytes: 46 });
    expect(await readFile(result.assets[0]!.sourcePath)).toHaveLength(46);
    await expect(readFile(plan.entries[0]!.wavPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('残応答容量を1 byte超えたらstaging全体を破棄する', async () => {
    const { cache, stage } = await fixture();
    const plan = authorized(await planVoiceDiff([{ candidateId: 'c1', speechText: '生成', approved: true }], config, cache, binding), 45);
    await expect(generateVoiceDiff(plan, client(new Connector()), stage, { freeBytes: async () => 1_000 })).rejects.toMatchObject({
      code: 'VOICE_RESPONSE_BUDGET_EXCEEDED',
    });
    await expect(readFile(path.join(stage, `${plan.entries[0]!.audioId}.wav`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('実style不一致を要求前に拒否する', async () => {
    const { cache, stage } = await fixture();
    const plan = authorized(await planVoiceDiff([{ candidateId: 'c1', speechText: '生成', approved: true }], config, cache, binding));
    const connector = new Connector(wav(), '0.25.2', 'ヒソヒソ');
    await expect(generateVoiceDiff(plan, client(connector), stage)).rejects.toMatchObject({ code: 'VOICE_STYLE_MISMATCH' });
    expect(connector.syntheses).toBe(0);
  });

  it('必要空き容量より1 byte少なければstagingを破棄する', async () => {
    const { cache, stage } = await fixture();
    const plan = authorized(await planVoiceDiff([{ candidateId: 'c1', speechText: '生成', approved: true }], config, cache, binding), 46, 100);
    await expect(generateVoiceDiff(plan, client(new Connector()), stage, { freeBytes: async () => 145 })).rejects.toMatchObject({
      code: 'VOICE_DISK_INSUFFICIENT',
    });
    await expect(readFile(path.join(stage, `${plan.entries[0]!.audioId}.wav`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('全cache hitはmiss 0・VOICEVOX要求0・staged bytes 0で正常終了する', async () => {
    const { cache, stage } = await fixture();
    const item = [{ workId: 'w1', candidateId: 'c1', speechText: '共有済み', approved: true }];
    const initial = await planVoiceDiff(item, config, cache, binding);
    const entry = initial.entries[0]!;
    const bytes = wav();
    await mkdir(path.dirname(entry.wavPath), { recursive: true });
    await writeFile(entry.wavPath, bytes);
    await writeFile(entry.metadataPath, JSON.stringify({
      schemaVersion: '2', audioId: entry.audioId, configHash: initial.configHash,
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength, durationMs: 1,
    }));
    const plan = authorized(await planVoiceDiff(item, config, cache, binding), 0);
    const connector = new Connector();
    const result = await generateVoiceDiff(plan, client(connector), stage, { freeBytes: async () => 0 });
    expect(plan).toMatchObject({ hitCount: 1, missCount: 0, estimatedMissBytes: 0 });
    expect(result).toMatchObject({ succeeded: 1, stagedBytes: 0, assets: [{ source: 'cache', workIds: ['w1'] }] });
    expect(connector.syntheses).toBe(0);
  });

  it('後続batchはbinding.batchIdを公開root相対pathへ使用する', async () => {
    const { cache, stage } = await fixture();
    const nextBinding = { ...binding, batchId: 'F003' };
    const plan = authorized(await planVoiceDiff([
      { workId: 'w1', candidateId: 'c1', speechText: '後続batch', approved: true },
    ], config, cache, nextBinding));
    const result = await generateVoiceDiff(plan, client(new Connector()), stage, { freeBytes: async () => 46 });
    expect(result.batchId).toBe('F003');
    expect(result.assets[0]?.path).toBe(`audio/F003/${result.assets[0]?.audioId}.wav`);
  });
});

describe('FUN-F002-016 voice completeness', () => {
  it('approved→audio→assetの共有参照とWAV実体を検証する', async () => {
    const { cache, stage } = await fixture();
    const plan = authorized(await planVoiceDiff([
      { workId: 'w1', candidateId: 'c1', speechText: '共有', approved: true },
      { workId: 'w1', candidateId: 'c2', speechText: '共有', approved: true },
    ], config, cache, binding));
    const generation = await generateVoiceDiff(plan, client(new Connector()), stage, { freeBytes: async () => 46 });
    const review = {
      batchId: 'F002',
      workId: 'w1',
      approved: [{ candidate: { candidateId: 'c1' } }, { candidate: { candidateId: 'c2' } }],
      pending: [],
    };
    const completeness = await verifyVoiceCompleteness(review, generation, { assets: generation.assets }, { allowedRoots: [stage] });
    expect(completeness).toMatchObject({
      result: 'pass', approvedCount: 2, uniqueAudioCount: 1,
    });
    expect(Object.isFrozen(completeness)).toBe(true);
    expect(assertVoiceAcceptanceTuple(generation, completeness)).toMatchObject(binding);
    expect(() => assertVoiceAcceptanceTuple(
      { ...generation, workId: 'w2' },
      completeness,
    )).toThrowError(expect.objectContaining({ code: 'VOICE_TUPLE_MISMATCH' }));
    expect(() => assertVoiceAcceptanceTuple(
      generation,
      { ...completeness, approvedCount: 3 },
    )).toThrowError(expect.objectContaining({ code: 'VOICE_TUPLE_MISMATCH' }));
  });

  it('pending、生成失敗、孤立assetを拒否する', async () => {
    const { cache, stage } = await fixture();
    const plan = authorized(await planVoiceDiff([], config, cache, binding), 0);
    const empty = await generateVoiceDiff(plan, client(new Connector()), stage, { freeBytes: async () => 0 });
    await expect(verifyVoiceCompleteness({ batchId: 'F002', workId: 'w1', approved: [], pending: [{}] }, empty, { assets: [] })).rejects.toMatchObject({
      code: 'VOICE_APPROVED_MISSING',
    });
  });

  it('WAV実体改ざんを拒否する', async () => {
    const { cache, stage } = await fixture();
    const plan = authorized(await planVoiceDiff([{ workId: 'w1', candidateId: 'c1', speechText: '生成', approved: true }], config, cache, binding));
    const generation = await generateVoiceDiff(plan, client(new Connector()), stage, { freeBytes: async () => 46 });
    await writeFile(generation.assets[0]!.sourcePath, new Uint8Array());
    await expect(verifyVoiceCompleteness(
      { batchId: 'F002', workId: 'w1', approved: [{ candidate: { candidateId: 'c1' } }], pending: [] },
      generation,
      { assets: generation.assets },
    )).rejects.toMatchObject({ code: 'VOICE_ASSET_CORRUPT' });
  });
});
