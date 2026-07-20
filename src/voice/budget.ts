import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

import { canonicalVoiceConfig, createVoiceCacheKey, voiceConfigHash } from './cache.ts';
import {
  MAX_SINGLE_ASSET_BYTES,
  VOICE_HARD_LIMIT_BYTES,
  VOICE_WARNING_BYTES,
  type SpeechItem,
  type VoiceConfig,
} from './types.ts';
import {
  assertVoiceAcceptanceTuple,
  type VoiceDiffGenerationResult,
  type VoiceDiffPlan,
  type VoiceCompletenessReport,
} from './generation.ts';
import type { PagesDistPreview } from '../content/pages-preview.ts';
import type { BatchId, Sha256, WorkId } from '../content/batch.ts';

const SHA256 = /^[a-f\d]{64}$/i;
const GIT_OID = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
const execFileAsync = promisify(execFile);

export const ADDED_AUDIO_MAX_BYTES = 104_857_600;
export const PAGES_WARN_BYTES = 524_288_000;
export const PAGES_SAFETY_STOP_BYTES = 786_432_000;
export const DECIMAL_GB_BYTES = 1_000_000_000;
export const REPOSITORY_WARN_BYTES = 750_000_000;
export const MAX_GIT_OBJECT_BYTES = 104_857_600;
export const MIN_CAPACITY_RESERVE_BYTES = 67_108_864;

export interface ManifestAsset {
  path: string;
  bytes?: number;
  size?: number;
  sha256: string;
  mediaType?: string;
  audioId?: string;
}

export interface AssetReference {
  path?: string;
  audioId?: string;
}

export interface AssetManifest {
  assets: ManifestAsset[];
  references?: AssetReference[];
  candidateAudio?: Readonly<Record<string, string>>;
}

export interface BudgetIssue {
  code: string;
  path?: string;
  detail?: string;
}

export interface BudgetReport {
  ok: boolean;
  status: 'ok' | 'warning' | 'fail';
  warning: boolean;
  hardFail: boolean;
  totalBytes: number;
  mediaBytes: Readonly<Record<string, number>>;
  duplicates: ReadonlyArray<{ sha256: string; paths: string[] }>;
  largestAsset: { path: string; bytes: number } | null;
  issues: BudgetIssue[];
}

function assetBytes(asset: ManifestAsset): number {
  const value = asset.bytes ?? asset.size;
  return value ?? Number.NaN;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function relativeAssetPath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.includes('\\') &&
    !value.startsWith('//') &&
    !value.split('/').some((segment) => segment === '..' || segment === '.') &&
    !/^[a-z][a-z\d+.-]*:/i.test(value) &&
    !/[?#]|%2e|%2f|%5c/iu.test(value) &&
    !hasControlCharacter(value)
  );
}

function mediaBucket(asset: ManifestAsset): string {
  if (asset.mediaType?.trim()) return asset.mediaType.split(';', 1)[0]!.toLowerCase();
  const extension = path.posix.extname(asset.path).slice(1).toLowerCase();
  return extension || 'other';
}

/** @des DES-F001-008,DES-F001-014 @fun FUN-F001-018 */
export function verifyAssetBudget(manifest: AssetManifest): BudgetReport {
  const issues: BudgetIssue[] = [];
  const pathSet = new Set<string>();
  const hashPaths = new Map<string, string[]>();
  const audioIds = new Set<string>();
  const mediaBytes: Record<string, number> = {};
  let totalBytes = 0;
  let largestAsset: BudgetReport['largestAsset'] = null;

  for (const asset of manifest.assets) {
    const bytes = assetBytes(asset);
    if (!relativeAssetPath(asset.path)) issues.push({ code: 'asset-path-invalid', path: asset.path });
    if (pathSet.has(asset.path)) issues.push({ code: 'asset-path-duplicate', path: asset.path });
    pathSet.add(asset.path);
    if (!SHA256.test(asset.sha256)) issues.push({ code: 'asset-hash-invalid', path: asset.path });
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      issues.push({ code: 'asset-size-invalid', path: asset.path });
      continue;
    }
    if (bytes >= MAX_SINGLE_ASSET_BYTES) issues.push({ code: 'single-asset-limit', path: asset.path });
    totalBytes += bytes;
    const bucket = mediaBucket(asset);
    mediaBytes[bucket] = (mediaBytes[bucket] ?? 0) + bytes;
    if (!largestAsset || bytes > largestAsset.bytes) largestAsset = { path: asset.path, bytes };

    const normalizedHash = asset.sha256.toLowerCase();
    const paths = hashPaths.get(normalizedHash) ?? [];
    paths.push(asset.path);
    hashPaths.set(normalizedHash, paths);
    if (asset.audioId) {
      if (audioIds.has(asset.audioId)) issues.push({ code: 'audio-id-duplicate', path: asset.path, detail: asset.audioId });
      audioIds.add(asset.audioId);
    }
  }

  const duplicates = Array.from(hashPaths, ([sha256, paths]) => ({ sha256, paths }))
    .filter((entry) => entry.paths.length > 1 && new Set(entry.paths).size > 1);
  for (const duplicate of duplicates) {
    issues.push({ code: 'duplicate-content-path', detail: duplicate.paths.join(',') });
  }

  for (const reference of manifest.references ?? []) {
    if (!reference.path && !reference.audioId) {
      issues.push({ code: 'asset-reference-invalid' });
      continue;
    }
    if (reference.path && !pathSet.has(reference.path)) {
      issues.push({ code: 'asset-reference-missing', path: reference.path });
    }
    if (reference.audioId && !audioIds.has(reference.audioId)) {
      issues.push({ code: 'audio-reference-missing', detail: reference.audioId });
    }
  }
  for (const audioId of Object.values(manifest.candidateAudio ?? {})) {
    if (!audioIds.has(audioId)) issues.push({ code: 'audio-reference-missing', detail: audioId });
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes >= VOICE_HARD_LIMIT_BYTES) {
    issues.push({ code: 'total-asset-limit' });
  }

  const hardFail = issues.length > 0;
  const warning = !hardFail && totalBytes >= VOICE_WARNING_BYTES;
  return {
    ok: !hardFail,
    status: hardFail ? 'fail' : warning ? 'warning' : 'ok',
    warning,
    hardFail,
    totalBytes,
    mediaBytes,
    duplicates,
    largestAsset,
    issues,
  };
}

export interface VoiceEstimateProfile {
  secondsPerCharacter: number;
  samplingRate?: number;
  outputSamplingRate?: number;
  bitDepth: number;
  channels: number;
  wavHeaderBytes?: number;
  safetyFactor?: number;
  observedRelativeError?: number;
  maxRelativeError?: number;
  observedEstimatedBytes?: number;
  observedActualBytes?: number;
  config?: VoiceConfig;
}

export interface VoicePreflight {
  status: 'ok' | 'warning' | 'blocked' | 'profile-update-required';
  canGenerate: boolean;
  warning: boolean;
  candidateCount: number;
  uniqueAudioCount: number;
  totalCharacters: number;
  estimatedSeconds: number;
  estimatedBytes: number;
  warningThresholdBytes: number;
  hardLimitBytes: number;
  profileUpdateRequired: boolean;
  reasonCodes: string[];
  configHash: string | null;
  inputDigest: string | null;
}

function preflightFailure(items: SpeechItem[], code: string): VoicePreflight {
  return {
    status: 'profile-update-required',
    canGenerate: false,
    warning: false,
    candidateCount: items.length,
    uniqueAudioCount: 0,
    totalCharacters: 0,
    estimatedSeconds: 0,
    estimatedBytes: 0,
    warningThresholdBytes: VOICE_WARNING_BYTES,
    hardLimitBytes: VOICE_HARD_LIMIT_BYTES,
    profileUpdateRequired: true,
    reasonCodes: [code],
    configHash: null,
    inputDigest: null,
  };
}

function speechText(item: SpeechItem): string {
  return item.speechText ?? item.text ?? '';
}

/** @des DES-F001-008,DES-F001-014 @fun FUN-F001-039 */
export function voiceInputDigest(items: SpeechItem[], config: VoiceConfig): string {
  const records = items.map((item) => ({
    candidateId: item.candidateId,
    audioId: createVoiceCacheKey(speechText(item), config),
    approved: item.approved !== false,
  }));
  return createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex');
}

/** @des DES-F001-008,DES-F001-014 @fun FUN-F001-039 */
export function estimateVoiceBudget(items: SpeechItem[], profile: VoiceEstimateProfile): VoicePreflight {
  const samplingRate = profile.outputSamplingRate ?? profile.samplingRate ?? Number.NaN;
  const wavHeaderBytes = profile.wavHeaderBytes ?? 44;
  const safetyFactor = profile.safetyFactor ?? 1;
  if (
    !Number.isFinite(profile.secondsPerCharacter) ||
    profile.secondsPerCharacter < 0 ||
    !Number.isSafeInteger(samplingRate) ||
    samplingRate <= 0 ||
    !Number.isSafeInteger(profile.bitDepth) ||
    profile.bitDepth <= 0 ||
    profile.bitDepth % 8 !== 0 ||
    !Number.isSafeInteger(profile.channels) ||
    profile.channels <= 0 ||
    !Number.isSafeInteger(wavHeaderBytes) ||
    wavHeaderBytes < 0 ||
    !Number.isFinite(safetyFactor) ||
    safetyFactor <= 0
  ) {
    return preflightFailure(items, 'voice-estimate-profile-invalid');
  }
  if (profile.config && samplingRate !== profile.config.outputSamplingRate) {
    return preflightFailure(items, 'voice-config-mismatch');
  }

  let observedError = profile.observedRelativeError;
  if (observedError === undefined && profile.observedEstimatedBytes !== undefined && profile.observedActualBytes !== undefined) {
    if (profile.observedEstimatedBytes <= 0 || profile.observedActualBytes < 0) {
      return preflightFailure(items, 'voice-estimate-profile-invalid');
    }
    observedError = Math.abs(profile.observedActualBytes - profile.observedEstimatedBytes) / profile.observedEstimatedBytes;
  }
  const maxError = profile.maxRelativeError ?? 0.2;
  if (!Number.isFinite(maxError) || maxError < 0 || (observedError !== undefined && (!Number.isFinite(observedError) || observedError < 0))) {
    return preflightFailure(items, 'voice-estimate-profile-invalid');
  }
  if (observedError !== undefined && observedError > maxError) {
    return preflightFailure(items, 'voice-estimate-profile-stale');
  }

  const unique = new Map<string, string>();
  const candidateIds = new Set<string>();
  const fixedConfig = profile.config;
  for (const item of items) {
    if (item.approved === false) return preflightFailure(items, 'voice-item-not-approved');
    if (!item.candidateId.trim() || candidateIds.has(item.candidateId)) {
      return preflightFailure(items, 'voice-item-invalid');
    }
    candidateIds.add(item.candidateId);
    const text = speechText(item);
    if (!text.trim() || text.includes('\0') || /[\uD800-\uDFFF]/u.test(text)) {
      return preflightFailure(items, 'voice-text-invalid');
    }
    try {
      if (fixedConfig && item.config && canonicalVoiceConfig(item.config) !== canonicalVoiceConfig(fixedConfig)) {
        return preflightFailure(items, 'voice-config-mismatch');
      }
      const config = item.config ?? fixedConfig;
      const key = config ? createVoiceCacheKey(text, config) : text.normalize('NFC');
      unique.set(key, text.normalize('NFC'));
    } catch {
      return preflightFailure(items, 'voice-text-invalid');
    }
  }

  const totalCharacters = Array.from(unique.values()).reduce((total, value) => total + Array.from(value).length, 0);
  const estimatedSeconds = totalCharacters * profile.secondsPerCharacter * safetyFactor;
  const pcmBytes = Math.ceil(estimatedSeconds * samplingRate * (profile.bitDepth / 8) * profile.channels);
  const estimatedBytes = pcmBytes + unique.size * wavHeaderBytes;
  if (!Number.isSafeInteger(pcmBytes) || !Number.isSafeInteger(estimatedBytes)) {
    return preflightFailure(items, 'voice-estimate-profile-invalid');
  }
  const blocked = estimatedBytes >= VOICE_HARD_LIMIT_BYTES;
  const warning = !blocked && estimatedBytes >= VOICE_WARNING_BYTES;
  return {
    status: blocked ? 'blocked' : warning ? 'warning' : 'ok',
    canGenerate: !blocked,
    warning,
    candidateCount: items.length,
    uniqueAudioCount: unique.size,
    totalCharacters,
    estimatedSeconds,
    estimatedBytes,
    warningThresholdBytes: VOICE_WARNING_BYTES,
    hardLimitBytes: VOICE_HARD_LIMIT_BYTES,
    profileUpdateRequired: false,
    reasonCodes: blocked ? ['voice-budget-hard-limit'] : warning ? ['voice-budget-warning'] : [],
    configHash: fixedConfig ? voiceConfigHash(fixedConfig) : null,
    inputDigest: fixedConfig ? voiceInputDigest(items, fixedConfig) : null,
  };
}

export type CapacityResult = 'pass' | 'pass_with_warning' | 'blocked';
export type CapacitySectionStatus = 'pass' | 'warning' | 'blocked';

export interface CapacitySection {
  readonly measuredBytes: number;
  readonly thresholdBytes: number;
  readonly warningThresholdBytes?: number;
  readonly status: CapacitySectionStatus;
  readonly includedPaths: readonly string[];
  readonly deduplicatedHashes: readonly string[];
  readonly reasons: readonly string[];
}

export interface GitObjectMeasurement {
  readonly oid: string;
  /** repositoryで実際に占有するbytes。未object化blobはraw bytes。 */
  readonly storedBytes: number;
  /** 単一object停止判定に使う展開後bytes。 */
  readonly logicalBytes: number;
  readonly source: 'pack' | 'loose' | 'new';
  readonly objectized: boolean;
  readonly path?: string;
}

export interface CapacityPathClaim {
  readonly path: string;
  readonly boundary: 'workspace' | 'repository';
  readonly regularFile: boolean;
  readonly reparsePoint: boolean;
}

export interface CapacityDiskInput {
  readonly liveWriteUpperBounds: number;
  readonly rollbackBackupBytes: number;
  readonly freeBytes: number;
}

export interface CapacityForecastInput {
  readonly plan: Pick<VoiceDiffPlan, 'batchId' | 'workId' | 'expectedManifestSha' | 'preTreeDigest' | 'planDigest' | 'estimatedMissBytes'>;
  readonly expectedManifestSha: string;
  readonly preTreeDigest: string;
  readonly planDigest: string;
  readonly alreadyGeneratedUniqueAudioBytes: number;
  readonly currentPagesBytes: number;
  readonly plannedPagesBytes: number;
  readonly repositoryNonObjectBytes: number;
  readonly gitObjects: readonly GitObjectMeasurement[];
  readonly disk: CapacityDiskInput;
  readonly paths?: readonly CapacityPathClaim[];
}

export interface CapacityForecast {
  readonly evidenceKind: 'forecast';
  readonly actualCapacitySatisfied: false;
  readonly result: CapacityResult;
  readonly canGenerate: boolean;
  readonly batchId: string;
  readonly workId: string;
  readonly expectedManifestSha: string;
  readonly preTreeDigest: string;
  readonly planDigest: string;
  readonly remainingResponseBytes: number;
  readonly minimumFreeBytesAfterWrite: number;
  readonly additionalAudio: CapacitySection;
  readonly pagesArtifact: CapacitySection;
  readonly sourceRepository: CapacitySection;
  readonly singleGitObjects: CapacitySection;
  readonly workDrive: CapacitySection;
  readonly reasons: readonly string[];
}

export type CapacityDistPreview = PagesDistPreview;

interface ActualMeasurementInput {
  readonly workspaceRoot: string;
  readonly repositoryRoot: string;
  readonly additionalAudioFiles: readonly string[];
  readonly repositoryCandidateFiles: readonly string[];
  readonly repositoryNonObjectBytes?: number;
  readonly gitObjects?: readonly GitObjectMeasurement[];
  readonly disk: CapacityDiskInput;
}

export interface WorkActualCapacityInput extends ActualMeasurementInput {
  readonly phase: 'work-preview';
  readonly batchId: string;
  readonly workId: string;
  readonly expectedManifestSha: string;
  readonly preTreeDigest: string;
  readonly contentStagingSha256: string;
  readonly voiceConfigHash: string;
  readonly planDigest: string;
  readonly authorizationDigest: string;
  readonly generation: VoiceDiffGenerationResult;
  readonly completeness: VoiceCompletenessReport;
}

export interface ReleaseActualCapacityInput extends ActualMeasurementInput {
  readonly phase: 'release';
  readonly releaseCandidateBatchId: string;
  readonly feature: string;
  readonly releaseCommit: string;
  readonly artifactDigest: string;
  readonly contentBuildSha256: string;
  readonly contentStagingSha256: string;
}

export type ActualCapacityInput = WorkActualCapacityInput | ReleaseActualCapacityInput;

export interface ActualCapacityReport {
  readonly evidenceKind: 'actual';
  readonly phase: 'work-preview' | 'release';
  readonly result: CapacityResult;
  readonly batchId: BatchId;
  readonly workId: WorkId;
  readonly expectedManifestSha: Sha256;
  readonly preTreeDigest: Sha256;
  readonly contentBuildSha256: Sha256;
  readonly contentStagingSha256: Sha256;
  readonly distSha256: Sha256;
  readonly voiceConfigHash: Sha256;
  readonly planDigest: Sha256;
  readonly authorizationDigest: Sha256;
  readonly generationDigest: Sha256;
  readonly completenessDigest: Sha256;
  readonly releaseCandidateBatchId?: string;
  readonly feature?: string;
  readonly releaseCommit?: string;
  readonly artifactDigest?: string;
  readonly additionalAudio: CapacitySection;
  readonly pagesArtifact: CapacitySection;
  readonly sourceRepository: CapacitySection;
  readonly singleGitObjects: CapacitySection;
  readonly workDrive: CapacitySection;
  readonly reasons: readonly string[];
}

export interface ReleaseActualCapacityReport {
  readonly evidenceKind: 'actual';
  readonly phase: 'release';
  readonly result: CapacityResult;
  readonly releaseCandidateBatchId: string;
  readonly feature: string;
  readonly releaseCommit: string;
  readonly artifactDigest: string;
  readonly contentBuildSha256: Sha256;
  readonly contentStagingSha256: Sha256;
  readonly distSha256: Sha256;
  readonly additionalAudio: CapacitySection;
  readonly pagesArtifact: CapacitySection;
  readonly sourceRepository: CapacitySection;
  readonly singleGitObjects: CapacitySection;
  readonly workDrive: CapacitySection;
  readonly reasons: readonly string[];
}

export class CapacityError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CapacityError';
  }
}

function capacityError(code: string, message: string, cause?: unknown): CapacityError {
  return new CapacityError(code, message, cause === undefined ? undefined : { cause });
}

function safeBytes(value: number, code = 'CAPACITY_INTEGER_INVALID'): number {
  if (!Number.isSafeInteger(value) || value < 0) throw capacityError(code, '容量は非負のsafe integerである必要があります');
  return value;
}

function safeAdd(...values: readonly number[]): number {
  let result = 0;
  for (const value of values) {
    safeBytes(value);
    result += value;
    if (!Number.isSafeInteger(result)) throw capacityError('CAPACITY_INTEGER_OVERFLOW', '容量加算がsafe integerを超えました');
  }
  return result;
}

export function requiredFreeBytes(disk: Pick<CapacityDiskInput, 'liveWriteUpperBounds' | 'rollbackBackupBytes'>): number {
  const base = safeAdd(disk.liveWriteUpperBounds, disk.rollbackBackupBytes);
  const reserve = Math.max(MIN_CAPACITY_RESERVE_BYTES, Math.ceil(base / 10));
  return safeAdd(base, reserve);
}

function safeRelative(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    !value.includes('\\') && !value.startsWith('//') && !/[?#]/u.test(value) && !hasControlCharacter(value) &&
    !/^[a-z][a-z\d+.-]*:/iu.test(value) && !/%(?:2e|2f|5c)/iu.test(value) &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function assertPathClaims(claims: readonly CapacityPathClaim[]): string[] {
  const paths: string[] = [];
  for (const claim of claims) {
    if (!safeRelative(claim.path) || !claim.regularFile || claim.reparsePoint ||
      (claim.boundary !== 'workspace' && claim.boundary !== 'repository')) {
      throw capacityError('CAPACITY_PATH_UNSAFE', `容量対象pathが安全ではありません: ${claim.path}`);
    }
    paths.push(claim.path);
  }
  return paths.sort((a, b) => a.localeCompare(b, 'en'));
}

interface GitTotals {
  readonly repositoryObjectBytes: number;
  readonly largestObjectBytes: number;
  readonly paths: string[];
  readonly deduplicated: string[];
}

function gitTotals(entries: readonly GitObjectMeasurement[]): GitTotals {
  const byOid = new Map<string, GitObjectMeasurement>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    const oid = entry.oid.toLowerCase();
    if (!GIT_OID.test(oid)) throw capacityError('CAPACITY_GIT_OBJECT_INVALID', 'Git object IDが不正です');
    safeBytes(entry.storedBytes);
    safeBytes(entry.logicalBytes);
    if (!entry.objectized && entry.source !== 'new') throw capacityError('CAPACITY_GIT_OBJECT_INVALID', '未object化bytesはnew blobだけに許可されます');
    if (entry.path !== undefined && !safeRelative(entry.path)) {
      throw capacityError('CAPACITY_PATH_UNSAFE', 'Git object pathがrepository相対pathではありません');
    }
    const previous = byOid.get(oid);
    if (previous) {
      duplicates.add(oid);
      if (previous.logicalBytes !== entry.logicalBytes) {
        throw capacityError('CAPACITY_GIT_OBJECT_INVALID', '同一OIDのlogical bytesが一致しません');
      }
      if (previous.objectized && !entry.objectized) continue;
      if (!previous.objectized && entry.objectized) byOid.set(oid, entry);
      else if (entry.storedBytes > previous.storedBytes) byOid.set(oid, entry);
    } else byOid.set(oid, entry);
  }
  let repositoryObjectBytes = 0;
  let largestObjectBytes = 0;
  const paths: string[] = [];
  for (const entry of byOid.values()) {
    repositoryObjectBytes = safeAdd(repositoryObjectBytes, entry.storedBytes);
    largestObjectBytes = Math.max(largestObjectBytes, entry.logicalBytes);
    if (entry.path) paths.push(entry.path);
  }
  return {
    repositoryObjectBytes,
    largestObjectBytes,
    paths: paths.sort((a, b) => a.localeCompare(b, 'en')),
    deduplicated: Array.from(duplicates).sort((a, b) => a.localeCompare(b, 'en')),
  };
}

function audioSection(bytes: number, prefix: 'CAPACITY_FORECAST' | 'CAPACITY_ACTUAL', paths: readonly string[] = []): CapacitySection {
  const blocked = bytes > ADDED_AUDIO_MAX_BYTES;
  return {
    measuredBytes: bytes, thresholdBytes: ADDED_AUDIO_MAX_BYTES, status: blocked ? 'blocked' : 'pass',
    includedPaths: paths, deduplicatedHashes: [], reasons: blocked ? [`${prefix}_AUDIO_EXCEEDED`] : [],
  };
}

function pagesSection(bytes: number, prefix: 'CAPACITY_FORECAST' | 'CAPACITY_ACTUAL', paths: readonly string[] = []): CapacitySection {
  const blocked = bytes > PAGES_SAFETY_STOP_BYTES || bytes >= DECIMAL_GB_BYTES;
  const warning = !blocked && bytes >= PAGES_WARN_BYTES;
  return {
    measuredBytes: bytes, thresholdBytes: PAGES_SAFETY_STOP_BYTES, warningThresholdBytes: PAGES_WARN_BYTES,
    status: blocked ? 'blocked' : warning ? 'warning' : 'pass', includedPaths: paths, deduplicatedHashes: [],
    reasons: blocked ? [`${prefix}_PAGES_EXCEEDED`] : warning ? [`${prefix}_PAGES_WARNING`] : [],
  };
}

function repositorySection(bytes: number, git: GitTotals, prefix: 'CAPACITY_FORECAST' | 'CAPACITY_ACTUAL'): CapacitySection {
  const blocked = bytes >= DECIMAL_GB_BYTES;
  const warning = !blocked && bytes >= REPOSITORY_WARN_BYTES;
  return {
    measuredBytes: bytes, thresholdBytes: DECIMAL_GB_BYTES, warningThresholdBytes: REPOSITORY_WARN_BYTES,
    status: blocked ? 'blocked' : warning ? 'warning' : 'pass', includedPaths: git.paths,
    deduplicatedHashes: git.deduplicated,
    reasons: blocked ? [`${prefix}_REPOSITORY_EXCEEDED`] : warning ? [`${prefix}_REPOSITORY_WARNING`] : [],
  };
}

function objectSection(git: GitTotals, prefix: 'CAPACITY_FORECAST' | 'CAPACITY_ACTUAL'): CapacitySection {
  const blocked = git.largestObjectBytes >= MAX_GIT_OBJECT_BYTES;
  return {
    measuredBytes: git.largestObjectBytes, thresholdBytes: MAX_GIT_OBJECT_BYTES, status: blocked ? 'blocked' : 'pass',
    includedPaths: git.paths, deduplicatedHashes: git.deduplicated,
    reasons: blocked ? [`${prefix}_OBJECT_EXCEEDED`] : [],
  };
}

function diskSection(disk: CapacityDiskInput, prefix: 'CAPACITY_FORECAST' | 'CAPACITY_ACTUAL'): CapacitySection {
  safeBytes(disk.freeBytes);
  const required = requiredFreeBytes(disk);
  const blocked = disk.freeBytes < required;
  return {
    measuredBytes: disk.freeBytes, thresholdBytes: required, status: blocked ? 'blocked' : 'pass',
    includedPaths: [], deduplicatedHashes: [], reasons: blocked ? [`${prefix}_DISK_INSUFFICIENT`] : [],
  };
}

function combinedResult(sections: readonly CapacitySection[]): CapacityResult {
  if (sections.some((section) => section.status === 'blocked')) return 'blocked';
  if (sections.some((section) => section.status === 'warning')) return 'pass_with_warning';
  return 'pass';
}

function allReasons(sections: readonly CapacitySection[]): string[] {
  return sections.flatMap((section) => section.reasons);
}

/** @des DES-F002-005 DES-F002-011 DES-F002-015 @fun FUN-F002-032 */
export async function forecastCapacity(input: CapacityForecastInput): Promise<CapacityForecast> {
  const { plan } = input;
  if (!SHA256.test(input.expectedManifestSha) || !SHA256.test(input.preTreeDigest) || !SHA256.test(input.planDigest) ||
    plan.expectedManifestSha !== input.expectedManifestSha || plan.preTreeDigest !== input.preTreeDigest ||
    plan.planDigest !== input.planDigest) {
    throw capacityError('CAPACITY_FORECAST_STALE', 'capacity forecastのplan/manifest/tree tupleが一致しません');
  }
  const claimedPaths = assertPathClaims(input.paths ?? []);
  const additionalAudioBytes = safeAdd(input.alreadyGeneratedUniqueAudioBytes, plan.estimatedMissBytes);
  const pagesBytes = safeAdd(input.currentPagesBytes, input.plannedPagesBytes);
  const git = gitTotals(input.gitObjects);
  const repositoryBytes = safeAdd(input.repositoryNonObjectBytes, git.repositoryObjectBytes);
  const sections = [
    audioSection(additionalAudioBytes, 'CAPACITY_FORECAST', claimedPaths),
    pagesSection(pagesBytes, 'CAPACITY_FORECAST'),
    repositorySection(repositoryBytes, git, 'CAPACITY_FORECAST'),
    objectSection(git, 'CAPACITY_FORECAST'),
    diskSection(input.disk, 'CAPACITY_FORECAST'),
  ] as const;
  const result = combinedResult(sections);
  return Object.freeze({
    evidenceKind: 'forecast' as const, actualCapacitySatisfied: false as const, result, canGenerate: result !== 'blocked',
    batchId: plan.batchId, workId: plan.workId, expectedManifestSha: input.expectedManifestSha,
    preTreeDigest: input.preTreeDigest, planDigest: input.planDigest,
    remainingResponseBytes: Math.max(0, ADDED_AUDIO_MAX_BYTES - input.alreadyGeneratedUniqueAudioBytes),
    minimumFreeBytesAfterWrite: sections[4].thresholdBytes,
    additionalAudio: sections[0], pagesArtifact: sections[1], sourceRepository: sections[2],
    singleGitObjects: sections[3], workDrive: sections[4], reasons: allReasons(sections),
  });
}

function inside(root: string, target: string): boolean {
  const relation = path.relative(root, target);
  return relation === '' || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation));
}

async function safeRoot(root: string, boundary?: string): Promise<string> {
  if (!path.isAbsolute(root)) throw capacityError('CAPACITY_PATH_UNSAFE', '容量rootは絶対pathである必要があります');
  const resolved = path.resolve(root);
  let actual: string;
  try { actual = await realpath(resolved); } catch (error) {
    throw capacityError('CAPACITY_PATH_UNSAFE', '容量rootを解決できません', error);
  }
  const stats = await lstat(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw capacityError('CAPACITY_PATH_UNSAFE', '容量rootが通常directoryではありません');
  if (actual !== resolved || (boundary && !inside(boundary, actual))) {
    throw capacityError('CAPACITY_PATH_UNSAFE', '容量rootが境界外またはreparseです');
  }
  return actual;
}

async function safeFile(root: string, target: string): Promise<{ bytes: number; sha256: string; relativePath: string }> {
  const resolved = path.resolve(target);
  if (!inside(root, resolved) || resolved === root) throw capacityError('CAPACITY_PATH_UNSAFE', '容量対象fileがroot外です');
  const relation = path.relative(root, resolved);
  let current = root;
  for (const segment of relation.split(path.sep)) {
    current = path.join(current, segment);
    const stats = await lstat(current).catch((error: unknown) => {
      throw capacityError('CAPACITY_PATH_UNSAFE', '容量対象fileを検査できません', error);
    });
    if (stats.isSymbolicLink()) throw capacityError('CAPACITY_PATH_UNSAFE', 'reparse/symlinkは容量対象にできません');
  }
  const stats = await lstat(resolved);
  if (!stats.isFile() || !Number.isSafeInteger(stats.size)) throw capacityError('CAPACITY_PATH_UNSAFE', 'regular file以外は容量対象にできません');
  const actual = await realpath(resolved);
  if (actual !== resolved || !inside(root, actual)) throw capacityError('CAPACITY_PATH_UNSAFE', '容量対象file実体が境界外です');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(actual)) {
    const data = chunk as Buffer;
    bytes = safeAdd(bytes, data.byteLength);
    digest.update(data);
  }
  const after = await lstat(actual);
  if (bytes !== stats.size || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || after.ino !== stats.ino) {
    throw capacityError('CAPACITY_FILE_CHANGED', '容量計測中にfileが変化しました');
  }
  return {
    bytes,
    sha256: digest.digest('hex'),
    relativePath: relation.split(path.sep).join('/'),
  };
}

async function walkRegularFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw capacityError('CAPACITY_PATH_UNSAFE', 'dist内reparse/symlinkを拒否しました');
    if (entry.isDirectory()) result.push(...await walkRegularFiles(root, target));
    else if (entry.isFile()) result.push(path.relative(root, target).split(path.sep).join('/'));
    else throw capacityError('CAPACITY_PATH_UNSAFE', 'dist内regular file以外を拒否しました');
  }
  return result.sort((a, b) => a.localeCompare(b, 'en'));
}

async function verifyDistPreview(workspace: string, pages: CapacityDistPreview): Promise<{ bytes: number; paths: string[] }> {
  if (!SHA256.test(pages.contentBuildSha256) || !SHA256.test(pages.distSha256) ||
    Object.values(pages.inputHashes).some((value) => !SHA256.test(value))) {
    throw capacityError('CAPACITY_ACTUAL_DIST_INCOMPLETE', '完全DistPreviewではありません');
  }
  const root = await safeRoot(pages.outputRoot, workspace);
  const actualPaths = await walkRegularFiles(root);
  const expectedPaths = pages.files.map((file) => file.path).sort((a, b) => a.localeCompare(b, 'en'));
  if (new Set(expectedPaths).size !== expectedPaths.length || JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw capacityError('CAPACITY_ACTUAL_DIST_INCOMPLETE', 'DistPreviewのfile一覧が完全treeと一致しません');
  }
  let bytes = 0;
  for (const expected of pages.files) {
    if (!safeRelative(expected.path) || !SHA256.test(expected.sha256)) {
      throw capacityError('CAPACITY_PATH_UNSAFE', 'DistPreview path/hashが不正です');
    }
    safeBytes(expected.bytes);
    const measured = await safeFile(root, path.join(root, ...expected.path.split('/')));
    if (measured.bytes !== expected.bytes || measured.sha256 !== expected.sha256.toLowerCase()) {
      throw capacityError('CAPACITY_ACTUAL_DIST_STALE', `DistPreview実体が変化しました: ${expected.path}`);
    }
    bytes = safeAdd(bytes, measured.bytes);
  }
  return { bytes, paths: actualPaths };
}

function parseGitObjects(stdout: string): GitObjectMeasurement[] {
  return stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
    const [oid, logical, stored] = line.trim().split(/\s+/u);
    const logicalBytes = Number(logical);
    const storedBytes = Number(stored);
    if (!oid || !GIT_OID.test(oid) || !Number.isSafeInteger(logicalBytes) || !Number.isSafeInteger(storedBytes)) {
      throw capacityError('CAPACITY_GIT_OBJECT_INVALID', 'git cat-file出力が不正です');
    }
    return { oid: oid.toLowerCase(), logicalBytes, storedBytes, source: 'pack', objectized: true };
  });
}

export async function measureGitRepository(repositoryRoot: string, candidateFiles: readonly string[]): Promise<GitObjectMeasurement[]> {
  const root = await safeRoot(repositoryRoot);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', [
      '-C', root, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objectsize) %(objectsize:disk)',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    throw capacityError('CAPACITY_GIT_SCAN_FAILED', 'Git objectを列挙できません', error);
  }
  const objects = parseGitObjects(stdout);
  for (const candidate of candidateFiles) {
    const measured = await safeFile(root, candidate);
    let oid: string;
    try {
      ({ stdout: oid } = await execFileAsync('git', ['-C', root, 'hash-object', candidate], { encoding: 'utf8' }));
    } catch (error) {
      throw capacityError('CAPACITY_GIT_SCAN_FAILED', '候補blobのOIDを計算できません', error);
    }
    objects.push({
      oid: oid.trim().toLowerCase(), storedBytes: measured.bytes, logicalBytes: measured.bytes,
      source: 'new', objectized: false, path: measured.relativePath,
    });
  }
  return objects;
}

function assertActualTuple(input: ActualCapacityInput, pages: CapacityDistPreview): void {
  if (input.phase === 'release') {
    if (pages.batchId !== undefined || pages.workId !== undefined || !/^F\d{3}$/u.test(input.releaseCandidateBatchId) ||
      input.feature !== input.releaseCandidateBatchId || !/^[a-f\d]{40}$/u.test(input.releaseCommit) ||
      !SHA256.test(input.artifactDigest) || !SHA256.test(input.contentBuildSha256) ||
      !SHA256.test(input.contentStagingSha256) || input.contentBuildSha256 !== pages.contentBuildSha256) {
      throw capacityError('CAPACITY_ACTUAL_STALE', 'release candidate tupleが不正です');
    }
    return;
  }
  const { generation, completeness } = input;
  const hashes = [input.expectedManifestSha, input.preTreeDigest, input.contentStagingSha256, input.voiceConfigHash, input.planDigest,
    input.authorizationDigest, generation.generationDigest, completeness.completenessDigest];
  if (hashes.some((value) => !SHA256.test(value))) throw capacityError('CAPACITY_ACTUAL_TUPLE_INVALID', 'actual tuple hashが不正です');
  try { assertVoiceAcceptanceTuple(generation, completeness); } catch (error) {
    throw capacityError('CAPACITY_ACTUAL_STALE', 'generation/completeness digestが一致しません', error);
  }
  const common = generation.batchId === completeness.batchId && generation.workId === completeness.workId &&
    generation.expectedManifestSha === input.expectedManifestSha && completeness.expectedManifestSha === input.expectedManifestSha &&
    generation.preTreeDigest === input.preTreeDigest && completeness.preTreeDigest === input.preTreeDigest &&
    generation.planDigest === input.planDigest && completeness.planDigest === input.planDigest &&
    generation.authorizationDigest === input.authorizationDigest && completeness.authorizationDigest === input.authorizationDigest &&
    generation.generationDigest === completeness.generationDigest && generation.configHash === input.voiceConfigHash;
  if (!common) throw capacityError('CAPACITY_ACTUAL_STALE', 'generation/completeness tupleが一致しません');
  if (input.batchId !== generation.batchId || input.workId !== generation.workId ||
    pages.batchId !== input.batchId || pages.workId !== input.workId) {
    throw capacityError('CAPACITY_ACTUAL_STALE', 'work-preview tupleが一致しません');
  }
}

/** @des DES-F002-011 DES-F002-015 @fun FUN-F002-017 */
export async function verifyActualCapacity(
  input: WorkActualCapacityInput,
  pages: CapacityDistPreview,
): Promise<ActualCapacityReport>;
export async function verifyActualCapacity(
  input: ReleaseActualCapacityInput,
  pages: CapacityDistPreview,
): Promise<ReleaseActualCapacityReport>;
export async function verifyActualCapacity(
  input: ActualCapacityInput,
  pages: CapacityDistPreview,
): Promise<ActualCapacityReport | ReleaseActualCapacityReport>;
export async function verifyActualCapacity(
  input: ActualCapacityInput,
  pages: CapacityDistPreview,
): Promise<ActualCapacityReport | ReleaseActualCapacityReport> {
  assertActualTuple(input, pages);
  const workspace = await safeRoot(input.workspaceRoot);
  const repository = await safeRoot(input.repositoryRoot, workspace);
  const audioMeasurements = await Promise.all(input.additionalAudioFiles.map((file) => safeFile(workspace, file)));
  const audioHashes = new Set<string>();
  const duplicateAudioHashes = new Set<string>();
  let audioBytes = 0;
  for (const measured of audioMeasurements) {
    if (audioHashes.has(measured.sha256)) {
      duplicateAudioHashes.add(measured.sha256);
      continue;
    }
    audioHashes.add(measured.sha256);
    audioBytes = safeAdd(audioBytes, measured.bytes);
  }
  const measuredPages = await verifyDistPreview(workspace, pages);
  const objects = input.gitObjects ?? await measureGitRepository(repository, input.repositoryCandidateFiles);
  const git = gitTotals(objects);
  const repositoryBytes = safeAdd(input.repositoryNonObjectBytes ?? 0, git.repositoryObjectBytes);
  const prefix = 'CAPACITY_ACTUAL' as const;
  const sections = [
    { ...audioSection(audioBytes, prefix, audioMeasurements.map((entry) => entry.relativePath)),
      deduplicatedHashes: Array.from(duplicateAudioHashes).sort((a, b) => a.localeCompare(b, 'en')) },
    pagesSection(measuredPages.bytes, prefix, measuredPages.paths),
    repositorySection(repositoryBytes, git, prefix),
    objectSection(git, prefix),
    diskSection(input.disk, prefix),
  ] as const;
  const result = combinedResult(sections);
  if (input.phase === 'release') {
    return Object.freeze({
      evidenceKind: 'actual' as const, phase: 'release' as const, result,
      releaseCandidateBatchId: input.releaseCandidateBatchId, feature: input.feature,
      releaseCommit: input.releaseCommit, artifactDigest: input.artifactDigest,
      contentBuildSha256: input.contentBuildSha256 as Sha256,
      contentStagingSha256: input.contentStagingSha256 as Sha256,
      distSha256: pages.distSha256,
      additionalAudio: sections[0], pagesArtifact: sections[1], sourceRepository: sections[2],
      singleGitObjects: sections[3], workDrive: sections[4], reasons: allReasons(sections),
    });
  }
  const generation = input.generation;
  const report: ActualCapacityReport = {
    evidenceKind: 'actual', phase: input.phase, result,
    batchId: generation.batchId as BatchId, workId: generation.workId as WorkId,
    expectedManifestSha: input.expectedManifestSha as Sha256,
    preTreeDigest: input.preTreeDigest as Sha256, contentBuildSha256: pages.contentBuildSha256,
    contentStagingSha256: input.contentStagingSha256 as Sha256, distSha256: pages.distSha256,
    voiceConfigHash: input.voiceConfigHash as Sha256, planDigest: input.planDigest as Sha256,
    authorizationDigest: input.authorizationDigest as Sha256, generationDigest: generation.generationDigest as Sha256,
    completenessDigest: input.completeness.completenessDigest as Sha256,
    additionalAudio: sections[0], pagesArtifact: sections[1], sourceRepository: sections[2],
    singleGitObjects: sections[3], workDrive: sections[4], reasons: allReasons(sections),
  };
  return Object.freeze(report);
}
