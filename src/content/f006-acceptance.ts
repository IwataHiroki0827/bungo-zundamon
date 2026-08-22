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
import { resolveVoiceGenerationPaths } from './f003-artifact-paths.ts';

/**
 * F006（中島敦3作品追加）work単位atomic受入の薄い橋渡しラッパー。
 *
 * DD-F006.md FUN-F006-010の方式訂正どおり、F006のvoiced段階は間接ハッシュ規約
 * （voiceEvidenceRef・capacity-actual evidenceファイルのSHA-256だけをstage record
 * outputHashesへ格納する方式、scripts/f006-prepare-voice.ts / scripts/
 * f006-capacity-actual.ts参照）を採用している。汎用src/content/batch-acceptance.ts
 * のpromoteVerifiedWorkArtifactsが要求する直接evidence値（generationDigest・
 * completenessDigest等）は、scripts/f006-capacity-actual.tsが同じmanifest work上へ
 * 追加のvoiced/capacity-actual stage recordとして再導出・追記済みである前提とし、
 * ここではcanonical allowlist pathから実体を再読込・再検証したうえでbrandedな
 * prepared値を組み立て、promoteVerifiedWorkArtifacts（変更しない）をそのまま呼ぶ。
 * F003のsrc/content/f003-review-acceptance.tsと同じ理由・同じパターン。
 * @des DES-F006-009 @fun FUN-F006-010
 */

const MANIFEST_PATH = 'content/batches/F006/batch.json';
const WORK_ID = /^[0-9]{6}$/u;
const preparedValues = new WeakSet<object>();

function sha(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function verifyPreviewTree(root: string, preview: IntegratedBuild): Promise<void> {
  const stage = resolve(preview.stagingRoot);
  const relation = relative(root, stage);
  if (!isAbsolute(preview.stagingRoot) || !relation || relation === '..' ||
    relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    return fail('F006_ACCEPTANCE_PREVIEW_MISMATCH', 'preview stagingがworkspace外です');
  }
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const walk = async (current: string, logical: string): Promise<void> => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) return fail('F006_ACCEPTANCE_PREVIEW_MISMATCH', 'preview treeにlinkがあります');
    if (info.isFile()) {
      files.push({ path: logical, bytes: await readFile(current) });
      return;
    }
    if (!info.isDirectory()) return fail('F006_ACCEPTANCE_PREVIEW_MISMATCH', 'preview treeが不正です');
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
    return fail('F006_ACCEPTANCE_PREVIEW_MISMATCH', 'preview tree/hash/bytesを再計算できません');
  }
}

export class F006AcceptanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'F006AcceptanceError';
  }
}

export interface PreparedF006WorkAcceptance {
  readonly __brand: 'PreparedF006WorkAcceptance';
  readonly batchId: 'F006';
  readonly workId: WorkId;
  readonly manifestPath: typeof MANIFEST_PATH;
  readonly expectedManifestSha: Sha256;
  readonly generation: VoiceDiffGenerationResult;
  readonly completeness: VoiceCompletenessReport;
  readonly actual: ActualCapacityReport;
  readonly preview: IntegratedBuild;
  readonly pages: DistPreview;
  readonly contentInvariant: F001ContentInvariantReport;
  readonly distInvariant: F001DistInvariantReport;
}

export interface F006AcceptanceResult {
  readonly manifest: BatchManifest;
  readonly evidence: WorkAcceptanceEvidence;
}

interface F006AcceptanceDependencies {
  readonly promote: typeof promoteVerifiedWorkArtifacts;
}

const productionDependencies: F006AcceptanceDependencies = {
  promote: promoteVerifiedWorkArtifacts,
};

function fail(code: string, message: string): never {
  throw new F006AcceptanceError(code, message);
}

async function workspaceRoot(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) return fail('F006_ACCEPTANCE_PATH', 'workspaceは絶対pathが必要です');
  const root = resolve(workspace);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    return fail('F006_ACCEPTANCE_PATH', 'workspace実体が不正です');
  }
  return root;
}

async function canonical<T>(root: string, path: string): Promise<T> {
  const text = await readFile(join(root, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) return fail('F006_ACCEPTANCE_ARTIFACT', `${path}がcanonical JSONではありません`);
  return value;
}

async function loadManifest(root: string): Promise<BatchManifest> {
  const value = await canonical<unknown>(root, MANIFEST_PATH);
  const checked = validateBatchManifest(value);
  if (!checked.ok || checked.value.batchId !== 'F006') {
    return fail('F006_ACCEPTANCE_MANIFEST', 'F006 manifestが不正です');
  }
  return checked.value;
}

function assertOrder(manifest: BatchManifest, workId: WorkId): void {
  const index = manifest.workIds.indexOf(workId);
  const work = manifest.workProgress[index];
  if (index < 0 || !work || !['voiced', 'accepted'].includes(work.status) ||
    manifest.workProgress.slice(0, index).some((item) => item.status !== 'accepted') ||
    manifest.workProgress.slice(index + 1).some((item) => item.status === 'accepted')) {
    fail('F006_WORK_ORDER', 'manifest順の先行accepted＋現在work条件を満たしません');
  }
}

/**
 * F006間接ハッシュ規約下のcanonical allowlistから、promoteVerifiedWorkArtifactsが
 * 要求する直接evidenceを再読込・再検証し、偽造不能なprepared値をmintする。
 * @des DES-F006-009 @fun FUN-F006-010
 */
export async function prepareF006WorkAcceptance(
  workspace: string,
  manifestPath: string,
  workId: WorkId | string,
): Promise<PreparedF006WorkAcceptance> {
  const root = await workspaceRoot(workspace);
  if (manifestPath !== MANIFEST_PATH || !WORK_ID.test(workId)) {
    return fail('F006_ACCEPTANCE_PATH', 'manifest/work pathがallowlist外です');
  }
  const id = workId as WorkId;
  const manifest = await loadManifest(root);
  assertOrder(manifest, id);
  const cache = `.cache/batch-accept/F006/${id}`;
  const [
    voiceEvidence,
    generationCanonical,
    completeness,
    actual,
    preview,
    pages,
    contentInvariant,
    distInvariant,
  ] = await Promise.all([
    canonical<Record<string, unknown>>(root, `content/batches/F006/voice-evidence/${id}.json`),
    canonical<VoiceDiffGenerationResult>(root, `content/batches/F006/work-artifacts/${id}/voice-generation.json`),
    canonical<VoiceCompletenessReport>(root, `content/batches/F006/work-artifacts/${id}/voice-completeness.json`),
    canonical<ActualCapacityReport>(root, `content/batches/F006/capacity-actual/${id}.json`),
    canonical<IntegratedBuild>(root, `${cache}/content-preview.json`),
    canonical<DistPreview>(root, `${cache}/dist-preview.json`),
    canonical<F001ContentInvariantReport>(root, `${cache}/f001-content-invariant.json`),
    canonical<F001DistInvariantReport>(root, `${cache}/f001-dist-invariant.json`),
  ]);
  const generation = resolveVoiceGenerationPaths(root, generationCanonical);

  const work = manifest.workProgress[manifest.workIds.indexOf(id)];
  const voicedEvidence = work?.stageRecords.findLast((item) => item.stage === 'voiced');
  const capacityEvidence = work?.stageRecords.at(-1);
  const directVoicedRecords = work?.stageRecords.filter((item) => item.stage === 'voiced') ?? [];

  if (
    voiceEvidence.batchId !== 'F006' || voiceEvidence.workId !== id ||
    voiceEvidence.generationDigest !== generation.generationDigest ||
    voiceEvidence.completenessDigest !== completeness.completenessDigest ||
    generation.batchId !== 'F006' || generation.workId !== id ||
    completeness.batchId !== 'F006' || completeness.workId !== id || completeness.result !== 'pass' ||
    actual.batchId !== 'F006' || actual.workId !== id || !['pass', 'pass_with_warning'].includes(actual.result) ||
    preview.mode !== 'work-preview' || preview.activeBatchId !== 'F006' || preview.activeWorkId !== id ||
    pages.batchId !== 'F006' || pages.workId !== id ||
    actual.contentBuildSha256 !== preview.buildSha256 || pages.contentBuildSha256 !== preview.buildSha256 ||
    actual.distSha256 !== pages.distSha256 ||
    contentInvariant.result !== 'pass' || contentInvariant.buildSha256 !== preview.buildSha256 ||
    contentInvariant.stagingSha256 !== preview.buildSha256 ||
    distInvariant.result !== 'pass' || distInvariant.contentBuildSha256 !== preview.buildSha256 ||
    distInvariant.distSha256 !== pages.distSha256 ||
    actual.generationDigest !== generation.generationDigest ||
    actual.completenessDigest !== completeness.completenessDigest ||
    actual.planDigest !== generation.planDigest ||
    actual.authorizationDigest !== generation.authorizationDigest ||
    directVoicedRecords.length < 2 ||
    !voicedEvidence || voicedEvidence.stage !== 'voiced' ||
    !voicedEvidence.outputHashes.includes(generation.generationDigest as Sha256) ||
    !voicedEvidence.outputHashes.includes(completeness.completenessDigest as Sha256) ||
    !capacityEvidence || capacityEvidence.stage !== 'capacity-actual' ||
    !capacityEvidence.inputHashes.includes(generation.generationDigest as Sha256) ||
    !capacityEvidence.inputHashes.includes(completeness.completenessDigest as Sha256) ||
    !capacityEvidence.inputHashes.includes(preview.buildSha256) ||
    work?.actualCapacityRef !== `content/batches/F006/capacity-actual/${id}.json`
  ) {
    return fail('F006_ACCEPTANCE_PREVIEW_MISMATCH', 'canonical voice/capacity/preview tupleが一致しません');
  }
  await verifyPreviewTree(root, preview);
  const prepared = Object.freeze({
    __brand: 'PreparedF006WorkAcceptance' as const,
    batchId: 'F006' as const,
    workId: id,
    manifestPath: MANIFEST_PATH,
    expectedManifestSha: hashBatchManifest(manifest),
    generation,
    completeness,
    actual,
    preview,
    pages,
    contentInvariant,
    distInvariant,
  });
  preparedValues.add(prepared);
  return prepared;
}

function assertPrepared(prepared: PreparedF006WorkAcceptance, expectedManifestSha: Sha256 | string): void {
  if (!preparedValues.has(prepared) || prepared.__brand !== 'PreparedF006WorkAcceptance') {
    fail('F006_ACCEPTANCE_PREPARED_UNTRUSTED', 'production prepareがmintした値ではありません');
  }
  if (prepared.expectedManifestSha !== expectedManifestSha) {
    fail('F006_ACCEPTANCE_MANIFEST_STALE', 'expected manifest SHAがprepare時点と一致しません');
  }
}

async function promote(
  workspace: string,
  prepared: PreparedF006WorkAcceptance,
  expectedManifestSha: Sha256 | string,
  options: WorkPromotionOptions,
  dependencies: F006AcceptanceDependencies,
): Promise<F006AcceptanceResult> {
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
 * generic accepted-audio transactionをF006 prepared brandに限定して呼ぶ。
 * @des DES-F006-009 @fun FUN-F006-010
 */
export async function acceptF006Work(
  workspace: string,
  prepared: PreparedF006WorkAcceptance,
  expectedManifestSha: Sha256 | string,
  options: WorkPromotionOptions = {},
  dependencies: F006AcceptanceDependencies = productionDependencies,
): Promise<F006AcceptanceResult> {
  return promote(workspace, prepared, expectedManifestSha, options, dependencies);
}

/**
 * 同じjournal owner/tupleでgeneric transactionを再開し、verifiedへ収束させる。
 * @des DES-F006-009 @fun FUN-F006-010
 */
export async function recoverF006WorkAcceptance(
  workspace: string,
  prepared: PreparedF006WorkAcceptance,
  expectedManifestSha: Sha256 | string,
  options: WorkPromotionOptions = {},
  dependencies: F006AcceptanceDependencies = productionDependencies,
): Promise<F006AcceptanceResult> {
  return promote(workspace, prepared, expectedManifestSha, options, dependencies);
}
