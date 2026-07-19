import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_SINGLE_ASSET_BYTES,
  ProductionVoicevoxClient,
  VOICE_HARD_LIMIT_BYTES,
  VOICE_WARNING_BYTES,
  VoiceContractError,
  createVoiceCacheKey,
  estimateVoiceBudget,
  generateVoiceAssets,
  verifyAssetBudget,
  voiceConfigHash,
  type AssetManifest,
  type GenerateVoiceOptions,
  type SpeechItem,
  type VoiceConfig,
  type VoiceFileSystem,
  type VoicevoxConnector,
  type VoicevoxRequest,
  type VoicevoxResponse,
} from './index';

const CONFIG: VoiceConfig = {
  engineVersion: '0.22.0',
  speakerUuid: '3885f35f-a3f2-4f8a-b8a4-5cced9f7f851',
  speakerName: 'ずんだもん',
  styleId: 3,
  styleName: 'ノーマル',
  speedScale: 1,
  pitchScale: 0,
  intonationScale: 1,
  volumeScale: 1,
  outputSamplingRate: 24_000,
  presetVersion: '1.0.0',
};

function approvedPreflight(items: SpeechItem[]) {
  return estimateVoiceBudget(items, {
    secondsPerCharacter: 0.5,
    outputSamplingRate: CONFIG.outputSamplingRate,
    bitDepth: 16,
    channels: 1,
    config: CONFIG,
  });
}

function pcmWav(dataBytes = 4): Uint8Array {
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function jsonResponse(request: VoicevoxRequest, value: unknown): VoicevoxResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
    finalUrl: request.url.href,
    remoteAddress: request.url.hostname === '[::1]' ? '::1' : '127.0.0.1',
  };
}

class FakeConnector implements VoicevoxConnector {
  requests: VoicevoxRequest[] = [];
  active = 0;
  maximumActive = 0;
  version = CONFIG.engineVersion;
  speakerName = CONFIG.speakerName;
  styleName = CONFIG.styleName;
  queryFactory: (request: VoicevoxRequest) => unknown = (request) => ({
    text: request.url.searchParams.get('text'),
    speedScale: 2,
    pitchScale: 0.15,
    intonationScale: 0,
    volumeScale: 0,
    outputSamplingRate: 48_000,
    outputStereo: true,
  });

  async request(request: VoicevoxRequest): Promise<VoicevoxResponse> {
    this.requests.push(request);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await Promise.resolve();
      if (request.url.pathname === '/version') return jsonResponse(request, this.version);
      if (request.url.pathname === '/speakers') {
        return jsonResponse(request, [
          {
            name: this.speakerName,
            speaker_uuid: CONFIG.speakerUuid,
            styles: [{ id: CONFIG.styleId, name: this.styleName }],
          },
        ]);
      }
      if (request.url.pathname === '/audio_query') {
        return jsonResponse(request, this.queryFactory(request));
      }
      const query = JSON.parse(new TextDecoder().decode(request.body)) as { text: string };
      const body = query.text === '非WAV' ? new Uint8Array([1, 2, 3]) : pcmWav();
      return {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
        body,
        finalUrl: request.url.href,
        remoteAddress: request.url.hostname === '[::1]' ? '::1' : '127.0.0.1',
      };
    } finally {
      this.active -= 1;
    }
  }
}

class MemoryVoiceFileSystem implements VoiceFileSystem {
  readonly files = new Map<string, Uint8Array>();
  writes: string[] = [];
  removals: string[] = [];
  prepared?: { cacheDir: string; workspaceRoot: string };

  async prepareCache(cacheDir: string, workspaceRoot: string): Promise<string> {
    this.prepared = { cacheDir, workspaceRoot };
    return cacheDir;
  }

  async read(filePath: string): Promise<Uint8Array | null> {
    return this.files.get(filePath) ?? null;
  }

  async writeAtomic(filePath: string, value: Uint8Array): Promise<void> {
    this.writes.push(filePath);
    this.files.set(filePath, value.slice());
  }

  async remove(filePath: string): Promise<void> {
    this.removals.push(filePath);
    this.files.delete(filePath);
  }
}

describe('FUN-F001-016 音声cache key [DES-F001-006][DES-F001-008][UT-F001-016]', () => {
  it('全設定を決定的なSHA-256 keyへ含め、設定境界を受理する', () => {
    const first = createVoiceCacheKey('吾輩は猫である', CONFIG);
    expect(first).toMatch(/^[a-f\d]{64}$/);
    expect(createVoiceCacheKey('吾輩は猫である', CONFIG)).toBe(first);

    const mutations: VoiceConfig[] = [
      { ...CONFIG, engineVersion: '0.22.1' },
      { ...CONFIG, speakerUuid: '11111111-1111-4111-8111-111111111111' },
      { ...CONFIG, speakerName: '変更した話者名' },
      { ...CONFIG, styleId: 1 },
      { ...CONFIG, styleName: 'あまあま' },
      { ...CONFIG, speedScale: 0.5 },
      { ...CONFIG, pitchScale: -0.15 },
      { ...CONFIG, intonationScale: 2 },
      { ...CONFIG, volumeScale: 0 },
      { ...CONFIG, outputSamplingRate: 48_000 },
      { ...CONFIG, presetVersion: '1.0.1' },
    ];
    expect(new Set(mutations.map((config) => createVoiceCacheKey('吾輩は猫である', config))).size).toBe(
      mutations.length,
    );
  });

  it.each([
    ['', CONFIG],
    ['本文', { ...CONFIG, engineVersion: '' }],
    ['本文', { ...CONFIG, speakerName: '' }],
    ['本文', { ...CONFIG, speedScale: 0.499 }],
    ['本文', { ...CONFIG, pitchScale: 0.151 }],
    ['本文', { ...CONFIG, outputSamplingRate: 44_100 }],
  ] as const)('空文字・未固定・範囲外を拒否する', (text, config) => {
    expect(() => createVoiceCacheKey(text, config)).toThrow(VoiceContractError);
  });
});

// IT-F001-004: VOICEVOX事前検査、差分生成、manifest反映の結合境界を追跡する。
describe('FUN-F001-017 production VOICEVOX境界と差分cache [DES-F001-008][DES-F001-017][DES-F001-019][UT-F001-017]', () => {
  it.each(['http://127.0.0.1:50021', 'http://[::1]:50021'])('loopback固定clientでgate後に直列・無retry生成する: %s', async (baseUrl) => {
    const connector = new FakeConnector();
    const fileSystem = new MemoryVoiceFileSystem();
    const cacheDir = path.resolve('workspace/.voice-cache');
    const hitId = createVoiceCacheKey('共有', CONFIG);
    fileSystem.files.set(path.join(cacheDir, `${hitId}.wav`), pcmWav());
    const client = new ProductionVoicevoxClient({
      baseUrl,
      config: CONFIG,
      connector,
      workspaceRoot: path.resolve('workspace'),
    });

    const items: SpeechItem[] = [
        { candidateId: 'c1', speechText: '共有' },
        { candidateId: 'c2', speechText: '共有' },
        { candidateId: 'c3', speechText: '新規' },
        { candidateId: 'c4', speechText: '非WAV' },
      ];
    const result = await generateVoiceAssets(
      items,
      client,
      cacheDir,
      { fileSystem, preflight: approvedPreflight(items) },
    );

    expect(result).toMatchObject({ attempted: 3, succeeded: 2, failed: 1 });
    expect(result.assets.find((asset) => asset.audioId === hitId)?.candidateIds).toEqual(['c1', 'c2']);
    expect(result.failures[0]).toMatchObject({ candidateIds: ['c4'], reasonCode: 'VOICE_WAV_INVALID' });
    expect(connector.requests.filter((request) => request.url.pathname === '/version')).toHaveLength(1);
    expect(connector.requests.filter((request) => request.url.pathname === '/speakers')).toHaveLength(1);
    expect(connector.requests.filter((request) => request.url.pathname === '/audio_query')).toHaveLength(2);
    expect(connector.requests.filter((request) => request.url.pathname === '/synthesis')).toHaveLength(2);
    expect(connector.requests.every((request) => !request.followRedirects && !request.useProxy)).toBe(true);
    expect(connector.maximumActive).toBe(1);
    expect(fileSystem.writes).toHaveLength(1);
  });

  it('版・話者gate不一致では追加生成と公開先変更を行わない', async () => {
    const connector = new FakeConnector();
    connector.styleName = '不一致';
    const fileSystem = new MemoryVoiceFileSystem();
    const client = new ProductionVoicevoxClient({
      baseUrl: 'http://127.0.0.1:50021',
      config: CONFIG,
      connector,
      workspaceRoot: path.resolve('workspace'),
    });
    const items: SpeechItem[] = [{ candidateId: 'c1', speechText: '本文' }];
    await expect(
      generateVoiceAssets(items, client, path.resolve('workspace/.cache'), {
        fileSystem,
        preflight: approvedPreflight(items),
      }),
    ).rejects.toMatchObject({ code: 'voice-style-name-mismatch' });
    expect(connector.requests.map((request) => request.url.pathname)).toEqual(['/version', '/speakers']);
    expect(fileSystem.writes).toEqual([]);
  });

  it('immutable config snapshotをgate・query・synthesis・hashで共有し外部改変を拒否する', async () => {
    const connector = new FakeConnector();
    const config: VoiceConfig = {
      ...CONFIG,
      speedScale: 1.25,
      pitchScale: -0.05,
      intonationScale: 1.5,
      volumeScale: 1.25,
      outputSamplingRate: 24_000,
    };
    const expectedConfig = { ...config };
    const client = new ProductionVoicevoxClient({
      baseUrl: 'http://127.0.0.1:50021',
      config,
      connector,
      workspaceRoot: path.resolve('workspace'),
    });
    expect(client.config).not.toBe(config);
    expect(Object.isFrozen(client.config)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(client, 'config')).toMatchObject({
      writable: false,
      configurable: false,
    });
    config.speedScale = Number.NaN;
    config.outputSamplingRate = 48_000;
    expect(Reflect.set(client.config, 'speedScale', Number.NaN)).toBe(false);
    expect(Reflect.set(client, 'config', { ...expectedConfig, speedScale: Number.NaN })).toBe(false);
    expect(client.config).toEqual(expectedConfig);

    const request = connector.request.bind(connector);
    const tamperAttempts: string[] = [];
    connector.request = async (voiceRequest) => {
      if (voiceRequest.url.pathname === '/version' || voiceRequest.url.pathname === '/audio_query') {
        tamperAttempts.push(voiceRequest.url.pathname);
        expect(Reflect.set(client.config, 'speedScale', Number.NaN)).toBe(false);
        expect(Reflect.set(client, 'config', { ...expectedConfig, pitchScale: Number.NaN })).toBe(false);
      }
      return request(voiceRequest);
    };

    const query = await client.createAudioQuery('設定確認') as Record<string, unknown>;
    expect(query).toMatchObject({
      speedScale: expectedConfig.speedScale,
      pitchScale: expectedConfig.pitchScale,
      intonationScale: expectedConfig.intonationScale,
      volumeScale: expectedConfig.volumeScale,
      outputSamplingRate: expectedConfig.outputSamplingRate,
      outputStereo: false,
    });
    Object.assign(query, {
      speedScale: 0.5,
      pitchScale: 0.15,
      intonationScale: 0,
      volumeScale: 0,
      outputSamplingRate: 48_000,
      outputStereo: true,
    });
    await client.synthesize(query);

    const synthesis = connector.requests.find((request) => request.url.pathname === '/synthesis')!;
    const sent = JSON.parse(new TextDecoder().decode(synthesis.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      speedScale: expectedConfig.speedScale,
      pitchScale: expectedConfig.pitchScale,
      intonationScale: expectedConfig.intonationScale,
      volumeScale: expectedConfig.volumeScale,
      outputSamplingRate: expectedConfig.outputSamplingRate,
      outputStereo: false,
    });
    expect(voiceConfigHash(client.config)).toBe(voiceConfigHash(expectedConfig));

    const items: SpeechItem[] = [{ candidateId: 'config-proof', speechText: '設定証跡' }];
    const generation = await generateVoiceAssets(items, client, path.resolve('workspace/.voice-cache'), {
      fileSystem: new MemoryVoiceFileSystem(),
      preflight: estimateVoiceBudget(items, {
        secondsPerCharacter: 0.5,
        outputSamplingRate: client.config.outputSamplingRate,
        bitDepth: 16,
        channels: 1,
        config: client.config,
      }),
    });
    expect(generation.configHash).toBe(voiceConfigHash(expectedConfig));
    const generatedQuery = JSON.parse(new TextDecoder().decode(
      connector.requests.filter((request) => request.url.pathname === '/synthesis').at(-1)!.body,
    )) as Record<string, unknown>;
    expect(generatedQuery).toMatchObject({
      speedScale: expectedConfig.speedScale,
      pitchScale: expectedConfig.pitchScale,
      intonationScale: expectedConfig.intonationScale,
      volumeScale: expectedConfig.volumeScale,
      outputSamplingRate: expectedConfig.outputSamplingRate,
      outputStereo: false,
    });
    expect(tamperAttempts).toEqual(['/audio_query', '/version', '/audio_query']);
  });

  it('非object・NaN・危険key/prototype・getter/proxy/symbol・深さ/件数超過をsynthesis前に拒否する', async () => {
    const connector = new FakeConnector();
    const client = new ProductionVoicevoxClient({
      baseUrl: 'http://127.0.0.1:50021',
      config: CONFIG,
      connector,
    });
    connector.queryFactory = () => null;
    await expect(client.createAudioQuery('不正')).rejects.toMatchObject({ code: 'voice-query-malformed' });

    const inherited = Object.create({ polluted: true }) as Record<string, unknown>;
    inherited.text = '不正';
    const dangerousKey = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const accessor = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperty(accessor, 'text', { enumerable: true, get: () => '不正' });
    const arrayAccessor: unknown[] = [];
    Object.defineProperty(arrayAccessor, '0', { enumerable: true, get: () => '不正' });
    arrayAccessor.length = 1;
    const symbolKey = { [Symbol('unsafe')]: '不正' };
    const proxy = new Proxy({}, { getPrototypeOf: () => { throw new Error('trap'); } });
    const descriptorProxy = new Proxy({ text: '不正' }, {
      getOwnPropertyDescriptor: () => { throw new Error('descriptor trap'); },
    });
    let tooDeep: Record<string, unknown> = {};
    for (let index = 0; index < 66; index += 1) tooDeep = { nested: tooDeep };
    const tooMany = { items: Array.from({ length: 100_001 }, () => null) };
    for (const invalid of [
      null,
      [],
      { value: Number.NaN },
      inherited,
      dangerousKey,
      accessor,
      { items: arrayAccessor },
      symbolKey,
      proxy,
      descriptorProxy,
      tooDeep,
      tooMany,
    ]) {
      await expect(client.synthesize(invalid)).rejects.toBeInstanceOf(VoiceContractError);
    }
    expect(connector.requests.filter((request) => request.url.pathname === '/synthesis')).toHaveLength(0);
  });

  it.each([
    ['非loopback socket', { remoteAddress: '192.168.1.20' }],
    ['redirect', { finalUrl: 'http://127.0.0.1:50021/redirected' }],
  ])('%sは台詞失敗へ格下げせずstage全体を拒否する', async (_label, override) => {
    const connector = new FakeConnector();
    const originalRequest = connector.request.bind(connector);
    connector.request = async (request) => {
      const response = await originalRequest(request);
      return request.url.pathname === '/audio_query' ? { ...response, ...override } : response;
    };
    const fileSystem = new MemoryVoiceFileSystem();
    const client = new ProductionVoicevoxClient({
      baseUrl: 'http://127.0.0.1:50021',
      config: CONFIG,
      connector,
      workspaceRoot: path.resolve('workspace'),
    });
    const items: SpeechItem[] = [{ candidateId: 'c1', speechText: '本文' }];
    await expect(generateVoiceAssets(
      items,
      client,
      path.resolve('workspace/.cache'),
      { fileSystem, preflight: approvedPreflight(items) },
    )).rejects.toMatchObject({ code: expect.stringMatching(/redirect|loopback/) });
    expect(connector.requests.some((request) => request.url.pathname === '/synthesis')).toBe(false);
    expect(fileSystem.writes).toEqual([]);
  });

  it('encoded traversalを含む公開pathとworkspace外cache実体を拒否する', async () => {
    const connector = new FakeConnector();
    const fileSystem = new MemoryVoiceFileSystem();
    const client = new ProductionVoicevoxClient({
      baseUrl: 'http://127.0.0.1:50021',
      config: CONFIG,
      connector,
      workspaceRoot: path.resolve('workspace'),
    });
    const items: SpeechItem[] = [{ candidateId: 'c1', speechText: '本文' }];
    await expect(generateVoiceAssets(
      items,
      client,
      path.resolve('workspace/.cache'),
      { fileSystem, publicPathPrefix: 'audio/%2e%2e/outside', preflight: approvedPreflight(items) },
    )).rejects.toMatchObject({ code: 'voice-public-path-invalid' });

    fileSystem.prepareCache = async () => path.resolve('outside-cache');
    await expect(generateVoiceAssets(
      items,
      client,
      path.resolve('workspace/.cache'),
      { fileSystem, preflight: approvedPreflight(items) },
    )).rejects.toMatchObject({ code: 'voice-cache-boundary' });
  });

  it('preflightなし・候補/configに結合しない古いpreflightではENGINEへ接続しない', async () => {
    const connector = new FakeConnector();
    const fileSystem = new MemoryVoiceFileSystem();
    const client = new ProductionVoicevoxClient({
      baseUrl: 'http://127.0.0.1:50021',
      config: CONFIG,
      connector,
      workspaceRoot: path.resolve('workspace'),
    });
    const items: SpeechItem[] = [{ candidateId: 'c1', speechText: '現在' }];
    await expect(generateVoiceAssets(items, client, path.resolve('workspace/.cache'), {
      fileSystem,
    } as unknown as GenerateVoiceOptions)).rejects.toMatchObject({ code: 'voice-preflight-required' });

    const stale = approvedPreflight([{ candidateId: 'c1', speechText: '過去' }]);
    await expect(generateVoiceAssets(items, client, path.resolve('workspace/.cache'), {
      fileSystem,
      preflight: stale,
    })).rejects.toMatchObject({ code: 'voice-preflight-mismatch' });
    expect(connector.requests).toEqual([]);
    expect(fileSystem.writes).toEqual([]);
  });

  it.each([
    'http://localhost:50021',
    'http://127.0.0.1:50022',
    'https://127.0.0.1:50021',
    'http://192.168.1.1:50021',
  ])('hostname・別port・非loopbackをclient生成時に拒否する: %s', (baseUrl) => {
    expect(() => new ProductionVoicevoxClient({ baseUrl, config: CONFIG, connector: new FakeConnector() })).toThrow(
      /接続先/,
    );
  });
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function manifestForTotal(total: number): AssetManifest {
  const assets: AssetManifest['assets'] = [];
  let remaining = total;
  let index = 0;
  while (remaining > 0) {
    const bytes = Math.min(99_000_000, remaining);
    assets.push({ path: `audio/${index}.wav`, bytes, sha256: hash(String(index)), audioId: `a${index}` });
    remaining -= bytes;
    index += 1;
  }
  return { assets };
}

describe('FUN-F001-018 実測asset容量 [DES-F001-008][DES-F001-014][UT-F001-018]', () => {
  it.each([
    [VOICE_WARNING_BYTES - 1, 'ok'],
    [VOICE_WARNING_BYTES, 'warning'],
    [VOICE_HARD_LIMIT_BYTES - 1, 'warning'],
    [VOICE_HARD_LIMIT_BYTES, 'fail'],
  ] as const)('合計%d byteを%s判定する', (total, status) => {
    expect(verifyAssetBudget(manifestForTotal(total))).toMatchObject({ totalBytes: total, status });
  });

  it('単一上限・参照欠損・別path同一hashをfailし、共有参照は許可する', () => {
    const oneBelow = verifyAssetBudget({
      assets: [
        { path: 'audio/a.wav', bytes: MAX_SINGLE_ASSET_BYTES - 1, sha256: hash('a'), audioId: 'shared' },
      ],
      references: [{ audioId: 'shared' }, { audioId: 'shared' }],
    });
    expect(oneBelow.ok).toBe(true);

    const failed = verifyAssetBudget({
      assets: [
        { path: 'audio/a.wav', bytes: MAX_SINGLE_ASSET_BYTES, sha256: hash('same'), audioId: 'a' },
        { path: 'audio/b.wav', bytes: 1, sha256: hash('same'), audioId: 'b' },
      ],
      references: [{ path: 'missing.wav' }],
    });
    expect(failed.hardFail).toBe(true);
    expect(failed.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['single-asset-limit', 'duplicate-content-path', 'asset-reference-missing']),
    );

    const unsafe = verifyAssetBudget({
      assets: [{ path: 'audio/%2e%2e/a.wav', bytes: 1, sha256: hash('unsafe'), audioId: 'unsafe' }],
      references: [{}],
    });
    expect(unsafe.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['asset-path-invalid', 'asset-reference-invalid']),
    );
  });
});

describe('FUN-F001-039 音声容量preflight [DES-F001-008][DES-F001-014][UT-F001-039]', () => {
  const profile = (targetBytes: number) => ({
    secondsPerCharacter: targetBytes,
    samplingRate: 1,
    bitDepth: 8,
    channels: 1,
    wavHeaderBytes: 0,
  });

  it.each([
    [VOICE_WARNING_BYTES - 1, 'ok', true],
    [VOICE_WARNING_BYTES, 'warning', true],
    [VOICE_HARD_LIMIT_BYTES - 1, 'warning', true],
    [VOICE_HARD_LIMIT_BYTES, 'blocked', false],
  ] as const)('推定%d byteを%s判定する', (bytes, status, canGenerate) => {
    expect(estimateVoiceBudget([{ candidateId: 'c1', speechText: '一' }], profile(bytes))).toMatchObject({
      estimatedBytes: bytes,
      status,
      canGenerate,
    });
  });

  it('共有読みをunique計上し、不正profile・過大誤差で係数更新を要求する', () => {
    const shared = estimateVoiceBudget(
      [
        { candidateId: 'c1', speechText: '同じ' },
        { candidateId: 'c2', speechText: '同じ' },
        { candidateId: 'c3', speechText: '別' },
      ],
      { ...profile(10), wavHeaderBytes: 44 },
    );
    expect(shared).toMatchObject({ candidateCount: 3, uniqueAudioCount: 2, totalCharacters: 3 });

    expect(estimateVoiceBudget([], { ...profile(1), secondsPerCharacter: -1 })).toMatchObject({
      status: 'profile-update-required',
      profileUpdateRequired: true,
    });
    expect(
      estimateVoiceBudget([], { ...profile(1), observedRelativeError: 0.21, maxRelativeError: 0.2 }),
    ).toMatchObject({ status: 'profile-update-required', profileUpdateRequired: true });
    expect(estimateVoiceBudget([
      { candidateId: 'duplicate', speechText: '一' },
      { candidateId: 'duplicate', speechText: '二' },
    ], profile(1))).toMatchObject({ status: 'profile-update-required', reasonCodes: ['voice-item-invalid'] });
  });
});
