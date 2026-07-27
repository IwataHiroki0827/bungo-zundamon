import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
  VoiceCompletenessReport,
  VoiceDiffGenerationResult,
} from '../voice/generation.ts';
import { canonicalJson } from './artifacts.ts';
import {
  promoteVerifiedWorkArtifacts,
  type ActualCapacityReport,
  type DistPreview,
  type F001DistInvariantReport,
  type WorkAcceptanceEvidence,
  type WorkPromotionOptions,
} from './batch-acceptance.ts';
import {
  hashBatchManifest,
  validateBatchManifest,
  type BatchManifest,
  type Sha256,
  type WorkId,
} from './batch.ts';
import type { F001ContentInvariantReport, IntegratedBuild } from './batch-public.ts';
import type { PublishedInvariantReport } from './published-baseline.ts';
import { F004_V030_PINS } from './f004-baseline.ts';

const MANIFEST_PATH = 'content/batches/F004/batch.json';
const WORK_ID = /^[0-9]{6}$/u;
const preparedValues = new WeakSet<object>();

function sha(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function verifyPreviewTree(root: string, preview: IntegratedBuild): Promise<void> {
  const stage = resolve(preview.stagingRoot);
  const relation = relative(root, stage);
  if (!isAbsolute(preview.stagingRoot) || !relation || relation === '..' ||
    relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    return fail('F004_ACCEPTANCE_PREVIEW_MISMATCH', 'preview stagingがworkspace外です');
  }
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (current: string, logical: string): Promise<void> => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) return fail('F004_ACCEPTANCE_PREVIEW_MISMATCH', 'preview treeにlinkがあります');
    if (info.isFile()) {
      files.push({ path: logical, bytes: await readFile(current) });
      return;
    }
    if (!info.isDirectory()) return fail('F004_ACCEPTANCE_PREVIEW_MISMATCH', 'preview treeが不正です');
    for (const name of (await readdir(current)).sort((a, b) => a.localeCompare(b, 'en'))) {
      await walk(join(current, name), logical ? `${logical}/${name}` : name);
    }
  };
  await walk(stage, '');
  const digest = createHash('sha256');
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    digest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
  }
  const actual = digest.digest('hex');
  const declared = preview.files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).sort();
  const recomputed = files.map((file) => `${file.path}\0${file.bytes.byteLength}\0${sha(file.bytes)}`).sort();
  if (actual !== preview.buildSha256 || canonicalJson(declared) !== canonicalJson(recomputed)) {
    return fail('F004_ACCEPTANCE_PREVIEW_MISMATCH', 'preview tree/hash/bytesを再計算できません');
  }
}

export class F004AcceptanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'F004AcceptanceError';
  }
}

interface VoiceGenerationRuntimeArtifact {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'voice-generation-runtime';
  readonly batchId: 'F004';
  readonly workId: WorkId;
  readonly preVoiceManifestSha: Sha256;
  readonly voicedManifestSha: Sha256;
  readonly generationSha256: Sha256;
  readonly generation: VoiceDiffGenerationResult;
}

export interface PreparedF004WorkAcceptance {
  readonly __brand: 'PreparedF004WorkAcceptance';
  readonly batchId: 'F004';
  readonly workId: WorkId;
  readonly manifestPath: typeof MANIFEST_PATH;
  readonly expectedManifestSha: Sha256;
  readonly generation: VoiceDiffGenerationResult;
  readonly completeness: VoiceCompletenessReport;
  readonly actual: ActualCapacityReport;
  readonly preview: IntegratedBuild;
  readonly pages: DistPreview;
  readonly contentInvariant: F001ContentInvariantReport;
  readonly publishedInvariant: PublishedInvariantReport;
  readonly distInvariant: F001DistInvariantReport;
}

export interface F004AcceptanceResult {
  readonly manifest: BatchManifest;
  readonly evidence: WorkAcceptanceEvidence;
}

interface F004AcceptanceDependencies {
  readonly promote: typeof promoteVerifiedWorkArtifacts;
}

const productionDependencies: F004AcceptanceDependencies = {
  promote: promoteVerifiedWorkArtifacts,
};

function fail(code: string, message: string): never {
  throw new F004AcceptanceError(code, message);
}

async function workspaceRoot(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) return fail('F004_ACCEPTANCE_PATH', 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    return fail('F004_ACCEPTANCE_PATH', 'workspace実体が不正です');
  }
  return root;
}

async function canonical<T>(root: string, path: string): Promise<T> {
  const text = await readFile(join(root, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) return fail('F004_ACCEPTANCE_ARTIFACT', `${path}がcanonical JSONではありません`);
  return value;
}

async function loadManifest(root: string): Promise<BatchManifest> {
  const value = await canonical<unknown>(root, MANIFEST_PATH);
  const checked = validateBatchManifest(value);
  if (!checked.ok || checked.value.batchId !== 'F004') {
    return fail('F004_ACCEPTANCE_MANIFEST', 'F004 manifestが不正です');
  }
  return checked.value;
}

function assertOrder(manifest: BatchManifest, workId: WorkId): void {
  const index = manifest.workIds.indexOf(workId);
  const work = manifest.workProgress[index];
  if (index < 0 || !work || !['voiced', 'accepted'].includes(work.status) ||
    manifest.workProgress.slice(0, index).some((item) => item.status !== 'accepted') ||
    manifest.workProgress.slice(index + 1).some((item) => item.status === 'accepted')) {
    fail('F004_WORK_ORDER', 'manifest順の先行accepted＋現在work条件を満たしません');
  }
}

/**
 * canonical allowlistから受入tupleを再読込し、偽造不能なprepared値をmintする。
 * @des DES-F004-006 @fun FUN-F004-018 @ut UT-F004-018
 */
export async function prepareF004WorkAcceptance(
  workspace: string,
  manifestPath: string,
  workId: WorkId | string,
): Promise<PreparedF004WorkAcceptance> {
  const root = await workspaceRoot(workspace);
  if (manifestPath !== MANIFEST_PATH || !WORK_ID.test(workId)) {
    return fail('F004_ACCEPTANCE_PATH', 'manifest/work pathがallowlist外です');
  }
  const id = workId as WorkId;
  const manifest = await loadManifest(root);
  assertOrder(manifest, id);
  const cache = `.cache/batch-accept/F004/${id}`;
  const [
    reconciliation,
    speechItems,
    review,
    safety,
    forecast,
    voiceEvidence,
    voiceConfig,
    baselineDescriptor,
    baselineCatalog,
    generationArtifact,
    completeness,
    actual,
    preview,
    pages,
    contentInvariant,
    publishedInvariant,
    distInvariant,
  ] =
    await Promise.all([
      canonical<Record<string, unknown>>(root, `content/batches/F004/work-artifacts/${id}/review-reconciliation.json`),
      canonical<unknown[]>(root, `content/batches/F004/work-artifacts/${id}/speech-items.json`),
      canonical<Record<string, unknown>>(root, `.cache/batch-review/F004/${id}/review-result.json`),
      canonical<Record<string, unknown>>(root, `content/batches/F004/candidate-safety/${id}.json`),
      canonical<Record<string, unknown>>(root, `content/batches/F004/capacity-forecast/${id}.json`),
      canonical<Record<string, unknown>>(root, `content/batches/F004/voice-evidence/${id}.json`),
      canonical<Record<string, unknown>>(root, 'content/batches/F004/voice-config.json'),
      canonical<Record<string, unknown>>(root, 'content/baselines/F004-v0.3.0.json'),
      canonical<Record<string, unknown>>(root, 'public/content/catalog.json'),
      canonical<VoiceGenerationRuntimeArtifact>(root, `${cache}/voice-generation.json`),
      canonical<VoiceCompletenessReport>(root, `${cache}/voice-completeness.json`),
      canonical<ActualCapacityReport>(root, `content/batches/F004/capacity-actual/${id}.json`),
      canonical<IntegratedBuild>(root, `${cache}/content-preview.json`),
      canonical<DistPreview>(root, `${cache}/dist-preview.json`),
      canonical<F001ContentInvariantReport>(root, `${cache}/f001-content-invariant.json`),
      canonical<PublishedInvariantReport>(root, `${cache}/published-content-invariant.json`),
      canonical<F001DistInvariantReport>(root, `${cache}/f001-dist-invariant.json`),
    ]);
  const generation = generationArtifact.generation;
  const approved = Array.isArray(review.approved) ? review.approved : [];
  const pending = Array.isArray(review.pending) ? review.pending : [];
  const resolutions = Array.isArray(reconciliation.resolutions) ? reconciliation.resolutions : [];
  const reports = Array.isArray(safety.reports) ? safety.reports : [];
  const approvedIds = approved.map((item) =>
    record(item) && record(item.candidate) ? item.candidate.candidateId : null);
  const speechIds = speechItems.map((item) => record(item) ? item.candidateId : null);
  const resolutionApprovedIds = resolutions
    .filter((item) => record(item) && item.finalDecision === 'approved')
    .map((item) => (item as Record<string, unknown>).candidateId);
  const reportIds = reports.map((item) => record(item) ? item.candidateId : null);
  const speechById = new Map(speechItems.filter(record).map((item) => [item.candidateId, item]));
  const forecastPlan = record(forecast.plan) ? forecast.plan : {};
  const forecastAuthorization = record(forecast.authorization) ? forecast.authorization : {};
  const configHash = sha(canonicalJson(voiceConfig));
  const reviewedEvidence = manifest.workProgress[manifest.workIds.indexOf(id)]?.stageRecords
    .findLast((item) => item.stage === 'reviewed');
  const budgetEvidence = manifest.workProgress[manifest.workIds.indexOf(id)]?.stageRecords
    .findLast((item) => item.stage === 'budget-approved');
  const voicedEvidence = manifest.workProgress[manifest.workIds.indexOf(id)]?.stageRecords
    .findLast((item) => item.stage === 'voiced');
  const actualEvidence = manifest.workProgress[manifest.workIds.indexOf(id)]?.stageRecords
    .findLast((item) => item.stage === 'capacity-actual');
  if (generationArtifact.batchId !== 'F004' || generationArtifact.workId !== id ||
    generation.batchId !== 'F004' || generation.workId !== id ||
    completeness.batchId !== 'F004' || completeness.workId !== id || completeness.result !== 'pass' ||
    actual.batchId !== 'F004' || actual.workId !== id || !['pass', 'pass_with_warning'].includes(actual.result) ||
    preview.mode !== 'work-preview' || preview.activeBatchId !== 'F004' || preview.activeWorkId !== id ||
    pages.batchId !== 'F004' || pages.workId !== id ||
    actual.contentBuildSha256 !== preview.buildSha256 || pages.contentBuildSha256 !== preview.buildSha256 ||
    actual.distSha256 !== pages.distSha256 ||
    contentInvariant.result !== 'pass' || contentInvariant.buildSha256 !== preview.buildSha256 ||
    contentInvariant.stagingSha256 !== preview.buildSha256 ||
    publishedInvariant.result !== 'pass' || publishedInvariant.target !== 'work-preview' ||
    publishedInvariant.inputTreeSha256 !== preview.buildSha256 ||
    publishedInvariant.actualTreeSha256 !== preview.buildSha256 ||
    distInvariant.result !== 'pass' || distInvariant.contentBuildSha256 !== preview.buildSha256 ||
    distInvariant.distSha256 !== pages.distSha256 ||
    actual.generationDigest !== generation.generationDigest ||
    actual.completenessDigest !== completeness.completenessDigest ||
    actual.planDigest !== generation.planDigest ||
    actual.authorizationDigest !== generation.authorizationDigest ||
    reconciliation.schemaVersion !== '1.0.0' || !Array.isArray(reconciliation.pendingIds) ||
    reconciliation.pendingIds.length !== 0 || pending.length !== 0 ||
    canonicalJson(approvedIds) !== canonicalJson(speechIds) ||
    canonicalJson(approvedIds) !== canonicalJson(resolutionApprovedIds) ||
    canonicalJson(approvedIds) !== canonicalJson(reportIds) ||
    reports.some((item) => {
      if (!record(item) || item.result !== 'pass' || item.workId !== id) return true;
      const speech = speechById.get(item.candidateId);
      return !speech || speech.workId !== id || item.speechText !== speech.speechText ||
        item.speechSha256 !== speech.speechSha256 ||
        item.speechSha256 !== sha(String(speech.speechText));
    }) ||
    safety.workId !== id || safety.batchId !== 'F004' ||
    safety.reconciliationDigest !== reconciliation.reconciliationDigest ||
    forecast.workId !== id || forecast.batchId !== 'F004' ||
    forecast.configSha256 !== configHash ||
    forecastPlan.planDigest !== forecastAuthorization.planDigest ||
    forecastPlan.planDigest !== generation.planDigest ||
    forecastPlan.configHash !== generation.configHash ||
    voiceEvidence.workId !== id || voiceEvidence.batchId !== 'F004' ||
    voiceEvidence.planDigest !== generation.planDigest ||
    voiceEvidence.authorizationDigest !== generation.authorizationDigest ||
    voiceEvidence.generationDigest !== generation.generationDigest ||
    voiceEvidence.completenessDigest !== completeness.completenessDigest ||
    baselineDescriptor.releaseCommit !== F004_V030_PINS.releaseCommit ||
    baselineDescriptor.catalogSha256 !== F004_V030_PINS.catalogSha256 ||
    sha(canonicalJson(baselineCatalog)) !== F004_V030_PINS.catalogSha256 ||
    !reviewedEvidence?.outputHashes.includes(sha(canonicalJson(review))) ||
    !budgetEvidence?.outputHashes.includes(sha(canonicalJson(forecast))) ||
    !voicedEvidence?.outputHashes.includes(generation.generationDigest as Sha256) ||
    !voicedEvidence.outputHashes.includes(completeness.completenessDigest as Sha256) ||
    !actualEvidence?.outputHashes.includes(sha(canonicalJson(actual))) ||
    !actualEvidence.outputHashes.includes(preview.buildSha256) &&
      !actualEvidence.inputHashes.includes(preview.buildSha256)) {
    return fail('F004_ACCEPTANCE_PREVIEW_MISMATCH', 'canonical voice/capacity/preview tupleが一致しません');
  }
  await verifyPreviewTree(root, preview);
  const prepared = Object.freeze({
    __brand: 'PreparedF004WorkAcceptance' as const,
    batchId: 'F004' as const,
    workId: id,
    manifestPath: MANIFEST_PATH,
    expectedManifestSha: hashBatchManifest(manifest),
    generation,
    completeness,
    actual,
    preview,
    pages,
    contentInvariant,
    publishedInvariant,
    distInvariant,
  });
  preparedValues.add(prepared);
  return prepared;
}

function assertPrepared(prepared: PreparedF004WorkAcceptance, expectedManifestSha: Sha256 | string): void {
  if (!preparedValues.has(prepared) || prepared.__brand !== 'PreparedF004WorkAcceptance') {
    fail('F004_ACCEPTANCE_PREPARED_UNTRUSTED', 'production prepareがmintした値ではありません');
  }
  if (prepared.expectedManifestSha !== expectedManifestSha) {
    fail('F004_ACCEPTANCE_MANIFEST_STALE', 'expected manifest SHAがprepare時点と一致しません');
  }
}

async function promote(
  workspace: string,
  prepared: PreparedF004WorkAcceptance,
  expectedManifestSha: Sha256 | string,
  options: WorkPromotionOptions,
  dependencies: F004AcceptanceDependencies,
): Promise<F004AcceptanceResult> {
  assertPrepared(prepared, expectedManifestSha);
  const evidence = await dependencies.promote(
    workspace,
    prepared.batchId as BatchManifest['batchId'],
    prepared.workId,
    prepared.generation,
    prepared.completeness,
    prepared.actual,
    prepared.preview,
    prepared.pages,
    prepared.contentInvariant,
    prepared.distInvariant,
    options,
  );
  return { manifest: await loadManifest(await workspaceRoot(workspace)), evidence };
}

/**
 * generic accepted-audio transactionをF004 prepared brandに限定して呼ぶ。
 * @des DES-F004-006 @fun FUN-F004-019 @ut UT-F004-019
 */
export async function acceptF004Work(
  workspace: string,
  prepared: PreparedF004WorkAcceptance,
  expectedManifestSha: Sha256 | string,
  options: WorkPromotionOptions = {},
  dependencies: F004AcceptanceDependencies = productionDependencies,
): Promise<F004AcceptanceResult> {
  return promote(workspace, prepared, expectedManifestSha, options, dependencies);
}

/**
 * 同じjournal owner/tupleでgeneric transactionを再開し、verifiedへ収束させる。
 * @des DES-F004-006 @fun FUN-F004-020 @ut UT-F004-020
 */
export async function recoverF004WorkAcceptance(
  workspace: string,
  prepared: PreparedF004WorkAcceptance,
  expectedManifestSha: Sha256 | string,
  options: WorkPromotionOptions = {},
  dependencies: F004AcceptanceDependencies = productionDependencies,
): Promise<F004AcceptanceResult> {
  return promote(workspace, prepared, expectedManifestSha, options, dependencies);
}
