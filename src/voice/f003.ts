import { createHash } from 'node:crypto';

import { canonicalJson } from '../content/artifacts.ts';
import {
  authorizeVoiceDiffPlan,
  generateVoiceDiff as generateVoiceDiffV2,
  planVoiceDiff as planVoiceDiffV2,
  verifyVoiceCompleteness as verifyVoiceCompletenessV2,
  type GenerateVoiceDiffOptions,
  type VoiceCompletenessReport,
  type VoiceDiffGenerationResult,
  type VoiceDiffPlan,
} from './generation.ts';
import {
  forecastCapacity as forecastCapacityV2,
  measureGitRepository,
  verifyActualCapacity,
  type ActualCapacityReport,
  type CapacityDistPreview,
  type CapacityDiskInput,
  type CapacityForecast,
  type CapacityForecastInput,
  type CapacityPathClaim,
  type GitObjectMeasurement,
} from './budget.ts';
import {
  canonicalVoiceConfigV2,
  voiceConfigHashV2,
  type VoiceConfigV2,
} from './cache.ts';
import { VoiceStageError, type VoicevoxClient } from './types.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

export const F002_VOICE_CONFIG_SOURCE = Object.freeze({
  releaseCommit: '84c985f382910216e381a96901f6fd569165a27e',
  path: 'content/batches/F002/voice-config.json',
  sha256: 'dd0e45e4a57e2bcd5b3901ac43112f42c0ce8fcf67af5da8b3f2177ddd88ca1e',
});

export const F002_VOICE_CONFIG: Readonly<VoiceConfigV2> = Object.freeze({
  cacheSchemaVersion: '2',
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
  presetVersion: '1.0.0',
});

export class F003VoiceError extends VoiceStageError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = 'F003VoiceError';
  }
}

export interface F003VoiceManifest {
  readonly schemaVersion: '1.0.0';
  readonly batchId: 'F003';
  readonly workId: string;
  readonly expectedManifestSha: string;
  readonly preTreeDigest: string;
  readonly reconciliationDigest: string;
  readonly profileSha256: string;
  readonly approvedCandidateIds: readonly string[];
}

export interface F003SafeVoiceItem {
  readonly candidateId: string;
  readonly workId: string;
  readonly speechText: string;
  readonly speechSha256: string;
  readonly profileSha256: string;
  readonly configHash: string;
  readonly reconciliationDigest: string;
  readonly result: 'pass' | 'blocked';
  readonly codePoints: number;
  readonly durationMs: number;
  readonly wavBytes: number;
  readonly limits: Readonly<{
    codePoints: 500;
    durationMs: 120_000;
    wavBytes: 5_760_044;
  }>;
}

export interface F003VoiceCacheIndex {
  readonly root: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceReleaseCommit: string;
}

export interface F003VoiceDiffPlan {
  readonly schemaVersion: '3';
  readonly manifest: F003VoiceManifest;
  readonly items: readonly F003SafeVoiceItem[];
  readonly configSource: F003VoiceCacheIndex;
  readonly configHash: string;
  readonly basePlan: VoiceDiffPlan;
  readonly basePlanDigest: string;
  readonly candidateCount: number;
  readonly uniqueAudioCount: number;
  readonly hitCount: number;
  readonly missCount: number;
  readonly invalidCount: number;
  readonly estimatedMissBytes: number;
  readonly planDigest: string;
}

export interface F003CapacityForecastInput {
  readonly plan: F003VoiceDiffPlan;
  readonly alreadyGeneratedUniqueAudioBytes: number;
  readonly currentPagesBytes: number;
  readonly plannedPagesBytes: number;
  readonly repositoryNonObjectBytes: number;
  readonly gitObjects: readonly GitObjectMeasurement[];
  readonly disk: CapacityDiskInput;
  readonly paths?: readonly CapacityPathClaim[];
}

export interface F003VoiceDiffResult {
  readonly schemaVersion: '3';
  readonly planDigest: string;
  readonly basePlanDigest: string;
  readonly generation: VoiceDiffGenerationResult;
  readonly generationDigest: string;
}

export interface F003ReviewCandidate {
  readonly candidateId: string;
  readonly speechText: string;
  readonly speechSha256: string;
  readonly configHash: string;
}

export interface F003VoiceReview {
  readonly batchId: 'F003';
  readonly workId: string;
  readonly reconciliationDigest: string;
  readonly approved: readonly F003ReviewCandidate[];
  readonly rejectedCandidateIds: readonly string[];
  readonly pendingCandidateIds: readonly string[];
}

export interface F003AcceptedAudioSource {
  readonly candidateId: string;
  readonly audioId: string;
  readonly speechSha256: string;
  readonly configHash: string;
  readonly assetSha256: string;
  readonly bytes: number;
  readonly durationMs: number;
  readonly sourcePath: string;
}

export interface F003VoiceCompletenessReport {
  readonly schemaVersion: '3';
  readonly result: 'pass';
  readonly planDigest: string;
  readonly generationDigest: string;
  readonly reconciliationDigest: string;
  readonly base: VoiceCompletenessReport;
  readonly completenessDigest: string;
}

export interface F003GitAdapter {
  readonly measure: (repositoryRoot: string, candidateFiles: readonly string[]) => Promise<readonly GitObjectMeasurement[]>;
}

export interface F003ActualCapacityContext {
  readonly phase: 'work-preview';
  readonly workspaceRoot: string;
  readonly repositoryRoot: string;
  readonly candidateDigest: string;
  readonly candidateCommit: string;
  readonly contentStagingSha256: string;
  readonly additionalAudioFiles: readonly string[];
  readonly repositoryCandidateFiles: readonly string[];
  readonly repositoryNonObjectBytes?: number;
  readonly disk: CapacityDiskInput;
}

export interface F003CompletedVoiceResult {
  readonly plan: F003VoiceDiffPlan;
  readonly generation: F003VoiceDiffResult;
  readonly completeness: F003VoiceCompletenessReport;
}

export interface F003ActualCapacityReport {
  readonly schemaVersion: '3';
  readonly phase: 'work-preview';
  readonly result: ActualCapacityReport['result'];
  readonly planDigest: string;
  readonly candidateDigest: string;
  readonly candidateCommit: string;
  readonly distSha256: string;
  readonly base: ActualCapacityReport;
  readonly capacityDigest: string;
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function voiceError(code: string, message: string): never {
  throw new F003VoiceError(code, message);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort((x, y) => x.localeCompare(y, 'en'));
  const b = [...right].sort((x, y) => x.localeCompare(y, 'en'));
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertFixedConfig(config: VoiceConfigV2, cacheIndex: F003VoiceCacheIndex): string {
  if (cacheIndex.sourcePath !== F002_VOICE_CONFIG_SOURCE.path ||
    cacheIndex.sourceSha256 !== F002_VOICE_CONFIG_SOURCE.sha256 ||
    cacheIndex.sourceReleaseCommit !== F002_VOICE_CONFIG_SOURCE.releaseCommit) {
    return voiceError('VOICE_CONFIG_SOURCE_MISMATCH', 'F002固定releaseのconfig provenanceと一致しません');
  }
  const canonical = canonicalVoiceConfigV2(config);
  if (canonical !== canonicalVoiceConfigV2(F002_VOICE_CONFIG)) {
    return voiceError('VOICE_CONFIG_HASH_MISMATCH', 'F002固定VoiceConfig tupleと一致しません');
  }
  return voiceConfigHashV2(config);
}

function assertManifest(manifest: F003VoiceManifest): void {
  if (manifest.schemaVersion !== '1.0.0' || manifest.batchId !== 'F003' ||
    !manifest.workId.trim() || /[\\/\0]/u.test(manifest.workId) ||
    !SHA256.test(manifest.expectedManifestSha) || !SHA256.test(manifest.preTreeDigest) ||
    !SHA256.test(manifest.reconciliationDigest) || !SHA256.test(manifest.profileSha256) ||
    manifest.approvedCandidateIds.length === 0 ||
    new Set(manifest.approvedCandidateIds).size !== manifest.approvedCandidateIds.length ||
    manifest.approvedCandidateIds.some((id) => !id.trim())) {
    voiceError('VOICE_TUPLE_INVALID', 'F003 voice manifestが不正です');
  }
}

function assertSafeItems(
  manifest: F003VoiceManifest,
  items: readonly F003SafeVoiceItem[],
  configHash: string,
): void {
  if (!sameStringSet(manifest.approvedCandidateIds, items.map((item) => item.candidateId)) ||
    new Set(items.map((item) => item.candidateId)).size !== items.length) {
    voiceError('VOICE_APPROVED_MISSING', '承認候補と安全予測項目が一致しません');
  }
  for (const item of items) {
    if (item.workId !== manifest.workId || item.result !== 'pass' ||
      item.reconciliationDigest !== manifest.reconciliationDigest ||
      item.profileSha256 !== manifest.profileSha256 ||
      item.configHash !== configHash || item.speechSha256 !== hash(item.speechText.normalize('NFC')) ||
      item.speechText !== item.speechText.normalize('NFC') ||
      !Number.isSafeInteger(item.codePoints) || item.codePoints < 1 || item.codePoints > 500 ||
      !Number.isSafeInteger(item.durationMs) || item.durationMs < 1 || item.durationMs > 120_000 ||
      !Number.isSafeInteger(item.wavBytes) || item.wavBytes < 45 || item.wavBytes > 5_760_044 ||
      canonicalJson(item.limits) !== canonicalJson({ codePoints: 500, durationMs: 120_000, wavBytes: 5_760_044 })) {
      voiceError('VOICE_SAFETY_TUPLE_MISMATCH', `候補安全予測tupleが不正です: ${item.candidateId}`);
    }
  }
}

function f003PlanCore(plan: Omit<F003VoiceDiffPlan, 'planDigest'>): unknown {
  return {
    schemaVersion: plan.schemaVersion,
    manifest: plan.manifest,
    items: plan.items.map((item) => ({
      candidateId: item.candidateId,
      workId: item.workId,
      speechSha256: item.speechSha256,
      profileSha256: item.profileSha256,
      configHash: item.configHash,
      reconciliationDigest: item.reconciliationDigest,
      result: item.result,
      codePoints: item.codePoints,
      durationMs: item.durationMs,
      wavBytes: item.wavBytes,
      limits: item.limits,
    })),
    configSource: plan.configSource,
    configHash: plan.configHash,
    basePlanDigest: plan.basePlanDigest,
    candidateCount: plan.candidateCount,
    uniqueAudioCount: plan.uniqueAudioCount,
    hitCount: plan.hitCount,
    missCount: plan.missCount,
    invalidCount: plan.invalidCount,
    estimatedMissBytes: plan.estimatedMissBytes,
  };
}

function assertPlan(plan: F003VoiceDiffPlan): void {
  const { planDigest, ...core } = plan;
  if (!SHA256.test(planDigest) || hash(canonicalJson(f003PlanCore(core))) !== planDigest ||
    plan.basePlan.planDigest !== plan.basePlanDigest ||
    plan.basePlan.batchId !== plan.manifest.batchId || plan.basePlan.workId !== plan.manifest.workId ||
    plan.basePlan.expectedManifestSha !== plan.manifest.expectedManifestSha ||
    plan.basePlan.preTreeDigest !== plan.manifest.preTreeDigest ||
    plan.basePlan.configHash !== plan.configHash) {
    voiceError('VOICE_PLAN_DIGEST_MISMATCH', 'F003 voice plan digest/tupleが一致しません');
  }
}

/**
 * F002 diff plannerへF003のreview/safety/profile/config証跡を結合する。
 * @des DES-F003-007 @fun FUN-F003-014 @ut UT-F003-014
 */
export async function planVoiceDiff(
  manifest: F003VoiceManifest,
  safeItems: readonly F003SafeVoiceItem[],
  cacheIndex: F003VoiceCacheIndex,
  config: VoiceConfigV2,
): Promise<F003VoiceDiffPlan> {
  assertManifest(manifest);
  const configHash = assertFixedConfig(config, cacheIndex);
  assertSafeItems(manifest, safeItems, configHash);
  const basePlan = await planVoiceDiffV2(
    safeItems.map((item) => ({
      candidateId: item.candidateId,
      workId: item.workId,
      speechText: item.speechText,
      approved: true,
      estimatedBytes: item.wavBytes,
    })),
    config,
    cacheIndex.root,
    {
      batchId: manifest.batchId,
      workId: manifest.workId,
      expectedManifestSha: manifest.expectedManifestSha,
      preTreeDigest: manifest.preTreeDigest,
    },
  );
  const partial: Omit<F003VoiceDiffPlan, 'planDigest'> = {
    schemaVersion: '3',
    manifest: Object.freeze({ ...manifest, approvedCandidateIds: Object.freeze([...manifest.approvedCandidateIds]) }),
    items: Object.freeze(safeItems.map((item) => Object.freeze({ ...item, limits: Object.freeze({ ...item.limits }) }))),
    configSource: Object.freeze({ ...cacheIndex }),
    configHash,
    basePlan,
    basePlanDigest: basePlan.planDigest,
    candidateCount: basePlan.candidateCount,
    uniqueAudioCount: basePlan.uniqueAudioCount,
    hitCount: basePlan.hitCount,
    missCount: basePlan.missCount,
    invalidCount: basePlan.invalidCount,
    estimatedMissBytes: basePlan.estimatedMissBytes,
  };
  return Object.freeze({ ...partial, planDigest: hash(canonicalJson(f003PlanCore(partial))) });
}

/**
 * 既存5区分容量forecastへF003 plan digestを結合する。
 * @des DES-F003-007 @fun FUN-F003-016 @ut UT-F003-016
 */
export async function forecastCapacity(input: F003CapacityForecastInput): Promise<CapacityForecast> {
  assertPlan(input.plan);
  const base: CapacityForecastInput = {
    plan: {
      batchId: input.plan.manifest.batchId,
      workId: input.plan.manifest.workId,
      expectedManifestSha: input.plan.manifest.expectedManifestSha,
      preTreeDigest: input.plan.manifest.preTreeDigest,
      planDigest: input.plan.planDigest,
      estimatedMissBytes: input.plan.estimatedMissBytes,
    },
    expectedManifestSha: input.plan.manifest.expectedManifestSha,
    preTreeDigest: input.plan.manifest.preTreeDigest,
    planDigest: input.plan.planDigest,
    alreadyGeneratedUniqueAudioBytes: input.alreadyGeneratedUniqueAudioBytes,
    currentPagesBytes: input.currentPagesBytes,
    plannedPagesBytes: input.plannedPagesBytes,
    repositoryNonObjectBytes: input.repositoryNonObjectBytes,
    gitObjects: input.gitObjects,
    disk: input.disk,
    ...(input.paths ? { paths: input.paths } : {}),
  };
  return forecastCapacityV2(base);
}

function generationDigest(plan: F003VoiceDiffPlan, generation: VoiceDiffGenerationResult): string {
  return hash(canonicalJson({
    schemaVersion: '3',
    planDigest: plan.planDigest,
    basePlanDigest: plan.basePlanDigest,
    baseGenerationDigest: generation.generationDigest,
  }));
}

/**
 * F002のloopback検証・逐次生成・WAV検査・失敗時staging破棄を再利用する。
 * @des DES-F003-007 @fun FUN-F003-015 @ut UT-F003-015
 */
export async function generateVoiceDiff(
  plan: F003VoiceDiffPlan,
  loopbackClient: VoicevoxClient,
  stage: string,
  diskGuard: CapacityForecast,
  options: GenerateVoiceDiffOptions = {},
): Promise<F003VoiceDiffResult> {
  assertPlan(plan);
  if (diskGuard.evidenceKind !== 'forecast' || diskGuard.result === 'blocked' ||
    diskGuard.planDigest !== plan.planDigest ||
    diskGuard.expectedManifestSha !== plan.manifest.expectedManifestSha ||
    diskGuard.preTreeDigest !== plan.manifest.preTreeDigest) {
    voiceError('VOICE_CAPACITY_FORECAST_REQUIRED', 'F003 planと一致する容量forecast PASSが必要です');
  }
  const authorized = authorizeVoiceDiffPlan(plan.basePlan, {
    result: diskGuard.result,
    planDigest: plan.basePlanDigest,
    remainingResponseBytes: diskGuard.remainingResponseBytes,
    minimumFreeBytesAfterWrite: diskGuard.minimumFreeBytesAfterWrite,
  });
  const generation = await generateVoiceDiffV2(authorized, loopbackClient, stage, options);
  return Object.freeze({
    schemaVersion: '3',
    planDigest: plan.planDigest,
    basePlanDigest: plan.basePlanDigest,
    generation,
    generationDigest: generationDigest(plan, generation),
  });
}

function assertGeneration(plan: F003VoiceDiffPlan, result: F003VoiceDiffResult): void {
  assertPlan(plan);
  if (result.schemaVersion !== '3' || result.planDigest !== plan.planDigest ||
    result.basePlanDigest !== plan.basePlanDigest ||
    result.generation.planDigest !== plan.basePlanDigest ||
    result.generationDigest !== generationDigest(plan, result.generation)) {
    voiceError('VOICE_TUPLE_MISMATCH', 'F003 generation tupleが一致しません');
  }
}

function completenessDigest(
  plan: F003VoiceDiffPlan,
  result: F003VoiceDiffResult,
  base: VoiceCompletenessReport,
): string {
  return hash(canonicalJson({
    schemaVersion: '3',
    planDigest: plan.planDigest,
    generationDigest: result.generationDigest,
    reconciliationDigest: plan.manifest.reconciliationDigest,
    baseCompletenessDigest: base.completenessDigest,
  }));
}

/**
 * approved review・generation・accepted sourceを全件逆joinする。
 * @des DES-F003-007 @fun FUN-F003-018 @ut UT-F003-018
 */
export async function verifyVoiceCompleteness(
  plan: F003VoiceDiffPlan,
  review: F003VoiceReview,
  voiceResult: F003VoiceDiffResult,
  acceptedSources: readonly F003AcceptedAudioSource[],
): Promise<F003VoiceCompletenessReport> {
  assertGeneration(plan, voiceResult);
  if (review.batchId !== plan.manifest.batchId || review.workId !== plan.manifest.workId ||
    review.reconciliationDigest !== plan.manifest.reconciliationDigest ||
    review.pendingCandidateIds.length !== 0 ||
    !sameStringSet(review.approved.map((item) => item.candidateId), plan.manifest.approvedCandidateIds) ||
    new Set(review.approved.map((item) => item.candidateId)).size !== review.approved.length) {
    voiceError('VOICE_APPROVED_MISSING', 'review完結性またはF003 tupleが一致しません');
  }
  const approved = new Map(review.approved.map((item) => [item.candidateId, item]));
  const safe = new Map(plan.items.map((item) => [item.candidateId, item]));
  const assets = new Map(voiceResult.generation.assets.map((asset) => [asset.audioId, asset]));
  const sourceByCandidate = new Map<string, F003AcceptedAudioSource>();
  for (const source of acceptedSources) {
    if (sourceByCandidate.has(source.candidateId) || review.rejectedCandidateIds.includes(source.candidateId)) {
      voiceError('VOICE_ASSET_ORPHAN', '未承認または重複ownerのaccepted sourceです');
    }
    const candidate = approved.get(source.candidateId);
    const safety = safe.get(source.candidateId);
    const asset = assets.get(source.audioId);
    if (!candidate || !safety || !asset || !asset.candidateIds.includes(source.candidateId) ||
      source.speechSha256 !== candidate.speechSha256 || source.speechSha256 !== safety.speechSha256 ||
      source.configHash !== candidate.configHash || source.configHash !== plan.configHash ||
      source.assetSha256 !== asset.sha256 || source.bytes !== asset.bytes ||
      source.durationMs !== asset.durationMs || source.sourcePath !== asset.sourcePath) {
      voiceError('VOICE_ASSET_CORRUPT', 'accepted sourceとreview/generation実体が一致しません');
    }
    sourceByCandidate.set(source.candidateId, source);
  }
  if (sourceByCandidate.size !== approved.size) voiceError('VOICE_APPROVED_MISSING', 'approved候補の音声が不足しています');
  for (const asset of voiceResult.generation.assets) {
    const owners = asset.candidateIds.map((id) => sourceByCandidate.get(id));
    if (owners.some((owner) => !owner) || owners.length === 0 ||
      new Set(owners.map((owner) => owner!.speechSha256)).size !== 1 ||
      new Set(owners.map((owner) => owner!.configHash)).size !== 1) {
      voiceError('VOICE_ASSET_SHARED_INPUT_MISMATCH', '共有audioのspeech/configが一致しません');
    }
  }
  const candidateAudio = Object.freeze(Object.fromEntries(
    acceptedSources.map((source) => [source.candidateId, source.audioId]),
  ));
  const base = await verifyVoiceCompletenessV2(
    {
      batchId: review.batchId,
      workId: review.workId,
      approved: review.approved.map((candidate) => ({ candidate: { candidateId: candidate.candidateId } })),
      pending: review.pendingCandidateIds,
    },
    voiceResult.generation,
    { assets: voiceResult.generation.assets, candidateAudio },
    { allowedRoots: [voiceResult.generation.stagingRoot, plan.basePlan.cacheRoot] },
  );
  return Object.freeze({
    schemaVersion: '3',
    result: 'pass',
    planDigest: plan.planDigest,
    generationDigest: voiceResult.generationDigest,
    reconciliationDigest: plan.manifest.reconciliationDigest,
    base,
    completenessDigest: completenessDigest(plan, voiceResult, base),
  });
}

function assertCompleteness(
  plan: F003VoiceDiffPlan,
  generation: F003VoiceDiffResult,
  completeness: F003VoiceCompletenessReport,
): void {
  if (completeness.result !== 'pass' || completeness.planDigest !== plan.planDigest ||
    completeness.generationDigest !== generation.generationDigest ||
    completeness.reconciliationDigest !== plan.manifest.reconciliationDigest ||
    completeness.completenessDigest !== completenessDigest(plan, generation, completeness.base)) {
    voiceError('VOICE_TUPLE_MISMATCH', 'F003 completeness tupleが一致しません');
  }
}

export const defaultF003GitAdapter: F003GitAdapter = Object.freeze({
  measure: measureGitRepository,
});

/**
 * 実WAV/dist/Git/free bytesをF002 actual capacityへ再計測させ、F003 candidate/commitへ結合する。
 * @des DES-F003-007 @fun FUN-F003-017 @ut UT-F003-017
 */
export async function measureActualCapacity(
  context: F003ActualCapacityContext,
  distPreview: CapacityDistPreview,
  voiceResult: F003CompletedVoiceResult,
  gitAdapter: F003GitAdapter = defaultF003GitAdapter,
): Promise<F003ActualCapacityReport> {
  const { plan, generation, completeness } = voiceResult;
  assertGeneration(plan, generation);
  assertCompleteness(plan, generation, completeness);
  if (context.phase !== 'work-preview' || !SHA256.test(context.candidateDigest) ||
    !COMMIT.test(context.candidateCommit) ||
    distPreview.batchId !== plan.manifest.batchId || distPreview.workId !== plan.manifest.workId) {
    voiceError('CAPACITY_ACTUAL_TUPLE_INVALID', 'F003 actual capacity contextが不正です');
  }
  let objects: readonly GitObjectMeasurement[];
  try {
    objects = await gitAdapter.measure(context.repositoryRoot, context.repositoryCandidateFiles);
  } catch (error) {
    throw new F003VoiceError('CAPACITY_GIT_SCAN_FAILED', 'Git objectを再計測できません', { cause: error });
  }
  const base = await verifyActualCapacity({
    phase: 'work-preview',
    batchId: plan.manifest.batchId,
    workId: plan.manifest.workId,
    workspaceRoot: context.workspaceRoot,
    repositoryRoot: context.repositoryRoot,
    expectedManifestSha: plan.manifest.expectedManifestSha,
    preTreeDigest: plan.manifest.preTreeDigest,
    contentStagingSha256: context.contentStagingSha256,
    voiceConfigHash: plan.configHash,
    planDigest: plan.basePlanDigest,
    authorizationDigest: generation.generation.authorizationDigest,
    generation: generation.generation,
    completeness: completeness.base,
    additionalAudioFiles: context.additionalAudioFiles,
    repositoryCandidateFiles: context.repositoryCandidateFiles,
    repositoryNonObjectBytes: context.repositoryNonObjectBytes,
    gitObjects: objects,
    disk: context.disk,
  }, distPreview);
  const partial = {
    schemaVersion: '3' as const,
    phase: 'work-preview' as const,
    result: base.result,
    planDigest: plan.planDigest,
    candidateDigest: context.candidateDigest,
    candidateCommit: context.candidateCommit,
    distSha256: distPreview.distSha256,
    base,
  };
  return Object.freeze({ ...partial, capacityDigest: hash(canonicalJson(partial)) });
}
