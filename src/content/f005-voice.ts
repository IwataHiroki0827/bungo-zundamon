import { createHash } from 'node:crypto';
import { mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import {
  forecastCandidateSafety,
  type CandidateSafetyReport as CandidateSafetyItemReport,
  type VoiceEstimateProfileV2,
} from './f003-reuse.ts';
import {
  forecastF005Capacity,
  type CapacityBucket,
  type CapacityEntry,
  type CapacityForecastV3,
  type F005CandidateHashes,
  type F005CapacityPlan,
  type V040Baseline,
} from './f005-foundation.ts';
import {
  isMintedF005NativeCapacityBackend,
  readF005NativeCapacityJournalFile,
  type CapacityJournalV3,
} from './f005-native-guard.ts';
import { F002_VOICE_CONFIG } from '../voice/f003.ts';
import {
  canonicalVoiceConfigV2,
  createVoiceCacheKeyV2,
  voiceConfigHashV2,
  type VoiceConfigV2,
} from '../voice/cache.ts';
import { inspectWav } from '../voice/generation.ts';
import type { VoicevoxSpeaker } from '../voice/types.ts';

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*[\\:\0])[\p{L}\p{N}._/-]+$/u;
const safetyReports = new WeakSet<object>();
const voicePlans = new WeakSet<object>();
const capacityRecorders = new WeakSet<object>();
const closedJournals = new WeakSet<object>();
const F002_SECONDS_PER_CHARACTER = 0.1624195655724318;
const F002_SAFETY_FACTOR = 1.2;

export const F005_VOICE_LIMITS = Object.freeze({
  codePoints: 500,
  durationMs: 120_000,
  wavBytes: 5_760_044,
  addedAudioBytes: 104_857_600,
} as const);

export type F005VoiceErrorCode =
  | 'F005_CANDIDATE_UNSAFE'
  | 'F005_VOICE_PLAN_INVALID'
  | 'F005_VOICE_GENERATION_INVALID'
  | 'F005_CAPACITY_ACTUAL_INVALID';

export class F005VoiceError extends Error {
  readonly code: F005VoiceErrorCode;

  constructor(code: F005VoiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'F005VoiceError';
    this.code = code;
  }
}

function fail(code: F005VoiceErrorCode, message: string, cause?: unknown): never {
  throw new F005VoiceError(code, message, cause === undefined ? undefined : { cause });
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort((a, b) => a.localeCompare(b, 'en'))
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function assertDataObject(
  value: unknown,
  code: F005VoiceErrorCode,
  label: string,
  allowedPrototypes: readonly object[] = [Object.prototype, null as unknown as object],
): void {
  if (value === null || typeof value !== 'object' || !allowedPrototypes.includes(Object.getPrototypeOf(value) as object)) {
    fail(code, `${label}はplain data objectである必要があります`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || descriptor.get || descriptor.set) {
      fail(code, `${label}.${key}にaccessorは使用できません`);
    }
  }
}

function assertExactKeys(value: object, keys: readonly string[], code: F005VoiceErrorCode, label: string): void {
  const actual = Object.keys(value).sort((a, b) => a.localeCompare(b, 'en'));
  const expected = [...keys].sort((a, b) => a.localeCompare(b, 'en'));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label}のschemaが一致しません`);
  }
}

function assertPlainDataTree(value: unknown, code: F005VoiceErrorCode, label: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertPlainDataTree(item, code, `${label}[${index}]`);
    return;
  }
  assertDataObject(value, code, label);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    assertPlainDataTree(descriptor.value, code, `${label}.${key}`);
  }
}

function fixedConfig(config: VoiceConfigV2, code: F005VoiceErrorCode): { config: VoiceConfigV2; configHash: string } {
  assertDataObject(config, code, 'voiceConfig');
  try {
    if (canonicalVoiceConfigV2(config) !== canonicalVoiceConfigV2(F002_VOICE_CONFIG)) {
      fail(code, 'F002固定voice configと一致しません');
    }
    return {
      config: freezeDeep(JSON.parse(JSON.stringify(config)) as VoiceConfigV2),
      configHash: voiceConfigHashV2(config),
    };
  } catch (error) {
    if (error instanceof F005VoiceError) throw error;
    return fail(code, 'voice configを検証できません', error);
  }
}

export interface F005CandidateSafetyReport {
  readonly __brand: 'F005CandidateSafetyReport';
  readonly result: 'pass' | 'blocked';
  readonly configHash: string;
  readonly items: readonly CandidateSafetyItemReport[];
  readonly reportSha256: string;
}

export interface F005SpeechItem {
  readonly candidateId: string;
  readonly speechText: string;
  readonly speechSha256: string;
  readonly approved: true;
}

/**
 * F002校正profileを再検算し、F005候補を3つのinclusive上限で一括判定する。
 * @des DES-F005-006 @fun FUN-F005-015 @ut UT-F005-015
 */
export function validateF005CandidateSafety(
  speechItems: readonly F005SpeechItem[],
  calibratedProfile: VoiceEstimateProfileV2,
  voiceConfig: VoiceConfigV2,
): F005CandidateSafetyReport {
  const { configHash } = fixedConfig(voiceConfig, 'F005_CANDIDATE_UNSAFE');
  if (!Array.isArray(speechItems)) fail('F005_CANDIDATE_UNSAFE', 'speechItemsが配列ではありません');
  assertDataObject(calibratedProfile, 'F005_CANDIDATE_UNSAFE', 'calibratedProfile');
  const seen = new Set<string>();
  const items = speechItems.map((item, index) => {
    assertDataObject(item, 'F005_CANDIDATE_UNSAFE', `speechItems[${index}]`);
    if (item.approved !== true || seen.has(item.candidateId)) {
      fail('F005_CANDIDATE_UNSAFE', 'approved候補が一意ではありません');
    }
    seen.add(item.candidateId);
    const report = forecastCandidateSafety(item, calibratedProfile);
    const reasons = [...report.reasons];
    if (calibratedProfile.configHash !== configHash) reasons.push('VOICE_CONFIG_HASH_MISMATCH');
    return freezeDeep({ ...report, result: reasons.length === 0 ? 'pass' as const : 'blocked' as const, reasons });
  });
  const payload = { result: items.every((item) => item.result === 'pass') ? 'pass' as const : 'blocked' as const, configHash, items };
  const report = freezeDeep({
    __brand: 'F005CandidateSafetyReport' as const,
    ...payload,
    reportSha256: hash(canonical(payload)),
  });
  safetyReports.add(report);
  return report;
}

export interface F005ExistingAudio {
  readonly audioId: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly durationMs: number;
  readonly configHash: string;
  readonly wav: Uint8Array;
}

export interface F005ExistingAudioIndex {
  readonly entries: readonly F005ExistingAudio[];
}

export interface F005VoicePlanEntry {
  readonly audioId: string;
  readonly speechText: string;
  readonly speechSha256: string;
  readonly candidateIds: readonly string[];
  readonly action: 'reuse' | 'generate';
  readonly estimatedBytes: number;
  readonly existing: Omit<F005ExistingAudio, 'wav'> | null;
}

export interface F005VoicePlan {
  readonly __brand: 'F005VoicePlan';
  readonly schemaVersion: 1;
  readonly config: VoiceConfigV2;
  readonly configHash: string;
  readonly entries: readonly F005VoicePlanEntry[];
  readonly reuseCount: number;
  readonly generateCount: number;
  readonly estimatedGenerateBytes: number;
  readonly planSha256: string;
}

function validateExistingAudio(entry: F005ExistingAudio, configHash: string): Omit<F005ExistingAudio, 'wav'> {
  assertDataObject(entry, 'F005_VOICE_PLAN_INVALID', 'existingAudio');
  assertExactKeys(entry, ['audioId', 'path', 'sha256', 'bytes', 'durationMs', 'configHash', 'wav'],
    'F005_VOICE_PLAN_INVALID', 'existingAudio');
  if (!SHA256.test(entry.audioId) || !SHA256.test(entry.sha256) || entry.configHash !== configHash ||
    !SAFE_PATH.test(entry.path) || basename(entry.path) !== `${entry.audioId}.wav` ||
    !(entry.wav instanceof Uint8Array) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 44 ||
    !Number.isSafeInteger(entry.durationMs) || entry.durationMs <= 0 ||
    entry.wav.byteLength !== entry.bytes || hash(entry.wav) !== entry.sha256) {
    fail('F005_VOICE_PLAN_INVALID', 'existing audioの実体・metadataが一致しません');
  }
  let durationMs: number;
  try {
    durationMs = inspectWav(entry.wav).durationMs;
  } catch (error) {
    return fail('F005_VOICE_PLAN_INVALID', 'existing audioがPCM WAVではありません', error);
  }
  if (durationMs !== entry.durationMs || durationMs > F005_VOICE_LIMITS.durationMs ||
    entry.bytes > F005_VOICE_LIMITS.wavBytes) {
    fail('F005_VOICE_PLAN_INVALID', 'existing audioのduration/bytesが一致しません');
  }
  return freezeDeep({
    audioId: entry.audioId,
    path: entry.path,
    sha256: entry.sha256,
    bytes: entry.bytes,
    durationMs: entry.durationMs,
    configHash: entry.configHash,
  });
}

/**
 * canonical speech/configからIDを作り、物理WAVまでexact一致するものだけを再利用する。
 * @des DES-F005-006 @fun FUN-F005-016 @ut UT-F005-016
 */
export function planF005VoiceDiff(
  speechItems: readonly F005SpeechItem[],
  config: VoiceConfigV2,
  existingAudioIndex: F005ExistingAudioIndex,
): F005VoicePlan {
  const fixed = fixedConfig(config, 'F005_VOICE_PLAN_INVALID');
  if (!Array.isArray(speechItems)) fail('F005_VOICE_PLAN_INVALID', 'speechItemsが配列ではありません');
  assertDataObject(existingAudioIndex, 'F005_VOICE_PLAN_INVALID', 'existingAudioIndex');
  assertExactKeys(existingAudioIndex, ['entries'], 'F005_VOICE_PLAN_INVALID', 'existingAudioIndex');
  if (!Array.isArray(existingAudioIndex.entries)) fail('F005_VOICE_PLAN_INVALID', 'existingAudioIndex.entriesが配列ではありません');

  const existing = new Map<string, Omit<F005ExistingAudio, 'wav'>>();
  for (const raw of existingAudioIndex.entries) {
    const verified = validateExistingAudio(raw, fixed.configHash);
    if (existing.has(verified.audioId)) fail('F005_VOICE_PLAN_INVALID', 'existing audio IDがcollisionしています');
    existing.set(verified.audioId, verified);
  }

  const candidates = new Set<string>();
  const grouped = new Map<string, { text: string; speechSha256: string; candidateIds: string[] }>();
  for (const [index, item] of speechItems.entries()) {
    assertDataObject(item, 'F005_VOICE_PLAN_INVALID', `speechItems[${index}]`);
    if (item.approved !== true || !item.candidateId.trim() || candidates.has(item.candidateId) ||
      typeof item.speechText !== 'string' || item.speechText !== item.speechText.normalize('NFC') ||
      item.speechText.trim() === '' || hash(item.speechText) !== item.speechSha256 ||
      Array.from(item.speechText).length > F005_VOICE_LIMITS.codePoints) {
      fail('F005_VOICE_PLAN_INVALID', 'approved speech itemが不正です');
    }
    candidates.add(item.candidateId);
    let audioId: string;
    try {
      audioId = createVoiceCacheKeyV2(item.speechText, fixed.config);
    } catch (error) {
      return fail('F005_VOICE_PLAN_INVALID', 'canonical audio IDを生成できません', error);
    }
    const previous = grouped.get(audioId);
    if (previous && (previous.text !== item.speechText || previous.speechSha256 !== item.speechSha256)) {
      fail('F005_VOICE_PLAN_INVALID', 'canonical audio ID collisionを検出しました');
    }
    if (previous) previous.candidateIds.push(item.candidateId);
    else grouped.set(audioId, { text: item.speechText, speechSha256: item.speechSha256, candidateIds: [item.candidateId] });
  }
  for (const audioId of existing.keys()) {
    if (!grouped.has(audioId)) fail('F005_VOICE_PLAN_INVALID', 'orphan existing audioがあります');
  }
  const entries = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([audioId, item]) => {
    const physical = existing.get(audioId) ?? null;
    const durationMs = Math.ceil(Array.from(item.text).length *
      F002_SECONDS_PER_CHARACTER * F002_SAFETY_FACTOR * 1_000);
    const estimatedBytes = 44 + Math.ceil(durationMs * 48);
    return freezeDeep({
      audioId,
      speechText: item.text,
      speechSha256: item.speechSha256,
      candidateIds: [...item.candidateIds].sort((a, b) => a.localeCompare(b, 'en')),
      action: physical ? 'reuse' as const : 'generate' as const,
      estimatedBytes,
      existing: physical,
    });
  });
  const payload = {
    schemaVersion: 1 as const,
    config: fixed.config,
    configHash: fixed.configHash,
    entries,
    reuseCount: entries.filter((entry) => entry.action === 'reuse').length,
    generateCount: entries.filter((entry) => entry.action === 'generate').length,
    estimatedGenerateBytes: entries.filter((entry) => entry.action === 'generate')
      .reduce((sum, entry) => sum + entry.estimatedBytes, 0),
  };
  if (!Number.isSafeInteger(payload.estimatedGenerateBytes) ||
    payload.estimatedGenerateBytes > F005_VOICE_LIMITS.addedAudioBytes) {
    fail('F005_VOICE_PLAN_INVALID', '追加audio容量が100 MiBを超えます');
  }
  const plan = freezeDeep({ __brand: 'F005VoicePlan' as const, ...payload, planSha256: hash(canonical(payload)) });
  voicePlans.add(plan);
  return plan;
}

export type F005MutationKind = 'create' | 'rename' | 'delete';

export interface F005MutationNotice {
  readonly noticeId: string;
  readonly sequence: number;
  readonly phase: 'voice';
  readonly phaseInstanceId: string;
  readonly kind: F005MutationKind;
  readonly path: string;
  readonly targetPath: string | null;
  readonly sha256: string | null;
  readonly bytes: number;
}

export interface F005MutationObservation {
  readonly noticeId: string;
  readonly sessionNonce: string;
  readonly sequence: number;
  readonly workerPid: number;
  readonly matchedEtw: true;
}

export interface F005CapacityRecorderBackend {
  beginPhase(phase: 'voice', workId: string | null, phaseInstanceId: string): Promise<void>;
  observeMutation(notice: F005MutationNotice): Promise<F005MutationObservation>;
  endPhase(phase: 'voice', phaseInstanceId: string): Promise<void>;
}

export interface F005CapacityRecorder {
  readonly __brand: 'F005CapacityRecorder';
  readonly journalId: string;
  readonly owner: string;
  readonly sessionNonce: string;
  readonly workerPid: number;
  beginPhase(phase: 'voice', workId: string | null, phaseInstanceId: string): Promise<void>;
  observeMutation(notice: F005MutationNotice): Promise<void>;
  endPhase(phase: 'voice', phaseInstanceId: string): Promise<void>;
}

/** Native IPCで認証済みのbackendをclone不能なadapterへ包む。 */
export function createF005CapacityRecorder(
  identity: { readonly journalId: string; readonly owner: string; readonly sessionNonce: string; readonly workerPid: number },
  backend: F005CapacityRecorderBackend,
): F005CapacityRecorder {
  if (process.env.NODE_ENV !== 'test' && !isMintedF005NativeCapacityBackend(backend)) {
    fail(
      'F005_VOICE_GENERATION_INVALID',
      'productionではmint済みnative ETW capacity backendが必要です',
    );
  }
  assertDataObject(identity, 'F005_VOICE_GENERATION_INVALID', 'capacity recorder identity');
  assertExactKeys(identity, ['journalId', 'owner', 'sessionNonce', 'workerPid'],
    'F005_VOICE_GENERATION_INVALID', 'capacity recorder identity');
  assertDataObject(backend, 'F005_VOICE_GENERATION_INVALID', 'capacity recorder backend');
  if (!SHA256.test(identity.journalId) || !SHA256.test(identity.sessionNonce) || !identity.owner.trim() ||
    !Number.isSafeInteger(identity.workerPid) || identity.workerPid <= 0 ||
    typeof backend.beginPhase !== 'function' || typeof backend.observeMutation !== 'function' ||
    typeof backend.endPhase !== 'function') {
    fail('F005_VOICE_GENERATION_INVALID', 'capacity recorder identity/backendが不正です');
  }
  const observeMutation = async (notice: F005MutationNotice): Promise<void> => {
    const observation = await backend.observeMutation(notice);
    assertDataObject(observation, 'F005_VOICE_GENERATION_INVALID', 'native ETW observation');
    assertExactKeys(observation, ['noticeId', 'sessionNonce', 'sequence', 'workerPid', 'matchedEtw'],
      'F005_VOICE_GENERATION_INVALID', 'native ETW observation');
    if (observation.noticeId !== notice.noticeId || observation.sessionNonce !== identity.sessionNonce ||
      observation.sequence !== notice.sequence || observation.workerPid !== identity.workerPid ||
      observation.matchedEtw !== true) {
      fail('F005_VOICE_GENERATION_INVALID', 'noticeに対応する認証済みETW観測がありません');
    }
  };
  const recorder = freezeDeep({
    __brand: 'F005CapacityRecorder' as const,
    ...identity,
    beginPhase: backend.beginPhase.bind(backend),
    observeMutation,
    endPhase: backend.endPhase.bind(backend),
  });
  capacityRecorders.add(recorder);
  return recorder;
}

export interface F005LoopbackEngine {
  readonly baseUrl: URL;
  readonly config: VoiceConfigV2;
  getVersion(): Promise<string>;
  getSpeakers(): Promise<readonly VoicevoxSpeaker[]>;
  createAudioQuery(text: string): Promise<unknown>;
  synthesize(query: unknown): Promise<Uint8Array>;
}

export interface F005VoiceGenerationEvidence {
  readonly __brand: 'F005VoiceGenerationEvidence';
  readonly planSha256: string;
  readonly phaseInstanceId: string;
  readonly assets: readonly {
    readonly audioId: string;
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly durationMs: number;
    readonly source: 'reuse' | 'staging';
  }[];
  readonly evidenceSha256: string;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * missだけを直列生成し、全論理mutationを認証済みrecorderへawaitしてからphaseを閉じる。
 * @des DES-F005-006 @fun FUN-F005-017 @ut UT-F005-017
 */
export async function generateF005Voice(
  plan: F005VoicePlan,
  loopbackEngine: F005LoopbackEngine,
  stageRoot: string,
  capacityRecorder: F005CapacityRecorder,
  concurrency = 1,
  timeoutMs = 120_000,
): Promise<F005VoiceGenerationEvidence> {
  if (!voicePlans.has(plan) || plan.__brand !== 'F005VoicePlan' ||
    plan.planSha256 !== hash(canonical({
      schemaVersion: plan.schemaVersion,
      config: plan.config,
      configHash: plan.configHash,
      entries: plan.entries,
      reuseCount: plan.reuseCount,
      generateCount: plan.generateCount,
      estimatedGenerateBytes: plan.estimatedGenerateBytes,
    })) || !capacityRecorders.has(capacityRecorder) || concurrency !== 1 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail('F005_VOICE_GENERATION_INVALID', 'mint済みplan/recorderとconcurrency=1が必要です');
  }
  fixedConfig(plan.config, 'F005_VOICE_GENERATION_INVALID');
  let engineConfig: { config: VoiceConfigV2; configHash: string };
  try {
    engineConfig = fixedConfig(loopbackEngine.config, 'F005_VOICE_GENERATION_INVALID');
  } catch (error) {
    if (error instanceof F005VoiceError) throw error;
    return fail('F005_VOICE_GENERATION_INVALID', 'engine configを検証できません', error);
  }
  if (!(loopbackEngine.baseUrl instanceof URL) ||
    !['http://127.0.0.1:50021/', 'http://[::1]:50021/'].includes(loopbackEngine.baseUrl.href) ||
    engineConfig.configHash !== plan.configHash ||
    typeof loopbackEngine.getVersion !== 'function' || typeof loopbackEngine.getSpeakers !== 'function' ||
    typeof loopbackEngine.createAudioQuery !== 'function' || typeof loopbackEngine.synthesize !== 'function' ||
    !isAbsolute(stageRoot)) {
    fail('F005_VOICE_GENERATION_INVALID', 'loopback engine/config/stageRootが不正です');
  }
  const root = resolve(stageRoot);
  const phaseInstanceId = hash(`${plan.planSha256}\0${capacityRecorder.journalId}\0voice`);
  const assets: F005VoiceGenerationEvidence['assets'][number][] = [];
  const created: string[] = [];
  let stagedBytes = 0;
  let rootCreated = false;
  let sequence = 0;
  let begun = false;
  const notice = async (
    kind: F005MutationKind,
    path: string,
    targetPath: string | null,
    bytes: number,
    sha256: string | null,
  ): Promise<void> => {
    sequence += 1;
    const noticeId = hash(`${phaseInstanceId}\0${sequence}\0${kind}\0${path}\0${targetPath ?? ''}`);
    await capacityRecorder.observeMutation(freezeDeep({
      noticeId,
      sequence,
      phase: 'voice',
      phaseInstanceId,
      kind,
      path,
      targetPath,
      sha256,
      bytes,
    }));
  };
  try {
    const [version, speakers] = await withTimeout(Promise.all([
      loopbackEngine.getVersion(),
      loopbackEngine.getSpeakers(),
    ]), timeoutMs);
    const speaker = speakers.filter((item) =>
      item.speaker_uuid?.toLowerCase() === F002_VOICE_CONFIG.speakerUuid &&
      item.name === F002_VOICE_CONFIG.speakerName);
    const style = speaker[0]?.styles?.filter((item) =>
      item.id === F002_VOICE_CONFIG.styleId && item.name === F002_VOICE_CONFIG.styleName);
    if (version !== F002_VOICE_CONFIG.engineVersion || speaker.length !== 1 || style?.length !== 1) {
      fail('F005_VOICE_GENERATION_INVALID', 'VOICEVOX engine/speaker/styleが固定tupleと一致しません');
    }
    await capacityRecorder.beginPhase('voice', null, phaseInstanceId);
    begun = true;
    await mkdir(root, { recursive: false });
    rootCreated = true;
    await notice('create', root, null, 0, null);
    for (const entry of plan.entries) {
      if (entry.action === 'reuse') {
        if (!entry.existing) fail('F005_VOICE_GENERATION_INVALID', 'reuse実体がありません');
        assets.push({
          audioId: entry.audioId,
          path: entry.existing.path,
          sha256: entry.existing.sha256,
          bytes: entry.existing.bytes,
          durationMs: entry.existing.durationMs,
          source: 'reuse',
        });
        continue;
      }
      const query = await withTimeout(loopbackEngine.createAudioQuery(entry.speechText), timeoutMs);
      const wav = await withTimeout(loopbackEngine.synthesize(query), timeoutMs);
      if (!(wav instanceof Uint8Array) || wav.byteLength > F005_VOICE_LIMITS.wavBytes) {
        fail('F005_VOICE_GENERATION_INVALID', 'VOICEVOX responseがWAV上限を超えるか不正です');
      }
      if (stagedBytes + wav.byteLength > F005_VOICE_LIMITS.addedAudioBytes) {
        fail('F005_VOICE_GENERATION_INVALID', 'VOICEVOX応答の追加audio累計が100 MiBを超えます');
      }
      let durationMs: number;
      try {
        durationMs = inspectWav(wav).durationMs;
      } catch (error) {
        return fail('F005_VOICE_GENERATION_INVALID', 'VOICEVOX responseがPCM WAVではありません', error);
      }
      if (durationMs > F005_VOICE_LIMITS.durationMs) {
        fail('F005_VOICE_GENERATION_INVALID', 'VOICEVOX responseがduration上限を超えます');
      }
      const digest = hash(wav);
      const temporary = join(root, `.${entry.audioId}.${phaseInstanceId}.tmp`);
      const destination = join(root, `${entry.audioId}.wav`);
      await writeFile(temporary, wav, { flag: 'wx' });
      created.push(temporary);
      await notice('create', temporary, null, wav.byteLength, digest);
      await rename(temporary, destination);
      created.splice(created.indexOf(temporary), 1);
      created.push(destination);
      stagedBytes += wav.byteLength;
      await notice('rename', temporary, destination, wav.byteLength, digest);
      assets.push({
        audioId: entry.audioId,
        path: destination,
        sha256: digest,
        bytes: wav.byteLength,
        durationMs,
        source: 'staging',
      });
    }
    await capacityRecorder.endPhase('voice', phaseInstanceId);
    const payload = { planSha256: plan.planSha256, phaseInstanceId, assets };
    return freezeDeep({
      __brand: 'F005VoiceGenerationEvidence' as const,
      ...payload,
      evidenceSha256: hash(canonical(payload)),
    });
  } catch (error) {
    for (const path of created.reverse()) {
      try {
        await rm(path, { force: true });
        if (begun) await notice('delete', path, null, 0, null);
      } catch {
        // cleanup/notice失敗もphase未完了のままにし、元のcache/publicは変更しない。
      }
    }
    if (rootCreated) {
      try {
        await rmdir(root);
        if (begun) await notice('delete', root, null, 0, null);
      } catch {
        // phaseは未完了のままにする。
      }
    }
    if (error instanceof F005VoiceError) throw error;
    return fail('F005_VOICE_GENERATION_INVALID', '音声生成phaseを完了できません', error);
  }
}

export type F005CapacityPhase = 'voice' | 'preview' | 'accept' | 'build';

export interface F005CapacityJournalEvent {
  readonly sequence: number;
  readonly phase: F005CapacityPhase;
  readonly phaseInstanceId: string;
  readonly source: 'notice-etw' | 'etw-only';
  readonly noticeId: string | null;
  readonly workerPid: number;
  readonly path: string;
  readonly sha256: string | null;
  readonly timestamp: string;
  readonly freeBytes: number;
  readonly liveBytes: number;
}

export interface F005ClosedCapacityJournal {
  readonly schemaVersion: 3;
  readonly state: 'closed';
  readonly journalId: string;
  readonly candidateSha256: string;
  readonly workspaceRoot: string;
  readonly distRoot: string;
  readonly allowedWorkerPids: readonly number[];
  readonly phases: readonly {
    readonly phase: F005CapacityPhase;
    readonly phaseInstanceId: string;
    readonly beganAt: string;
    readonly endedAt: string;
  }[];
  readonly events: readonly F005CapacityJournalEvent[];
  readonly entries: readonly (CapacityEntry & { readonly bucket: CapacityBucket['kind'] })[];
  readonly initialFreeBytes: number;
  readonly sealSha256: string;
}

export interface F005CapacityJournalReader {
  readClosedCapacityJournal(workspace: string): Promise<F005ClosedCapacityJournal>;
}

export interface F005NativeCapacityJournalBinding {
  readonly journalId: string;
  readonly journalPath: string;
  readonly candidateSha256: string;
  readonly workspaceRoot: string;
  readonly distRoot: string;
  readonly entries: readonly (CapacityEntry & { readonly bucket: CapacityBucket['kind'] })[];
}

export interface CapacityActualV3 {
  readonly schemaVersion: 3;
  readonly candidateSha256: string;
  readonly journalSha256: string;
  readonly minimumObservedFreeBytes: number;
  readonly peakLiveBytes: number;
  readonly buckets: readonly CapacityBucket[];
  readonly state: 'closed';
}

function journalPayload(journal: Omit<F005ClosedCapacityJournal, 'sealSha256'>): string {
  return canonical(journal);
}

/** test/native readerが検証済みbytesからclosed journalをmintする境界。 */
export function sealF005CapacityJournal(
  journal: Omit<F005ClosedCapacityJournal, 'sealSha256'>,
): F005ClosedCapacityJournal {
  assertPlainDataTree(journal, 'F005_CAPACITY_ACTUAL_INVALID', 'capacity journal');
  const sealed = freezeDeep({ ...journal, sealSha256: hash(journalPayload(journal)) });
  closedJournals.add(sealed);
  return sealed;
}

function nativeJournalPhaseRows(journal: CapacityJournalV3): F005ClosedCapacityJournal['phases'] {
  const pairs = new Map<string, {
    phase: F005CapacityPhase;
    beganAt?: string;
    endedAt?: string;
  }>();
  const order: string[] = [];
  for (const row of journal.phases) {
    assertDataObject(row, 'F005_CAPACITY_ACTUAL_INVALID', 'native phase row');
    assertExactKeys(row, [
      'freeBytes',
      'liveBytes',
      'observedAt',
      'phase',
      'phaseInstanceId',
      'state',
      'workId',
    ], 'F005_CAPACITY_ACTUAL_INVALID', 'native phase row');
    const phase = row.phase;
    const phaseInstanceId = row.phaseInstanceId;
    const state = row.state;
    const observedAt = row.observedAt;
    if (!['voice', 'preview', 'accept', 'build'].includes(String(phase)) ||
      typeof phaseInstanceId !== 'string' || !SHA256.test(phaseInstanceId) ||
      !['started', 'finished'].includes(String(state)) ||
      typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
      fail('F005_CAPACITY_ACTUAL_INVALID', 'native phase rowが不正です');
    }
    const key = phaseInstanceId;
    const existing = pairs.get(key) ?? { phase: phase as F005CapacityPhase };
    if (existing.phase !== phase ||
      (state === 'started' ? existing.beganAt !== undefined : existing.endedAt !== undefined)) {
      fail('F005_CAPACITY_ACTUAL_INVALID', 'native phase pairが重複または不一致です');
    }
    if (!pairs.has(key)) {
      pairs.set(key, existing);
      order.push(key);
    }
    if (state === 'started') existing.beganAt = observedAt;
    else existing.endedAt = observedAt;
  }
  return order.map((phaseInstanceId) => {
    const pair = pairs.get(phaseInstanceId)!;
    if (!pair.beganAt || !pair.endedAt || Date.parse(pair.beganAt) > Date.parse(pair.endedAt)) {
      fail('F005_CAPACITY_ACTUAL_INVALID', 'native phase pairが閉じていません');
    }
    return freezeDeep({
      phase: pair.phase,
      phaseInstanceId,
      beganAt: pair.beganAt,
      endedAt: pair.endedAt,
    });
  });
}

/**
 * CapacityJournalV3を既存のactual測定境界へ接続するproduction reader。
 * native journalを毎回diskから再読込し、自己申告値ではなく検証済みETW列を変換する。
 */
export function createF005NativeCapacityJournalReader(
  binding: F005NativeCapacityJournalBinding,
): F005CapacityJournalReader {
  assertPlainDataTree(binding, 'F005_CAPACITY_ACTUAL_INVALID', 'native journal binding');
  assertExactKeys(binding, [
    'candidateSha256',
    'distRoot',
    'entries',
    'journalId',
    'journalPath',
    'workspaceRoot',
  ], 'F005_CAPACITY_ACTUAL_INVALID', 'native journal binding');
  const workspaceRoot = resolve(binding.workspaceRoot);
  const distRoot = resolve(binding.distRoot);
  const distRelative = relative(workspaceRoot, distRoot).replaceAll('\\', '/');
  if (!isAbsolute(binding.workspaceRoot) || workspaceRoot !== binding.workspaceRoot ||
    !isAbsolute(binding.distRoot) || distRoot !== binding.distRoot ||
    !distRelative || distRelative === '..' || distRelative.startsWith('../') ||
    !SHA256.test(binding.journalId) || !SHA256.test(binding.candidateSha256) ||
    binding.journalPath !== `.cache/f005-capacity/${binding.journalId}.json` ||
    !Array.isArray(binding.entries)) {
    fail('F005_CAPACITY_ACTUAL_INVALID', 'native journal bindingが不正です');
  }
  const fixed = freezeDeep(structuredClone(binding));
  return Object.freeze({
    async readClosedCapacityJournal(workspace: string): Promise<F005ClosedCapacityJournal> {
      if (!isAbsolute(workspace) || resolve(workspace) !== fixed.workspaceRoot) {
        fail('F005_CAPACITY_ACTUAL_INVALID', 'native journal workspace bindingが一致しません');
      }
      const journal = await readF005NativeCapacityJournalFile(
        fixed.workspaceRoot,
        fixed.journalPath,
      );
      const phases = nativeJournalPhaseRows(journal);
      const noticeIds = new Map<number, string>();
      for (const envelope of journal.notices) {
        const notice = envelope.notice as Record<string, unknown>;
        noticeIds.set(Number(envelope.noticeSequence), String(notice.noticeId));
      }
      const events = journal.observations.map((observation): F005CapacityJournalEvent => {
        const event = String(observation.event);
        const path = String(event === 'rename' ? observation.to : observation.path);
        const noticeSequence = Number.isSafeInteger(observation.noticeSequence)
          ? Number(observation.noticeSequence)
          : null;
        const noticeId = noticeSequence === null ? null : noticeIds.get(noticeSequence);
        if (noticeSequence !== null &&
          (typeof noticeId !== 'string' || !SHA256.test(noticeId))) {
          fail('F005_CAPACITY_ACTUAL_INVALID', 'native observation notice bindingが不正です');
        }
        if (!SAFE_PATH.test(path) ||
          typeof observation.observedAt !== 'string' ||
          !Number.isFinite(Date.parse(observation.observedAt))) {
          fail('F005_CAPACITY_ACTUAL_INVALID', 'native observation bridgeが不正です');
        }
        return freezeDeep({
          sequence: Number(observation.etwSequence),
          phase: observation.phase as F005CapacityPhase,
          phaseInstanceId: String(observation.phaseInstanceId),
          source: noticeId === null ? 'etw-only' as const : 'notice-etw' as const,
          noticeId: noticeId ?? null,
          workerPid: Number(observation.workerPid),
          path,
          sha256: typeof observation.sha256 === 'string' ? observation.sha256 : null,
          timestamp: observation.observedAt,
          freeBytes: Number(observation.freeBytesAvailable),
          liveBytes: Number(observation.liveBytes),
        });
      });
      const allowedWorkerPids = [...new Set(events.map((event) => event.workerPid))]
        .sort((left, right) => left - right);
      return sealF005CapacityJournal({
        schemaVersion: 3,
        state: 'closed',
        journalId: fixed.journalId,
        candidateSha256: fixed.candidateSha256,
        workspaceRoot: fixed.workspaceRoot,
        distRoot: fixed.distRoot,
        allowedWorkerPids,
        phases,
        events,
        entries: fixed.entries,
        initialFreeBytes: journal.initialFreeBytes,
      });
    },
  });
}

function total(entries: readonly CapacityEntry[], maximum = false): number {
  const values = entries.map((entry) => entry.bytes);
  const result = maximum ? Math.max(0, ...values) : values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) fail('F005_CAPACITY_ACTUAL_INVALID', 'capacity totalがsafe integerではありません');
  return result;
}

/**
 * native readerが再読込したclosed journalだけから実測容量を導く。
 * @des DES-F005-006 @fun FUN-F005-019 @ut UT-F005-019
 */
export async function measureF005ActualCapacity(
  workspace: string,
  dist: string,
  acceptedAudio: readonly { readonly path: string; readonly sha256: string }[],
  gitAdapter: F005CapacityJournalReader,
): Promise<CapacityActualV3> {
  if (!isAbsolute(workspace) || !isAbsolute(dist) || !Array.isArray(acceptedAudio)) {
    fail('F005_CAPACITY_ACTUAL_INVALID', 'workspace/dist/acceptedAudioが不正です');
  }
  let journal: F005ClosedCapacityJournal;
  try {
    journal = await gitAdapter.readClosedCapacityJournal(resolve(workspace));
  } catch (error) {
    return fail('F005_CAPACITY_ACTUAL_INVALID', 'closed journalを再読込できません', error);
  }
  if (!closedJournals.has(journal) || journal.state !== 'closed' || journal.schemaVersion !== 3 ||
    journal.workspaceRoot !== resolve(workspace) || journal.distRoot !== resolve(dist) ||
    !SHA256.test(journal.journalId) || !SHA256.test(journal.candidateSha256) ||
    journal.sealSha256 !== hash(journalPayload({
      schemaVersion: journal.schemaVersion,
      state: journal.state,
      journalId: journal.journalId,
      candidateSha256: journal.candidateSha256,
      workspaceRoot: journal.workspaceRoot,
      distRoot: journal.distRoot,
      allowedWorkerPids: journal.allowedWorkerPids,
      phases: journal.phases,
      events: journal.events,
      entries: journal.entries,
      initialFreeBytes: journal.initialFreeBytes,
    }))) {
    fail('F005_CAPACITY_ACTUAL_INVALID', 'journalのbrand/binding/sealが不正です');
  }
  const phaseKinds = new Set(journal.phases.map((phase) => phase.phase));
  if (!(['voice', 'preview', 'accept', 'build'] as const).every((phase) => phaseKinds.has(phase)) ||
    journal.allowedWorkerPids.length === 0 ||
    !journal.allowedWorkerPids.every((pid) => Number.isSafeInteger(pid) && pid > 0) ||
    !Number.isSafeInteger(journal.initialFreeBytes) || journal.initialFreeBytes < 0) {
    fail('F005_CAPACITY_ACTUAL_INVALID', 'journalのphase/PID/initial freeが不完全です');
  }
  const phaseInstances = new Map<string, F005CapacityPhase>();
  for (const phase of journal.phases) {
    if (!SHA256.test(phase.phaseInstanceId) || !Number.isFinite(Date.parse(phase.beganAt)) ||
      !Number.isFinite(Date.parse(phase.endedAt)) || Date.parse(phase.beganAt) > Date.parse(phase.endedAt) ||
      phaseInstances.has(phase.phaseInstanceId)) {
      fail('F005_CAPACITY_ACTUAL_INVALID', 'journal phaseのinstance/timeが不正です');
    }
    phaseInstances.set(phase.phaseInstanceId, phase.phase);
  }
  const noticeIds = new Map<string, string>();
  for (const [index, event] of journal.events.entries()) {
    if (event.sequence !== index + 1 ||
      phaseInstances.get(event.phaseInstanceId) !== event.phase ||
      !journal.allowedWorkerPids.includes(event.workerPid) ||
      !Number.isSafeInteger(event.freeBytes) || event.freeBytes < 0 ||
      !Number.isSafeInteger(event.liveBytes) || event.liveBytes < 0 ||
      !SAFE_PATH.test(event.path) || !Number.isFinite(Date.parse(event.timestamp)) ||
      (event.source === 'notice-etw' ? !event.noticeId || !SHA256.test(event.noticeId) : event.noticeId !== null)) {
      fail('F005_CAPACITY_ACTUAL_INVALID', 'journal eventにgap/loss/PID逸脱/不正値があります');
    }
    if (event.noticeId !== null) {
      const phaseInstanceId = noticeIds.get(event.noticeId);
      if (phaseInstanceId !== undefined && phaseInstanceId !== event.phaseInstanceId) {
        fail('F005_CAPACITY_ACTUAL_INVALID', 'notice IDが別phaseで再利用されています');
      }
      noticeIds.set(event.noticeId, event.phaseInstanceId);
    }
  }
  const entryIdentities = new Set<string>();
  for (const entry of journal.entries) {
    const validKind = (entry.bucket === 'audio' || entry.bucket === 'artifact' || entry.bucket === 'workspace-peak')
      ? entry.kind === 'path'
      : entry.bucket === 'repository'
        ? entry.kind === 'git-index'
        : entry.bucket === 'object'
          ? entry.kind === 'git-object'
          : false;
    const pathValid = entry.kind === 'path' || entry.kind === 'git-index' ? SAFE_PATH.test(entry.path) : true;
    const oidValid = entry.kind === 'git-index' || entry.kind === 'git-object'
      ? /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(entry.oid)
      : true;
    const identity = entry.kind === 'path' ? `${entry.bucket}:path:${entry.path}`
      : entry.kind === 'git-index' ? `${entry.bucket}:index:${entry.path}:${entry.oid}`
        : entry.kind === 'git-object' ? `${entry.bucket}:object:${entry.oid}`
          : `${entry.bucket}:planned-audio:${entry.path}:${entry.planSha256}`;
    if (!validKind || !pathValid || !oidValid || !SHA256.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entryIdentities.has(identity)) {
      fail('F005_CAPACITY_ACTUAL_INVALID', 'journal capacity entryが不正または重複しています');
    }
    entryIdentities.add(identity);
  }
  const audioEntries = journal.entries.filter((entry) => entry.bucket === 'audio');
  const accepted = [...acceptedAudio].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const measuredAudio = audioEntries.map((entry) => ({ path: 'path' in entry ? entry.path : '', sha256: entry.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (canonical(accepted) !== canonical(measuredAudio)) {
    fail('F005_CAPACITY_ACTUAL_INVALID', 'accepted audioとjournal path/hashが一致しません');
  }
  const bucketKinds: CapacityBucket['kind'][] =
    ['audio', 'artifact', 'repository', 'object', 'workspace-peak', 'free-after-peak'];
  const minimumObservedFreeBytes = Math.min(journal.initialFreeBytes, ...journal.events.map((event) => event.freeBytes));
  const peakLiveBytes = Math.max(0, ...journal.events.map((event) => event.liveBytes));
  const buckets = bucketKinds.map((kind) => {
    const entries = journal.entries.filter((entry) => entry.bucket === kind)
      .map((entry): CapacityEntry => entry.kind === 'path'
        ? freezeDeep({ kind: entry.kind, path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })
        : entry.kind === 'planned-audio'
          ? freezeDeep({
            kind: entry.kind,
            path: entry.path,
            bytes: entry.bytes,
            sha256: entry.sha256,
            planSha256: entry.planSha256,
          })
        : entry.kind === 'git-index'
          ? freezeDeep({
            kind: entry.kind,
            path: entry.path,
            oid: entry.oid,
            bytes: entry.bytes,
            sha256: entry.sha256,
          })
          : freezeDeep({ kind: entry.kind, oid: entry.oid, bytes: entry.bytes, sha256: entry.sha256 }));
    const totalBytes = kind === 'object' ? total(entries, true)
      : kind === 'workspace-peak' ? peakLiveBytes
        : kind === 'free-after-peak' ? minimumObservedFreeBytes
          : total(entries);
    return freezeDeep({ kind, entries, totalBytes });
  });
  const payload = {
    schemaVersion: 3 as const,
    candidateSha256: journal.candidateSha256,
    journalSha256: journal.sealSha256,
    minimumObservedFreeBytes,
    peakLiveBytes,
    buckets,
    state: 'closed' as const,
  };
  return freezeDeep(payload);
}

export {
  forecastF005Capacity,
  type CapacityForecastV3,
  type F005CandidateHashes,
  type F005CapacityPlan,
  type V040Baseline,
};
