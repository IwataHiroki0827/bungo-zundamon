import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import { measureF004ActualCapacity } from '../src/content/f004-voice.ts';
import { measureGitRepository } from '../src/voice/budget.ts';

const execFile = promisify(execFileCallback);
const CANDIDATE_PATH = '.cache/batch-release/F004/candidate-paths.json';
const FINAL_REPORT_PATH = '.cache/batch-release/F004/final-integration.json';
const EVIDENCE_PATH = 'docs/evidence/qt/QT-F004-capacity-actual.json';
const WORK_IDS = ['000466', '045679', '001918'] as const;
const MINIMUM_FREE_BYTES = 5 * 1024 * 1024 * 1024;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readCanonical<T>(workspace: string, path: string): Promise<{ text: string; value: T }> {
  const text = await readFile(join(workspace, ...path.split('/')), 'utf8');
  const value = JSON.parse(text) as T;
  if (canonicalJson(value) !== text) throw new Error(`${path}がcanonical JSONではありません`);
  return { text, value };
}

interface MeasuredTree {
  readonly bytes: number;
  readonly files: readonly string[];
  readonly fileCount: number;
  readonly distSha256: string;
  readonly metadataSha256: string;
}

async function safeTree(workspace: string, rootInput: string, requireCache = false): Promise<MeasuredTree> {
  const root = resolve(rootInput);
  const workspaceRoot = resolve(workspace);
  const relation = relative(workspaceRoot, root);
  if (isAbsolute(relation) || relation === '..' || relation.startsWith(`..${sep}`) ||
    (requireCache && !relation.startsWith(`.cache${sep}`))) {
    throw new Error(`容量計測rootが許可範囲外です: ${root}`);
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error(`容量計測root実体が不正です: ${root}`);
  }
  const measured: Array<{ path: string; target: string; bytes: Uint8Array; sha256: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`容量計測treeにreparseがあります: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        const before = await lstat(target);
        const bytes = new Uint8Array(await readFile(target));
        const after = await lstat(target);
        if (before.size !== bytes.byteLength || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new Error(`容量計測中にfileが変化しました: ${target}`);
        }
        measured.push({
          path: relative(root, target).split(sep).join('/'),
          target,
          bytes,
          sha256: sha256(bytes),
        });
      } else throw new Error(`容量計測treeに通常file以外があります: ${target}`);
    }
  };
  await walk(root);
  measured.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const rawDigest = createHash('sha256');
  const metadataDigest = createHash('sha256');
  let total = 0;
  for (const file of measured) {
    total += file.bytes.byteLength;
    if (!Number.isSafeInteger(total)) throw new Error('容量計測値がoverflowしました');
    rawDigest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.bytes);
    metadataDigest.update(file.path).update('\0').update(String(file.bytes.byteLength)).update('\0').update(file.sha256);
  }
  return {
    bytes: total,
    files: measured.map((file) => file.target),
    fileCount: measured.length,
    distSha256: rawDigest.digest('hex'),
    metadataSha256: metadataDigest.digest('hex'),
  };
}

async function measureRepositoryNonObjects(workspace: string): Promise<{
  readonly bytes: number;
  readonly files: number;
}> {
  const gitRoot = join(workspace, '.git');
  let bytes = 0;
  let files = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === gitRoot && entry.name === 'objects') continue;
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`.gitにreparseがあります: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        const info = await lstat(target);
        bytes += info.size;
        files += 1;
      } else throw new Error(`.gitに通常file以外があります: ${target}`);
    }
  };
  await walk(gitRoot);
  if (!Number.isSafeInteger(bytes)) throw new Error('Git容量計測値がoverflowしました');
  return { bytes, files };
}

async function main(): Promise<void> {
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const [
    { stdout: headRaw },
    { stdout: status },
    candidateArtifact,
    finalArtifact,
    disk,
  ] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }),
    execFile('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workspace, encoding: 'utf8' }),
    readCanonical<{
      sourceCommit: string;
      contentRoot: string;
      distRoot: string;
      contentBuildSha256: string;
      distSha256: string;
    }>(workspace, CANDIDATE_PATH),
    readCanonical<{
      sourceCommit: string;
      reportSha256: string;
      contentBuildSha256: string;
      distSha256: string;
      distFileCount: number;
      f004AudioCount: number;
    }>(workspace, FINAL_REPORT_PATH),
    statfs(workspace),
  ]);
  const head = headRaw.trim();
  if (status !== '') throw new Error('release容量実測にはclean worktreeが必要です');
  if (candidateArtifact.value.sourceCommit !== head || finalArtifact.value.sourceCommit !== head ||
    candidateArtifact.value.contentBuildSha256 !== finalArtifact.value.contentBuildSha256 ||
    candidateArtifact.value.distSha256 !== finalArtifact.value.distSha256) {
    throw new Error('release容量実測のHEADとexact candidate tupleが一致しません');
  }
  const [dist, publicTree, repository, ...preparedArtifacts] = await Promise.all([
    safeTree(workspace, candidateArtifact.value.distRoot, true),
    safeTree(workspace, join(workspace, 'public')),
    measureRepositoryNonObjects(workspace),
    ...WORK_IDS.map((workId) => readCanonical<{
      audioAssets: readonly {
        audioId: string;
        bytes: number;
        path: string;
        sha256: string;
      }[];
    }>(workspace, `content/batches/F004/work-artifacts/${workId}/prepared-work.json`)),
  ]);
  if (dist.distSha256 !== candidateArtifact.value.distSha256 ||
    dist.fileCount !== finalArtifact.value.distFileCount) {
    throw new Error('release dist実体がexact candidateと一致しません');
  }

  const audioFiles: string[] = [];
  let audioBytes = 0;
  const audioIds = new Set<string>();
  for (const [index, artifact] of preparedArtifacts.entries()) {
    const workId = WORK_IDS[index]!;
    for (const asset of artifact.value.audioAssets) {
      if (audioIds.has(asset.audioId) || asset.path !== `audio/F004/${asset.audioId}.wav`) {
        throw new Error(`F004 audio集合が不正です: ${asset.audioId}`);
      }
      audioIds.add(asset.audioId);
      const target = join(workspace, 'content', 'batches', 'F004', 'accepted-audio', workId, `${asset.audioId}.wav`);
      const bytes = new Uint8Array(await readFile(target));
      if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) {
        throw new Error(`F004 accepted audio実体が不一致です: ${asset.audioId}`);
      }
      audioBytes += bytes.byteLength;
      audioFiles.push(target);
    }
  }
  if (audioIds.size !== finalArtifact.value.f004AudioCount || !Number.isSafeInteger(audioBytes)) {
    throw new Error('F004 audio件数または容量が不正です');
  }
  const gitObjects = await measureGitRepository(workspace, dist.files);
  const freeBytes = disk.bavail * disk.bsize;
  if (!Number.isSafeInteger(freeBytes) || freeBytes < MINIMUM_FREE_BYTES) {
    throw new Error('5GiB disk guardによりrelease容量証跡の生成を停止しました');
  }
  const report = measureF004ActualCapacity({
    batchId: 'F004',
    workId: '001918',
    additionalAudioBytes: audioBytes,
    pagesBytes: dist.bytes,
    repositoryNonObjectBytes: repository.bytes,
    gitObjects,
    freeBytes,
    liveWriteUpperBounds: dist.bytes,
    rollbackBackupBytes: publicTree.bytes,
  });
  if (report.result === 'blocked') throw new Error(`F004 release容量実測がblockedです: ${report.reasons.join(',')}`);

  const evidence = {
    schemaVersion: '1.0.0',
    kind: 'f004-release-capacity-evidence',
    batchId: 'F004',
    phase: 'release',
    result: report.result,
    sourceCommit: head,
    candidate: {
      finalIntegrationReportSha256: finalArtifact.value.reportSha256,
      contentBuildSha256: candidateArtifact.value.contentBuildSha256,
      distSha256: candidateArtifact.value.distSha256,
      distFiles: dist.fileCount,
      distBytes: dist.bytes,
      distMetadataSha256: dist.metadataSha256,
    },
    measurements: {
      additionalAudioFiles: audioFiles.length,
      additionalAudioBytes: audioBytes,
      repositoryNonObjectBytes: repository.bytes,
      repositoryNonObjectFiles: repository.files,
      measuredGitObjects: gitObjects.length,
      liveWriteUpperBounds: dist.bytes,
      rollbackBackupBytes: publicTree.bytes,
      freeBytes,
    },
    report,
  } as const;
  await writeJsonArtifactAtomic(workspace, join(workspace, ...EVIDENCE_PATH.split('/')), evidence);
  process.stdout.write(canonicalJson({
    ok: true,
    path: EVIDENCE_PATH,
    sha256: sha256(canonicalJson(evidence)),
    sourceCommit: head,
    result: report.result,
    distBytes: dist.bytes,
    additionalAudioBytes: audioBytes,
    repositoryBytes: report.repository.bytes,
    largestGitObjectBytes: report.singleGitObject.bytes,
    freeBytes,
    requiredFreeBytes: report.workDrive.required,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
