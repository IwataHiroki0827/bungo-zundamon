import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  promoteVerifiedWorkArtifacts as promoteVerifiedWorkArtifactsV2,
  type ActualCapacityReport,
  type DistPreview,
  type F001DistInvariantReport,
  type WorkAcceptanceEvidence,
  type WorkPromotionOptions,
} from './batch-acceptance.ts';
import { canonicalJson, fingerprintArtifact, writeJsonArtifactAtomic } from './artifacts.ts';
import {
  hashBatchManifest,
  validateBatchManifest,
  type BatchId,
  type BatchManifest,
  type Sha256,
  type WorkId,
} from './batch.ts';
import type { F001ContentInvariantReport, IntegratedBuild } from './batch-public.ts';
import type { PublishedInvariantReport } from './published-baseline.ts';
import {
  resolveVoiceGenerationPaths,
  resolveWorkspaceArtifactPath,
} from './f003-artifact-paths.ts';
import {
  loadAndVerifyEditorialJudgmentSets,
  reconcileIndependentJudgments,
  verifyEditorialCompleteness,
  type EditorialCandidate,
  type EditorialJudgmentSet,
  type EditorialResolutionSet,
} from './editorial-independent.ts';
import type { CandidateSafetyReport } from './f003-reuse.ts';
import {
  APPROVED_REVIEW_REASONS,
  REJECTED_REVIEW_REASONS,
  validateReview,
  type ReviewRecord,
} from './processing.ts';
import {
  type VoiceCompletenessReport,
  type VoiceDiffGenerationResult,
} from '../voice/generation.ts';

const SHA256 = /^[a-f0-9]{64}$/u;
const WORK_ID = /^[0-9]{6}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACCEPTANCE_ROOT = '.cache/transactions/f003-work-acceptance';
const preparedValues = new WeakSet<object>();

const ROOT_FILES = Object.freeze([
  'baseline-content.json',
  'baseline-dist.json',
  'candidate-safety.json',
  'capacity-actual.json',
  'review-reconciliation.json',
  'voice-completeness.json',
] as const);

const APPROVED_REASONS = new Set<string>(APPROVED_REVIEW_REASONS);
const REJECTED_REASONS = new Set<string>(REJECTED_REVIEW_REASONS);
const TOPIC_ONLY_REASONS = new Set(['SUBJECT_ONLY', 'MOTIF_ONLY']);

export class F003AcceptanceError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'F003AcceptanceError';
  }
}

export interface F003EvidenceFileRef {
  readonly path: string;
  readonly sha256: Sha256 | string;
  readonly bytes: number;
}

export interface F003WorkEvidenceRefs {
  readonly primary: F003EvidenceFileRef;
  readonly secondary: F003EvidenceFileRef;
  readonly adjudication?: F003EvidenceFileRef;
  readonly reconciliation: F003EvidenceFileRef;
  readonly candidateSafety: F003EvidenceFileRef;
  readonly voiceCompleteness: F003EvidenceFileRef;
  readonly capacityActual: F003EvidenceFileRef;
  readonly baselineContent: F003EvidenceFileRef;
  readonly baselineDist: F003EvidenceFileRef;
}

interface AcceptanceArtifactBase<K extends string, P> {
  readonly schemaVersion: '1.0.0';
  readonly kind: K;
  readonly batchId: 'F003';
  readonly workId: WorkId | string;
  readonly toolSha256: Sha256 | string;
  readonly inputHashes: readonly (Sha256 | string)[];
  readonly payload: P;
}

export type F003CandidateSafetyArtifact = AcceptanceArtifactBase<'candidate-safety', Readonly<{
  reconciliationDigest: Sha256 | string;
  reports: readonly CandidateSafetyReport[];
}>>;

export type F003VoiceCompletenessArtifact = AcceptanceArtifactBase<'voice-completeness', Readonly<{
  planDigest: Sha256 | string;
  generationDigest: Sha256 | string;
  completenessDigest: Sha256 | string;
  reconciliationDigest: Sha256 | string;
  generation: VoiceDiffGenerationResult;
  completeness: VoiceCompletenessReport;
}>>;

export type F003CapacityActualArtifact = AcceptanceArtifactBase<'capacity-actual', Readonly<{
  result: 'pass' | 'pass_with_warning' | 'blocked';
  planDigest: Sha256 | string;
  generationDigest: Sha256 | string;
  completenessDigest: Sha256 | string;
  contentBuildSha256: Sha256 | string;
  distSha256: Sha256 | string;
  actual: ActualCapacityReport;
}>>;

export type F003BaselineContentArtifact = AcceptanceArtifactBase<'baseline-content', Readonly<{
  result: 'pass' | 'blocked';
  contentBuildSha256: Sha256 | string;
  preview: IntegratedBuild;
  invariant: F001ContentInvariantReport;
  publishedInvariant: PublishedInvariantReport;
}>>;

export type F003BaselineDistArtifact = AcceptanceArtifactBase<'baseline-dist', Readonly<{
  result: 'pass' | 'blocked';
  contentBuildSha256: Sha256 | string;
  distSha256: Sha256 | string;
  preview: DistPreview;
  invariant: F001DistInvariantReport;
}>>;

export type F003AcceptanceArtifact =
  | F003CandidateSafetyArtifact
  | F003VoiceCompletenessArtifact
  | F003CapacityActualArtifact
  | F003BaselineContentArtifact
  | F003BaselineDistArtifact;

export interface F003AcceptanceBaseline {
  readonly contentBuildSha256: Sha256 | string;
  readonly distSha256: Sha256 | string;
  readonly voiceConfigHash: Sha256 | string;
}

export interface PreparedWorkAcceptance {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'f003-work-acceptance-prepared';
  readonly batchId: 'F003';
  readonly workId: WorkId;
  readonly manifestPath: 'content/batches/F003/batch.json';
  readonly manifestSha256: Sha256;
  readonly manifestStatus: 'voiced' | 'accepted';
  readonly evidenceRefs: F003WorkEvidenceRefs;
  readonly evidenceCount: 8 | 9;
  readonly reconciliationDigest: Sha256;
  readonly reviewRecords: readonly ReviewRecord[];
  readonly candidateSafety: F003CandidateSafetyArtifact;
  readonly voiceCompleteness: F003VoiceCompletenessArtifact;
  readonly capacityActual: F003CapacityActualArtifact;
  readonly baselineContent: F003BaselineContentArtifact;
  readonly baselineDist: F003BaselineDistArtifact;
  readonly baseline: F003AcceptanceBaseline;
  readonly artifactTreeDigest: Sha256;
  readonly preparedDigest: Sha256;
}

interface F003AcceptanceJournal {
  readonly schemaVersion: '1.0.0';
  readonly phase: 'prepared' | 'verified';
  readonly batchId: 'F003';
  readonly workId: WorkId;
  readonly transactionId: string;
  readonly ownerSha256: Sha256;
  readonly manifestPath: 'content/batches/F003/batch.json';
  readonly manifestSha256: Sha256;
  readonly preparedDigest: Sha256;
  readonly evidenceRefs: F003WorkEvidenceRefs;
  readonly baseline: F003AcceptanceBaseline;
  readonly acceptedAt: string;
  readonly acceptedBy: string;
  readonly evidence?: WorkAcceptanceEvidence;
}

type ExistingPromoter = typeof promoteVerifiedWorkArtifactsV2;

export interface F003PromotionOptions {
  readonly acceptedAt?: string;
  readonly promoter?: ExistingPromoter;
  readonly afterPhase?: WorkPromotionOptions['afterPhase'];
}

export interface F003PromotionResult {
  readonly evidence: WorkAcceptanceEvidence;
  readonly journalPath: string;
  readonly journalSha256: Sha256;
}

function hash(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function fail(code: string, message: string): never {
  throw new F003AcceptanceError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function latestInstant(values: readonly string[]): string {
  if (values.length === 0 || values.some((value) => !validInstant(value))) {
    return fail('F003_REVIEW_TIMESTAMP_INVALID', 'seal時刻がRFC 3339 instantではありません');
  }
  return [...values].sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1)!;
}

function derivedCandidates(primary: EditorialJudgmentSet): EditorialCandidate[] {
  return primary.judgments.map((judgment) => Object.freeze({
    candidateId: judgment.candidateId,
    inputSha256: judgment.inputSha256,
    sourceAnchor: judgment.sourceAnchor,
  }));
}

function reviewerFor(
  source: 'agreement' | 'adjudication' | 'pending',
  primary: EditorialJudgmentSet,
  secondary: EditorialJudgmentSet,
  adjudication?: EditorialJudgmentSet,
): string {
  if (source === 'adjudication') {
    if (!adjudication) return fail('F003_ADJUDICATION_REQUIRED', '第三裁定sealがありません');
    return `editorial-independent:${adjudication.header.authorizationId}`;
  }
  return `editorial-independent:${primary.header.authorizationId}+${secondary.header.authorizationId}`;
}

/**
 * 独立判定のresolutionを既存pipeline用ReviewRecordへ決定的に投影する。
 * @des DES-F003-008 @fun FUN-F003-019 @ut UT-F003-019
 */
export function bridgeEditorialResolutionSetToReviewRecords(
  workId: WorkId | string,
  resolutionSet: EditorialResolutionSet,
  primary: EditorialJudgmentSet,
  secondary: EditorialJudgmentSet,
  adjudication?: EditorialJudgmentSet,
): readonly ReviewRecord[] {
  if (!WORK_ID.test(workId)) fail('F003_REVIEW_WORK_INVALID', 'work IDが不正です');
  const candidates = derivedCandidates(primary);
  let recomputed: EditorialResolutionSet;
  try {
    recomputed = reconcileIndependentJudgments(candidates, primary, secondary, adjudication);
  } catch (error) {
    throw new F003AcceptanceError('F003_REVIEW_CHAIN_INVALID', 'seal/reconciliationを再検算できません', { cause: error });
  }
  if (canonicalJson(recomputed) !== canonicalJson(resolutionSet)) {
    fail('F003_REVIEW_RECONCILIATION_MISMATCH', '保存済みreconciliationが原sealからの再計算値と一致しません');
  }
  const completeness = verifyEditorialCompleteness(candidates, resolutionSet.resolutions);
  if (completeness.result !== 'pass' || resolutionSet.pendingIds.length !== 0 ||
    new Set(resolutionSet.resolutions.map((item) => item.candidateId)).size !== candidates.length) {
    fail('F003_REVIEW_INCOMPLETE', 'resolutionにpending・欠落・余分・重複があります');
  }
  const policyCheckedAt = latestInstant([
    primary.header.sealedAt,
    secondary.header.sealedAt,
    ...(adjudication ? [adjudication.header.sealedAt] : []),
  ]);
  const records = resolutionSet.resolutions.map((resolution): ReviewRecord => {
    if (resolution.finalDecision === 'pending' || resolution.resolutionSource === 'pending') {
      return fail('F003_REVIEW_PENDING', `pending resolutionです: ${resolution.candidateId}`);
    }
    if (TOPIC_ONLY_REASONS.has(resolution.reasonCode)) {
      return fail('F003_REVIEW_TOPIC_ONLY', `題材語だけの除外理由です: ${resolution.candidateId}`);
    }
    const approved = resolution.finalDecision === 'approved';
    if ((approved && !APPROVED_REASONS.has(resolution.reasonCode)) ||
      (!approved && !REJECTED_REASONS.has(resolution.reasonCode))) {
      return fail('F003_REVIEW_REASON_INVALID', `decision/reasonがallowlist外です: ${resolution.candidateId}`);
    }
    if (approved && !resolution.speaker?.trim()) {
      return fail('F003_REVIEW_SPEAKER_MISSING', `approved resolutionにspeakerがありません: ${resolution.candidateId}`);
    }
    if (!approved && resolution.speaker !== null) {
      return fail('F003_REVIEW_SPEAKER_INVALID', `rejected resolutionにspeakerがあります: ${resolution.candidateId}`);
    }
    const reviewedAt = resolution.resolutionSource === 'adjudication'
      ? adjudication?.header.sealedAt
      : latestInstant([primary.header.sealedAt, secondary.header.sealedAt]);
    if (!reviewedAt) return fail('F003_REVIEW_TIMESTAMP_INVALID', 'reviewedAtを導出できません');
    const record: ReviewRecord = {
      candidateId: resolution.candidateId,
      workId,
      policyDecision: !approved && resolution.reasonCode === 'POLICY_EXCLUDED' ? 'excluded' : 'allowed',
      revision: 1,
      status: approved ? 'approved' : 'rejected',
      reasonCode: resolution.reasonCode,
      note: canonicalJson({
        inputSha256: resolution.inputSha256,
        reconciliationDigest: resolutionSet.reconciliationDigest,
        resolutionSource: resolution.resolutionSource,
        sourceAnchor: resolution.sourceAnchor,
        speaker: resolution.speaker,
      }),
      reviewer: reviewerFor(resolution.resolutionSource, primary, secondary, adjudication),
      reviewedAt,
      policyCheckedAt,
    };
    validateReview(record);
    return Object.freeze(record);
  });
  return Object.freeze(records);
}

async function verifiedWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) return fail('F003_ACCEPTANCE_PATH_UNSAFE', 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    return fail('F003_ACCEPTANCE_PATH_UNSAFE', 'workspace実体が不正です');
  }
  return root;
}

function safeRelativePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.includes('\\') && !value.includes('\0') &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

async function assertNoReparse(root: string, target: string): Promise<void> {
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    fail('F003_ACCEPTANCE_PATH_UNSAFE', 'pathがworkspace外です');
  }
  let cursor = root;
  for (const part of relation.split(sep)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail('F003_ACCEPTANCE_PATH_UNSAFE', 'pathにreparse/symlinkがあります');
  }
}

function expectedPaths(workId: string, adjudication: boolean): Readonly<Record<keyof F003WorkEvidenceRefs, string>> {
  const root = `content/batches/F003/work-artifacts/${workId}`;
  return {
    primary: `${root}/reviews/primary.json`,
    secondary: `${root}/reviews/secondary.json`,
    ...(adjudication ? { adjudication: `${root}/reviews/adjudication.json` } : {}),
    reconciliation: `${root}/review-reconciliation.json`,
    candidateSafety: `${root}/candidate-safety.json`,
    voiceCompleteness: `${root}/voice-completeness.json`,
    capacityActual: `${root}/capacity-actual.json`,
    baselineContent: `${root}/baseline-content.json`,
    baselineDist: `${root}/baseline-dist.json`,
  } as Readonly<Record<keyof F003WorkEvidenceRefs, string>>;
}

function assertEvidenceRefs(value: unknown): asserts value is F003WorkEvidenceRefs {
  if (!isRecord(value)) fail('F003_ACCEPTANCE_REF_INVALID', 'evidenceRefsはobjectが必要です');
  const adjudication = Object.hasOwn(value, 'adjudication');
  const keys = [
    'primary', 'secondary', ...(adjudication ? ['adjudication'] : []), 'reconciliation',
    'candidateSafety', 'voiceCompleteness', 'capacityActual', 'baselineContent', 'baselineDist',
  ];
  if (!exactKeys(value, keys)) {
    fail('F003_ACCEPTANCE_REF_INVALID', 'evidenceRefsに未知・欠落keyがあります');
  }
  for (const ref of Object.values(value)) {
    if (!isRecord(ref) || !exactKeys(ref, ['path', 'sha256', 'bytes']) ||
      typeof ref.path !== 'string' || typeof ref.sha256 !== 'string' ||
      !Number.isSafeInteger(ref.bytes)) {
      fail('F003_ACCEPTANCE_REF_INVALID', 'evidence file ref schemaが不正です');
    }
  }
}

function assertBaseline(value: unknown): asserts value is F003AcceptanceBaseline {
  if (!isRecord(value) || !exactKeys(value, [
    'contentBuildSha256', 'distSha256', 'voiceConfigHash',
  ]) || ![value.contentBuildSha256, value.distSha256, value.voiceConfigHash]
    .every((item) => typeof item === 'string' && SHA256.test(item))) {
    fail('F003_ACCEPTANCE_INPUT_INVALID', 'baseline exact schemaが不正です');
  }
}

async function readEvidence<T>(
  root: string,
  ref: F003EvidenceFileRef,
  expectedPath: string,
): Promise<{ value: T; text: string }> {
  if (ref.path !== expectedPath || !safeRelativePath(ref.path) || !SHA256.test(ref.sha256) ||
    !Number.isSafeInteger(ref.bytes) || ref.bytes < 2) {
    return fail('F003_ACCEPTANCE_REF_INVALID', `evidence refが不正です: ${expectedPath}`);
  }
  const target = join(root, ...ref.path.split('/'));
  await assertNoReparse(root, target);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) {
    return fail('F003_ACCEPTANCE_PATH_UNSAFE', `evidence実体が不正です: ${expectedPath}`);
  }
  const bytes = new Uint8Array(await readFile(target));
  if (bytes.byteLength !== ref.bytes || hash(bytes) !== ref.sha256) {
    return fail('F003_ACCEPTANCE_HASH_MISMATCH', `evidence SHA/bytesが一致しません: ${expectedPath}`);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new F003AcceptanceError('F003_ACCEPTANCE_SCHEMA_INVALID', `JSONが不正です: ${expectedPath}`, { cause: error });
  }
  if (canonicalJson(value) !== text) {
    return fail('F003_ACCEPTANCE_SCHEMA_INVALID', `artifactがcanonical JSONではありません: ${expectedPath}`);
  }
  return { value: value as T, text };
}

async function assertExactWorkRoot(root: string, workId: string, adjudication: boolean): Promise<void> {
  const workRoot = join(root, 'content', 'batches', 'F003', 'work-artifacts', workId);
  await assertNoReparse(root, workRoot);
  const entries = await readdir(workRoot, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...ROOT_FILES, 'reviews'].sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(names) !== canonicalJson(expected) ||
    entries.some((entry) => entry.isSymbolicLink() ||
      (entry.name === 'reviews' ? !entry.isDirectory() : !entry.isFile()))) {
    fail('F003_ACCEPTANCE_ALLOWLIST_MISMATCH', 'work artifact rootにallowlist外・欠落entryがあります');
  }
  const reviewRoot = join(workRoot, 'reviews');
  await assertNoReparse(root, reviewRoot);
  const reviews = await readdir(reviewRoot, { withFileTypes: true });
  const reviewNames = reviews.map((entry) => entry.name).sort((left, right) => left.localeCompare(right, 'en'));
  const expectedReviews = ['primary.json', 'secondary.json', ...(adjudication ? ['adjudication.json'] : [])]
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(reviewNames) !== canonicalJson(expectedReviews) ||
    reviews.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail('F003_ACCEPTANCE_ALLOWLIST_MISMATCH', 'reviewsの8/9件条件allowlistが一致しません');
  }
}

function assertArtifactEnvelope<K extends F003AcceptanceArtifact['kind']>(
  value: unknown,
  kind: K,
  workId: string,
): asserts value is Extract<F003AcceptanceArtifact, { kind: K }> {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'batchId', 'workId', 'toolSha256', 'inputHashes', 'payload',
  ]) || value.schemaVersion !== '1.0.0' || value.kind !== kind || value.batchId !== 'F003' ||
    value.workId !== workId || typeof value.toolSha256 !== 'string' || !SHA256.test(value.toolSha256) ||
    !Array.isArray(value.inputHashes) || value.inputHashes.length === 0 ||
    value.inputHashes.some((input) => typeof input !== 'string' || !SHA256.test(input)) ||
    new Set(value.inputHashes).size !== value.inputHashes.length || !isRecord(value.payload)) {
    fail('F003_ACCEPTANCE_SCHEMA_INVALID', `${kind} schema/tool/input tupleが不正です`);
  }
  const payloadKeys: Readonly<Record<F003AcceptanceArtifact['kind'], readonly string[]>> = {
    'candidate-safety': ['reconciliationDigest', 'reports'],
    'voice-completeness': [
      'planDigest', 'generationDigest', 'completenessDigest', 'reconciliationDigest',
      'generation', 'completeness',
    ],
    'capacity-actual': [
      'result', 'planDigest', 'generationDigest', 'completenessDigest',
      'contentBuildSha256', 'distSha256', 'actual',
    ],
    'baseline-content': ['result', 'contentBuildSha256', 'preview', 'invariant', 'publishedInvariant'],
    'baseline-dist': ['result', 'contentBuildSha256', 'distSha256', 'preview', 'invariant'],
  };
  if (!exactKeys(value.payload, payloadKeys[kind]!)) {
    fail('F003_ACCEPTANCE_SCHEMA_INVALID', `${kind} payloadに未知・欠落keyがあります`);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort((x, y) => x.localeCompare(y, 'en'));
  const b = [...right].sort((x, y) => x.localeCompare(y, 'en'));
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validSafetyReport(value: unknown, voiceConfigHash: string): value is CandidateSafetyReport {
  return isRecord(value) && exactKeys(value, [
    'result', 'candidateId', 'profileSha256', 'configHash', 'speechSha256',
    'codePoints', 'durationMs', 'wavBytes', 'limits', 'reasons',
  ]) && value.result === 'pass' && typeof value.candidateId === 'string' && value.candidateId.length > 0 &&
    typeof value.profileSha256 === 'string' && SHA256.test(value.profileSha256) &&
    value.configHash === voiceConfigHash && typeof value.speechSha256 === 'string' &&
    SHA256.test(value.speechSha256) && Number.isSafeInteger(value.codePoints) &&
    (value.codePoints as number) >= 1 && (value.codePoints as number) <= 500 &&
    Number.isSafeInteger(value.durationMs) && (value.durationMs as number) >= 1 &&
    (value.durationMs as number) <= 120_000 && Number.isSafeInteger(value.wavBytes) &&
    (value.wavBytes as number) >= 45 && (value.wavBytes as number) <= 5_760_044 &&
    isRecord(value.limits) && exactKeys(value.limits, ['codePoints', 'durationMs', 'wavBytes']) &&
    value.limits.codePoints === 500 && value.limits.durationMs === 120_000 &&
    value.limits.wavBytes === 5_760_044 && Array.isArray(value.reasons) && value.reasons.length === 0;
}

function assertCrossChain(
  reconciliation: EditorialResolutionSet,
  reviews: readonly ReviewRecord[],
  safety: F003CandidateSafetyArtifact,
  voice: F003VoiceCompletenessArtifact,
  capacity: F003CapacityActualArtifact,
  content: F003BaselineContentArtifact,
  dist: F003BaselineDistArtifact,
  refs: F003WorkEvidenceRefs,
  baseline: F003AcceptanceBaseline,
): void {
  const approvedIds = reviews.filter((review) => review.status === 'approved').map((review) => review.candidateId);
  const reports: readonly unknown[] = isRecord(safety.payload) && Array.isArray(safety.payload.reports)
    ? safety.payload.reports
    : [];
  if (!isRecord(safety.payload) || !Array.isArray(safety.payload.reports) ||
    safety.payload.reconciliationDigest !== reconciliation.reconciliationDigest ||
    !safety.inputHashes.includes(reconciliation.reconciliationDigest) ||
    reports.some((report) => !validSafetyReport(report, baseline.voiceConfigHash)) ||
    !sameIds(approvedIds, (reports as readonly CandidateSafetyReport[]).map((report) => report.candidateId))) {
    fail('F003_ACCEPTANCE_SAFETY_INVALID', 'candidate safetyがapproved/reconciliation/configへ一致しません');
  }
  if (!isRecord(voice.payload) || voice.payload.reconciliationDigest !== reconciliation.reconciliationDigest ||
    voice.payload.completeness?.result !== 'pass' || voice.payload.generation?.batchId !== 'F003' ||
    voice.payload.generation?.workId !== reviews[0]?.workId ||
    voice.payload.completeness?.batchId !== 'F003' || voice.payload.completeness?.workId !== reviews[0]?.workId ||
    !voice.inputHashes.includes(refs.candidateSafety.sha256) ||
    !voice.inputHashes.includes(reconciliation.reconciliationDigest)) {
    fail('F003_ACCEPTANCE_VOICE_INVALID', 'voice completeness tupleが一致しません');
  }
  if (!isRecord(capacity.payload) || !['pass', 'pass_with_warning'].includes(capacity.payload.result) ||
    capacity.payload.planDigest !== voice.payload.planDigest ||
    capacity.payload.generationDigest !== voice.payload.generationDigest ||
    capacity.payload.completenessDigest !== voice.payload.completenessDigest ||
    !capacity.inputHashes.includes(refs.voiceCompleteness.sha256) ||
    capacity.payload.contentBuildSha256 !== baseline.contentBuildSha256 ||
    capacity.payload.distSha256 !== baseline.distSha256) {
    fail('F003_ACCEPTANCE_CAPACITY_INVALID', 'capacity actual tupleが一致しません');
  }
  if (!isRecord(content.payload) || content.payload.result !== 'pass' ||
    content.payload.contentBuildSha256 !== baseline.contentBuildSha256 ||
    content.payload.preview?.buildSha256 !== baseline.contentBuildSha256 ||
    content.payload.invariant?.result !== 'pass' ||
    content.payload.publishedInvariant?.result !== 'pass' ||
    content.payload.publishedInvariant?.target !== 'work-preview' ||
    content.payload.publishedInvariant?.inputTreeSha256 !== baseline.contentBuildSha256 ||
    content.payload.publishedInvariant?.actualTreeSha256 !== baseline.contentBuildSha256 ||
    !content.inputHashes.includes(refs.capacityActual.sha256)) {
    fail('F003_ACCEPTANCE_BASELINE_INVALID', 'baseline content tupleが一致しません');
  }
  if (!isRecord(dist.payload) || dist.payload.result !== 'pass' ||
    dist.payload.contentBuildSha256 !== baseline.contentBuildSha256 ||
    dist.payload.distSha256 !== baseline.distSha256 ||
    dist.payload.preview?.contentBuildSha256 !== baseline.contentBuildSha256 ||
    dist.payload.preview?.distSha256 !== baseline.distSha256 ||
    dist.payload.invariant?.result !== 'pass' ||
    !dist.inputHashes.includes(refs.baselineContent.sha256)) {
    fail('F003_ACCEPTANCE_BASELINE_INVALID', 'baseline dist tupleが一致しません');
  }
}

function preparedCore(prepared: Omit<PreparedWorkAcceptance, 'preparedDigest'>): unknown {
  return {
    schemaVersion: prepared.schemaVersion,
    kind: prepared.kind,
    batchId: prepared.batchId,
    workId: prepared.workId,
    manifestPath: prepared.manifestPath,
    evidenceRefs: prepared.evidenceRefs,
    evidenceCount: prepared.evidenceCount,
    reconciliationDigest: prepared.reconciliationDigest,
    reviewRecords: prepared.reviewRecords,
    baseline: prepared.baseline,
    artifactTreeDigest: prepared.artifactTreeDigest,
  };
}

async function loadCanonicalManifest(
  root: string,
  manifestPath: string,
  workId: string,
): Promise<{ manifest: BatchManifest; sha256: Sha256; status: 'voiced' | 'accepted' }> {
  if (manifestPath !== 'content/batches/F003/batch.json') {
    return fail('F003_ACCEPTANCE_MANIFEST_PATH_INVALID', 'F003 canonical manifest pathではありません');
  }
  const target = join(root, ...manifestPath.split('/'));
  await assertNoReparse(root, target);
  const text = await readFile(target, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new F003AcceptanceError('F003_ACCEPTANCE_MANIFEST_INVALID', 'manifest JSONが不正です', { cause: error });
  }
  const checked = validateBatchManifest(raw);
  if (!checked.ok || checked.value.batchId !== 'F003' || canonicalJson(checked.value) !== text) {
    return fail('F003_ACCEPTANCE_MANIFEST_INVALID', 'manifest schema/canonical formが不正です');
  }
  const index = checked.value.workIds.indexOf(workId as WorkId);
  const work = checked.value.workProgress[index];
  if (index < 0 || !work || !['voiced', 'accepted'].includes(work.status)) {
    return fail('F003_ACCEPTANCE_ORDER_INVALID', '対象workはvoiced/acceptedではありません');
  }
  if (index > 0 && checked.value.workProgress[index - 1]?.status !== 'accepted') {
    return fail('F003_ACCEPTANCE_ORDER_INVALID', '直前workがacceptedではありません');
  }
  if (checked.value.workProgress.slice(index + 1).some((item) => item.status === 'accepted')) {
    return fail('F003_ACCEPTANCE_ORDER_INVALID', '後続workが先にacceptedです');
  }
  return {
    manifest: checked.value,
    sha256: hashBatchManifest(checked.value),
    status: work.status as 'voiced' | 'accepted',
  };
}

/**
 * F003 canonical work rootの8/9原artifactを再読込してbranded Prepared値を作る。
 * @des DES-F003-008 @fun FUN-F003-019 @ut UT-F003-019
 */
export async function prepareWorkAcceptance(
  workspace: string,
  manifestPath: string,
  workId: WorkId | string,
  evidenceRefs: F003WorkEvidenceRefs,
  baseline: F003AcceptanceBaseline,
): Promise<PreparedWorkAcceptance> {
  const root = await verifiedWorkspace(workspace);
  assertEvidenceRefs(evidenceRefs);
  assertBaseline(baseline);
  if (!WORK_ID.test(workId)) {
    return fail('F003_ACCEPTANCE_INPUT_INVALID', 'work/baseline tupleが不正です');
  }
  const manifest = await loadCanonicalManifest(root, manifestPath, workId);
  const adjudication = evidenceRefs.adjudication !== undefined;
  await assertExactWorkRoot(root, workId, adjudication);
  const paths = expectedPaths(workId, adjudication);
  const [
    primaryRaw,
    secondaryRaw,
    reconciliationRaw,
    safetyRaw,
    voiceRaw,
    capacityRaw,
    contentRaw,
    distRaw,
    adjudicationRaw,
  ] = await Promise.all([
    readEvidence<EditorialJudgmentSet>(root, evidenceRefs.primary, paths.primary),
    readEvidence<EditorialJudgmentSet>(root, evidenceRefs.secondary, paths.secondary),
    readEvidence<EditorialResolutionSet>(root, evidenceRefs.reconciliation, paths.reconciliation),
    readEvidence<unknown>(root, evidenceRefs.candidateSafety, paths.candidateSafety),
    readEvidence<unknown>(root, evidenceRefs.voiceCompleteness, paths.voiceCompleteness),
    readEvidence<unknown>(root, evidenceRefs.capacityActual, paths.capacityActual),
    readEvidence<unknown>(root, evidenceRefs.baselineContent, paths.baselineContent),
    readEvidence<unknown>(root, evidenceRefs.baselineDist, paths.baselineDist),
    adjudication
      ? readEvidence<EditorialJudgmentSet>(root, evidenceRefs.adjudication!, paths.adjudication)
      : Promise.resolve(undefined),
  ]);
  let trustedSets: readonly EditorialJudgmentSet[];
  try {
    trustedSets = await loadAndVerifyEditorialJudgmentSets(root);
  } catch (error) {
    throw new F003AcceptanceError(
      'F003_REVIEW_CHAIN_INVALID',
      'trusted authorization storeから原sealを再検証できません',
      { cause: error },
    );
  }
  const trustedBySha = new Map(trustedSets.map((set) => [set.header.artifactSha256, set]));
  const trustedPrimary = trustedBySha.get(primaryRaw.value.header.artifactSha256);
  const trustedSecondary = trustedBySha.get(secondaryRaw.value.header.artifactSha256);
  const trustedAdjudication = adjudicationRaw
    ? trustedBySha.get(adjudicationRaw.value.header.artifactSha256)
    : undefined;
  if (!trustedPrimary || !trustedSecondary || (adjudicationRaw && !trustedAdjudication) ||
    canonicalJson(trustedPrimary) !== primaryRaw.text ||
    canonicalJson(trustedSecondary) !== secondaryRaw.text ||
    (adjudicationRaw && canonicalJson(trustedAdjudication) !== adjudicationRaw.text)) {
    return fail('F003_REVIEW_CHAIN_INVALID', 'canonical work rootのsealがtrusted store原artifactと一致しません');
  }
  const reviews = bridgeEditorialResolutionSetToReviewRecords(
    workId,
    reconciliationRaw.value,
    trustedPrimary,
    trustedSecondary,
    trustedAdjudication,
  );
  if ((reconciliationRaw.value.adjudicationArtifactSha256 === null) !== !adjudicationRaw) {
    return fail('F003_ADJUDICATION_CONDITION_MISMATCH', 'semantic一致/不一致とadjudication 8/9件条件が一致しません');
  }
  assertArtifactEnvelope(safetyRaw.value, 'candidate-safety', workId);
  assertArtifactEnvelope(voiceRaw.value, 'voice-completeness', workId);
  assertArtifactEnvelope(capacityRaw.value, 'capacity-actual', workId);
  assertArtifactEnvelope(contentRaw.value, 'baseline-content', workId);
  assertArtifactEnvelope(distRaw.value, 'baseline-dist', workId);
  assertCrossChain(
    reconciliationRaw.value,
    reviews,
    safetyRaw.value,
    voiceRaw.value,
    capacityRaw.value,
    contentRaw.value,
    distRaw.value,
    evidenceRefs,
    baseline,
  );
  try {
    resolveVoiceGenerationPaths(root, voiceRaw.value.payload.generation);
    resolveWorkspaceArtifactPath(root, contentRaw.value.payload.preview.stagingRoot);
    const outputRoot = distRaw.value.payload.preview.outputRoot;
    if (typeof outputRoot !== 'string') {
      return fail('F003_ACCEPTANCE_BASELINE_INVALID', 'baseline dist outputRootがありません');
    }
    resolveWorkspaceArtifactPath(root, outputRoot);
  } catch (error) {
    if (error instanceof F003AcceptanceError) throw error;
    throw new F003AcceptanceError(
      'F003_ACCEPTANCE_PATH_UNSAFE',
      '永続artifact pathまたはvoice digestをruntime tupleへ復元できません',
      { cause: error },
    );
  }
  const refsInOrder = Object.entries(evidenceRefs)
    .map(([name, ref]) => ({ name, path: ref.path, sha256: ref.sha256, bytes: ref.bytes }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const artifactTreeDigest = hash(canonicalJson(refsInOrder));
  const partial: Omit<PreparedWorkAcceptance, 'preparedDigest'> = {
    schemaVersion: '1.0.0',
    kind: 'f003-work-acceptance-prepared',
    batchId: 'F003',
    workId: workId as WorkId,
    manifestPath: 'content/batches/F003/batch.json',
    manifestSha256: manifest.sha256,
    manifestStatus: manifest.status,
    evidenceRefs: Object.freeze({ ...evidenceRefs }),
    evidenceCount: adjudication ? 9 : 8,
    reconciliationDigest: reconciliationRaw.value.reconciliationDigest as Sha256,
    reviewRecords: reviews,
    candidateSafety: safetyRaw.value,
    voiceCompleteness: voiceRaw.value,
    capacityActual: capacityRaw.value,
    baselineContent: contentRaw.value,
    baselineDist: distRaw.value,
    baseline: Object.freeze({ ...baseline }),
    artifactTreeDigest,
  };
  const prepared = Object.freeze({
    ...partial,
    preparedDigest: hash(canonicalJson(preparedCore(partial))),
  });
  preparedValues.add(prepared);
  return prepared;
}

function assertPrepared(prepared: PreparedWorkAcceptance): void {
  const { preparedDigest, ...partial } = prepared;
  if (!preparedValues.has(prepared) || !SHA256.test(preparedDigest) ||
    hash(canonicalJson(preparedCore(partial))) !== preparedDigest) {
    fail('F003_ACCEPTANCE_PREPARED_UNTRUSTED', 'prepareWorkAcceptanceが生成した未改変値ではありません');
  }
}

function journalPath(root: string, workId: string): string {
  return join(root, ...ACCEPTANCE_ROOT.split('/'), `F003-${workId}.json`);
}

function ownerSha(journal: Pick<F003AcceptanceJournal,
  'batchId' | 'workId' | 'transactionId' | 'manifestSha256' | 'preparedDigest'>): Sha256 {
  return hash(canonicalJson({
    batchId: journal.batchId,
    workId: journal.workId,
    transactionId: journal.transactionId,
    manifestSha256: journal.manifestSha256,
    preparedDigest: journal.preparedDigest,
  }));
}

function parseJournal(text: string): F003AcceptanceJournal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new F003AcceptanceError('F003_ACCEPTANCE_JOURNAL_INVALID', 'journal JSONが不正です', { cause: error });
  }
  if (!isRecord(value) || canonicalJson(value) !== text ||
    !exactKeys(value, [
      'schemaVersion', 'phase', 'batchId', 'workId', 'transactionId', 'ownerSha256',
      'manifestPath', 'manifestSha256', 'preparedDigest', 'evidenceRefs', 'baseline',
      'acceptedAt', 'acceptedBy', ...(value.phase === 'verified' ? ['evidence'] : []),
    ]) ||
    value.schemaVersion !== '1.0.0' || !['prepared', 'verified'].includes(String(value.phase)) ||
    value.batchId !== 'F003' || typeof value.workId !== 'string' || !WORK_ID.test(value.workId) ||
    typeof value.transactionId !== 'string' || !UUID.test(value.transactionId) ||
    typeof value.ownerSha256 !== 'string' || !SHA256.test(value.ownerSha256) ||
    value.manifestPath !== 'content/batches/F003/batch.json' ||
    typeof value.manifestSha256 !== 'string' || !SHA256.test(value.manifestSha256) ||
    typeof value.preparedDigest !== 'string' || !SHA256.test(value.preparedDigest) ||
    typeof value.acceptedAt !== 'string' || !validInstant(value.acceptedAt) ||
    typeof value.acceptedBy !== 'string' || !value.acceptedBy.trim() ||
    !isRecord(value.evidenceRefs) || !isRecord(value.baseline)) {
    return fail('F003_ACCEPTANCE_JOURNAL_INVALID', 'journal schema/tupleが不正です');
  }
  const journal = value as unknown as F003AcceptanceJournal;
  if (journal.ownerSha256 !== ownerSha(journal) ||
    (journal.phase === 'verified' && !isRecord(journal.evidence))) {
    return fail('F003_ACCEPTANCE_JOURNAL_OWNER_INVALID', 'journal owner/evidenceが一致しません');
  }
  return journal;
}

async function writeJournal(root: string, path: string, journal: F003AcceptanceJournal): Promise<Sha256> {
  await mkdir(dirname(path), { recursive: true });
  await writeJsonArtifactAtomic(root, path, journal, {
    expectedFingerprint: await fingerprintArtifact(path),
  });
  return hash(await readFile(path));
}

async function rereadPrepared(root: string, prepared: PreparedWorkAcceptance): Promise<PreparedWorkAcceptance> {
  const current = await prepareWorkAcceptance(
    root,
    prepared.manifestPath,
    prepared.workId,
    prepared.evidenceRefs,
    prepared.baseline,
  );
  if (current.preparedDigest !== prepared.preparedDigest ||
    current.artifactTreeDigest !== prepared.artifactTreeDigest) {
    return fail('F003_ACCEPTANCE_INPUT_STALE', 'prepare後にcanonical work artifactが変化しました');
  }
  return current;
}

function acceptedManifestMatchesEvidence(
  manifest: BatchManifest,
  workId: WorkId,
  evidence: WorkAcceptanceEvidence,
): boolean {
  const work = manifest.workProgress[manifest.workIds.indexOf(workId)];
  if (!work || work.status !== 'accepted' ||
    work.acceptedBy !== evidence.acceptedBy ||
    work.acceptedAt !== evidence.acceptedAt ||
    canonicalJson(work.acceptedAudioSources ?? []) !== canonicalJson(evidence.acceptedSources)) {
    return false;
  }
  const expectedRecord = {
    stage: 'accepted',
    inputHashes: [
      evidence.expectedManifestSha,
      evidence.preTreeDigest,
      evidence.contentBuildSha,
      evidence.contentStagingSha,
      evidence.distSha,
      evidence.actualCapacityReportSha,
      evidence.f001ContentInvariantReportSha,
      evidence.f001DistInvariantReportSha,
    ],
    toolVersion: 'accepted-audio-transaction-v1',
    outputHashes: [evidence.postTreeDigest, ...evidence.acceptedSources.map((source) => source.sha256)],
    count: evidence.acceptedSources.length,
    completedAt: evidence.acceptedAt,
  };
  return canonicalJson(work.stageRecords.at(-1)) === canonicalJson(expectedRecord);
}

/**
 * 既存audio+manifest transactionへ、再検証済みF003 work artifact digestを結合して昇格する。
 * @des DES-F003-008 @fun FUN-F003-020 @ut UT-F003-020
 */
export async function promoteVerifiedWorkArtifacts(
  workspace: string,
  prepared: PreparedWorkAcceptance,
  expectedManifestSha: Sha256 | string,
  options: F003PromotionOptions = {},
): Promise<F003PromotionResult> {
  assertPrepared(prepared);
  const root = await verifiedWorkspace(workspace);
  const path = journalPath(root, prepared.workId);
  let journal: F003AcceptanceJournal | undefined;
  try {
    journal = parseJournal(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (journal) {
    const verifiedAccepted = journal.phase === 'verified' && prepared.manifestStatus === 'accepted';
    let verifiedAcceptedResume = false;
    let acceptedTupleValid = !verifiedAccepted;
    if (verifiedAccepted && journal.evidence) {
      const currentManifest = await loadCanonicalManifest(root, prepared.manifestPath, prepared.workId);
      acceptedTupleValid = currentManifest.sha256 === prepared.manifestSha256 &&
        journal.evidence.acceptedBy === journal.acceptedBy &&
        journal.evidence.workId === prepared.workId &&
        acceptedManifestMatchesEvidence(currentManifest.manifest, prepared.workId, journal.evidence);
      verifiedAcceptedResume = acceptedTupleValid && expectedManifestSha === prepared.manifestSha256;
    }
    if (journal.workId !== prepared.workId || journal.preparedDigest !== prepared.preparedDigest ||
      (journal.manifestSha256 !== expectedManifestSha && !verifiedAcceptedResume) ||
      !acceptedTupleValid) {
      return fail('F003_ACCEPTANCE_JOURNAL_CONFLICT', '既存journalとprepared/manifest tupleが一致しません');
    }
  } else {
    if (expectedManifestSha !== prepared.manifestSha256) {
      return fail('F003_ACCEPTANCE_MANIFEST_STALE', 'expected manifest SHAがprepare時点と一致しません');
    }
    const transactionId = randomUUID();
    const acceptedAt = options.acceptedAt ?? new Date().toISOString();
    const partial = {
      schemaVersion: '1.0.0' as const,
      phase: 'prepared' as const,
      batchId: 'F003' as const,
      workId: prepared.workId,
      transactionId,
      manifestPath: prepared.manifestPath,
      manifestSha256: expectedManifestSha as Sha256,
      preparedDigest: prepared.preparedDigest,
      evidenceRefs: prepared.evidenceRefs,
      baseline: prepared.baseline,
      acceptedAt,
      acceptedBy: `f003-acceptance:${prepared.preparedDigest}`,
    };
    journal = { ...partial, ownerSha256: ownerSha(partial) };
    await writeJournal(root, path, journal);
  }
  const current = await rereadPrepared(root, prepared);
  if (journal.phase === 'verified') {
    return {
      evidence: journal.evidence!,
      journalPath: path,
      journalSha256: hash(await readFile(path)),
    };
  }
  const promoter = options.promoter ?? promoteVerifiedWorkArtifactsV2;
  const voice = current.voiceCompleteness.payload;
  const capacity = current.capacityActual.payload;
  const content = current.baselineContent.payload;
  const dist = current.baselineDist.payload;
  const evidence = await promoter(
    root,
    'F003' as BatchId,
    current.workId,
    resolveVoiceGenerationPaths(root, voice.generation),
    voice.completeness,
    capacity.actual,
    content.preview,
    dist.preview,
    content.invariant,
    dist.invariant,
    {
      acceptedAt: journal.acceptedAt,
      acceptedBy: journal.acceptedBy,
      ...(options.afterPhase ? { afterPhase: options.afterPhase } : {}),
    },
  );
  const verified: F003AcceptanceJournal = { ...journal, phase: 'verified', evidence };
  const journalSha256 = await writeJournal(root, path, verified);
  return { evidence, journalPath: path, journalSha256 };
}

/**
 * 外側journalと既存accepted-audio journalから同じprepared tupleを再構築して再開する。
 * @des DES-F003-008 @fun FUN-F003-021 @ut UT-F003-021
 */
export async function recoverWorkAcceptance(
  workspace: string,
  journalFile: string,
  options: Omit<F003PromotionOptions, 'acceptedAt'> = {},
): Promise<F003PromotionResult> {
  const root = await verifiedWorkspace(workspace);
  const transactionRoot = join(root, ...ACCEPTANCE_ROOT.split('/'));
  const relation = relative(transactionRoot, resolve(journalFile));
  if (!isAbsolute(journalFile) || !/^F003-[0-9]{6}\.json$/u.test(relation) ||
    resolve(journalFile) !== join(transactionRoot, relation)) {
    return fail('F003_ACCEPTANCE_JOURNAL_PATH_INVALID', 'journal pathがcanonical transaction root外です');
  }
  await assertNoReparse(root, resolve(journalFile));
  const journal = parseJournal(await readFile(journalFile, 'utf8'));
  const prepared = await prepareWorkAcceptance(
    root,
    journal.manifestPath,
    journal.workId,
    journal.evidenceRefs,
    journal.baseline,
  );
  if (prepared.preparedDigest !== journal.preparedDigest) {
    return fail('F003_ACCEPTANCE_INPUT_STALE', 'journalの原artifact digestが現在値と一致しません');
  }
  return promoteVerifiedWorkArtifacts(root, prepared, journal.manifestSha256, options);
}
