import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson } from '../src/content/artifacts.ts';
import {
  applySpeechRevisions,
  forecastCandidateSafety,
  type VoiceEstimateProfileV2,
} from '../src/content/f003-reuse.ts';
import { hashBatchManifest, validateBatchManifest, type BatchManifest } from '../src/content/batch.ts';
import type { EditorialResolutionSet } from '../src/content/editorial-independent.ts';
import type { WorkReviewResult } from '../src/content/processing.ts';
import {
  projectDistPreviewPaths,
  projectIntegratedBuildPaths,
  projectVoiceGenerationPaths,
} from '../src/content/f003-artifact-paths.ts';
import type {
  F003BaselineContentArtifact,
  F003BaselineDistArtifact,
  F003CandidateSafetyArtifact,
  F003CapacityActualArtifact,
  F003VoiceCompletenessArtifact,
} from '../src/content/f003-review-acceptance.ts';

const BATCH_ID = 'F003';
const WORK_ID = '000275';
const MEBIBYTE = 1_048_576;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function writeCanonicalAtomic(path: string, value: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  await mkdir(dirname(path), { recursive: true });
  try {
    const current = await readFile(path);
    if (!current.equals(bytes)) throw new Error(`既存artifactが現在のtupleと異なります: ${path}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function currentManifest(workspace: string): Promise<BatchManifest> {
  const value = await readJson<unknown>(join(workspace, 'content', 'batches', BATCH_ID, 'batch.json'));
  const checked = validateBatchManifest(value);
  if (!checked.ok) throw new Error(`F003 manifestが不正です: ${checked.error.code}`);
  return checked.value;
}

async function writeSafety(workspace: string): Promise<void> {
  const [review, reconciliation, profile, toolBytes] = await Promise.all([
    readJson<WorkReviewResult>(join(workspace, '.cache', 'batch-review', BATCH_ID, WORK_ID, 'review-result.json')),
    readJson<EditorialResolutionSet>(
      join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', WORK_ID, 'review-reconciliation.json'),
    ),
    readJson<VoiceEstimateProfileV2>(join(workspace, 'content', 'baselines', 'F002-voice-estimate-profile.json')),
    readFile(join(workspace, 'src', 'content', 'f003-reuse.ts')),
  ]);
  if (review.workId !== WORK_ID || review.pending.length !== 0 || review.approved.length === 0 ||
    reconciliation.pendingIds.length !== 0) {
    throw new Error('完結した女生徒review/reconciliationが必要です');
  }
  const revised = applySpeechRevisions(
    review.approved.map(({ candidate }) => ({
      candidateId: candidate.candidateId,
      displayText: candidate.displayText,
      speechText: candidate.speechText,
    })),
    [],
  );
  const reports = revised.map((item) => forecastCandidateSafety(item, profile));
  const blocked = reports.filter((report) => report.result !== 'pass');
  if (blocked.length > 0) throw new Error(`candidate safety blocked: ${blocked.map((item) => item.candidateId).join(',')}`);
  const artifact: F003CandidateSafetyArtifact = {
    schemaVersion: '1.0.0',
    kind: 'candidate-safety',
    batchId: BATCH_ID,
    workId: WORK_ID,
    toolSha256: sha256(toolBytes),
    inputHashes: [
      reconciliation.reconciliationDigest,
      profile.artifactSha256,
      profile.configHash,
    ],
    payload: {
      reconciliationDigest: reconciliation.reconciliationDigest,
      reports,
    },
  };
  await writeCanonicalAtomic(
    join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', WORK_ID, 'candidate-safety.json'),
    artifact,
  );
  const estimatedBytes = reports.reduce((total, report) => total + report.wavBytes, 0);
  process.stdout.write(`candidate-safety: pass=${reports.length}, forecast=${estimatedBytes} bytes\n`);
}

async function writeForecastInputs(workspace: string): Promise<void> {
  const manifest = await currentManifest(workspace);
  const work = manifest.workProgress[manifest.workIds.indexOf(WORK_ID as never)];
  if (work?.status !== 'reviewed') throw new Error(`forecast入力にはreviewed状態が必要です: ${work?.status ?? 'missing'}`);
  await writeCanonicalAtomic(
    join(workspace, '.cache', 'batch-capacity', BATCH_ID, WORK_ID, 'forecast-inputs.json'),
    {
      schemaVersion: '1.0.0',
      kind: 'capacity-forecast-inputs',
      batchId: BATCH_ID,
      workId: WORK_ID,
      expectedManifestSha: hashBatchManifest(manifest),
      plannedPagesBytes: 16 * MEBIBYTE,
      repositoryCandidateFiles: [],
      liveWriteUpperBounds: 64 * MEBIBYTE,
      rollbackBackupBytes: 16 * MEBIBYTE,
    },
  );
  process.stdout.write('capacity-forecast inputs: ready\n');
}

async function writeActualInputs(workspace: string): Promise<void> {
  const manifest = await currentManifest(workspace);
  const work = manifest.workProgress[manifest.workIds.indexOf(WORK_ID as never)];
  if (work?.status !== 'voiced') throw new Error(`actual入力にはvoiced状態が必要です: ${work?.status ?? 'missing'}`);
  await writeCanonicalAtomic(
    join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'capacity-actual-inputs.json'),
    {
      schemaVersion: '1.0.0',
      kind: 'capacity-actual-inputs',
      batchId: BATCH_ID,
      workId: WORK_ID,
      voicedManifestSha: hashBatchManifest(manifest),
      liveWriteUpperBounds: 64 * MEBIBYTE,
      rollbackBackupBytes: 16 * MEBIBYTE,
    },
  );
  process.stdout.write('capacity-actual inputs: ready\n');
}

async function writeEnvelopes(workspace: string): Promise<void> {
  const root = join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', WORK_ID);
  const cache = join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID);
  const [
    reconciliation,
    safetyBytes,
    generationArtifact,
    completeness,
    actual,
    preview,
    distPreview,
    contentInvariant,
    distInvariant,
    runtimeTool,
  ] = await Promise.all([
    readJson<EditorialResolutionSet>(join(root, 'review-reconciliation.json')),
    readFile(join(root, 'candidate-safety.json')),
    readJson<{ readonly generation: F003VoiceCompletenessArtifact['payload']['generation'] }>(
      join(cache, 'voice-generation.json'),
    ),
    readJson<F003VoiceCompletenessArtifact['payload']['completeness']>(join(cache, 'voice-completeness.json')),
    readJson<F003CapacityActualArtifact['payload']['actual']>(
      join(workspace, 'content', 'batches', BATCH_ID, 'capacity-actual', `${WORK_ID}.json`),
    ),
    readJson<F003BaselineContentArtifact['payload']['preview']>(join(cache, 'content-preview.json')),
    readJson<F003BaselineDistArtifact['payload']['preview']>(join(cache, 'dist-preview.json')),
    readJson<F003BaselineContentArtifact['payload']['invariant']>(join(cache, 'f001-content-invariant.json')),
    readJson<F003BaselineDistArtifact['payload']['invariant']>(join(cache, 'f001-dist-invariant.json')),
    readFile(join(workspace, 'src', 'content', 'batch-runtime.ts')),
  ]);
  const generation = generationArtifact.generation;
  if (generation.batchId !== BATCH_ID || generation.workId !== WORK_ID ||
    completeness.result !== 'pass' || actual.result === 'blocked' ||
    preview.activeBatchId !== BATCH_ID || preview.activeWorkId !== WORK_ID ||
    contentInvariant.result !== 'pass' || distInvariant.result !== 'pass') {
    throw new Error('voice/capacity/baseline evidenceがPASS tupleではありません');
  }
  const persistedGeneration = projectVoiceGenerationPaths(workspace, generation);
  const persistedPreview = projectIntegratedBuildPaths(workspace, preview);
  const persistedDistPreview = projectDistPreviewPaths(workspace, distPreview);
  const toolSha256 = sha256(runtimeTool);
  const voice: F003VoiceCompletenessArtifact = {
    schemaVersion: '1.0.0',
    kind: 'voice-completeness',
    batchId: BATCH_ID,
    workId: WORK_ID,
    toolSha256,
    inputHashes: [sha256(safetyBytes), reconciliation.reconciliationDigest],
    payload: {
      planDigest: generation.planDigest,
      generationDigest: generation.generationDigest,
      completenessDigest: completeness.completenessDigest,
      reconciliationDigest: reconciliation.reconciliationDigest,
      generation: persistedGeneration,
      completeness,
    },
  };
  const voicePath = join(root, 'voice-completeness.json');
  await writeCanonicalAtomic(voicePath, voice);
  const voiceSha = sha256(await readFile(voicePath));
  const capacity: F003CapacityActualArtifact = {
    schemaVersion: '1.0.0',
    kind: 'capacity-actual',
    batchId: BATCH_ID,
    workId: WORK_ID,
    toolSha256,
    inputHashes: [voiceSha],
    payload: {
      result: actual.result,
      planDigest: generation.planDigest,
      generationDigest: generation.generationDigest,
      completenessDigest: completeness.completenessDigest,
      contentBuildSha256: preview.buildSha256,
      distSha256: distPreview.distSha256,
      actual,
    },
  };
  const capacityPath = join(root, 'capacity-actual.json');
  await writeCanonicalAtomic(capacityPath, capacity);
  const capacitySha = sha256(await readFile(capacityPath));
  const content: F003BaselineContentArtifact = {
    schemaVersion: '1.0.0',
    kind: 'baseline-content',
    batchId: BATCH_ID,
    workId: WORK_ID,
    toolSha256,
    inputHashes: [capacitySha],
    payload: {
      result: contentInvariant.result,
      contentBuildSha256: preview.buildSha256,
      preview: persistedPreview,
      invariant: contentInvariant,
    },
  };
  const contentPath = join(root, 'baseline-content.json');
  await writeCanonicalAtomic(contentPath, content);
  const contentSha = sha256(await readFile(contentPath));
  const dist: F003BaselineDistArtifact = {
    schemaVersion: '1.0.0',
    kind: 'baseline-dist',
    batchId: BATCH_ID,
    workId: WORK_ID,
    toolSha256,
    inputHashes: [contentSha],
    payload: {
      result: distInvariant.result,
      contentBuildSha256: preview.buildSha256,
      distSha256: distPreview.distSha256,
      preview: persistedDistPreview,
      invariant: distInvariant,
    },
  };
  await writeCanonicalAtomic(join(root, 'baseline-dist.json'), dist);
  process.stdout.write('F003 acceptance envelopes: ready\n');
}

const command = process.argv[2];
const workspace = resolve(process.cwd());
if (command === 'safety') await writeSafety(workspace);
else if (command === 'forecast') await writeForecastInputs(workspace);
else if (command === 'actual') await writeActualInputs(workspace);
else if (command === 'envelopes') await writeEnvelopes(workspace);
else throw new Error('usage: node --experimental-transform-types scripts/f003-work-inputs.ts safety|forecast|actual|envelopes');
