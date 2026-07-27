import { createHash } from 'node:crypto';

import type { F004SpeechItem } from './f004-editorial.ts';
import {
  forecastCandidateSafety,
  type CandidateSafetyReport,
  type VoiceEstimateProfileV2,
} from './f003-reuse.ts';
import {
  authorizeVoiceDiffPlan,
  generateVoiceDiff,
  planVoiceDiff,
  type GenerateVoiceDiffOptions,
  type VoiceDiffGenerationResult,
  type VoiceDiffPlan,
} from '../voice/generation.ts';
import {
  ADDED_AUDIO_MAX_BYTES,
  DECIMAL_GB_BYTES,
  MAX_GIT_OBJECT_BYTES,
  PAGES_SAFETY_STOP_BYTES,
  PAGES_WARN_BYTES,
  REPOSITORY_WARN_BYTES,
  forecastCapacity,
  requiredFreeBytes,
  type CapacityForecast,
  type CapacityForecastInput,
  type CapacityResult,
  type GitObjectMeasurement,
} from '../voice/budget.ts';
import type { VoiceConfigV2 } from '../voice/cache.ts';
import type { VoicevoxClient } from '../voice/types.ts';

export class F004VoiceError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'F004VoiceError';
  }
}

export interface F004SafeVoiceItem extends CandidateSafetyReport {
  readonly workId: string;
  readonly speechText: string;
  readonly reconciliationDigest: string;
}

export interface F004ActualCapacityInput {
  readonly batchId: 'F004';
  readonly workId: string;
  readonly additionalAudioBytes: number;
  readonly pagesBytes: number;
  readonly repositoryNonObjectBytes: number;
  readonly gitObjects: readonly GitObjectMeasurement[];
  readonly freeBytes: number;
  readonly liveWriteUpperBounds: number;
  readonly rollbackBackupBytes: number;
}

export interface F004ActualCapacityReport {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'f004-capacity-actual';
  readonly batchId: 'F004';
  readonly workId: string;
  readonly result: CapacityResult;
  readonly additionalAudio: Readonly<{ bytes: number; limit: number; status: 'pass' | 'blocked' }>;
  readonly pages: Readonly<{ bytes: number; warning: number; limit: number; status: 'pass' | 'warning' | 'blocked' }>;
  readonly repository: Readonly<{ bytes: number; warning: number; limit: number; status: 'pass' | 'warning' | 'blocked' }>;
  readonly singleGitObject: Readonly<{ bytes: number; limit: number; status: 'pass' | 'blocked' }>;
  readonly workDrive: Readonly<{ bytes: number; required: number; status: 'pass' | 'blocked' }>;
  readonly reasons: readonly string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 校正済みprofileを再検算し、44 speechを500 code point / 120秒 / 5,760,044 byteで判定する。
 * @des DES-F004-005 @fun FUN-F004-012 @ut UT-F004-012
 */
export function evaluateF004CandidateSafety(
  workId: string,
  items: readonly F004SpeechItem[],
  profile: VoiceEstimateProfileV2,
  reconciliationDigest: string,
): readonly F004SafeVoiceItem[] {
  if (!/^[0-9]{6}$/u.test(workId) || !/^[a-f0-9]{64}$/u.test(reconciliationDigest) ||
    items.length === 0 || new Set(items.map((item) => item.candidateId)).size !== items.length) {
    throw new F004VoiceError('F004_CANDIDATE_UNSAFE', 'safety入力tupleが不正です');
  }
  const reports = items.map((item): F004SafeVoiceItem => {
    if (item.workId !== workId || item.speechSha256 !== sha256(item.speechText.normalize('NFC'))) {
      throw new F004VoiceError('F004_CANDIDATE_UNSAFE', `speech tupleが不正です: ${item.candidateId}`);
    }
    const report = forecastCandidateSafety(item, profile);
    return Object.freeze({
      ...report,
      workId,
      speechText: item.speechText,
      reconciliationDigest,
    });
  });
  const blocked = reports.filter((report) => report.result !== 'pass');
  if (blocked.length !== 0) {
    throw new F004VoiceError(
      'F004_CANDIDATE_UNSAFE',
      `安全上限を超えた候補があります: ${blocked.map((item) => item.candidateId).join(',')}`,
    );
  }
  return Object.freeze(reports);
}

/**
 * approved/safety/speech/config tupleだけからcache hit/missを決定する。
 * @des DES-F004-005 @des DES-F004-011 @fun FUN-F004-014 @ut UT-F004-014
 */
export async function planF004VoiceDiff(
  items: readonly F004SafeVoiceItem[],
  config: VoiceConfigV2,
  cacheRoot: string,
  binding: {
    readonly expectedManifestSha: string;
    readonly preTreeDigest: string;
  },
): Promise<VoiceDiffPlan> {
  if (items.some((item) => item.result !== 'pass')) {
    throw new F004VoiceError('F004_CANDIDATE_UNSAFE', 'PASS safetyだけがvoice planへ進めます');
  }
  return planVoiceDiff(
    items.map((item) => ({
      candidateId: item.candidateId,
      workId: item.workId,
      speechText: item.speechText,
      approved: true,
      estimatedBytes: item.wavBytes,
    })),
    config,
    cacheRoot,
    {
      batchId: 'F004',
      workId: items[0]!.workId,
      expectedManifestSha: binding.expectedManifestSha,
      preTreeDigest: binding.preTreeDigest,
    },
  );
}

/**
 * 5区分の整数容量境界を汎用capacity evaluatorで判定する。
 * @des DES-F004-005 @fun FUN-F004-016 @ut UT-F004-016
 */
export async function forecastF004Capacity(input: CapacityForecastInput): Promise<CapacityForecast> {
  const report = await forecastCapacity(input);
  if (report.batchId !== 'F004') {
    throw new F004VoiceError('F004_CAPACITY_BLOCKED', 'F004以外のcapacity reportです');
  }
  return report;
}

/**
 * PASS forecastをplanへ結合し、loopback clientでmissを逐次生成する。
 * @des DES-F004-005 @fun FUN-F004-015 @ut UT-F004-015
 */
export async function generateF004VoiceDiff(
  plan: VoiceDiffPlan,
  client: VoicevoxClient,
  staging: string,
  forecast: CapacityForecast,
  options: GenerateVoiceDiffOptions = {},
): Promise<VoiceDiffGenerationResult> {
  if (
    forecast.batchId !== 'F004' ||
    forecast.workId !== plan.workId ||
    forecast.planDigest !== plan.planDigest ||
    forecast.expectedManifestSha !== plan.expectedManifestSha ||
    forecast.preTreeDigest !== plan.preTreeDigest ||
    forecast.result === 'blocked' ||
    !forecast.canGenerate
  ) {
    throw new F004VoiceError('F004_CAPACITY_BLOCKED', 'planと一致するPASS forecastが必要です');
  }
  const authorized = authorizeVoiceDiffPlan(plan, {
    result: forecast.result,
    planDigest: plan.planDigest,
    remainingResponseBytes: forecast.remainingResponseBytes,
    minimumFreeBytesAfterWrite: forecast.minimumFreeBytesAfterWrite,
  });
  return generateVoiceDiff(authorized, client, staging, options);
}

function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new F004VoiceError('F004_CAPACITY_BLOCKED', '容量実測値が非負safe integerではありません');
  }
  return value;
}

/**
 * 実WAV・Pages・Git・空き容量の5区分を実測値から再判定する。
 * @des DES-F004-005 @fun FUN-F004-017 @ut UT-F004-017
 */
export function measureF004ActualCapacity(
  input: F004ActualCapacityInput,
): F004ActualCapacityReport {
  if (input.batchId !== 'F004' || !/^[0-9]{6}$/u.test(input.workId)) {
    throw new F004VoiceError('F004_CAPACITY_BLOCKED', 'actual capacity tupleが不正です');
  }
  const additionalAudioBytes = safeInteger(input.additionalAudioBytes);
  const pagesBytes = safeInteger(input.pagesBytes);
  const repositoryNonObjectBytes = safeInteger(input.repositoryNonObjectBytes);
  const freeBytes = safeInteger(input.freeBytes);
  safeInteger(input.liveWriteUpperBounds);
  safeInteger(input.rollbackBackupBytes);
  const uniqueObjects = new Map<string, GitObjectMeasurement>();
  for (const object of input.gitObjects) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object.oid) ||
      !Number.isSafeInteger(object.storedBytes) || object.storedBytes < 0 ||
      !Number.isSafeInteger(object.logicalBytes) || object.logicalBytes < 0) {
      throw new F004VoiceError('F004_CAPACITY_BLOCKED', 'Git object実測値が不正です');
    }
    const previous = uniqueObjects.get(object.oid);
    if (!previous || object.storedBytes > previous.storedBytes) uniqueObjects.set(object.oid, object);
  }
  const objectBytes = [...uniqueObjects.values()].reduce((sum, object) => {
    const next = sum + object.storedBytes;
    if (!Number.isSafeInteger(next)) throw new F004VoiceError('F004_CAPACITY_BLOCKED', 'Git object容量がoverflowしました');
    return next;
  }, 0);
  const repositoryBytes = repositoryNonObjectBytes + objectBytes;
  if (!Number.isSafeInteger(repositoryBytes)) {
    throw new F004VoiceError('F004_CAPACITY_BLOCKED', 'repository容量がoverflowしました');
  }
  const largestObject = Math.max(0, ...[...uniqueObjects.values()].map((object) => object.logicalBytes));
  const required = requiredFreeBytes(input);
  const additionalAudio = {
    bytes: additionalAudioBytes,
    limit: ADDED_AUDIO_MAX_BYTES,
    status: additionalAudioBytes > ADDED_AUDIO_MAX_BYTES ? 'blocked' as const : 'pass' as const,
  };
  const pages = {
    bytes: pagesBytes,
    warning: PAGES_WARN_BYTES,
    limit: PAGES_SAFETY_STOP_BYTES,
    status: pagesBytes > PAGES_SAFETY_STOP_BYTES || pagesBytes >= DECIMAL_GB_BYTES
      ? 'blocked' as const
      : pagesBytes >= PAGES_WARN_BYTES ? 'warning' as const : 'pass' as const,
  };
  const repository = {
    bytes: repositoryBytes,
    warning: REPOSITORY_WARN_BYTES,
    limit: DECIMAL_GB_BYTES,
    status: repositoryBytes >= DECIMAL_GB_BYTES
      ? 'blocked' as const
      : repositoryBytes >= REPOSITORY_WARN_BYTES ? 'warning' as const : 'pass' as const,
  };
  const singleGitObject = {
    bytes: largestObject,
    limit: MAX_GIT_OBJECT_BYTES,
    status: largestObject >= MAX_GIT_OBJECT_BYTES ? 'blocked' as const : 'pass' as const,
  };
  const workDrive = {
    bytes: freeBytes,
    required,
    status: freeBytes < required ? 'blocked' as const : 'pass' as const,
  };
  const statuses = [additionalAudio.status, pages.status, repository.status, singleGitObject.status, workDrive.status];
  const result: CapacityResult = statuses.includes('blocked')
    ? 'blocked'
    : statuses.includes('warning') ? 'pass_with_warning' : 'pass';
  const reasons = [
    ...(additionalAudio.status === 'blocked' ? ['F004_ACTUAL_AUDIO_EXCEEDED'] : []),
    ...(pages.status === 'blocked' ? ['F004_ACTUAL_PAGES_EXCEEDED'] : pages.status === 'warning' ? ['F004_ACTUAL_PAGES_WARNING'] : []),
    ...(repository.status === 'blocked' ? ['F004_ACTUAL_REPOSITORY_EXCEEDED'] :
      repository.status === 'warning' ? ['F004_ACTUAL_REPOSITORY_WARNING'] : []),
    ...(singleGitObject.status === 'blocked' ? ['F004_ACTUAL_OBJECT_EXCEEDED'] : []),
    ...(workDrive.status === 'blocked' ? ['F004_ACTUAL_DISK_INSUFFICIENT'] : []),
  ];
  return Object.freeze({
    schemaVersion: '1.0.0',
    kind: 'f004-capacity-actual',
    batchId: 'F004',
    workId: input.workId,
    result,
    additionalAudio: Object.freeze(additionalAudio),
    pages: Object.freeze(pages),
    repository: Object.freeze(repository),
    singleGitObject: Object.freeze(singleGitObject),
    workDrive: Object.freeze(workDrive),
    reasons: Object.freeze(reasons),
  });
}
