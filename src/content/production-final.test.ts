import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { estimateVoiceBudget } from '../voice/budget';
import { voiceConfigHash } from '../voice/cache';
import { MAX_SINGLE_ASSET_BYTES, type SpeechItem, type VoiceGenerationResult } from '../voice/types';
import {
  FIXED_VOICE_CONFIG,
  VOICE_ESTIMATE_PROFILE,
  assertPreflight,
  assertVoiceGeneration,
  assertWorkspacePathSafe,
  parseProductionJsonBytes,
  validateProductionReviewRecords,
} from './production-final';
import type { Candidate, ReviewRecord } from './processing';

const HASH = 'a'.repeat(64);
const WHEN = '2026-07-18T00:00:00Z';
const temporaryDirectories: string[] = [];

function candidate(id = 'candidate-1'): Candidate {
  return {
    candidateId: id,
    workId: '000127',
    rawSourceSha256: HASH,
    order: 0,
    rawTokenRange: { start: 1, end: 3 },
    displayText: '「台詞」',
    speechText: '「せりふ」',
    contextBefore: '前',
    contextAfter: '後',
    sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 3 },
    extractorVersion: '1.0.0',
    normalizerVersion: '1.0.0',
  };
}

function review(candidateId = 'candidate-1'): ReviewRecord {
  return {
    candidateId,
    revision: 1,
    status: 'approved',
    reasonCode: 'SPOKEN_DIALOGUE',
    note: '本文の発声描写を確認',
    reviewer: 'pf-worker-editorial',
    reviewedAt: WHEN,
    policyCheckedAt: WHEN,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('production後半の信頼境界 [DES-F001-007][DES-F001-017][DES-F001-019]', () => {
  it('reviewのcandidate集合・work/order/hash/anchor・schema・status/reasonをstrict検証する', () => {
    expect(validateProductionReviewRecords('000127', [candidate()], [review()])).toHaveLength(1);
    const mutations: Array<() => unknown> = [
      () => validateProductionReviewRecords('000127', [candidate()], [{ ...review(), extra: true }]),
      () => validateProductionReviewRecords('000127', [candidate()], [{ ...review(), reasonCode: 'UNKNOWN_REASON' }]),
      () => validateProductionReviewRecords('000127', [candidate()], [{ ...review(), status: 'rejected' }]),
      () => validateProductionReviewRecords('000127', [candidate()], [{ ...review(), reviewer: '' }]),
      () => validateProductionReviewRecords('000127', [{ ...candidate(), order: 1 }], [review()]),
      () => validateProductionReviewRecords('000127', [{ ...candidate(), rawSourceSha256: 'bad' }], [review()]),
      () => validateProductionReviewRecords('000127', [{ ...candidate(), sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 1 } }], [review()]),
      () => validateProductionReviewRecords('000127', [candidate()], [{ ...review(), candidateId: 'orphan' }]),
    ];
    mutations.forEach((run) => expect(run).toThrow());
  });

  it('JSONを8MiB以下のfatal UTF-8だけに限定し、置換文字・巨大入力を拒否する', () => {
    expect(parseProductionJsonBytes<{ ok: boolean }>(new TextEncoder().encode('{"ok":true}'))).toEqual({ ok: true });
    expect(() => parseProductionJsonBytes(new Uint8Array([0xc3, 0x28]))).toThrow(/UTF-8/);
    expect(() => parseProductionJsonBytes(new TextEncoder().encode('{"value":"�"}'))).toThrow(/置換文字/);
    expect(() => parseProductionJsonBytes(new Uint8Array(8_388_609))).toThrow(/byte上限/);
  });

  it('保存preflightの推定値・件数・digestを固定profileから全件再計算する', () => {
    const items: SpeechItem[] = Array.from({ length: 59 }, (_, index) => ({
      candidateId: `candidate-${index}`,
      speechText: index === 0 ? 'あ'.repeat(3_284) : String.fromCodePoint(0x4e00 + index),
      approved: true,
      config: FIXED_VOICE_CONFIG,
    }));
    const preflight = estimateVoiceBudget(items, VOICE_ESTIMATE_PROFILE);
    expect(() => assertPreflight(preflight, items)).not.toThrow();
    for (const mutated of [
      { ...preflight, estimatedBytes: preflight.estimatedBytes + 1 },
      { ...preflight, estimatedSeconds: preflight.estimatedSeconds + 1 },
      { ...preflight, totalCharacters: preflight.totalCharacters + 1 },
      { ...preflight, uniqueAudioCount: preflight.uniqueAudioCount - 1 },
      { ...preflight, inputDigest: HASH },
      { ...preflight, reasonCodes: ['voice-budget-warning'] },
    ]) expect(() => assertPreflight(mutated, items)).toThrow(/preflight/);
  });

  it('voice manifestのID/path/candidate/failure/byte/時間の重複と上限違反を拒否する', () => {
    const items: SpeechItem[] = [
      { candidateId: 'c1', speechText: '一' },
      { candidateId: 'c2', speechText: '二' },
    ];
    const base: VoiceGenerationResult = {
      assets: [{
        audioId: HASH,
        path: `audio/F001/${HASH}.wav`,
        sha256: HASH,
        bytes: 100,
        durationMs: 1_000,
        configHash: voiceConfigHash(FIXED_VOICE_CONFIG),
        candidateIds: ['c1', 'c2'],
      }],
      failures: [],
      attempted: 1,
      succeeded: 1,
      failed: 0,
      configHash: voiceConfigHash(FIXED_VOICE_CONFIG),
    };
    expect(() => assertVoiceGeneration(base, items)).not.toThrow();
    const duplicateCandidate = structuredClone(base);
    duplicateCandidate.assets[0]!.candidateIds = ['c1', 'c1'];
    expect(() => assertVoiceGeneration(duplicateCandidate, items)).toThrow();
    const tooLarge = structuredClone(base);
    tooLarge.assets[0]!.bytes = MAX_SINGLE_ASSET_BYTES;
    expect(() => assertVoiceGeneration(tooLarge, items)).toThrow();
    const tooLong = structuredClone(base);
    tooLong.assets[0]!.durationMs = 86_400_001;
    expect(() => assertVoiceGeneration(tooLong, items)).toThrow();
    const badFailure: VoiceGenerationResult = {
      assets: [],
      failures: [{ audioId: 'not-a-hash', candidateIds: ['c1', 'c2'], reasonCode: 'voice-timeout' }],
      attempted: 1,
      succeeded: 0,
      failed: 1,
      configHash: voiceConfigHash(FIXED_VOICE_CONFIG),
    };
    expect(() => assertVoiceGeneration(badFailure, items)).toThrow();
  });

  it('workspace内pathに外部実体を指すjunctionがあれば拒否する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bungo-final-boundary-'));
    temporaryDirectories.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    const junction = join(workspace, 'build');
    await symlink(outside, junction, 'junction');
    await expect(assertWorkspacePathSafe(workspace, join(junction, 'stage'), true)).rejects.toThrow(/symlink|junction/);
  });
});
