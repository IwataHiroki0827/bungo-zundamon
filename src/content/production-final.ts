import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { validateReleaseNotices } from '../notices/release-notices.ts';
import type { ArtworkProvenanceManifest, LicenseManifest } from '../notices/types.ts';
import { estimateVoiceBudget, verifyAssetBudget, voiceInputDigest, type VoicePreflight } from '../voice/budget.ts';
import { validateVoiceConfig, voiceConfigHash } from '../voice/cache.ts';
import { ProductionVoicevoxClient } from '../voice/client.ts';
import { generateVoiceAssets, inspectWav } from '../voice/generation.ts';
import { MAX_SINGLE_ASSET_BYTES } from '../voice/types.ts';
import type { SpeechItem, VoiceConfig, VoiceGenerationResult } from '../voice/types.ts';
import { canonicalJson, writeJsonArtifactAtomic } from './artifacts.ts';
import type { StageResult, StageRunner, UpdateStage } from './pipeline.ts';
import {
  APPROVED_REVIEW_REASONS,
  PUBLIC_AUTHOR,
  REJECTED_REVIEW_REASONS,
  SOURCE_TRANSFORMATION,
  MAX_CATALOG_BYTES,
  applyEditorialReview,
  buildPublicCatalog,
  validateReview,
  type AssetManifest as CatalogAssetManifest,
  type Candidate,
  type ReviewRecord,
  type ReviewedContent,
} from './processing.ts';
import {
  PRODUCTION_ARTIFACTS,
  createProductionStageRunner,
  loadProductionCandidates,
  loadProductionSelectedWorks,
  loadProductionSourceRecords,
} from './production.ts';
import { INITIAL_WORK_IDS, type SelectedWork, type SourceRecord } from './source.ts';

export const FINAL_CONTENT_STAGES = ['review', 'voice-preflight', 'voice', 'build'] as const satisfies readonly UpdateStage[];
export const COMPLETE_PRODUCTION_CONTENT_STAGES = [
  'bibliography', 'select', 'sources', 'provenance', 'decode', 'extract', 'normalize',
  ...FINAL_CONTENT_STAGES,
] as const satisfies readonly UpdateStage[];

export const FIXED_VOICE_CONFIG: Readonly<VoiceConfig> = Object.freeze(validateVoiceConfig({
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
}));

export const VOICE_ESTIMATE_PROFILE = Object.freeze({
  // 初回の全28音声実測（216.525秒 / 1,234文字）に安全率1.2を加えた校正値。
  secondsPerCharacter: 0.210559,
  outputSamplingRate: 24_000,
  bitDepth: 16,
  channels: 1,
  wavHeaderBytes: 44,
  safetyFactor: 1,
  maxRelativeError: 0.2,
  config: FIXED_VOICE_CONFIG,
});

export const FINAL_ARTIFACTS = Object.freeze({
  reviewedContent: 'content/reviewed-content.json',
  voiceConfig: 'content/voice-config.json',
  voicePreflight: 'content/voice-preflight.json',
  voiceGeneration: 'content/voice-generation.json',
  assetManifest: 'content/asset-manifest.json',
  reviewEvidence: 'docs/evidence/content/CONTENT-F001-reviewed.json',
  voiceEvidence: 'docs/evidence/content/CONTENT-F001-voice-generation.json',
  buildEvidence: 'docs/evidence/content/CONTENT-F001-public-build.json',
  voiceCache: '.cache/voice/F001',
  publicTarget: 'public',
});

const REVIEW_REASON_SET = new Set<string>([...APPROVED_REVIEW_REASONS, ...REJECTED_REVIEW_REASONS]);
const VOICE_FAILURE_REASONS = new Set([
  'VOICE_TIMEOUT', 'VOICE_WAV_INVALID', 'VOICE_ZERO_BYTE', 'VOICE_HTTP_ERROR', 'VOICE_GENERATION_FAILED',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEW_KEYS = new Set([
  'candidateId', 'revision', 'status', 'reasonCode', 'note', 'reviewer', 'reviewedAt', 'policyCheckedAt',
]);
const REQUIRED_REVIEW_KEYS = [
  'candidateId', 'revision', 'status', 'reasonCode', 'reviewer', 'reviewedAt', 'policyCheckedAt',
] as const;
const EXPECTED_CANDIDATE_COUNT = 67;
const EXPECTED_APPROVED_COUNT = 59;
const EXPECTED_APPROVED_CHARACTERS = 3_342;
const MAX_FINAL_JSON_BYTES = 8_388_608;
const MAX_AUDIO_DURATION_MS = 86_400_000;

class FinalStageError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FinalStageError';
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashValue(value: unknown): string {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(value)));
}

function safeRelative(workspace: string, target: string): string {
  const relation = relative(resolve(workspace), resolve(target));
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new FinalStageError('FINAL_WORKSPACE_BOUNDARY', 'artifactがworkspace外です');
  }
  return relation.replaceAll('\\', '/');
}

async function readRegularJson<T>(workspace: string, path: string): Promise<T> {
  const root = resolve(workspace);
  const target = resolve(path);
  safeRelative(root, target);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_FINAL_JSON_BYTES) {
    throw new FinalStageError('FINAL_ARTIFACT_INVALID', 'JSON artifactのfile種別またはbyte上限が不正です');
  }
  const [physicalRoot, physicalTarget] = await Promise.all([realpath(root), realpath(target)]);
  safeRelative(physicalRoot, physicalTarget);
  const bytes = new Uint8Array(await readFile(target));
  if (bytes.byteLength !== info.size) throw new FinalStageError('FINAL_ARTIFACT_INVALID', 'JSON artifactが読込中に変更されました');
  return parseProductionJsonBytes<T>(bytes);
}

export function parseProductionJsonBytes<T>(bytes: Uint8Array): T {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FINAL_JSON_BYTES) {
    throw new FinalStageError('FINAL_ARTIFACT_INVALID', 'JSON artifactのbyte上限が不正です');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FinalStageError('FINAL_ARTIFACT_INVALID', 'JSON artifactが正しいUTF-8ではありません');
  }
  if (text.includes('\uFFFD')) throw new FinalStageError('FINAL_ARTIFACT_INVALID', 'JSON artifactに置換文字があります');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FinalStageError('FINAL_ARTIFACT_INVALID', 'JSON artifactをparseできません');
  }
}

function pathInside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export async function assertWorkspacePathSafe(workspace: string, target: string, allowMissing = false): Promise<void> {
  const lexicalRoot = resolve(workspace);
  const lexicalTarget = resolve(target);
  if (!pathInside(lexicalRoot, lexicalTarget)) throw new FinalStageError('FINAL_WORKSPACE_BOUNDARY', 'pathがworkspace外です');
  const rootInfo = await lstat(lexicalRoot);
  const physicalRoot = await realpath(lexicalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || physicalRoot !== lexicalRoot) {
    throw new FinalStageError('FINAL_WORKSPACE_BOUNDARY', 'workspaceが通常directoryではありません');
  }
  const components = relative(lexicalRoot, lexicalTarget).split(sep).filter(Boolean);
  let cursor = lexicalRoot;
  for (const component of components) {
    cursor = join(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new FinalStageError('FINAL_WORKSPACE_BOUNDARY', 'pathにsymlink/junctionがあります');
      const physical = await realpath(cursor);
      if (!pathInside(physicalRoot, physical)) throw new FinalStageError('FINAL_WORKSPACE_BOUNDARY', 'path実体がworkspace外です');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function assertStrictReviewRecord(value: unknown): asserts value is ReviewRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FinalStageError('REVIEW_SCHEMA_INVALID', 'review recordがobjectではありません');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !REVIEW_KEYS.has(key)) || REQUIRED_REVIEW_KEYS.some((key) => !(key in value))) {
    throw new FinalStageError('REVIEW_SCHEMA_INVALID', 'review recordに未知または欠落fieldがあります');
  }
  const review = value as ReviewRecord;
  if (typeof review.candidateId !== 'string' || typeof review.reviewer !== 'string' ||
      typeof review.reasonCode !== 'string' || typeof review.status !== 'string' ||
      typeof review.reviewedAt !== 'string' || typeof review.policyCheckedAt !== 'string' ||
      (review.note !== undefined && (typeof review.note !== 'string' || review.note.trim() === '')) ||
      !REVIEW_REASON_SET.has(review.reasonCode)) {
    throw new FinalStageError('REVIEW_SCHEMA_INVALID', 'review fieldが固定契約を満たしません');
  }
  validateReview(review);
}

async function loadStrictReviews(workspace: string, groups: readonly Candidate[][]): Promise<ReviewRecord[]> {
  const all: ReviewRecord[] = [];
  for (let index = 0; index < INITIAL_WORK_IDS.length; index += 1) {
    const workId = INITIAL_WORK_IDS[index]!;
    const candidates = groups[index] ?? [];
    const records = await readRegularJson<unknown>(workspace, join(workspace, PRODUCTION_ARTIFACTS.reviews, `${workId}.json`));
    all.push(...validateProductionReviewRecords(workId, candidates, records));
  }
  return all;
}

export function validateProductionReviewRecords(
  workId: string,
  candidates: readonly Candidate[],
  records: unknown,
): ReviewRecord[] {
  if (!INITIAL_WORK_IDS.includes(workId as (typeof INITIAL_WORK_IDS)[number]) ||
      candidates.some((candidate, order) => candidate.workId !== workId || candidate.order !== order ||
        !SHA256.test(candidate.rawSourceSha256) || candidate.sourceAnchor.endToken <= candidate.sourceAnchor.startToken)) {
    throw new FinalStageError('REVIEW_CANDIDATE_MISMATCH', `候補のwork/order/hash/anchorが不正です: ${workId}`);
  }
  if (!Array.isArray(records) || records.length !== candidates.length) {
    throw new FinalStageError('REVIEW_CANDIDATE_MISMATCH', `review件数が候補と一致しません: ${workId}`);
  }
  const expected = new Set(candidates.map((candidate) => candidate.candidateId));
  const seen = new Set<string>();
  const validated: ReviewRecord[] = [];
  for (const record of records) {
    assertStrictReviewRecord(record);
    if (!expected.has(record.candidateId) || seen.has(record.candidateId)) {
      throw new FinalStageError('REVIEW_CANDIDATE_MISMATCH', `review候補集合が一致しません: ${workId}`);
    }
    seen.add(record.candidateId);
    validated.push(record);
  }
  if (seen.size !== expected.size) throw new FinalStageError('REVIEW_CANDIDATE_MISMATCH', `review候補が欠落しています: ${workId}`);
  return validated;
}

function catalogSource(work: SelectedWork, source: SourceRecord) {
  return {
    cardUrl: work.cardUrl as string,
    textUrl: source.sourceUrl,
    attribution: `青空文庫『${work.title}』（芥川龍之介）`,
    baseEdition: work.baseEdition as string,
    inputter: work.inputter as string,
    proofreader: work.proofreader as string,
    fetchedAt: source.fetchedAt,
    transformation: SOURCE_TRANSFORMATION,
    sourceSha256: source.rawSha256,
  };
}

async function assembleReviewedContent(workspace: string): Promise<ReviewedContent> {
  const [groups, works, sources] = await Promise.all([
    loadProductionCandidates(workspace),
    loadProductionSelectedWorks(workspace),
    loadProductionSourceRecords(workspace),
  ]);
  const candidates = groups.flat();
  const reviews = await loadStrictReviews(workspace, groups);
  const review = applyEditorialReview(candidates, reviews);
  const approvedCharacters = review.approved.reduce((sum, item) => sum + Array.from(item.candidate.speechText).length, 0);
  if (
    candidates.length !== EXPECTED_CANDIDATE_COUNT || review.counts.approved !== EXPECTED_APPROVED_COUNT ||
    review.counts.rejected !== EXPECTED_CANDIDATE_COUNT - EXPECTED_APPROVED_COUNT || review.counts.pending !== 0 ||
    approvedCharacters !== EXPECTED_APPROVED_CHARACTERS
  ) {
    throw new FinalStageError('REVIEW_BASELINE_MISMATCH', '承認済み候補の固定baselineが一致しません');
  }
  return {
    schemaVersion: '1.0.0',
    author: {
      ...PUBLIC_AUTHOR,
      artwork: { ...PUBLIC_AUTHOR.artwork },
    },
    works: INITIAL_WORK_IDS.map((workId, index) => {
      const work = works[index];
      const source = sources[index];
      const group = groups[index];
      if (!work || work.workId !== workId || !source || source.workId !== workId || !group) {
        throw new FinalStageError('REVIEW_WORK_MISMATCH', `作品artifactの対応が不正です: ${workId}`);
      }
      return {
        workId,
        title: work.title,
        cardLink: work.cardUrl as string,
        source: catalogSource(work, source),
        candidateIds: group.map((candidate) => candidate.candidateId),
      };
    }),
    review,
    creditsRef: 'content/licenses.json',
    futureExpansionPolicy: {
      eligibilityCriteria: '著作権保護期間満了・青空文庫公開中・日本語原著・出典metadata完備をすべて満たす作品だけを候補にする',
      rightsRecheck: '追加時と公開前に本文・書誌・キャラクター・音声・画像の利用条件を再確認する',
      stagedAddition: '候補抽出、全件編集レビュー、音声容量preflight、生成、独立受け入れ試験を作品単位で完了してから追加する',
    },
  };
}

function speechItems(reviewed: ReviewedContent): SpeechItem[] {
  return reviewed.review.approved.map(({ candidate }) => ({
    candidateId: candidate.candidateId,
    speechText: candidate.speechText,
    approved: true,
    config: FIXED_VOICE_CONFIG,
  }));
}

function assertReviewedArtifact(value: ReviewedContent): void {
  if (hashValue(value) === hashValue({})) throw new FinalStageError('REVIEWED_CONTENT_INVALID', 'reviewed contentが不正です');
  const items = speechItems(value);
  if (items.length !== EXPECTED_APPROVED_COUNT ||
      items.reduce((sum, item) => sum + Array.from(item.speechText ?? '').length, 0) !== EXPECTED_APPROVED_CHARACTERS) {
    throw new FinalStageError('REVIEWED_CONTENT_INVALID', 'reviewed contentの件数または文字数が不正です');
  }
}

function assertFixedVoiceConfig(value: VoiceConfig): void {
  if (voiceConfigHash(value) !== voiceConfigHash(FIXED_VOICE_CONFIG) || canonicalJson(value) !== canonicalJson(FIXED_VOICE_CONFIG)) {
    throw new FinalStageError('VOICE_CONFIG_MISMATCH', 'repository固定VoiceConfigが一致しません');
  }
}

const PREFLIGHT_KEYS = [
  'status', 'canGenerate', 'warning', 'candidateCount', 'uniqueAudioCount', 'totalCharacters', 'estimatedSeconds',
  'estimatedBytes', 'warningThresholdBytes', 'hardLimitBytes', 'profileUpdateRequired', 'reasonCodes', 'configHash',
  'inputDigest',
] as const;

function preflightCore(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(PREFLIGHT_KEYS.map((key) => [key, value[key]]));
}

export function assertPreflight(preflight: VoicePreflight, items: SpeechItem[]): void {
  if (preflight === null || typeof preflight !== 'object' || Array.isArray(preflight)) {
    throw new FinalStageError('VOICE_PREFLIGHT_MISMATCH', '音声preflightがobjectではありません');
  }
  const expected = estimateVoiceBudget(items, VOICE_ESTIMATE_PROFILE);
  if (canonicalJson(preflightCore(preflight as unknown as Record<string, unknown>)) !==
      canonicalJson(preflightCore(expected as unknown as Record<string, unknown>)) ||
    !expected.canGenerate || expected.status !== 'ok' || expected.warning || expected.profileUpdateRequired ||
    expected.candidateCount !== EXPECTED_APPROVED_COUNT || expected.configHash !== voiceConfigHash(FIXED_VOICE_CONFIG) ||
    expected.inputDigest !== voiceInputDigest(items, FIXED_VOICE_CONFIG) || expected.warningThresholdBytes !== 500_000_000 ||
    expected.hardLimitBytes !== 750_000_000) {
    throw new FinalStageError('VOICE_PREFLIGHT_MISMATCH', '音声preflightが固定入力と一致しません');
  }
}

function storedProfile(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(VOICE_ESTIMATE_PROFILE).filter(([key]) => key !== 'config'));
}

function assertStoredPreflight(value: VoicePreflight & Record<string, unknown>, items: SpeechItem[]): void {
  assertPreflight(value, items);
  if (value.schemaVersion !== '1.0.0' || value.approvedCharacters !== EXPECTED_APPROVED_CHARACTERS ||
      canonicalJson(value.profile) !== canonicalJson(storedProfile())) {
    throw new FinalStageError('VOICE_PREFLIGHT_MISMATCH', '保存preflightのprofile証跡が固定値と一致しません');
  }
}

function relativeError(estimated: number, actual: number): number {
  if (!Number.isFinite(estimated) || estimated <= 0 || !Number.isFinite(actual) || actual < 0) return Number.POSITIVE_INFINITY;
  return Math.abs(actual - estimated) / estimated;
}

function voiceCalibration(preflight: VoicePreflight, generation: VoiceGenerationResult) {
  const actualBytes = generation.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const actualDurationMs = generation.assets.reduce((sum, asset) => sum + asset.durationMs, 0);
  const actualSeconds = actualDurationMs / 1_000;
  const byteRelativeError = relativeError(preflight.estimatedBytes, actualBytes);
  const durationRelativeError = relativeError(preflight.estimatedSeconds, actualSeconds);
  const maximumRelativeError = Math.max(byteRelativeError, durationRelativeError);
  const recommendedSecondsPerCharacter = preflight.totalCharacters > 0
    ? Number(((actualSeconds / preflight.totalCharacters) * 1.2).toFixed(6))
    : 0;
  return {
    status: generation.failed === 0 && maximumRelativeError <= 0.2 ? 'ok' : 'profile-update-required',
    maxAllowedRelativeError: 0.2,
    estimatedBytes: preflight.estimatedBytes,
    actualBytes,
    byteRelativeError,
    estimatedSeconds: preflight.estimatedSeconds,
    actualDurationMs,
    actualSeconds,
    durationRelativeError,
    maximumRelativeError,
    uniqueCharacters: preflight.totalCharacters,
    recommendedSecondsPerCharacter,
    safetyMargin: 1.2,
  } as const;
}

function assertVoiceCalibrationEvidence(
  evidence: Record<string, unknown>,
  preflight: VoicePreflight,
  generation: VoiceGenerationResult,
): void {
  const expected = voiceCalibration(preflight, generation);
  if (evidence.schemaVersion !== '1.0.0' || evidence.generationSha256 !== hashValue(generation) ||
      evidence.configHash !== generation.configHash || evidence.inputDigest !== preflight.inputDigest ||
      canonicalJson(evidence.calibration) !== canonicalJson(expected) || expected.status !== 'ok') {
    throw new FinalStageError('VOICE_PROFILE_UPDATE_REQUIRED', '実測誤差が20%を超えるか、校正証跡が生成結果と一致しません');
  }
}

export function assertVoiceGeneration(value: VoiceGenerationResult, items: SpeechItem[]): void {
  const ids = new Set(items.map((item) => item.candidateId));
  if (value === null || typeof value !== 'object' || !Array.isArray(value.assets) || !Array.isArray(value.failures) ||
      !Number.isSafeInteger(value.attempted) || !Number.isSafeInteger(value.succeeded) || !Number.isSafeInteger(value.failed)) {
    throw new FinalStageError('VOICE_RESULT_INVALID', '音声生成結果のschemaが不正です');
  }
  if (
    value.configHash !== voiceConfigHash(FIXED_VOICE_CONFIG) || value.attempted !== value.succeeded + value.failed ||
    value.succeeded !== value.assets.length || value.failed !== value.failures.length ||
    value.attempted !== new Set([...value.assets.map((asset) => asset.audioId), ...value.failures.map((failure) => failure.audioId)]).size
  ) throw new FinalStageError('VOICE_RESULT_INVALID', '音声生成結果の集計が不正です');
  const referenced = new Set<string>();
  const audioIds = new Set<string>();
  const paths = new Set<string>();
  for (const asset of value.assets) {
    const candidateIds = new Set(asset.candidateIds);
    if (!SHA256.test(asset.audioId) || audioIds.has(asset.audioId) || paths.has(asset.path) ||
        asset.path !== `audio/F001/${asset.audioId}.wav` || !SHA256.test(asset.sha256) ||
        asset.configHash !== value.configHash || asset.candidateIds.length === 0 || candidateIds.size !== asset.candidateIds.length ||
        !Number.isSafeInteger(asset.bytes) || asset.bytes < 44 || asset.bytes >= MAX_SINGLE_ASSET_BYTES ||
        !Number.isSafeInteger(asset.durationMs) || asset.durationMs <= 0 || asset.durationMs > MAX_AUDIO_DURATION_MS ||
        asset.candidateIds.some((id) => !ids.has(id) || referenced.has(id))) {
      throw new FinalStageError('VOICE_RESULT_INVALID', '音声assetの参照が不正です');
    }
    audioIds.add(asset.audioId);
    paths.add(asset.path);
    asset.candidateIds.forEach((id) => referenced.add(id));
  }
  for (const failure of value.failures) {
    const candidateIds = new Set(failure.candidateIds);
    if (!SHA256.test(failure.audioId) || audioIds.has(failure.audioId) || !VOICE_FAILURE_REASONS.has(failure.reasonCode) ||
        failure.candidateIds.length === 0 || candidateIds.size !== failure.candidateIds.length ||
        failure.candidateIds.some((id) => !ids.has(id) || referenced.has(id))) {
      throw new FinalStageError('VOICE_RESULT_INVALID', '音声失敗理由または参照が不正です');
    }
    audioIds.add(failure.audioId);
    failure.candidateIds.forEach((id) => referenced.add(id));
  }
  if (referenced.size !== ids.size) throw new FinalStageError('VOICE_RESULT_INVALID', 'approved候補に音声結果がありません');
}

async function verifyCachedVoice(workspace: string, generation: VoiceGenerationResult): Promise<void> {
  const cache = join(workspace, FINAL_ARTIFACTS.voiceCache);
  await assertWorkspacePathSafe(workspace, cache);
  for (const asset of generation.assets) {
    const expectedPath = `audio/F001/${asset.audioId}.wav`;
    if (asset.path !== expectedPath || !SHA256.test(asset.audioId)) {
      throw new FinalStageError('VOICE_RESULT_INVALID', '音声pathまたはaudioIdが不正です');
    }
    const path = join(cache, `${asset.audioId}.wav`);
    await assertWorkspacePathSafe(workspace, path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new FinalStageError('VOICE_CACHE_INVALID', 'cache WAVが通常fileではありません');
    const wav = new Uint8Array(await readFile(path));
    const inspected = inspectWav(wav);
    if (wav.byteLength !== asset.bytes || sha256Bytes(wav) !== asset.sha256 || inspected.durationMs !== asset.durationMs) {
      throw new FinalStageError('VOICE_CACHE_INVALID', 'cache WAVのhash/bytes/durationが生成manifestと一致しません');
    }
  }
}

async function assertSourceProvenance(workspace: string, works: readonly SelectedWork[], sources: readonly SourceRecord[]): Promise<unknown> {
  const provenance = await readRegularJson<Record<string, unknown>>(workspace, join(workspace, PRODUCTION_ARTIFACTS.provenance));
  if (!Array.isArray(provenance.works) || provenance.works.length !== INITIAL_WORK_IDS.length) {
    throw new FinalStageError('PROVENANCE_INVALID', '原典provenanceが固定3作品を含みません');
  }
  for (let index = 0; index < INITIAL_WORK_IDS.length; index += 1) {
    const item = provenance.works[index] as Record<string, unknown> | undefined;
    const work = works[index];
    const source = sources[index];
    if (!item || !work || !source || item.workId !== work.workId || item.sourceSha256 !== source.rawSha256 ||
        item.sourceUrl !== source.sourceUrl || item.stableCardUrl !== work.cardUrl || item.baseEdition !== work.baseEdition ||
        item.inputter !== work.inputter || item.proofreader !== work.proofreader || item.fetchedAt !== source.fetchedAt ||
        item.transformation !== SOURCE_TRANSFORMATION) {
      throw new FinalStageError('PROVENANCE_INVALID', '原典provenanceとsource artifactが一致しません');
    }
  }
  return provenance;
}

async function createPublicStaging(
  workspace: string,
  reviewed: ReviewedContent,
  generation: VoiceGenerationResult,
): Promise<{ stagingPath: string; catalogHash: string; totalBytes: number; totalDurationMs: number; assetManifest: unknown }> {
  await verifyCachedVoice(workspace, generation);
  const [licenses, artworkProvenance, works, sources] = await Promise.all([
    readRegularJson<LicenseManifest>(workspace, join(workspace, 'content/licenses.json')),
    readRegularJson<ArtworkProvenanceManifest>(workspace, join(workspace, 'content/artwork-provenance.json')),
    loadProductionSelectedWorks(workspace),
    loadProductionSourceRecords(workspace),
  ]);
  const validation = validateReleaseNotices(licenses, artworkProvenance, new Date());
  if (!validation.ok || !validation.value) throw new FinalStageError('LICENSE_MANIFEST_INVALID', '権利・クレジットmanifestが不正です');
  const provenance = await assertSourceProvenance(workspace, works, sources);
  const candidateAudio = Object.fromEntries(generation.assets.flatMap((asset) =>
    asset.candidateIds.map((candidateId) => [candidateId, asset.audioId])));
  const audioManifest: CatalogAssetManifest = { assets: generation.assets, candidateAudio };
  const catalog = buildPublicCatalog(reviewed, generation, audioManifest);

  const artworkSource = join(workspace, 'public/artwork/akutagawa-zundamon.png');
  const noJekyllSource = join(workspace, 'public/.nojekyll');
  await Promise.all([
    assertWorkspacePathSafe(workspace, artworkSource),
    assertWorkspacePathSafe(workspace, noJekyllSource),
  ]);
  const artworkBytes = new Uint8Array(await readFile(artworkSource));
  if (sha256Bytes(artworkBytes) !== artworkProvenance.output.sha256) {
    throw new FinalStageError('ARTWORK_HASH_MISMATCH', '画像と由来manifestのSHA-256が一致しません');
  }
  const buildRoot = join(workspace, 'build');
  await assertWorkspacePathSafe(workspace, buildRoot, true);
  await mkdir(buildRoot, { recursive: true });
  await assertWorkspacePathSafe(workspace, buildRoot);
  const staging = await mkdtemp(join(buildRoot, '.public-F001-stage-'));
  await assertWorkspacePathSafe(workspace, staging);
  let keepForPromotion = false;
  try {
    await mkdir(join(staging, 'artwork'), { recursive: true });
    await mkdir(join(staging, 'audio/F001'), { recursive: true });
    await copyFile(artworkSource, join(staging, PUBLIC_AUTHOR.artwork.path));
    for (const asset of generation.assets) {
      await copyFile(join(workspace, FINAL_ARTIFACTS.voiceCache, `${asset.audioId}.wav`), join(staging, asset.path));
    }
    await writeJsonArtifactAtomic(workspace, join(staging, 'content/catalog.json'), catalog);
    await writeJsonArtifactAtomic(workspace, join(staging, 'content/licenses.json'), licenses);
    await writeJsonArtifactAtomic(workspace, join(staging, 'content/artwork-provenance.json'), artworkProvenance);
    await writeJsonArtifactAtomic(workspace, join(staging, 'content/provenance.json'), provenance);
    await copyFile(noJekyllSource, join(staging, '.nojekyll'));

    const staticDefinitions = [
      { path: 'content/catalog.json', mediaType: 'application/json' },
      { path: 'content/licenses.json', mediaType: 'application/json' },
      { path: 'content/artwork-provenance.json', mediaType: 'application/json' },
      { path: 'content/provenance.json', mediaType: 'application/json' },
      { path: PUBLIC_AUTHOR.artwork.path, mediaType: 'image/png' },
      { path: '.nojekyll', mediaType: 'application/octet-stream' },
    ] as const;
    const publicAssets: Array<{ path: string; bytes: number; sha256: string; mediaType: string; audioId?: string }> = [];
    for (const definition of staticDefinitions) {
      const file = join(staging, definition.path);
      await assertWorkspacePathSafe(workspace, file);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new FinalStageError('PUBLIC_STAGING_INVALID', 'stagingに通常file以外があります');
      const bytes = new Uint8Array(await readFile(file));
      if (definition.path === 'content/catalog.json' && bytes.byteLength > MAX_CATALOG_BYTES) {
        throw new FinalStageError('PUBLIC_CATALOG_TOO_LARGE', 'catalog raw UTF-8が8MiBを超えています');
      }
      publicAssets.push({ path: definition.path, bytes: bytes.byteLength, sha256: sha256Bytes(bytes), mediaType: definition.mediaType });
    }
    for (const asset of generation.assets) {
      const file = join(staging, asset.path);
      await assertWorkspacePathSafe(workspace, file);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new FinalStageError('PUBLIC_STAGING_INVALID', 'staging WAVが通常fileではありません');
      const wav = new Uint8Array(await readFile(file));
      const inspected = inspectWav(wav);
      if (wav.byteLength !== asset.bytes || sha256Bytes(wav) !== asset.sha256 || inspected.durationMs !== asset.durationMs) {
        throw new FinalStageError('PUBLIC_STAGING_INVALID', 'staging WAVが生成manifestと一致しません');
      }
      publicAssets.push({ path: asset.path, bytes: wav.byteLength, sha256: asset.sha256, mediaType: 'audio/wav', audioId: asset.audioId });
    }
    const budget = verifyAssetBudget({
      assets: publicAssets,
      references: [
        ...staticDefinitions.map(({ path }) => ({ path })),
        ...generation.assets.map((asset) => ({ audioId: asset.audioId, path: asset.path })),
      ],
      candidateAudio,
    });
    if (!budget.ok) {
      throw new FinalStageError('ASSET_BUDGET_FAILED', `公開asset容量検証に失敗しました: ${budget.issues.map((issue) => issue.code).join(',')}`);
    }
    const catalogAsset = publicAssets.find((asset) => asset.path === 'content/catalog.json');
    if (!catalogAsset) throw new FinalStageError('PUBLIC_STAGING_INVALID', 'catalog assetがありません');
    const assetManifest = {
      schemaVersion: '1.0.0',
      configHash: generation.configHash,
      assets: publicAssets,
      audioAssets: generation.assets,
      candidateAudio,
      totalBytes: budget.totalBytes,
      status: budget.status,
    };
    keepForPromotion = true;
    return {
      stagingPath: safeRelative(workspace, staging),
      catalogHash: catalogAsset.sha256,
      totalBytes: budget.totalBytes,
      totalDurationMs: generation.assets.reduce((sum, asset) => sum + asset.durationMs, 0),
      assetManifest,
    };
  } finally {
    if (!keepForPromotion) await rm(staging, { recursive: true, force: true });
  }
}

async function runFinalStage(stage: UpdateStage, workspace: string): Promise<StageResult> {
  if (stage === 'review') {
    const reviewed = await assembleReviewedContent(workspace);
    await writeJsonArtifactAtomic(workspace, join(workspace, FINAL_ARTIFACTS.reviewedContent), reviewed);
    const evidence = {
      schemaVersion: '1.0.0',
      reviewedAt: reviewed.review.all.reduce((latest, item) => item.review.reviewedAt > latest ? item.review.reviewedAt : latest, ''),
      candidateCount: reviewed.review.all.length,
      approvedCount: reviewed.review.counts.approved,
      rejectedCount: reviewed.review.counts.rejected,
      pendingCount: reviewed.review.counts.pending,
      approvedCharacters: EXPECTED_APPROVED_CHARACTERS,
      reasonCounts: reviewed.review.reasonCounts,
      reviewedContentSha256: hashValue(reviewed),
    };
    await writeJsonArtifactAtomic(workspace, join(workspace, FINAL_ARTIFACTS.reviewEvidence), evidence);
    return { hash: evidence.reviewedContentSha256, count: evidence.approvedCount };
  }

  const reviewed = await readRegularJson<ReviewedContent>(workspace, join(workspace, FINAL_ARTIFACTS.reviewedContent));
  assertReviewedArtifact(reviewed);
  const liveReviewed = await assembleReviewedContent(workspace);
  if (hashValue(reviewed) !== hashValue(liveReviewed)) {
    throw new FinalStageError('REVIEWED_CONTENT_STALE', 'reviewed contentが現在の候補・reviewと一致しません');
  }
  const items = speechItems(reviewed);

  if (stage === 'voice-preflight') {
    await writeJsonArtifactAtomic(workspace, join(workspace, FINAL_ARTIFACTS.voiceConfig), FIXED_VOICE_CONFIG);
    const preflight = estimateVoiceBudget(items, VOICE_ESTIMATE_PROFILE);
    assertPreflight(preflight, items);
    const evidence = {
      ...preflight,
      schemaVersion: '1.0.0',
      profile: storedProfile(),
      approvedCharacters: EXPECTED_APPROVED_CHARACTERS,
    };
    await writeJsonArtifactAtomic(workspace, join(workspace, FINAL_ARTIFACTS.voicePreflight), evidence);
    return { hash: hashValue(evidence), count: preflight.uniqueAudioCount };
  }

  const config = await readRegularJson<VoiceConfig>(workspace, join(workspace, FINAL_ARTIFACTS.voiceConfig));
  assertFixedVoiceConfig(config);
  const preflight = await readRegularJson<VoicePreflight & Record<string, unknown>>(workspace, join(workspace, FINAL_ARTIFACTS.voicePreflight));
  assertStoredPreflight(preflight, items);

  if (stage === 'voice') {
    const client = new ProductionVoicevoxClient({
      baseUrl: 'http://127.0.0.1:50021',
      config,
      workspaceRoot: workspace,
      timeoutMs: 60_000,
      proxy: false,
    });
    const generation = await generateVoiceAssets(items, client, join(workspace, FINAL_ARTIFACTS.voiceCache), {
      workspaceRoot: workspace,
      publicPathPrefix: 'audio/F001',
      preflight,
    });
    assertVoiceGeneration(generation, items);
    await writeJsonArtifactAtomic(workspace, join(workspace, FINAL_ARTIFACTS.voiceGeneration), generation);
    const calibration = voiceCalibration(preflight, generation);
    const evidence = {
      schemaVersion: '1.0.0',
      configHash: generation.configHash,
      inputDigest: preflight.inputDigest,
      attempted: generation.attempted,
      succeeded: generation.succeeded,
      failed: generation.failed,
      failures: generation.failures,
      wavBytes: generation.assets.reduce((sum, asset) => sum + asset.bytes, 0),
      durationMs: generation.assets.reduce((sum, asset) => sum + asset.durationMs, 0),
      generationSha256: hashValue(generation),
      calibration,
    };
    await writeJsonArtifactAtomic(workspace, join(workspace, FINAL_ARTIFACTS.voiceEvidence), evidence);
    return { hash: evidence.generationSha256, count: generation.succeeded, voiceFailures: generation.failures };
  }

  if (stage === 'build') {
    const generation = await readRegularJson<VoiceGenerationResult>(workspace, join(workspace, FINAL_ARTIFACTS.voiceGeneration));
    assertVoiceGeneration(generation, items);
    if (generation.failed !== 0) throw new FinalStageError('VOICE_RESULT_INCOMPLETE', 'approved台詞の音声生成失敗が残っています');
    const voiceEvidence = await readRegularJson<Record<string, unknown>>(workspace, join(workspace, FINAL_ARTIFACTS.voiceEvidence));
    assertVoiceCalibrationEvidence(voiceEvidence, preflight, generation);
    const result = await createPublicStaging(workspace, reviewed, generation);
    await writeJsonArtifactAtomic(workspace, join(workspace, FINAL_ARTIFACTS.assetManifest), result.assetManifest);
    const evidence = {
      schemaVersion: '1.0.0',
      catalogSha256: result.catalogHash,
      publicAssetBytes: result.totalBytes,
      wavBytes: generation.assets.reduce((sum, asset) => sum + asset.bytes, 0),
      durationMs: result.totalDurationMs,
      publishedDialogueCount: generation.assets.reduce((sum, asset) => sum + asset.candidateIds.length, 0),
      audioAssetCount: generation.assets.length,
      failedAudioCount: generation.failed,
      assetManifestSha256: hashValue(result.assetManifest),
    };
    await writeJsonArtifactAtomic(workspace, join(workspace, FINAL_ARTIFACTS.buildEvidence), evidence);
    return {
      hash: result.catalogHash,
      count: evidence.publishedDialogueCount,
      publicTree: { stagingPath: result.stagingPath, targetPath: FINAL_ARTIFACTS.publicTarget },
    };
  }

  throw new FinalStageError('PRODUCTION_STAGE_UNSUPPORTED', `production後半CLIの対象外stageです: ${stage}`);
}

/** @des DES-F001-017 DES-F001-019 @fun FUN-F001-033 */
export function createCompleteProductionStageRunner(): StageRunner {
  const frontRunner = createProductionStageRunner();
  return async (stage, context) => {
    if ((FINAL_CONTENT_STAGES as readonly string[]).includes(stage)) return runFinalStage(stage, context.workspace);
    return frontRunner(stage, context);
  };
}
