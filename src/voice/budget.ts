import path from 'node:path';
import { createHash } from 'node:crypto';

import { canonicalVoiceConfig, createVoiceCacheKey, voiceConfigHash } from './cache.ts';
import {
  MAX_SINGLE_ASSET_BYTES,
  VOICE_HARD_LIMIT_BYTES,
  VOICE_WARNING_BYTES,
  type SpeechItem,
  type VoiceConfig,
} from './types.ts';

const SHA256 = /^[a-f\d]{64}$/i;

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
