import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson } from './artifacts.ts';
import type { BatchManifest, Sha256 } from './batch.ts';
import {
  AOZORA_BIBLIOGRAPHY_ENTRY,
  AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS,
  AOZORA_BIBLIOGRAPHY_URL,
  ProductionAozoraTransport,
  type BatchSelectionManifest,
  type BibliographyRow,
  type BibliographySnapshot,
  type DecodedSource,
  type PinnedRequest,
  type SelectedWork,
  type TransportResponse,
  type WorkRightsObservation,
} from './source.ts';
import { EXTRACTOR_VERSION } from './processing.ts';
import {
  F003ReuseError,
  applySpeechRevisions,
  extractOuterDialogueCandidates,
  fixBatchSource,
  forecastCandidateSafety,
  hashVoiceEstimateProfileV2,
  observeBatchBibliography,
  type ApprovedSpeechCandidate,
  type SpeechRevisionV2,
  type VoiceEstimateProfileV2,
} from './f003-reuse.ts';

const temporaryDirectories: string[] = [];
const WHEN = '2026-07-26T00:00:00.000Z';
const RELEASE = '84c985f382910216e381a96901f6fd569165a27e';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function hash(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function manifest(): BatchSelectionManifest {
  const workIds = ['000275', '001567', '000258'] as unknown as BatchManifest['workIds'];
  return {
    batchId: 'F003' as BatchManifest['batchId'],
    feature: 'F003',
    schemaVersion: '1.0.0',
    status: 'draft',
    author: {
      authorId: '000035',
      name: 'だざいおさむ',
      originalName: '太宰治',
      slug: 'dazai-osamu',
      identitySha256: 'a'.repeat(64) as Sha256,
    },
    workIds,
    workProgress: workIds.map((workId) => ({
      workId,
      status: 'pending' as const,
      stageRecords: [],
    })) as unknown as BatchManifest['workProgress'],
    inputPaths: [],
    outputPaths: [],
    stageRecords: [],
    rightsSnapshotIds: [],
    voiceConfigRef: 'content/batches/F003/voice-config.json' as never,
    artworkProvenanceRef: 'content/batches/F003/artwork-provenance.json' as never,
    editionRules: [
      { title: '女生徒', preferredWorkId: '000275', allowedWorkIds: ['000275'], reason: '承認済み代表作' },
      { title: '走れメロス', preferredWorkId: '001567', allowedWorkIds: ['001567'], reason: '承認済み代表作' },
      { title: 'グッド・バイ', preferredWorkId: '000258', allowedWorkIds: ['000258'], reason: '承認済み代表作' },
    ],
  };
}

function selectedWorks(): SelectedWork[] {
  return [
    ['000275', '女生徒', '275_20169.html'],
    ['001567', '走れメロス', '1567_14913.html'],
    ['000258', 'グッド・バイ', '258_20179.html'],
  ].map(([workId = '', title = '', file = '']) => ({
    workId,
    title,
    personId: '000035',
    role: '著者',
    copyright: 'なし',
    personCopyright: 'なし',
    status: '公開中',
    language: '日本語原著',
    orthography: '新字新仮名',
    sourceUrl: `https://www.aozora.gr.jp/cards/000035/files/${file}`,
    cardUrl: `https://www.aozora.gr.jp/cards/000035/card${Number(workId)}.html`,
    charset: 'UTF-8',
    edition: `底本-${title}`,
    baseEdition: `底本-${title}`,
    inputter: '入力者',
    proofreader: '校正者',
    selectionReason: '承認済み代表作',
  }));
}

function rights(works = selectedWorks()): WorkRightsObservation {
  return {
    phase: 'selection',
    bibliographySha256: 'b'.repeat(64),
    observedAt: WHEN,
    works: works.map((work) => ({
      workId: work.workId,
      title: work.title,
      personId: work.personId,
      personCopyright: work.personCopyright ?? '',
      workCopyright: work.copyright,
      role: work.role,
      translatorPresent: false,
      status: work.status,
      orthography: work.orthography ?? '',
      cardUrl: work.cardUrl ?? '',
      sourceUrl: work.sourceUrl,
    })),
  };
}

function bibliographyCsv(rows: readonly BibliographyRow[]): Uint8Array {
  const records = rows.map((item) => AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.map((column) => ({
    作品ID: String(Number(item.workId)),
    作品名: item.title,
    文字遣い種別: item.orthography ?? '',
    作品著作権フラグ: item.copyright,
    図書カードURL: item.cardUrl ?? '',
    人物ID: String(Number(item.personId)),
    人物著作権フラグ: item.personCopyright ?? '',
    役割フラグ: item.role,
    底本名1: item.baseEdition ?? '',
    入力者: item.inputter ?? '',
    校正者: item.proofreader ?? '',
    'XHTML/HTMLファイルURL': item.sourceUrl,
    'XHTML/HTMLファイル符号化方式': item.charset ?? '',
    'XHTML/HTMLファイル文字集合': item.charset ?? '',
  } as Record<string, string>)[column] ?? '').join(','));
  return new TextEncoder().encode(`${AOZORA_BIBLIOGRAPHY_REQUIRED_COLUMNS.join(',')}\n${records.join('\n')}\n`);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(csv: Uint8Array): Uint8Array {
  const name = Buffer.from(AOZORA_BIBLIOGRAPHY_ENTRY);
  const body = Buffer.from(csv);
  const crc = crc32(csv);
  const local = Buffer.alloc(30 + name.byteLength);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.byteLength, 18);
  local.writeUInt32LE(body.byteLength, 22);
  local.writeUInt16LE(name.byteLength, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.byteLength);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.byteLength, 20);
  central.writeUInt32LE(body.byteLength, 24);
  central.writeUInt16LE(name.byteLength, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.byteLength, 12);
  eocd.writeUInt32LE(local.byteLength + body.byteLength, 16);
  return Buffer.concat([local, body, central, eocd]);
}

function transport(responses: readonly TransportResponse[]): {
  readonly value: ProductionAozoraTransport;
  readonly socket: ReturnType<typeof vi.fn<(request: PinnedRequest) => Promise<TransportResponse>>>;
} {
  let index = 0;
  const socket = vi.fn(async () => {
    const response = responses[index];
    index += 1;
    if (!response) throw new Error('unexpected request');
    return response;
  });
  return {
    value: new ProductionAozoraTransport({
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      pinnedSocketFactory: socket,
    }),
    socket,
  };
}

function response(body: Uint8Array, mediaType: string): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': mediaType, 'content-length': String(body.byteLength) },
    body,
    elapsedMs: 14_999,
    fetchedAt: WHEN,
    complete: true,
    peerAddress: '8.8.8.8',
    socketSecurity: { tlsAuthorized: true, hostnameVerified: true },
  };
}

function decoded(text: string): DecodedSource {
  return {
    workId: '000275',
    rawSha256: 'c'.repeat(64),
    httpCharset: 'UTF-8',
    metaCharset: 'UTF-8',
    bibliographyCharset: 'UTF-8',
    adoptedCharset: 'UTF-8',
    text,
  };
}

function profile(overrides: Partial<VoiceEstimateProfileV2> = {}): VoiceEstimateProfileV2 {
  const core: Omit<VoiceEstimateProfileV2, 'artifactSha256'> = {
    schemaVersion: '2.0.0',
    sourceReleaseCommit: RELEASE,
    sourceSetSha256: '0951c2da012c91d646b2a435b96ea6c7d9fa18809e84419245191114cf2605ff' as Sha256,
    configHash: '0c42dc249190ce75ad6f7dee06aeae099abcef4bbd7c23411c966c9389d14691' as Sha256,
    sampleCount: 151,
    secondsPerCharacter: 0.1624195655724318,
    safetyFactor: 1.2,
    observedEstimatedBytes: 57_293_300,
    observedActualBytes: 47_741_940,
    observedRelativeError: 0.1667098945251888,
    maxRelativeError: 0.2,
    outputSamplingRate: 24_000,
    bitDepth: 16,
    channels: 1,
    wavHeaderBytes: 44,
    calibratedAt: '2026-07-26T02:59:39.000+09:00',
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'artifactSha256')),
  } as Omit<VoiceEstimateProfileV2, 'artifactSha256'>;
  return {
    ...core,
    artifactSha256: overrides.artifactSha256 ?? hashVoiceEstimateProfileV2(core),
  };
}

describe('F003 F002処理再利用adapter', () => {
  /** @des DES-F003-003 @fun FUN-F003-006 @test UT-F003-006 */
  it('production transportで3作品の書誌権利を一括観測し、危険なtransport差替えを拒否する', async () => {
    const archive = zip(bibliographyCsv(selectedWorks()));
    const fake = transport([response(archive, 'application/zip')]);
    const result = await observeBatchBibliography(manifest(), 'selection', {
      transport: fake.value,
      clock: () => new Date(WHEN),
    });
    expect(result.phase).toBe('selection');
    if (result.phase === 'selection') {
      expect(result.works.map((work) => work.workId)).toEqual(['000275', '001567', '000258']);
      expect(result.observation.works).toHaveLength(3);
    }
    expect(fake.socket).toHaveBeenCalledTimes(1);
    await expect(observeBatchBibliography(manifest(), 'selection', {
      transport: { request: vi.fn() } as unknown as ProductionAozoraTransport,
      clock: () => new Date(WHEN),
    })).rejects.toMatchObject({ code: 'PRODUCTION_TRANSPORT_REQUIRED' });
  });

  /** @des DES-F003-003 @fun FUN-F003-006 @test UT-F003-006 */
  it('predeployではrelease commit/run/selectionを必須にする', async () => {
    const fake = transport([]);
    await expect(observeBatchBibliography(manifest(), 'predeploy', {
      transport: fake.value,
      clock: () => new Date(WHEN),
    })).rejects.toMatchObject({ code: 'WORK_RIGHTS_PREDEPLOY_MISSING' });
    await expect(observeBatchBibliography(manifest(), 'selection', {
      transport: fake.value,
      clock: () => new Date(WHEN),
      releaseCommit: RELEASE,
    })).rejects.toMatchObject({ code: 'WORK_RIGHTS_OBSERVATION_STALE' });
  });

  /** @des DES-F003-003 @fun FUN-F003-007 @test UT-F003-007 */
  it('原典bytes・charset・selector・書誌metadataを検証後に既存atomic promotionへ渡す', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bungo-f003-source-'));
    temporaryDirectories.push(workspace);
    const work = selectedWorks()[0]!;
    const raw = new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?><html><body><div class="main_text">前「台詞」後</div></body></html>',
    );
    const fake = transport([response(raw, 'application/xhtml+xml; charset=UTF-8')]);
    const snapshot: BibliographySnapshot = {
      sourceUrl: AOZORA_BIBLIOGRAPHY_URL,
      archivePath: AOZORA_BIBLIOGRAPHY_ENTRY.replace('.csv', '.zip'),
      archiveSha256: 'e'.repeat(64),
      archiveBytes: 100,
      csvPath: AOZORA_BIBLIOGRAPHY_ENTRY,
      csvEntry: AOZORA_BIBLIOGRAPHY_ENTRY,
      csvSha256: 'b'.repeat(64),
      csvBytes: 100,
      mediaType: 'application/zip',
      fetchedAt: WHEN,
      schemaVersion: 'schema-1',
    };
    const outputDir = join(workspace, 'data', 'batches', 'F003', 'sources');
    const fixed = await fixBatchSource(work, fake.value, {
      workspaceRoot: workspace,
      outputDir,
      observation: rights(),
      snapshot,
      toolVersion: 'f003-source/1.0.0',
      changeNotice: '書誌metadataはCC BY 4.0、本文加工内容を記録',
    });
    expect(fixed).toMatchObject({
      bodySelector: '.main_text',
      metadata: { baseEdition: '底本-女生徒', inputter: '入力者', proofreader: '校正者' },
    });
    expect(hash(await readFile(join(outputDir, work.workId, 'source.raw')))).toBe(hash(raw));
    expect(JSON.parse(await readFile(join(outputDir, work.workId, 'metadata.json'), 'utf8')))
      .toEqual(fixed.metadata);
    expect(JSON.parse(await readFile(join(outputDir, work.workId, 'provenance.json'), 'utf8')))
      .toEqual(fixed.provenance);
    expect(JSON.parse(await readFile(join(outputDir, work.workId, 'fixed-source.json'), 'utf8')))
      .toEqual(fixed.wrapper);
    expect(fixed.wrapper.metadataSha256).toBe(hash(canonicalJson(fixed.metadata)));
    expect(fixed.wrapper.provenanceSha256).toBe(hash(canonicalJson(fixed.provenance)));

    const before = await readFile(join(outputDir, work.workId, 'source.raw'));
    const invalid = transport([response(
      new TextEncoder().encode('<?xml version="1.0" encoding="Shift_JIS"?><html><body><div class="main_text">「壊れる」</div></body></html>'),
      'application/xhtml+xml; charset=UTF-8',
    )]);
    await expect(fixBatchSource(work, invalid.value, {
      workspaceRoot: workspace,
      outputDir,
      observation: rights(),
      snapshot,
      toolVersion: 'f003-source/1.0.0',
      changeNotice: '書誌metadataはCC BY 4.0、本文加工内容を記録',
    })).rejects.toBeTruthy();
    expect(await readFile(join(outputDir, work.workId, 'source.raw'))).toEqual(before);

    const unusedForInvalidSnapshot = transport([response(raw, 'application/xhtml+xml; charset=UTF-8')]);
    await expect(fixBatchSource(work, unusedForInvalidSnapshot.value, {
      workspaceRoot: workspace,
      outputDir,
      observation: rights(),
      snapshot: { ...snapshot, unexpected: true } as unknown as BibliographySnapshot,
      toolVersion: 'f003-source/1.0.0',
      changeNotice: '書誌metadataはCC BY 4.0、本文加工内容を記録',
    })).rejects.toMatchObject({ code: 'SOURCE_BIBLIOGRAPHY_INVALID' });
    expect(unusedForInvalidSnapshot.socket).not.toHaveBeenCalled();

    const validRights = rights();
    const mismatchedRights: WorkRightsObservation = {
      ...validRights,
      works: validRights.works.map((entry, index) => index === 0 ? { ...entry, role: '翻訳者' } : entry),
    };
    const unusedForInvalidRights = transport([response(raw, 'application/xhtml+xml; charset=UTF-8')]);
    await expect(fixBatchSource(work, unusedForInvalidRights.value, {
      workspaceRoot: workspace,
      outputDir,
      observation: mismatchedRights,
      snapshot,
      toolVersion: 'f003-source/1.0.0',
      changeNotice: '書誌metadataはCC BY 4.0、本文加工内容を記録',
    })).rejects.toMatchObject({ code: 'WORK_ALLOWLIST_MISMATCH' });
    expect(unusedForInvalidRights.socket).not.toHaveBeenCalled();
  });

  /** @des DES-F003-004 @fun FUN-F003-008 @test UT-F003-008 */
  it('外側「」だけを順序どおり抽出し、ruby・改行・入れ子『』でも決定的である', () => {
    const source = decoded(
      '<html><body><div class="main_text">前「一つ<br/>続き『引用』」中「<ruby>言葉<rt>ことば</rt></ruby>」後</div></body></html>',
    );
    const first = extractOuterDialogueCandidates(source, EXTRACTOR_VERSION);
    const second = extractOuterDialogueCandidates(source, EXTRACTOR_VERSION);
    expect(first.candidates).toHaveLength(2);
    expect(first.candidates.map((candidate) => candidate.order)).toEqual([0, 1]);
    expect(first.sha256).toBe(second.sha256);
  });

  /** @des DES-F003-004 @fun FUN-F003-008 @test UT-F003-008 */
  it('壊れた外側括弧と単独『』を候補へ混ぜず理由codeを残す', () => {
    const broken = extractOuterDialogueCandidates(
      decoded('<html><body><div class="main_text">「未完</div></body></html>'),
      EXTRACTOR_VERSION,
    );
    expect(broken.candidates).toEqual([]);
    expect(broken.excluded.map((item) => item.code)).toContain('unmatched-opening-bracket');
    const inner = extractOuterDialogueCandidates(
      decoded('<html><body><div class="main_text">『引用』</div></body></html>'),
      EXTRACTOR_VERSION,
    );
    expect(inner.candidates).toEqual([]);
    expect(inner.excluded.map((item) => item.code)).toContain('standalone-inner-bracket');
    expect(() => extractOuterDialogueCandidates(decoded('<html/>'), '2.0.0')).toThrowError(F003ReuseError);
  });

  /** @des DES-F003-006 @fun FUN-F003-012 @test UT-F003-012 */
  it('display textを保持して連続revisionとhashを適用し、revisionなしも再現する', () => {
    const approved: ApprovedSpeechCandidate[] = [
      { candidateId: 'c1', displayText: '「今日」', speechText: '「きょう」' },
      { candidateId: 'c2', displayText: '「無補正」', speechText: '「むほせい」' },
    ];
    const after1 = '「きょー」';
    const after2 = '「きょー。」';
    const revisions: SpeechRevisionV2[] = [
      {
        candidateId: 'c1', revision: 1, before: approved[0]!.speechText, after: after1, reason: '読み補正',
        inputSha256: hash(approved[0]!.speechText), outputSha256: hash(after1),
      },
      {
        candidateId: 'c1', revision: 2, before: after1, after: after2, reason: '間補正',
        inputSha256: hash(after1), outputSha256: hash(after2),
      },
    ];
    expect(applySpeechRevisions(approved, revisions)).toEqual([
      expect.objectContaining({ candidateId: 'c1', displayText: '「今日」', speechText: after2, revisionCount: 2 }),
      expect.objectContaining({ candidateId: 'c2', displayText: '「無補正」', speechText: '「むほせい」', revisionCount: 0 }),
    ]);
  });

  /** @des DES-F003-006 @fun FUN-F003-012 @test UT-F003-012 */
  it.each([
    ['飛越し', { revision: 2 }],
    ['before差', { before: '別本文' }],
    ['input hash差', { inputSha256: '0'.repeat(64) }],
    ['output hash差', { outputSha256: '0'.repeat(64) }],
    ['別candidate', { candidateId: 'other' }],
  ])('%sのrevision chainを拒否する', (_label, overrides) => {
    const approved = [{ candidateId: 'c1', displayText: '表示', speechText: '発話' }];
    const revision = {
      candidateId: 'c1',
      revision: 1,
      before: '発話',
      after: 'はつわ',
      reason: '読み補正',
      inputSha256: hash('発話'),
      outputSha256: hash('はつわ'),
      ...overrides,
    } as SpeechRevisionV2;
    expect(() => applySpeechRevisions(approved, [revision])).toThrowError(
      expect.objectContaining({ code: 'SPEECH_REVISION_CHAIN_INVALID' }),
    );
  });

  /** @des DES-F003-006 @fun FUN-F003-013 @test UT-F003-013 */
  it('Unicode code point・duration・WAVのinclusive上限を受理し+1をblockedにする', () => {
    const exactProfile = profile();
    const exactText = '声';
    const exact = forecastCandidateSafety(
      { candidateId: 'c1', speechText: exactText, speechSha256: hash(exactText) },
      exactProfile,
    );
    expect(exact).toMatchObject({
      result: 'pass',
      configHash: exactProfile.configHash,
      profileSha256: exactProfile.artifactSha256,
      codePoints: 1,
      durationMs: 195,
      wavBytes: 9_404,
    });
    const exactBoundaryProfile = profile({ secondsPerCharacter: 120, safetyFactor: 1 });
    const exactBoundary = forecastCandidateSafety(
      { candidateId: 'c1', speechText: exactText, speechSha256: hash(exactText) },
      exactBoundaryProfile,
    );
    expect(exactBoundary).toMatchObject({ result: 'blocked', durationMs: 120_000, wavBytes: 5_760_044 });
    expect(exactBoundary.reasons).toContain('VOICE_PROFILE_STALE');
    const overBoundary = forecastCandidateSafety(
      { candidateId: 'c1', speechText: exactText, speechSha256: hash(exactText) },
      profile({ secondsPerCharacter: 120.001, safetyFactor: 1 }),
    );
    expect(overBoundary).toMatchObject({
      result: 'blocked',
      durationMs: 120_001,
      wavBytes: 5_760_092,
    });

    expect(forecastCandidateSafety(
      { candidateId: 'c2', speechText: '😀'.repeat(500), speechSha256: hash('😀'.repeat(500)) },
      exactProfile,
    )).toMatchObject({ result: 'pass', codePoints: 500 });
    expect(forecastCandidateSafety(
      { candidateId: 'c2', speechText: '😀'.repeat(501), speechSha256: hash('😀'.repeat(501)) },
      exactProfile,
    ).reasons).toContain('CANDIDATE_CODE_POINT_LIMIT');
  });

  /** @des DES-F003-006 @fun FUN-F003-013 @test UT-F003-013 */
  it('profile誤差0.20を受理し、+ε・hash差・非有限・stale speechをblockedにする', () => {
    const text = '台詞';
    const item = { candidateId: 'c1', speechText: text, speechSha256: hash(text) };
    expect(forecastCandidateSafety(item, profile()).result).toBe('pass');
    expect(forecastCandidateSafety(item, profile({
      observedActualBytes: 121,
      observedRelativeError: 0.21,
    })).reasons).toContain('VOICE_PROFILE_STALE');
    expect(forecastCandidateSafety(item, profile({ artifactSha256: '0'.repeat(64) as Sha256 })).reasons)
      .toContain('VOICE_PROFILE_HASH_MISMATCH');
    expect(forecastCandidateSafety(item, profile({
      secondsPerCharacter: Number.NaN,
      artifactSha256: '0'.repeat(64) as Sha256,
    })).reasons)
      .toContain('VOICE_PROFILE_VALUE_INVALID');
    expect(forecastCandidateSafety(item, profile({
      configHash: '0'.repeat(64) as Sha256,
    })).reasons).toContain('VOICE_PROFILE_SCHEMA_INVALID');
    expect(forecastCandidateSafety(item, profile({
      outputSamplingRate: 48_000 as 24_000,
    })).reasons).toContain('VOICE_PROFILE_SCHEMA_INVALID');
    expect(forecastCandidateSafety({ ...item, speechSha256: '0'.repeat(64) as Sha256 }, profile()).reasons)
      .toContain('CANDIDATE_SPEECH_INVALID');
  });

  /** @des DES-F003-006 @fun FUN-F003-013 @test UT-F003-013 */
  it('固定F002校正artifactが実装内の信頼値と一致する', async () => {
    const artifact = JSON.parse(await readFile(
      join(process.cwd(), 'content', 'baselines', 'F002-voice-estimate-profile.json'),
      'utf8',
    )) as VoiceEstimateProfileV2;
    expect(artifact).toEqual(profile());
    expect(forecastCandidateSafety(
      { candidateId: 'c1', speechText: '台詞', speechSha256: hash('台詞') },
      artifact,
    ).result).toBe('pass');
  });
});
