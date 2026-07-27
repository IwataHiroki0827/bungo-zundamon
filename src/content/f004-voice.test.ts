import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { F004SpeechItem } from './f004-editorial.ts';
import {
  F004VoiceError,
  evaluateF004CandidateSafety,
} from './f004-voice.ts';
import type { VoiceEstimateProfileV2 } from './f003-reuse.ts';

const H = (value: string) => createHash('sha256').update(value).digest('hex');

const PROFILE = {
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
} as unknown as VoiceEstimateProfileV2;

function item(text: string): F004SpeechItem {
  return {
    candidateId: 'candidate',
    workId: '000466',
    rawSourceSha256: H('raw'),
    order: 0,
    rawTokenRange: { start: 1, end: 2 },
    displayText: text,
    speechText: text,
    contextBefore: '',
    contextAfter: '',
    sourceAnchor: { bodySelector: '.main_text', startToken: 1, endToken: 2 },
    extractorVersion: '1.0.0',
    normalizerVersion: '1.0.0',
    speechSha256: H(text),
    revisions: [],
  } as unknown as F004SpeechItem;
}

describe('UT-F004-012 candidate safety [DES-F004-005][FUN-F004-012]', () => {
  it('校正profileとinclusive上限内のspeechをPASSにする', () => {
    const reports = evaluateF004CandidateSafety(
      '000466',
      [item('「そうだ」')],
      PROFILE,
      H('reconciliation'),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ result: 'pass', codePoints: 5 });
  });

  it('500 code point超過とstale profileをfail-closedにする', () => {
    expect(() => evaluateF004CandidateSafety(
      '000466',
      [item('あ'.repeat(501))],
      PROFILE,
      H('reconciliation'),
    )).toThrowError(F004VoiceError);
    expect(() => evaluateF004CandidateSafety(
      '000466',
      [item('「そうだ」')],
      { ...PROFILE, artifactSha256: H('stale') } as VoiceEstimateProfileV2,
      H('reconciliation'),
    )).toThrowError(F004VoiceError);
  });
});
