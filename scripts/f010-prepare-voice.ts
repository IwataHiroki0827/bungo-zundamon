import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  hashBatchManifest,
  transitionWorkState,
  validateBatchManifest,
  writeBatchManifestAtomic,
  type BatchManifest,
  type Sha256,
  type StageEvidence,
  type WorkId,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  projectVoiceDiffPlanPaths,
  projectVoiceGenerationPaths,
} from '../src/content/f003-artifact-paths.ts';
import type { VoiceConfigV2 } from '../src/voice/cache.ts';
import { ProductionVoicevoxClient } from '../src/voice/client.ts';
import { forecastCapacity, measureGitRepository, type CapacityForecast } from '../src/voice/budget.ts';
import {
  authorizeVoiceDiffPlan,
  generateVoiceDiff,
  planVoiceDiff,
  verifyVoiceCompleteness,
  type VoiceDiffItem,
  type VoiceDiffPlan,
} from '../src/voice/generation.ts';

const execFileAsync = promisify(execFile);

/**
 * F010（梶井基次郎3作品追加）work単位の差分音声生成・容量forecast thin script。
 * f009-prepare-voice.tsをF010向けにパラメータ化した複製。CHG-F008-001（容量forecast
 * 自己増悪バグ、公開treeの成長に伴いplannedPagesBytesをcurrentPages.bytes全体で
 * 倍増する見積もりが閾値を自己増悪させる構造的欠陥）の是正済み固定上限方式
 * （`Math.min(currentPages.bytes, 150_000_000)`）をF010でも踏襲する。
 * @des DES-F010-008 @fun FUN-F010-009
 */

const BATCH_ID = 'F010';
const workIdArgument = process.argv[2];
if (!workIdArgument || !/^[0-9]{6}$/u.test(workIdArgument)) {
  throw new Error('6桁のwork IDを引数で指定してください（例: node --experimental-transform-types scripts/f009-prepare-voice.ts 000424）');
}
const WORK_ID = workIdArgument as WorkId;
const MANIFEST_PATH = `content/batches/${BATCH_ID}/batch.json`;
const SPEECH_REVISIONS_PATH = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/speech-revisions.json`;
const SOURCE_CONFIG_PATH = 'content/batches/F002/voice-config.json';
const CONFIG_PATH = `content/batches/${BATCH_ID}/voice-config.json`;
const FORECAST_PATH = `content/batches/${BATCH_ID}/capacity-forecast/${WORK_ID}.json`;
const VOICE_EVIDENCE_PATH = `content/batches/${BATCH_ID}/voice-evidence/${WORK_ID}.json`;
const GENERATION_PATH = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/voice-generation.json`;
const COMPLETENESS_PATH = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/voice-completeness.json`;
const FORECAST_TOOL_VERSION = 'f009-prepare-voice-forecast-v1';
const VOICE_TOOL_VERSION = 'f009-prepare-voice-generate-v1';
const STOP_FREE_BYTES = 5 * 1024 * 1024 * 1024;

function sha256(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function canonicalArtifact<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

interface TreeMeasurement {
  readonly bytes: number;
  readonly files: number;
  readonly digest: string;
}

async function measureTree(root: string, allowMissing = false, excluded?: string): Promise<TreeMeasurement> {
  const resolvedRoot = resolve(root);
  try {
    const info = await lstat(resolvedRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolvedRoot) !== resolvedRoot) {
      throw new Error('unsafe tree root');
    }
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { bytes: 0, files: 0, digest: sha256('') };
    }
    throw error;
  }
  const excludedRoot = excluded === undefined ? undefined : resolve(excluded);
  const measured: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (excludedRoot && (target === excludedRoot || target.startsWith(`${excludedRoot}${sep}`))) continue;
      if (entry.isSymbolicLink()) throw new Error(`treeにreparseがあります: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(target));
        measured.push({
          path: relative(resolvedRoot, target).split(sep).join('/'),
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        });
      }
    }
  };
  await walk(resolvedRoot);
  measured.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const digest = createHash('sha256');
  for (const file of measured) {
    digest.update(file.path).update('\0').update(String(file.bytes)).update('\0').update(file.sha256);
  }
  return {
    bytes: measured.reduce((sum, file) => sum + file.bytes, 0),
    files: measured.length,
    digest: digest.digest('hex'),
  };
}

async function freeBytes(workspace: string): Promise<number> {
  const disk = await statfs(workspace);
  return disk.bavail * disk.bsize;
}

async function assertDiskGuard(workspace: string, label: string): Promise<number> {
  const free = await freeBytes(workspace);
  if (free < STOP_FREE_BYTES) throw new Error(`5GiB disk guardにより${label}を停止しました (free=${free})`);
  return free;
}

async function changedRepositoryCandidates(workspace: string): Promise<string[]> {
  const outputs = await Promise.all([
    execFileAsync('git', ['diff', '--name-only', '-z'], { cwd: workspace, encoding: 'utf8' }),
    execFileAsync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: workspace, encoding: 'utf8' }),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: workspace, encoding: 'utf8' }),
  ]);
  const relativePaths = [...new Set(outputs.flatMap(({ stdout }) => stdout.split('\0').filter(Boolean)))];
  const candidates: string[] = [];
  for (const relativePath of relativePaths) {
    const target = join(workspace, ...relativePath.split('/'));
    try {
      const info = await lstat(target);
      if (info.isFile() && !info.isSymbolicLink()) candidates.push(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return candidates.sort((left, right) => left.localeCompare(right, 'en'));
}

async function guardedWrite(workspace: string, path: string, value: unknown): Promise<Sha256> {
  await assertDiskGuard(workspace, `artifact write (${path})`);
  await writeJsonArtifactAtomic(workspace, join(workspace, ...path.split('/')), value);
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  return sha256(text);
}

/**
 * f010-prepare-editorial.tsのadvanceF010WorkStateと同じ再開可能パターンを
 * budget-approved/voicedへ拡張する。同一入力での再実行はstageRecordsの
 * 既存出力と照合し、一致すれば何もしない。
 */
async function advanceF010VoiceWorkState(
  workspace: string,
  manifest: BatchManifest,
  stage: 'budget-approved' | 'voiced',
  output: readonly Sha256[],
  count: number,
  extra: Pick<StageEvidence, 'forecastRef' | 'voiceEvidenceRef'>,
  toolVersion: string,
  completedAt: string,
): Promise<BatchManifest> {
  const stageOrder = ['pending', 'extracted', 'reviewed', 'budget-approved', 'voiced'] as const;
  const index = manifest.workIds.indexOf(WORK_ID);
  const current = manifest.workProgress[index];
  if (!current) throw new Error(`work ${WORK_ID}がmanifestにありません`);
  const currentRank = stageOrder.indexOf(current.status as typeof stageOrder[number]);
  const nextRank = stageOrder.indexOf(stage);
  if (currentRank >= nextRank) {
    const existing = current.stageRecords.find((record) => record.stage === stage);
    const sameOutput = existing?.outputHashes.length === output.length &&
      existing.outputHashes.every((value, position) => value === output[position]);
    const sameBinding = existing?.count === count && existing.toolVersion === toolVersion;
    if (!sameOutput || !sameBinding) {
      throw new Error(`work stage再開証跡が今回入力と一致しません: ${stage}`);
    }
    return manifest;
  }
  if (nextRank !== currentRank + 1) throw new Error(`work stage順が不正です: ${stage}`);
  const expectedManifestSha = hashBatchManifest(manifest);
  const previousOutputs = current.stageRecords.at(-1)?.outputHashes ?? [];
  const evidence: StageEvidence = {
    kind: 'stage',
    stage,
    expectedManifestSha,
    workId: WORK_ID,
    result: 'pass',
    inputHashes: [...new Set([expectedManifestSha, ...previousOutputs])],
    outputHashes: [...output],
    count,
    toolVersion,
    completedAt,
    ...extra,
  };
  const next = transitionWorkState(manifest, WORK_ID, stage, evidence);
  await writeBatchManifestAtomic(
    workspace,
    MANIFEST_PATH as WorkspaceRelativePath,
    next,
    expectedManifestSha,
  );
  return next;
}

async function ensureConfigWritten(workspace: string): Promise<{ text: string; value: VoiceConfigV2 }> {
  const source = await canonicalArtifact<VoiceConfigV2>(workspace, SOURCE_CONFIG_PATH);
  try {
    const existing = await canonicalArtifact<VoiceConfigV2>(workspace, CONFIG_PATH);
    if (existing.text !== source.text) throw new Error('既存voice-config.jsonがF002固定値と一致しません');
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await guardedWrite(workspace, CONFIG_PATH, source.value);
  return canonicalArtifact<VoiceConfigV2>(workspace, CONFIG_PATH);
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  await assertDiskGuard(workspace, '開始前チェック');

  const manifestPath = resolve(workspace, ...MANIFEST_PATH.split('/'));
  const manifestText = await readFile(manifestPath, 'utf8');
  const checkedManifest = validateBatchManifest(JSON.parse(manifestText) as unknown);
  if (!checkedManifest.ok || canonicalJson(checkedManifest.value) !== manifestText) {
    throw new Error('F010 manifestがcanonicalではありません');
  }
  let manifest = checkedManifest.value;
  const workIndex = manifest.workIds.indexOf(WORK_ID);
  const workProgress = manifest.workProgress[workIndex];
  if (!workProgress || (workProgress.status !== 'reviewed' && workProgress.status !== 'budget-approved' && workProgress.status !== 'voiced')) {
    throw new Error(`work ${WORK_ID}はreviewed以降ではありません: ${String(workProgress?.status)}`);
  }
  if (workProgress.status === 'voiced') {
    process.stdout.write(canonicalJson({
      ok: true,
      workId: WORK_ID,
      status: 'voiced',
      note: 'already voiced; no-op',
    }));
    return;
  }

  const config = await ensureConfigWritten(workspace);
  const revisionArtifact = await canonicalArtifact<{
    schemaVersion: '1.0.0';
    batchId: string;
    workId: string;
    reconciliationDigest: string;
    speech: ReadonlyArray<{ candidateId: string; speechText: string; displayText: string; speechSha256: string; revisionCount: number }>;
  }>(workspace, SPEECH_REVISIONS_PATH);
  if (revisionArtifact.value.batchId !== BATCH_ID || revisionArtifact.value.workId !== WORK_ID || revisionArtifact.value.speech.length === 0) {
    throw new Error(`speech-revisions.jsonがF010/${WORK_ID}のtupleと一致しません`);
  }

  const acceptedAudio = await measureTree(join(workspace, 'content', 'batches', BATCH_ID, 'accepted-audio'), true);
  // reviewed→budget-approved遷移はmanifestへstageRecordを追記するためhashBatchManifest(manifest)が
  // 変化する。budget-approved以降の再実行でここを都度再計算すると、既に確定したforecast.planDigestと
  // 一致しなくなり再実行が常に失敗する。resume時は最初の実行で確定した
  // expectedManifestSha（forecast artifactに保存済み）をそのまま再利用する。
  const preManifestSha = workProgress.status === 'reviewed'
    ? hashBatchManifest(manifest)
    : (await canonicalArtifact<{ forecast: CapacityForecast }>(workspace, FORECAST_PATH)).value.forecast.expectedManifestSha as Sha256;
  const binding = {
    batchId: BATCH_ID,
    workId: WORK_ID,
    expectedManifestSha: preManifestSha,
    preTreeDigest: acceptedAudio.digest as Sha256,
  };

  const items: VoiceDiffItem[] = revisionArtifact.value.speech.map((entry) => ({
    candidateId: entry.candidateId,
    workId: WORK_ID,
    speechText: entry.speechText,
    approved: true,
  }));

  const plan = await planVoiceDiff(items, config.value, join(workspace, '.cache', 'voice'), binding);

  let forecast: CapacityForecast;
  if (workProgress.status === 'reviewed') {
    const currentPages = await measureTree(join(workspace, 'public'));
    const gitRoot = join(workspace, '.git');
    const gitNonObjects = await measureTree(gitRoot, false, join(gitRoot, 'objects'));
    const candidateFiles = await changedRepositoryCandidates(workspace);
    const gitObjects = await measureGitRepository(workspace, candidateFiles);
    const free = await assertDiskGuard(workspace, 'capacity forecast');
    // CHG-F008-001是正済みの固定上限方式（F008 precedent踏襲）。currentPages.bytes全体を
    // 倍増する前提は公開treeの成長に伴いforecastを自己増悪させるため、実測最大機能追加量に
    // 安全余裕を加えた固定上限で見積もる。verifyActualCapacity側は倍増しない実測bytesで
    // 安全網を提供するため、この見積もりを縮小しても実際の容量安全性は損なわれない。
    const plannedPagesBytes = Math.min(currentPages.bytes, 150_000_000);
    const liveWriteUpperBounds = plan.estimatedMissBytes + plannedPagesBytes;
    const rollbackBackupBytes = plannedPagesBytes + acceptedAudio.bytes;
    forecast = await forecastCapacity({
      plan,
      expectedManifestSha: binding.expectedManifestSha,
      preTreeDigest: binding.preTreeDigest,
      planDigest: plan.planDigest,
      alreadyGeneratedUniqueAudioBytes: acceptedAudio.bytes,
      currentPagesBytes: currentPages.bytes,
      plannedPagesBytes,
      repositoryNonObjectBytes: gitNonObjects.bytes,
      gitObjects,
      disk: { liveWriteUpperBounds, rollbackBackupBytes, freeBytes: free },
    });
    if (forecast.result === 'blocked' || !forecast.canGenerate) {
      throw new Error(`F010 capacity forecast blocked: ${forecast.reasons.join(',')}`);
    }
    const forecastArtifact = {
      schemaVersion: '1.0.0' as const,
      kind: 'f009-voice-capacity-forecast' as const,
      batchId: BATCH_ID,
      workId: WORK_ID,
      expectedManifestSha: binding.expectedManifestSha,
      preTreeDigest: binding.preTreeDigest,
      configPath: CONFIG_PATH,
      configSha256: sha256(config.text),
      plan: projectVoiceDiffPlanPaths(workspace, plan),
      forecast,
      measurements: {
        acceptedAudioBytes: acceptedAudio.bytes,
        acceptedAudioFiles: acceptedAudio.files,
        currentPagesBytes: currentPages.bytes,
        currentPagesFiles: currentPages.files,
        plannedPagesBytes,
        repositoryNonObjectBytes: gitNonObjects.bytes,
        liveWriteUpperBounds,
        rollbackBackupBytes,
        freeBytes: free,
      },
    };
    const forecastSha = await guardedWrite(workspace, FORECAST_PATH, forecastArtifact);
    manifest = await advanceF010VoiceWorkState(
      workspace,
      manifest,
      'budget-approved',
      [forecastSha],
      items.length,
      { forecastRef: FORECAST_PATH as WorkspaceRelativePath },
      FORECAST_TOOL_VERSION,
      new Date().toISOString(),
    );
  } else {
    const existing = await canonicalArtifact<{ forecast: CapacityForecast }>(workspace, FORECAST_PATH);
    forecast = existing.value.forecast;
    if (forecast.planDigest !== plan.planDigest || forecast.result === 'blocked') {
      throw new Error('既存capacity forecastが現在のplanと一致しません');
    }
  }

  const authorization = {
    result: forecast.result,
    planDigest: plan.planDigest,
    remainingResponseBytes: forecast.remainingResponseBytes,
    minimumFreeBytesAfterWrite: forecast.minimumFreeBytesAfterWrite,
  };
  const authorizedPlan: VoiceDiffPlan = authorizeVoiceDiffPlan(plan, authorization);

  await assertDiskGuard(workspace, '音声生成');
  const stageDirectory = join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', WORK_ID, `.voice-stage-${WORK_ID}`);
  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', WORK_ID), { recursive: true });

  const client = new ProductionVoicevoxClient({
    baseUrl: 'http://127.0.0.1:50021',
    config: config.value,
    workspaceRoot: workspace,
    timeoutMs: 60_000,
    proxy: false,
  });
  const generation = await generateVoiceDiff(authorizedPlan, client, stageDirectory);
  if (generation.failed !== 0 || generation.succeeded !== authorizedPlan.uniqueAudioCount) {
    throw new Error('F010 voice generationが不完全です');
  }

  const candidateAudio = Object.fromEntries(
    generation.assets.flatMap((asset) => asset.candidateIds.map((candidateId) => [candidateId, asset.audioId])),
  );
  const completeness = await verifyVoiceCompleteness(
    { batchId: BATCH_ID, workId: WORK_ID, approved: items.map((item) => ({ candidate: { candidateId: item.candidateId } })), pending: [] },
    generation,
    { assets: generation.assets, candidateAudio },
    { allowedRoots: [generation.stagingRoot, join(workspace, '.cache', 'voice')] },
  );

  await assertDiskGuard(workspace, '音声完全性証跡の書込み');
  const projectedGeneration = projectVoiceGenerationPaths(workspace, generation);
  await guardedWrite(workspace, GENERATION_PATH, projectedGeneration);
  await guardedWrite(workspace, COMPLETENESS_PATH, completeness);

  const voiceEvidence = {
    schemaVersion: '1.0.0' as const,
    kind: 'f009-voice-evidence' as const,
    batchId: BATCH_ID,
    workId: WORK_ID,
    preVoiceManifestSha: binding.expectedManifestSha,
    planDigest: generation.planDigest,
    authorizationDigest: generation.authorizationDigest,
    generationDigest: generation.generationDigest,
    completenessDigest: completeness.completenessDigest,
    stagingRoot: projectedGeneration.stagingRoot,
  };
  const voiceEvidenceSha = await guardedWrite(workspace, VOICE_EVIDENCE_PATH, voiceEvidence);

  manifest = await advanceF010VoiceWorkState(
    workspace,
    manifest,
    'voiced',
    [voiceEvidenceSha],
    generation.assets.length,
    { voiceEvidenceRef: VOICE_EVIDENCE_PATH as WorkspaceRelativePath },
    VOICE_TOOL_VERSION,
    new Date().toISOString(),
  );

  process.stdout.write(canonicalJson({
    ok: true,
    workId: WORK_ID,
    status: manifest.workProgress[workIndex]?.status,
    forecastResult: forecast.result,
    attempted: generation.attempted,
    succeeded: generation.succeeded,
    failed: generation.failed,
    stagedBytes: generation.stagedBytes,
    stagingRoot: projectedGeneration.stagingRoot,
    generationPath: GENERATION_PATH,
    completenessPath: COMPLETENESS_PATH,
    voiceEvidencePath: VOICE_EVIDENCE_PATH,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
