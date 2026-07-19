import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalVoiceConfig, createVoiceCacheKey, NodeVoiceFileSystem, voiceConfigHash, type VoiceFileSystem } from './cache.ts';
import { ProductionVoicevoxClient } from './client.ts';
import {
  VoiceContractError,
  VoiceStageError,
  VOICE_HARD_LIMIT_BYTES,
  VOICE_WARNING_BYTES,
  type AudioAsset,
  type SpeechItem,
  type VoiceGenerationResult,
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
