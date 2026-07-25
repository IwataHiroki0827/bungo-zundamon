import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  ArtifactWriteError,
  canonicalJson,
  fingerprintArtifact,
  writeJsonArtifactAtomic,
} from './artifacts.ts';

export type BatchId = string & { readonly __batchId: unique symbol };
export type WorkId = string & { readonly __workId: unique symbol };
export type Sha256 = string & { readonly __sha256: unique symbol };
export type WorkspaceRelativePath = string & { readonly __workspaceRelativePath: unique symbol };

export type BatchStatus =
  | 'draft'
  | 'rights-verified'
  | 'sources-fixed'
  | 'extracted'
  | 'reviewed'
  | 'budget-approved'
  | 'voiced'
  | 'accepted'
  | 'published';

export type WorkStatus = 'pending' | 'extracted' | 'reviewed' | 'budget-approved' | 'voiced' | 'accepted';
export type PassingResult = 'pass' | 'pass_with_warning';

export interface BatchAuthor {
  readonly authorId: string;
  readonly name: string;
  readonly originalName: string;
  readonly slug: string;
  readonly identitySha256: Sha256;
}

export interface StageRecord {
  readonly stage: string;
  readonly inputHashes: readonly Sha256[];
  readonly toolVersion: string;
  readonly outputHashes: readonly Sha256[];
  readonly count: number;
  readonly completedAt: string;
}

export interface AcceptedAudioSource {
  readonly path: WorkspaceRelativePath;
  readonly sha256: Sha256;
  readonly bytes: number;
  readonly configHash: Sha256;
}

export interface WorkProgress {
  readonly workId: WorkId;
  readonly status: WorkStatus;
  readonly stageRecords: readonly StageRecord[];
  readonly forecastRef?: WorkspaceRelativePath;
  readonly actualCapacityRef?: WorkspaceRelativePath;
  readonly voiceEvidenceRef?: WorkspaceRelativePath;
  readonly acceptedAudioSources?: readonly AcceptedAudioSource[];
  readonly acceptedAt?: string;
  readonly acceptedBy?: string;
}

export interface BatchManifest {
  readonly batchId: BatchId;
  readonly feature: string;
  readonly schemaVersion: string;
  readonly status: BatchStatus;
  readonly author: BatchAuthor;
  readonly workIds: readonly [WorkId, WorkId, WorkId];
  readonly workProgress: readonly [WorkProgress, WorkProgress, WorkProgress];
  readonly inputPaths: readonly WorkspaceRelativePath[];
  readonly outputPaths: readonly WorkspaceRelativePath[];
  readonly stageRecords: readonly StageRecord[];
  readonly rightsSnapshotIds: readonly string[];
  readonly voiceConfigRef: WorkspaceRelativePath;
  readonly artworkProvenanceRef: WorkspaceRelativePath;
  readonly acceptedAt?: string;
  readonly acceptedBy?: string;
  readonly publishedAt?: string;
  readonly releaseVersion?: string;
  readonly deploymentEvidenceRef?: WorkspaceRelativePath;
  readonly smokeEvidenceRef?: WorkspaceRelativePath;
  readonly approvalGateRefs?: BatchApprovalGateRefs;
  readonly editionRules?: readonly BatchEditionRule[];
}

export interface BatchEditionRule {
  readonly title: string;
  readonly preferredWorkId: string;
  readonly fallbackWorkIds?: readonly string[];
  readonly allowedWorkIds: readonly string[];
  readonly reason: string;
}

export interface BatchApprovalGateRefs {
  readonly requirements: WorkspaceRelativePath;
  readonly design: WorkspaceRelativePath;
  readonly testspec: WorkspaceRelativePath;
  readonly release: WorkspaceRelativePath;
}

export interface BatchCandidateWork {
  readonly workId: string;
  readonly title: string;
}

export interface BatchCandidate {
  readonly candidateId: string;
  readonly approved: boolean;
  readonly author: BatchAuthor;
  readonly works: readonly BatchCandidateWork[];
  readonly approvalGateRefs: BatchApprovalGateRefs;
  readonly existingFeatureIds?: readonly string[];
  readonly artifactPaths?: readonly string[];
  readonly initialStatus?: BatchStatus;
  readonly schemaVersion?: string;
}

export interface StageEvidence extends StageRecord {
  readonly kind: 'stage';
  readonly expectedManifestSha: Sha256;
  readonly workId?: WorkId;
  readonly result?: PassingResult | 'blocked';
  readonly pendingCount?: number;
  readonly forecastRef?: WorkspaceRelativePath;
  readonly actualCapacityRef?: WorkspaceRelativePath;
  readonly voiceEvidenceRef?: WorkspaceRelativePath;
  readonly acceptedAt?: string;
  readonly acceptedBy?: string;
}

export interface PreparedWorkAcceptanceEvidence {
  readonly kind: 'accepted';
  readonly batchId: BatchId;
  readonly workId: WorkId;
  readonly expectedManifestSha: Sha256;
  readonly acceptedSources: readonly AcceptedAudioSource[];
  readonly preTreeDigest: Sha256;
  readonly postTreeDigest: Sha256;
  readonly contentBuildSha: Sha256;
  readonly contentStagingSha: Sha256;
  readonly distSha: Sha256;
  readonly actualCapacityReportSha: Sha256;
  readonly f001ContentInvariantReportSha: Sha256;
  readonly f001DistInvariantReportSha: Sha256;
  readonly journalId: string;
  readonly acceptedAt: string;
  readonly acceptedBy: string;
}

export type WorkTransitionEvidence = StageEvidence | PreparedWorkAcceptanceEvidence;

export type BatchValidationCode =
  | 'BATCH_SCHEMA_INVALID'
  | 'BATCH_ID_INVALID'
  | 'BATCH_WORK_DUPLICATE'
  | 'BATCH_PATH_INVALID'
  | 'BATCH_STAGE_HASH_MISMATCH';

export type BatchTransitionCode =
  | 'BATCH_STATE_SKIP'
  | 'BATCH_STATE_REWIND'
  | 'BATCH_GATE_INCOMPLETE'
  | 'BATCH_EVIDENCE_STALE';

export type WorkTransitionCode =
  | 'WORK_STATE_SKIP'
  | 'WORK_STATE_REWIND'
  | 'WORK_ORDER_BLOCKED'
  | 'WORK_GATE_INCOMPLETE'
  | 'WORK_EVIDENCE_STALE';

export type BatchWriteCode =
  | 'BATCH_WRITE_CONFLICT'
  | 'BATCH_WORKSPACE_BOUNDARY'
  | 'BATCH_FILE_SYNC_FAILED'
  | 'BATCH_ATOMIC_RENAME_FAILED'
  | 'BATCH_POSTWRITE_MISMATCH';

export type NextBatchCode =
  | 'NEXT_BATCH_NOT_APPROVED'
  | 'NEXT_BATCH_FEATURE_COLLISION'
  | 'NEXT_BATCH_WORKS_INCOMPLETE';

export type PublishBatchCode =
  | 'PUBLISH_NOT_ACCEPTED'
  | 'PUBLISH_CANDIDATE_MISMATCH'
  | 'PUBLISH_APPROVAL_MISMATCH'
  | 'PUBLISH_DEPLOYMENT_MISMATCH'
  | 'PUBLISH_SMOKE_FAILED'
  | 'PUBLISH_DEPLOY_FLAG_ACTIVE';

export type BatchManifestJournalPhase = 'prepared' | 'replaced' | 'verified';
export type PublishBatchJournalPhase =
  | 'deploy-verified'
  | 'manifest-prepared'
  | 'manifest-written'
  | 'published-verified';

export interface BatchManifestWriteOptions {
  /** UT専用fault境界。phaseのjournalをdurable化した直後に呼ぶ。 */
  readonly afterPhase?: (phase: BatchManifestJournalPhase) => void | Promise<void>;
}

export interface ReleasePreparationContext {
  readonly releaseCandidateBatchId: BatchId;
  readonly feature: string;
  readonly sourceCommit: string;
}

export interface ReleaseBuildContext {
  readonly releaseCandidateBatchId: BatchId;
  readonly feature: string;
  readonly releaseCommit: string;
  readonly distSha256: Sha256;
  readonly artifactDigest: Sha256;
}

export interface ReleaseApproval extends ReleaseBuildContext {
  readonly result: 'approved';
  readonly approvedAt: string;
  readonly releaseVersion: string;
  readonly evidenceRef: WorkspaceRelativePath;
  readonly evidenceSha256: Sha256;
}

export interface DeploymentEvidence extends ReleaseBuildContext {
  readonly result: 'success';
  readonly deployedAt: string;
  readonly evidenceRef: WorkspaceRelativePath;
  readonly evidenceSha256: Sha256;
  readonly deployFlagDisabled: boolean;
}

export interface PublicSmokeEvidence extends ReleaseBuildContext {
  readonly result: 'pass';
  readonly checkedAt: string;
  readonly evidenceRef: WorkspaceRelativePath;
  readonly evidenceSha256: Sha256;
  readonly allRoutesCovered: boolean;
  readonly expectedRoutes: readonly string[];
  readonly routes: readonly string[];
}

export interface PublishBatchOptions {
  /** UT専用fault境界。publish phaseのjournalをdurable化した直後に呼ぶ。 */
  readonly afterPhase?: (phase: PublishBatchJournalPhase) => void | Promise<void>;
  /** UT専用fault境界。内側のFUN-F002-003へそのまま渡す。 */
  readonly manifestWriteOptions?: BatchManifestWriteOptions;
}

export interface PublishableBatch {
  readonly manifest: BatchManifest;
  readonly manifestPath: WorkspaceRelativePath;
  readonly manifestSha256: Sha256;
  readonly acceptedAudioSources: readonly AcceptedAudioSource[];
  readonly candidate: boolean;
}

export interface LoadAcceptedBatchOptions {
  readonly excludeActiveBatchId?: BatchId;
  readonly preparation?: ReleasePreparationContext;
  readonly release?: ReleaseBuildContext;
}

export type BatchDiscoveryCode =
  | 'BATCH_DISCOVERY_PATH_UNSAFE'
  | 'BATCH_MANIFEST_NONCANONICAL'
  | 'BATCH_HASH_CHAIN_INVALID'
  | 'BATCH_RELEASE_CANDIDATE_MISSING'
  | 'BATCH_RELEASE_CANDIDATE_DUPLICATE'
  | 'BATCH_RELEASE_CANDIDATE_MISMATCH'
  | 'BATCH_RELEASE_CHECKOUT_DIRTY'
  | 'BATCH_ACCEPTED_AUDIO_MISSING'
  | 'BATCH_ACCEPTED_AUDIO_HASH_MISMATCH'
  | 'BATCH_AUTHOR_CONFLICT'
  | 'BATCH_ARTIFACT_MISSING';

export interface ValidationIssue {
  readonly code: BatchValidationCode;
  readonly message: string;
  readonly path?: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly success: true; readonly value: T; readonly issues: readonly [] }
  | { readonly ok: false; readonly success: false; readonly error: ValidationIssue; readonly issues: readonly ValidationIssue[] };

export class BatchOperationError extends Error {
  constructor(
    public readonly code: BatchValidationCode | BatchTransitionCode | WorkTransitionCode | BatchWriteCode | NextBatchCode |
      BatchDiscoveryCode | PublishBatchCode,
    message: string,
  ) {
    super(message);
    this.name = 'BatchOperationError';
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const BATCH_ID = /^F[0-9]{3}$/;
const WORK_ID = /^[0-9]{6}$/;
const AUTHOR_ID = /^[0-9]{6}$/;
const AUTHOR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FEATURE_ID = /^F[0-9]{3}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BATCH_STATUSES: readonly BatchStatus[] = [
  'draft', 'rights-verified', 'sources-fixed', 'extracted', 'reviewed', 'budget-approved', 'voiced', 'accepted', 'published',
];
const WORK_STATUSES: readonly WorkStatus[] = ['pending', 'extracted', 'reviewed', 'budget-approved', 'voiced', 'accepted'];
const F002_WORK_IDS = ['000473', '043752', '043754'] as const;
const validatedManifests = new WeakSet<object>();
const execFile = promisify(execFileCallback);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code: BatchValidationCode, message: string, path?: string): ValidationResult<never> {
  const error = { code, message, ...(path === undefined ? {} : { path }) };
  return { ok: false, success: false, error, issues: [error] };
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isAuthorText(value: unknown): value is string {
  return isText(value) && value === value.trim() &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 31 || character.codePointAt(0) === 127);
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function isSha(value: unknown): value is Sha256 {
  return typeof value === 'string' && SHA256.test(value);
}

function isSafePath(value: unknown): value is WorkspaceRelativePath {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) return false;
  if (value.startsWith('/') || value.includes(':') || value.includes('?') || value.includes('#') ||
    /%(?:0[0-9a-f]|1[0-9a-f]|2e|2f|5c|7f)/i.test(value)) return false;
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' &&
    !part.endsWith('.') && !part.endsWith(' ') && !reserved.test(part));
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isText);
}

function pathArray(value: unknown): value is readonly WorkspaceRelativePath[] {
  return Array.isArray(value) && value.every(isSafePath);
}

function approvalGateRefs(value: unknown): value is BatchApprovalGateRefs {
  return isRecord(value) && isSafePath(value.requirements) && isSafePath(value.design) &&
    isSafePath(value.testspec) && isSafePath(value.release) && Object.keys(value).length === 4;
}

function hashArray(value: unknown): value is readonly Sha256[] {
  return Array.isArray(value) && value.every(isSha);
}

function validateStageRecord(value: unknown): value is StageRecord {
  return isRecord(value) && isText(value.stage) && hashArray(value.inputHashes) && isText(value.toolVersion) &&
    hashArray(value.outputHashes) && Number.isSafeInteger(value.count) && (value.count as number) >= 0 && isInstant(value.completedAt);
}

function validateEditionRules(value: unknown, workIds: readonly string[]): value is readonly BatchEditionRule[] {
  return Array.isArray(value) && value.length === workIds.length && value.every((rule, index) =>
    isRecord(rule) && isAuthorText(rule.title) && rule.preferredWorkId === workIds[index] &&
    Array.isArray(rule.allowedWorkIds) && rule.allowedWorkIds.length > 0 && rule.allowedWorkIds.every((id) =>
      typeof id === 'string' && WORK_ID.test(id)) && rule.allowedWorkIds.includes(rule.preferredWorkId as string) &&
    (rule.fallbackWorkIds === undefined || (Array.isArray(rule.fallbackWorkIds) && rule.fallbackWorkIds.every((id) =>
      typeof id === 'string' && WORK_ID.test(id)))) && isAuthorText(rule.reason));
}

function validateStageChain(records: readonly StageRecord[]): boolean {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    // accepted recordはprepared transactionのtree/report hashへ結合し、直前stage出力を再包装しない。
    if (current?.stage === 'accepted') continue;
    if (!previous || !current || previous.outputHashes.length === 0 ||
      !previous.outputHashes.some((hash) => current.inputHashes.includes(hash))) return false;
  }
  return true;
}

function validateAcceptedSource(value: unknown, batchId: string): value is AcceptedAudioSource {
  if (!isRecord(value) || !isSafePath(value.path) || !isSha(value.sha256) || !isSha(value.configHash) ||
    !Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) return false;
  const prefix = `content/batches/${batchId}/accepted-audio/`;
  const rest = value.path.slice(prefix.length);
  const [ownerWorkId, fileName, ...extra] = rest.split('/');
  return value.path.startsWith(prefix) && /^\d{6}$/u.test(ownerWorkId ?? '') && extra.length === 0 &&
    /^[A-Za-z0-9_-]+\.wav$/u.test(fileName ?? '');
}

function validateWorkProgress(value: unknown, batchId: string, expectedWorkId: string): value is WorkProgress {
  if (!isRecord(value) || value.workId !== expectedWorkId || !WORK_STATUSES.includes(value.status as WorkStatus) ||
    !Array.isArray(value.stageRecords) || !value.stageRecords.every(validateStageRecord) ||
    !validateStageChain(value.stageRecords)) return false;
  for (const optionalPath of ['forecastRef', 'actualCapacityRef', 'voiceEvidenceRef'] as const) {
    if (value[optionalPath] !== undefined && !isSafePath(value[optionalPath])) return false;
  }
  if (value.acceptedAudioSources !== undefined && (!Array.isArray(value.acceptedAudioSources) ||
    !value.acceptedAudioSources.every((source) => validateAcceptedSource(source, batchId)))) return false;
  const accepted = value.status === 'accepted';
  if (accepted !== (isInstant(value.acceptedAt) && isText(value.acceptedBy) &&
    Array.isArray(value.acceptedAudioSources) && value.acceptedAudioSources.length > 0)) return false;
  if (!accepted && (value.acceptedAt !== undefined || value.acceptedBy !== undefined || value.acceptedAudioSources !== undefined)) return false;
  if (value.status === 'pending' && value.stageRecords.length !== 0) return false;
  if (value.status === 'voiced' && value.stageRecords.at(-1)?.stage === 'capacity-actual') {
    if (value.stageRecords.at(-2)?.stage !== 'voiced' || value.actualCapacityRef === undefined) return false;
  } else if (value.status !== 'pending' && value.stageRecords.at(-1)?.stage !== value.status) return false;
  return true;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

export function hashBatchManifest(manifest: BatchManifest): Sha256 {
  return sha256(canonicalJson(manifest));
}

/** @des DES-F002-002 DES-F002-014 @fun FUN-F002-001 */
export function validateBatchManifest(value: unknown): ValidationResult<BatchManifest> {
  if (isRecord(value) && validatedManifests.has(value)) {
    return { ok: true, success: true, value: value as unknown as BatchManifest, issues: [] };
  }
  if (!isRecord(value)) return fail('BATCH_SCHEMA_INVALID', 'batch manifestはobjectで指定してください');
  if (!isText(value.batchId) || !BATCH_ID.test(value.batchId)) return fail('BATCH_ID_INVALID', 'batchIdが不正です', 'batchId');
  if (!isText(value.feature) || !FEATURE_ID.test(value.feature) || !isText(value.schemaVersion) || !SEMVER.test(value.schemaVersion) ||
    !BATCH_STATUSES.includes(value.status as BatchStatus)) return fail('BATCH_SCHEMA_INVALID', 'feature/schemaVersion/statusが不正です');
  if (!isRecord(value.author) || typeof value.author.authorId !== 'string' || !AUTHOR_ID.test(value.author.authorId) ||
    !isAuthorText(value.author.name) || !isAuthorText(value.author.originalName) ||
    typeof value.author.slug !== 'string' || !AUTHOR_SLUG.test(value.author.slug) || !isSha(value.author.identitySha256)) {
    return fail('BATCH_SCHEMA_INVALID', 'authorが不正です', 'author');
  }
  if (!Array.isArray(value.workIds) || value.workIds.length !== 3 || !value.workIds.every((id) => isText(id) && WORK_ID.test(id))) {
    return fail('BATCH_SCHEMA_INVALID', 'workIdsは6桁IDをちょうど3件指定してください', 'workIds');
  }
  const workIds = value.workIds as string[];
  if (new Set(workIds).size !== 3) return fail('BATCH_WORK_DUPLICATE', 'work IDが重複しています', 'workIds');
  if (value.batchId === 'F002' && (value.author.authorId !== '000081' ||
    workIds.some((id, index) => id !== F002_WORK_IDS[index]))) {
    return fail('BATCH_SCHEMA_INVALID', 'F002のauthor/work順がfixtureと一致しません');
  }
  if (value.editionRules !== undefined && !validateEditionRules(value.editionRules, workIds)) {
    return fail('BATCH_SCHEMA_INVALID', 'editionRulesがmanifest work順・allowlistと一致しません');
  }
  if (!Array.isArray(value.workProgress) || value.workProgress.length !== 3 ||
    !value.workProgress.every((work, index) => validateWorkProgress(work, value.batchId as string, workIds[index] as string))) {
    return fail('BATCH_STAGE_HASH_MISMATCH', 'workProgressの状態、順序、stage hash chainが不正です', 'workProgress');
  }
  if (!pathArray(value.inputPaths) || !pathArray(value.outputPaths) || !isSafePath(value.voiceConfigRef) ||
    !isSafePath(value.artworkProvenanceRef) ||
    (value.deploymentEvidenceRef !== undefined && !isSafePath(value.deploymentEvidenceRef)) ||
    (value.smokeEvidenceRef !== undefined && !isSafePath(value.smokeEvidenceRef)) ||
    (value.approvalGateRefs !== undefined && !approvalGateRefs(value.approvalGateRefs))) {
    return fail('BATCH_PATH_INVALID', 'manifestに危険なworkspace相対pathがあります');
  }
  if (!Array.isArray(value.stageRecords) || !value.stageRecords.every(validateStageRecord) ||
    !validateStageChain(value.stageRecords)) return fail('BATCH_STAGE_HASH_MISMATCH', 'batch stage hash chainが不正です', 'stageRecords');
  if (!stringArray(value.rightsSnapshotIds)) return fail('BATCH_SCHEMA_INVALID', 'rightsSnapshotIdsが不正です');
  const workStatuses = (value.workProgress as WorkProgress[]).map((work) => work.status);
  const minimumWorkRank = Math.min(...workStatuses.map(workRank));
  const manifestStatus = value.status as BatchStatus;
  if (minimumWorkRank === 0) {
    if (batchRank(manifestStatus) > batchRank('sources-fixed')) {
      return fail('BATCH_SCHEMA_INVALID', 'pending workを含むbatchはreviewed以降を名乗れません');
    }
  } else {
    const expectedStatus = WORK_STATUSES[minimumWorkRank] as Exclude<WorkStatus, 'pending'>;
    if (manifestStatus !== expectedStatus && !(manifestStatus === 'published' && expectedStatus === 'accepted')) {
      return fail('BATCH_SCHEMA_INVALID', 'batch statusがworkProgressの最低状態と一致しません');
    }
  }
  if (batchRank(manifestStatus) > batchRank('draft') && batchRank(manifestStatus) <= batchRank('sources-fixed') &&
    value.stageRecords.at(-1)?.stage !== manifestStatus) {
    return fail('BATCH_STAGE_HASH_MISMATCH', 'batch前段statusと末尾stage recordが一致しません');
  }
  const accepted = value.status === 'accepted' || value.status === 'published';
  const published = value.status === 'published';
  if (accepted !== (isInstant(value.acceptedAt) && isText(value.acceptedBy))) {
    return fail('BATCH_SCHEMA_INVALID', 'accepted状態と受入項目が矛盾しています');
  }
  const publishFields = [value.publishedAt, value.releaseVersion, value.deploymentEvidenceRef, value.smokeEvidenceRef];
  if (published) {
    if (!isInstant(value.publishedAt) || !isText(value.releaseVersion) || !isSafePath(value.deploymentEvidenceRef) ||
      !isSafePath(value.smokeEvidenceRef)) return fail('BATCH_SCHEMA_INVALID', 'published状態の必須項目が不足しています');
  } else if (publishFields.some((field) => field !== undefined)) {
    return fail('BATCH_SCHEMA_INVALID', 'published以前にpublish項目は指定できません');
  }
  const cloned = freezeDeep(cloneJson(value) as unknown as BatchManifest);
  validatedManifests.add(cloned as object);
  return { ok: true, success: true, value: cloned, issues: [] };
}

function requireManifest(value: BatchManifest): BatchManifest {
  const result = validateBatchManifest(value);
  if (!result.ok) throw new BatchOperationError(result.error.code, result.error.message);
  return result.value;
}

function recordFromEvidence(evidence: StageEvidence): StageRecord {
  return {
    stage: evidence.stage,
    inputHashes: [...evidence.inputHashes],
    toolVersion: evidence.toolVersion,
    outputHashes: [...evidence.outputHashes],
    count: evidence.count,
    completedAt: evidence.completedAt,
  };
}

function sameStage(left: StageRecord, right: StageRecord): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertFresh(manifest: BatchManifest, expected: string, code: 'BATCH_EVIDENCE_STALE' | 'WORK_EVIDENCE_STALE'): void {
  if (hashBatchManifest(manifest) !== expected) throw new BatchOperationError(code, '証跡のexpected manifest SHAが古くなっています');
}

function workRank(status: WorkStatus): number {
  return WORK_STATUSES.indexOf(status);
}

function batchRank(status: BatchStatus): number {
  return BATCH_STATUSES.indexOf(status);
}

function batchStatusFromWorks(manifest: BatchManifest, works: readonly WorkProgress[]): BatchStatus {
  const minimum = Math.min(...works.map((work) => workRank(work.status)));
  if (minimum === 0) return batchRank(manifest.status) <= batchRank('sources-fixed') ? manifest.status : 'sources-fixed';
  return WORK_STATUSES[minimum] as Exclude<WorkStatus, 'pending'>;
}

function finalizeManifest(value: BatchManifest): BatchManifest {
  const result = validateBatchManifest(value);
  if (!result.ok) throw new BatchOperationError(result.error.code, result.error.message);
  return result.value;
}

/** @des DES-F002-002 DES-F002-015 @fun FUN-F002-002 */
export function transitionBatchState(manifestValue: BatchManifest, next: BatchStatus, evidence: StageEvidence): BatchManifest {
  const manifest = requireManifest(manifestValue);
  if (!BATCH_STATUSES.includes(next) || next === 'published') throw new BatchOperationError('BATCH_STATE_SKIP', 'published遷移は専用処理だけが実行できます');
  if (evidence.kind !== 'stage' || !validateStageRecord(evidence)) throw new BatchOperationError('BATCH_GATE_INCOMPLETE', 'batch stage evidenceが不正です');
  const record = recordFromEvidence(evidence);
  if (next === manifest.status && manifest.stageRecords.some((item) => sameStage(item, record))) return manifest;
  const currentRank = batchRank(manifest.status);
  const nextRank = batchRank(next);
  if (nextRank < currentRank) throw new BatchOperationError('BATCH_STATE_REWIND', 'batch状態を巻き戻せません');
  if (nextRank !== currentRank + 1) throw new BatchOperationError('BATCH_STATE_SKIP', 'batch状態を飛ばせません');
  assertFresh(manifest, evidence.expectedManifestSha, 'BATCH_EVIDENCE_STALE');
  if (nextRank >= batchRank('reviewed')) {
    const required = WORK_STATUSES.indexOf(next as WorkStatus);
    if (manifest.workProgress.some((work) => workRank(work.status) < required)) {
      throw new BatchOperationError('BATCH_GATE_INCOMPLETE', '全workがbatch遷移先の状態へ到達していません');
    }
  }
  if (evidence.result === 'blocked') throw new BatchOperationError('BATCH_GATE_INCOMPLETE', 'blocked証跡では遷移できません');
  const acceptedFields = next === 'accepted'
    ? { acceptedAt: evidence.acceptedAt, acceptedBy: evidence.acceptedBy }
    : {};
  if (next === 'accepted' && (!isInstant(evidence.acceptedAt) || !isText(evidence.acceptedBy))) {
    throw new BatchOperationError('BATCH_GATE_INCOMPLETE', 'accepted遷移に受入日時・担当が必要です');
  }
  return finalizeManifest({
    ...manifest,
    status: next,
    stageRecords: [...manifest.stageRecords, record],
    ...acceptedFields,
  });
}

function assertStageGate(current: WorkStatus, next: WorkStatus, evidence: StageEvidence, workId: WorkId): void {
  if (evidence.workId !== workId) {
    throw new BatchOperationError('WORK_EVIDENCE_STALE', '証跡のwork IDが対象と一致しません');
  }
  if (evidence.stage !== next) throw new BatchOperationError('WORK_GATE_INCOMPLETE', '証跡stageと遷移先が一致しません');
  if (evidence.result === 'blocked') throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'blocked証跡では遷移できません');
  if (current === 'extracted' && next === 'reviewed' && evidence.pendingCount !== 0) {
    throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'reviewed遷移にはpending 0が必要です');
  }
  if (current === 'reviewed' && next === 'budget-approved' &&
    ((evidence.result !== 'pass' && evidence.result !== 'pass_with_warning') || !isSafePath(evidence.forecastRef))) {
    throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'budget-approved遷移にはPASS容量予測が必要です');
  }
  if (current === 'budget-approved' && next === 'voiced' &&
    (evidence.result !== 'pass' || !isSafePath(evidence.voiceEvidenceRef))) {
    throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'voiced遷移には音声完全性PASSが必要です');
  }
}

function validatePreparedEvidence(evidence: PreparedWorkAcceptanceEvidence, manifest: BatchManifest, workId: WorkId): void {
  const hashes = [
    evidence.expectedManifestSha, evidence.preTreeDigest, evidence.postTreeDigest, evidence.contentBuildSha,
    evidence.contentStagingSha, evidence.distSha, evidence.actualCapacityReportSha,
    evidence.f001ContentInvariantReportSha, evidence.f001DistInvariantReportSha,
  ];
  if (evidence.kind !== 'accepted' || evidence.batchId !== manifest.batchId || evidence.workId !== workId ||
    !hashes.every(isSha) || !isText(evidence.journalId) || !isInstant(evidence.acceptedAt) || !isText(evidence.acceptedBy) ||
    !Array.isArray(evidence.acceptedSources) || evidence.acceptedSources.length === 0 ||
    !evidence.acceptedSources.every((source) => validateAcceptedSource(source, manifest.batchId)) ||
    new Set(evidence.acceptedSources.map((source) => source.path)).size !== evidence.acceptedSources.length) {
    throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'prepared acceptance evidenceが不完全です');
  }
}

function acceptedRecord(evidence: PreparedWorkAcceptanceEvidence): StageRecord {
  return {
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
}

/** @des DES-F002-002 DES-F002-014 DES-F002-015 @fun FUN-F002-031 */
export function transitionWorkState(
  manifestValue: BatchManifest,
  workId: WorkId,
  next: WorkStatus,
  evidence: WorkTransitionEvidence,
): BatchManifest {
  const manifest = requireManifest(manifestValue);
  const index = manifest.workIds.indexOf(workId);
  if (index < 0) throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'work IDがmanifestにありません');
  const current = manifest.workProgress[index];
  if (!current || !WORK_STATUSES.includes(next)) throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'work状態が不正です');
  if (next === 'accepted') {
    if (evidence.kind !== 'accepted') throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'acceptedにはprepared evidenceが必要です');
    validatePreparedEvidence(evidence, manifest, workId);
  } else if (evidence.kind !== 'stage' || !validateStageRecord(evidence)) {
    throw new BatchOperationError('WORK_GATE_INCOMPLETE', '通常遷移にはstage evidenceが必要です');
  }
  const record = evidence.kind === 'stage' ? recordFromEvidence(evidence) : acceptedRecord(evidence);
  if (next === current.status && current.stageRecords.some((item) => sameStage(item, record))) return manifest;
  const currentRank = workRank(current.status);
  const nextRank = workRank(next);
  if (nextRank < currentRank) throw new BatchOperationError('WORK_STATE_REWIND', 'work状態を巻き戻せません');
  if (nextRank !== currentRank + 1) throw new BatchOperationError('WORK_STATE_SKIP', 'work状態を飛ばせません');
  if (nextRank >= workRank('reviewed') && index > 0 && manifest.workProgress[index - 1]?.status !== 'accepted') {
    throw new BatchOperationError('WORK_ORDER_BLOCKED', '直前workがacceptedになるまでreviewed以降へ進めません');
  }
  assertFresh(manifest, evidence.expectedManifestSha, 'WORK_EVIDENCE_STALE');
  let updatedWork: WorkProgress;
  if (next === 'accepted') {
    // 上のdiscriminant検査により、ここではaccepted evidenceだけに絞られている。
    if (evidence.kind !== 'accepted') throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'accepted evidenceが必要です');
    updatedWork = {
      ...current,
      status: next,
      stageRecords: [...current.stageRecords, record],
      acceptedAudioSources: [...evidence.acceptedSources],
      acceptedAt: evidence.acceptedAt,
      acceptedBy: evidence.acceptedBy,
    };
  } else {
    if (evidence.kind !== 'stage') throw new BatchOperationError('WORK_GATE_INCOMPLETE', 'stage evidenceが必要です');
    assertStageGate(current.status, next, evidence, workId);
    updatedWork = {
      ...current,
      status: next,
      stageRecords: [...current.stageRecords, record],
      ...(evidence.forecastRef === undefined ? {} : { forecastRef: evidence.forecastRef }),
      ...(evidence.actualCapacityRef === undefined ? {} : { actualCapacityRef: evidence.actualCapacityRef }),
      ...(evidence.voiceEvidenceRef === undefined ? {} : { voiceEvidenceRef: evidence.voiceEvidenceRef }),
    };
  }
  const works = manifest.workProgress.map((work, workIndex) => workIndex === index ? updatedWork : work) as unknown as
    readonly [WorkProgress, WorkProgress, WorkProgress];
  const status = batchStatusFromWorks(manifest, works);
  const acceptedFields = status === 'accepted'
    ? { acceptedAt: updatedWork.acceptedAt, acceptedBy: updatedWork.acceptedBy }
    : {};
  return finalizeManifest({ ...manifest, workProgress: works, status, ...acceptedFields });
}

/** @des DES-F002-014 @fun FUN-F002-028 */
export function createNextBatchTemplate(candidate: BatchCandidate, nextFeature: BatchId): BatchManifest {
  if (!isRecord(candidate) || candidate.approved !== true || !isText(candidate.candidateId) ||
    (candidate.initialStatus !== undefined && candidate.initialStatus !== 'draft') ||
    (Array.isArray(candidate.artifactPaths) && candidate.artifactPaths.length > 0) ||
    !approvalGateRefs(candidate.approvalGateRefs)) {
    throw new BatchOperationError('NEXT_BATCH_NOT_APPROVED', '承認済みでartifactを含まないcandidateと4承認gate参照が必要です');
  }
  if (!isText(nextFeature) || !BATCH_ID.test(nextFeature) || candidate.existingFeatureIds?.includes(nextFeature)) {
    throw new BatchOperationError('NEXT_BATCH_FEATURE_COLLISION', 'next feature IDが不正または使用済みです');
  }
  if (!isRecord(candidate.author) || typeof candidate.author.authorId !== 'string' || !AUTHOR_ID.test(candidate.author.authorId) ||
    !isAuthorText(candidate.author.name) || !isAuthorText(candidate.author.originalName) ||
    typeof candidate.author.slug !== 'string' || !AUTHOR_SLUG.test(candidate.author.slug) || !isSha(candidate.author.identitySha256) ||
    !Array.isArray(candidate.works) || candidate.works.length !== 3 ||
    !candidate.works.every((work) => isRecord(work) && isText(work.workId) && WORK_ID.test(work.workId) && isText(work.title)) ||
    new Set(candidate.works.map((work) => work.workId)).size !== 3) {
    throw new BatchOperationError('NEXT_BATCH_WORKS_INCOMPLETE', 'authorと重複のない代表3作品を明示してください');
  }
  const workIds = candidate.works.map((work) => work.workId as WorkId) as [WorkId, WorkId, WorkId];
  return finalizeManifest({
    batchId: nextFeature,
    feature: nextFeature,
    schemaVersion: candidate.schemaVersion ?? '1.0.0',
    status: 'draft',
    author: cloneJson(candidate.author),
    workIds,
    workProgress: workIds.map((workId) => ({ workId, status: 'pending' as const, stageRecords: [] })) as unknown as
      [WorkProgress, WorkProgress, WorkProgress],
    inputPaths: [],
    outputPaths: [],
    stageRecords: [],
    rightsSnapshotIds: [],
    voiceConfigRef: `content/batches/${nextFeature}/voice-config.json` as WorkspaceRelativePath,
    artworkProvenanceRef: `content/batches/${nextFeature}/artwork-provenance.json` as WorkspaceRelativePath,
    approvalGateRefs: cloneJson(candidate.approvalGateRefs),
    editionRules: candidate.works.map((work) => ({
      title: work.title,
      preferredWorkId: work.workId,
      allowedWorkIds: [work.workId],
      reason: '承認済み代表作',
    })),
  });
}

function mapArtifactError(error: unknown): BatchOperationError {
  if (error instanceof BatchOperationError) return error;
  if (error instanceof ArtifactWriteError) {
    const code: BatchWriteCode = error.code === 'ARTIFACT_WORKSPACE_BOUNDARY'
      ? 'BATCH_WORKSPACE_BOUNDARY'
      : error.code === 'ARTIFACT_CONFLICT' ? 'BATCH_WRITE_CONFLICT' : 'BATCH_ATOMIC_RENAME_FAILED';
    return new BatchOperationError(code, error.message);
  }
  return new BatchOperationError('BATCH_ATOMIC_RENAME_FAILED', error instanceof Error ? error.message : 'manifestのatomic renameに失敗しました');
}

async function fileSha(path: string): Promise<Sha256> {
  return sha256(await readFile(path));
}

async function assertManifestBoundary(workspace: string, target: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new BatchOperationError('BATCH_WORKSPACE_BOUNDARY', 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new BatchOperationError('BATCH_WORKSPACE_BOUNDARY', 'workspace実体が不正です');
  }
  const relation = relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new BatchOperationError('BATCH_WORKSPACE_BOUNDARY', 'manifestがworkspace外です');
  }
  let cursor = root;
  for (const component of relation.split(sep)) {
    cursor = join(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new BatchOperationError('BATCH_WORKSPACE_BOUNDARY', 'manifest pathにlink/reparseがあります');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return root;
}

async function syncRegularFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && ['EPERM', 'EINVAL', 'EISDIR', 'EBADF', 'ENOTSUP'].includes(code ?? '')) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeManifestJournal(
  workspace: string,
  journalPath: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  const expectedFingerprint = await fingerprintArtifact(journalPath);
  await writeJsonArtifactAtomic(workspace, journalPath, value, { expectedFingerprint });
  await syncRegularFile(journalPath);
  await syncDirectory(dirname(journalPath));
}

interface BatchManifestJournal {
  readonly schemaVersion: '1.0.0';
  readonly phase: BatchManifestJournalPhase;
  readonly manifestPath: string;
  readonly expectedSha256: Sha256;
  readonly nextSha256: Sha256;
}

async function readManifestJournal(path: string): Promise<BatchManifestJournal | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'manifest journalを読めません');
  }
  if (!isRecord(value) || value.schemaVersion !== '1.0.0' ||
    !['prepared', 'replaced', 'verified'].includes(value.phase as string) || !isSafePath(value.manifestPath) ||
    !isSha(value.expectedSha256) || !isSha(value.nextSha256) || Object.keys(value).length !== 5) {
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'manifest journalの内容が不正です');
  }
  return value as unknown as BatchManifestJournal;
}

async function quarantineThirdPartyManifest(root: string, target: string, batchId: BatchId, digest: Sha256): Promise<string> {
  const quarantineDirectory = join(root, '.cache', 'quarantine', 'batch-manifest');
  await mkdir(quarantineDirectory, { recursive: true });
  const quarantinePath = join(quarantineDirectory, `${batchId}-${digest}.json`);
  try {
    await rename(target, quarantinePath);
  } catch (error) {
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', error instanceof Error ? `第三者manifestを隔離できません: ${error.message}` : '第三者manifestを隔離できません');
  }
  await syncDirectory(quarantineDirectory);
  await syncDirectory(dirname(target));
  return quarantinePath;
}

/** @des DES-F002-002 DES-F002-015 @fun FUN-F002-003 */
export async function writeBatchManifestAtomic(
  workspace: string,
  manifestPath: WorkspaceRelativePath,
  nextValue: BatchManifest,
  expectedSha256: Sha256,
  options: BatchManifestWriteOptions = {},
): Promise<Sha256> {
  const next = requireManifest(nextValue);
  if (!isAbsolute(workspace) || !isSafePath(manifestPath) ||
    manifestPath !== `content/batches/${next.batchId}/batch.json`) {
    throw new BatchOperationError('BATCH_WORKSPACE_BOUNDARY', 'manifest pathはbatchのcanonical workspace相対pathが必要です');
  }
  if (!isSha(expectedSha256)) throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'expected SHA-256が不正です');
  const target = join(workspace, ...manifestPath.split('/'));
  const root = await assertManifestBoundary(workspace, target);
  const targetDirectory = dirname(target);
  const journalPath = join(root, '.cache', 'transactions', 'batch-manifest', `${next.batchId}.json`);
  const nextBytes = canonicalJson(next);
  const nextSha = sha256(nextBytes);
  const existingJournal = await readManifestJournal(journalPath);
  const startsAfterVerified = existingJournal?.phase === 'verified' && existingJournal.nextSha256 === expectedSha256;
  const journal = startsAfterVerified ? null : existingJournal;
  if (journal && (journal.manifestPath !== manifestPath || journal.expectedSha256 !== expectedSha256 || journal.nextSha256 !== nextSha)) {
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', '別transactionのmanifest journalが存在します');
  }
  let initialSha: Sha256;
  try {
    initialSha = await fileSha(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BatchOperationError('BATCH_WRITE_CONFLICT', '更新対象manifestが存在しません');
    throw mapArtifactError(error);
  }
  if (initialSha === nextSha) {
    if (await readFile(target, 'utf8') !== nextBytes) {
      throw new BatchOperationError('BATCH_POSTWRITE_MISMATCH', '同じSHAの保存済みmanifestがcanonical bytesではありません');
    }
    try {
      await syncRegularFile(target);
      await syncDirectory(targetDirectory);
      await writeManifestJournal(root, journalPath, {
        schemaVersion: '1.0.0', phase: 'verified', manifestPath, expectedSha256, nextSha256: nextSha,
      });
    } catch (error) {
      throw new BatchOperationError('BATCH_FILE_SYNC_FAILED', error instanceof Error ? error.message : 'manifest recovery syncに失敗しました');
    }
    return nextSha;
  }
  if (initialSha !== expectedSha256) {
    if (journal) await quarantineThirdPartyManifest(root, target, next.batchId, initialSha);
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', '更新前manifest SHA-256が一致しません');
  }
  await mkdir(targetDirectory, { recursive: true });
  await assertManifestBoundary(root, target);
  const temporary = join(targetDirectory, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const temporaryHandle = await open(temporary, 'wx');
    try {
      await temporaryHandle.writeFile(nextBytes, 'utf8');
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await writeManifestJournal(root, journalPath, {
      schemaVersion: '1.0.0', phase: 'prepared', manifestPath, expectedSha256, nextSha256: nextSha,
    });
    await options.afterPhase?.('prepared');
    if (await fileSha(target) !== expectedSha256) {
      throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'rename直前にmanifestが変更されました');
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      throw new BatchOperationError('BATCH_ATOMIC_RENAME_FAILED', error instanceof Error ? error.message : 'manifest renameに失敗しました');
    }
    await writeManifestJournal(root, journalPath, {
      schemaVersion: '1.0.0', phase: 'replaced', manifestPath, expectedSha256, nextSha256: nextSha,
    });
    await options.afterPhase?.('replaced');
    try {
      await syncRegularFile(target);
      await syncDirectory(targetDirectory);
    } catch (error) {
      throw new BatchOperationError('BATCH_FILE_SYNC_FAILED', error instanceof Error ? error.message : 'manifest durability syncに失敗しました');
    }
    if (await fileSha(target) !== nextSha || await readFile(target, 'utf8') !== nextBytes) {
      throw new BatchOperationError('BATCH_POSTWRITE_MISMATCH', '保存後manifest SHA-256/canonical bytesが一致しません');
    }
    await writeManifestJournal(root, journalPath, {
      schemaVersion: '1.0.0', phase: 'verified', manifestPath, expectedSha256, nextSha256: nextSha,
    });
    await options.afterPhase?.('verified');
  } catch (error) {
    throw mapArtifactError(error);
  } finally {
    await rm(temporary, { force: true });
  }
  return nextSha;
}

const RELEASE_TUPLE_KEYS = [
  'releaseCandidateBatchId',
  'feature',
  'releaseCommit',
  'distSha256',
  'artifactDigest',
] as const;
const PUBLISH_PHASES: readonly PublishBatchJournalPhase[] = [
  'deploy-verified',
  'manifest-prepared',
  'manifest-written',
  'published-verified',
];
const F002_PUBLIC_ROUTES = [
  '#/',
  '#/authors/akutagawa-zunnosuke',
  '#/authors/miyazawa-zunji',
  '#/credits',
] as const;

interface PublishBatchJournal {
  readonly schemaVersion: '1.0.0';
  readonly phase: PublishBatchJournalPhase;
  readonly manifestPath: WorkspaceRelativePath;
  readonly expectedManifestSha: Sha256;
  readonly publishedManifestSha: Sha256;
  readonly releaseSha256: Sha256;
  readonly approvalSha256: Sha256;
  readonly deploymentSha256: Sha256;
  readonly smokeSha256: Sha256;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  return canonicalJson(actual) === canonicalJson(expected);
}

function releaseTuple(value: unknown): value is ReleaseBuildContext {
  return isRecord(value) && exactKeys(value, RELEASE_TUPLE_KEYS) &&
    typeof value.releaseCandidateBatchId === 'string' && BATCH_ID.test(value.releaseCandidateBatchId) &&
    typeof value.feature === 'string' && FEATURE_ID.test(value.feature) &&
    typeof value.releaseCommit === 'string' && /^[0-9a-f]{40}$/u.test(value.releaseCommit) &&
    isSha(value.distSha256) && isSha(value.artifactDigest);
}

function sameReleaseTuple(left: ReleaseBuildContext, right: ReleaseBuildContext): boolean {
  return RELEASE_TUPLE_KEYS.every((key) => left[key] === right[key]);
}

function approvalEvidence(value: unknown, release: ReleaseBuildContext): value is ReleaseApproval {
  if (!isRecord(value) || !exactKeys(value, [
    ...RELEASE_TUPLE_KEYS, 'result', 'approvedAt', 'releaseVersion', 'evidenceRef', 'evidenceSha256',
  ])) return false;
  return sameReleaseTuple(value as unknown as ReleaseBuildContext, release) && value.result === 'approved' &&
    isInstant(value.approvedAt) && typeof value.releaseVersion === 'string' && SEMVER.test(value.releaseVersion) &&
    isSafePath(value.evidenceRef) && isSha(value.evidenceSha256);
}

function deploymentEvidence(value: unknown, release: ReleaseBuildContext): value is DeploymentEvidence {
  if (!isRecord(value) || !exactKeys(value, [
    ...RELEASE_TUPLE_KEYS, 'result', 'deployedAt', 'evidenceRef', 'evidenceSha256', 'deployFlagDisabled',
  ])) return false;
  return sameReleaseTuple(value as unknown as ReleaseBuildContext, release) && value.result === 'success' &&
    isInstant(value.deployedAt) && isSafePath(value.evidenceRef) && isSha(value.evidenceSha256) &&
    typeof value.deployFlagDisabled === 'boolean';
}

function validPublicRoute(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('#/') &&
    [...value].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127);
}

function exactRouteSet(routes: readonly string[], expectedRoutes: readonly string[]): boolean {
  const sortRoutes = (values: readonly string[]) => [...values].sort((left, right) => left.localeCompare(right, 'en'));
  return canonicalJson(sortRoutes(routes)) === canonicalJson(sortRoutes(expectedRoutes));
}

function smokeEvidence(value: unknown, release: ReleaseBuildContext): value is PublicSmokeEvidence {
  if (!isRecord(value) || !exactKeys(value, [
    ...RELEASE_TUPLE_KEYS, 'result', 'checkedAt', 'evidenceRef', 'evidenceSha256',
    'allRoutesCovered', 'expectedRoutes', 'routes',
  ])) return false;
  if (!sameReleaseTuple(value as unknown as ReleaseBuildContext, release) || value.result !== 'pass' ||
    !isInstant(value.checkedAt) || !isSafePath(value.evidenceRef) || !isSha(value.evidenceSha256) ||
    value.allRoutesCovered !== true || !Array.isArray(value.routes) || !Array.isArray(value.expectedRoutes)) return false;
  const routes = value.routes as unknown[];
  const expectedRoutes = value.expectedRoutes as unknown[];
  if (!routes.every(validPublicRoute) || !expectedRoutes.every(validPublicRoute) ||
    new Set(routes).size !== routes.length || new Set(expectedRoutes).size !== expectedRoutes.length) return false;
  const expected = expectedRoutes as string[];
  return exactRouteSet(expected, F002_PUBLIC_ROUTES) &&
    exactRouteSet(routes as string[], F002_PUBLIC_ROUTES);
}

function publishDigest(value: unknown): Sha256 {
  return sha256(canonicalJson(value));
}

type PublishEvidence = ReleaseApproval | DeploymentEvidence | PublicSmokeEvidence;

function publishEvidenceCore(evidence: PublishEvidence): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'evidenceRef' && key !== 'evidenceSha256'),
  );
}

async function verifyPublishEvidenceFile(
  workspace: string,
  evidence: PublishEvidence,
  failureCode: 'PUBLISH_APPROVAL_MISMATCH' | 'PUBLISH_DEPLOYMENT_MISMATCH' | 'PUBLISH_SMOKE_FAILED',
): Promise<void> {
  const fail = (message: string): never => {
    throw new BatchOperationError(failureCode, message);
  };
  if (!isSafePath(evidence.evidenceRef) || !isSha(evidence.evidenceSha256)) fail('証跡pathまたはSHAが不正です');
  const target = join(workspace, ...evidence.evidenceRef.split('/'));
  try {
    const root = await assertManifestBoundary(workspace, target);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target ||
      relative(root, target).startsWith(`..${sep}`)) fail('証跡がworkspace内の通常ファイルではありません');
    const raw = await readFile(target);
    if (sha256(raw) !== evidence.evidenceSha256) fail('証跡SHAが入力と一致しません');
    const text = raw.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      fail('証跡JSONが不正です');
    }
    if (!isRecord(parsed) || text !== canonicalJson(parsed) ||
      text !== canonicalJson(publishEvidenceCore(evidence))) {
      fail('証跡のcandidate tupleまたは結果が入力と一致しません');
    }
  } catch (error) {
    if (error instanceof BatchOperationError && error.code === failureCode) throw error;
    fail(error instanceof Error ? `証跡を検証できません: ${error.message}` : '証跡を検証できません');
  }
}

async function verifyPublishEvidenceFiles(
  workspace: string,
  approval: ReleaseApproval,
  deployment: DeploymentEvidence,
  smoke: PublicSmokeEvidence,
): Promise<void> {
  await verifyPublishEvidenceFile(workspace, approval, 'PUBLISH_APPROVAL_MISMATCH');
  await verifyPublishEvidenceFile(workspace, deployment, 'PUBLISH_DEPLOYMENT_MISMATCH');
  await verifyPublishEvidenceFile(workspace, smoke, 'PUBLISH_SMOKE_FAILED');
}

async function readPublishJournal(path: string): Promise<PublishBatchJournal | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'release journalを読めません');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'release journal JSONが不正です');
  }
  const keys = [
    'schemaVersion', 'phase', 'manifestPath', 'expectedManifestSha', 'publishedManifestSha',
    'releaseSha256', 'approvalSha256', 'deploymentSha256', 'smokeSha256',
  ];
  if (!isRecord(value) || !exactKeys(value, keys) || raw !== canonicalJson(value) ||
    value.schemaVersion !== '1.0.0' || !PUBLISH_PHASES.includes(value.phase as PublishBatchJournalPhase) ||
    !isSafePath(value.manifestPath) || !isSha(value.expectedManifestSha) || !isSha(value.publishedManifestSha) ||
    !isSha(value.releaseSha256) || !isSha(value.approvalSha256) || !isSha(value.deploymentSha256) ||
    !isSha(value.smokeSha256)) {
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'release journalの内容が不正です');
  }
  return value as unknown as PublishBatchJournal;
}

async function writePublishJournal(
  workspace: string,
  path: string,
  journal: PublishBatchJournal,
): Promise<void> {
  try {
    await writeManifestJournal(workspace, path, { ...journal });
  } catch (error) {
    throw mapArtifactError(error);
  }
}

function publishJournalMatches(left: PublishBatchJournal, right: PublishBatchJournal): boolean {
  const leftCore = Object.fromEntries(Object.entries(left).filter(([key]) => key !== 'phase'));
  const rightCore = Object.fromEntries(Object.entries(right).filter(([key]) => key !== 'phase'));
  return canonicalJson(leftCore) === canonicalJson(rightCore);
}

async function verifyPublishedManifest(
  target: string,
  expected: BatchManifest,
  expectedSha: Sha256,
): Promise<BatchManifest> {
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (error) {
    throw new BatchOperationError(
      'BATCH_POSTWRITE_MISMATCH',
      error instanceof Error ? `published manifestを再読込できません: ${error.message}` : 'published manifestを再読込できません',
    );
  }
  if (sha256(raw) !== expectedSha || raw !== canonicalJson(expected)) {
    throw new BatchOperationError('BATCH_POSTWRITE_MISMATCH', 'published manifestのcanonical SHAが一致しません');
  }
  const parsed = validateBatchManifest(JSON.parse(raw) as unknown);
  if (!parsed.ok || parsed.value.status !== 'published') {
    throw new BatchOperationError('BATCH_POSTWRITE_MISMATCH', 'published manifestの再検証に失敗しました');
  }
  return parsed.value;
}

function acceptedManifestForPublish(manifest: BatchManifest): BatchManifest {
  if (manifest.status === 'accepted') return manifest;
  if (manifest.status !== 'published') {
    throw new BatchOperationError('PUBLISH_NOT_ACCEPTED', 'accepted manifestだけをpublishedへ遷移できます');
  }
  const accepted = cloneJson(manifest) as unknown as Record<string, unknown>;
  accepted.status = 'accepted';
  delete accepted.publishedAt;
  delete accepted.releaseVersion;
  delete accepted.deploymentEvidenceRef;
  delete accepted.smokeEvidenceRef;
  return finalizeManifest(accepted as unknown as BatchManifest);
}

/** @des DES-F002-002 DES-F002-015 DES-F002-016 @fun FUN-F002-037 */
export async function recordPublishedBatch(
  workspace: string,
  manifestPath: WorkspaceRelativePath,
  manifestValue: BatchManifest,
  expectedManifestSha: Sha256,
  release: ReleaseBuildContext,
  approval: ReleaseApproval,
  deployment: DeploymentEvidence,
  smoke: PublicSmokeEvidence,
  options: PublishBatchOptions = {},
): Promise<{ readonly manifest: BatchManifest; readonly sha256: Sha256 }> {
  const suppliedManifest = requireManifest(manifestValue);
  const suppliedPublished = suppliedManifest.status === 'published';
  const manifest = acceptedManifestForPublish(suppliedManifest);
  if (!isSha(expectedManifestSha) || expectedManifestSha !== hashBatchManifest(manifest)) {
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'expected manifest SHAがaccepted manifestと一致しません');
  }
  if (!releaseTuple(release) || release.releaseCandidateBatchId !== manifest.batchId ||
    release.feature !== manifest.feature) {
    throw new BatchOperationError('PUBLISH_CANDIDATE_MISMATCH', 'release candidate tupleがmanifestと一致しません');
  }
  if (!approvalEvidence(approval, release)) {
    throw new BatchOperationError('PUBLISH_APPROVAL_MISMATCH', 'release approvalがcandidate tupleと一致しません');
  }
  if (!deploymentEvidence(deployment, release)) {
    throw new BatchOperationError('PUBLISH_DEPLOYMENT_MISMATCH', 'deployment evidenceがcandidate tupleと一致しません');
  }
  if (deployment.deployFlagDisabled !== true) {
    throw new BatchOperationError('PUBLISH_DEPLOY_FLAG_ACTIVE', 'deploy変数の無効化を確認できません');
  }
  if (!smokeEvidence(smoke, release)) {
    throw new BatchOperationError('PUBLISH_SMOKE_FAILED', '公開後の全route smokeがPASSしていません');
  }
  if (Date.parse(approval.approvedAt) > Date.parse(deployment.deployedAt)) {
    throw new BatchOperationError('PUBLISH_DEPLOYMENT_MISMATCH', 'deploymentがrelease approvalより前です');
  }
  if (Date.parse(deployment.deployedAt) > Date.parse(smoke.checkedAt)) {
    throw new BatchOperationError('PUBLISH_SMOKE_FAILED', 'public smokeがdeploymentより前です');
  }
  if (!isAbsolute(workspace) || !isSafePath(manifestPath) ||
    manifestPath !== `content/batches/${manifest.batchId}/batch.json`) {
    throw new BatchOperationError('BATCH_WORKSPACE_BOUNDARY', 'manifest pathはbatchのcanonical workspace相対pathが必要です');
  }
  const target = join(workspace, ...manifestPath.split('/'));
  const root = await assertManifestBoundary(workspace, target);
  const published = finalizeManifest({
    ...manifest,
    status: 'published',
    publishedAt: smoke.checkedAt,
    releaseVersion: approval.releaseVersion,
    deploymentEvidenceRef: deployment.evidenceRef,
    smokeEvidenceRef: smoke.evidenceRef,
  });
  const publishedSha = hashBatchManifest(published);
  if (suppliedPublished && canonicalJson(suppliedManifest) !== canonicalJson(published)) {
    throw new BatchOperationError('PUBLISH_NOT_ACCEPTED', 'published manifestが同一candidate/evidenceの期待値と一致しません');
  }
  const journalPath = join(root, '.cache', 'transactions', 'release-publish', `${manifest.batchId}.json`);
  const journalCore = {
    schemaVersion: '1.0.0',
    manifestPath,
    expectedManifestSha,
    publishedManifestSha: publishedSha,
    releaseSha256: publishDigest(release),
    approvalSha256: publishDigest(approval),
    deploymentSha256: publishDigest(deployment),
    smokeSha256: publishDigest(smoke),
  } as const;
  let journal = await readPublishJournal(journalPath);
  if (suppliedPublished && !journal) {
    throw new BatchOperationError('PUBLISH_NOT_ACCEPTED', '所有するrelease journalがないpublished manifestは再開できません');
  }
  const expectedJournal: PublishBatchJournal = { ...journalCore, phase: journal?.phase ?? 'deploy-verified' };
  if (journal && !publishJournalMatches(journal, expectedJournal)) {
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', '別candidateのrelease journalが存在します');
  }
  await verifyPublishEvidenceFiles(root, approval, deployment, smoke);
  let targetSha: Sha256;
  try {
    targetSha = await fileSha(target);
  } catch (error) {
    throw mapArtifactError(error);
  }
  if ((!journal && targetSha !== expectedManifestSha) ||
    (journal && targetSha !== expectedManifestSha && targetSha !== publishedSha) ||
    (journal && PUBLISH_PHASES.indexOf(journal.phase) >= PUBLISH_PHASES.indexOf('manifest-written') &&
      targetSha !== publishedSha)) {
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'manifestがrelease journalのaccepted/published SHAと一致しません');
  }
  const advance = async (phase: PublishBatchJournalPhase): Promise<void> => {
    if (journal && PUBLISH_PHASES.indexOf(journal.phase) >= PUBLISH_PHASES.indexOf(phase)) return;
    const nextJournal: PublishBatchJournal = { ...journalCore, phase };
    await writePublishJournal(root, journalPath, nextJournal);
    journal = nextJournal;
    await options.afterPhase?.(phase);
  };
  await advance('deploy-verified');
  await advance('manifest-prepared');
  targetSha = await fileSha(target);
  if (journal && PUBLISH_PHASES.indexOf(journal.phase) < PUBLISH_PHASES.indexOf('manifest-written') &&
    (targetSha === expectedManifestSha || targetSha === publishedSha)) {
    await writeBatchManifestAtomic(root, manifestPath, published, expectedManifestSha, options.manifestWriteOptions);
  } else if (targetSha !== publishedSha) {
    throw new BatchOperationError('BATCH_WRITE_CONFLICT', 'manifest書込み前に第三者変更を検出しました');
  }
  await advance('manifest-written');
  const verified = await verifyPublishedManifest(target, published, publishedSha);
  await verifyPublishEvidenceFiles(root, approval, deployment, smoke);
  await advance('published-verified');
  return Object.freeze({ manifest: verified, sha256: publishedSha });
}

function discoveryError(code: BatchDiscoveryCode, message: string): never {
  throw new BatchOperationError(code, message);
}

async function verifyGitCheckout(workspace: string, commit: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit)) discoveryError('BATCH_RELEASE_CANDIDATE_MISMATCH', 'candidate commitが40桁SHAではありません');
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
      execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: workspace, encoding: 'utf8' }),
    ]);
    if (head.trim() !== commit || status.trim() !== '') {
      discoveryError('BATCH_RELEASE_CHECKOUT_DIRTY', 'workspaceがexact clean candidate commitではありません');
    }
  } catch (error) {
    if (error instanceof BatchOperationError) throw error;
    discoveryError('BATCH_RELEASE_CHECKOUT_DIRTY', error instanceof Error ? error.message : 'Git checkoutを検証できません');
  }
}

async function verifyTracked(workspace: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await execFile('git', ['ls-files', '--error-unmatch', '--', path], { cwd: workspace, encoding: 'utf8' });
    } catch {
      discoveryError('BATCH_ARTIFACT_MISSING', `candidate commitに追跡されていないartifactがあります: ${path}`);
    }
  }
}

async function verifyAcceptedSource(workspace: string, source: AcceptedAudioSource): Promise<void> {
  const target = join(workspace, ...source.path.split('/'));
  try {
    await assertManifestBoundary(workspace, target);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== source.bytes) {
      discoveryError('BATCH_ACCEPTED_AUDIO_MISSING', `accepted audio実体がありません: ${source.path}`);
    }
    if (await fileSha(target) !== source.sha256) {
      discoveryError('BATCH_ACCEPTED_AUDIO_HASH_MISMATCH', `accepted audio SHAが一致しません: ${source.path}`);
    }
  } catch (error) {
    if (error instanceof BatchOperationError) throw error;
    discoveryError('BATCH_ACCEPTED_AUDIO_MISSING', `accepted audioを検証できません: ${source.path}`);
  }
}

/** @des DES-F002-001 DES-F002-002 DES-F002-006 DES-F002-014 DES-F002-015 @fun FUN-F002-034 */
export async function loadAcceptedBatches(
  workspace: string,
  options: LoadAcceptedBatchOptions = {},
): Promise<readonly PublishableBatch[]> {
  if (options.preparation && options.release) {
    discoveryError('BATCH_RELEASE_CANDIDATE_MISMATCH', 'preparationとreleaseは同時指定できません');
  }
  const root = resolve(workspace);
  await assertManifestBoundary(root, join(root, 'content'));
  const context = options.preparation ?? options.release;
  const expectedCommit = options.preparation?.sourceCommit ?? options.release?.releaseCommit;
  if (context && expectedCommit) await verifyGitCheckout(root, expectedCommit);
  const batchesRoot = join(root, 'content', 'batches');
  let names: string[];
  try {
    const rootInfo = await lstat(batchesRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) discoveryError('BATCH_DISCOVERY_PATH_UNSAFE', 'content/batches実体が不正です');
    names = await readdir(batchesRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof BatchOperationError) throw error;
    discoveryError('BATCH_DISCOVERY_PATH_UNSAFE', 'content/batchesを列挙できません');
  }
  const discovered: PublishableBatch[] = [];
  const candidateMatches: PublishableBatch[] = [];
  const authorIdentities = new Map<string, string>();
  for (const name of names.sort((left, right) => left.localeCompare(right, 'en'))) {
    if (!BATCH_ID.test(name) || name < 'F002') discoveryError('BATCH_DISCOVERY_PATH_UNSAFE', `未知batch directoryがあります: ${name}`);
    const directory = join(batchesRoot, name);
    const manifestFile = join(directory, 'batch.json');
    const directoryInfo = await lstat(directory);
    const manifestInfo = await lstat(manifestFile);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      discoveryError('BATCH_DISCOVERY_PATH_UNSAFE', `batch path実体が不正です: ${name}`);
    }
    await assertManifestBoundary(root, manifestFile);
    const bytes = await readFile(manifestFile, 'utf8');
    let unknown: unknown;
    try {
      unknown = JSON.parse(bytes) as unknown;
    } catch {
      discoveryError('BATCH_MANIFEST_NONCANONICAL', `${name} manifest JSONが不正です`);
    }
    const validated = validateBatchManifest(unknown);
    if (!validated.ok || validated.value.batchId !== name) {
      discoveryError('BATCH_HASH_CHAIN_INVALID', `${name} manifest schema/hash chainが不正です`);
    }
    const manifest = validated.value;
    if (bytes !== canonicalJson(manifest)) discoveryError('BATCH_MANIFEST_NONCANONICAL', `${name} manifestがcanonical JSONではありません`);
    if (options.excludeActiveBatchId === manifest.batchId) continue;
    const isCandidate = context?.releaseCandidateBatchId === manifest.batchId;
    if (isCandidate && manifest.status !== 'accepted') {
      discoveryError('BATCH_RELEASE_CANDIDATE_MISMATCH', 'release candidateはaccepted未publishedである必要があります');
    }
    const eligible = manifest.status === 'published' || (isCandidate && manifest.status === 'accepted');
    if (!eligible) continue;
    if (isCandidate && context?.feature !== manifest.feature) {
      discoveryError('BATCH_RELEASE_CANDIDATE_MISMATCH', 'candidate batch/feature tupleが一致しません');
    }
    if (manifest.rightsSnapshotIds.length === 0 || manifest.workProgress.some((work) =>
      work.status !== 'accepted' || !work.forecastRef || !work.actualCapacityRef || !work.voiceEvidenceRef)) {
      discoveryError('BATCH_ARTIFACT_MISSING', `${name}の権利・容量・音声証跡が不足しています`);
    }
    const priorIdentity = authorIdentities.get(manifest.author.authorId);
    if (priorIdentity && priorIdentity !== manifest.author.identitySha256) {
      discoveryError('BATCH_AUTHOR_CONFLICT', `author identityがbatch間で競合しています: ${manifest.author.authorId}`);
    }
    authorIdentities.set(manifest.author.authorId, manifest.author.identitySha256);
    const byPath = new Map<string, AcceptedAudioSource>();
    for (const work of manifest.workProgress) {
      for (const source of work.acceptedAudioSources ?? []) {
        const existing = byPath.get(source.path);
        if (existing && canonicalJson(existing) !== canonicalJson(source)) {
          discoveryError('BATCH_ACCEPTED_AUDIO_HASH_MISMATCH', `共有accepted audio定義が競合しています: ${source.path}`);
        }
        byPath.set(source.path, source);
      }
    }
    const sources = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'));
    if (sources.length === 0) discoveryError('BATCH_ACCEPTED_AUDIO_MISSING', `${name} accepted audioが0件です`);
    await Promise.all(sources.map((source) => verifyAcceptedSource(root, source)));
    const item: PublishableBatch = Object.freeze({
      manifest,
      manifestPath: `content/batches/${name}/batch.json` as WorkspaceRelativePath,
      manifestSha256: sha256(bytes),
      acceptedAudioSources: Object.freeze(sources),
      candidate: isCandidate,
    });
    discovered.push(item);
    if (isCandidate) candidateMatches.push(item);
  }
  if (context) {
    if (candidateMatches.length === 0) discoveryError('BATCH_RELEASE_CANDIDATE_MISSING', 'accepted release candidateがありません');
    if (candidateMatches.length !== 1) discoveryError('BATCH_RELEASE_CANDIDATE_DUPLICATE', 'release candidateが複数あります');
    const tracked = discovered.flatMap((item) => [item.manifestPath, ...item.acceptedAudioSources.map((source) => source.path)]);
    await verifyTracked(root, tracked);
  }
  return Object.freeze(discovered.sort((left, right) => left.manifest.batchId.localeCompare(right.manifest.batchId, 'en')));
}
