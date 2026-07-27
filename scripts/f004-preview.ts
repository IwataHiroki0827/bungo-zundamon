import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { canonicalJson, writeJsonArtifactAtomic } from '../src/content/artifacts.ts';
import {
  APPROVAL_POLICY_REFS,
  BATCH_DEFINITION_REFS,
  loadAndVerifyBatchCandidate,
} from '../src/content/batch-candidate.ts';
import {
  loadVerifiedIncludedBatchWork,
  prepareBatchWorkPreview,
} from '../src/content/batch-catalog.ts';
import {
  hashBatchManifest,
  validateBatchManifest,
  type BatchManifest,
  type Sha256,
  type WorkId,
} from '../src/content/batch.ts';
import { F004_V030_PINS, loadPublishedV030Baseline } from '../src/content/f004-baseline.ts';
import type { WorkReviewResult } from '../src/content/processing.ts';

const BATCH_ID = 'F004';
const WORK_ID = '000466' as WorkId;

function sha(value: string | Uint8Array): Sha256 {
  return createHash('sha256').update(value).digest('hex') as Sha256;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function treeFiles(root: string): Promise<Array<{ path: string; sha256: Sha256; bytes: number }>> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`preview treeに通常file以外があります: ${path}`);
    }
  };
  await walk(root);
  return Promise.all(files.sort((a, b) => a.localeCompare(b, 'en')).map(async (path) => {
    const bytes = await readFile(path);
    return {
      path: relative(root, path).replaceAll('\\', '/'),
      sha256: sha(bytes),
      bytes: bytes.byteLength,
    };
  }));
}

const workspace = resolve(process.cwd());
const manifestPath = join(workspace, 'content', 'batches', BATCH_ID, 'batch.json');
const checked = validateBatchManifest(await readJson<unknown>(manifestPath));
if (!checked.ok) throw new Error(`F004 manifestが不正です: ${checked.error.code}`);
const manifest = checked.value;
const workIndex = manifest.workIds.indexOf(WORK_ID);
const progress = manifest.workProgress[workIndex];
if (workIndex !== 0 || progress?.status !== 'voiced') {
  throw new Error(`previewには先頭のvoiced workが必要です: ${progress?.status ?? 'missing'}`);
}

const [context, baseline, review, generationArtifact, sourceIndex, sourceRecord, provenanceBytes] =
  await Promise.all([
    loadAndVerifyBatchCandidate(
      workspace,
      BATCH_DEFINITION_REFS.F004.ref,
      BATCH_DEFINITION_REFS.F004.sha256,
      APPROVAL_POLICY_REFS.F004.ref,
      APPROVAL_POLICY_REFS.F004.sha256,
    ),
    loadPublishedV030Baseline(workspace, F004_V030_PINS),
    readJson<WorkReviewResult>(
      join(workspace, '.cache', 'batch-review', BATCH_ID, WORK_ID, 'review-result.json'),
    ),
    readJson<{
      readonly generation: {
        readonly batchId: string;
        readonly workId: string;
        readonly assets: readonly {
          readonly audioId: string;
          readonly candidateIds: readonly string[];
          readonly sourcePath: string;
          readonly sha256: string;
          readonly bytes: number;
          readonly durationMs: number;
          readonly configHash: string;
        }[];
      };
    }>(join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'voice-generation.json')),
    readJson<{
      readonly bodySelector: string;
      readonly works: readonly Record<string, unknown>[];
    }>(join(workspace, 'content', 'batches', BATCH_ID, 'source-index.json')),
    readJson<Record<string, unknown>>(
      join(workspace, 'data', 'batches', BATCH_ID, 'fixed-sources', WORK_ID, WORK_ID, 'source.json'),
    ),
    readFile(join(
      workspace, 'data', 'batches', BATCH_ID, 'fixed-sources', WORK_ID, WORK_ID, 'provenance.json',
    )),
  ]);

const definitionWork = context.definition.works[workIndex]!;
const sourceEntry = sourceIndex.works.find((entry) => entry.workId === WORK_ID);
const generation = generationArtifact.generation;
if (!sourceEntry || sourceIndex.bodySelector !== '.main_text' ||
  review.workId !== WORK_ID || review.pending.length !== 0 || review.approved.length === 0 ||
  generation.batchId !== BATCH_ID || generation.workId !== WORK_ID) {
  throw new Error('preview review/source/generation tupleが不正です');
}
const provenance = JSON.parse(provenanceBytes.toString('utf8')) as { transformation: string };
const candidateAudio = new Map<string, string>();
for (const asset of generation.assets) {
  for (const candidateId of asset.candidateIds) candidateAudio.set(candidateId, asset.audioId);
}
const reviews = new Map(review.all.map((item) => [item.candidate.candidateId, item.review]));
const dialogues = review.approved.map(({ candidate }, order) => {
  const audioId = candidateAudio.get(candidate.candidateId);
  const editorial = reviews.get(candidate.candidateId);
  if (!audioId || !editorial) throw new Error(`candidate audio/reviewがありません: ${candidate.candidateId}`);
  return {
    dialogueId: candidate.candidateId,
    workId: WORK_ID,
    order,
    displayText: candidate.displayText,
    speechText: candidate.speechText,
    audioId,
    sourceAnchor: candidate.sourceAnchor,
    review: editorial,
  };
});
const reasons = Object.fromEntries(
  [...new Set(review.rejected.map((item) => item.review.reasonCode))]
    .map((reason) => [reason, review.rejected.filter((item) => item.review.reasonCode === reason).length]),
);
const provenancePath =
  `data/batches/${BATCH_ID}/fixed-sources/${WORK_ID}/${WORK_ID}/provenance.json`;
const artifact = {
  schemaVersion: '1.0.0',
  batchId: BATCH_ID,
  workId: WORK_ID,
  lifecycle: 'staged',
  work: {
    workId: WORK_ID,
    title: definitionWork.title,
    cardLink: definitionWork.cardUrl,
    authorId: manifest.author.authorId,
    batchId: BATCH_ID,
    source: {
      cardUrl: definitionWork.cardUrl,
      textUrl: definitionWork.xhtmlUrl,
      attribution: '青空文庫',
      baseEdition: sourceEntry.baseEdition,
      inputter: sourceEntry.inputter,
      proofreader: sourceEntry.proofreader,
      fetchedAt: sourceEntry.fetchedAt,
      transformation: provenance.transformation,
      sourceSha256: sourceEntry.rawSha256,
      provenancePath,
      provenanceSha256: sha(provenanceBytes),
      bibliographyCharset: sourceEntry.bibliographyCharset,
      bodySelector: sourceIndex.bodySelector,
      rawBytes: sourceEntry.rawBytes,
      rawSha256: sourceEntry.rawSha256,
      canonicalSourceSha256: sha(canonicalJson({
        work: sourceEntry,
        record: sourceRecord,
        bodySelector: sourceIndex.bodySelector,
      })),
      sourceUpdatedAt: sourceEntry.sourceUpdatedAt,
    },
    dialogues,
    completionStatus: 'complete',
    notices: [{
      textKey: 'dialogue-excerpt-scope',
      placements: ['work-list', 'work-detail', 'credits'],
    }],
  },
  audioAssets: generation.assets.map((asset) => ({
    audioId: asset.audioId,
    batchId: BATCH_ID,
    path: `audio/${BATCH_ID}/${asset.audioId}.wav`,
    sha256: asset.sha256,
    bytes: asset.bytes,
    durationMs: asset.durationMs,
    configHash: asset.configHash,
    candidateIds: [...asset.candidateIds],
  })),
  candidateCounts: {
    total: review.all.length,
    published: review.approved.length,
    editorialExcluded: review.rejected.length,
    audioExcluded: 0,
    editorialReasons: reasons,
    audioFailureReasons: {},
  },
};
const artifactRaw = canonicalJson(artifact);
const artifactSha = sha(artifactRaw);
const sourceWorkspace = await mkdtemp(join(workspace, '.cache', 'f004-prepared-'));
const artifactRef = `content/batches/${BATCH_ID}/work-artifacts/${WORK_ID}/prepared-work.json`;
const artifactPath = join(sourceWorkspace, ...artifactRef.split('/'));
await mkdir(dirname(artifactPath), { recursive: true });
await writeJsonArtifactAtomic(sourceWorkspace, artifactPath, artifact);
for (const sourcePath of [
  `content/batches/${BATCH_ID}/source-index.json`,
  `data/batches/${BATCH_ID}/fixed-sources/${WORK_ID}/${WORK_ID}/source.raw`,
  `data/batches/${BATCH_ID}/fixed-sources/${WORK_ID}/${WORK_ID}/source.json`,
  provenancePath,
]) {
  const target = join(sourceWorkspace, ...sourcePath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await cp(join(workspace, ...sourcePath.split('/')), target);
}
for (const asset of generation.assets) {
  const target = join(sourceWorkspace, 'public', 'audio', BATCH_ID, `${asset.audioId}.wav`);
  await mkdir(dirname(target), { recursive: true });
  await cp(asset.sourcePath, target);
}
const boundManifest = structuredClone(manifest) as BatchManifest;
const rebound = {
  ...boundManifest,
  workProgress: boundManifest.workProgress.map((item, index) => index === workIndex ? {
    ...item,
    stageRecords: item.stageRecords.map((record, recordIndex) =>
      recordIndex === item.stageRecords.length - 1
        ? { ...record, outputHashes: [...record.outputHashes, artifactSha] }
        : record),
  } : item),
} as unknown as BatchManifest;
const reboundSha = hashBatchManifest(rebound);
const included = await loadVerifiedIncludedBatchWork(
  sourceWorkspace,
  context.definition,
  rebound,
  reboundSha,
  artifactRef,
  artifactSha,
);
const preview = await prepareBatchWorkPreview(
  workspace,
  context.definition,
  rebound,
  [],
  included,
  baseline,
);
const integrated = {
  mode: 'work-preview',
  stagingRoot: preview.stagingRoot,
  buildSha256: preview.previewTreeSha256,
  files: await treeFiles(preview.stagingRoot),
  activeBatchId: BATCH_ID,
  activeWorkId: WORK_ID,
};
await Promise.all([
  writeJsonArtifactAtomic(
    workspace,
    join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'content-preview.json'),
    integrated,
  ),
  writeJsonArtifactAtomic(
    workspace,
    join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', WORK_ID, 'prepared-work.json'),
    artifact,
  ),
]);
process.stdout.write(canonicalJson({
  ok: true,
  workId: WORK_ID,
  artifactSha256: artifactSha,
  reboundManifestSha256: reboundSha,
  previewTreeSha256: preview.previewTreeSha256,
  distSha256: preview.distSha256,
  files: integrated.files.length,
}));
