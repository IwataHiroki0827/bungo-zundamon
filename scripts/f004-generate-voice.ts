import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { projectVoiceGenerationPaths } from '../src/content/f003-artifact-paths.ts';
import { generateF004VoiceDiff } from '../src/content/f004-voice.ts';
import type { CapacityForecast } from '../src/voice/budget.ts';
import { ProductionVoicevoxClient } from '../src/voice/client.ts';
import type {
  VoiceDiffPlan,
} from '../src/voice/generation.ts';

const WORK_ID = '000466';
const FORECAST_PATH = `content/batches/F004/capacity-forecast/${WORK_ID}.json`;
const RUNTIME_PLAN_PATH = `.cache/f004-voice/${WORK_ID}-plan.json`;
const RUNTIME_GENERATION_PATH = `.cache/f004-voice/${WORK_ID}-generation.json`;
const GENERATION_PATH = `content/batches/F004/voice-evidence/${WORK_ID}.json`;
const STOP_FREE_BYTES = 5 * 1024 * 1024 * 1024;

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

async function freeBytes(workspace: string): Promise<number> {
  const disk = await statfs(workspace);
  return disk.bavail * disk.bsize;
}

async function guardedWrite(workspace: string, path: string, value: unknown): Promise<void> {
  if (await freeBytes(workspace) < STOP_FREE_BYTES) {
    throw new Error('5GiB disk guardによりartifact writeを停止しました');
  }
  await writeJsonArtifactAtomic(workspace, join(workspace, ...path.split('/')), value);
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [planArtifact, forecastArtifact] = await Promise.all([
    canonicalArtifact<VoiceDiffPlan>(workspace, RUNTIME_PLAN_PATH),
    canonicalArtifact<{ forecast: CapacityForecast }>(workspace, FORECAST_PATH),
  ]);
  const plan = planArtifact.value;
  const forecast = forecastArtifact.value.forecast;
  if (
    plan.batchId !== 'F004' ||
    plan.workId !== WORK_ID ||
    plan.planDigest !== forecast.planDigest ||
    forecast.result === 'blocked' ||
    !forecast.canGenerate
  ) {
    throw new Error('voice plan/forecast tupleが不正です');
  }
  const roots = {
    accepted: join(workspace, 'content', 'batches', 'F004', 'accepted-audio'),
    cache: join(workspace, '.cache', 'voice'),
    public: join(workspace, 'public'),
  };
  const [acceptedBefore, cacheBefore, publicBefore, freeBefore] = await Promise.all([
    measureTree(roots.accepted, true),
    measureTree(roots.cache, true),
    measureTree(roots.public),
    freeBytes(workspace),
  ]);
  if (freeBefore < STOP_FREE_BYTES) throw new Error('5GiB disk guardによりVOICEVOX生成を停止しました');
  const client = new ProductionVoicevoxClient({
    baseUrl: 'http://127.0.0.1:50021',
    config: plan.config,
    workspaceRoot: workspace,
    timeoutMs: 60_000,
    proxy: false,
  });
  const staging = join(workspace, '.cache', `.voice-stage-${randomUUID()}-${WORK_ID}`);
  const generation = await generateF004VoiceDiff(
    plan,
    client,
    staging,
    forecast,
  );
  const projected = projectVoiceGenerationPaths(workspace, generation);
  const [acceptedAfter, cacheAfter, publicAfter, stage, freeAfter] = await Promise.all([
    measureTree(roots.accepted, true),
    measureTree(roots.cache, true),
    measureTree(roots.public),
    measureTree(generation.stagingRoot),
    freeBytes(workspace),
  ]);
  if (
    canonicalJson(acceptedAfter) !== canonicalJson(acceptedBefore) ||
    canonicalJson(cacheAfter) !== canonicalJson(cacheBefore) ||
    canonicalJson(publicAfter) !== canonicalJson(publicBefore)
  ) {
    throw new Error('voice staging生成がaccepted/cache/publicを変更しました');
  }
  if (
    generation.failed !== 0 ||
    generation.succeeded !== plan.uniqueAudioCount ||
    generation.assets.flatMap((asset) => asset.candidateIds).length !== plan.candidateCount ||
    stage.files !== generation.assets.filter((asset) => asset.source === 'staging').length ||
    stage.bytes !== generation.stagedBytes
  ) {
    throw new Error('voice generation completenessが不正です');
  }
  await guardedWrite(workspace, RUNTIME_GENERATION_PATH, generation);
  await guardedWrite(workspace, GENERATION_PATH, {
    schemaVersion: '1.0.0',
    kind: 'f004-voice-generation',
    batchId: 'F004',
    workId: WORK_ID,
    planDigest: plan.planDigest,
    generation: projected,
    invariants: {
      acceptedBefore,
      acceptedAfter,
      cacheBefore,
      cacheAfter,
      publicBefore,
      publicAfter,
    },
    disk: { freeBefore, freeAfter },
  });
  process.stdout.write(canonicalJson({
    ok: true,
    workId: WORK_ID,
    generationPath: GENERATION_PATH,
    generationSha256: sha256(canonicalJson({
      schemaVersion: '1.0.0',
      kind: 'f004-voice-generation',
      batchId: 'F004',
      workId: WORK_ID,
      planDigest: plan.planDigest,
      generation: projected,
      invariants: {
        acceptedBefore,
        acceptedAfter,
        cacheBefore,
        cacheAfter,
        publicBefore,
        publicAfter,
      },
      disk: { freeBefore, freeAfter },
    })),
    attempted: generation.attempted,
    succeeded: generation.succeeded,
    failed: generation.failed,
    candidateBindings: generation.assets.flatMap((asset) => asset.candidateIds).length,
    uniqueAudio: generation.assets.length,
    stagedBytes: generation.stagedBytes,
    stagingFiles: stage.files,
    freeBefore,
    freeAfter,
    acceptedInvariant: acceptedBefore.digest === acceptedAfter.digest,
    cacheInvariant: cacheBefore.digest === cacheAfter.digest,
    publicInvariant: publicBefore.digest === publicAfter.digest,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
