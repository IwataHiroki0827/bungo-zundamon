import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  measureF004ActualCapacity,
} from '../src/content/f004-voice.ts';
import {
  measureGitRepository,
  type CapacityForecast,
} from '../src/voice/budget.ts';
import type { VoiceDiffGenerationResult } from '../src/voice/generation.ts';

const execFileAsync = promisify(execFile);
const WORK_ID = '000466';
const FORECAST_PATH = `content/batches/F004/capacity-forecast/${WORK_ID}.json`;
const RUNTIME_GENERATION_PATH = `.cache/f004-voice/${WORK_ID}-generation.json`;
const ACTUAL_PATH = `content/batches/F004/capacity-actual/${WORK_ID}.json`;
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

async function measureTree(root: string): Promise<{ bytes: number; files: readonly string[]; digest: string }> {
  const resolvedRoot = resolve(root);
  const info = await lstat(resolvedRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolvedRoot) !== resolvedRoot) {
    throw new Error('actual tree rootが不正です');
  }
  const measured: Array<{ path: string; target: string; bytes: number; sha256: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`treeにreparseがあります: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(target));
        measured.push({
          path: relative(resolvedRoot, target).split(sep).join('/'),
          target,
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
    files: measured.map((file) => file.target),
    digest: digest.digest('hex'),
  };
}

async function changedFiles(workspace: string): Promise<string[]> {
  const outputs = await Promise.all([
    execFileAsync('git', ['diff', '--name-only', '-z'], { cwd: workspace, encoding: 'utf8' }),
    execFileAsync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: workspace, encoding: 'utf8' }),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: workspace, encoding: 'utf8' }),
  ]);
  return [...new Set(outputs.flatMap(({ stdout }) => stdout.split('\0').filter(Boolean)))]
    .map((path) => join(workspace, ...path.split('/')));
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [generationArtifact, forecastArtifact, pages, repository, disk] = await Promise.all([
    canonicalArtifact<VoiceDiffGenerationResult>(workspace, RUNTIME_GENERATION_PATH),
    canonicalArtifact<{
      forecast: CapacityForecast;
      measurements: {
        liveWriteUpperBounds: number;
        rollbackBackupBytes: number;
      };
    }>(workspace, FORECAST_PATH),
    measureTree(join(workspace, 'public')),
    measureTree(join(workspace, '.git')),
    statfs(workspace),
  ]);
  const generation = generationArtifact.value;
  const stage = await measureTree(generation.stagingRoot);
  if (
    generation.batchId !== 'F004' ||
    generation.workId !== WORK_ID ||
    generation.failed !== 0 ||
    generation.stagedBytes !== stage.bytes ||
    generation.assets.filter((asset) => asset.source === 'staging').length !== stage.files.length
  ) {
    throw new Error('generation/staging actual tupleが不正です');
  }
  const candidateFiles = [...new Set([...stage.files, ...await changedFiles(workspace)])];
  const gitObjects = await measureGitRepository(workspace, candidateFiles);
  const freeBytes = disk.bavail * disk.bsize;
  const report = measureF004ActualCapacity({
    batchId: 'F004',
    workId: WORK_ID,
    additionalAudioBytes: stage.bytes,
    pagesBytes: pages.bytes,
    repositoryNonObjectBytes: repository.bytes,
    gitObjects,
    freeBytes,
    liveWriteUpperBounds: forecastArtifact.value.measurements.liveWriteUpperBounds,
    rollbackBackupBytes: forecastArtifact.value.measurements.rollbackBackupBytes,
  });
  if (report.result === 'blocked' || freeBytes < STOP_FREE_BYTES) {
    throw new Error(`F004 actual capacity blocked: ${report.reasons.join(',')}`);
  }
  const artifact = {
    schemaVersion: '1.0.0',
    kind: 'f004-capacity-actual-evidence',
    batchId: 'F004',
    workId: WORK_ID,
    planDigest: generation.planDigest,
    generationDigest: generation.generationDigest,
    generationSha256: sha256(generationArtifact.text),
    stage: { bytes: stage.bytes, files: stage.files.length, digest: stage.digest },
    pages: { bytes: pages.bytes, files: pages.files.length, digest: pages.digest },
    repository: {
      conservativeBytes: repository.bytes,
      files: repository.files.length,
      digest: repository.digest,
      measuredGitObjects: gitObjects.length,
    },
    freeBytes,
    report,
  };
  if ((await statfs(workspace)).bavail * (await statfs(workspace)).bsize < STOP_FREE_BYTES) {
    throw new Error('5GiB disk guardによりactual artifact writeを停止しました');
  }
  await writeJsonArtifactAtomic(workspace, join(workspace, ...ACTUAL_PATH.split('/')), artifact);
  process.stdout.write(canonicalJson({
    ok: true,
    workId: WORK_ID,
    actualPath: ACTUAL_PATH,
    actualSha256: sha256(canonicalJson(artifact)),
    result: report.result,
    stagedBytes: stage.bytes,
    stagedFiles: stage.files.length,
    pagesBytes: pages.bytes,
    repositoryBytes: report.repository.bytes,
    largestGitObjectBytes: report.singleGitObject.bytes,
    freeBytes,
    requiredFreeBytes: report.workDrive.required,
    reasons: report.reasons,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
