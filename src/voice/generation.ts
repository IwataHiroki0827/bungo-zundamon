import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalVoiceConfig,
  canonicalVoiceConfigV2,
  createVoiceCacheKey,
  createVoiceCacheKeyV2,
  NodeVoiceFileSystem,
  voiceConfigHash,
  voiceConfigHashV2,
  type VoiceConfigV2,
  type VoiceFileSystem,
} from './cache.ts';
import { ProductionVoicevoxClient } from './client.ts';
import {
  VoiceContractError,
  VoiceStageError,
  VOICE_HARD_LIMIT_BYTES,
  VOICE_WARNING_BYTES,
  type AudioAsset,
  type SpeechItem,
  type VoiceGenerationResult,
  type VoiceConfig,
  type VoiceFailure,
  type VoicevoxClient,
  type VoicevoxSpeaker,
} from './types.ts';
import { voiceInputDigest, type VoicePreflight } from './budget.ts';

interface WavInfo {
  durationMs: number;
}

export interface GenerateVoiceOptions {
  fileSystem?: VoiceFileSystem;
  workspaceRoot?: string;
  publicPathPrefix?: string;
  preflight: VoicePreflight;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

export function inspectWav(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength === 0) throw new VoiceContractError('voice-zero-byte', 'WAVが0 byteです');
  if (bytes.byteLength < 44 || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new VoiceContractError('voice-not-wav', 'RIFF/WAVE headerがありません');
  }
  const declaredSize = uint32(bytes, 4) + 8;
  if (declaredSize !== bytes.byteLength) throw new VoiceContractError('voice-not-wav', 'RIFF sizeと実byte数が一致しません');

  let offset = 12;
  let byteRate = 0;
  let dataBytes = -1;
  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, 4);
    const size = uint32(bytes, offset + 4);
    const payload = offset + 8;
    if (payload + size > bytes.byteLength) throw new VoiceContractError('voice-not-wav', 'WAV chunkがfile境界を超えています');
    if (id === 'fmt ') {
      if (size < 16 || uint16(bytes, payload) !== 1) {
        throw new VoiceContractError('voice-not-wav', 'PCM WAVではありません');
      }
      byteRate = uint32(bytes, payload + 8);
      if (byteRate <= 0) throw new VoiceContractError('voice-not-wav', 'WAV byte rateが不正です');
    } else if (id === 'data') {
      dataBytes = size;
    }
    offset = payload + size + (size % 2);
  }
  if (byteRate <= 0 || dataBytes <= 0) throw new VoiceContractError('voice-not-wav', 'WAVのfmt/data chunkが不正です');
  return { durationMs: Math.max(1, Math.round((dataBytes / byteRate) * 1_000)) };
}

function validatePublicPrefix(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((segment) => segment === '..' || segment === '.') ||
    /^[a-z][\w+.-]*:/i.test(normalized) ||
    /[?#]|%2e|%2f|%5c/iu.test(normalized) ||
    hasControlCharacter(normalized)
  ) {
    throw new VoiceStageError('voice-public-path-invalid', '公開音声path prefixは安全な相対pathが必要です');
  }
  return normalized;
}

const STAGE_FATAL_CLIENT_CODES = new Set([
  'voice-redirect-forbidden',
  'voice-remote-not-loopback',
  'voice-endpoint-not-allowed',
  'voice-proxy-forbidden',
]);

function isStageFatalClientError(error: unknown): error is VoiceContractError {
  return error instanceof VoiceContractError && STAGE_FATAL_CLIENT_CODES.has(error.code);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function itemText(item: SpeechItem): string {
  return item.speechText ?? item.text ?? '';
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function failureReason(error: unknown): string {
  if (error instanceof VoiceContractError) {
    if (error.code === 'voice-timeout') return 'VOICE_TIMEOUT';
    if (error.code === 'voice-not-wav') return 'VOICE_WAV_INVALID';
    if (error.code === 'voice-zero-byte') return 'VOICE_ZERO_BYTE';
    if (error.code === 'voice-http-error') return 'VOICE_HTTP_ERROR';
    return 'VOICE_GENERATION_FAILED';
  }
  if (error instanceof Error && /timeout|timed out/i.test(error.message)) return 'VOICE_TIMEOUT';
  return 'VOICE_GENERATION_FAILED';
}

function assertSpeakerGate(speakers: VoicevoxSpeaker[], client: VoicevoxClient): void {
  if (!Array.isArray(speakers)) throw new VoiceStageError('voice-speakers-malformed', '話者一覧が不正です');
  for (const speaker of speakers) {
    if (
      !speaker ||
      typeof speaker.name !== 'string' ||
      typeof speaker.speaker_uuid !== 'string' ||
      !Array.isArray(speaker.styles) ||
      speaker.styles.some((style) => !style || !Number.isSafeInteger(style.id) || typeof style.name !== 'string')
    ) {
      throw new VoiceStageError('voice-speakers-malformed', '話者一覧のschemaが不正です');
    }
  }
  const uuidMatches = speakers.filter(
    (speaker) => speaker.speaker_uuid.toLowerCase() === client.config.speakerUuid.toLowerCase(),
  );
  if (uuidMatches.length !== 1) throw new VoiceStageError('voice-speaker-uuid-mismatch', 'speaker UUIDが期待値と一致しません');
  const speaker = uuidMatches[0]!;
  if (speaker.name !== client.config.speakerName) {
    throw new VoiceStageError('voice-speaker-name-mismatch', 'speaker名が期待値と一致しません');
  }
  const styleMatches = speaker.styles.filter((style) => style.id === client.config.styleId);
  if (styleMatches.length !== 1) throw new VoiceStageError('voice-style-id-mismatch', 'style IDが期待値と一致しません');
  if (styleMatches[0]!.name !== client.config.styleName) {
    throw new VoiceStageError('voice-style-name-mismatch', 'style名が期待値と一致しません');
  }
}

async function verifyEngineGate(client: VoicevoxClient): Promise<void> {
  let version: string;
  try {
    version = await client.getVersion();
  } catch (error) {
    throw new VoiceStageError('voice-version-check-failed', 'VOICEVOX版を検証できません', { cause: error });
  }
  if (typeof version !== 'string' || !version.trim() || hasControlCharacter(version)) {
    throw new VoiceStageError('voice-version-malformed', 'VOICEVOX版が妥当な文字列ではありません');
  }
  if (version !== client.config.engineVersion) {
    throw new VoiceStageError('voice-version-mismatch', 'VOICEVOX版が期待値と一致しません');
  }
  let speakers: VoicevoxSpeaker[];
  try {
    speakers = await client.getSpeakers();
  } catch (error) {
    throw new VoiceStageError('voice-speakers-check-failed', 'VOICEVOX話者を検証できません', { cause: error });
  }
  assertSpeakerGate(speakers, client);
}

interface WorkItem {
  audioId: string;
  text: string;
  candidateIds: string[];
}

function prepareItems(items: SpeechItem[], client: VoicevoxClient): WorkItem[] {
  const expectedConfig = canonicalVoiceConfig(client.config);
  const candidateIds = new Set<string>();
  const grouped = new Map<string, WorkItem>();
  for (const item of items) {
    if (item.approved === false) throw new VoiceStageError('voice-item-not-approved', 'approvedでない項目を生成できません');
    if (!item.candidateId.trim() || candidateIds.has(item.candidateId)) {
      throw new VoiceStageError('voice-manifest-invariant', 'candidateIdが空または重複しています');
    }
    candidateIds.add(item.candidateId);
    if (item.config && canonicalVoiceConfig(item.config) !== expectedConfig) {
      throw new VoiceStageError('voice-config-mismatch', '項目とclientのVoiceConfigが一致しません');
    }
    const text = itemText(item);
    let audioId: string;
    try {
      audioId = createVoiceCacheKey(text, client.config);
    } catch (error) {
      throw new VoiceStageError('voice-manifest-invariant', '読み上げ項目が不正です', { cause: error });
    }
    const existing = grouped.get(audioId);
    if (existing) existing.candidateIds.push(item.candidateId);
    else grouped.set(audioId, { audioId, text: text.normalize('NFC'), candidateIds: [item.candidateId] });
  }
  return Array.from(grouped.values());
}

/** @des DES-F001-008,DES-F001-017,DES-F001-019 @fun FUN-F001-017 */
export async function generateVoiceAssets(
  items: SpeechItem[],
  client: VoicevoxClient,
  cacheDir: string,
  options: GenerateVoiceOptions,
): Promise<VoiceGenerationResult> {
  if (!(client instanceof ProductionVoicevoxClient)) {
    throw new VoiceStageError('voice-client-not-production', 'ProductionVoicevoxClientが必要です');
  }
  if (!options?.preflight) {
    throw new VoiceStageError('voice-preflight-required', '検証済み音声容量preflightが必要です');
  }
  if (!options.preflight.canGenerate) {
    throw new VoiceStageError('voice-preflight-blocked', '音声容量preflightが生成を許可していません');
  }
  const workItems = prepareItems(items, client);
  const expectedConfigHash = voiceConfigHash(client.config);
  if (
    options.preflight.configHash !== expectedConfigHash ||
    options.preflight.inputDigest !== voiceInputDigest(items, client.config) ||
    options.preflight.candidateCount !== items.length ||
    options.preflight.uniqueAudioCount !== workItems.length ||
    options.preflight.warningThresholdBytes !== VOICE_WARNING_BYTES ||
    options.preflight.hardLimitBytes !== VOICE_HARD_LIMIT_BYTES ||
    !Number.isSafeInteger(options.preflight.estimatedBytes) ||
    options.preflight.estimatedBytes < 0 ||
    options.preflight.estimatedBytes >= options.preflight.hardLimitBytes ||
    options.preflight.status === 'blocked' ||
    options.preflight.status === 'profile-update-required'
  ) {
    throw new VoiceStageError('voice-preflight-mismatch', 'preflight証跡が候補・音声・VoiceConfigと一致しません');
  }
  const fileSystem = options.fileSystem ?? new NodeVoiceFileSystem();
  const workspaceRoot = options.workspaceRoot ?? client.workspaceRoot;
  if (!workspaceRoot) throw new VoiceStageError('voice-workspace-unfixed', 'workspaceRootを固定してください');
  const cacheParts = path.resolve(cacheDir).split(path.sep).map((part) => part.toLowerCase());
  if (cacheParts.includes('public') || cacheParts.includes('dist')) {
    throw new VoiceStageError('voice-public-write-forbidden', '公開directoryへ音声を直接書き込めません');
  }
  let preparedCache: string;
  try {
    preparedCache = await fileSystem.prepareCache(cacheDir, workspaceRoot);
  } catch (error) {
    throw new VoiceStageError('voice-cache-boundary', 'cache workspace境界を検証できません', { cause: error });
  }
  if (!path.isAbsolute(preparedCache) || !isInside(workspaceRoot, preparedCache)) {
    throw new VoiceStageError('voice-cache-boundary', '検証後cache実体がworkspace外です');
  }
  const publicPathPrefix = validatePublicPrefix(options.publicPathPrefix ?? 'audio/F001');
  await verifyEngineGate(client);

  const configHash = expectedConfigHash;
  const assets: AudioAsset[] = [];
  const failures: VoiceGenerationResult['failures'] = [];
  for (const item of workItems) {
    const cachePath = path.join(preparedCache, `${item.audioId}.wav`);
    let wav: Uint8Array | null;
    try {
      wav = await fileSystem.read(cachePath);
    } catch (error) {
      throw new VoiceStageError('voice-cache-read-failed', 'cacheを安全に読み込めません', { cause: error });
    }

    let info: WavInfo;
    if (wav) {
      try {
        info = inspectWav(wav);
      } catch (error) {
        throw new VoiceStageError('voice-cache-invalid', '既存cacheのWAVが不正です', { cause: error });
      }
    } else {
      try {
        const query = await client.createAudioQuery(item.text);
        wav = await client.synthesize(query);
        info = inspectWav(wav);
      } catch (error) {
        if (isStageFatalClientError(error)) {
          throw new VoiceStageError(error.code, 'VOICEVOX接続の安全境界に違反しました', { cause: error });
        }
        await fileSystem.remove(cachePath).catch(() => undefined);
        failures.push({ audioId: item.audioId, candidateIds: item.candidateIds, reasonCode: failureReason(error) });
        continue;
      }
      try {
        await fileSystem.writeAtomic(cachePath, wav);
      } catch (error) {
        throw new VoiceStageError('voice-cache-write-failed', '検証済みWAVをcacheへ原子的に保存できません', {
          cause: error,
        });
      }
    }

    assets.push({
      audioId: item.audioId,
      path: `${publicPathPrefix}/${item.audioId}.wav`,
      sha256: createHash('sha256').update(wav).digest('hex'),
      bytes: wav.byteLength,
      durationMs: info.durationMs,
      configHash,
      candidateIds: item.candidateIds,
    });
  }

  return {
    assets,
    failures,
    attempted: workItems.length,
    succeeded: assets.length,
    failed: failures.length,
    configHash,
  };
}

const F002_ENGINE_VERSION = '0.25.2';
const F002_SPEAKER_UUID = '388f246b-8c41-4ac1-8e2d-5d79f3ff56d9';
const F002_SPEAKER_NAME = 'ずんだもん';
const F002_STYLE_ID = 3;
const F002_STYLE_NAME = 'ノーマル';
const F002_MAX_UNIQUE_WAV_BYTES = 100 * 1024 * 1024;

export interface VoiceDiffItem {
  candidateId: string;
  workId?: string;
  speechText?: string;
  text?: string;
  approved?: boolean;
  /** 容量予測側が算出済みの場合に使用する。未指定時は保守的な決定式で見積もる。 */
  estimatedBytes?: number;
}

export interface VoiceCacheMetadataV2 {
  schemaVersion: '2';
  audioId: string;
  configHash: string;
  sha256: string;
  bytes: number;
  durationMs: number;
}

export type VoiceDiffStatus = 'hit' | 'miss' | 'invalid';

export interface VoiceDiffEntry {
  audioId: string;
  text: string;
  candidateIds: string[];
  workIds: string[];
  status: VoiceDiffStatus;
  wavPath: string;
  metadataPath: string;
  estimatedBytes: number;
  invalidReason?: 'VOICE_CACHE_HASH_MISMATCH' | 'VOICE_CACHE_ORPHAN_METADATA';
  metadata?: VoiceCacheMetadataV2;
}

export interface VoiceCapacityAuthorization {
  readonly result: 'pass' | 'pass_with_warning';
  readonly planDigest: string;
  readonly remainingResponseBytes: number;
  /** 書込み後にも確保する空き容量。 */
  readonly minimumFreeBytesAfterWrite: number;
}

export interface VoiceWorkBinding {
  readonly batchId: string;
  readonly workId: string;
  readonly expectedManifestSha: string;
  readonly preTreeDigest: string;
}

export interface VoiceDiffPlan {
  readonly schemaVersion: '2';
  readonly batchId: string;
  readonly workId: string;
  readonly expectedManifestSha: string;
  readonly preTreeDigest: string;
  readonly config: VoiceConfigV2;
  readonly configHash: string;
  readonly cacheRoot: string;
  readonly entries: VoiceDiffEntry[];
  readonly candidateCount: number;
  readonly uniqueAudioCount: number;
  readonly hitCount: number;
  readonly missCount: number;
  readonly invalidCount: number;
  readonly estimatedMissBytes: number;
  readonly existingUniqueAudioCount: number;
  readonly existingUniqueBytes: number;
  readonly planDigest: string;
  readonly authorization?: VoiceCapacityAuthorization;
  readonly authorizationDigest?: string;
}

export interface VoiceDiffAsset extends AudioAsset {
  source: 'cache' | 'staging';
  sourcePath: string;
  workIds: string[];
}

export interface VoiceDiffGenerationResult {
  readonly schemaVersion: '2';
  readonly batchId: string;
  readonly workId: string;
  readonly expectedManifestSha: string;
  readonly preTreeDigest: string;
  readonly planDigest: string;
  readonly authorizationDigest: string;
  readonly generationDigest: string;
  readonly configHash: string;
  readonly assets: VoiceDiffAsset[];
  readonly failures: VoiceFailure[];
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly stagedBytes: number;
  readonly stagingRoot: string;
}

export interface VoiceAcceptanceTuple extends VoiceWorkBinding {
  readonly planDigest: string;
  readonly authorizationDigest: string;
  readonly generationDigest: string;
  readonly completenessDigest: string;
}

export interface GenerateVoiceDiffOptions {
  freeBytes?: (directory: string) => Promise<number>;
}

function voiceV2Error(code: string, message: string, cause?: unknown): VoiceStageError {
  return new VoiceStageError(code, message, cause === undefined ? undefined : { cause });
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function assertVoiceWorkBinding(value: VoiceWorkBinding): void {
  if (!value || typeof value.batchId !== 'string' || !/^F[0-9]{3}$/u.test(value.batchId) ||
    typeof value.workId !== 'string' || !value.workId.trim() || /[\\/\0]/u.test(value.workId) ||
    !SHA256_HEX.test(value.expectedManifestSha) || !SHA256_HEX.test(value.preTreeDigest)) {
    throw voiceV2Error('VOICE_TUPLE_INVALID', 'voice work tupleが不正です');
  }
}

function estimateVoiceBytesV2(text: string, samplingRate: number): number {
  const scalarCount = Array.from(text).length;
  return 44 + Math.max(1, Math.ceil(scalarCount * 0.18 * samplingRate * 2));
}

function planDigestOf(plan: Omit<VoiceDiffPlan, 'planDigest' | 'authorization' | 'authorizationDigest'>): string {
  return sha256(JSON.stringify({
    schemaVersion: plan.schemaVersion,
    batchId: plan.batchId,
    workId: plan.workId,
    expectedManifestSha: plan.expectedManifestSha,
    preTreeDigest: plan.preTreeDigest,
    configHash: plan.configHash,
    cacheRoot: plan.cacheRoot,
    entries: plan.entries.map((entry) => ({
      audioId: entry.audioId,
      candidateIds: entry.candidateIds,
      workIds: entry.workIds,
      status: entry.status,
      estimatedBytes: entry.estimatedBytes,
      metadata: entry.metadata,
      invalidReason: entry.invalidReason,
    })),
    candidateCount: plan.candidateCount,
    uniqueAudioCount: plan.uniqueAudioCount,
    estimatedMissBytes: plan.estimatedMissBytes,
    existingUniqueAudioCount: plan.existingUniqueAudioCount,
    existingUniqueBytes: plan.existingUniqueBytes,
  }));
}

function authorizationDigestOf(plan: VoiceDiffPlan, authorization: VoiceCapacityAuthorization): string {
  return sha256(JSON.stringify({
    schemaVersion: '2',
    kind: 'voice-capacity-authorization',
    batchId: plan.batchId,
    workId: plan.workId,
    expectedManifestSha: plan.expectedManifestSha,
    preTreeDigest: plan.preTreeDigest,
    planDigest: plan.planDigest,
    result: authorization.result,
    remainingResponseBytes: authorization.remainingResponseBytes,
    minimumFreeBytesAfterWrite: authorization.minimumFreeBytesAfterWrite,
  }));
}

/** 容量予測PASSをplanへcanonicalに結合し、後段での差替えをdigest検知可能にする。 */
export function authorizeVoiceDiffPlan(plan: VoiceDiffPlan, authorization: VoiceCapacityAuthorization): VoiceDiffPlan {
  if (planDigestOf(plan) !== plan.planDigest || authorization.planDigest !== plan.planDigest ||
    !['pass', 'pass_with_warning'].includes(authorization.result) ||
    !Number.isSafeInteger(authorization.remainingResponseBytes) || authorization.remainingResponseBytes < 0 ||
    !Number.isSafeInteger(authorization.minimumFreeBytesAfterWrite) || authorization.minimumFreeBytesAfterWrite < 0) {
    throw voiceV2Error('VOICE_CAPACITY_FORECAST_REQUIRED', 'planと一致するPASS容量予測が必要です');
  }
  const frozenAuthorization = Object.freeze({ ...authorization });
  return Object.freeze({
    ...plan,
    authorization: frozenAuthorization,
    authorizationDigest: authorizationDigestOf(plan, frozenAuthorization),
  });
}

async function safeExistingFile(filePath: string): Promise<Uint8Array | null> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw voiceV2Error('VOICE_CACHE_PATH_INVALID', 'cache fileが通常fileではありません');
    return new Uint8Array(await readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertCacheRootV2(cacheRoot: string): Promise<string> {
  if (!path.isAbsolute(cacheRoot) || path.basename(cacheRoot).toLowerCase() !== 'voice' || path.basename(path.dirname(cacheRoot)).toLowerCase() !== '.cache') {
    throw voiceV2Error('VOICE_CACHE_PATH_INVALID', 'cache rootは絶対pathの.cache/voiceで指定してください');
  }
  const resolved = path.resolve(cacheRoot);
  let current = resolved;
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw voiceV2Error('VOICE_CACHE_PATH_INVALID', 'cache pathにreparse pointがあります');
      if (current === resolved && !info.isDirectory()) throw voiceV2Error('VOICE_CACHE_PATH_INVALID', 'cache rootがdirectoryではありません');
      if (current === resolved && await realpath(current) !== resolved) throw voiceV2Error('VOICE_CACHE_PATH_INVALID', 'cache root実体が一致しません');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

async function scanExistingVoiceCache(cacheRoot: string): Promise<{ count: number; bytes: number }> {
  let configDirectories;
  try { configDirectories = await readdir(cacheRoot, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { count: 0, bytes: 0 };
    throw error;
  }
  let count = 0;
  let bytes = 0;
  for (const directory of configDirectories) {
    if (directory.isSymbolicLink()) throw voiceV2Error('VOICE_CACHE_PATH_INVALID', 'cache内にreparse pointがあります');
    if (!directory.isDirectory() || !/^[0-9a-f]{64}$/.test(directory.name)) continue;
    const directoryPath = path.join(cacheRoot, directory.name);
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw voiceV2Error('VOICE_CACHE_PATH_INVALID', 'cache内にreparse pointがあります');
      if (!entry.isFile() || !/^[0-9a-f]{64}\.wav$/.test(entry.name)) continue;
      const info = await lstat(path.join(directoryPath, entry.name));
      count += 1;
      bytes += info.size;
    }
  }
  return { count, bytes };
}

function parseCacheMetadata(bytes: Uint8Array, audioId: string, configHash: string): VoiceCacheMetadataV2 | null {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Partial<VoiceCacheMetadataV2>;
    if (value.schemaVersion !== '2' || value.audioId !== audioId || value.configHash !== configHash ||
      !/^[0-9a-f]{64}$/.test(value.sha256 ?? '') || !Number.isSafeInteger(value.bytes) || (value.bytes ?? 0) <= 0 ||
      !Number.isSafeInteger(value.durationMs) || (value.durationMs ?? 0) <= 0) return null;
    return value as VoiceCacheMetadataV2;
  } catch {
    return null;
  }
}

/** @des DD-F002 @fun FUN-F002-014 */
export async function planVoiceDiff(
  items: readonly VoiceDiffItem[],
  config: VoiceConfigV2,
  cacheRoot: string,
  binding: VoiceWorkBinding,
): Promise<VoiceDiffPlan> {
  assertVoiceWorkBinding(binding);
  canonicalVoiceConfigV2(config);
  const preparedRoot = await assertCacheRootV2(cacheRoot);
  const existingCache = await scanExistingVoiceCache(preparedRoot);
  const configHash = voiceConfigHashV2(config);
  const configRoot = path.join(preparedRoot, configHash);
  const candidates = new Set<string>();
  const grouped = new Map<string, VoiceDiffEntry>();
  for (const item of items) {
    if (item.approved === false || !item.candidateId?.trim() || candidates.has(item.candidateId)) {
      throw voiceV2Error('VOICE_APPROVED_MISSING', 'approved候補またはcandidateIdが不正です');
    }
    if (item.workId !== undefined && item.workId !== binding.workId) {
      throw voiceV2Error('VOICE_TUPLE_MISMATCH', '候補のwork IDがvoice tupleと一致しません');
    }
    candidates.add(item.candidateId);
    const text = item.speechText ?? item.text ?? '';
    const audioId = createVoiceCacheKeyV2(text, config);
    const estimatedBytes = item.estimatedBytes ?? estimateVoiceBytesV2(text, config.outputSamplingRate);
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) throw voiceV2Error('VOICE_CONFIG_RANGE_INVALID', 'estimatedBytesが不正です');
    const existing = grouped.get(audioId);
    if (existing) {
      existing.candidateIds.push(item.candidateId);
      existing.estimatedBytes = Math.max(existing.estimatedBytes, estimatedBytes);
    } else {
      grouped.set(audioId, {
        audioId,
        text: text.normalize('NFC'),
        candidateIds: [item.candidateId],
        workIds: [binding.workId],
        status: 'miss',
        wavPath: path.join(configRoot, `${audioId}.wav`),
        metadataPath: path.join(configRoot, `${audioId}.json`),
        estimatedBytes,
      });
    }
  }

  const entries = Array.from(grouped.values()).sort((a, b) => a.audioId.localeCompare(b.audioId));
  for (const entry of entries) {
    const [wav, metadataBytes] = await Promise.all([safeExistingFile(entry.wavPath), safeExistingFile(entry.metadataPath)]);
    if (!wav && !metadataBytes) continue;
    if (!wav || !metadataBytes) {
      entry.status = 'invalid';
      entry.invalidReason = 'VOICE_CACHE_ORPHAN_METADATA';
      continue;
    }
    const metadata = parseCacheMetadata(metadataBytes, entry.audioId, configHash);
    let durationMs = 0;
    try { durationMs = inspectWav(wav).durationMs; } catch { /* invalid below */ }
    if (!metadata || metadata.sha256 !== sha256(wav) || metadata.bytes !== wav.byteLength || metadata.durationMs !== durationMs) {
      entry.status = 'invalid';
      entry.invalidReason = 'VOICE_CACHE_HASH_MISMATCH';
      continue;
    }
    entry.status = 'hit';
    entry.metadata = metadata;
  }
  const partial = {
    schemaVersion: '2' as const,
    batchId: binding.batchId,
    workId: binding.workId,
    expectedManifestSha: binding.expectedManifestSha,
    preTreeDigest: binding.preTreeDigest,
    config: JSON.parse(JSON.stringify(config)) as VoiceConfigV2,
    configHash,
    cacheRoot: preparedRoot,
    entries,
    candidateCount: items.length,
    uniqueAudioCount: entries.length,
    hitCount: entries.filter((entry) => entry.status === 'hit').length,
    missCount: entries.filter((entry) => entry.status === 'miss').length,
    invalidCount: entries.filter((entry) => entry.status === 'invalid').length,
    estimatedMissBytes: entries.filter((entry) => entry.status === 'miss').reduce((sum, entry) => sum + entry.estimatedBytes, 0),
    existingUniqueAudioCount: existingCache.count,
    existingUniqueBytes: existingCache.bytes,
  };
  const plan = { ...partial, planDigest: planDigestOf(partial) };
  for (const entry of plan.entries) {
    Object.freeze(entry.candidateIds);
    Object.freeze(entry.workIds);
    if (entry.metadata) Object.freeze(entry.metadata);
    Object.freeze(entry);
  }
  Object.freeze(plan.entries);
  Object.freeze(plan.config);
  return Object.freeze(plan);
}

function assertF002Config(config: VoiceConfig): void {
  if (config.engineVersion !== F002_ENGINE_VERSION) throw voiceV2Error('VOICE_ENGINE_MISMATCH', 'ENGINE版がF002固定値と一致しません');
  if (config.speakerUuid.toLowerCase() !== F002_SPEAKER_UUID || config.speakerName !== F002_SPEAKER_NAME) {
    throw voiceV2Error('VOICE_SPEAKER_MISMATCH', 'speakerがF002固定値と一致しません');
  }
  if (config.styleId !== F002_STYLE_ID || config.styleName !== F002_STYLE_NAME) {
    throw voiceV2Error('VOICE_STYLE_MISMATCH', 'styleがF002固定値と一致しません');
  }
  if (config.speedScale !== 1 || config.pitchScale !== 0 || config.intonationScale !== 1 ||
    config.volumeScale !== 1 || config.outputSamplingRate !== 24_000) {
    throw voiceV2Error('VOICE_CONFIG_RANGE_INVALID', '音声設定がF002固定値と一致しません');
  }
}

async function verifyF002Client(client: VoicevoxClient, expected: VoiceConfigV2): Promise<void> {
  if (!(client instanceof ProductionVoicevoxClient) || !['127.0.0.1', '[::1]'].includes(client.baseUrl.hostname)) {
    throw voiceV2Error('VOICE_NON_LOOPBACK', 'loopback固定のProductionVoicevoxClientが必要です');
  }
  assertF002Config(expected);
  if (canonicalVoiceConfigV2(client.config) !== canonicalVoiceConfigV2(expected)) {
    throw voiceV2Error('VOICE_CONFIG_HASH_MISMATCH', 'clientとplanのVoiceConfigが一致しません');
  }
  let version: string;
  try { version = await client.getVersion(); } catch (error) { throw voiceV2Error('VOICE_ENGINE_MISMATCH', 'ENGINE版を確認できません', error); }
  if (version !== F002_ENGINE_VERSION) throw voiceV2Error('VOICE_ENGINE_MISMATCH', '実ENGINE版が固定値と一致しません');
  let speakers: VoicevoxSpeaker[];
  try { speakers = await client.getSpeakers(); } catch (error) { throw voiceV2Error('VOICE_SPEAKER_MISMATCH', 'speakerを確認できません', error); }
  const speaker = speakers.filter((value) => value?.speaker_uuid?.toLowerCase() === F002_SPEAKER_UUID);
  if (speaker.length !== 1 || speaker[0]!.name !== F002_SPEAKER_NAME) {
    throw voiceV2Error('VOICE_SPEAKER_MISMATCH', '実speakerが固定値と一致しません');
  }
  const style = speaker[0]!.styles?.filter((value) => value?.id === F002_STYLE_ID);
  if (style?.length !== 1 || style[0]!.name !== F002_STYLE_NAME) {
    throw voiceV2Error('VOICE_STYLE_MISMATCH', '実styleが固定値と一致しません');
  }
}

async function defaultFreeBytes(directory: string): Promise<number> {
  const value = await statfs(directory);
  return value.bavail * value.bsize;
}

export function computeVoiceGenerationDigest(result: Omit<VoiceDiffGenerationResult, 'generationDigest'>): string {
  return sha256(JSON.stringify({
    schemaVersion: result.schemaVersion,
    batchId: result.batchId,
    workId: result.workId,
    expectedManifestSha: result.expectedManifestSha,
    preTreeDigest: result.preTreeDigest,
    planDigest: result.planDigest,
    authorizationDigest: result.authorizationDigest,
    configHash: result.configHash,
    assets: [...result.assets].sort((a, b) => a.audioId.localeCompare(b.audioId, 'en')).map((asset) => ({
      audioId: asset.audioId,
      path: asset.path,
      sha256: asset.sha256,
      bytes: asset.bytes,
      durationMs: asset.durationMs,
      configHash: asset.configHash,
      candidateIds: [...asset.candidateIds].sort((a, b) => a.localeCompare(b, 'en')),
      workIds: [...asset.workIds].sort((a, b) => a.localeCompare(b, 'en')),
      source: asset.source,
      sourcePath: path.resolve(asset.sourcePath),
    })),
    failures: [...result.failures].sort((a, b) => a.audioId.localeCompare(b.audioId, 'en')).map((failure) => ({
      audioId: failure.audioId,
      candidateIds: [...failure.candidateIds].sort((a, b) => a.localeCompare(b, 'en')),
      reasonCode: failure.reasonCode,
    })),
    attempted: result.attempted,
    succeeded: result.succeeded,
    failed: result.failed,
    stagedBytes: result.stagedBytes,
    stagingRoot: path.resolve(result.stagingRoot),
  }));
}

/** @des DD-F002 @fun FUN-F002-015 */
export async function generateVoiceDiff(
  plan: VoiceDiffPlan,
  client: VoicevoxClient,
  staging: string,
  options: GenerateVoiceDiffOptions = {},
): Promise<VoiceDiffGenerationResult> {
  const authorization = plan.authorization;
  if (!authorization || !['pass', 'pass_with_warning'].includes(authorization.result) ||
    authorization.planDigest !== plan.planDigest || planDigestOf(plan) !== plan.planDigest ||
    !plan.authorizationDigest || authorizationDigestOf(plan, authorization) !== plan.authorizationDigest) {
    throw voiceV2Error('VOICE_CAPACITY_FORECAST_REQUIRED', 'planと一致するPASS容量予測が必要です');
  }
  if (voiceConfigHashV2(plan.config) !== plan.configHash) {
    throw voiceV2Error('VOICE_CONFIG_HASH_MISMATCH', 'planのVoiceConfig hashが一致しません');
  }
  if (!Number.isSafeInteger(authorization.remainingResponseBytes) || authorization.remainingResponseBytes < 0 ||
    !Number.isSafeInteger(authorization.minimumFreeBytesAfterWrite) || authorization.minimumFreeBytesAfterWrite < 0) {
    throw voiceV2Error('VOICE_CAPACITY_FORECAST_REQUIRED', '容量予測値が不正です');
  }
  if (plan.invalidCount > 0 || plan.entries.some((entry) => entry.status === 'invalid')) {
    throw voiceV2Error(plan.entries.find((entry) => entry.status === 'invalid')?.invalidReason ?? 'VOICE_CACHE_HASH_MISMATCH', '再利用できないcache entryがあります');
  }
  const workspaceRoot = path.dirname(path.dirname(plan.cacheRoot));
  if (!path.isAbsolute(staging) || !isInside(workspaceRoot, staging) || !path.basename(staging).startsWith('.voice-stage-') ||
    isInside(plan.cacheRoot, staging) || isInside(staging, plan.cacheRoot)) {
    throw voiceV2Error('VOICE_CACHE_PATH_INVALID', 'stagingはcache外の絶対pathで指定してください');
  }
  await verifyF002Client(client, plan.config);

  const stageRoot = path.resolve(staging);
  try { await mkdir(stageRoot, { recursive: false }); } catch (error) {
    throw voiceV2Error('VOICE_CACHE_PATH_INVALID', '新規のwork専用stagingを指定してください', error);
  }
  const getFreeBytes = options.freeBytes ?? defaultFreeBytes;
  const assets: VoiceDiffAsset[] = [];
  let remaining = authorization.remainingResponseBytes;
  let stagedBytes = 0;
  try {
    for (const entry of plan.entries) {
      if (entry.status === 'hit') {
        const wav = await safeExistingFile(entry.wavPath);
        if (!wav || !entry.metadata || sha256(wav) !== entry.metadata.sha256 || wav.byteLength !== entry.metadata.bytes ||
          inspectWav(wav).durationMs !== entry.metadata.durationMs) {
          throw voiceV2Error('VOICE_CACHE_HASH_MISMATCH', '生成直前のcache再検証に失敗しました');
        }
        assets.push({
          audioId: entry.audioId,
          path: `audio/${plan.batchId}/${entry.audioId}.wav`,
          sha256: entry.metadata.sha256,
          bytes: entry.metadata.bytes,
          durationMs: entry.metadata.durationMs,
          configHash: plan.configHash,
          candidateIds: [...entry.candidateIds],
          workIds: [...entry.workIds],
          source: 'cache',
          sourcePath: entry.wavPath,
        });
        continue;
      }

      let wav: Uint8Array;
      try {
        const query = await client.createAudioQuery(entry.text);
        wav = await client.synthesize(query);
      } catch (error) {
        throw voiceV2Error('VOICE_ITEM_FAILED', `音声生成に失敗しました: ${entry.audioId}`, error);
      }
      if (wav.byteLength > remaining) throw voiceV2Error('VOICE_RESPONSE_BUDGET_EXCEEDED', 'VOICEVOX応答が残容量を超えました');
      if (plan.existingUniqueBytes + stagedBytes + wav.byteLength > F002_MAX_UNIQUE_WAV_BYTES) {
        throw voiceV2Error('VOICE_BATCH_BYTES_EXCEEDED', 'F002のunique WAV累計が100MiBを超えました');
      }
      let info: WavInfo;
      try { info = inspectWav(wav); } catch (error) { throw voiceV2Error('VOICE_WAV_INVALID', '生成WAVが不正です', error); }
      const freeBytes = await getFreeBytes(stageRoot);
      if (!Number.isFinite(freeBytes) || freeBytes < wav.byteLength + authorization.minimumFreeBytesAfterWrite) {
        throw voiceV2Error('VOICE_DISK_INSUFFICIENT', 'stagingの空き容量が不足しています');
      }
      const sourcePath = path.join(stageRoot, `${entry.audioId}.wav`);
      await writeFile(sourcePath, wav, { flag: 'wx' });
      remaining -= wav.byteLength;
      stagedBytes += wav.byteLength;
      assets.push({
        audioId: entry.audioId,
        path: `audio/${plan.batchId}/${entry.audioId}.wav`,
        sha256: sha256(wav),
        bytes: wav.byteLength,
        durationMs: info.durationMs,
        configHash: plan.configHash,
        candidateIds: [...entry.candidateIds],
        workIds: [...entry.workIds],
        source: 'staging',
        sourcePath,
      });
    }
    const partial = {
      schemaVersion: '2',
      batchId: plan.batchId,
      workId: plan.workId,
      expectedManifestSha: plan.expectedManifestSha,
      preTreeDigest: plan.preTreeDigest,
      planDigest: plan.planDigest,
      authorizationDigest: plan.authorizationDigest,
      configHash: plan.configHash,
      assets,
      failures: [],
      attempted: plan.entries.length,
      succeeded: assets.length,
      failed: 0,
      stagedBytes,
      stagingRoot: stageRoot,
    };
    const result: VoiceDiffGenerationResult = { ...partial, schemaVersion: '2', generationDigest: computeVoiceGenerationDigest({ ...partial, schemaVersion: '2' }) };
    for (const asset of result.assets) {
      Object.freeze(asset.candidateIds);
      Object.freeze(asset.workIds);
      Object.freeze(asset);
    }
    Object.freeze(result.assets);
    Object.freeze(result.failures);
    return Object.freeze(result);
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof VoiceContractError) throw error;
    throw voiceV2Error('VOICE_ITEM_FAILED', '音声差分生成に失敗しました', error);
  }
}

export interface VoiceCompletenessReview {
  batchId: string;
  workId: string;
  approved: ReadonlyArray<{ candidate: { candidateId: string }; review?: { workId?: string } }>;
  pending: ReadonlyArray<unknown>;
}

export interface VoiceCompletenessManifest {
  assets: ReadonlyArray<AudioAsset & { sourcePath?: string; workIds?: string[] }>;
  candidateAudio?: Readonly<Record<string, string>>;
}

export interface VerifyVoiceCompletenessOptions {
  allowedRoots?: readonly string[];
}

export interface VoiceCompletenessReport extends VoiceAcceptanceTuple {
  readonly result: 'pass';
  readonly approvedCount: number;
  readonly uniqueAudioCount: number;
  readonly candidateAudio: Readonly<Record<string, string>>;
}

export function computeVoiceCompletenessDigest(report: Omit<VoiceCompletenessReport, 'completenessDigest'>): string {
  return sha256(JSON.stringify({
    schemaVersion: '2',
    kind: 'voice-completeness',
    batchId: report.batchId,
    workId: report.workId,
    expectedManifestSha: report.expectedManifestSha,
    preTreeDigest: report.preTreeDigest,
    planDigest: report.planDigest,
    authorizationDigest: report.authorizationDigest,
    generationDigest: report.generationDigest,
    result: report.result,
    approvedCount: report.approvedCount,
    uniqueAudioCount: report.uniqueAudioCount,
    candidateAudio: Object.entries(report.candidateAudio).sort(([a], [b]) => a.localeCompare(b, 'en')),
  }));
}

function assertGenerationDigest(generation: VoiceDiffGenerationResult): void {
  if (!generation || generation.schemaVersion !== '2' || !Array.isArray(generation.assets) || !Array.isArray(generation.failures) ||
    !Number.isSafeInteger(generation.attempted) || generation.attempted < 0 ||
    !Number.isSafeInteger(generation.succeeded) || generation.succeeded < 0 ||
    !Number.isSafeInteger(generation.failed) || generation.failed < 0 ||
    !Number.isSafeInteger(generation.stagedBytes) || generation.stagedBytes < 0 ||
    !path.isAbsolute(generation.stagingRoot)) {
    throw voiceV2Error('VOICE_TUPLE_INVALID', 'voice generation resultが不正です');
  }
  const { generationDigest, ...core } = generation;
  if (!SHA256_HEX.test(generation.planDigest) || !SHA256_HEX.test(generation.authorizationDigest) ||
    !SHA256_HEX.test(generationDigest) || computeVoiceGenerationDigest(core) !== generationDigest) {
    throw voiceV2Error('VOICE_TUPLE_MISMATCH', 'voice generation digestが一致しません');
  }
  assertVoiceWorkBinding(generation);
}

/** FUN-F002-033がgeneration/completenessの同一tupleを受入前に照合するためのvalidator。 */
export function assertVoiceAcceptanceTuple(
  generation: VoiceDiffGenerationResult,
  completeness: VoiceCompletenessReport,
): VoiceAcceptanceTuple {
  assertGenerationDigest(generation);
  if (!completeness || completeness.result !== 'pass' || !Number.isSafeInteger(completeness.approvedCount) ||
    completeness.approvedCount < 0 || !Number.isSafeInteger(completeness.uniqueAudioCount) || completeness.uniqueAudioCount < 0 ||
    !completeness.candidateAudio || typeof completeness.candidateAudio !== 'object' || Array.isArray(completeness.candidateAudio)) {
    throw voiceV2Error('VOICE_TUPLE_INVALID', 'voice completeness reportが不正です');
  }
  const fields = ['batchId', 'workId', 'expectedManifestSha', 'preTreeDigest', 'planDigest', 'authorizationDigest', 'generationDigest'] as const;
  if (fields.some((field) => completeness[field] !== generation[field]) ||
    !SHA256_HEX.test(completeness.completenessDigest)) {
    throw voiceV2Error('VOICE_TUPLE_MISMATCH', 'generationとcompletenessのtupleが一致しません');
  }
  const { completenessDigest, ...core } = completeness;
  if (computeVoiceCompletenessDigest(core) !== completenessDigest) {
    throw voiceV2Error('VOICE_TUPLE_MISMATCH', 'voice completeness digestが一致しません');
  }
  return Object.freeze({
    batchId: generation.batchId,
    workId: generation.workId,
    expectedManifestSha: generation.expectedManifestSha,
    preTreeDigest: generation.preTreeDigest,
    planDigest: generation.planDigest,
    authorizationDigest: generation.authorizationDigest,
    generationDigest: generation.generationDigest,
    completenessDigest,
  });
}

/** @des DD-F002 @fun FUN-F002-016 */
export async function verifyVoiceCompleteness(
  review: VoiceCompletenessReview,
  generation: VoiceDiffGenerationResult,
  manifest: VoiceCompletenessManifest,
  options: VerifyVoiceCompletenessOptions = {},
): Promise<VoiceCompletenessReport> {
  assertGenerationDigest(generation);
  if (review.batchId !== generation.batchId || review.workId !== generation.workId) {
    throw voiceV2Error('VOICE_TUPLE_MISMATCH', 'reviewとgenerationのbatch/workが一致しません');
  }
  if (review.pending.length !== 0) throw voiceV2Error('VOICE_APPROVED_MISSING', 'pending reviewが残っています');
  if (generation.failed !== 0 || generation.failures.length !== 0) throw voiceV2Error('VOICE_GENERATION_FAILED', '音声生成失敗が残っています');
  const approved = new Set(review.approved.map((item) => item.candidate.candidateId));
  if (approved.size !== review.approved.length) throw voiceV2Error('VOICE_APPROVED_MISSING', 'approved候補が重複しています');
  const generated = new Map(generation.assets.map((asset) => [asset.audioId, asset]));
  const manifestAssets = new Map(manifest.assets.map((asset) => [asset.audioId, asset]));
  if (generated.size !== generation.assets.length || manifestAssets.size !== manifest.assets.length) {
    throw voiceV2Error('VOICE_ASSET_ORPHAN', 'audioIdが重複しています');
  }
  const candidateAudio = new Map<string, string>();
  for (const asset of generation.assets) {
    if (asset.workIds.length !== 1 || asset.workIds[0] !== generation.workId) {
      throw voiceV2Error('VOICE_TUPLE_MISMATCH', 'assetのwork参照がgeneration tupleと一致しません');
    }
    if (!manifestAssets.has(asset.audioId)) throw voiceV2Error('VOICE_APPROVED_MISSING', '生成assetがmanifestにありません');
    for (const candidateId of asset.candidateIds) {
      if (!approved.has(candidateId) || candidateAudio.has(candidateId)) throw voiceV2Error('VOICE_ASSET_ORPHAN', 'asset参照が孤立または重複しています');
      candidateAudio.set(candidateId, asset.audioId);
    }
  }
  if (candidateAudio.size !== approved.size) throw voiceV2Error('VOICE_APPROVED_MISSING', 'approved候補の音声が不足しています');
  for (const [candidateId, audioId] of Object.entries(manifest.candidateAudio ?? {})) {
    if (candidateAudio.get(candidateId) !== audioId) throw voiceV2Error('VOICE_ASSET_ORPHAN', 'candidateAudio対応が一致しません');
  }
  for (const asset of manifest.assets) {
    const source = generated.get(asset.audioId);
    if (!source) throw voiceV2Error('VOICE_ASSET_ORPHAN', 'manifestに孤立assetがあります');
    if (asset.configHash !== generation.configHash || source.configHash !== generation.configHash) {
      throw voiceV2Error('VOICE_CONFIG_HASH_MISMATCH', 'assetのconfig hashが一致しません');
    }
    if (asset.sha256 !== source.sha256 || asset.bytes !== source.bytes || asset.durationMs !== source.durationMs) {
      throw voiceV2Error('VOICE_ASSET_CORRUPT', 'asset metadataが一致しません');
    }
    const sourcePath = asset.sourcePath ?? source.sourcePath;
    if (options.allowedRoots?.length && !options.allowedRoots.some((root) => isInside(root, sourcePath))) {
      throw voiceV2Error('VOICE_ASSET_ORPHAN', 'assetが対象workのroot外にあります');
    }
    let wav: Uint8Array;
    try { wav = new Uint8Array(await readFile(sourcePath)); } catch (error) { throw voiceV2Error('VOICE_ASSET_CORRUPT', 'assetを読めません', error); }
    let durationMs: number;
    try { durationMs = inspectWav(wav).durationMs; } catch (error) { throw voiceV2Error('VOICE_ASSET_CORRUPT', 'asset WAVが不正です', error); }
    if (wav.byteLength !== asset.bytes || sha256(wav) !== asset.sha256 || durationMs !== asset.durationMs) {
      throw voiceV2Error('VOICE_ASSET_CORRUPT', 'asset実体とmetadataが一致しません');
    }
  }
  const sortedCandidateAudio = Object.freeze(Object.fromEntries(
    [...candidateAudio.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')),
  ));
  const partial = {
    result: 'pass' as const,
    batchId: generation.batchId,
    workId: generation.workId,
    expectedManifestSha: generation.expectedManifestSha,
    preTreeDigest: generation.preTreeDigest,
    planDigest: generation.planDigest,
    authorizationDigest: generation.authorizationDigest,
    generationDigest: generation.generationDigest,
    approvedCount: approved.size,
    uniqueAudioCount: manifestAssets.size,
    candidateAudio: sortedCandidateAudio,
  };
  const report = Object.freeze({ ...partial, completenessDigest: computeVoiceCompletenessDigest(partial) });
  assertVoiceAcceptanceTuple(generation, report);
  return report;
}
