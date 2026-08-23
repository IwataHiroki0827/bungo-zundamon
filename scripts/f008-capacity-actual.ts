import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { loadAndVerifyF001Baseline, verifyF001Invariant, verifyF001DistInvariant, type F001Baseline } from '../src/content/baseline.ts';
import { buildPagesPreview } from '../src/content/pages-preview.ts';
import { measureGitRepository, verifyActualCapacity, type CapacityForecast, type GitObjectMeasurement } from '../src/voice/budget.ts';
import { resolveVoiceGenerationPaths } from '../src/content/f003-artifact-paths.ts';
import type { VoiceCompletenessReport, VoiceDiffGenerationResult } from '../src/voice/generation.ts';
import {
  hashBatchManifest,
  validateBatchManifest,
  writeBatchManifestAtomic,
  type BatchManifest,
  type Sha256,
  type StageRecord,
  type WorkId,
  type WorkProgress,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import type { CatalogV2 } from '../src/content/processing.ts';
import type { IntegratedBuild } from '../src/content/batch-public.ts';
import { validateCatalogV2 } from '../src/ui/catalog-loader.ts';

const execFileAsync = promisify(execFile);

/**
 * F008（江戸川乱歩3作品追加）work単位の容量actual測定＋atomic受入前橋渡しscript。
 * scripts/f007-capacity-actual.tsのF008向けパラメータ化複製。F007と同じ理由で、
 * F008のvoiced stage記録も間接ハッシュ規約（voiceEvidenceRefファイルのSHA-256だけを
 * 保持、scripts/f008-prepare-voice.ts）を採用しており、汎用promoteVerifiedWorkArtifacts
 * のassertInputsと直接には噛み合わないため、manifestを直接操作して直接ハッシュ値を持つ
 * voiced stage recordとcapacity-actual stage recordを追記する。
 * @des DES-F008-008 DES-F008-009 @fun FUN-F008-009 FUN-F008-010
 */

const BATCH_ID = 'F008';
const workIdArgument = process.argv[2];
if (!workIdArgument || !/^[0-9]{6}$/u.test(workIdArgument)) {
  throw new Error('6桁のwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f008-capacity-actual.ts 056648）');
}
const WORK_ID = workIdArgument as WorkId;
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json`;
const VOICE_EVIDENCE_PATH = `content/batches/${BATCH_ID}/voice-evidence/${WORK_ID}.json`;
const GENERATION_PATH = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/voice-generation.json`;
const COMPLETENESS_PATH = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/voice-completeness.json`;
const FORECAST_PATH = `content/batches/${BATCH_ID}/capacity-forecast/${WORK_ID}.json`;
const ACTUAL_PATH = `content/batches/${BATCH_ID}/capacity-actual/${WORK_ID}.json`;
const CACHE_ROOT = `.cache/batch-accept/${BATCH_ID}/${WORK_ID}`;
const VOICED2_TOOL_VERSION = 'f008-capacity-actual-voiced-direct-v1';
const ACTUAL_TOOL_VERSION = 'f008-capacity-actual-v1';
const STOP_FREE_BYTES = 5 * 1024 * 1024 * 1024;

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

function digestArtifact(value: unknown): Sha256 {
  return sha256(canonicalJson(value));
}

async function canonicalArtifact<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

async function assertDiskGuard(workspace: string, label: string): Promise<number> {
  const disk = await statfs(workspace);
  const free = disk.bavail * disk.bsize;
  if (free < STOP_FREE_BYTES) throw new Error(`5GiB disk guardにより${label}を停止しました (free=${free})`);
  return free;
}

interface TreeMeasurement {
  readonly bytes: number;
  readonly files: readonly string[];
  readonly digest: string;
}

async function measureTree(root: string, allowMissing = false, excluded?: string): Promise<TreeMeasurement> {
  const resolvedRoot = resolve(root);
  try {
    const info = await lstat(resolvedRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolvedRoot) !== resolvedRoot) throw new Error('unsafe root');
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, files: [], digest: sha256('') };
    throw error;
  }
  const excludedRoot = excluded === undefined ? undefined : resolve(excluded);
  const measured: Array<{ path: string; target: string; bytes: number; sha256: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (excludedRoot && (target === excludedRoot || target.startsWith(`${excludedRoot}${sep}`))) continue;
      if (entry.isSymbolicLink()) throw new Error(`treeにreparseがあります: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(target));
        measured.push({ path: relative(resolvedRoot, target).split(sep).join('/'), target, bytes: bytes.byteLength, sha256: sha256(bytes) });
      }
    }
  };
  await walk(resolvedRoot);
  measured.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const digest = createHash('sha256');
  for (const file of measured) digest.update(file.path).update('\0').update(String(file.bytes)).update('\0').update(file.sha256);
  return { bytes: measured.reduce((sum, file) => sum + file.bytes, 0), files: measured.map((file) => file.target), digest: digest.digest('hex') };
}

async function changedRepositoryCandidates(workspace: string): Promise<string[]> {
  const outputs = await Promise.all([
    execFileAsync('git', ['diff', '--name-only', '-z'], { cwd: workspace, encoding: 'utf8' }),
    execFileAsync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: workspace, encoding: 'utf8' }),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: workspace, encoding: 'utf8' }),
  ]);
  return [...new Set(outputs.flatMap(({ stdout }) => stdout.split('\0').filter(Boolean)))]
    .map((path) => join(workspace, ...path.split('/')));
}

/** manifest再読込のstatus確認・stageRecords末尾検証だけを行う軽量再読込。 */
async function loadManifest(workspace: string): Promise<BatchManifest> {
  const text = await readFile(join(workspace, ...MANIFEST_PATH.split('/')), 'utf8');
  const checked = validateBatchManifest(JSON.parse(text) as unknown);
  if (!checked.ok || canonicalJson(checked.value) !== text || checked.value.batchId !== BATCH_ID) {
    throw new Error(`F008 manifestが不正です: ${checked.ok ? 'not canonical' : checked.error.code}`);
  }
  return checked.value;
}

function replaceWork(manifest: BatchManifest, workId: WorkId, next: WorkProgress): BatchManifest {
  const index = manifest.workIds.indexOf(workId);
  const works = manifest.workProgress.map((work, workIndex) => workIndex === index ? next : work) as unknown as
    readonly [WorkProgress, WorkProgress, WorkProgress];
  return { ...manifest, workProgress: works };
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  await assertDiskGuard(workspace, '開始前チェック');

  let manifest = await loadManifest(workspace);
  const workIndex = manifest.workIds.indexOf(WORK_ID);
  let progress = manifest.workProgress[workIndex];
  if (!progress || (progress.status !== 'voiced' && progress.status !== 'accepted')) {
    throw new Error(`容量actualにはvoiced以降が必要です: ${String(progress?.status)}`);
  }

  const [voiceEvidence, generationCanonical, completeness, forecastArtifact] = await Promise.all([
    canonicalArtifact<{
      readonly schemaVersion: '1.0.0';
      readonly kind: 'f008-voice-evidence';
      readonly batchId: string;
      readonly workId: string;
      readonly preVoiceManifestSha: string;
      readonly planDigest: string;
      readonly authorizationDigest: string;
      readonly generationDigest: string;
      readonly completenessDigest: string;
      readonly stagingRoot: string;
    }>(workspace, VOICE_EVIDENCE_PATH),
    canonicalArtifact<VoiceDiffGenerationResult>(workspace, GENERATION_PATH),
    canonicalArtifact<VoiceCompletenessReport>(workspace, COMPLETENESS_PATH),
    canonicalArtifact<{ readonly forecast: CapacityForecast; readonly measurements: { readonly liveWriteUpperBounds: number; readonly rollbackBackupBytes: number } }>(
      workspace, FORECAST_PATH,
    ),
  ]);
  const generation = resolveVoiceGenerationPaths(workspace, generationCanonical.value);
  if (
    voiceEvidence.value.batchId !== BATCH_ID || voiceEvidence.value.workId !== WORK_ID ||
    voiceEvidence.value.generationDigest !== generation.generationDigest ||
    voiceEvidence.value.completenessDigest !== completeness.value.completenessDigest ||
    voiceEvidence.value.planDigest !== generation.planDigest ||
    voiceEvidence.value.authorizationDigest !== generation.authorizationDigest ||
    generation.batchId !== BATCH_ID || generation.workId !== WORK_ID ||
    completeness.value.batchId !== BATCH_ID || completeness.value.workId !== WORK_ID ||
    completeness.value.result !== 'pass' || generation.failed !== 0
  ) {
    throw new Error('voice-evidence/generation/completeness tupleが一致しません');
  }

  // 1) 間接ハッシュ規約から直接evidence値を再導出したvoiced stage recordを追記する（冪等）。
  const voicedRecords = progress.stageRecords.filter((record) => record.stage === 'voiced');
  const originalVoiced = voicedRecords[0];
  if (!originalVoiced) throw new Error('voiced stage recordがありません');
  const directOutputs: readonly Sha256[] = [generation.generationDigest as Sha256, completeness.value.completenessDigest as Sha256];
  const alreadyDirect = voicedRecords.length >= 2 &&
    directOutputs.every((hash) => voicedRecords[1]!.outputHashes.includes(hash));
  if (!alreadyDirect) {
    if (progress.status === 'accepted') throw new Error('accepted work再導出は対象外です');
    const voiced2: StageRecord = {
      stage: 'voiced',
      inputHashes: [
        ...new Set([digestArtifact(voiceEvidence.value), generation.expectedManifestSha as Sha256]),
      ],
      toolVersion: VOICED2_TOOL_VERSION,
      outputHashes: directOutputs,
      count: generation.assets.length,
      completedAt: new Date().toISOString(),
    };
    const withVoiced2 = replaceWork(manifest, WORK_ID, {
      ...progress,
      stageRecords: [...progress.stageRecords, voiced2],
    });
    const checked = validateBatchManifest(withVoiced2);
    if (!checked.ok) throw new Error(`直接ハッシュvoiced record追記後manifestが不正です: ${checked.error.code}`);
    await writeBatchManifestAtomic(workspace, MANIFEST_PATH as WorkspaceRelativePath, checked.value, hashBatchManifest(manifest));
    manifest = await loadManifest(workspace);
    progress = manifest.workProgress[workIndex]!;
  } else {
    manifest = await loadManifest(workspace);
    progress = manifest.workProgress[workIndex]!;
  }

  // 既にcapacity-actual stageまで到達済みなら（同一hash chain）何もしない。
  const existingActual = progress.stageRecords.at(-1);
  if (existingActual?.stage === 'capacity-actual') {
    const existingReport = await canonicalArtifact<{ generationDigest: string; completenessDigest: string }>(workspace, ACTUAL_PATH).catch(() => undefined);
    if (existingReport?.value.generationDigest === generation.generationDigest &&
      existingReport.value.completenessDigest === completeness.value.completenessDigest) {
      process.stdout.write(canonicalJson({ ok: true, workId: WORK_ID, status: progress.status, note: 'capacity-actual already recorded; no-op' }));
      return;
    }
    throw new Error('既存capacity-actual recordが現在のvoice tupleと一致しません');
  }

  // 2) 容量actual: F001 baseline invariant + Pages dist preview(実vite build) + verifyActualCapacity。
  const preview = await canonicalArtifact<IntegratedBuild>(workspace, `${CACHE_ROOT}/content-preview.json`);
  if (preview.value.mode !== 'work-preview' || preview.value.activeBatchId !== BATCH_ID || preview.value.activeWorkId !== WORK_ID) {
    throw new Error('content-preview.jsonが現在のwork-previewと一致しません（scripts/f008-content-preview.tsを先に実行してください）');
  }
  const catalogBytes = await readFile(join(preview.value.stagingRoot, 'content', 'catalog.json'));
  let catalogUnknown: unknown;
  try {
    catalogUnknown = JSON.parse(catalogBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`content preview catalogが不正です: ${error instanceof Error ? error.message : 'parse error'}`, { cause: error });
  }
  const catalogChecked = validateCatalogV2(catalogUnknown, catalogBytes.byteLength);
  if (!catalogChecked.ok) throw new Error(`content preview catalog schemaが不正です: ${catalogChecked.error.code}`);
  const catalog: CatalogV2 = catalogChecked.value;

  const baselineBundle = await loadAndVerifyF001Baseline(
    join(workspace, 'public'),
    join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
    join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
  );
  const { authors, works, audioAssets } = baselineBundle.catalog;
  if (!authors || !works || !audioAssets) throw new Error('F001 baseline projectionが不完全です');
  const baseline: F001Baseline = {
    baselineSha256: baselineBundle.baselineSha256,
    catalog: { authors, works, audioAssets },
    files: baselineBundle.files,
  };

  const acceptedAudio = await measureTree(join(workspace, 'content', 'batches', BATCH_ID, 'accepted-audio'), true);
  const pagesOutputRoot = join(workspace, '.cache', `.f008-actual-pages-${WORK_ID}-${Date.now()}`);
  await mkdir(join(workspace, '.cache'), { recursive: true });
  await mkdir(pagesOutputRoot, { recursive: false });
  try {
    const contentInvariant = await verifyF001Invariant(catalog, preview.value.stagingRoot, baseline);
    if (contentInvariant.buildSha256 !== preview.value.buildSha256 || contentInvariant.stagingSha256 !== preview.value.buildSha256) {
      throw new Error('content invariant/build SHAが不一致です');
    }
    const pages = await buildPagesPreview(preview.value, workspace, pagesOutputRoot, true);
    if (pages.contentBuildSha256 !== preview.value.buildSha256) throw new Error('Pages preview tupleが不一致です');
    const distInvariant = await verifyF001DistInvariant(pages, baseline, contentInvariant);

    const generationFiles = generation.assets.map((asset) => asset.sourcePath);
    if (generationFiles.some((file) => typeof file !== 'string') || new Set(generationFiles).size !== generation.assets.length) {
      throw new Error('generation asset path集合が不正です');
    }
    const candidateFiles = [...new Set([...(await changedRepositoryCandidates(workspace)), ...generationFiles])];
    const gitObjects: readonly GitObjectMeasurement[] = await measureGitRepository(workspace, candidateFiles);
    const gitRoot = join(workspace, '.git');
    const gitNonObjects = await measureTree(gitRoot, false, join(gitRoot, 'objects'));
    const freeBytes = await assertDiskGuard(workspace, '容量actual測定');

    const actual = await verifyActualCapacity({
      phase: 'work-preview',
      batchId: BATCH_ID,
      workId: WORK_ID,
      workspaceRoot: workspace,
      repositoryRoot: workspace,
      expectedManifestSha: generation.expectedManifestSha,
      preTreeDigest: generation.preTreeDigest,
      contentStagingSha256: contentInvariant.stagingSha256,
      voiceConfigHash: generation.configHash,
      planDigest: generation.planDigest,
      authorizationDigest: generation.authorizationDigest,
      generation,
      completeness: completeness.value,
      additionalAudioFiles: [...new Set([...acceptedAudio.files, ...generationFiles])],
      repositoryCandidateFiles: candidateFiles,
      repositoryNonObjectBytes: gitNonObjects.bytes,
      gitObjects,
      disk: {
        liveWriteUpperBounds: forecastArtifact.value.measurements.liveWriteUpperBounds,
        rollbackBackupBytes: forecastArtifact.value.measurements.rollbackBackupBytes,
        freeBytes,
      },
    }, pages);
    if (actual.result === 'blocked') throw new Error(`F008容量actualがblockedです: ${actual.reasons.join(',')}`);

    await Promise.all([
      writeJsonArtifactAtomic(workspace, join(workspace, ...ACTUAL_PATH.split('/')), actual),
      writeJsonArtifactAtomic(workspace, join(workspace, CACHE_ROOT, 'dist-preview.json'), pages),
      writeJsonArtifactAtomic(workspace, join(workspace, CACHE_ROOT, 'f001-content-invariant.json'), contentInvariant),
      writeJsonArtifactAtomic(workspace, join(workspace, CACHE_ROOT, 'f001-dist-invariant.json'), distInvariant),
    ]);

    // 3) capacity-actual stage recordを直接ハッシュで追記する（work statusはvoicedのまま特例許容）。
    const voicedManifestSha = hashBatchManifest(manifest);
    const capacityRecord: StageRecord = {
      stage: 'capacity-actual',
      inputHashes: [
        voicedManifestSha, generation.generationDigest as Sha256, completeness.value.completenessDigest as Sha256,
        preview.value.buildSha256,
      ],
      toolVersion: ACTUAL_TOOL_VERSION,
      outputHashes: [
        digestArtifact(actual), pages.distSha256, digestArtifact(contentInvariant), digestArtifact(distInvariant),
      ],
      count: actual.additionalAudio.includedPaths.length,
      completedAt: new Date().toISOString(),
    };
    const withActual = replaceWork(manifest, WORK_ID, {
      ...progress,
      stageRecords: [...progress.stageRecords, capacityRecord],
      actualCapacityRef: ACTUAL_PATH as WorkspaceRelativePath,
    });
    const checkedFinal = validateBatchManifest(withActual);
    if (!checkedFinal.ok) throw new Error(`capacity-actual record追記後manifestが不正です: ${checkedFinal.error.code}`);
    await writeBatchManifestAtomic(workspace, MANIFEST_PATH as WorkspaceRelativePath, checkedFinal.value, voicedManifestSha);

    process.stdout.write(canonicalJson({
      ok: true,
      workId: WORK_ID,
      result: actual.result,
      actualPath: ACTUAL_PATH,
      actualSha256: digestArtifact(actual),
      distSha256: pages.distSha256,
      freeBytes,
      reasons: actual.reasons,
    }));
  } finally {
    await rm(pagesOutputRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
