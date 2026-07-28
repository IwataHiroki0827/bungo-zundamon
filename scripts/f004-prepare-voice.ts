import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  hashBatchManifest,
  validateBatchManifest,
  type BatchManifest,
  type WorkId,
} from '../src/content/batch.ts';
import { projectVoiceDiffPlanPaths } from '../src/content/f003-artifact-paths.ts';
import type { VoiceEstimateProfileV2 } from '../src/content/f003-reuse.ts';
import {
  evaluateF004CandidateSafety,
  forecastF004Capacity,
  planF004VoiceDiff,
} from '../src/content/f004-voice.ts';
import type { F004SpeechItem } from '../src/content/f004-editorial.ts';
import type { VoiceConfigV2 } from '../src/voice/cache.ts';

const workIdArg = process.argv[2];
if (!workIdArg || !/^[0-9]{6}$/u.test(workIdArg)) throw new Error('6桁のwork IDが必要です');
const WORK_ID = workIdArg as WorkId;
const SPEECH_PATH = `content/batches/F004/work-artifacts/${WORK_ID}/speech-items.json`;
const RECONCILIATION_PATH =
  `content/batches/F004/work-artifacts/${WORK_ID}/review-reconciliation.json`;
const PROFILE_PATH = 'content/baselines/F002-voice-estimate-profile.json';
const CONFIG_SOURCE_PATH = 'content/batches/F002/voice-config.json';
const CONFIG_PATH = 'content/batches/F004/voice-config.json';
const SAFETY_PATH = `content/batches/F004/candidate-safety/${WORK_ID}.json`;
const FORECAST_PATH = `content/batches/F004/capacity-forecast/${WORK_ID}.json`;
const RUNTIME_PLAN_PATH = `.cache/f004-voice/${WORK_ID}-plan.json`;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
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

async function measureTree(root: string, allowMissing = false): Promise<TreeMeasurement> {
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
  const measured: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
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

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [speech, reconciliation, profile, configSource, manifestArtifact] = await Promise.all([
    canonicalArtifact<readonly F004SpeechItem[]>(workspace, SPEECH_PATH),
    canonicalArtifact<{ reconciliationDigest: string }>(workspace, RECONCILIATION_PATH),
    canonicalArtifact<VoiceEstimateProfileV2>(workspace, PROFILE_PATH),
    canonicalArtifact<VoiceConfigV2>(workspace, CONFIG_SOURCE_PATH),
    canonicalArtifact<BatchManifest>(workspace, 'content/batches/F004/batch.json'),
  ]);
  const checked = validateBatchManifest(manifestArtifact.value);
  if (!checked.ok) throw new Error(`F004 manifestが不正です: ${checked.error.code}`);
  const manifest = checked.value;
  const workIndex = manifest.workIds.indexOf(WORK_ID);
  if (
    speech.value.length === 0 ||
    workIndex < 0 ||
    manifest.workProgress.slice(0, workIndex).some((item) => item.status !== 'accepted')
  ) {
    throw new Error(`${WORK_ID} speech/manifest tupleが不正です`);
  }
  const safety = evaluateF004CandidateSafety(
    WORK_ID,
    speech.value,
    profile.value,
    reconciliation.value.reconciliationDigest,
  );
  await writeJsonArtifactAtomic(
    workspace,
    join(workspace, ...CONFIG_PATH.split('/')),
    configSource.value,
  );
  const [accepted, pages, repository, disk] = await Promise.all([
    measureTree(join(workspace, 'content', 'batches', 'F004', 'accepted-audio'), true),
    measureTree(join(workspace, 'public')),
    measureTree(join(workspace, '.git')),
    statfs(workspace),
  ]);
  const expectedManifestSha = hashBatchManifest(manifest);
  const plan = await planF004VoiceDiff(
    safety,
    configSource.value,
    join(workspace, '.cache', 'voice'),
    { expectedManifestSha, preTreeDigest: accepted.digest },
  );
  const plannedPagesBytes = pages.bytes;
  const liveWriteUpperBounds = plan.estimatedMissBytes + plannedPagesBytes;
  const rollbackBackupBytes = pages.bytes + accepted.bytes;
  const freeBytes = disk.bavail * disk.bsize;
  const forecast = await forecastF004Capacity({
    plan,
    expectedManifestSha,
    preTreeDigest: accepted.digest,
    planDigest: plan.planDigest,
    alreadyGeneratedUniqueAudioBytes: accepted.bytes,
    currentPagesBytes: pages.bytes,
    plannedPagesBytes,
    repositoryNonObjectBytes: repository.bytes,
    gitObjects: [],
    disk: { liveWriteUpperBounds, rollbackBackupBytes, freeBytes },
  });
  if (forecast.result === 'blocked' || !forecast.canGenerate) {
    throw new Error(`F004 capacity forecast blocked: ${forecast.reasons.join(',')}`);
  }
  const safetyArtifact = {
    schemaVersion: '1.0.0',
    kind: 'f004-candidate-safety',
    batchId: 'F004',
    workId: WORK_ID,
    reconciliationDigest: reconciliation.value.reconciliationDigest,
    profilePath: PROFILE_PATH,
    profileSha256: sha256(profile.text),
    reports: safety,
  };
  const forecastArtifact = {
    schemaVersion: '1.0.0',
    kind: 'f004-voice-capacity-forecast',
    batchId: 'F004',
    workId: WORK_ID,
    expectedManifestSha,
    preTreeDigest: accepted.digest,
    configPath: CONFIG_PATH,
    configSha256: sha256(configSource.text),
    plan: projectVoiceDiffPlanPaths(workspace, plan),
    forecast,
    measurements: {
      acceptedAudioBytes: accepted.bytes,
      acceptedAudioFiles: accepted.files,
      currentPagesBytes: pages.bytes,
      currentPagesFiles: pages.files,
      plannedPagesBytes,
      repositoryBytesConservative: repository.bytes,
      liveWriteUpperBounds,
      rollbackBackupBytes,
      freeBytes,
    },
  };
  await Promise.all([
    writeJsonArtifactAtomic(workspace, join(workspace, ...SAFETY_PATH.split('/')), safetyArtifact),
    writeJsonArtifactAtomic(workspace, join(workspace, ...FORECAST_PATH.split('/')), forecastArtifact),
    writeJsonArtifactAtomic(workspace, join(workspace, ...RUNTIME_PLAN_PATH.split('/')), plan),
  ]);
  process.stdout.write(canonicalJson({
    ok: true,
    workId: WORK_ID,
    safetyCount: safety.length,
    safetyPath: SAFETY_PATH,
    safetySha256: sha256(canonicalJson(safetyArtifact)),
    maxCodePoints: Math.max(...safety.map((item) => item.codePoints)),
    maxDurationMs: Math.max(...safety.map((item) => item.durationMs)),
    maxWavBytes: Math.max(...safety.map((item) => item.wavBytes)),
    planDigest: plan.planDigest,
    hitCount: plan.hitCount,
    missCount: plan.missCount,
    estimatedMissBytes: plan.estimatedMissBytes,
    forecastPath: FORECAST_PATH,
    forecastSha256: sha256(canonicalJson(forecastArtifact)),
    forecastResult: forecast.result,
    freeBytes,
    acceptedAudioBytes: accepted.bytes,
    acceptedAudioFiles: accepted.files,
    publicBytes: pages.bytes,
    publicFiles: pages.files,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
