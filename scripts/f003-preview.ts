import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson } from '../src/content/artifacts.ts';
import { loadAndVerifyF001Baseline } from '../src/content/baseline.ts';
import {
  hashBatchManifest,
  loadAcceptedBatches,
  validateBatchManifest,
  type Sha256,
  type WorkspaceRelativePath,
} from '../src/content/batch.ts';
import {
  buildIntegratedPublicTree,
  type ActiveBatchPreview,
  type BatchCatalogFragment,
} from '../src/content/batch-public.ts';
import type { CatalogV2, WorkReviewResult } from '../src/content/processing.ts';

const BATCH_ID = 'F003';
const WORK_ID = '000275';

interface VoiceGenerationArtifact {
  readonly generation: {
    readonly schemaVersion: '2';
    readonly batchId: string;
    readonly workId: string;
    readonly configHash: string;
    readonly generationDigest: string;
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
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function asSha256(value: string): Sha256 {
  return value as Sha256;
}

function asWorkspacePath(value: string): WorkspaceRelativePath {
  return value as WorkspaceRelativePath;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function writeCanonicalAtomic(path: string, value: unknown): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  await mkdir(dirname(path), { recursive: true });
  try {
    const current = await readFile(path);
    if (current.equals(bytes)) return bytes;
    throw new Error(`既存artifactが現在のtupleと異なります: ${path}`);
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
  return bytes;
}

async function f002Fragment(workspace: string, catalog: CatalogV2): Promise<BatchCatalogFragment> {
  const author = catalog.authors.filter((item) => item.introducedByBatchId === 'F002');
  const works = catalog.works.filter((item) => item.batchId === 'F002');
  const audioAssets = catalog.audioAssets.filter((item) => item.batchId === 'F002').map((item) => ({ ...item }));
  const f002Manifest = await readJson<{
    readonly workProgress: readonly {
      readonly acceptedAudioSources?: readonly {
        readonly path: string;
        readonly sha256: string;
        readonly bytes: number;
        readonly configHash: string;
      }[];
    }[];
  }>(join(workspace, 'content', 'batches', 'F002', 'batch.json'));
  for (const source of f002Manifest.workProgress.flatMap((work) => work.acceptedAudioSources ?? [])) {
    const audioId = basename(source.path, '.wav');
    if (audioAssets.some((asset) => asset.audioId === audioId)) continue;
    const canonical = audioAssets.find((asset) =>
      asset.sha256 === source.sha256 && asset.bytes === source.bytes && asset.configHash === source.configHash);
    if (!canonical) throw new Error(`F002 accepted audioのcatalog aliasを復元できません: ${audioId}`);
    audioAssets.push({
      ...canonical,
      audioId,
      path: `audio/F002/${audioId}.wav`,
    });
  }
  const publicFiles: NonNullable<BatchCatalogFragment['publicFiles']>[number][] = [];
  for (const item of [
    ...author.map((value) => ({
      source: 'content/batches/F002/public-files/artwork/miyazawa-zundamon.png',
      publicPath: value.artwork.path,
    })),
    ...works.map((value) => ({
      source: `content/batches/F002/public-files/provenance/${value.workId}.json`,
      publicPath: value.source.provenancePath,
    })),
  ]) {
    const bytes = await readFile(join(workspace, ...item.source.split('/')));
    publicFiles.push({
      source: asWorkspacePath(item.source),
      publicPath: asWorkspacePath(item.publicPath),
      sha256: asSha256(sha256(bytes)),
      bytes: bytes.byteLength,
    });
  }
  const counts = catalog.candidateCounts.byBatch.F002;
  if (!counts) throw new Error('公開catalogにF002 candidate countsがありません');
  return { authors: author, works, audioAssets, candidateCounts: counts, publicFiles };
}

async function main(): Promise<void> {
  const workspace = resolve(process.cwd());
  const batchPath = join(workspace, 'content', 'batches', BATCH_ID, 'batch.json');
  const checked = validateBatchManifest(await readJson<unknown>(batchPath));
  if (!checked.ok) throw new Error(`F003 manifestが不正です: ${checked.error.code}`);
  const manifest = checked.value;
  const workProgress = manifest.workProgress[manifest.workIds.indexOf(WORK_ID as never)];
  if (workProgress?.status !== 'voiced') throw new Error(`previewにはvoiced workが必要です: ${workProgress?.status}`);

  const [review, generationArtifact, rights, source, publicCatalog, reconciliationBytes, reviewBytes] = await Promise.all([
    readJson<WorkReviewResult>(join(workspace, '.cache', 'batch-review', BATCH_ID, WORK_ID, 'review-result.json')),
    readJson<VoiceGenerationArtifact>(
      join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'voice-generation.json'),
    ),
    readJson<{
      readonly selection: { readonly works: readonly {
        readonly workId: string;
        readonly title: string;
        readonly cardUrl: string;
        readonly sourceUrl: string;
        readonly baseEdition: string;
        readonly inputter: string;
        readonly proofreader: string;
      }[] };
    }>(join(workspace, 'content', 'batches', BATCH_ID, 'rights-selection.json')),
    readJson<{
      readonly rawSha256: string;
      readonly fetchedAt: string;
      readonly sourceUrl: string;
    }>(join(workspace, 'data', 'batches', BATCH_ID, 'work-artifacts', WORK_ID, 'sources', WORK_ID, 'source.json')),
    readJson<CatalogV2>(join(workspace, 'public', 'content', 'catalog.json')),
    readFile(join(workspace, 'content', 'batches', BATCH_ID, 'work-artifacts', WORK_ID, 'review-reconciliation.json')),
    readFile(join(workspace, 'content', 'batches', BATCH_ID, 'reviews', `${WORK_ID}.json`)),
  ]);
  const selected = rights.selection.works.find((item) => item.workId === WORK_ID);
  if (!selected || review.pending.length !== 0 || review.approved.length === 0 ||
    generationArtifact.generation.batchId !== BATCH_ID ||
    generationArtifact.generation.workId !== WORK_ID) {
    throw new Error('review/generation/source tupleが不正です');
  }

  const revisionsPath = join(workspace, 'content', 'batches', BATCH_ID, 'speech-revisions', `${WORK_ID}.json`);
  const revisionsBytes = await writeCanonicalAtomic(revisionsPath, []);
  const provenance = {
    authorId: manifest.author.authorId,
    batchId: BATCH_ID,
    editorialReview: {
      approved: review.approved.length,
      path: `content/batches/${BATCH_ID}/reviews/${WORK_ID}.json`,
      pending: 0,
      rejected: review.rejected.length,
      resultSha256: workProgress.stageRecords.findLast((item) => item.stage === 'reviewed')?.outputHashes[0],
      sha256: sha256(reviewBytes),
    },
    processing: {
      candidateCount: review.all.length,
      sourceTreeSha256: workProgress.stageRecords.find((item) => item.stage === 'extracted')?.outputHashes[0],
      toolVersion: 'batch-runtime-source/1.0.0',
      transformation: '青空文庫公式XHTMLを宣言charsetでdecodeし、外側の「」候補を抽出して表示文とVOICEVOX用speech textへ決定的に正規化',
    },
    schemaVersion: '1.0.0',
    source: {
      baseEdition: selected.baseEdition,
      cardUrl: selected.cardUrl,
      fetchedAt: source.fetchedAt,
      inputter: selected.inputter,
      proofreader: selected.proofreader,
      rawSha256: source.rawSha256,
      textUrl: selected.sourceUrl,
    },
    speechRevisions: {
      count: 0,
      path: `content/batches/${BATCH_ID}/speech-revisions/${WORK_ID}.json`,
      sha256: sha256(revisionsBytes),
    },
    title: selected.title,
    workId: WORK_ID,
  };
  const provenanceSource = join(
    workspace, 'content', 'batches', BATCH_ID, 'public-files', 'provenance', `${WORK_ID}.json`,
  );
  const provenanceBytes = await writeCanonicalAtomic(provenanceSource, provenance);
  const artworkSource = join(
    workspace, 'content', 'batches', BATCH_ID, 'public-files', 'artwork', 'dazai-zundamon.png',
  );
  const artworkBytes = await readFile(artworkSource);
  const reviews = new Map(review.all.map((item) => [item.candidate.candidateId, item.review]));
  const candidateAudio = new Map<string, string>();
  for (const asset of generationArtifact.generation.assets) {
    for (const candidateId of asset.candidateIds) candidateAudio.set(candidateId, asset.audioId);
  }
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
  const reasonCounts = Object.fromEntries(
    [...new Set(review.rejected.map((item) => item.review.reasonCode))]
      .map((reason) => [reason, review.rejected.filter((item) => item.review.reasonCode === reason).length]),
  );
  const provenancePath = `content/provenance/${BATCH_ID}/${WORK_ID}.json`;
  const activeFragment: BatchCatalogFragment = {
    authors: [{
      ...manifest.author,
      artwork: {
        path: 'artwork/dazai-zundamon.png',
        alt: '太宰治をイメージしたずんだもん',
        sha256: sha256(artworkBytes),
      },
      introducedByBatchId: BATCH_ID,
    }],
    works: [{
      workId: WORK_ID,
      title: selected.title,
      cardLink: selected.cardUrl,
      authorId: manifest.author.authorId,
      batchId: BATCH_ID,
      source: {
        cardUrl: selected.cardUrl,
        textUrl: selected.sourceUrl,
        attribution: '青空文庫',
        baseEdition: selected.baseEdition,
        inputter: selected.inputter,
        proofreader: selected.proofreader,
        fetchedAt: source.fetchedAt,
        transformation: provenance.processing.transformation,
        sourceSha256: source.rawSha256,
        provenancePath,
        provenanceSha256: sha256(provenanceBytes),
      },
      dialogues,
      completionStatus: 'complete',
      notices: [
        { textKey: 'dialogue-excerpt-scope', placements: ['work-list', 'work-detail', 'credits'] },
        { textKey: 'official-content-warning', placements: ['work-list', 'work-detail', 'credits'] },
      ],
    }],
    audioAssets: generationArtifact.generation.assets.map((asset) => ({
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
      editorialReasons: reasonCounts,
      audioFailureReasons: {},
    },
    publicFiles: [
      {
        source: asWorkspacePath(`content/batches/${BATCH_ID}/public-files/artwork/dazai-zundamon.png`),
        publicPath: asWorkspacePath('artwork/dazai-zundamon.png'),
        sha256: asSha256(sha256(artworkBytes)),
        bytes: artworkBytes.byteLength,
      },
      {
        source: asWorkspacePath(`content/batches/${BATCH_ID}/public-files/provenance/${WORK_ID}.json`),
        publicPath: asWorkspacePath(provenancePath),
        sha256: asSha256(sha256(provenanceBytes)),
        bytes: provenanceBytes.byteLength,
      },
    ],
  };

  const activeStage = join(workspace, '.cache', `.f003-active-${randomUUID()}`);
  const previewStage = join(workspace, '.cache', `.f003-preview-${randomUUID()}`);
  await Promise.all([mkdir(activeStage, { recursive: false }), mkdir(previewStage, { recursive: false })]);
  const stagedFiles: ActiveBatchPreview['stagedFiles'][number][] = [];
  for (const asset of generationArtifact.generation.assets) {
    const target = join(activeStage, 'audio', `${asset.audioId}.wav`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(asset.sourcePath, target);
    stagedFiles.push({
      source: target,
      publicPath: asWorkspacePath(`audio/${BATCH_ID}/${asset.audioId}.wav`),
      sha256: asSha256(asset.sha256),
      bytes: asset.bytes,
    });
  }
  for (const item of [
    {
      source: artworkSource,
      publicPath: asWorkspacePath('artwork/dazai-zundamon.png'),
      sha256: asSha256(sha256(artworkBytes)),
      bytes: artworkBytes.byteLength,
    },
    {
      source: provenanceSource,
      publicPath: asWorkspacePath(provenancePath),
      sha256: asSha256(sha256(provenanceBytes)),
      bytes: provenanceBytes.byteLength,
    },
  ]) {
    const target = join(activeStage, ...item.publicPath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(item.source, target);
    stagedFiles.push({ ...item, source: target });
  }

  const [f001, batches, f002] = await Promise.all([
    loadAndVerifyF001Baseline(
      join(workspace, 'public'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0.json'),
      join(workspace, 'content', 'baselines', 'F001-v0.1.0-catalog.json'),
    ),
    loadAcceptedBatches(workspace),
    f002Fragment(workspace, publicCatalog),
  ]);
  const active: ActiveBatchPreview = {
    manifest,
    workId: WORK_ID,
    catalogFragment: activeFragment,
    catalogBatch: {
      batchId: BATCH_ID,
      feature: BATCH_ID,
      status: 'accepted',
      authorId: manifest.author.authorId,
      workIds: [WORK_ID],
      acceptedAt: workProgress.stageRecords.findLast((item) => item.stage === 'voiced')!.completedAt,
      evidenceSha256: hashBatchManifest(manifest),
    },
    stagingRoot: activeStage,
    stagedFiles,
  };
  const build = await buildIntegratedPublicTree(
    batches,
    {
      baselineSha256: f001.baselineSha256,
      catalog: f001.catalog,
      files: f001.files,
      sourceRoot: f001.sourceRoot,
      syntheticBatch: f001.syntheticBatch,
    },
    previewStage,
    { mode: 'work-preview', workspaceRoot: workspace, batchCatalogs: { F002: f002 } },
    active,
  );
  await writeCanonicalAtomic(
    join(workspace, '.cache', 'batch-accept', BATCH_ID, WORK_ID, 'content-preview.json'),
    build,
  );
  process.stdout.write(
    `work-preview: ${build.files.length} files, build=${build.buildSha256}, reconciliation=${sha256(reconciliationBytes)}\n`,
  );
}

await main();
